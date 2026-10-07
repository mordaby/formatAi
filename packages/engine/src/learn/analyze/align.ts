// Row alignment (SPEC 6.2 step 2): find a key (an output column matching an
// input column one-to-one after normalization, else a 2-column key), map every
// output data row to its input row, or recognize a summary output (one row per
// distinct value of an input column).

import { limits } from '@formatai/shared';
import { EMPTY, keys, nonEmptyCount, type ColumnData } from './cells';
import { sampleIndices } from './prng';
import type { AlignedRow, Alignment, KeyMatch } from './types';

// The thresholds are config (`limits.analysis.align`, SPEC 6.2 step 2).
const ALIGN = limits.analysis.align;

/** Map from a key to the input rows holding it. */
export class KeyIndex {
  private readonly first = new Map<string, number>();
  private readonly multi = new Map<string, number[]>();
  readonly distinct: number;
  readonly nonEmpty: number;

  constructor(ks: ArrayLike<string | null>) {
    let nonEmpty = 0;
    for (let r = 0; r < ks.length; r++) {
      const k = ks[r];
      if (k === null || k === undefined) continue;
      nonEmpty++;
      const f = this.first.get(k);
      if (f === undefined) {
        this.first.set(k, r);
        continue;
      }
      const m = this.multi.get(k);
      if (m) m.push(r);
      else this.multi.set(k, [f, r]);
    }
    this.distinct = this.first.size;
    this.nonEmpty = nonEmpty;
  }

  has(k: string): boolean {
    return this.first.has(k);
  }

  /** Rows with key k (ascending), or null. */
  get(k: string): number[] | null {
    const m = this.multi.get(k);
    if (m) return m;
    const f = this.first.get(k);
    return f === undefined ? null : [f];
  }

  count(k: string): number {
    const m = this.multi.get(k);
    if (m) return m.length;
    return this.first.has(k) ? 1 : 0;
  }
}

/** An (input column, output column) pair whose output values are found among the input's. */
export interface ValuePair {
  in: number;
  out: number;
  /** Share of sampled non-empty output values found in the input column. */
  containment: number;
}

export interface SummaryCandidate {
  groupIn: number;
  groupOut: number;
  /** Input rows of each output data row's group (empty when not found). */
  groups: number[][];
}

export interface AlignResult {
  alignment: Alignment;
  summary: SummaryCandidate | null;
  valuePairs: ValuePair[];
}

function compositeKeys(a: ArrayLike<string | null>, b: ArrayLike<string | null>): (string | null)[] {
  const out: (string | null)[] = new Array(a.length);
  for (let r = 0; r < a.length; r++) {
    const x = a[r];
    const y = b[r];
    out[r] = x === null || x === undefined || y === null || y === undefined ? null : `${x}\u001f${y}`;
  }
  return out;
}

interface KeyCand extends KeyMatch {
  index: KeyIndex;
  outKeys: (string | null)[];
  inDistinct: number;
  /** Memoized keyExplainScore (SPEC 6.2 step 2), computed lazily on a tie. */
  explainScore?: number;
}

/** Context a tie between two key candidates needs to score them past matchRate/uniqueness. */
interface KeyContext {
  nIn: number;
  nOut: number;
  valuePairs: ValuePair[];
  inKeys: (string | null)[][];
  outKeys: (string | null)[][];
}

function evalKey(
  index: KeyIndex,
  outKeys: (string | null)[],
  sample: number[],
): { matchRate: number; uniqueness: number; spread: number } {
  let found = 0;
  let unique = 0;
  let rows = 0;
  for (const r of sample) {
    const k = outKeys[r];
    if (k === null || k === undefined) continue;
    const n = index.count(k);
    if (n === 0) continue;
    found++;
    rows += n;
    if (n === 1) unique++;
  }
  return {
    matchRate: sample.length === 0 ? 0 : found / sample.length,
    uniqueness: found === 0 ? 0 : unique / found,
    spread: found === 0 ? Infinity : rows / found,
  };
}

/**
 * DECISION: a key may point to a few rows (duplicates the example removed),
 * but not to groups: accepted when >= 80% of keys are unique, or when keys
 * point to 1.5 input rows or fewer on average (`limits.analysis.align`). When a summary reading also
 * exists, the one that explains more output columns wins (see alignRows).
 */
function keyOk(m: { matchRate: number; uniqueness: number; spread: number }): boolean {
  return m.matchRate >= ALIGN.keyMinMatchShare && (m.uniqueness >= ALIGN.keyMinUniqueShare || m.spread <= ALIGN.keyMaxSpread);
}

/**
 * How well a key candidate explains the OTHER output columns once its rows
 * are assigned: assigns every output row through it, then counts output
 * columns that equal some input column on most of those rows (same measure
 * `alignRows` uses to pick between a key and a summary reading). Memoized on
 * the candidate: a tie can be compared against several times.
 */
function keyExplainScore(cand: KeyCand, ctx: KeyContext): number {
  if (cand.explainScore === undefined) {
    const { rows } = assign(cand, ctx.nIn, ctx.nOut, ctx.valuePairs, ctx.inKeys, ctx.outKeys);
    cand.explainScore = explainKey(ctx.inKeys, ctx.outKeys, rows);
  }
  return cand.explainScore;
}

function betterKey(a: KeyCand, b: KeyCand | null, ctx: KeyContext): boolean {
  if (b === null) return true;
  if (a.matchRate !== b.matchRate) return a.matchRate > b.matchRate;
  if (a.uniqueness !== b.uniqueness) return a.uniqueness > b.uniqueness;
  if (a.inDistinct !== b.inDistinct) return a.inDistinct > b.inDistinct;
  // DECISION: still tied on the input-side stats — two different columns can
  // point to the same input row for every sampled key by coincidence (e.g. a
  // small group id and an unrelated id column both stripped of leading zeros
  // land on the same 1..N range). The real key also makes the OTHER output
  // columns line up with the row it assigns; a coincidental one doesn't.
  const explainA = keyExplainScore(a, ctx);
  const explainB = keyExplainScore(b, ctx);
  if (explainA !== explainB) return explainA > explainB;
  return false; // earlier (lower out, then lower in) wins ties
}

/**
 * Aligns output data rows to input rows. Chooses between a key alignment and a
 * summary reading by how many output columns each one explains (a summary's
 * group column is not unique in the input, so it's never a key; but a key may
 * exist by coincidence on a summary, e.g. when most groups have one row).
 */
export function alignRows(inCols: ColumnData[], outCols: ColumnData[], nIn: number, nOut: number, seed: number): AlignResult {
  const inKeys = inCols.map((c) => keys(c));
  const outKeys = outCols.map((c) => keys(c));
  const indexes: (KeyIndex | undefined)[] = new Array(inCols.length);
  const indexOf = (i: number): KeyIndex => {
    let ix = indexes[i];
    if (!ix) {
      ix = new KeyIndex(inKeys[i]!);
      indexes[i] = ix;
    }
    return ix;
  };
  const sample = sampleIndices(nOut, ALIGN.keySampleRows, (seed ^ 0x9e3779b9) >>> 0);
  const ctx: KeyContext = { nIn, nOut, valuePairs: [], inKeys, outKeys };
  const valuePairs = ctx.valuePairs;

  // Value pairs: output values found among an input column's values.
  for (let o = 0; o < outCols.length; o++) {
    const ok = outKeys[o]!;
    for (let i = 0; i < inCols.length; i++) {
      const ix = indexOf(i);
      let ne = 0;
      let found = 0;
      for (const r of sample) {
        const k = ok[r];
        if (k === null || k === undefined) continue;
        ne++;
        if (ix.has(k)) found++;
      }
      if (ne > 0 && found / ne >= ALIGN.valueMinContainment) valuePairs.push({ in: i, out: o, containment: found / ne });
    }
  }

  // Single-column key.
  let best: KeyCand | null = null;
  for (let o = 0; o < outCols.length; o++) {
    for (let i = 0; i < inCols.length; i++) {
      const ix = indexOf(i);
      if (ix.nonEmpty === 0 || ix.distinct / ix.nonEmpty < ALIGN.keyMinDistinctShare) continue;
      const { spread: _s, ...m } = evalKey(ix, outKeys[o]!, sample);
      if (!keyOk({ ...m, spread: _s })) continue;
      const cand: KeyCand = { in: [i], out: [o], ...m, index: ix, outKeys: outKeys[o]!, inDistinct: ix.distinct / ix.nonEmpty };
      if (betterKey(cand, best, ctx)) best = cand;
    }
  }

  // Two-column key, from the pairs whose values match (also when the best single
  // key is weak: a numeric column can match a few output values by chance).
  if (best === null || best.matchRate < ALIGN.strongKeyMatchShare) {
    const top = [...valuePairs].sort((a, b) => b.containment - a.containment || a.out - b.out || a.in - b.in).slice(0, ALIGN.maxValuePairs);
    for (let x = 0; x < top.length; x++) {
      for (let y = x + 1; y < top.length; y++) {
        const p = top[x]!;
        const q = top[y]!;
        if (p.in === q.in || p.out === q.out) continue;
        const [a, b] = p.in < q.in ? [p, q] : [q, p];
        const ix = new KeyIndex(compositeKeys(inKeys[a.in]!, inKeys[b.in]!));
        const ok = compositeKeys(outKeys[a.out]!, outKeys[b.out]!);
        const { spread: _s, ...m } = evalKey(ix, ok, sample);
        if (!keyOk({ ...m, spread: _s })) continue;
        const cand: KeyCand = { in: [a.in, b.in], out: [a.out, b.out], ...m, index: ix, outKeys: ok, inDistinct: ix.distinct / Math.max(1, ix.nonEmpty) };
        if (betterKey(cand, best, ctx)) best = cand;
      }
    }
  }

  const summary = findSummary(inCols, outCols, outKeys, indexOf, nOut);
  let useSummary = false;
  if (summary !== null) {
    if (best === null) useSummary = true;
    else {
      // Even a perfect key can be a coincidence on a summary: max/min columns hold input values.
      const keyRows = assign(best, nIn, nOut, valuePairs, inKeys, outKeys).rows;
      useSummary = explainSummary(inCols, outCols, summary) > explainKey(inKeys, outKeys, keyRows);
    }
  }

  if (useSummary && summary !== null) {
    const rows: AlignedRow[] = [];
    const unalignedOut: number[] = [];
    const grouped = new Uint8Array(nIn);
    summary.groups.forEach((g, o) => {
      if (g.length === 0) unalignedOut.push(o);
      else {
        rows.push({ out: o, in: g[0]! });
        for (const r of g) grouped[r] = 1;
      }
    });
    const droppedIn: number[] = [];
    for (let r = 0; r < nIn; r++) if (!grouped[r]) droppedIn.push(r);
    return {
      alignment: { method: 'group', key: null, rows, unalignedOut, droppedIn },
      summary: { ...summary, groups: summary.groups.filter((g) => g.length > 0) },
      valuePairs,
    };
  }

  if (best !== null) {
    const { rows, unalignedOut, droppedIn } = assign(best, nIn, nOut, valuePairs, inKeys, outKeys);
    const key: KeyMatch = { in: best.in, out: best.out, matchRate: best.matchRate, uniqueness: best.uniqueness };
    return { alignment: { method: 'key', key, rows, unalignedOut, droppedIn }, summary: null, valuePairs };
  }

  if (nIn === nOut && nIn > 0) {
    // DECISION: no key, same row count: align by position (the output may
    // transform every column, e.g. all reformatted). Relations then decide.
    const rows: AlignedRow[] = [];
    for (let r = 0; r < nOut; r++) rows.push({ out: r, in: r });
    return { alignment: { method: 'position', key: null, rows, unalignedOut: [], droppedIn: [] }, summary: null, valuePairs };
  }

  const unalignedOut: number[] = [];
  for (let r = 0; r < nOut; r++) unalignedOut.push(r);
  const droppedIn: number[] = [];
  for (let r = 0; r < nIn; r++) droppedIn.push(r);
  return { alignment: { method: 'none', key: null, rows: [], unalignedOut, droppedIn }, summary: null, valuePairs };
}

/**
 * Maps every output row through the key. When a key points to several input
 * rows, the candidates are scored by the other matching columns; remaining
 * ties take the first candidate at or after the previous row's input row, so
 * unsorted outputs of deduplicated inputs keep the copy the example kept.
 */
function assign(
  key: KeyCand,
  nIn: number,
  nOut: number,
  valuePairs: ValuePair[],
  inKeys: (string | null)[][],
  outKeys: (string | null)[][],
): { rows: AlignedRow[]; unalignedOut: number[]; droppedIn: number[] } {
  const others = valuePairs.filter((p) => !key.in.includes(p.in) && !key.out.includes(p.out));
  const rows: AlignedRow[] = [];
  const unalignedOut: number[] = [];
  const used = new Uint8Array(nIn);
  let prev = -1;
  for (let o = 0; o < nOut; o++) {
    const k = key.outKeys[o];
    const cands = k === null || k === undefined ? null : key.index.get(k);
    if (!cands) {
      unalignedOut.push(o);
      continue;
    }
    let chosen = cands[0]!;
    if (cands.length > 1) {
      let bestScore = -1;
      let tied: number[] = [];
      for (const c of cands) {
        let s = 0;
        for (const p of others) if (inKeys[p.in]![c] === outKeys[p.out]![o]) s++;
        if (s > bestScore) {
          bestScore = s;
          tied = [c];
        } else if (s === bestScore) tied.push(c);
      }
      chosen = tied.find((c) => c >= prev) ?? tied[0]!;
    }
    rows.push({ out: o, in: chosen });
    used[chosen] = 1;
    prev = chosen;
  }
  const droppedIn: number[] = [];
  for (let r = 0; r < nIn; r++) if (!used[r]) droppedIn.push(r);
  return { rows, unalignedOut, droppedIn };
}

/** Output column o is unique per row; input column i repeats and holds every one of its values. */
function findSummary(
  inCols: ColumnData[],
  outCols: ColumnData[],
  outKeys: (string | null)[][],
  indexOf: (i: number) => KeyIndex,
  nOut: number,
): SummaryCandidate | null {
  if (nOut === 0) return null;
  let best: { cand: SummaryCandidate; covered: number } | null = null;
  for (let o = 0; o < outCols.length; o++) {
    const ok = outKeys[o]!;
    const ne = nonEmptyCount(outCols[o]!);
    if (ne < ALIGN.summaryMinNonEmptyShare * nOut) continue;
    if (new Set(ok.filter((k) => k !== null)).size !== ne) continue;
    for (let i = 0; i < inCols.length; i++) {
      const ix = indexOf(i);
      if (ix.distinct === 0 || ix.distinct >= ix.nonEmpty) continue; // needs repeats
      if (ix.distinct > nOut / ALIGN.summaryMinGroupShare) continue; // most groups must be present
      const groups: number[][] = [];
      let covered = 0;
      let missing = 0;
      for (let r = 0; r < nOut; r++) {
        const k = ok[r];
        const g = k === null || k === undefined ? null : ix.get(k);
        if (!g) {
          missing++;
          groups.push([]);
        } else {
          groups.push(g);
          covered += g.length;
        }
      }
      if (missing > 0) continue;
      if (best === null || covered > best.covered) best = { cand: { groupIn: i, groupOut: o, groups }, covered };
    }
  }
  return best?.cand ?? null;
}

/** Output columns that equal some input column on >= 90% of (sampled) aligned rows. */
function explainKey(inKeys: (string | null)[][], outKeys: (string | null)[][], rows: AlignedRow[]): number {
  const sample = rows.length <= ALIGN.explainSampleRows ? rows : sampleIndices(rows.length, ALIGN.explainSampleRows, 7).map((k) => rows[k]!);
  if (sample.length === 0) return 0;
  let n = 0;
  for (const ok of outKeys) {
    for (const ik of inKeys) {
      let eq = 0;
      for (const a of sample) if (ok[a.out] === ik[a.in]) eq++;
      if (eq / sample.length >= ALIGN.explainMinShare) {
        n++;
        break;
      }
    }
  }
  return n;
}

/** Output columns explained by the group key or an aggregate of an input column on >= 90% of groups. */
function explainSummary(inCols: ColumnData[], outCols: ColumnData[], s: SummaryCandidate): number {
  const groups = s.groups;
  if (groups.length === 0) return 0;
  const approx = (a: number, b: number): boolean => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
  let n = 0;
  outCols.forEach((out, o) => {
    if (o === s.groupOut) {
      n++;
      return;
    }
    const outK = keys(out);
    for (const inp of inCols) {
      const inK = keys(inp);
      let hitFirst = 0;
      let hitSum = 0;
      let hitCount = 0;
      let hitMin = 0;
      let hitMax = 0;
      let hitAvg = 0;
      groups.forEach((g, r) => {
        if (inK[g[0]!] === outK[r]) hitFirst++;
        const v = out.num[r]!;
        if (Number.isNaN(v)) return;
        let sum = 0;
        let cnt = 0;
        let ne = 0;
        let mn = Infinity;
        let mx = -Infinity;
        for (const x of g) {
          if (inp.kind[x] === EMPTY) continue;
          ne++;
          const f = inp.num[x]!;
          if (Number.isNaN(f)) continue;
          sum += f;
          cnt++;
          mn = Math.min(mn, f);
          mx = Math.max(mx, f);
        }
        if (v === ne) hitCount++;
        if (cnt > 0) {
          if (approx(v, sum)) hitSum++;
          if (approx(v, mn)) hitMin++;
          if (approx(v, mx)) hitMax++;
          const dp = out.numKey[r]?.split('.')[1]?.length ?? 0;
          if (Math.abs(v - sum / cnt) <= 0.5 * 10 ** -dp + 1e-9 * Math.max(1, Math.abs(v))) hitAvg++;
        }
      });
      const best = Math.max(hitFirst, hitSum, hitCount, hitMin, hitMax, hitAvg);
      if (best / groups.length >= ALIGN.explainMinShare) {
        n++;
        return;
      }
    }
  });
  return n;
}
