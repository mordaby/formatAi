// The free engine and across-row (window) patterns (docs/proposals/window-operations.md, owner decisions): it builds ONLY the order-independent
// ones - a group's total on every row (`groupSum(x, by: g)`) and a count per group (`groupCount(by: g)`), exact on every aligned row - and
// refuses everything that depends on the order of the rows (running totals, row numbers, previous / next, fill down, rank), which are found only
// as hints for the AI step (sent since learn-v7, `limits.learn.window.hintsEnabled`). Two equally fitting columns build nothing.
import { checkRules, limits } from '@formatai/shared';
import { describe, expect, it } from 'vitest';
import { typeCheck } from '../../src/check';
import { analyzePair, type PairAnalysis, type WindowFinding } from '../../src/learn/analyze';
import { fastPath, type FastPathResult } from '../../src/learn/fastPath';
import { relationsToHints, windowHintCandidate } from '../../src/learn/hints';
import { buildPayload } from '../../src/learn/payload';
import { preflight } from '../../src/learn/preflight';
import { runOk, table, values, type CellInput } from '../pipeline/helpers';
import { xlsx, type V } from './analyze/helpers';

type Cell = string | number | null;
/** A row built from indexed cells (indexing may give undefined to the type checker; the data never does). */
type Row = (Cell | undefined)[];

const IN_HEADERS = ['Id', 'Dept', 'Region', 'Amount', 'Score'];
// 12 rows, 3 departments (A: 5 rows, B: 4, C: 3), a region per department's pair of rows, amounts and a score with a tie.
const IN_ROWS: Row[] = [
  [1, 'A', 'north', 10, 70],
  [2, 'B', 'south', 5, 90],
  [3, 'A', 'north', 20, 70],
  [4, 'C', 'east', 7, 50],
  [5, 'B', 'south', 15, 80],
  [6, 'A', 'west', 30, 60],
  [7, 'A', 'west', 40, 95],
  [8, 'C', 'east', 3, 55],
  [9, 'B', 'south', 25, 85],
  [10, 'A', 'north', 50, 65],
  [11, 'C', 'east', 11, 40],
  [12, 'B', 'south', 35, 75],
];

function analyze(inRows: Row[], outHeaders: string[], outRows: Row[], inHeaders = IN_HEADERS): PairAnalysis {
  const a = analyzePair(xlsx([inHeaders, ...(inRows as V[][])]), xlsx([outHeaders, ...(outRows as V[][])]));
  if (!a.ok) throw new Error(`analysis failed: ${JSON.stringify(a.issues)}`);
  return a;
}

function tryFastPath(a: PairAnalysis): FastPathResult {
  return fastPath(a, preflight(a, 'registered'));
}

/** fastPath succeeded AND the rules it wrote are clean and reproduce the example output when run on the same input. */
function builds(inRows: Row[], outHeaders: string[], outRows: Row[], inHeaders = IN_HEADERS) {
  const a = analyze(inRows, outHeaders, outRows, inHeaders);
  const result = tryFastPath(a);
  if (!('rules' in result)) throw new Error(`fastPath did not build: ${JSON.stringify(result)}`);
  expect(checkRules(result.rules), 'checkRules').toEqual([]);
  expect(typeCheck(result.rules), 'typeCheck').toEqual([]);
  const ran = runOk(result.rules, table(inHeaders, inRows as CellInput[][]));
  expect(values(ran.sheet), 'the rules reproduce the example').toEqual(outRows);
  return { a, rules: result.rules };
}

function groupSums(by: (r: Row) => string, pick: (r: Row) => number): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of IN_ROWS) m.set(by(r), (m.get(by(r)) ?? 0) + pick(r));
  return m;
}

const dept = (r: Row): string => r[1] as string;
const amount = (r: Row): number => r[3] as number;
const totals = groupSums(dept, amount); // A 150, B 80, C 21

describe('built: a group total on every row, a count per group', () => {
  it('groupSum(amount, by: dept) - and it is not memorized as a value map of the department', () => {
    const outRows = IN_ROWS.map((r) => [r[0], r[1], r[3], totals.get(dept(r))!]);
    const { a, rules } = builds(IN_ROWS, ['Id', 'Dept', 'Amount', 'Dept total'], outRows);
    const col = a.columns[3]!;
    // the window relation outranks the value map the same cells also fit
    expect(col.relations[0]).toMatchObject({ rel: 'window', fn: 'groupSum', coverage: 1 });
    expect(col.relations.some((r) => r.rel === 'valueMap')).toBe(true);
    const computed = rules.transform.computed.find((c) => c.expr && 'op' in c.expr && c.expr.op === 'window');
    expect(computed).toBeDefined();
    expect(computed!.expr).toEqual({ op: 'window', fn: 'groupSum', arg: { col: 'amount' }, by: ['dept'] });
    expect(computed!.type).toBe('integer');
    expect(rules.transform.valueMaps).toEqual([]);
  });

  it('groupCount(by: dept)', () => {
    const counts = new Map<string, number>();
    for (const r of IN_ROWS) counts.set(dept(r), (counts.get(dept(r)) ?? 0) + 1);
    const outRows = IN_ROWS.map((r) => [r[0], r[1], counts.get(dept(r))!]);
    const { rules } = builds(IN_ROWS, ['Id', 'Dept', 'Rows in dept'], outRows);
    const computed = rules.transform.computed.find((c) => 'op' in c.expr && c.expr.op === 'window');
    expect(computed!.expr).toEqual({ op: 'window', fn: 'groupCount', by: ['dept'] });
    expect(computed!.type).toBe('integer');
  });

  it('exact decimals: group totals of cents, no float drift', () => {
    const rows: Row[] = [
      [1, 'A', 'n', 0.1, 1],
      [2, 'A', 'n', 0.2, 1],
      [3, 'B', 'n', 0.7, 1],
      [4, 'B', 'n', 0.1, 1],
      [5, 'A', 'n', 0.3, 1],
      [6, 'B', 'n', 0.2, 1],
    ];
    // A: 0.1 + 0.2 + 0.3 = 0.6; B: 0.7 + 0.1 + 0.2 = 1 (a float sum would give 0.6000000000000001 and 0.9999999999999999)
    const out = rows.map((r) => [r[0], r[3], dept(r) === 'A' ? 0.6 : 1]);
    const { rules } = builds(rows, ['Id', 'Amount', 'Total'], out);
    const computed = rules.transform.computed.find((c) => 'op' in c.expr && c.expr.op === 'window')!;
    expect(computed.type).toBe('decimal');
  });

  it('only over the rows that remain: a dropped (filtered) row is not in the total, and the filter is built with it', () => {
    // Department D rows are dropped from the output; the totals shown are over the kept rows only.
    const rows: Row[] = [...IN_ROWS, [13, 'D', 'x', 1000, 1], [14, 'D', 'x', 2000, 1]];
    const outRows = IN_ROWS.map((r) => [r[0], r[1], r[3], totals.get(dept(r))!]);
    const a = analyze(rows, ['Id', 'Dept', 'Amount', 'Dept total'], outRows);
    const result = tryFastPath(a);
    if (!('rules' in result)) throw new Error(`fastPath did not build: ${JSON.stringify(result)}`);
    expect(result.rules.input.rowFilters?.length).toBeGreaterThan(0);
    const ran = runOk(result.rules, table(IN_HEADERS, rows as CellInput[][]));
    expect(values(ran.sheet)).toEqual(outRows);
  });

  it('the group column is text, an id or an integer, never the alignment key', () => {
    const a = analyze(IN_ROWS, ['Id', 'Dept', 'Amount', 'Dept total'], IN_ROWS.map((r) => [r[0], r[1], r[3], totals.get(dept(r))!]));
    const win = a.columns[3]!.relations.find((r) => r.rel === 'window');
    expect(win).toMatchObject({ by: [1], in: [3] });
    expect(a.alignment.key?.in).toEqual([0]);
  });
});

describe('not built: guards against taking something else for a window', () => {
  it('a plain copy of the column is a copy, not a group total of groups of one', () => {
    const outRows = IN_ROWS.map((r) => [r[0], r[1], r[3], r[3]]);
    const a = analyze(IN_ROWS, ['Id', 'Dept', 'Amount', 'Same'], outRows);
    expect(a.columns[3]!.relations[0]).toMatchObject({ rel: 'copy' });
    expect(a.columns[3]!.relations.some((r) => r.rel === 'window')).toBe(false);
    expect(a.columns[3]!.windows).toBeUndefined();
  });

  it('a single group is a constant, not a group total', () => {
    const rows = IN_ROWS.map((r) => [r[0], 'A', r[2], r[3], r[4]]);
    const outRows = rows.map((r) => [r[0], r[3], 150 + 80 + 21]);
    const a = analyze(rows, ['Id', 'Amount', 'Total'], outRows);
    expect(a.columns[2]!.relations.some((r) => r.rel === 'window')).toBe(false);
  });

  it('too few rows (under limits.learn.window.minRows) are not evidence', () => {
    const rows: Row[] = [
      [1, 'A', 'n', 10, 1],
      [2, 'B', 'n', 5, 1],
      [3, 'A', 'n', 20, 1],
    ];
    const outRows = [
      [1, 'A', 30],
      [2, 'B', 5],
      [3, 'A', 30],
    ];
    const a = analyze(rows, ['Id', 'Dept', 'Total'], outRows);
    expect(a.columns[2]!.relations.some((r) => r.rel === 'window')).toBe(false);
    expect(a.columns[2]!.windows).toBeUndefined();
    expect(limits.learn.window.minRows).toBe(4);
  });

  it('a total over rows the output does not keep is not a group total of what remains', () => {
    // The shown totals include a department-A row (id 99) that is not in the output.
    const rows: Row[] = [...IN_ROWS, [99, 'A', 'n', 500, 1]];
    const outRows = IN_ROWS.map((r) => [r[0], r[1], r[3], totals.get(dept(r))! + (dept(r) === 'A' ? 500 : 0)]);
    const a = analyze(rows, ['Id', 'Dept', 'Amount', 'Total'], outRows);
    expect(a.columns[3]!.relations.some((r) => r.rel === 'window')).toBe(false);
  });

  it('one wrong row is not exact: coverage 0.9-0.99 is a hint only, never built', () => {
    const outRows = IN_ROWS.map((r, i) => [r[0], r[1], r[3], totals.get(dept(r))! + (i === 4 ? 1 : 0)]);
    const rows = IN_ROWS.concat([]);
    // 12 rows: 11/12 = 0.917 >= 0.9
    const a = analyze(rows, ['Id', 'Dept', 'Amount', 'Total'], outRows);
    expect(a.columns[3]!.relations.some((r) => r.rel === 'window')).toBe(false);
    const f = a.columns[3]!.windows?.find((w) => w.fn === 'groupSum');
    expect(f).toBeDefined();
    expect(f!.coverage).toBeCloseTo(11 / 12);
    expect(f!.built).toBe(false);
    expect(f!.failing).toEqual([4]);
    expect(tryFastPath(a)).toMatchObject({ reason: expect.any(String) });
  });

  it('two equally fitting group columns (a code and its name) are an ambiguity: nothing is built, the other goes in alt', () => {
    const rows: Row[] = IN_ROWS.map((r) => [r[0], r[1], r[2], r[3], r[1] === 'A' ? 'Alpha' : r[1] === 'B' ? 'Beta' : 'Gamma']);
    const outRows = IN_ROWS.map((r) => [r[0], r[3], totals.get(dept(r))!]);
    const a = analyze(rows, ['Id', 'Amount', 'Dept total'], outRows, ['Id', 'Dept', 'Region', 'Amount', 'Dept name']);
    const windows = a.columns[2]!.relations.filter((r) => r.rel === 'window');
    expect(windows.length).toBe(2);
    expect(tryFastPath(a)).toMatchObject({ reason: 'ambiguousColumn' });
    const finding = a.columns[2]!.windows![0]!;
    expect(finding).toMatchObject({ fn: 'groupSum', coverage: 1 });
    expect(finding.alt).toHaveLength(1);
    expect([finding.by[0], finding.alt![0]!.by![0]].sort()).toEqual([1, 4]);
  });

  it('two columns that add up to the same group totals are an ambiguity too (two x)', () => {
    const rows: Row[] = IN_ROWS.map((r) => [r[0], r[1], r[2], r[3], r[3]]);
    const outRows = IN_ROWS.map((r) => [r[0], r[1], totals.get(dept(r))!]);
    const a = analyze(rows, ['Id', 'Dept', 'Total'], outRows, ['Id', 'Dept', 'Region', 'Amount', 'Amount again']);
    expect(tryFastPath(a)).toMatchObject({ reason: 'ambiguousColumn' });
  });
});

describe('never built: whatever depends on the order of the rows', () => {
  const runningOf = (rows: Row[]): number[] => {
    let acc = 0;
    return rows.map((r) => (acc += amount(r)));
  };

  function expectHintOnly(a: PairAnalysis, col: number, fn: string): WindowFinding {
    const ca = a.columns[col]!;
    expect(ca.relations.some((r) => r.rel === 'window'), 'no window relation').toBe(false);
    const f = ca.windows?.find((w) => w.fn === fn);
    expect(f, `a ${fn} finding`).toBeDefined();
    expect(f!.coverage).toBe(1);
    expect(f!.built).toBe(false);
    const result = tryFastPath(a);
    // the AI step gets the column: the fast path neither builds it nor a lookalike (a value map of the key)
    expect(result).toMatchObject({ reason: 'columnNotFullyExplained' });
    return f!;
  }

  it('a running total (global, in file order)', () => {
    const run = runningOf(IN_ROWS);
    const a = analyze(IN_ROWS, ['Id', 'Amount', 'Balance'], IN_ROWS.map((r, i) => [r[0], r[3], run[i]!]));
    const f = expectHintOnly(a, 2, 'runningSum');
    expect(f).toMatchObject({ in: [3], by: [], order: 'file' });
  });

  it('a running total per group', () => {
    const acc = new Map<string, number>();
    const out = IN_ROWS.map((r) => {
      const v = (acc.get(dept(r)) ?? 0) + amount(r);
      acc.set(dept(r), v);
      return [r[0], r[1], r[3], v];
    });
    const a = analyze(IN_ROWS, ['Id', 'Dept', 'Amount', 'Balance'], out);
    const f = expectHintOnly(a, 3, 'runningSum');
    expect(f).toMatchObject({ in: [3], by: [1], order: 'file' });
  });

  it('a row number, global and per group', () => {
    const a = analyze(IN_ROWS, ['Id', 'Amount', 'No'], IN_ROWS.map((r, i) => [r[0], r[3], i + 1]));
    // a column 1..12 equal to the Id column is a copy of Id: the window is only looked for where nothing simpler explains the column
    expect(a.columns[2]!.relations[0]).toMatchObject({ rel: 'copy' });
    const rows = IN_ROWS.map((r) => [100 + 3 * (r[0] as number), r[1], r[2], r[3], r[4]]);
    const seen = new Map<string, number>();
    const out = rows.map((r) => {
      const n = (seen.get(dept(r)) ?? 0) + 1;
      seen.set(dept(r), n);
      return [r[0], r[1], n];
    });
    const b = analyze(rows, ['Id', 'Dept', 'Line in dept'], out);
    expectHintOnly(b, 2, 'rowNumber');
  });

  it('previous / next / fill down', () => {
    const prev = IN_ROWS.map((r, i) => [r[0], r[3], i === 0 ? null : amount(IN_ROWS[i - 1]!)]);
    expectHintOnly(analyze(IN_ROWS, ['Id', 'Amount', 'Previous'], prev), 2, 'previous');
    const next = IN_ROWS.map((r, i) => [r[0], r[3], i === IN_ROWS.length - 1 ? null : amount(IN_ROWS[i + 1]!)]);
    expectHintOnly(analyze(IN_ROWS, ['Id', 'Amount', 'Next'], next), 2, 'next');
    // a text column with gaps, filled down
    const gaps: Row[] = IN_ROWS.map((r, i) => [r[0], r[1], r[2], r[3], r[4], i % 4 === 0 ? `cat ${i / 4 + 1}` : null]);
    let last: Cell = null;
    const filled = gaps.map((r) => {
      if (r[5] !== null) last = r[5] ?? null;
      return [r[0], r[3], last];
    });
    const a = analyze(gaps, ['Id', 'Amount', 'Category'], filled, [...IN_HEADERS, 'Cat']);
    expectHintOnly(a, 2, 'fillDown');
  });

  it('a rank, with a tie (min and dense)', () => {
    // rank of Score, highest first: scores 95, 90, 85, 80, 75, 70, 70, 65, 60, 55, 50, 40 -> the two 70s share rank 6
    const sorted = [...IN_ROWS].map((r) => r[4] as number).sort((x, y) => y - x);
    const rankMin = (v: number): number => sorted.indexOf(v) + 1;
    const rankDense = (v: number): number => [...new Set(sorted)].indexOf(v) + 1;
    const a = analyze(IN_ROWS, ['Id', 'Score', 'Rank'], IN_ROWS.map((r) => [r[0], r[4], rankMin(r[4] as number)]));
    const f = expectHintOnly(a, 2, 'rank');
    expect(f).toMatchObject({ order: [{ in: 4, dir: 'desc' }], ties: 'min', by: [] });
    const b = analyze(IN_ROWS, ['Id', 'Score', 'Rank'], IN_ROWS.map((r) => [r[0], r[4], rankDense(r[4] as number)]));
    expect(expectHintOnly(b, 2, 'rank')).toMatchObject({ order: [{ in: 4, dir: 'desc' }], ties: 'dense' });
  });

  it('group average, minimum and maximum (order-independent, but not built: hints only)', () => {
    const sums = totals;
    const counts = new Map<string, number>();
    for (const r of IN_ROWS) counts.set(dept(r), (counts.get(dept(r)) ?? 0) + 1);
    const avg = IN_ROWS.map((r) => [r[0], r[1], r[3], sums.get(dept(r))! / counts.get(dept(r))!]);
    // A: 150/5 = 30, B: 80/4 = 20, C: 21/3 = 7: whole numbers, exact
    const a = analyze(IN_ROWS, ['Id', 'Dept', 'Amount', 'Average'], avg);
    expectHintOnly(a, 3, 'groupAvg');
    const mins = new Map<string, number>();
    for (const r of IN_ROWS) mins.set(dept(r), Math.min(mins.get(dept(r)) ?? Infinity, amount(r)));
    const b = analyze(IN_ROWS, ['Id', 'Dept', 'Amount', 'Smallest'], IN_ROWS.map((r) => [r[0], r[1], r[3], mins.get(dept(r))!]));
    expectHintOnly(b, 3, 'groupMin');
  });

  it('the order the output shows, when only that order explains a running total', () => {
    // The output lists the rows sorted by amount; the running total follows THAT order, not the file's.
    const byAmount = [...IN_ROWS].sort((x, y) => amount(x) - amount(y));
    let acc = 0;
    const out = byAmount.map((r) => [r[0], r[3], (acc += amount(r))]);
    const a = analyze(IN_ROWS, ['Id', 'Amount', 'Balance'], out);
    const f = a.columns[2]!.windows?.find((w) => w.fn === 'runningSum');
    expect(f).toMatchObject({ order: 'output', in: [3], coverage: 1 });
    expect(a.columns[2]!.relations.some((r) => r.rel === 'window')).toBe(false);
  });
});

describe('the hint (shape and switch)', () => {
  const groupTotalPair = () => {
    const out = IN_ROWS.map((r) => [r[0], r[1], r[3], totals.get(dept(r))!]);
    return analyze(IN_ROWS, ['Id', 'Dept', 'Amount', 'Dept total'], out);
  };
  const runningPair = () => {
    let acc = 0;
    return analyze(IN_ROWS, ['Id', 'Amount', 'Balance'], IN_ROWS.map((r) => [r[0], r[3], (acc += amount(r))]));
  };
  const withSwitch = <T,>(on: boolean, f: () => T): T => {
    const w = limits.learn.window as unknown as { hintsEnabled: boolean };
    const before = w.hintsEnabled;
    w.hintsEnabled = on;
    try {
      return f();
    } finally {
      w.hintsEnabled = before;
    }
  };
  const hintsOf = (a: PairAnalysis) => relationsToHints(a, preflight(a, 'registered'));

  it('the switch is ON since learn-v7 (the prompt documents the window functions)', () => {
    expect(limits.learn.window.hintsEnabled).toBe(true);
  });

  it('on (the default): the learn payload carries the window hints for a detected pattern, with the shapes the prompt documents', () => {
    // a running total (order-dependent: never built by the free engine, always a hint for the AI step)
    const run = runningPair();
    const { payload } = buildPayload(run, preflight(run, 'registered'));
    const w = payload.hints.find((h) => h.rel === 'window');
    expect(w).toEqual({ out: 2, rel: 'window', fn: 'runningSum', in: [3], order: 'file', coverage: 1 });
    // the column has no other hint (no misleading lookalike next to it)
    expect(payload.hints.filter((h) => 'out' in h && h.out === 2)).toHaveLength(1);
    // a group total: hinted too (the AI step may be asked after the free engine could not build everything else)
    const g = groupTotalPair();
    const { payload: gp } = buildPayload(g, preflight(g, 'registered'));
    expect(gp.hints.find((h) => h.rel === 'window')).toEqual({ out: 3, rel: 'window', fn: 'groupSum', in: [3], by: [1], coverage: 1 });
    // the serialized payload stays compact (no values of the window columns are added)
    expect(JSON.stringify(payload).length).toBeLessThan(limits.payload.maxBytes);
  });

  it('a summary output (one row per group) carries no window hint: its rows are groups, not input rows - the totals are aggregate hints', () => {
    const depts = ['A', 'B', 'C'];
    const out = depts.map((d) => [d, totals.get(d)!, IN_ROWS.filter((r) => dept(r) === d).length]);
    const a = analyze(IN_ROWS, ['Dept', 'Total', 'Orders'], out);
    const { payload } = buildPayload(a, preflight(a, 'registered'));
    expect(payload.output.layout.summary).toBe(true);
    expect(payload.hints.some((h) => h.rel === 'window')).toBe(false);
    expect(payload.hints.filter((h) => 'out' in h).map((h) => [(h as { out: number }).out, h.rel])).toEqual([[0, 'copy'], [1, 'aggregate'], [2, 'aggregate']]);
    // ... and with the group total ALSO on a plain row-per-row output of the same data, the window hint is there (the guard is the shape, not the data)
    const plain = groupTotalPair();
    expect(buildPayload(plain, preflight(plain, 'registered')).payload.hints.some((h) => h.rel === 'window')).toBe(true);
  });

  it('switched off: the payload has no window hint (the pre-learn-v7 behaviour)', () => {
    const run = runningPair();
    const { payload } = withSwitch(false, () => buildPayload(run, preflight(run, 'registered')));
    expect(payload.hints.some((h) => h.rel === 'window')).toBe(false);
  });

  it('off: no window hint is sent, and a column the free engine knows is a group total gets no (misleading value map) hint at all', () => {
    const a = groupTotalPair();
    const hints = withSwitch(false, () => hintsOf(a));
    expect(hints.some((h) => h.rel === 'window')).toBe(false);
    expect(hints.some((h) => 'out' in h && h.out === 3)).toBe(false);
    // other columns are hinted as always
    expect(hints.some((h) => 'out' in h && h.out === 1 && h.rel === 'copy')).toBe(true);
    // a hint-only pattern is left as it was before windows existed (here: a column no relation explains gets no hint)
    const r = runningPair();
    expect(withSwitch(false, () => hintsOf(r)).some((h) => h.rel === 'window')).toBe(false);
  });

  it('on: the window finding is the column\'s hint, a fact at coverage 1, in the proposal\'s shape', () => {
    const hints = withSwitch(true, () => hintsOf(groupTotalPair()));
    const h = hints.find((x) => x.rel === 'window');
    expect(h).toEqual({ out: 3, rel: 'window', fn: 'groupSum', in: [3], by: [1], coverage: 1 });
    // the lookalike value map is not sent next to it
    expect(hints.filter((x) => 'out' in x && x.out === 3)).toHaveLength(1);

    const run = withSwitch(true, () => hintsOf(runningPair())).find((x) => x.rel === 'window');
    expect(run).toEqual({ out: 2, rel: 'window', fn: 'runningSum', in: [3], order: 'file', coverage: 1 });
  });

  it('on: rank carries its keys and ties; a partial coverage carries failingRows (the payload turns them into failsOn)', () => {
    const sorted = [...IN_ROWS].map((r) => r[4] as number).sort((x, y) => y - x);
    const out = IN_ROWS.map((r, i) => [r[0], r[4], sorted.indexOf(r[4] as number) + 1 + (i === 3 ? 1 : 0)]);
    const a = analyze(IN_ROWS, ['Id', 'Score', 'Rank'], out);
    const h = withSwitch(true, () => hintsOf(a)).find((x) => x.rel === 'window')!;
    expect(h).toMatchObject({ out: 2, rel: 'window', fn: 'rank', order: [{ in: 4, dir: 'desc' }], ties: 'min', failingRows: [3] });
    expect((h as { coverage: number }).coverage).toBeCloseTo(11 / 12);
  });

  it('on: an ambiguity carries alt (at most 3)', () => {
    const rows: Row[] = IN_ROWS.map((r) => [r[0], r[1], r[2], r[3], r[1] === 'A' ? 'Alpha' : r[1] === 'B' ? 'Beta' : 'Gamma']);
    const out = IN_ROWS.map((r) => [r[0], r[3], totals.get(dept(r))!]);
    const a = analyze(rows, ['Id', 'Amount', 'Total'], out, ['Id', 'Dept', 'Region', 'Amount', 'Dept name']);
    const h = withSwitch(true, () => hintsOf(a)).find((x) => x.rel === 'window')! as unknown as { alt?: { by?: number[] }[]; by: number[] };
    expect(h.alt).toHaveLength(1);
    expect([h.by[0], h.alt![0]!.by![0]].sort()).toEqual([1, 4]);
  });

  it('the builder: order is not said for a group function; only the first three alternatives are kept', () => {
    const f: WindowFinding = {
      out: 2,
      fn: 'groupSum',
      in: [3],
      by: [1],
      order: 'file',
      coverage: 1,
      matched: 12,
      total: 12,
      failing: [],
      failCount: 0,
      built: true,
      alt: [{ by: [4] }, { by: [5] }, { by: [6] }, { by: [7] }],
    };
    const h = windowHintCandidate(f);
    expect(h).toEqual({ out: 2, rel: 'window', fn: 'groupSum', in: [3], by: [1], coverage: 1, alt: [{ by: [4] }, { by: [5] }, { by: [6] }] });
    expect(windowHintCandidate({ ...f, fn: 'rowNumber', in: [], order: 'output', alt: undefined })).toEqual({ out: 2, rel: 'window', fn: 'rowNumber', by: [1], order: 'output', coverage: 1 });
  });
});
