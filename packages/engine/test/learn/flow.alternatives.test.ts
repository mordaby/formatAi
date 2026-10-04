// learn-v8 (owner decision 2026-10-04; SPEC 9.2 layer 8, 21 v12 item 17): an answer may give a second rule for a column, and code decides
// with every row of the example - both fit: the user is asked (the existing ambiguity question, with a `sameAs` check until they answer);
// only one fits: that one is the rule, silently; neither: the loop goes on with the answer's rule. Only the column WITH an alternative gets
// extra work: one more run of the rules, that column alone compared (`onlyColumns`); nothing more runs when there is no alternative.
import type { Computed, Expr, LearnAlternative, LearnPayload, LearnResult, RepairProblem } from '@formatai/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { learnFromExamples, type LearnCallResult } from '../../src/learn/flow';
import { runRules } from '../../src/pipeline/runRules';
import type { V } from './analyze/helpers';
import { xlsxBytesOf } from './v5fixtures';

// Every full verification the learn makes, with the columns it compared (undefined = all) - to see what an alternative costs.
const verifyRuns = vi.hoisted(() => ({ only: [] as (number[] | undefined)[] }));
vi.mock('../../src/learn/verify', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/learn/verify')>();
  return {
    ...mod,
    verifyAgainstExample: (...args: Parameters<typeof mod.verifyAgainstExample>) => {
      verifyRuns.only.push(args[2]?.onlyColumns);
      return mod.verifyAgainstExample(...args);
    },
  };
});
beforeEach(() => {
  verifyRuns.only.length = 0;
});

const CODES = ['AbC', 'xYz', 'MnO', 'pQr', 'StU', 'vWx', 'DeF', 'gHi', 'JkL', 'mNo'];
const STATUS = ['Open', 'Closed', 'Pending'];

/** 30 orders: Tag = the code in lower case, Total = Amount x 2, State = "Done" for a closed order (else the status), Note = from elsewhere. */
function pair(): { input: V[][]; output: V[][] } {
  const input: V[][] = [['Ref', 'Code', 'Amount', 'Status']];
  const output: V[][] = [['Ref', 'Tag', 'Total', 'State', 'Note']];
  for (let i = 0; i < 30; i++) {
    const code = CODES[i % CODES.length]!;
    const status = STATUS[i % 3]!;
    input.push([`R${100 + i}`, code, 10 + i * 7, status]);
    output.push([`R${100 + i}`, code.toLowerCase(), (10 + i * 7) * 2, status === 'Closed' ? 'Done' : status, `Q${(i * 7919) % 997}`]);
  }
  return { input, output };
}

const call = (fn: string, ...args: Expr[]): Expr => ({ op: fn, arg: args[0] }) as unknown as Expr;
const lower = (id: string): Expr => call('lower', { col: id });
const upper = (id: string): Expr => call('upper', { col: id });

/** The answer: Tag by `tag`, Total = amount x 2, State by `state` (default: a copy of Status), Note given up on. */
function answer(tag: Expr, state: Expr = { col: 'status' }): LearnResult {
  const computed: Computed[] = [
    { id: 'tag', type: 'text', expr: tag },
    { id: 'total', type: 'decimal', expr: { op: 'mul', args: [{ col: 'amount' }, { const: 2 }] } },
    { id: 'state', type: 'text', expr: state },
  ];
  return {
    schemaVersion: 1,
    input: { sheet: { pick: 'first' }, headerRow: 'auto', columns: [{ id: 'ref', header: 'Ref', type: 'idLike' }, { id: 'code', header: 'Code', type: 'text' }, { id: 'amount', header: 'Amount', type: 'decimal' }, { id: 'status', header: 'Status', type: 'text' }] },
    transform: { computed, valueMaps: [], sort: [] },
    output: {
      sheetName: 'Sheet1',
      direction: 'ltr',
      language: 'en',
      titleRows: [],
      columns: [{ header: 'Ref', from: 'ref' }, { header: 'Tag', from: 'tag' }, { header: 'Total', from: 'total' }, { header: 'State', from: 'state' }, { header: 'Note', from: null }],
    },
    validations: [],
    unsupported: [{ outputColumn: 'Note', reasonCode: 'externalData' }],
    assumptions: [],
  };
}

const alt = (outputColumn: string, expr: Expr, type: Computed['type'] = 'text'): LearnAlternative => ({ outputColumn, from: `${outputColumn.toLowerCase()}Alt`, computed: [{ id: `${outputColumn.toLowerCase()}Alt`, type, expr }] });

async function learn(first: (payload: LearnPayload) => LearnCallResult, opts: { masking?: boolean } = {}) {
  const p = pair();
  const rounds: { previous: LearnResult; problems: RepairProblem[] }[] = [];
  const result = await learnFromExamples({
    input: { bytes: await xlsxBytesOf(p.input), name: 'in.xlsx' },
    output: { bytes: await xlsxBytesOf(p.output), name: 'out.xlsx' },
    masking: opts.masking ?? false,
    ...(opts.masking ? { key: new TextEncoder().encode('alternatives') } : {}),
    tier: 'paid',
    callLearn: async (payload) => first(payload),
    callRepair: async (_payload, previous, problems) => {
      rounds.push({ previous, problems });
      return { rules: null, problems: [], calls: [] };
    },
  });
  return { result, rounds };
}

describe('learnFromExamples: alternatives (learn-v8)', () => {
  it('no alternative: the standard path, one verification of the answer and no extra run', async () => {
    const { result } = await learn(() => ({ rules: answer(lower('code')), problems: [], calls: [] }));
    expect(result.path).toBe('llm');
    expect(result.stages.verifiedFirstCall).toBe(false); // State is a copy: closed orders differ
    expect(result.alternatives).toBeUndefined();
    expect(verifyRuns.only.filter((o) => o?.length === 1)).toEqual([]);
  });

  it('only the alternative fits: it is the rule, silently; the answer\'s own rule goes; one more run, only its column compared', async () => {
    const baseline = await learn(() => ({ rules: answer(upper('code')), problems: [], calls: [] }));
    const baseRuns = verifyRuns.only.length;
    verifyRuns.only.length = 0;

    const { result, rounds } = await learn(() => ({ rules: answer(upper('code')), alternatives: [alt('Tag', lower('code'))], problems: [], calls: [] }));
    expect(result.alternatives).toEqual([{ column: 'Tag', out: 1, outcome: 'alternativeOnly' }]);
    const rules = result.rules!;
    expect(rules.output.columns[1]).toEqual({ header: 'Tag', from: 'tagAlt' });
    expect(rules.transform.computed.map((c) => c.id)).toEqual(['total', 'state', 'tagAlt']);
    expect(result.verification!.mismatches.some((m) => m.column === 'Tag')).toBe(false);
    // Exactly one more run of the rules than the same learn without the alternative - with only Tag (position 1) compared.
    expect(verifyRuns.only.length).toBe(baseRuns + 1);
    expect(verifyRuns.only.filter((o) => o !== undefined && o.length === 1)).toEqual([[1]]);
    // The loop goes on with the rules that are used now: the round sends back the answer with the alternative in place, and only the
    // State rows (the one column still wrong) as problems.
    expect(baseline.rounds.length).toBeGreaterThan(0);
    expect(rounds[0]!.previous.output.columns[1]!.from).toBe('tagAlt');
  });

  it('only the answer fits: nothing changes and the alternative is dropped', async () => {
    const { result } = await learn(() => ({ rules: answer(lower('code')), alternatives: [alt('Tag', upper('code'))], problems: [], calls: [] }));
    expect(result.alternatives).toEqual([{ column: 'Tag', out: 1, outcome: 'answerOnly' }]);
    expect(result.rules!.output.columns[1]!.from).toBe('tag');
    expect(result.rules!.transform.computed.some((c) => c.id === 'tagAlt')).toBe(false);
    expect(result.rules!.validations).toEqual([]);
  });

  it('neither fits: nothing new - the loop goes on with the answer\'s rule, and the alternative is dropped', async () => {
    const bang: Expr = { op: 'concat', args: [{ col: 'code' }, { const: '!' }] };
    const { result, rounds } = await learn(() => ({ rules: answer(upper('code')), alternatives: [alt('Tag', bang)], problems: [], calls: [] }));
    expect(result.alternatives).toEqual([{ column: 'Tag', out: 1, outcome: 'bothFail' }]);
    expect(result.rules!.output.columns[1]!.from).toBe('tag');
    expect(rounds.length).toBeGreaterThan(0);
    expect(rounds[0]!.previous.output.columns[1]!.from).toBe('tag');
    expect(rounds[0]!.previous.transform.computed.some((c) => c.id === 'tagAlt')).toBe(false);
  });

  it('both fit: the ambiguity question (the answer\'s rule the default, the alternative the second reading) and its sameAs check', async () => {
    const twice: Expr = { op: 'add', args: [{ col: 'amount' }, { col: 'amount' }] };
    const { result } = await learn(() => ({ rules: answer(lower('code'), { op: 'if', cond: { op: 'eq', args: [{ col: 'status' }, { const: 'Closed' }] }, then: { const: 'Done' }, else: { col: 'status' } } as Expr), alternatives: [alt('Total', twice, 'decimal')], problems: [], calls: [] }));
    expect(result.stages.verifiedFirstCall).toBe(true);
    const [found] = result.alternatives!;
    expect(found).toMatchObject({ column: 'Total', out: 2, outcome: 'bothPass' });
    const q = found!.question!;
    expect(q).toMatchObject({ out: 2, header: 'Total', defaultReading: 0 });
    expect(q.readings.map((r) => [r.kind, r.columns, r.fragment.from, r.fragment.computed.map((c) => c.id)])).toEqual([
      ['rule', ['Amount'], 'total', ['total']],
      ['alternative', ['Amount'], 'totalAlt', ['totalAlt']],
    ]);
    expect(q.readings[1]!.fragment.computed[0]!.expr).toEqual(twice);
    // The rules keep the answer's rule, with the check that marks the question open (the alternative written out as one expression).
    expect(result.rules!.output.columns[2]!.from).toBe('total');
    expect(q.check).toEqual({ column: 'total', rule: 'sameAs', expr: twice, severity: 'flag' });
    expect(result.rules!.validations).toContainEqual(q.check);
    expect(result.verification!.verified).toBe(true);
    // The rules still run, and the check flags nothing on the example (both rules agree on every row).
    const run = runRules(result.rules!, { sheetName: 'S', direction: 'ltr', headers: ['Ref', 'Code', 'Amount', 'Status'], rows: [[{ v: 'R1' }, { v: 'AbC' }, { v: 5 }, { v: 'Open' }]], rowNumbers: [2] });
    expect(run.ok && run.flags).toEqual([]);
  });

  it('unmasks an alternative\'s constants exactly like the answer\'s, before testing it', async () => {
    let maskedClosed = '';
    let maskedDone = '';
    const { result } = await learn((payload) => {
      // The masked words for "Closed" and "Done", as the AI step would copy them from its samples.
      const closed = payload.samples.find((s) => (s.out as string[])[3] !== s.in[3])!;
      maskedClosed = closed.in[3] as string;
      maskedDone = (closed.out as string[])[3]!;
      const state: Expr = { op: 'if', cond: { op: 'eq', args: [{ col: 'status' }, { const: maskedClosed }] }, then: { const: maskedDone }, else: { col: 'status' } } as Expr;
      return { rules: answer(lower('code')), alternatives: [alt('State', state)], problems: [], calls: [] };
    }, { masking: true });
    expect(maskedClosed).not.toBe('Closed');
    expect(maskedDone).not.toBe('Done');
    expect(result.alternatives).toEqual([{ column: 'State', out: 3, outcome: 'alternativeOnly' }]);
    expect(JSON.stringify(result.rules)).toContain('"Closed"');
    expect(JSON.stringify(result.rules)).toContain('"Done"');
    expect(JSON.stringify(result.rules)).not.toContain(maskedDone);
    expect(result.stages.verifiedFirstCall).toBe(true);
  });
});
