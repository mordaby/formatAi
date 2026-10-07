// Dropped input rows (SPEC 6.2 step 4, "dropped rows"): copies of kept rows
// (dedupe, on every column or on a key, keeping the first or the last copy),
// then a filter on one input column that separates kept rows from the rest (a
// set of values, emptiness, or a numeric or date threshold). The engine order
// is filter -> dedupe; a copy of a kept row is attributed to dedupe.

import { limits, type PayloadCell } from '@formatai/shared';
import { DATE, EMPTY, canonNum, isoOfSerial, keys, payloadCell, type ColumnData } from './cells';
import type { DedupeRelation, DroppedAnalysis, FilterRelation } from './types';

// The caps are config (`limits.analysis`, SPEC 6.2 step 4).
const MAX_FAILING = limits.analysis.maxFailing;
const { maxListedValues: MAX_LISTED_VALUES, maxFilters: MAX_FILTERS, maxFilterValues: MAX_FILTER_VALUES } = limits.analysis.dropped;

type Dup = { row: number; of: number };

function sigOf(inCols: ColumnData[], r: number): string {
  let s = '';
  for (const col of inCols) s += `${keys(col)[r] ?? ''}\u001f`;
  return s;
}

/** keyDups result: values are shared with dropped rows, but kept rows aren't unique on the key. */
const SHARED_NOT_UNIQUE: Dup[] = [];

/**
 * Copies of kept rows on the key columns: [] when no dropped row shares the
 * key with a kept row, SHARED_NOT_UNIQUE when some do but kept rows aren't
 * unique on the key (so it can't be a dedupe key).
 */
function keyDups(inCols: ColumnData[], cols: number[], kept: number[], dropped: number[]): Dup[] {
  const ks = cols.map((c) => keys(inCols[c]!));
  const keyAt = (r: number): string | null => {
    if (ks.length === 1) return ks[0]![r] ?? null;
    let s = '';
    for (const k of ks) {
      const v = k[r];
      if (v === null || v === undefined) return null;
      s += `${v}\u001f`;
    }
    return s;
  };
  // Cheap reject: no dropped row's key appears among the kept rows.
  const droppedKeys = new Set<string>();
  for (const d of dropped) {
    const k = keyAt(d);
    if (k !== null) droppedKeys.add(k);
  }
  let shared = false;
  for (const r of kept) {
    const k = keyAt(r);
    if (k !== null && droppedKeys.has(k)) {
      shared = true;
      break;
    }
  }
  if (!shared) return [];
  const keptMap = new Map<string, number>();
  for (const r of kept) {
    const k = keyAt(r);
    if (k === null) continue;
    if (keptMap.has(k)) return SHARED_NOT_UNIQUE; // after dedupe, kept rows are unique on the key
    keptMap.set(k, r);
  }
  const dups: Dup[] = [];
  for (const d of dropped) {
    const k = keyAt(d);
    const of = k === null ? undefined : keptMap.get(k);
    if (of !== undefined) dups.push({ row: d, of });
  }
  return dups;
}

/** Dropped rows that are copies of kept rows, on every column or on the best single (or double) key. */
function findDedupe(inCols: ColumnData[], kept: number[], dropped: number[], preferKey: number[]): DedupeRelation | null {
  if (dropped.length === 0 || kept.length === 0) return null;

  // Every column. Full copies share every key, so only kept rows that share the
  // most distinct column's key with a dropped row are candidates.
  const distinct = inCols.map((col) => new Set(keys(col)).size);
  let pivot = 0;
  distinct.forEach((d, c) => {
    if (d > distinct[pivot]!) pivot = c;
  });
  const pivotKeys = inCols.length > 0 ? keys(inCols[pivot]!) : [];
  const droppedPivot = new Set(dropped.map((d) => pivotKeys[d] ?? ''));
  const keptSig = new Map<string, number[]>();
  for (const r of kept) {
    if (inCols.length > 0 && !droppedPivot.has(pivotKeys[r] ?? '')) continue;
    const s = sigOf(inCols, r);
    const l = keptSig.get(s);
    if (l) l.push(r);
    else keptSig.set(s, [r]);
  }
  const allDups: Dup[] = [];
  for (const d of dropped) {
    const cands = keptSig.get(sigOf(inCols, d));
    if (cands) allDups.push({ row: d, of: cands.find((c) => c < d) ?? cands[0]! });
  }

  // A key: single columns, then pairs among the most distinct columns whose
  // values are shared by dropped and kept rows (a pair can't match otherwise).
  let key: { cols: number[]; dups: Dup[] } | null = null;
  const shared: number[] = [];
  const isPreferred = (cols: number[]): boolean => cols.length === preferKey.length && cols.every((c, i) => c === preferKey[i]);
  const tryKey = (cols: number[]): void => {
    const dups = keyDups(inCols, cols, kept, dropped);
    if (dups === SHARED_NOT_UNIQUE || dups.length > 0) {
      if (cols.length === 1) shared.push(cols[0]!);
    }
    if (dups === SHARED_NOT_UNIQUE || dups.length === 0) return;
    if (key === null || dups.length > key.dups.length || (dups.length === key.dups.length && isPreferred(cols) && !isPreferred(key.cols))) {
      key = { cols, dups };
    }
  };
  for (let c = 0; c < inCols.length; c++) tryKey([c]);
  let found = key as { cols: number[]; dups: Dup[] } | null;
  if (found === null && allDups.length === 0) {
    const ranked = shared
      .sort((a, b) => distinct[b]! - distinct[a]! || a - b)
      .slice(0, limits.analysis.dropped.maxKeyColumns)
      .sort((a, b) => a - b);
    for (let i = 0; i < ranked.length; i++) for (let j = i + 1; j < ranked.length; j++) tryKey([ranked[i]!, ranked[j]!]);
    found = key as { cols: number[]; dups: Dup[] } | null;
  }

  let duplicates: Dup[];
  let keysOut: number[] | 'all';
  let cols: number[];
  // DECISION: full copies read as "all columns" (the natural reading); a key is
  // reported only when it explains more dropped rows than full copies do.
  if (allDups.length > 0 && (found === null || allDups.length >= found.dups.length)) {
    duplicates = allDups;
    keysOut = 'all';
    cols = inCols.map((_, c) => c);
  } else if (found !== null) {
    duplicates = found.dups;
    keysOut = found.cols;
    cols = found.cols;
  } else return null;

  let first = 0;
  for (const d of duplicates) if (d.row > d.of) first++;
  const keepFirst = first * 2 >= duplicates.length;
  return {
    rel: 'dedupe',
    in: cols,
    keys: keysOut,
    keep: keepFirst ? 'first' : 'last',
    coverage: (keepFirst ? first : duplicates.length - first) / duplicates.length,
    duplicates,
  };
}

interface Scored {
  rel: FilterRelation;
  /** Lower = preferred among equal coverage. */
  order: number;
  drops: (r: number) => boolean;
}

/** More trailing zeros = rounder; decimals count negative. */
function roundness(x: number): number {
  if (x === 0) return 10;
  if (!Number.isInteger(x)) return -(canonNum(x).split('.')[1]?.length ?? 0);
  let z = 0;
  let v = Math.abs(x);
  while (v % 10 === 0) {
    z++;
    v /= 10;
  }
  return z;
}

/**
 * The roundest number strictly between `lo` and `hi` - a multiple of the largest power of ten that has one in the gap
 * (100 in 98.2..103.66) - or null. The data only says the threshold is somewhere in the gap; a round number is the
 * likeliest place for a person to have put it.
 */
function roundestBetween(lo: number, hi: number): number | null {
  if (!(hi > lo)) return null;
  const top = Math.ceil(Math.log10(Math.max(Math.abs(lo), Math.abs(hi), 1))) + 1;
  for (let e = top; e >= -4; e--) {
    const step = 10 ** e;
    const c = Number(((Math.floor(lo / step) + 1) * step).toFixed(Math.max(0, -e)));
    if (c > lo && c < hi) return c;
  }
  return null;
}

function makeFilter(
  c: number,
  universe: number[],
  isDropped: Uint8Array,
  drops: (r: number) => boolean,
  order: number,
  extra: Partial<FilterRelation>,
): Scored {
  const failing: number[] = [];
  let failCount = 0;
  for (const r of universe) {
    if (drops(r) === (isDropped[r] === 1)) continue;
    failCount++;
    if (failing.length < MAX_FAILING) failing.push(r);
  }
  const rel: FilterRelation = { rel: 'filter', in: [c], ...extra, coverage: (universe.length - failCount) / universe.length, failing, failCount };
  return { rel, order, drops };
}

/** Candidate filters on one column; `isDropped[r]` marks the dropped rows of `universe`. */
function filtersOn(col: ColumnData, c: number, universe: number[], isDropped: Uint8Array): Scored[] {
  const out: Scored[] = [];
  const N = universe.length;
  const ks = keys(col);

  // Emptiness.
  let keptEmpty = 0;
  let droppedEmpty = 0;
  for (const r of universe) {
    if (col.kind[r] !== EMPTY) continue;
    if (isDropped[r]) droppedEmpty++;
    else keptEmpty++;
  }
  if (droppedEmpty > 0) out.push(makeFilter(c, universe, isDropped, (r) => col.kind[r] === EMPTY, 1, { droppedWhen: { op: 'isEmpty' } }));
  if (keptEmpty > 0) out.push(makeFilter(c, universe, isDropped, (r) => col.kind[r] !== EMPTY, 1, { droppedWhen: { op: 'notEmpty' } }));

  // A set of values. DECISION: only on low-cardinality columns (<= `MAX_FILTER_VALUES` (50) values, and
  // at most half the rows or a dropped value that repeats): a column of unique
  // ids "separates" any rows.
  const counts = new Map<string, { kept: number; dropped: number; row: number }>();
  for (const r of universe) {
    const k = ks[r] ?? '';
    let e = counts.get(k);
    if (!e) {
      if (counts.size > MAX_FILTER_VALUES) break; // too many values for a value-set filter
      e = { kept: 0, dropped: 0, row: r };
      counts.set(k, e);
    }
    if (isDropped[r]) e.dropped++;
    else e.kept++;
  }
  let repeatedDrop = false;
  for (const e of counts.values()) if (e.dropped >= 2) repeatedDrop = true;
  if (counts.size >= 2 && counts.size <= MAX_FILTER_VALUES && (counts.size <= Math.max(2, N / 2) || repeatedDrop)) {
    const droppedKeys = new Set<string>();
    for (const [k, e] of counts) if (e.dropped > e.kept) droppedKeys.add(k);
    if (droppedKeys.size > 0 && !(droppedKeys.size === 1 && droppedKeys.has(''))) {
      const keptValues: PayloadCell[] = [];
      const droppedValues: PayloadCell[] = [];
      for (const [k, e] of counts) {
        if (droppedKeys.has(k)) droppedValues.push(payloadCell(col, e.row));
        else if (e.kept > 0) keptValues.push(payloadCell(col, e.row));
      }
      const extra: Partial<FilterRelation> = {};
      if (keptValues.length <= MAX_LISTED_VALUES) extra.keptValues = keptValues;
      if (droppedValues.length <= MAX_LISTED_VALUES) extra.droppedValues = droppedValues;
      out.push(makeFilter(c, universe, isDropped, (r) => droppedKeys.has(ks[r] ?? ''), counts.size <= 10 ? 0 : 3, extra));
    }
  }

  // A threshold on numbers or dates.
  let ne = 0;
  let nDate = 0;
  for (const r of universe) {
    if (col.kind[r] === EMPTY) continue;
    ne++;
    if (col.kind[r] === DATE) nDate++;
  }
  const isDate = col.textDate !== null || (ne > 0 && nDate === ne);
  const valueAt = (r: number): number => (col.kind[r] === EMPTY ? NaN : isDate ? col.date[r]! : col.num[r]!);
  const pts: { v: number; dropped: boolean }[] = [];
  for (const r of universe) {
    if (col.kind[r] === EMPTY) continue;
    const v = valueAt(r);
    if (Number.isNaN(v)) return out; // not a numeric/date column
    pts.push({ v, dropped: isDropped[r] === 1 });
  }
  if (pts.length < 2) return out;
  pts.sort((a, b) => a.v - b.v);
  const m = pts.length;
  const droppedTotal = pts.filter((p) => p.dropped).length;
  const keptTotal = m - droppedTotal;
  let keptBelow = 0;
  let droppedBelow = 0;
  let best: { i: number; errors: number; below: boolean } | null = null;
  for (let i = 1; i < m; i++) {
    if (pts[i - 1]!.dropped) droppedBelow++;
    else keptBelow++;
    if (pts[i]!.v === pts[i - 1]!.v) continue; // never cut between equal values
    const belowErrors = keptBelow + (droppedTotal - droppedBelow); // drop the rows below the cut
    const aboveErrors = droppedBelow + (keptTotal - keptBelow); // drop the rows above the cut
    if (best === null || belowErrors < best.errors) best = { i, errors: belowErrors, below: true };
    if (aboveErrors < best.errors) best = { i, errors: aboveErrors, below: false };
  }
  if (best === null) return out;
  const lo = pts[best.i - 1]!.v; // largest value under the cut
  const hi = pts[best.i]!.v; // smallest value over the cut
  let op: 'lt' | 'lte' | 'gt' | 'gte';
  let value: number;
  // DECISION: the threshold is reported on 0 when the gap straddles it; otherwise on the roundest number of the gap
  // (100 in 98.2..103.66, rather than 103.66 - a value that happens to be in the file), at either edge or strictly inside.
  const inside = isDate ? null : roundestBetween(lo, hi);
  const insideRounder = inside !== null && roundness(inside) > Math.max(roundness(lo), roundness(hi));
  if (best.below) {
    if (lo < 0 && hi >= 0) [op, value] = ['lt', 0];
    else if (lo <= 0 && hi > 0) [op, value] = ['lte', 0];
    else if (insideRounder) [op, value] = ['lt', inside!];
    else if (!isDate && roundness(lo) > roundness(hi)) [op, value] = ['lte', lo];
    else [op, value] = ['lt', hi];
  } else if (lo < 0 && hi >= 0) [op, value] = ['gte', 0];
  else if (lo <= 0 && hi > 0) [op, value] = ['gt', 0];
  else if (insideRounder) [op, value] = ['gt', inside!];
  else if (!isDate && roundness(hi) > roundness(lo)) [op, value] = ['gte', hi];
  else [op, value] = ['gt', lo];
  const drops = (r: number): boolean => {
    const v = valueAt(r);
    if (Number.isNaN(v)) return false;
    return op === 'lt' ? v < value : op === 'lte' ? v <= value : op === 'gt' ? v > value : v >= value;
  };
  out.push(makeFilter(c, universe, isDropped, drops, 2, { droppedWhen: { op, value: isDate ? isoOfSerial(value) : value } }));
  return out;
}

/**
 * Explains the dropped rows: dedupe first (copies of kept rows), then filters
 * for the rest, best first (coverage, then a low-cardinality value set,
 * emptiness, a threshold, other value sets).
 */
export function analyzeDropped(
  inCols: ColumnData[],
  nIn: number,
  keptRows: number[],
  droppedRows: number[],
  explainedByExpand: number[],
  preferKey: number[],
  minCoverage: number,
): DroppedAnalysis {
  const dedupe = findDedupe(inCols, keptRows, droppedRows, preferKey);
  const deduped = new Set((dedupe?.duplicates ?? []).map((d) => d.row));
  const rest = droppedRows.filter((r) => !deduped.has(r));
  let filters: FilterRelation[] = [];
  let unexplained = rest;
  if (rest.length > 0 && keptRows.length > 0) {
    const universe = [...keptRows, ...rest].sort((a, b) => a - b);
    const isDropped = new Uint8Array(nIn);
    for (const r of rest) isDropped[r] = 1;
    const scored: Scored[] = [];
    inCols.forEach((col, c) => scored.push(...filtersOn(col, c, universe, isDropped)));
    const ok = scored
      .filter((s) => s.rel.coverage >= minCoverage)
      .sort((a, b) => b.rel.coverage - a.rel.coverage || a.order - b.order || a.rel.in[0] - b.rel.in[0]);
    filters = ok.slice(0, MAX_FILTERS).map((s) => s.rel);
    const best = ok[0];
    if (best) unexplained = rest.filter((r) => !best.drops(r));
  }
  return { rows: droppedRows, explainedByExpand, dedupe, filters, unexplained };
}
