// "See what we send" (owner, 2026-10-07): the user's choice per column - hidden or sent as it is - goes through the ONE column
// classification (`classifyColumns`, applied last), so every path that sends cells follows it: the payload's samples, the AI code checks'
// answers, the learning loop's rows and problems, and a completion's fixed rules. The preview (`sendPreview`) is the learn's own request,
// built by the same function: its rows are the rows that go. With no choice, nothing changes (the classification is code's own).
import type { Expr, LearnPayload, LearnResult, PayloadCell, RepairProblem, TestAnswer } from '@formatai/shared';
import { limits, payloadRowCount } from '@formatai/shared';
import { describe, expect, it } from 'vitest';
import { readWorkbook } from '../../src/io/read';
import { analyzePair, type PairAnalysis, type UserColumnChoices } from '../../src/learn/analyze';
import { answerChecks } from '../../src/learn/checks';
import { classifyColumns, codeColumnClasses, sendColumns, sentColumns, withColumnChoices } from '../../src/learn/classify';
import { learnFromExamples, type LearnCallResult } from '../../src/learn/flow';
import type { LoopRound } from '../../src/learn/loop';
import { createMasker } from '../../src/learn/mask';
import { maskFixedRules } from '../../src/learn/maskFixed';
import { buildPayload } from '../../src/learn/payload';
import { preflight } from '../../src/learn/preflight';
import { sendPreview } from '../../src/learn/sendPreview';
import { makeValidIsraeliId } from '../../src/values/israeliId';
import { analyzeOk, xlsx, type V } from './analyze/helpers';
import { priorityPair, priorityRules } from './loopFixtures';
import { xlsxBytesOf, type Pair } from './v5fixtures';

const key = (seed: string): Uint8Array => new TextEncoder().encode(seed);
const N = 12;
const NAMES = ['Dana Cohen', 'Yossi Levi', 'Michal Avraham', 'Avi Mizrahi', 'Ronit Peretz', 'Moshe Biton'];
const id = (i: number): number => Number(makeValidIsraeliId(String(31234500 + i * 1117).padStart(8, '0')));
const amount = (i: number): number => 1200 + i * 37;
const when = (i: number): V => ({ v: 45000 + i, isDate: true, z: 'dd/mm/yyyy' });

/** ID (valid IDs: an identifier by shape), Name (text), Amount (a measure), Date, Paid (yes/no) - copied to the output, plus a Note. */
function pair(): PairAnalysis {
  const headers = ['ID', 'Name', 'Amount', 'Date', 'Paid'];
  const cells = (i: number): V[] => [id(i), NAMES[i % NAMES.length]!, amount(i), when(i), i % 2 === 0];
  const input: V[][] = [headers, ...Array.from({ length: N }, (_, i) => cells(i))];
  const output: V[][] = [[...headers, 'Note'], ...Array.from({ length: N }, (_, i) => [...cells(i), i % 2 === 0 ? 'even' : 'odd'])];
  return analyzeOk(xlsx(input), xlsx(output));
}

const samplesOf = (a: PairAnalysis, seed: string): LearnPayload['samples'] => buildPayload(a, preflight(a, 'paid'), { masker: createMasker(key(seed)) }).payload.samples;

describe('the classification: the user\'s choice is applied last', () => {
  const a = pair();

  it('with no choice, the classes are code\'s own (the same object: masking defaults are unchanged)', () => {
    expect(classifyColumns(a)).toBe(codeColumnClasses(a));
    expect(classifyColumns(withColumnChoices(a, {}))).toEqual(codeColumnClasses(a));
    expect(classifyColumns(a).input).toEqual(['identifier', 'text', 'measure', 'date', 'category']);
  });

  it('"sent" loosens an identifier and a text column; "hidden" tightens a measure - each with its copy in the output', () => {
    const chosen = withColumnChoices(a, { input: { 0: 'sent', 1: 'sent', 2: 'hidden' } });
    const c = classifyColumns(chosen);
    expect(c.detail.input.slice(0, 3)).toEqual([
      { class: 'measure', by: 'user', was: 'identifier' },
      { class: 'category', by: 'user', was: 'text' },
      { class: 'identifier', by: 'user', was: 'measure' },
    ]);
    // The output's copies move with them: a copy keeps one class.
    expect(c.output.slice(0, 3)).toEqual(['measure', 'category', 'identifier']);
    // ... and the same from the output side.
    expect(classifyColumns(withColumnChoices(a, { output: { 0: 'sent', 2: 'hidden' } })).input.slice(0, 3)).toEqual(['measure', 'text', 'identifier']);
    // Code's classes stay what they were (the presets, and what a decision about the rules reads).
    expect(codeColumnClasses(chosen)).toEqual(codeColumnClasses(a));
  });

  it('a date and a yes/no column cannot be hidden (the masker sends them as they are): the choice changes nothing', () => {
    const c = classifyColumns(withColumnChoices(a, { input: { 3: 'hidden', 4: 'hidden' } }));
    expect(c.input.slice(3)).toEqual(['date', 'category']);
    expect(sendColumns(a, true).input.map((s) => s.canHide)).toEqual([true, true, true, false, false]);
  });

  it('when a copy\'s two sides disagree, hidden wins', () => {
    const c = classifyColumns(withColumnChoices(a, { input: { 0: 'sent', 2: 'sent' }, output: { 0: 'hidden', 2: 'hidden' } }));
    expect([c.input[0], c.output[0], c.input[2], c.output[2]]).toEqual(['identifier', 'identifier', 'identifier', 'identifier']);
  });

  it('sentColumns (the "what was sent" list) and sendColumns (the switches) say it, with the preset and why', () => {
    const chosen = withColumnChoices(a, { input: { 0: 'sent', 2: 'hidden' } });
    expect(sentColumns(chosen, true).input.map((s) => s.hidden)).toEqual([false, true, true, false, false]);
    const cols = sendColumns(chosen, true).input;
    expect(cols[0]).toMatchObject({ header: 'ID', hidden: false, hiddenByDefault: true, class: 'identifier', identifier: { by: 'shape', shape: 'israeliId' } });
    expect(cols[2]).toMatchObject({ header: 'Amount', hidden: true, hiddenByDefault: false, class: 'measure' });
    expect(cols[2]!.identifier).toBeUndefined();
    // A copy's columns share a group (a switch moves them together); the Note, copied from nothing, has its own.
    const out = sendColumns(chosen, true).output;
    expect(cols.map((c) => c.group)).toEqual(out.slice(0, 5).map((c) => c.group));
    expect(new Set([...cols.map((c) => c.group), out[5]!.group]).size).toBe(6);
    // Masking off: nothing is hidden, whatever was chosen.
    expect(sendColumns(chosen, false).input.every((s) => !s.hidden && !s.hiddenByDefault)).toBe(true);
  });
});

describe('the payload\'s samples follow the choice', () => {
  const a = pair();
  const ids = Array.from({ length: N }, (_, i) => id(i));
  const amounts = Array.from({ length: N }, (_, i) => amount(i));

  it('a user-sent identifier goes real, in `in` and `out`; a user-hidden measure is masked, in both', () => {
    const before = samplesOf(a, 'samples');
    expect(before.every((s) => !ids.includes(s.in[0] as number) && amounts.includes(s.in[2] as number))).toBe(true);
    const after = samplesOf(withColumnChoices(a, { input: { 0: 'sent', 2: 'hidden' } }), 'samples');
    expect(after.length).toBeGreaterThan(0);
    for (const s of after) {
      const k = ids.indexOf(s.in[0] as number);
      expect(k).toBeGreaterThanOrEqual(0); // the ID: real
      expect(s.in[2]).not.toBe(amounts[k]); // the amount: masked (digits for digits)
      expect(String(s.in[2])).toHaveLength(String(amounts[k]).length);
      expect((s.out as PayloadCell[]).slice(0, 3)).toEqual(s.in.slice(0, 3)); // the same values in `in` and `out`
    }
  });
});

describe('the AI code checks\' answers follow the choice', () => {
  // Amount decides Size at 1,500; the test's failing rows carry their row.
  const input: V[][] = [['ID', 'Name', 'Amount']];
  const output: V[][] = [['ID', 'Name', 'Amount', 'Size']];
  for (let i = 0; i < 30; i++) {
    input.push([id(i), NAMES[i % NAMES.length]!, amount(i)]);
    output.push([id(i), NAMES[i % NAMES.length]!, amount(i), amount(i) >= 1500 ? 'Big' : 'Small']);
  }
  const a = withColumnChoices(analyzeOk(xlsx(input), xlsx(output)), { input: { 0: 'sent', 2: 'hidden' } });

  it('a failing row shows the user-sent ID real and the user-hidden amount masked', () => {
    const masker = createMasker(key('checks'));
    const built = buildPayload(a, preflight(a, 'paid'), { masker });
    const sent = new Set([...built.sampleRows.map((s) => s.in), ...built.droppedRows]);
    const BIG = masker.maskText('Big');
    const SMALL = masker.maskText('Small');
    const r = answerChecks([{ check: 'test', column: 'Size', rule: `if(in2 >= 1300, "${BIG}", "${SMALL}")` }], { analysis: a, masker, sent, rowBudget: limits.learn.loop.maxRowsTotal - payloadRowCount(built.payload) });
    const t = r.answers[0] as TestAnswer;
    expect(t.failing.length).toBeGreaterThan(0);
    for (const f of t.failing) {
      const k = Array.from({ length: 30 }, (_, i) => id(i)).indexOf(f.row.in[0] as number);
      expect(k).toBeGreaterThanOrEqual(0); // the ID: real
      expect(f.row.in[2]).not.toBe(amount(k)); // the amount: masked
    }
  });
});

describe('every request of a learn follows the choice', () => {
  async function bytes(p: Pair) {
    return { input: { bytes: await xlsxBytesOf(p.input), name: 'in.xlsx' }, output: { bytes: await xlsxBytesOf(p.output), name: 'out.xlsx' } };
  }

  it('the learning loop: its rows and its problems carry the user-sent columns real and the user-hidden one masked', async () => {
    // Order and Customer sent as they are, Amount hidden (the loop's rows are the open orders the cut-off gets wrong).
    const p = priorityPair();
    const choices: UserColumnChoices = { input: { 0: 'sent', 1: 'sent', 3: 'hidden' } };
    const rounds: { problems: RepairProblem[]; round: LoopRound }[] = [];
    const payloads: LearnPayload[] = [];
    const r = await learnFromExamples({
      ...(await bytes(p)),
      masking: true,
      key: key('loop-choices'),
      tier: 'paid',
      userColumnChoices: choices,
      callLearn: async (payload): Promise<LearnCallResult> => {
        payloads.push(payload);
        return { rules: priorityRules(9400, true), problems: [], calls: [] };
      },
      callRepair: async (_payload, _previous, problems, round): Promise<LearnCallResult> => {
        rounds.push({ problems, round });
        return { rules: priorityRules(5000, true), problems: [], calls: [] };
      },
    });
    expect(r.loop?.rounds).toBeGreaterThan(0);
    const real = new Map(p.input.slice(1).map((row) => [row[0] as string, row] as const));
    const rows = [...rounds.flatMap((x) => x.round.rows), ...payloads[0]!.samples];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const original = real.get(row.in[0] as string);
      expect(original).toBeDefined(); // the order number: real
      expect(row.in[1]).toBe(original![1]); // the customer: real
      expect(row.in[3]).not.toBe(original![3]); // the amount: masked
    }
    const diffs = rounds.flatMap((x) => x.problems).filter((d): d is Extract<RepairProblem, { kind: 'diff' }> => d.kind === 'diff');
    expect(diffs.length).toBeGreaterThan(0);
    for (const d of diffs) {
      const original = real.get(d.row!.in[0] as string)!;
      expect(d.row!.in[1]).toBe(original[1]);
      expect(d.row!.in[3]).not.toBe(original[3]);
    }
  });

  it('the preview is the learn\'s own first request, value for value (with and without choices)', async () => {
    const p = priorityPair(30);
    const files = await bytes(p);
    // (the analysis the browser's worker keeps for the preview: the same two files, read the same way)
    const a = analyzePair(await readWorkbook(files.input.bytes, files.input.name), await readWorkbook(files.output.bytes, files.output.name));
    if (!a.ok) throw new Error('analysis failed');
    for (const choices of [undefined, { input: { 1: 'sent', 3: 'hidden' } } satisfies UserColumnChoices]) {
      let sent: LearnPayload | undefined;
      await learnFromExamples({
        ...files,
        masking: true,
        key: key('preview'),
        tier: 'paid',
        ...(choices ? { userColumnChoices: choices } : {}),
        callLearn: async (payload): Promise<LearnCallResult> => {
          sent = payload;
          return { rules: null, problems: [], calls: [] };
        },
      });
      const preview = sendPreview(a, { tier: 'paid', masking: true, key: key('preview'), userColumnChoices: choices });
      expect(preview.status).toBe('ready');
      expect(preview.status === 'ready' && preview.payload).toEqual(sent);
    }
  });

  it('a completion\'s fixed rules: a constant of a user-sent column goes real, one of a user-hidden column is masked', async () => {
    // Phone (an identifier by name), Name, Amount, Status; Size is what the completion asks for.
    const input: V[][] = [['Phone', 'Name', 'Amount', 'Status']];
    const output: V[][] = [['Phone', 'Name', 'Size', 'Status']];
    const STATUS = ['Active', 'Closed'];
    for (let i = 0; i < 12; i++) {
      const phone = `05${i % 9}-${String(2345671 + i * 1013)}`;
      input.push([phone, `Person ${'abcdefghijkl'[i]}`, 200 + i * 150, STATUS[i % 2]!]);
      output.push([phone, `Person ${'abcdefghijkl'[i]}`, 200 + i * 150 > 1000 ? 'Big' : 'Small', STATUS[i % 2]!]);
    }
    const col = (c: string): Expr => ({ col: c });
    const rules: LearnResult = {
      schemaVersion: 1,
      input: {
        sheet: { pick: 'first' },
        headerRow: 'auto',
        columns: [
          { id: 'phone', header: 'Phone', type: 'text' },
          { id: 'name', header: 'Name', type: 'text' },
          { id: 'amount', header: 'Amount', type: 'integer' },
          { id: 'status', header: 'Status', type: 'text' },
        ],
        rowFilters: [
          { column: 'phone', op: 'ne', value: '0501234567' },
          { column: 'status', op: 'ne', value: 'Gone' },
          { column: 'amount', op: 'ne', value: '99999' },
        ],
      },
      transform: { computed: [{ id: 'size', type: 'text', expr: col('status') }], valueMaps: [], sort: [] },
      output: {
        sheetName: 'Sheet1',
        direction: 'ltr',
        language: 'en',
        titleRows: [],
        columns: [
          { header: 'Phone', from: 'phone' },
          { header: 'Name', from: 'name' },
          { header: 'Size', from: null },
          { header: 'Status', from: 'status' },
        ],
      },
      validations: [],
      unsupported: [],
      assumptions: [],
    };
    const a = analyzeOk(xlsx(input), xlsx(output));
    const choices: UserColumnChoices = { input: { 0: 'sent', 2: 'hidden' } };
    const values = (r: LearnResult): string[] => (r.input.rowFilters ?? []).map((f) => String((f as { value: unknown }).value));
    // Direct: the same masker, code's classes, then the user's.
    const m = createMasker(key('fixed'));
    expect(values(maskFixedRules(rules, m, a))[0]).not.toBe('0501234567');
    expect(values(maskFixedRules(rules, m, a))[2]).toBe('99999');
    const chosen = values(maskFixedRules(rules, createMasker(key('fixed')), withColumnChoices(a, choices)));
    expect(chosen[0]).toBe('0501234567'); // Phone: sent as it is
    expect(chosen[2]).not.toBe('99999'); // Amount: hidden
    expect(chosen[2]).toMatch(/^[0-9]{5}$/);
    // Through the learn: the completion call's `complete.fixed` (what the AI step gets of the user's rules).
    let fixed = '';
    await learnFromExamples({
      input: { bytes: await xlsxBytesOf(input), name: 'in.xlsx' },
      output: { bytes: await xlsxBytesOf(output), name: 'out.xlsx' },
      masking: true,
      key: key('fixed-flow'),
      tier: 'paid',
      userColumnChoices: choices,
      complete: { fixedRules: rules, columns: [2], parts: [] },
      callLearn: async (payload): Promise<LearnCallResult> => {
        fixed = JSON.stringify(payload.complete?.fixed);
        return { rules: null, problems: [], calls: [] };
      },
    });
    expect(fixed).toContain('0501234567');
    expect(fixed).not.toContain('99999');
  });
});
