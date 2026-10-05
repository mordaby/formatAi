// The learning loop's driver (`learn/loop.ts`): which rows a round sends (grouped by what went wrong, biggest groups first, never a row
// twice), and when the loop ends - done, no progress, the round cap, the row cap, the payload cap, nothing to send - keeping the best answer.
import { payloadBytes, withRows, type LearnPayload, type LearnResult, type RepairProblem } from '@formatai/shared';
import { describe, expect, it } from 'vitest';
import { buildPayload, counterexampleSample } from '../../src/learn/payload';
import { createMasker } from '../../src/learn/mask';
import { loopStep, pickCounterexamples, startLoop, wrongCount, type LoopAnswer, type LoopCaps, type LoopContext, type LoopState } from '../../src/learn/loop';
import { verifyAgainstExample, type WrongRow } from '../../src/learn/verify';
import { analyzeOk, xlsx, type V } from './analyze/helpers';
import { analyzeWithPreflight, columnsToRowsPair } from './v5fixtures';
import { priorityPair, priorityRules, wrongWithCutoff } from './loopFixtures';

const CAPS: LoopCaps = { maxRounds: 3, rowsPerRound: 8, maxRowsTotal: 40, maxBytes: 49_152 };

/** A wrong row with one wrong cell per `(out, expected, actual)` given. */
function wrong(inRow: number, ...cells: [number, string, string][]): WrongRow {
  return { inRow, cells: cells.map(([out, expected, actual]) => ({ out, outRow: inRow, expected, actual })), extra: [] };
}

describe('pickCounterexamples: grouped by what went wrong, biggest groups first, one row from each in turn', () => {
  const rows = [
    wrong(1, [2, 'Urgent', 'Normal']),
    wrong(2, [1, 'A', 'B']),
    wrong(3, [2, 'Urgent', 'Normal']),
    wrong(4, [2, 'Urgent', 'Normal']),
    wrong(5, [1, 'A', 'B']),
    wrong(6, [2, 'Done', 'Normal']),
  ];

  it('takes one row from each group (biggest first), then a second from each, until full', () => {
    expect(pickCounterexamples(rows, new Set(), 8).map((r) => r.inRow)).toEqual([1, 2, 6, 3, 5, 4]);
    expect(pickCounterexamples(rows, new Set(), 3).map((r) => r.inRow)).toEqual([1, 2, 6]);
    expect(pickCounterexamples(rows, new Set(), 0)).toEqual([]);
  });

  it('never picks a row already sent, and a row in two groups only once', () => {
    expect(pickCounterexamples(rows, new Set([1, 2]), 8).map((r) => r.inRow)).toEqual([3, 5, 6, 4]);
    const both = [wrong(1, [1, 'A', 'B'], [2, 'X', 'Y']), wrong(2, [1, 'A', 'B']), wrong(3, [2, 'X', 'Y'])];
    expect(pickCounterexamples(both, new Set(), 8).map((r) => r.inRow)).toEqual([1, 3, 2]);
  });

  it('rows the rules make that the example does not have are one group', () => {
    const extra: WrongRow[] = [
      { inRow: 7, cells: [], extra: [['x']] },
      { inRow: 8, cells: [], extra: [['y']] },
      wrong(9, [0, 'a', 'b']),
    ];
    expect(pickCounterexamples(extra, new Set(), 8).map((r) => r.inRow)).toEqual([7, 9, 8]);
  });

  it('counts wrong output rows once each, plus extra rows and layout differences', () => {
    expect(wrongCount([wrong(1, [0, 'a', 'b'], [1, 'c', 'd']), { inRow: 2, cells: [], extra: [['x'], ['y']] }], 1)).toBe(4);
  });
});

/** The priority pair, its analysis and payload (12 samples), and a judged answer with the given cut-off. */
function setup(opts: { masking?: boolean } = {}) {
  const pair = priorityPair();
  const { a, pf } = analyzeWithPreflight(pair);
  const masker = opts.masking ? createMasker(new TextEncoder().encode('loop-test')) : undefined;
  const built = buildPayload(a, pf, masker ? { masker } : {});
  const ctx: LoopContext = { analysis: a, payload: built.payload, masker, caps: CAPS };
  const answer = (cut: number, other: RepairProblem[] = []): LoopAnswer => {
    const v = verifyAgainstExample(priorityRules(cut), a, { wrongRows: true });
    return { rules: true, passes: v.verified, wrong: wrongCount(v.wrongRows!, v.layoutIssues.length), wrongRows: v.wrongRows!, otherProblems: other };
  };
  const start = (): LoopState => startLoop([...built.sampleRows.map((s) => s.in), ...built.droppedRows]);
  return { pair, a, built, ctx, answer, start };
}

describe('loopStep: when the loop ends', () => {
  it('done: every row matches - that answer is the one kept', () => {
    const { ctx, answer, start } = setup();
    const r1 = loopStep(start(), answer(9000), ctx);
    const r2 = loopStep(r1.state, answer(5000), ctx);
    expect(r2.step).toEqual({ kind: 'done' });
    expect(r2.state.best).toBe(1);
  });

  it('no progress: an answer no better than the best so far stops the loop, and the best (the earliest of equals) is kept', () => {
    const { ctx, answer, start } = setup();
    const r1 = loopStep(start(), answer(7000), ctx);
    expect(r1.step.kind).toBe('next');
    const same = loopStep(r1.state, answer(7000), ctx);
    expect(same.step).toEqual({ kind: 'stop', reason: 'noProgress' });
    expect(same.state.best).toBe(0);
    const worse = loopStep(r1.state, answer(9500), ctx);
    expect(worse.step).toEqual({ kind: 'stop', reason: 'noProgress' });
    expect(worse.state.best).toBe(0);
  });

  it('no progress: an answer with no usable rules', () => {
    const { ctx, answer, start } = setup();
    const r1 = loopStep(start(), answer(7000), ctx);
    const r2 = loopStep(r1.state, { rules: false, passes: false, wrong: Number.POSITIVE_INFINITY, wrongRows: [], otherProblems: [] }, ctx);
    expect(r2.step).toEqual({ kind: 'stop', reason: 'noProgress' });
    expect(r2.state.best).toBe(0);
  });

  it('round cap: after 3 rounds, the latest (better) answer is kept and no fourth round is made', () => {
    const { ctx, answer, start } = setup();
    let s = start();
    const cuts = [9400, 8000, 7000, 6000];
    const steps = cuts.map((cut) => {
      const r = loopStep(s, answer(cut), ctx);
      s = r.state;
      return r.step;
    });
    expect(steps.slice(0, 3).map((x) => x.kind)).toEqual(['next', 'next', 'next']);
    expect(steps[3]).toEqual({ kind: 'stop', reason: 'roundCap' });
    expect(s.rounds).toBe(3);
    expect(s.best).toBe(3);
  });

  it('row cap: never more than 40 masked rows in one learn, the payload\'s samples included', () => {
    const { ctx, answer, start, built } = setup();
    const base = built.payload.samples.length + (built.payload.dropped?.length ?? 0);
    const caps = { ...CAPS, maxRowsTotal: base + 10, maxRounds: 5 };
    const r1 = loopStep(start(), answer(9400), { ...ctx, caps });
    const r2 = loopStep(r1.state, answer(8500), { ...ctx, caps });
    expect(r1.step.kind === 'next' && r1.step.rows.length).toBe(8);
    expect(r2.step.kind === 'next' && r2.step.rows.length).toBe(2); // only 2 left under the cap
    const r3 = loopStep(r2.state, answer(8000), { ...ctx, caps });
    expect(r3.step).toEqual({ kind: 'stop', reason: 'rowCap' });
  });

  it('payload cap: it limits only the new rows the request carries - the rest are still named in the problems', () => {
    const { pair, ctx, answer, start, built } = setup();
    const bytes = payloadBytes(built.payload);
    const tight = { ...CAPS, maxBytes: bytes + 300 }; // room for a few rows, not eight
    const r1 = loopStep(start(), answer(9400), { ...ctx, caps: tight });
    if (r1.step.kind !== 'next') throw new Error('expected a round');
    expect(r1.step.rows.length).toBeGreaterThan(0);
    expect(r1.step.rows.length).toBeLessThan(8);
    expect(r1.step.rows.length + r1.step.namedOnly.length).toBe(8);
    expect(payloadBytes(withRows(built.payload, r1.state.sent.map((r) => r.sample)))).toBeLessThanOrEqual(tight.maxBytes);
    // every picked row has its diff, carried or not
    const named = new Set(r1.step.problems.flatMap((p) => (p.kind === 'diff' && p.row ? [String(p.row.in[0])] : [])));
    for (const inRow of [...r1.step.rows.map((r) => r.inRow), ...r1.step.namedOnly]) expect(named.has(String(pair.input[inRow + 1]![0]))).toBe(true);
  });

  it('a payload already at the byte cap still gets a round with the problems alone (as the one repair did); payloadCap only when even that does not fit', () => {
    const { pair, ctx, answer, start, built } = setup();
    const bytes = payloadBytes(built.payload);
    const atCap = { ...CAPS, maxBytes: bytes }; // not one more byte for a row
    const base = built.payload.samples.length + (built.payload.dropped?.length ?? 0);
    const r1 = loopStep(start(), answer(9400), { ...ctx, caps: atCap });
    if (r1.step.kind !== 'next') throw new Error('expected a problems-only round');
    expect(r1.step.rows).toEqual([]);
    expect(r1.step.namedOnly).toHaveLength(8);
    const named = new Set(r1.step.problems.flatMap((p) => (p.kind === 'diff' && p.row ? [String(p.row.in[0])] : [])));
    for (const inRow of r1.step.namedOnly) expect(named.has(String(pair.input[inRow + 1]![0]))).toBe(true);
    expect(r1.state.sent).toEqual([]);
    expect(r1.state.named).toEqual(r1.step.namedOnly);
    // the rows it named count as sent: never picked again, and towards the 40
    const r2 = loopStep(r1.state, answer(8000), { ...ctx, caps: atCap });
    if (r2.step.kind !== 'next') throw new Error('expected a second round');
    const first = new Set(r1.step.namedOnly);
    expect(r2.step.namedOnly.some((r) => first.has(r))).toBe(false);
    expect(loopStep(r1.state, answer(8000), { ...ctx, caps: { ...atCap, maxRowsTotal: base + 8 } }).step).toEqual({ kind: 'stop', reason: 'rowCap' });
    // not even the payload fits: payloadCap
    const over = loopStep(start(), answer(9400), { ...ctx, caps: { ...CAPS, maxBytes: bytes - 1 } });
    expect(over.step).toEqual({ kind: 'stop', reason: 'payloadCap' });
  });

  it('nothing to send: not good, yet no row and no other problem to name', () => {
    const { ctx, start } = setup();
    const r = loopStep(start(), { rules: true, passes: false, wrong: 1, wrongRows: [], otherProblems: [] }, ctx);
    expect(r.step).toEqual({ kind: 'stop', reason: 'nothingToSend' });
  });
});

describe('loopStep: what a round sends', () => {
  it('up to 8 rows the rules got wrong, never a sample row, and one diff for each (at most 10 problems)', () => {
    const { pair, ctx, answer, start, built } = setup();
    const r = loopStep(start(), answer(9400), ctx);
    if (r.step.kind !== 'next') throw new Error('expected a round');
    const wrongRows = new Set(wrongWithCutoff(pair, 9400));
    const sampleRows = new Set(built.sampleRows.map((s) => s.in));
    expect(r.step.round).toBe(1);
    expect(r.step.rows).toHaveLength(8);
    for (const row of r.step.rows) {
      expect(wrongRows.has(row.inRow)).toBe(true);
      expect(sampleRows.has(row.inRow)).toBe(false);
    }
    const diffs = r.step.problems.filter((p) => p.kind === 'diff');
    expect(diffs.length).toBeGreaterThanOrEqual(8);
    expect(diffs.length).toBeLessThanOrEqual(10);
    expect(diffs[0]).toMatchObject({ kind: 'diff', out: 2, expected: 'Urgent', actual: 'Normal', row: { in: expect.any(Array), out: expect.any(Array) } });
    expect(r.state.sent.map((x) => x.inRow)).toEqual(r.step.rows.map((x) => x.inRow));
  });

  it('a later round adds new rows only; the problems put the fixed lock first and the rest after the rows', () => {
    const { ctx, answer, start } = setup();
    const fixed: RepairProblem = { kind: 'fixedMismatch', path: 'output.columns[0].from', message: 'x' };
    const layout: RepairProblem = { kind: 'layout', message: 'y' };
    const r1 = loopStep(start(), answer(9400), ctx);
    const r2 = loopStep(r1.state, answer(8000, [fixed, layout]), ctx);
    if (r1.step.kind !== 'next' || r2.step.kind !== 'next') throw new Error('expected two rounds');
    const first = new Set(r1.step.rows.map((x) => x.inRow));
    expect(r2.step.round).toBe(2);
    expect(r2.step.rows.every((x) => !first.has(x.inRow))).toBe(true);
    expect(r2.state.sent).toHaveLength(r1.step.rows.length + r2.step.rows.length);
    expect(r2.step.problems[0]).toEqual(fixed);
    expect(r2.step.problems.at(-1)).toEqual(layout);
  });

  it('with masking: rows and problems carry no real name, and a value has the same fake in every round', () => {
    const { pair, ctx, answer, start } = setup({ masking: true });
    const r1 = loopStep(start(), answer(9400), ctx);
    const r2 = loopStep(r1.state, answer(8000), ctx);
    if (r1.step.kind !== 'next' || r2.step.kind !== 'next') throw new Error('expected two rounds');
    const sent = JSON.stringify([r1.step, r2.step]);
    for (const name of new Set(pair.input.slice(1).map((r) => r[1] as string))) expect(sent).not.toContain(name);
    // The same customer in two rounds is the same fake name (the masker is the learn's own: one key per session).
    const nameOf = new Map<string, string>(); // real -> fake
    for (const row of [...r1.step.rows, ...r2.step.rows]) {
      const real = pair.input[row.inRow + 1]![1] as string;
      const fake = row.sample.in[1] as string;
      expect(fake).not.toBe(real);
      if (nameOf.has(real)) expect(nameOf.get(real)).toBe(fake);
      nameOf.set(real, fake);
    }
    expect(nameOf.size).toBeLessThan(r1.step.rows.length + r2.step.rows.length); // (some customer came up twice)
  });

  it('is deterministic: the same state and answer give the same step', () => {
    const { ctx, answer, start } = setup({ masking: true });
    expect(JSON.stringify(loopStep(start(), answer(9400), ctx))).toBe(JSON.stringify(loopStep(start(), answer(9400), ctx)));
  });
});

describe('verifyAgainstExample: the wrong rows and masked repair problems', () => {
  it('lists every wrong row (only when asked), in file order, with real values', () => {
    const { pair, a } = setup();
    const v = verifyAgainstExample(priorityRules(9400), a, { wrongRows: true });
    expect(v.wrongRows!.map((r) => r.inRow)).toEqual(wrongWithCutoff(pair, 9400));
    expect(v.wrongRows![0]!.cells).toEqual([{ out: 2, outRow: expect.any(Number), expected: 'Urgent', actual: 'Normal' }]);
    expect(verifyAgainstExample(priorityRules(9400), a).wrongRows).toBeUndefined();
  });

  it('masks a diff problem\'s expected and actual values too, not only its row', () => {
    const { a } = setup();
    const rules = priorityRules(5000);
    const broken = { ...rules, output: { ...rules.output, columns: rules.output.columns.map((c) => (c.header === 'Customer' ? { ...c, from: 'status' } : c)) } };
    const masker = createMasker(new TextEncoder().encode('verify-mask'));
    const v = verifyAgainstExample(broken, a, { masker });
    const diff = v.repairProblems.find((p) => p.kind === 'diff');
    expect(diff).toBeDefined();
    expect(JSON.stringify(v.repairProblems)).not.toMatch(/Dana Levi|Yossi Cohen|Noa Peretz/);
    expect(v.mismatches[0]!.expected).toBe('Dana Levi'); // the UI's copy stays real
  });
});

// Prompt audit X1: a problem's `row.out` is always the example's own output row - nothing (`[]`) for a row the example dropped - and the
// row the rules made where the example has none is `made`. (It used to be `row.out` in that one case, so the field meant two things.)
describe('a row the rules make that the example does not have: row.out is the example\'s (nothing), the rules\' row is `made`', () => {
  /** 30 orders, every 4th one "void" and dropped from the example output; rules that copy both columns and filter nothing keep them. */
  function droppedPair(): { input: V[][]; output: V[][] } {
    const input: V[][] = [['Ref', 'Name', 'Status']];
    const output: V[][] = [['Ref', 'Name']];
    for (let i = 0; i < 30; i++) {
      const status = i % 4 === 3 ? 'void' : 'ok';
      input.push([`R-${100 + i}`, `Name ${i}`, status]);
      if (status === 'ok') output.push([`R-${100 + i}`, `Name ${i}`]);
    }
    return { input, output };
  }
  const keepAll: LearnResult = {
    schemaVersion: 1,
    input: {
      sheet: { pick: 'first' },
      headerRow: 'auto',
      columns: [
        { id: 'ref', header: 'Ref', type: 'text' },
        { id: 'name', header: 'Name', type: 'text' },
      ],
    },
    transform: { computed: [], valueMaps: [], sort: [] },
    output: { sheetName: 'Sheet1', direction: 'ltr', language: 'en', titleRows: [], columns: [{ header: 'Ref', from: 'ref' }, { header: 'Name', from: 'name' }] },
    validations: [],
    unsupported: [],
    assumptions: [],
  };

  it('verifyAgainstExample: a dropped row the rules keep', () => {
    const { a } = analyzeWithPreflight(droppedPair());
    const v = verifyAgainstExample(keepAll, a);
    const extra = v.repairProblems.find((p) => p.kind === 'diff' && p.expected === null);
    expect(extra).toEqual({ kind: 'diff', out: 0, row: { in: ['R-103', 'Name 3', 'void'], out: [] }, made: ['R-103', 'Name 3'], expected: null, actual: 'R-103' });
  });

  it('a loop round sends it the same way, every value masked (made included)', () => {
    const pair = droppedPair();
    const { a, pf } = analyzeWithPreflight(pair);
    const masker = createMasker(new TextEncoder().encode('x1-test'));
    const built = buildPayload(a, pf, { masker });
    const ctx: LoopContext = { analysis: a, payload: built.payload, masker, caps: CAPS };
    const v = verifyAgainstExample(keepAll, a, { wrongRows: true });
    const r = loopStep(startLoop([...built.sampleRows.map((s) => s.in), ...built.droppedRows]), { rules: true, passes: false, wrong: wrongCount(v.wrongRows!, 0), wrongRows: v.wrongRows!, otherProblems: [] }, ctx);
    if (r.step.kind !== 'next') throw new Error('expected a round');
    const extras = r.step.problems.filter((p) => p.kind === 'diff' && p.expected === null);
    expect(extras.length).toBeGreaterThan(0);
    for (const p of extras) {
      if (p.kind !== 'diff') continue;
      expect(p.row?.out).toEqual([]);
      expect(p.made).toHaveLength(2);
      expect(p.made![0]).toBe(p.actual);
      // the row's input and the made row hold the same (masked) reference: same word, same fake
      expect(p.made![0]).toBe(p.row!.in[0]);
      expect(String(p.made![1])).not.toMatch(/^Name \d+$/);
    }
  });
});

describe('counterexampleSample: a row of the example as a sample, built like the payload\'s', () => {
  it('a family when rows expand (the input row and all its output rows), a pair otherwise, no output rows for a row the example dropped', () => {
    const fam = analyzeWithPreflight(columnsToRowsPair()).a;
    const famIn = fam.alignment.rows[0]!.in;
    const famSample = counterexampleSample(fam, famIn);
    expect(Array.isArray(famSample.out[0])).toBe(true);
    expect((famSample.out as unknown[][]).length).toBe(fam.alignment.rows.filter((r) => r.in === famIn).length);

    const input: V[][] = [['Ref', 'Name', 'Status']];
    const output: V[][] = [['Ref', 'Name']];
    for (let i = 0; i < 12; i++) {
      const status = i === 5 ? 'void' : 'ok';
      input.push([`R-${100 + i}`, `Name ${i}`, status]);
      if (status === 'ok') output.push([`R-${100 + i}`, `Name ${i}`]);
    }
    const a = analyzeOk(xlsx(input), xlsx(output));
    expect(a.alignment.droppedIn).toEqual([5]);
    expect(counterexampleSample(a, 5)).toEqual({ in: ['R-105', 'Name 5', 'void'], out: [] });
    expect(counterexampleSample(a, 2)).toEqual({ in: ['R-102', 'Name 2', 'ok'], out: ['R-102', 'Name 2'] });
  });
});

describe('the payload helpers the loop shares with the server', () => {
  it('withRows adds rows to the samples; the payload the AI step reads is unchanged', () => {
    const { built } = setup();
    const p: LearnPayload = built.payload;
    const extra = [{ in: ['x'], out: ['y'] }];
    expect(withRows(p, extra).samples).toHaveLength(p.samples.length + 1);
    expect(withRows(p, [])).toBe(p);
    expect(p.samples).toHaveLength(built.sampleRows.length);
  });
});
