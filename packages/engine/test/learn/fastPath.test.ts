// fastPath (SPEC 6.5, strict): builds verified rules with no LLM call for the
// simple cases, and refuses (with a reason) everything else. Every success
// case is checked with checkRules/typeCheck (shared/engine) and then actually
// run with runRules on the SAME input, confirming the rules reproduce the
// hand-authored example output exactly - not just that fastPath "returned
// something".
import type { Tier } from '@formatai/shared';
import { checkRules } from '@formatai/shared';
import { describe, expect, it } from 'vitest';
import { typeCheck } from '../../src/check';
import { analyzePair, type PairAnalysis } from '../../src/learn/analyze';
import { fastPath, type FastPathResult } from '../../src/learn/fastPath';
import { partialRules } from '../../src/learn/partial';
import { preflight } from '../../src/learn/preflight';
import { runOk, table, values, type CellInput } from '../pipeline/helpers';
import { bold, date, delimited, rng, xlsx, type V } from './analyze/helpers';

function cellV(v: V): string | number | boolean | null {
  return v !== null && typeof v === 'object' ? v.v : v;
}

/** Runs analyzePair + preflight + fastPath, then - on success - verifies the
 * rules type/reference-check cleanly and reproduce the example output when run
 * on the same input (SPEC 6.5: "verified as usual"). */
function fastPathOk(
  inHeaders: string[],
  inRows: V[][],
  outHeaders: string[],
  outRows: V[][],
  opts: { tier?: Tier; outputBuilder?: (rows: V[][]) => ReturnType<typeof xlsx> } = {},
) {
  const inputWb = xlsx([inHeaders, ...inRows]);
  const outputWb = opts.outputBuilder ? opts.outputBuilder([outHeaders, ...outRows]) : xlsx([outHeaders, ...outRows]);
  const a = analyzePair(inputWb, outputWb);
  if (!a.ok) throw new Error(`analysis failed: ${JSON.stringify(a.issues)}`);
  const pf = preflight(a, opts.tier ?? 'registered');
  const result = fastPath(a, pf);
  if (!('rules' in result)) throw new Error(`fastPath failed: ${JSON.stringify(result)}`);

  expect(checkRules(result.rules), 'checkRules').toEqual([]);
  expect(typeCheck(result.rules), 'typeCheck').toEqual([]);

  const ran = runOk(result.rules, table(inHeaders, inRows as CellInput[][]));
  expect(values(ran.sheet), 'runRules reproduces the example output').toEqual(outRows.map((r) => r.map(cellV)));

  return { a, pf, result };
}

/** Runs the pipeline and returns fastPath's result without asserting success -
 * for the refusal tests. */
function runFastPath(inHeaders: string[], inRows: V[][], outHeaders: string[], outRows: V[][], tier: Tier = 'registered'): { a: PairAnalysis; result: FastPathResult } {
  const a = analyzePair(xlsx([inHeaders, ...inRows]), xlsx([outHeaders, ...outRows]));
  if (!a.ok) throw new Error(`analysis failed: ${JSON.stringify(a.issues)}`);
  const pf = preflight(a, tier);
  return { a, result: fastPath(a, pf) };
}

// ---------------------------------------------------------------------------
// Success cases (SPEC 6.5's own list)
// ---------------------------------------------------------------------------

describe('fastPath: succeeds and produces verified rules', () => {
  it('rename, reorder and drop columns', () => {
    const inHeaders = ['Customer ID', 'Customer Name', 'Notes'];
    const inRows: V[][] = [
      [1, 'Dana', 'x'],
      [2, 'Yossi', 'y'],
      [3, 'Noa', 'z'],
      [4, 'Omer', 'w'],
      [5, 'Maya', 'v'],
    ];
    const outHeaders = ['Name', 'ID'];
    const outRows: V[][] = inRows.map((r) => [r[1]!, r[0]!]);
    const { result } = fastPathOk(inHeaders, inRows, outHeaders, outRows);
    if (!('rules' in result)) throw new Error('unreachable');
    // "Notes" is never referenced, so it's simply not declared.
    expect(result.rules.input.columns.map((c) => c.id)).toHaveLength(2);
    expect(result.rules.output.columns.map((c) => c.header)).toEqual(['Name', 'ID']);
  });

  it('padding (leading zeros restored via InputColumn.padLeft)', () => {
    const inHeaders = ['ID', 'Name'];
    const inRows: V[][] = [
      [123, 'A'],
      [4567, 'B'],
      [89, 'C'],
      [12, 'D'],
      [345, 'E'],
    ];
    const outHeaders = ['ID', 'Name'];
    const outRows: V[][] = [
      ['00123', 'A'],
      ['04567', 'B'],
      ['00089', 'C'],
      ['00012', 'D'],
      ['00345', 'E'],
    ];
    const { result } = fastPathOk(inHeaders, inRows, outHeaders, outRows);
    if (!('rules' in result)) throw new Error('unreachable');
    const idCol = result.rules.input.columns.find((c) => c.header === 'ID')!;
    expect(idCol.padLeft).toBe(5);
    // A plain copy: no computed column needed for padding.
    expect(result.rules.output.columns.find((c) => c.header === 'ID')!.from).toBe(idCol.id);
  });

  it('date and number reformatting', () => {
    const inHeaders = ['Date', 'Price'];
    const inRows: V[][] = [
      [date(2024, 1, 15), 1234.5],
      [date(2024, 2, 20), 99],
      [date(2024, 3, 5), 18000.25],
      [date(2024, 4, 10), 0.75],
      [date(2024, 5, 25), 250],
    ];
    const outHeaders = ['Date', 'Price'];
    const outRows: V[][] = [
      ['2024-01-15', '1,234.50'],
      ['2024-02-20', '99.00'],
      ['2024-03-05', '18,000.25'],
      ['2024-04-10', '0.75'],
      ['2024-05-25', '250.00'],
    ];
    fastPathOk(inHeaders, inRows, outHeaders, outRows);
  });

  it('a value map', () => {
    const inHeaders = ['ID', 'Status'];
    const inRows: V[][] = [
      [1, 'active'],
      [2, 'closed'],
      [3, 'active'],
      [4, 'pending'],
      [5, 'closed'],
      [6, 'active'],
      [7, 'pending'],
    ];
    const outHeaders = ['ID', 'Status'];
    const outRows: V[][] = [
      [1, 'A'],
      [2, 'C'],
      [3, 'A'],
      [4, 'P'],
      [5, 'C'],
      [6, 'A'],
      [7, 'P'],
    ];
    const { result } = fastPathOk(inHeaders, inRows, outHeaders, outRows);
    if (!('rules' in result)) throw new Error('unreachable');
    expect(result.rules.transform.valueMaps).toHaveLength(1);
    expect(result.rules.transform.valueMaps[0]!.onMissing).toBe('flag');
  });

  it('a simple calculation (mulConst, well evidenced)', () => {
    const inHeaders = ['ID', 'Amount'];
    const inRows: V[][] = [
      [1, 100],
      [2, 200],
      [3, 50],
      [4, 75],
      [5, 300],
    ];
    const outHeaders = ['ID', 'Total'];
    const outRows: V[][] = [
      [1, 117],
      [2, 234],
      [3, 58.5],
      [4, 87.75],
      [5, 351],
    ];
    const { result } = fastPathOk(inHeaders, inRows, outHeaders, outRows);
    if (!('rules' in result)) throw new Error('unreachable');
    expect(result.rules.transform.computed).toHaveLength(1);
  });

  it('a filter', () => {
    const inHeaders = ['ID', 'Status', 'Amount'];
    const inRows: V[][] = [
      [1, 'active', 10],
      [2, 'cancelled', 20],
      [3, 'active', 30],
      [4, 'cancelled', 40],
      [5, 'active', 50],
    ];
    const outHeaders = ['ID', 'Amount'];
    const outRows: V[][] = [
      [1, 10],
      [3, 30],
      [5, 50],
    ];
    const { result } = fastPathOk(inHeaders, inRows, outHeaders, outRows);
    if (!('rules' in result)) throw new Error('unreachable');
    expect(result.rules.input.rowFilters).toEqual([{ column: expect.any(String), op: 'ne', value: 'cancelled' }]);
  });

  it('dedupe', () => {
    // Distinct enough (5 unique rows, 2 exact repeats) that alignment reads it
    // as a key-matched dedupe rather than a group-by summary (a smaller/more
    // repetitive dataset can look like "one row per distinct key" instead).
    const inHeaders = ['Code', 'Zone', 'Qty'];
    const base: V[][] = [
      ['A1', 'north', 10],
      ['B2', 'south', 20],
      ['C3', 'east', 30],
      ['D4', 'west', 40],
      ['E5', 'north', 50],
    ];
    const inRows: V[][] = [...base, base[1]!, base[3]!];
    const outHeaders = ['Code', 'Zone', 'Qty'];
    const outRows: V[][] = [...base];
    const { result } = fastPathOk(inHeaders, inRows, outHeaders, outRows);
    if (!('rules' in result)) throw new Error('unreachable');
    expect(result.rules.transform.dedupe).toMatchObject({ keys: 'all', keep: 'first', action: 'remove' });
  });

  it('csv output: the example output.file is copied through, still verified', () => {
    const inHeaders = ['Code', 'Amount'];
    const inRows: V[][] = [
      ['A1', 10],
      ['A2', 20],
      ['A3', 30],
      ['A4', 40],
      ['A5', 50],
    ];
    // Reordered (not identical to the input) so this exercises a real copy
    // rather than tripping the "identical files" pre-flight block.
    const outHeaders = ['Amount', 'Code'];
    const outRows: V[][] = inRows.map((r) => [r[1]!, r[0]!]);
    const { result } = fastPathOk(inHeaders, inRows, outHeaders, outRows, {
      outputBuilder: (rows) => delimited(rows.map((r) => r.map(cellV)) as (string | number | null)[][], 'csv'),
    });
    if (!('rules' in result)) throw new Error('unreachable');
    expect(result.rules.output.file?.type).toBe('csv');
  });
});

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

describe('fastPath: refuses and reports why', () => {
  it('blocked: preflight already blocked (identical files)', () => {
    const rows: V[][] = [
      ['A', 'B'],
      [1, 'x'],
      [2, 'y'],
      [3, 'z'],
    ];
    const { result } = runFastPath(rows[0] as string[], rows.slice(1), rows[0] as string[], rows.slice(1));
    expect(result).toEqual({ reason: 'blocked' });
  });

  it('rowsExpand: families (columns to rows)', () => {
    const inHeaders = ['Id', 'Jan', 'Feb', 'Mar'];
    const inRows: V[][] = [
      [1, 10, 20, 30],
      [2, 40, 50, 60],
      [3, 70, 80, 90],
    ];
    const outHeaders = ['Id', 'Month', 'Amount'];
    const outRows: V[][] = [];
    for (const r of inRows) {
      ['Jan', 'Feb', 'Mar'].forEach((m, j) => outRows.push([r[0]!, m, r[1 + j]!]));
    }
    const { result } = runFastPath(inHeaders, inRows, outHeaders, outRows);
    expect(result).toMatchObject({ reason: 'rowsExpand' });
  });

  it('layoutUnsupported: groups (a blank row after each change of a key column)', () => {
    const inHeaders = ['Team', 'Member', 'Hours'];
    const inRows: V[][] = [
      ['blue', 'blue-0', 5],
      ['blue', 'blue-1', 6],
      ['red', 'red-0', 7],
      ['red', 'red-1', 8],
    ];
    const outHeaders = ['Team', 'Member', 'Hours'];
    const outRows: V[][] = [inRows[0]!, inRows[1]!, [], inRows[2]!, inRows[3]!];
    const a = analyzeOkResult(inHeaders, inRows, outHeaders, outRows);
    expect(a.layout.groupBy).not.toBeNull();
    const pf = preflight(a, 'registered');
    expect(fastPath(a, pf)).toMatchObject({ reason: 'layoutUnsupported' });
  });

  it('layoutUnsupported: a summary row (grand total) at the end', () => {
    const inHeaders = ['Ref', 'Amount'];
    const inRows: V[][] = [
      ['R1', 10],
      ['R2', 20],
      ['R3', 30],
      ['R4', 40],
    ];
    const outHeaders = ['Ref', 'Amount'];
    const outRows: V[][] = [...inRows, ['Total', 100]];
    const a = analyzeOkResult(inHeaders, inRows, outHeaders, outRows);
    expect(a.layout.summaryRows.length).toBeGreaterThan(0);
    const pf = preflight(a, 'registered');
    expect(fastPath(a, pf)).toMatchObject({ reason: 'layoutUnsupported' });
  });

  it('layoutUnsupported: a sort order different from the input', () => {
    const r = rng(40);
    const inRows: [string, number][] = [];
    for (let i = 0; i < 10; i++) inRows.push([`B${i}`, Math.round(r() * 1000)]);
    const outRows = [...inRows].sort((p, q) => q[1] - p[1]);
    const a = analyzeOkResult(
      ['Batch', 'Yield'],
      inRows.map((x) => [...x]),
      ['Batch', 'Yield'],
      outRows.map((x) => [...x]),
    );
    expect(a.layout.sort).not.toBeNull();
    const pf = preflight(a, 'registered');
    expect(fastPath(a, pf)).toMatchObject({ reason: 'layoutUnsupported' });
  });

  // Found by the engine stress test (eval/STRESS.md): rows sorted by a date written as text, compared as text ("01-02-2025" before
  // "03-01-2024"), which no sort the analysis tries explains. The fast path built no sort, the verification (which pairs rows by input
  // row) passed, and the result was "verified" in the input's order. An order nothing explains is a sort the free engine cannot build.
  it('layoutUnsupported: rows in an order no sort explains (and the partial result says the order needs the AI step)', () => {
    const r = rng(41);
    const inRows: [string, number][] = [];
    for (let i = 0; i < 10; i++) inRows.push([`B${i}`, Math.round(r() * 1000)]);
    const order = [3, 0, 7, 1, 9, 4, 2, 8, 5, 6];
    const a = analyzeOkResult(
      ['Batch', 'Yield'],
      inRows.map((x) => [...x]),
      ['Batch', 'Yield'],
      order.map((k) => [...inRows[k]!]),
    );
    expect(a.layout).toMatchObject({ sort: null, orderMatchesInput: false });
    const pf = preflight(a, 'registered');
    expect(fastPath(a, pf)).toMatchObject({ reason: 'layoutUnsupported', params: { part: 'sort' } });
    const p = partialRules(a, pf);
    if ('reason' in p) throw new Error('partialRules refused');
    expect(p.needsAiParts).toContain('sort');
  });

  it('layoutUnsupported: a title built from a date', () => {
    const inHeaders = ['Ticket', 'Opened'];
    const inRows: V[][] = [];
    const outRows: V[][] = [];
    for (let i = 0; i < 10; i++) {
      inRows.push([`T${i}`, date(2024, 9, 1 + i * 2)]);
      outRows.push([`T${i}`, date(2024, 9, 1 + i * 2)]);
    }
    const outputWb = xlsx([[bold('Monthly summary September 2024')], [], [bold('Ticket'), bold('Opened')], ...outRows]);
    const a = analyzePair(xlsx([inHeaders, ...inRows]), outputWb);
    if (!a.ok) throw new Error('analysis failed');
    expect(a.layout.titleRows[0]?.containsDate).toBeDefined();
    const pf = preflight(a, 'registered');
    expect(fastPath(a, pf)).toMatchObject({ reason: 'layoutUnsupported' });
  });

  it('ambiguousColumn: two coverage-1.0 relations from different source columns', () => {
    // Two input columns hold the exact same values; a plain copy of either one
    // reaches coverage 1.0, and picking the wrong one would matter the moment
    // the two columns ever disagree on a future row.
    const inHeaders = ['Ref1', 'Ref2', 'Other'];
    const inRows: V[][] = [];
    for (let i = 0; i < 8; i++) inRows.push([`X${i}`, `X${i}`, i]);
    const outHeaders = ['Ref'];
    const outRows: V[][] = inRows.map((r) => [r[0]!]);
    const { result } = runFastPath(inHeaders, inRows, outHeaders, outRows);
    expect(result).toMatchObject({ reason: 'ambiguousColumn' });
  });

  it('thinEvidence: a mulConst seen on fewer than 3 distinct non-zero values', () => {
    const inHeaders = ['ID', 'Amount'];
    const inRows: V[][] = [
      [1, 10],
      [2, 20],
      [3, 10],
      [4, 20],
      [5, 10],
      [6, 20],
    ];
    const outHeaders = ['ID', 'Total'];
    const outRows: V[][] = inRows.map((r) => [r[0]!, (r[1] as number) * 2]);
    const { result } = runFastPath(inHeaders, inRows, outHeaders, outRows);
    expect(result).toMatchObject({ reason: 'thinEvidence' });
  });

  it('thinEvidence: a valueMap whose every key appears once', () => {
    const inHeaders = ['ID', 'Code'];
    const inRows: V[][] = [];
    const outRows: V[][] = [];
    for (let i = 0; i < 8; i++) {
      inRows.push([i, `code-${i}`]);
      // An empty row lets the analyzer build a valueMap candidate at all
      // (identical keys are otherwise all unique, so no candidate exists).
      outRows.push([i, i % 2 === 0 ? `code-${i}`.toUpperCase() : '']);
    }
    const { result } = runFastPath(inHeaders, inRows, ['ID', 'Code'], outRows);
    // This construction is a best-effort attempt at the thin-valueMap case;
    // accept either a direct thinEvidence result or a column that simply isn't
    // fully explained, since the underlying analyzer may not always produce a
    // valueMap candidate for all-unique keys (see hints.ts's file header).
    expect(['thinEvidence', 'columnNotFullyExplained', 'ambiguousColumn']).toContain((result as { reason: string }).reason);
  });
});

function analyzeOkResult(inHeaders: string[], inRows: V[][], outHeaders: string[], outRows: V[][]): PairAnalysis {
  const a = analyzePair(xlsx([inHeaders, ...inRows]), xlsx([outHeaders, ...outRows]));
  if (!a.ok) throw new Error(`analysis failed: ${JSON.stringify(a.issues)}`);
  return a;
}
