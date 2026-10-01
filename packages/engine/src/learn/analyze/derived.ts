// Derived columns (SPEC 6.2 step 4, SPEC 21 v5 item 4). An output column that no relation explains is
// `unknown`. Most of those are EXTERNAL data (values that come from somewhere other than the input file),
// but some are DERIVED: fully determined by the input through a rule too rich for a single relation, e.g.
// `Size = "bulk" if Qty >= 10 else "single"` ("bulk" never appears in the input, yet the column is a function
// of Qty). The AI can solve those, so they must not be skipped, and must not be reported as external data.
//
// Whether an unknown column is determined by the input is a functional-dependency test, with real evidence:
//   (a) category: every value of one input column (or of two together) always maps to the same output value.
//       The evidence rule is the value map's: the keys must REPEAT, on average >= 1.5 rows per key, and the
//       repeated rows must agree. Reported for any number of keys (a value map stops at 50). A dependency on
//       an almost-unique key is memorizing, not a rule: it has no repeated rows, so it stays external.
//   (b) bands: sorting the rows by a numeric (or date) input column, the output values form contiguous
//       ranges with few breakpoints (<= 5), each range seen on >= 2 rows. The breakpoints are reported
//       (e.g. `< 10 -> single`, `>= 10 -> bulk`). A value seen on a single row is an exception (it counts
//       against the coverage), not a band.
//   (c) composition: the output is text COMPOSED from input values beyond the light `template` relation (three columns,
//       longer fixed text: `312345002 - Dana Cohen`, `Customer number 312345002: Cohen`). The cells visibly contain
//       input values, so the AI can write the rule: an input column counts when its value (normalized text) is a
//       substring of the output cell on >= `limits.learn.compositionMinCoverage` of the rows. Values shorter than
//       `compositionMinValueLength` never count, and neither does a value that sits just as often in the OTHER rows'
//       outputs (a constant column is fixed text, a common 2-letter value is chance, not data). The columns are
//       reported in the order they first appear in the output text. Tried last: only a column that no band or
//       category dependency explains (it would have been external before).
// Bands are tried first (they are the simpler, better generalizing rule), then one column, then two, then composition.
// Values are integer-coded once per column, so testing a few unknown columns on 20,000 rows stays cheap.
// Pure and deterministic. Only columns that stay `unknown` are tested. An unknown column with none of these is
// EXTERNAL: no relation to the input at all.

import Decimal from 'decimal.js';
import { limits } from '@formatai/shared';
import type { Band } from '@formatai/shared';
import { ymdToSerial } from '../../values/dates';
import { DATE, EMPTY, TEXT, canonNum, decimalsOf, isoOfSerial, keys, norms, payloadCell, ymdOfSerial, type ColumnData } from './cells';
import { MAX_FAILING, type RelationEnv } from './relations';
import type { ColumnAnalysis, Derivation } from './types';

/** At most this many breakpoints between bands (so at most 6 bands). */
export const MAX_BREAKPOINTS = 5;
/** A band must hold at least this many rows that agree with it. */
export const MIN_BAND_ROWS = 2;
/** Fewer aligned rows than this can't show a dependency. */
const MIN_ROWS = 6;
/** Columns considered for a two-column dependency: the ones with the fewest distinct values. */
const MAX_PAIR_COLUMNS = 10;
/** Two columns are combined only when their value pairs fit a table this big (bounds memory, not evidence). */
const MAX_PAIR_TABLE = 1_000_000;

/**
 * An unknown column no detector explained AND the input does not determine (as far as code can tell): its values may come from somewhere
 * else (SPEC 6.4). An internal class for wording and hints only: it is NOT skipped, the AI step tries it like any other column.
 */
export function isExternalColumn(ca: ColumnAnalysis): boolean {
  // A column that follows an across-row pattern (a running total, a rank ...) is determined by the input too: the AI step can solve it.
  return ca.unknown && ca.derived === null && (ca.windows === undefined || ca.windows.length === 0);
}

/** An unknown column the input determines: the AI can solve it (see the file header). */
export function isDerivedColumn(ca: ColumnAnalysis): boolean {
  return ca.unknown && (ca.derived !== null || (ca.windows !== undefined && ca.windows.length > 0));
}

// ---------- integer coding ----------

/** Every distinct value of a column as a small integer (the same value, the same id). */
interface Coded {
  ids: Int32Array;
  count: number;
}

function codeStrings(values: ArrayLike<string | null>): Coded {
  const n = values.length;
  const ids = new Int32Array(n);
  const table = new Map<string, number>();
  for (let k = 0; k < n; k++) {
    const v = values[k] ?? '';
    let id = table.get(v);
    if (id === undefined) {
      id = table.size;
      table.set(v, id);
    }
    ids[k] = id;
  }
  return { ids, count: table.size };
}

const CODED_MEMO = new WeakMap<ColumnData, Coded>();

/** An input (or created) column's matching keys (SPEC 6.2 value maps: numbers by value, text normalized), coded. */
function codedSource(col: ColumnData): Coded {
  let c = CODED_MEMO.get(col);
  if (c === undefined) {
    c = codeStrings(keys(col));
    CODED_MEMO.set(col, c);
  }
  return c;
}

/** Two columns as one: the id of each distinct pair. Null when the pair table would be too big. */
function combine(a: Coded, b: Coded): Coded | null {
  if (a.count * b.count > MAX_PAIR_TABLE) return null;
  const n = a.ids.length;
  const table = new Int32Array(a.count * b.count).fill(-1);
  const ids = new Int32Array(n);
  let count = 0;
  for (let k = 0; k < n; k++) {
    const key = a.ids[k]! * b.count + b.ids[k]!;
    let id = table[key]!;
    if (id < 0) {
      id = count++;
      table[key] = id;
    }
    ids[k] = id;
  }
  return { ids, count };
}

interface OutputCoding extends Coded {
  /** Rows per output value id. */
  freq: Int32Array;
  /** Probability that two random rows share an output value (1 = a constant column). */
  chance: number;
}

function codeOutput(out: ColumnData, n: number): OutputCoding {
  const text: string[] = new Array(n);
  for (let k = 0; k < n; k++) text[k] = out.kind[k] === EMPTY ? '' : out.text[k]!;
  const coded = codeStrings(text);
  const freq = new Int32Array(coded.count);
  for (let k = 0; k < n; k++) freq[coded.ids[k]!]!++;
  let chance = 0;
  for (const f of freq) chance += (f / n) ** 2;
  return { ...coded, freq, chance };
}

function capped(rows: number[]): number[] {
  return rows.slice(0, MAX_FAILING);
}

// ---------- (a) category dependency ----------

interface CategoryFit {
  keys: number;
  coverage: number;
  failing: number[];
  failCount: number;
}

/**
 * Whether the output is a function of the key `by`, with evidence: >= 1.5 rows per key on average, the repeated
 * rows agree (>= minCoverage of them, and clearly more than a nearly-constant output would give by chance), and
 * the value each key maps to explains >= minCoverage of all rows.
 */
function categoryFit(by: Coded, out: OutputCoding, minCoverage: number): CategoryFit | null {
  const n = by.ids.length;
  const nKeys = by.count;
  if (nKeys < 2 || nKeys >= n) return null;
  // The value map's evidence rule: rows whose key was already seen confirm the mapping.
  const confirming = n - nKeys;
  if (confirming < Math.max(2, Math.ceil(nKeys / 2))) return null;
  // The value each key maps to: its majority (one pass, no per-key tables).
  const value = new Int32Array(nKeys);
  const votes = new Int32Array(nKeys);
  for (let k = 0; k < n; k++) {
    const key = by.ids[k]!;
    const o = out.ids[k]!;
    if (votes[key] === 0) {
      value[key] = o;
      votes[key] = 1;
    } else if (value[key] === o) votes[key]!++;
    else votes[key]!--;
  }
  let matched = 0;
  for (let k = 0; k < n; k++) if (value[by.ids[k]!] === out.ids[k]) matched++;
  const coverage = matched / n;
  if (coverage < minCoverage) return null;
  const agreeRate = (matched - nKeys) / confirming;
  if (agreeRate < Math.max(minCoverage, out.chance + (1 - out.chance) / 2)) return null;
  const failing: number[] = [];
  for (let k = 0; k < n && failing.length < MAX_FAILING; k++) if (value[by.ids[k]!] !== out.ids[k]) failing.push(k);
  return { keys: nKeys, coverage, failing, failCount: n - matched };
}

function categoryDerivation(src: readonly ColumnData[], out: OutputCoding, minCoverage: number): Derivation | null {
  const n = out.ids.length;
  const coded = src.map(codedSource);

  // One column: the fewest distinct values wins (the simplest reading), then the first column.
  let best: { fit: CategoryFit; in: number[] } | null = null;
  for (let s = 0; s < coded.length; s++) {
    const fit = categoryFit(coded[s]!, out, minCoverage);
    if (fit && (best === null || fit.keys < best.fit.keys)) best = { fit, in: [s] };
  }

  // Two columns together, only when no single column does: columns with repeated values, fewest first.
  if (best === null) {
    const cand = coded
      .map((c, s) => ({ s, c }))
      .filter((x) => x.c.count >= 2 && x.c.count * 2 <= n)
      .sort((a, b) => a.c.count - b.c.count || a.s - b.s)
      .slice(0, MAX_PAIR_COLUMNS)
      .sort((a, b) => a.s - b.s);
    for (let i = 0; i < cand.length; i++) {
      for (let j = i + 1; j < cand.length; j++) {
        const both = combine(cand[i]!.c, cand[j]!.c);
        const fit = both && categoryFit(both, out, minCoverage);
        if (fit && (best === null || fit.keys < best.fit.keys)) best = { fit, in: [cand[i]!.s, cand[j]!.s] };
      }
    }
  }
  if (best === null) return null;
  const { fit, in: ins } = best;
  return { kind: 'category', in: ins, keys: fit.keys, coverage: fit.coverage, failing: fit.failing, failCount: fit.failCount };
}

// ---------- (b) numeric / date bands ----------

/** Steps for a "round" threshold, coarsest first: 1e6, 5e5, 1e5, ... 10, 5, 1, 0.5, ... */
function roundSteps(): Decimal[] {
  const steps: Decimal[] = [];
  for (let e = 6; e >= -6; e--) {
    steps.push(new Decimal(10).pow(e), new Decimal(10).pow(e).div(2));
  }
  return steps;
}
const ROUND_STEPS = roundSteps();

/**
 * The breakpoint between two neighbouring bands: any value in (lo, hi] fits the data (lo = the largest value of the
 * lower band, hi = the smallest of the upper band). The roundest number in the gap is reported (10 for 9 | 12);
 * with none coarser than the data's own granularity, hi (a value that really occurs).
 */
function numericThreshold(lo: number, hi: number): number {
  const dLo = new Decimal(canonNum(lo));
  const dHi = new Decimal(canonNum(hi));
  const finest = new Decimal(10).pow(-Math.max(decimalsOf(canonNum(lo)), decimalsOf(canonNum(hi))));
  for (const step of ROUND_STEPS) {
    if (step.lt(finest.times(2))) continue;
    const m = dLo.div(step).floor().plus(1).times(step);
    if (m.lte(dHi)) return m.toNumber();
  }
  return hi;
}

/** The same for dates (Excel serials): a January 1st, else a month start, else hi. */
function dateThreshold(lo: number, hi: number): number {
  const { y, m } = ymdOfSerial(lo);
  const year = ymdToSerial({ y: y + 1, m: 1, d: 1 });
  if (year <= hi) return year;
  const month = ymdToSerial(m === 12 ? { y: y + 1, m: 1, d: 1 } : { y, m: m + 1, d: 1 });
  return month <= hi ? month : hi;
}

/** Rows with a usable value in a column, sorted by it (the sort depends on the column only: every unknown output shares it). */
interface Axis {
  isDate: boolean;
  xs: Float64Array;
  order: number[];
}

const AXIS_MEMO = new WeakMap<ColumnData, Axis | null>();

/** The column read as dates or as numbers (whichever most cells are), sorted; null when too few cells are either. */
function axisOf(col: ColumnData, minCoverage: number): Axis | null {
  const memo = AXIS_MEMO.get(col);
  if (memo !== undefined) return memo;
  const n = col.n;
  let nNum = 0;
  let nDate = 0;
  for (let k = 0; k < n; k++) {
    if (col.kind[k] === EMPTY) continue;
    if (!Number.isNaN(col.date[k]!)) nDate++;
    else if (!Number.isNaN(col.num[k]!)) nNum++;
  }
  const isDate = nDate > nNum;
  const xs = isDate ? col.date : col.num;
  const valid = Math.max(nDate, nNum);
  let axis: Axis | null = null;
  if (valid >= MIN_ROWS && valid >= minCoverage * n) {
    const order: number[] = [];
    for (let k = 0; k < n; k++) if (col.kind[k] !== EMPTY && !Number.isNaN(xs[k]!)) order.push(k);
    order.sort((a, b) => xs[a]! - xs[b]! || a - b);
    axis = { isDate, xs, order };
  }
  AXIS_MEMO.set(col, axis);
  return axis;
}

interface Run {
  /** Output value id. */
  value: number;
  /** Group range [g0, g1], inclusive (groups = distinct x values in ascending order). */
  g0: number;
  g1: number;
}

/** Whether the top `MAX_BREAKPOINTS + 1` output values cover enough rows for bands to reach `minCoverage` at all. */
function fewValuesCover(out: OutputCoding, minCoverage: number): boolean {
  const n = out.ids.length;
  const top = [...out.freq].sort((a, b) => b - a).slice(0, MAX_BREAKPOINTS + 1);
  return top.reduce((a, b) => a + b, 0) >= minCoverage * n;
}

/** Sorts the rows by a numeric or date input column and looks for a few contiguous ranges of one output value. */
function bandsFor(src: ColumnData, s: number, outCol: ColumnData, out: OutputCoding, minCoverage: number): Derivation | null {
  const n = out.ids.length;
  const axis = axisOf(src, minCoverage);
  if (axis === null) return null;
  const { xs, order, isDate } = axis;
  const maxFailures = n - Math.ceil(minCoverage * n - 1e-9);

  // Groups of equal x, each with its dominant output value.
  const gx: number[] = [];
  const gsize: number[] = [];
  const gdom: number[] = [];
  for (let i = 0; i < order.length; ) {
    const x = xs[order[i]!]!;
    let j = i + 1;
    while (j < order.length && xs[order[j]!]! === x) j++;
    let dom = out.ids[order[i]!]!;
    if (j - i > 1) {
      const counts = new Map<number, number>();
      let best = 0;
      for (let p = i; p < j; p++) {
        const v = out.ids[order[p]!]!;
        const c = (counts.get(v) ?? 0) + 1;
        counts.set(v, c);
        if (c > best) {
          best = c;
          dom = v;
        }
      }
    }
    gx.push(x);
    gsize.push(j - i);
    gdom.push(dom);
    i = j;
  }
  const prefix: number[] = [0];
  for (const size of gsize) prefix.push(prefix[prefix.length - 1]! + size);

  // Runs of consecutive groups with the same dominant value.
  const runs: Run[] = [];
  for (let gi = 0; gi < gx.length; gi++) {
    const last = runs[runs.length - 1];
    if (last && last.value === gdom[gi]) last.g1 = gi;
    else runs.push({ value: gdom[gi]!, g0: gi, g1: gi });
  }
  // Each run seen on a single row is an exception, and counts against the coverage: bound them before sorting them out.
  const rowsOf = (r: Run): number => prefix[r.g1 + 1]! - prefix[r.g0]!;
  const shortRuns = runs.filter((r) => rowsOf(r) < MIN_BAND_ROWS).length;
  if (shortRuns > maxFailures || runs.length > MAX_BREAKPOINTS + 1 + 2 * shortRuns) return null;

  // A run seen on a single row (a hand-edited row) isn't a band: it joins the bigger neighbouring band (the only
  // one, at an edge). Its row then counts as a failure, so the coverage check below bounds the exceptions.
  for (;;) {
    const i = runs.findIndex((r) => rowsOf(r) < MIN_BAND_ROWS);
    if (i < 0 || runs.length < 2) break;
    const left = i > 0 ? runs[i - 1]! : null;
    const right = i + 1 < runs.length ? runs[i + 1]! : null;
    const into = left && right ? (rowsOf(right) > rowsOf(left) ? right : left) : (left ?? right)!;
    const merged: Run = { value: into.value, g0: Math.min(into.g0, runs[i]!.g0), g1: Math.max(into.g1, runs[i]!.g1) };
    runs.splice(Math.min(runs.indexOf(into), i), 2, merged);
    // Neighbours of the same value that met again form one run.
    for (let j = 0; j + 1 < runs.length; ) {
      if (runs[j]!.value === runs[j + 1]!.value) runs.splice(j, 2, { value: runs[j]!.value, g0: runs[j]!.g0, g1: runs[j + 1]!.g1 });
      else j++;
    }
  }
  if (runs.length < 2 || runs.length > MAX_BREAKPOINTS + 1) return null;

  // Row by row: which rows agree with their band; every band needs >= 2 of them.
  const agree = new Array<number>(runs.length).fill(0);
  const rep = new Array<number>(runs.length).fill(-1);
  const failing: number[] = [];
  let matched = 0;
  runs.forEach((run, ri) => {
    for (let pos = prefix[run.g0]!; pos < prefix[run.g1 + 1]!; pos++) {
      const k = order[pos]!;
      if (out.ids[k] === run.value) {
        agree[ri]!++;
        matched++;
        if (rep[ri]! < 0) rep[ri] = k;
      } else failing.push(k);
    }
  });
  if (agree.some((a) => a < MIN_BAND_ROWS)) return null;
  const coverage = matched / n;
  if (coverage < minCoverage) return null;
  // Rows without a usable value in this column count as failures.
  if (order.length < n) {
    const usable = new Uint8Array(n);
    for (const k of order) usable[k] = 1;
    for (let k = 0; k < n; k++) if (!usable[k]) failing.push(k);
  }
  failing.sort((a, b) => a - b);

  // The breakpoints, and the bands they make.
  const thresholds: (number | string)[] = [];
  for (let i = 0; i + 1 < runs.length; i++) {
    const lo = gx[runs[i]!.g1]!;
    const hi = gx[runs[i + 1]!.g0]!;
    thresholds.push(isDate ? isoOfSerial(dateThreshold(lo, hi)) : numericThreshold(lo, hi));
  }
  const bands: Band[] = runs.map((_, i) => {
    const band: Band = { value: payloadCell(outCol, rep[i]!) };
    if (i > 0) band.gte = thresholds[i - 1]!;
    if (i < thresholds.length) band.lt = thresholds[i]!;
    return band;
  });
  return { kind: 'bands', in: [s], bands, coverage, failing: capped(failing), failCount: n - matched };
}

// ---------- (c) composition ----------

/** One input column whose value sits inside the output text. */
interface Contained {
  col: number;
  /** Rows (aligned-row index) where the value is inside the output cell. */
  hit: Uint8Array;
  /** Where in the output text it was found, per hit row (in row order). */
  at: number[];
  /** The median of `at`: where the value usually appears in the output text. */
  place: number;
}

/** Where input column `a` (normalized `an`) is inside the output cell of the same row; null once the misses exceed `maxMisses` (it can't qualify). */
function containedIn(n: number, a: ColumnData, an: readonly string[], out: ColumnData, outNorm: readonly string[], minLen: number, maxMisses: number): Contained | null {
  const hit = new Uint8Array(n);
  const at: number[] = [];
  let misses = 0;
  for (let k = 0; k < n; k++) {
    const kind = a.kind[k]!;
    const v = an[k]!;
    let pos = -1;
    if (out.kind[k] === TEXT && kind !== EMPTY && kind !== DATE && v.length >= minLen) pos = outNorm[k]!.indexOf(v);
    if (pos < 0) {
      if (++misses > maxMisses) return null;
    } else {
      hit[k] = 1;
      at.push(pos);
    }
  }
  return { col: -1, hit, at, place: 0 };
}

/** How often the values of `a` sit inside the output cells of OTHER rows (row k's value against row k + n/2's output). */
function chanceRate(n: number, a: ColumnData, an: readonly string[], out: ColumnData, outNorm: readonly string[], minLen: number): number {
  const shift = Math.floor(n / 2) + 1;
  let hits = 0;
  for (let k = 0; k < n; k++) {
    const j = (k + shift) % n;
    const kind = a.kind[k]!;
    const v = an[k]!;
    if (out.kind[j] === TEXT && kind !== EMPTY && kind !== DATE && v.length >= minLen && outNorm[j]!.indexOf(v) >= 0) hits++;
  }
  return hits / n;
}

/**
 * Whether the output text is composed from input values: the input columns whose (normalized) value is a substring
 * of the output cell on >= `limits.learn.compositionMinCoverage` of the rows, and not just as often on other rows'
 * cells. Only input columns (not created family columns). Null when none qualifies: no composition evidence.
 */
function compositionDerivation(env: RelationEnv, out: ColumnData): Derivation | null {
  const { compositionMinCoverage, compositionMinValueLength } = limits.learn;
  const n = env.total;
  const nIn = Math.min(env.src.length, env.inputCount ?? env.src.length);
  let nonEmpty = 0;
  let text = 0;
  for (let k = 0; k < n; k++) {
    if (out.kind[k] === EMPTY) continue;
    nonEmpty++;
    if (out.kind[k] === TEXT) text++;
  }
  if (nonEmpty === 0 || text < 0.5 * nonEmpty) return null; // a text-like output only
  const maxMisses = n - Math.ceil(compositionMinCoverage * n - 1e-9);
  const outNorm = norms(out);

  const found: Contained[] = [];
  for (let s = 0; s < nIn; s++) {
    const a = env.src[s]!;
    const an = norms(a);
    const c = containedIn(n, a, an, out, outNorm, compositionMinValueLength, maxMisses);
    if (c === null) continue;
    // A value that sits as often in the other rows' outputs is not evidence about this row: a constant column is
    // fixed text, a common short value is chance.
    if (chanceRate(n, a, an, out, outNorm, compositionMinValueLength) > 0.5 * (c.at.length / n)) continue;
    c.col = s;
    c.place = [...c.at].sort((x, y) => x - y)[Math.floor(c.at.length / 2)]!;
    found.push(c);
  }
  if (found.length === 0) return null;

  // Ordered by where the value first appears in the output text (the median over the rows), then by column.
  found.sort((x, y) => x.place - y.place || x.col - y.col);

  const failing: number[] = [];
  let matched = 0;
  for (let k = 0; k < n; k++) {
    if (found.every((c) => c.hit[k] === 1)) matched++;
    else failing.push(k);
  }
  return { kind: 'composition', in: found.map((c) => c.col), coverage: matched / n, failing: capped(failing), failCount: n - matched };
}

// ---------- entry point ----------

/**
 * Whether the input determines the (unknown) output column `out`, and how: bands on a numeric or date column, else
 * a category dependency on one column, else on two, else (a text output) a composition of input values. `null` = no
 * dependency and no composition with real evidence: external data.
 * `env.src` are the columns aligned to the rows (input columns, then created family columns); `in` refers to them.
 */
export function findDerivation(env: RelationEnv, out: ColumnData): Derivation | null {
  const n = env.total;
  if (n < MIN_ROWS) return null;
  const coded = codeOutput(out, n);
  if (coded.chance >= 1) return null; // a constant column: nothing to derive

  // Bands first (the simpler rule, and the one that generalizes): the fewest breakpoints wins.
  let best: (Derivation & { kind: 'bands' }) | null = null;
  if (fewValuesCover(coded, env.minCoverage)) {
    for (let s = 0; s < env.src.length; s++) {
      const d = bandsFor(env.src[s]!, s, out, coded, env.minCoverage);
      if (d !== null && d.kind === 'bands' && (best === null || d.bands.length < best.bands.length)) best = d;
    }
  }
  return best ?? categoryDerivation(env.src, coded, env.minCoverage) ?? compositionDerivation(env, out);
}
