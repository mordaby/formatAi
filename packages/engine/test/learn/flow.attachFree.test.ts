// Add a source, the free engine first (owner decision 2026-10-07, SPEC 5 A2): in attach mode with the AI step not allowed, the free result
// takes the format's output side from the format (`conformToFormat`) - the format lock holds - and the AI step is never called. What the
// format cannot give by code (a title that reads a column these rules do not declare, a sort by a column no rule fills) is left to the AI step.
import type { Format, LearnPayload, LearnResult } from '@formatai/shared';
import { describe, expect, it } from 'vitest';
import { learnFromExamples, type LearnCallResult, type LearnFromExamplesOptions } from '../../src/learn/flow';
import { checkFormatLock, conformToFormat, formatOf } from '../../src/registry';
import { mixedPair, simplePair, xlsxBytesOf, type Pair } from './v5fixtures';

function spy(): { calls: LearnPayload[]; callLearn: LearnFromExamplesOptions['callLearn'] } {
  const calls: LearnPayload[] = [];
  return {
    calls,
    callLearn: async (payload): Promise<LearnCallResult> => {
      calls.push(payload);
      return { rules: null, problems: [], calls: [] };
    },
  };
}

async function learn(pair: Pair, opts: Partial<LearnFromExamplesOptions> = {}) {
  const s = spy();
  const r = await learnFromExamples({
    input: { bytes: await xlsxBytesOf(pair.input), name: 'in.xlsx' },
    output: { bytes: await xlsxBytesOf(pair.output), name: 'out.xlsx' },
    masking: false,
    tier: 'paid',
    callLearn: s.callLearn,
    ...opts,
  });
  return { r, calls: s.calls };
}

/** The format the first source made: the free engine's own rules for the pair, with what a person may have set on it. */
async function formatFrom(pair: Pair, edit: (f: Format) => Format = (f) => f): Promise<Format> {
  const { r } = await learn(pair, { ai: 'notAllowed' });
  return edit(formatOf(r.rules!));
}

describe('attach mode with the AI step not allowed: the free engine, the format taken from the format', () => {
  it('a pair code explains completely is a local result that holds the format lock (the format\'s sheet name, widths and checks), with no AI call', async () => {
    const target = await formatFrom(simplePair(), (f) => ({
      ...f,
      output: { ...f.output, sheetName: 'Load', columns: f.output.columns.map((c, i) => (i === 0 ? { ...c, width: 24 } : c)) },
      outputValidations: [{ on: 'output', column: 'Ref', rule: 'required', severity: 'flag' }],
    }));
    const { r, calls } = await learn(simplePair(), { ai: 'notAllowed', target });
    expect(calls).toHaveLength(0);
    expect(r.path).toBe('local');
    expect(r.verification?.verified).toBe(true);
    expect(checkFormatLock(r.rules!, target)).toEqual([]);
    expect(r.rules!.output.sheetName).toBe('Load');
    expect(r.rules!.output.columns[0]!.width).toBe(24);
  });

  it('a pair that needs the AI step is the partial result, conformed to the format, with no AI call', async () => {
    const target = await formatFrom(mixedPair());
    const { r, calls } = await learn(mixedPair(), { ai: 'notAllowed', target });
    expect(calls).toHaveLength(0);
    expect(r.path).toBe('partial');
    expect(r.partial).toMatchObject({ reason: 'aiNotAllowed', needsAi: ['Label', 'Warehouse'], needsAiParts: [] });
    expect(checkFormatLock(r.rules!, target)).toEqual([]);
  });

  it('with the AI step allowed, attach mode still goes to the AI step (as before)', async () => {
    const target = await formatFrom(simplePair());
    const { r, calls } = await learn(simplePair(), { target });
    expect(calls).toHaveLength(1);
    expect(r.path).toBe('llm');
  });

  it('a title that reads a column these rules do not declare is left to the AI step: never a local result', async () => {
    const target = await formatFrom(simplePair(), (f) => ({ ...f, output: { ...f.output, titleRows: [{ parts: [{ text: 'Orders up to ' }, { agg: 'max', column: 'orderDate', format: 'dd/MM/yyyy' }] }] } }));
    const { r, calls } = await learn(simplePair(), { ai: 'notAllowed', target });
    expect(calls).toHaveLength(0);
    expect(r.path).toBe('partial');
    expect(r.partial?.needsAiParts).toContain('dateTitle');
    expect(checkFormatLock(r.rules!, target).map((p) => p.path)).toEqual(['output.titleRows']);
  });
});

describe('conformToFormat', () => {
  const rules = (): LearnResult => ({
    schemaVersion: 1,
    input: {
      sheet: { pick: 'first' },
      headerRow: 'auto',
      columns: [
        { id: 'client', header: 'Client', type: 'text' },
        { id: 'sum', header: 'Sum', type: 'decimal' },
      ],
    },
    transform: { computed: [], valueMaps: [], sort: [] },
    output: {
      sheetName: 'Sheet1',
      direction: 'ltr',
      language: 'en',
      titleRows: [{ text: 'Report for April' }],
      columns: [
        { header: 'Customer', from: 'client' },
        { header: 'Total', from: 'sum', width: 9 },
      ],
    },
    validations: [{ on: 'output', column: 'Total', rule: 'oneOf', values: ['1'], severity: 'flag' } as never, { column: 'sum', rule: 'required', severity: 'flag' }],
    unsupported: [],
    assumptions: [],
  });
  const format: Format = {
    output: {
      file: { type: 'xlsx' },
      sheetName: 'Monthly',
      direction: 'rtl',
      language: 'he',
      titleRows: [{ text: 'Monthly report' }],
      columns: [{ header: 'Customer' }, { header: 'Total', format: '#,##0.00', width: 14, agg: 'sum' }],
      headerStyle: { bold: true },
      summaryRows: [{ label: 'Total', cells: { Total: 'sum' } }],
    },
    layout: { sort: [{ header: 'Total', dir: 'desc' }], group: { by: 'Customer', showDetailRows: false, agg: { Total: 'sum' }, summaryRows: [] } },
    outputValidations: [{ on: 'output', column: 'Customer', rule: 'required', severity: 'block' }],
  };

  it('takes the output side from the format, translating the layout\'s headers to the ids that fill them', () => {
    const c = conformToFormat(rules(), format);
    expect(c.unresolved).toEqual([]);
    expect(c.supplied).toEqual(expect.arrayContaining(['summaryRows', 'dateTitle', 'sort', 'group', 'blankRows']));
    expect(c.rules.output.columns).toEqual([
      { header: 'Customer', from: 'client' },
      { header: 'Total', from: 'sum', format: '#,##0.00', width: 14, agg: 'sum' },
    ]);
    expect(c.rules.transform.sort).toEqual([{ column: 'sum', dir: 'desc' }]);
    expect(c.rules.transform.group).toEqual({ by: 'client', showDetailRows: false });
    // the input side's checks stay; the output side's are the format's
    expect(c.rules.validations).toEqual([{ column: 'sum', rule: 'required', severity: 'flag' }, { on: 'output', column: 'Customer', rule: 'required', severity: 'block' }]);
    expect(checkFormatLock(c.rules, format)).toEqual([]);
  });

  it('a sort or group by a column no rule fills keeps the rules\' own, and says so', () => {
    const r = rules();
    r.output.columns[0]!.from = null;
    const c = conformToFormat(r, format);
    expect(c.unresolved).toEqual(['group']);
    expect(c.rules.transform.group).toBeUndefined();
    const sorted = conformToFormat(r, { ...format, layout: { sort: [{ header: 'Customer', dir: 'asc' }] } });
    expect(sorted.unresolved).toEqual(['sort']);
    expect(sorted.rules.transform.sort).toEqual([]);
  });

  it('rules with another number of columns are left as they are (the lock says why)', () => {
    const c = conformToFormat(rules(), { ...format, output: { ...format.output, columns: [{ header: 'Customer' }] } });
    expect(c.rules).toEqual(rules());
  });
});
