// Header check for a csv/txt example output (SPEC 8.13: "whether the first row is
// a header"; SPEC 6.2 pair analysis). detectFileSpec decides from cell types, but an
// all-text file gives no type evidence either way, and a headerless load file is a
// first-class output. The pair itself settles it: the input rows are the ground
// truth for what a data row of the output looks like.
//
//   row 0 explained as a data row (aligned with an input row, every traced column's
//   relation holds on it)  ->  it is data (header: false)
//   row 0 NOT explained, while the rows below it are (>= 90%)  ->  it is the header
//
// Both readings are full pair analyses (see analyzePair): "as header" reads row 0 as
// the header and analyzes the rows below; "as data" reads every row as data. This
// module only judges their results.

import { keys, type ColumnData } from './cells';
import type { PairAnalysis } from './types';

/** Share of rows that must be explained for a reading to count as "the rows are explained" (SPEC 6.2 partial hints). */
export const HEADER_MIN_EXPLAINED = 0.9;

/**
 * Share of the output data rows that are aligned to an input row and satisfy the
 * best relation of every traced column: the aligned share times the worst column
 * coverage (relations are only reported at >= minCoverage, so the worst column
 * bounds how many rows can fail). 0 when no column is traced.
 */
export function explainedRate(a: PairAnalysis): number {
  const n = a.output.dataRows.length;
  if (n === 0) return 0;
  const traced = a.columns.filter((c) => !c.unknown && c.relations[0] !== undefined);
  if (traced.length === 0) return 0;
  let worst = 1;
  for (const c of traced) worst = Math.min(worst, c.relations[0]!.coverage);
  return (Math.min(a.alignment.rows.length, n) / n) * worst;
}

/**
 * Whether the first output data row (row 0) of a reading where EVERY row is data
 * is explained as a data row: it is aligned to an input row and no traced
 * column's best relation fails on it. Aligned rows are in output order, so an
 * aligned row 0 is aligned-row index 0; failing lists are ascending, so a failure
 * on it is never cut off by their cap.
 */
export function firstRowExplained(asData: PairAnalysis): boolean {
  if (asData.alignment.rows[0]?.out !== 0) return false;
  const traced = asData.columns.filter((c) => !c.unknown && c.relations[0] !== undefined);
  if (traced.length === 0) return false;
  return traced.every((c) => !c.relations[0]!.failing.includes(0));
}

/**
 * Cheap pre-test for the default reading "row 0 is the header": can that row be a
 * data row at all? It cannot when it has no input counterpart by the alignment's
 * own means: the rows below line up with the input by position (an extra row has
 * nowhere to go), or its key (or group) value never occurs in the input. True
 * otherwise, including when nothing can be told. Skipping the second full analysis
 * in the false case gives the same verdict (the header stays) at a fraction of the cost.
 * `inCols` are the input columns, `allOut` the output columns over every sheet row.
 */
export function headerRowMayBeData(asHeader: PairAnalysis, inCols: ColumnData[], allOut: ColumnData[]): boolean {
  const { alignment, shape, output } = asHeader;
  if (alignment.method === 'position') return false;
  let inSel: number[];
  let outSel: number[];
  if (alignment.method === 'key' && alignment.key !== null) {
    inSel = alignment.key.in;
    outSel = alignment.key.out;
  } else if (shape.kind === 'summary') {
    inSel = [shape.groupIn];
    outSel = [shape.groupOut];
  } else return true;

  const compose = (parts: (string | null)[]): string | null => (parts.some((k) => k === null) ? null : parts.join('\u001f'));
  const rowKey = compose(outSel.map((o) => keys(allOut[o]!)[output.headerRow] ?? null));
  if (rowKey === null) return false;
  const inKeys = inSel.map((i) => keys(inCols[i]!));
  const n = inCols[inSel[0]!]!.n;
  for (let r = 0; r < n; r++) if (compose(inKeys.map((k) => k[r] ?? null)) === rowKey) return true;
  return false;
}

export type HeaderVerdict = 'header' | 'data' | 'unknown';

/**
 * Judges the two readings of the same output file. `asHeader` reads row 0 as the
 * header, `asData` reads every row as data; either may be missing (null).
 * 'unknown' keeps the default reading (header: true when detection had no type
 * evidence, as detected otherwise).
 */
export function decideHeader(asHeader: PairAnalysis | null, asData: PairAnalysis | null): HeaderVerdict {
  const row0 = asData !== null && firstRowExplained(asData);
  if (row0 && asData !== null && explainedRate(asData) >= HEADER_MIN_EXPLAINED) return 'data';
  if (!row0 && asHeader !== null && explainedRate(asHeader) >= HEADER_MIN_EXPLAINED) return 'header';
  return 'unknown';
}
