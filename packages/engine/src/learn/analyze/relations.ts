// Relation tests (SPEC 6.2 step 4): for one output column, every candidate
// relation to the input columns (and to the columns a family pattern creates)
// is tested on a seeded random sample of aligned rows first (cheap float
// pre-filters for numbers), then the survivors are confirmed on ALL aligned
// rows with exact decimal arithmetic. Each relation gets a coverage and the
// aligned rows where it fails.

import Decimal from 'decimal.js';
import { limits } from '@formatai/shared';
import type { PayloadCell } from '@formatai/shared';
import { formatYmd } from '../../values/dates';
import { padLeft } from '../../values/text';
import {
  BOOL,
  DATE,
  EMPTY,
  NUM,
  TEXT,
  altDates,
  canonNum,
  decOf,
  decimalsOf,
  keys,
  nonEmptyCount,
  normFast,
  norms,
  numericShare,
  payloadCell,
  significantDigits,
  ymdOfSerial,
  type ColumnData,
} from './cells';
import { dateReadings } from './dateReadings';
import type { Relation, RelationBody, SummaryAgg } from './types';

/** Failing aligned-row indices kept per relation. */
export const MAX_FAILING = 50;
/** Relations kept per output column. */
export const MAX_RELATIONS = 6;
/** The sample pass keeps candidates this far below minCoverage (sampling noise). */
const SLACK = 0.03;

export interface RelationEnv {
  /** Source columns aligned to the rows: input columns, then created family columns. */
  src: ColumnData[];
  /** How many of `src` are input columns (the rest are created family columns); default: all. */
  inputCount?: number;
  /** Rows tested (aligned rows, or one family position's rows). */
  total: number;
  /** Row indices (0..total-1, ascending) of the first pass. */
  sample: number[];
  minCoverage: number;
  /** Local row -> global aligned-row index, for `failing` (identity when absent). */
  globalIndex?: ArrayLike<number>;
  /** Language tried first for month names. */
  language: 'he' | 'en';
}

/** 0 = fails, 1 = holds, 2 = holds only after rounding (numeric relations). */
type Test = (k: number) => number;

interface Cand {
  body: RelationBody;
  rank: number;
  test: Test;
  /** Necessary condition (float pre-filter), used on the sample and before `test`. */
  pre?: (k: number) => boolean;
  /** Rounding digits to report when some rows only hold after rounding. */
  round?: number;
}

const RANK: Record<RelationBody['rel'], number> = {
  copy: 0,
  aggregate: 0,
  normalize: 1,
  padLeft: 2,
  dateFormat: 2,
  numberFormat: 2,
  substr: 3,
  split: 3,
  concat: 4,
  template: 4.5,
  // Across rows (windows.ts): a group's total, a count per group. Above a value map, a constant and the calculations: a figure of the group
  // that happens to repeat per key looks like a lookup, and is not one (it is different next month).
  window: 4.8,
  constant: 5,
  mulConst: 6,
  addConst: 6,
  add: 7,
  sub: 7,
  mul: 7,
  div: 7,
  sum: 8,
  valueMap: 9,
};

// ---------- evaluation ----------

function passesSample(env: RelationEnv, cand: Cand): boolean {
  const S = env.sample;
  if (S.length === 0) return true;
  const allowed = Math.floor(S.length * (1 - (env.minCoverage - SLACK)));
  let fails = 0;
  for (const k of S) {
    const ok = cand.pre ? cand.pre(k) : cand.test(k) > 0;
    if (!ok && ++fails > allowed) return false;
  }
  return true;
}

function evaluate(env: RelationEnv, out: ColumnData, outIndex: number, cand: Cand): Relation | null {
  const total = env.total;
  if (total === 0) return null;
  const res = new Uint8Array(total);
  let c1 = 0;
  let c2 = 0;
  // Early exit: even counting every rounded row, the relation can't reach minCoverage.
  const maxFails = total - Math.ceil(env.minCoverage * total - 1e-9);
  let fails = 0;
  for (let k = 0; k < total; k++) {
    const r = cand.pre && !cand.pre(k) ? 0 : cand.test(k);
    res[k] = r;
    if (r === 1) c1++;
    else if (r === 2) c2++;
    else if (++fails > maxFails) return null;
  }
  const useRound = cand.round !== undefined && c2 > 0;
  const matched = useRound ? c1 + c2 : c1;
  const coverage = matched / total;
  if (coverage < env.minCoverage) return null;
  // Non-trivial: the relation must hold on at least half of the rows where the output has a value.
  let outNonEmpty = 0;
  let heldNonEmpty = 0;
  const failing: number[] = [];
  for (let k = 0; k < total; k++) {
    const holds = res[k] === 1 || (useRound && res[k] === 2);
    if (out.kind[k] !== EMPTY) {
      outNonEmpty++;
      if (holds) heldNonEmpty++;
    }
    if (!holds && failing.length < MAX_FAILING) failing.push(env.globalIndex ? env.globalIndex[k]! : k);
  }
  if (outNonEmpty > 0 && heldNonEmpty < 0.5 * outNonEmpty) return null;
  const body = { ...cand.body } as RelationBody & { round?: number };
  if (useRound) body.round = cand.round;
  return { ...body, out: outIndex, coverage, matched, total, failing, failCount: total - matched } as Relation;
}

// ---------- shared helpers ----------

/** Trimmed text for text relations ('' for empty or dates). */
function textAt(col: ColumnData, k: number): string {
  const kind = col.kind[k]!;
  if (kind === EMPTY || kind === DATE) return '';
  return kind === TEXT ? col.text[k]!.trim() : col.text[k]!;
}

function kindShare(col: ColumnData, kind: number): number {
  let ne = 0;
  let n = 0;
  for (let k = 0; k < col.n; k++) {
    const kk = col.kind[k]!;
    if (kk === EMPTY) continue;
    ne++;
    if (kk === kind) n++;
  }
  return ne === 0 ? 0 : n / ne;
}

/** Up to `limit` sample rows where both columns have a value. */
function bothRows(env: RelationEnv, a: ColumnData, out: ColumnData, limit: number): number[] {
  const rows: number[] = [];
  for (const k of env.sample) {
    if (a.kind[k] !== EMPTY && out.kind[k] !== EMPTY) {
      rows.push(k);
      if (rows.length >= limit) break;
    }
  }
  return rows;
}

function mode<T>(counts: Map<T, number>): T | null {
  let best: T | null = null;
  let bestN = 0;
  for (const [k, n] of counts) {
    if (n > bestN) {
      best = k;
      bestN = n;
    }
  }
  return best;
}

function bump<T>(m: Map<T, number>, k: T): void {
  m.set(k, (m.get(k) ?? 0) + 1);
}

/** Same value, as the engine would copy it (types compared, text exact). */
export function eqTyped(a: ColumnData, b: ColumnData, k: number, j = k): boolean {
  const ka = a.kind[k]!;
  const kb = b.kind[j]!;
  if (kb === EMPTY) return ka === EMPTY;
  if (ka === EMPTY) return false;
  switch (kb) {
    case NUM:
      return ka !== DATE && a.numKey[k] !== null && a.numKey[k] === b.numKey[j];
    case DATE:
      return ka === DATE && a.date[k] === b.date[j];
    case BOOL:
      return ka === BOOL ? a.text[k] === b.text[j] : ka === TEXT && a.text[k]!.trim().toUpperCase() === b.text[j];
    default:
      return ka !== DATE && a.text[k] === b.text[j];
  }
}

// ---------- the constant guard ----------

/** Text renderings of a date a "fixed" column may really be: the month or year of the data (DATE_RENDERINGS, below), and the short ones. */
const GUARD_DATE_RENDERINGS = ['MM', 'M', 'MMM', 'YY'];

/**
 * DECISION (owner: light detection, refuse on ambiguity, the UI never claims what it can't know): a column that holds
 * the SAME value on every row is accepted as a `constant` only when the input cannot also write that value. In a March file
 * a `Period` of "03/2026" on every row is the month of the data as likely as a fixed label, and a fixed label is wrong next month.
 * The example cannot tell the two apart, so the constant is not guessed: the user is asked (readings.ts, fastPath.ts `ambiguityOf`; owner
 * decision 2026-10-04, SPEC 21 v12 item 11), the data reading being built until they answer. Where no data reading can be written as a rule
 * (a date column that mixes formats) the column goes to the AI step, with the input column that can write it named (a `dependsOn`
 * hint, or the relation that does). The value is derivable when, on EVERY row:
 *  (a) an input column holds the same value (a copy is as possible as a constant);
 *  (b) a date input column, formatted with an output date format the free engine writes (the month, the year, ...), gives it
 *      - each cell is read on its own, so a column mixing date formats counts (dateReadings.ts);
 *  (c) a fixed part of an input text (a prefix, a suffix, a fixed position, one part of a split) is that value;
 *  (d) fixed text around the value of an input column that holds ONE value on every row ("Area " + a Group that is "North"
 *      throughout): the `template` the free engine writes (short fixed text, `limits.learn.template`) gives the same constant.
 * (c) is the existing `substr` / `split` detection run on this column, not new code. A template over input columns that VARY cannot
 * write a constant; over a column that does not, it can (d): found by the engine stress test (eval/STRESS.md), built as a constant
 * the template was wrong on the first row next month that holds another value.
 * A truly fixed value that also happens to appear in the data goes to the AI step too: acceptable, the AI step or the user decides.
 * Returns the source columns (indices into `env.src`, input columns first) that can write the value; none = a real constant.
 */
function constantSources(env: RelationEnv, out: ColumnData, value: string): number[] {
  const found = new Set<number>();
  const total = env.total;
  const v = value.trim();

  // (a) a copy: an input column holds this very value on every row
  env.src.forEach((a, s) => {
    for (let k = 0; k < total; k++) if (!eqTyped(a, out, k)) return;
    found.add(s);
  });

  // (b) the month or year of a date column
  const langs: ('he' | 'en')[] = env.language === 'he' ? ['he', 'en'] : ['en', 'he'];
  env.src.forEach((a, s) => {
    if (found.has(s)) return;
    const reads = dateReadings(a);
    if (reads === null) return;
    for (const f of [...DATE_RENDERINGS, ...GUARD_DATE_RENDERINGS]) {
      for (const lang of /MMM/.test(f) ? langs : [langs[0]!]) {
        if (reads.every((r) => r.some((d) => formatYmd(ymdOfSerial(d), f, lang) === v))) {
          found.add(s);
          return;
        }
      }
    }
  });

  // (c) a fixed part of a text
  for (const cand of [...substrCands(env, out), ...splitCands(env, out)]) {
    const s = (cand.body as { in: number[] }).in[0]!;
    if (found.has(s)) continue;
    let holds = true;
    for (let k = 0; k < total && holds; k++) holds = cand.test(k) === 1;
    if (holds) found.add(s);
  }

  // (d) fixed text around the one value of an input column (a template of a column that does not vary in the example)
  const T = limits.learn.template;
  env.src.forEach((a, s) => {
    if (found.has(s) || total === 0) return;
    let w: string | null = null;
    for (let k = 0; k < total; k++) {
      const kind = a.kind[k];
      if (kind === EMPTY || kind === DATE) return;
      const t = a.text[k]!.trim();
      if (w === null) w = t;
      else if (t !== w) return;
    }
    if (w === null || w.length < limits.learn.compositionMinValueLength || w === v) return;
    const at = v.indexOf(w);
    if (at < 0) return;
    const before = at;
    const after = v.length - at - w.length;
    if (before <= T.maxLiteralChars && after <= T.maxLiteralChars && before + after <= T.maxTotalLiteralChars) found.add(s);
  });
  return [...found].sort((x, y) => x - y);
}

/** What `stage1` tells `findRelations` about the constant it did not accept. */
interface ConstantGuard {
  /** The columns that can write a constant column's value (see `constantSources`); undefined = no such column, or no constant. */
  sources?: number[];
  /** The value every row holds, when `sources` is set (the constant reading of the question the result screen asks, readings.ts). */
  value?: PayloadCell;
}

// ---------- stage 1: constant, copy, normalize ----------

function stage1(env: RelationEnv, out: ColumnData, guard: ConstantGuard): Cand[] {
  const cands: Cand[] = [];
  const counts = new Map<string, number>();
  const firstRow = new Map<string, number>();
  for (let k = 0; k < out.n; k++) {
    if (out.kind[k] === EMPTY) continue;
    const t = out.text[k]!;
    bump(counts, t);
    if (!firstRow.has(t)) firstRow.set(t, k);
  }
  const top = mode(counts);
  if (top !== null && counts.get(top)! >= (env.minCoverage - SLACK) * out.n) {
    const value: PayloadCell = payloadCell(out, firstRow.get(top)!);
    // The guard looks only at a constant that is exact (every row holds it): one with exceptions is a hint for the AI step anyway.
    const sources = counts.get(top) === out.n ? constantSources(env, out, top) : [];
    if (sources.length > 0) {
      guard.sources = sources;
      guard.value = value;
    } else cands.push({ body: { rel: 'constant', in: [], value }, rank: RANK.constant, test: (k) => (out.text[k] === top ? 1 : 0) });
  }
  const outText = kindShare(out, TEXT) > 0;
  const nb = outText ? norms(out) : null;
  env.src.forEach((a, s) => {
    cands.push({ body: { rel: 'copy', in: [s] }, rank: RANK.copy, test: (k) => (eqTyped(a, out, k) ? 1 : 0) });
    if (nb !== null && kindShare(a, TEXT) > 0) {
      const na = norms(a);
      // The texts match case-insensitively (norms), but the rule - trim, collapse, unify quotes, and the one case change
      // all rows share - writes an exact text: where the output differs from that (a proper case, say) the relation
      // does not hold, however alike the texts look.
      const caseChange = normalizeCase(a, out, env.total);
      cands.push({
        body: { rel: 'normalize', in: [s] },
        rank: RANK.normalize,
        test: (k) => {
          if (na[k] !== nb[k]) return 0;
          if (a.kind[k] !== TEXT || out.kind[k] === EMPTY) return 1;
          const n = normFast(a.text[k]!);
          const written = caseChange === 'upper' ? n.toUpperCase() : caseChange === 'lower' ? n.toLowerCase() : n;
          return out.text[k]!.trim() === written ? 1 : 0;
        },
      });
    }
  });
  return cands;
}

/** Which case change (if any) a normalize relation makes. */
function normalizeCase(a: ColumnData, out: ColumnData, total: number): 'upper' | 'lower' | undefined {
  let upper = true;
  let lower = true;
  let changed = false;
  let seen = 0;
  for (let k = 0; k < total && seen < 500; k++) {
    if (a.kind[k] !== TEXT || out.kind[k] === EMPTY) continue;
    const n = normFast(a.text[k]!);
    const o = out.text[k]!.trim();
    if (normFast(o).toLowerCase() !== n.toLowerCase()) continue;
    seen++;
    if (o !== n.toUpperCase()) upper = false;
    if (o !== n.toLowerCase()) lower = false;
    if (n !== n.toUpperCase() || n !== n.toLowerCase()) changed = true;
  }
  if (!changed || seen === 0) return undefined;
  return upper ? 'upper' : lower ? 'lower' : undefined;
}

// ---------- stage 2: text shapes and formats ----------

/**
 * DECISION (found by the engine stress test, eval/STRESS.md): "pad to a length" needs an example that shows a length. When every
 * padded text has the same length, padding it with "X" to a fixed length and a fixed "X" in front write the same output - but not on
 * next month's shorter code ("XXREF/3780"). Any character but "0" therefore pads only when the example pads by different amounts (the
 * template or the AI step takes the rest); zeros keep padding an ID to its length, the usual meaning of leading zeros.
 */
function padCands(env: RelationEnv, out: ColumnData): Cand[] {
  if (kindShare(out, TEXT) < 0.5) return [];
  const cands: Cand[] = [];
  env.src.forEach((a, s) => {
    const counts = new Map<string, number>();
    const padded = new Map<string, Set<number>>();
    for (const k of bothRows(env, a, out, 200)) {
      const t = textAt(a, k);
      const o = out.text[k]!.trim();
      if (t === '' || o.length <= t.length || !o.endsWith(t)) continue;
      const ch = o[0]!;
      if (o.slice(0, o.length - t.length) !== ch.repeat(o.length - t.length)) continue;
      const key = `${o.length}\u0000${ch}`;
      bump(counts, key);
      const amounts = padded.get(key) ?? new Set<number>();
      amounts.add(o.length - t.length);
      padded.set(key, amounts);
    }
    const best = mode(counts);
    if (best === null) return;
    const [lenText, ch] = best.split('\u0000') as [string, string];
    if (ch !== '0' && (padded.get(best)?.size ?? 0) < 2) return;
    const length = Number(lenText);
    cands.push({
      body: { rel: 'padLeft', in: [s], length, char: ch },
      rank: RANK.padLeft,
      test: (k) => {
        const ea = a.kind[k] === EMPTY;
        const eo = out.kind[k] === EMPTY;
        if (ea || eo) return ea && eo ? 1 : 0;
        return out.text[k]!.trim() === padLeft(textAt(a, k), length, ch) ? 1 : 0;
      },
    });
  });
  return cands;
}

/** Whether position `i` of `t` is a cut that leaves every run of digits whole (no digit on both sides). */
function wholeDigitsAt(t: string, i: number): boolean {
  return i <= 0 || i >= t.length || !(/\d/.test(t[i - 1]!) && /\d/.test(t[i]!));
}

function substrCands(env: RelationEnv, out: ColumnData): Cand[] {
  const cands: Cand[] = [];
  env.src.forEach((a, s) => {
    if (kindShare(a, DATE) > 0) return;
    // DECISION (found by the engine stress test, eval/STRESS.md): a part of a date written as text is a whole day, month or year. A cut
    // inside one is luck: the 5th character of "17/06/2026" is the month on every row of an example whose months are 1-9, and "0" in
    // October. Such a column is left to the rest of the analysis (or the AI step).
    const cut = a.textDate !== null ? (t: string, from: number, to: number): boolean => wholeDigitsAt(t, from) && wholeDigitsAt(t, to) : (): boolean => true;
    const pre = new Map<number, number>();
    const suf = new Map<number, number>();
    const fix = new Map<string, number>();
    for (const k of bothRows(env, a, out, 200)) {
      const t = textAt(a, k);
      const o = textAt(out, k);
      if (o === '' || o === t || o.length >= t.length) continue;
      if (t.startsWith(o) && cut(t, 0, o.length)) bump(pre, o.length);
      if (t.endsWith(o) && cut(t, t.length - o.length, t.length)) bump(suf, o.length);
      const at = t.indexOf(o, 1);
      if (at > 0 && at + o.length < t.length && cut(t, at, at + o.length)) bump(fix, `${at + 1}:${o.length}`);
    }
    const both = (k: number): number | null => {
      const ea = a.kind[k] === EMPTY;
      const eo = out.kind[k] === EMPTY;
      if (ea || eo) return ea && eo ? 1 : 0;
      return null;
    };
    const p = mode(pre);
    if (p !== null) {
      cands.push({
        body: { rel: 'substr', in: [s], from: 'start', length: p },
        rank: RANK.substr,
        test: (k) => both(k) ?? (textAt(out, k) === textAt(a, k).slice(0, p) ? 1 : 0),
      });
    }
    const q = mode(suf);
    if (q !== null) {
      cands.push({
        body: { rel: 'substr', in: [s], from: 'end', length: q },
        rank: RANK.substr,
        test: (k) => {
          const e = both(k);
          if (e !== null) return e;
          const t = textAt(a, k);
          return textAt(out, k) === t.slice(Math.max(0, t.length - q)) ? 1 : 0;
        },
      });
    }
    const f = mode(fix);
    if (f !== null) {
      const [startText, lenText] = f.split(':') as [string, string];
      const start = Number(startText);
      const length = Number(lenText);
      cands.push({
        body: { rel: 'substr', in: [s], from: start, length },
        rank: RANK.substr,
        test: (k) => both(k) ?? (textAt(out, k) === textAt(a, k).substr(start - 1, length) ? 1 : 0),
      });
    }
  });
  return cands;
}

/** The separators a `split` relation tries, in order of preference. */
export const SPLIT_SEPARATORS = [' ', '-', '/', '_', '.', ',', ';', '|'];

function splitCands(env: RelationEnv, out: ColumnData): Cand[] {
  if (kindShare(out, DATE) > 0.5) return [];
  const cands: Cand[] = [];
  env.src.forEach((a, s) => {
    if (kindShare(a, TEXT) === 0) return;
    const counts = new Map<string, number>();
    for (const k of bothRows(env, a, out, 200)) {
      const t = textAt(a, k);
      const o = textAt(out, k);
      if (o === '' || o === t) continue;
      for (const sep of SPLIT_SEPARATORS) {
        if (!t.includes(sep)) continue;
        const parts = t.split(sep).map((x) => x.trim());
        const i = parts.indexOf(o);
        if (i < 0) continue;
        bump(counts, `${sep}\u0000${i + 1}`);
        bump(counts, `${sep}\u0000${i - parts.length}`);
      }
    }
    const best = mode(counts);
    if (best === null) return;
    const [sep, idxText] = best.split('\u0000') as [string, string];
    const index = Number(idxText);
    cands.push({
      body: { rel: 'split', in: [s], separator: sep, index },
      rank: RANK.split,
      test: (k) => {
        const ea = a.kind[k] === EMPTY;
        const eo = out.kind[k] === EMPTY;
        if (ea) return eo ? 1 : 0;
        const parts = textAt(a, k).split(sep);
        const part = (index > 0 ? parts[index - 1] : parts[parts.length + index]) ?? '';
        return textAt(out, k) === part.trim() ? 1 : 0;
      },
    });
  });
  return cands;
}

const CONCAT_SEPARATORS = [' ', ', ', ',', ' - ', '-', '_', '/', ' / ', '|', ' | ', ';', '; ', '.', ''];
const MAX_CONCAT_PARTS = 5;

/** Sequences of distinct source columns whose texts, joined with sep, give o exactly. */
function concatSequences(texts: string[], o: string, sep: string, limit: number): number[][] {
  const found: number[][] = [];
  const seq: number[] = [];
  const walk = (pos: number): void => {
    if (found.length >= limit || seq.length >= MAX_CONCAT_PARTS) return;
    for (let c = 0; c < texts.length; c++) {
      const t = texts[c]!;
      if (t === '' || seq.includes(c) || !o.startsWith(t, pos)) continue;
      const end = pos + t.length;
      seq.push(c);
      if (end === o.length) {
        if (seq.length >= 2) found.push([...seq]);
      } else if (sep !== '' && o.startsWith(sep, end)) walk(end + sep.length);
      else if (sep === '') walk(end);
      seq.pop();
      if (found.length >= limit) return;
    }
  };
  walk(0);
  return found;
}

function concatCands(env: RelationEnv, out: ColumnData): Cand[] {
  if (kindShare(out, TEXT) < 0.5) return [];
  const src = env.src;
  const usable = src.map((a) => kindShare(a, DATE) === 0);
  const rows: number[] = [];
  for (const k of env.sample) {
    if (out.kind[k] === TEXT) rows.push(k);
    if (rows.length >= 12) break;
  }
  if (rows.length === 0) return [];
  const textsAt = (k: number): string[] => src.map((a, s) => (usable[s] ? textAt(a, k) : ''));
  const first = rows[0]!;
  const o0 = out.text[first]!.trim();
  const seqs = new Map<string, { sep: string; cols: number[] }>();
  for (const sep of CONCAT_SEPARATORS) {
    for (const cols of concatSequences(textsAt(first), o0, sep, 8)) seqs.set(`${sep}\u0000${cols.join(',')}`, { sep, cols });
  }
  const cands: Cand[] = [];
  for (const { sep, cols } of seqs.values()) {
    let hits = 0;
    for (const k of rows) {
      const parts = cols.map((c) => textAt(src[c]!, k));
      const o = out.text[k]!.trim();
      if (parts.join(sep) === o || parts.filter((p) => p !== '').join(sep) === o) hits++;
    }
    if (hits < 0.75 * rows.length) continue;
    for (const skipEmpty of [false, true]) {
      cands.push({
        body: { rel: 'concat', in: cols, separator: sep, skipEmpty },
        rank: RANK.concat + (skipEmpty ? 0.5 : 0),
        test: (k) => {
          const parts = cols.map((c) => textAt(src[c]!, k));
          const o = out.kind[k] === EMPTY ? '' : out.text[k]!.trim();
          const joined = skipEmpty ? parts.filter((p) => p !== '').join(sep) : parts.every((p) => p === '') ? '' : parts.join(sep);
          return joined === o ? 1 : 0;
        },
      });
    }
  }
  return cands;
}

// ---------- stage 2b: template (fixed text around and between input values) ----------

/** Sample rows the candidate templates are derived from and cross-checked on before the full test. */
const TEMPLATE_PROBE_ROWS = 12;
/** Probe rows a search runs on (a column that is empty on one row can be located on another). */
const TEMPLATE_SEARCH_ROWS = 3;
/** Search budget per probe row, and candidates kept: past this the data fits many readings and none is reported anyway. */
const TEMPLATE_MAX_NODES = 4000;
const TEMPLATE_MAX_CANDIDATES = 40;

interface TemplateShape {
  /** Source column of each value, in output order (a column may repeat). */
  cols: number[];
  /** Fixed text before, between and after the values: cols.length + 1 entries, any of them may be ''. */
  lits: string[];
}

/** Exact test: the output cell is text and equals lits[0] + v(cols[0]) + lits[1] + ... on this row. */
function templateTest(out: ColumnData, srcCols: ColumnData[], lits: string[]): Test {
  const n = srcCols.length;
  return (k) => {
    if (out.kind[k] !== TEXT) return 0;
    const o = out.text[k]!;
    let pos = 0;
    for (let i = 0; i <= n; i++) {
      const lit = lits[i]!;
      if (lit !== '') {
        if (!o.startsWith(lit, pos)) return 0;
        pos += lit.length;
      }
      if (i < n) {
        const v = textAt(srcCols[i]!, k);
        if (v !== '') {
          if (!o.startsWith(v, pos)) return 0;
          pos += v.length;
        }
      }
    }
    return pos === o.length ? 1 : 0;
  };
}

/**
 * DECISION (owner: keep it light - a wrongly caught complex rule is worse than one sent to the AI): the
 * `template` relation - output text = fixed text + the value of 1-2 input columns (+ fixed text + ...), e.g.
 * `12345:"Cohen"` from ID and Name - is reported only when
 *  - no simpler relation explained the column (the caller runs this after copy/normalize/padLeft/substr/concat...);
 *  - it holds on EVERY row (coverage 1, the output cell is text and equals the regenerated text exactly);
 *  - it is short: at most `limits.learn.template` columns (the same column twice counts twice), literals and total literal length;
 *  - it is the ONLY template that fits: two readings that both reproduce every row (a column equal to another,
 *    a column that is constant and could equally be fixed text) report none, and the column goes to the AI.
 * The input values are located as substrings of the output on a few rows, the literals are what lies between
 * them, and each candidate is then confirmed on the 2,000-row sample and on all rows. No regex.
 */
function templateRelation(env: RelationEnv, out: ColumnData, outIndex: number): Relation | null {
  const { maxColumns, maxLiteralChars, maxTotalLiteralChars } = limits.learn.template;
  if (kindShare(out, TEXT) < 0.5) return null;
  const src = env.src;
  const nIn = Math.min(src.length, env.inputCount ?? src.length);
  const probe: number[] = [];
  for (const k of env.sample) {
    if (out.kind[k] === TEXT) probe.push(k);
    if (probe.length >= TEMPLATE_PROBE_ROWS) break;
  }
  if (probe.length === 0) return null;

  // Columns that can take part: the value is in the output text on every probe row where it is not empty.
  const cols: number[] = [];
  for (let s = 0; s < nIn; s++) {
    const a = src[s]!;
    let seen = false;
    let ok = true;
    for (const k of probe) {
      const v = textAt(a, k);
      if (v === '') continue;
      seen = true;
      if (!out.text[k]!.includes(v)) {
        ok = false;
        break;
      }
    }
    if (ok && seen && kindShare(a, DATE) === 0) cols.push(s);
  }
  if (cols.length === 0) return null;

  // Candidate shapes: from a few probe rows, every way of locating up to `maxColumns` values in order.
  const shapes = new Map<string, TemplateShape>();
  for (const k0 of probe.slice(0, TEMPLATE_SEARCH_ROWS)) {
    const o0 = out.text[k0]!;
    const seq: { col: number; at: number; end: number }[] = [];
    let nodes = 0;
    const emit = (): void => {
      const lits: string[] = [];
      let pos = 0;
      let total = 0;
      for (const p of seq) {
        lits.push(o0.slice(pos, p.at));
        pos = p.end;
      }
      lits.push(o0.slice(pos));
      for (const l of lits) {
        if (l.length > maxLiteralChars) return;
        total += l.length;
      }
      if (total === 0 || total > maxTotalLiteralChars) return; // no fixed text at all is a copy / concat
      const shape: TemplateShape = { cols: seq.map((p) => p.col), lits };
      shapes.set(`${shape.cols.join(',')}\u0000${lits.join('\u0000')}`, shape);
    };
    const walk = (pos: number): void => {
      if (seq.length > 0) emit();
      if (seq.length >= maxColumns) return;
      for (const c of cols) {
        const v = textAt(src[c]!, k0);
        if (v === '') continue;
        for (let at = o0.indexOf(v, pos); at >= 0 && at - pos <= maxLiteralChars; at = o0.indexOf(v, at + 1)) {
          if (++nodes > TEMPLATE_MAX_NODES) return;
          seq.push({ col: c, at, end: at + v.length });
          walk(at + v.length);
          seq.pop();
        }
      }
    };
    walk(0);
  }
  if (shapes.size === 0) return null;

  // Confirm: the other probe rows, then the sample, then every row. Coverage must be exactly 1.
  const strict: RelationEnv = { ...env, minCoverage: 1 };
  const holding: Relation[] = [];
  for (const shape of [...shapes.values()].slice(0, TEMPLATE_MAX_CANDIDATES)) {
    const test = templateTest(out, shape.cols.map((c) => src[c]!), shape.lits);
    if (!probe.every((k) => test(k) === 1)) continue;
    const parts: (string | { in: number })[] = [];
    shape.lits.forEach((lit, i) => {
      if (lit !== '') parts.push(lit);
      if (i < shape.cols.length) parts.push({ in: shape.cols[i]! });
    });
    const cand: Cand = { body: { rel: 'template', in: [...new Set(shape.cols)], parts }, rank: RANK.template, test };
    if (!passesSample(strict, cand)) continue;
    const rel = evaluate(strict, out, outIndex, cand);
    if (rel !== null && rel.coverage === 1) holding.push(rel);
  }
  // More than one template fits every row: it is a guess which one is meant, so none is reported.
  return holding.length === 1 ? holding[0]! : null;
}

/** Output renderings tried for text dates besides the output column's own format. */
const DATE_RENDERINGS = [
  'DD/MM/YYYY', 'D/M/YYYY', 'MM/DD/YYYY', 'M/D/YYYY', 'YYYY-MM-DD', 'DD.MM.YYYY', 'D.M.YYYY', 'DD-MM-YYYY',
  'YYYYMMDD', 'DD/MM/YY', 'YYYY/MM/DD', 'MM/YYYY', 'M/YYYY', 'MM.YYYY', 'MM-YYYY', 'YYYY-MM', 'MMMM YYYY',
  'MMM YYYY', 'MMM-YY', 'MMMM', 'YYYY', 'DD/MM',
];

function dateSources(a: ColumnData): { dates: Float64Array; from: string }[] {
  const out: { dates: Float64Array; from: string }[] = [];
  if (kindShare(a, DATE) > 0.5) out.push({ dates: a.date, from: 'date' });
  else if (a.textDate) {
    out.push({ dates: a.date, from: a.textDate.format });
    if (a.textDate.ambiguous && a.textDate.altFormat) out.push({ dates: altDates(a), from: a.textDate.altFormat });
  } else if (numericShare(a) === 1 && nonEmptyCount(a) > 0) {
    // Plain numbers that may be Excel serials (1910-01-01 .. 2099-12-31).
    const serial = new Float64Array(a.n).fill(NaN);
    let ok = true;
    for (let k = 0; k < a.n && ok; k++) {
      if (a.kind[k] === EMPTY) continue;
      const v = a.num[k]!;
      if (!Number.isInteger(v) || v < 3654 || v > 73415) ok = false;
      else serial[k] = v;
    }
    if (ok) out.push({ dates: serial, from: 'excelSerial' });
  }
  return out;
}

function dateCands(env: RelationEnv, out: ColumnData, outFormat: string | undefined): Cand[] {
  const cands: Cand[] = [];
  const outIsDate = kindShare(out, DATE) > 0.5;
  const outIsText = kindShare(out, TEXT) > 0.5;
  if (!outIsDate && !outIsText) return cands;
  env.src.forEach((a, s) => {
    for (const { dates, from } of dateSources(a)) {
      if (outIsDate) {
        if (from === 'date') continue; // real date to real date is a copy
        cands.push({
          body: { rel: 'dateFormat', in: [s], from, to: outFormat ?? 'dd/mm/yyyy' },
          rank: RANK.dateFormat,
          test: (k) => {
            const ea = a.kind[k] === EMPTY;
            const eo = out.kind[k] === EMPTY;
            if (ea || eo) return ea && eo ? 1 : 0;
            return dates[k] === out.date[k] ? 1 : 0;
          },
        });
        continue;
      }
      // Text output: find the rendering on a few rows, then test it everywhere.
      const rows: number[] = [];
      for (const k of env.sample) {
        if (!Number.isNaN(dates[k]!) && out.kind[k] === TEXT) rows.push(k);
        if (rows.length >= 5) break;
      }
      if (rows.length === 0) continue;
      const formats = [
        ...(out.textDate ? [out.textDate.format, ...(out.textDate.altFormat ? [out.textDate.altFormat] : [])] : []),
        ...DATE_RENDERINGS,
      ];
      const langs: ('he' | 'en')[] = env.language === 'he' ? ['he', 'en'] : ['en', 'he'];
      let chosen: { f: string; lang: 'he' | 'en' } | null = null;
      for (const f of formats) {
        if (f === from) continue;
        const named = /MMM/.test(f);
        for (const lang of named ? langs : [langs[0]!]) {
          if (rows.every((k) => formatYmd(ymdOfSerial(dates[k]!), f, lang) === out.text[k]!.trim())) {
            chosen = { f, lang };
            break;
          }
        }
        if (chosen) break;
      }
      if (!chosen) continue;
      const { f, lang } = chosen;
      cands.push({
        body: { rel: 'dateFormat', in: [s], from, to: f },
        rank: RANK.dateFormat,
        test: (k) => {
          const d = dates[k]!;
          const eo = out.kind[k] === EMPTY;
          if (a.kind[k] === EMPTY) return eo ? 1 : 0;
          if (eo || Number.isNaN(d)) return 0;
          return formatYmd(ymdOfSerial(d), f, lang) === out.text[k]!.trim() ? 1 : 0;
        },
      });
    }
  });
  return cands;
}

interface NumberRendering {
  prefix: string;
  suffix: string;
  grouping: boolean;
  decimals: number;
  percent: boolean;
}

const RENDER_RE = /^(-?)([₪$€]\s?)?(-?)([\d,]*\d)(?:\.(\d+))?(%)?(\s?(?:[₪$€]|ש"ח|NIS))?$/;

function readRendering(o: string): NumberRendering | null {
  const m = RENDER_RE.exec(o.trim());
  if (!m) return null;
  return {
    prefix: m[2] ?? '',
    suffix: m[7] ?? '',
    grouping: (m[4] ?? '').includes(','),
    decimals: (m[5] ?? '').length,
    percent: m[6] === '%',
  };
}

function renderNumber(d: Decimal, r: NumberRendering): string {
  let x = r.percent ? d.times(100) : d;
  x = x.toDecimalPlaces(r.decimals, Decimal.ROUND_HALF_UP);
  let s = x.abs().toFixed(r.decimals);
  if (r.grouping) {
    const [intPart, frac] = s.split('.') as [string, string | undefined];
    const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    s = frac === undefined ? grouped : `${grouped}.${frac}`;
  }
  const neg = x.isNegative() && !x.isZero() ? '-' : '';
  return `${neg}${r.prefix}${s}${r.percent ? '%' : ''}${r.suffix}`;
}

function renderingFormat(r: NumberRendering): string {
  const core = `${r.grouping ? '#,##0' : '0'}${r.decimals > 0 ? `.${'0'.repeat(r.decimals)}` : ''}${r.percent ? '%' : ''}`;
  const lit = (t: string): string => (t === '' ? '' : `"${t}"`);
  return `${lit(r.prefix)}${core}${lit(r.suffix)}`;
}

function numberFormatCands(env: RelationEnv, out: ColumnData): Cand[] {
  if (kindShare(out, TEXT) < 0.5) return [];
  const cands: Cand[] = [];
  env.src.forEach((a, s) => {
    if (numericShare(a) < 0.9) return;
    const counts = new Map<string, number>();
    const renderings = new Map<string, NumberRendering>();
    for (const k of bothRows(env, a, out, 50)) {
      const o = out.text[k]!.trim();
      if (a.numKey[k] === null || o === a.numKey[k]) continue;
      const r = readRendering(o);
      if (r === null) continue;
      const d = decOf(a, k)!;
      if (renderNumber(d, r) !== o) continue;
      const f = renderingFormat(r);
      bump(counts, f);
      renderings.set(f, r);
    }
    const best = mode(counts);
    if (best === null) return;
    const r = renderings.get(best)!;
    cands.push({
      body: { rel: 'numberFormat', in: [s], format: best },
      rank: RANK.numberFormat,
      test: (k) => {
        const ea = a.kind[k] === EMPTY;
        const eo = out.kind[k] === EMPTY;
        if (ea || eo) return ea && eo ? 1 : 0;
        const d = decOf(a, k);
        return d !== null && renderNumber(d, r) === out.text[k]!.trim() ? 1 : 0;
      },
    });
  });
  return cands;
}

// ---------- stage 3: numbers ----------

interface NumCtx {
  out: ColumnData;
  kOut: number;
  tolAbs: number;
}

/** Float check of a predicted value (NaN = the engine's empty result) against the output. */
function matchF(ctx: NumCtx, k: number, p: number): boolean {
  const out = ctx.out;
  if (Number.isNaN(p)) return out.kind[k] === EMPTY;
  if (out.kind[k] === EMPTY) return false;
  const o = out.num[k]!;
  if (Number.isNaN(o) || !Number.isFinite(p)) return false;
  return Math.abs(p - o) <= ctx.tolAbs + 1e-9 * Math.max(1, Math.abs(o));
}

/** Exact check: 1 = equal (to 15 significant digits), 2 = equal after rounding to the output's decimals. */
function matchD(ctx: NumCtx, k: number, p: Decimal | null): number {
  const out = ctx.out;
  if (p === null) return out.kind[k] === EMPTY ? 1 : 0;
  if (out.kind[k] === EMPTY) return 0;
  const o = decOf(out, k);
  if (o === null) return 0;
  if (p.toSignificantDigits(15).eq(o)) return 1;
  return p.toDecimalPlaces(ctx.kOut, Decimal.ROUND_HALF_UP).eq(o) ? 2 : 0;
}

/** Operand as float: undefined = empty, NaN = not a number. */
function fOp(a: ColumnData, k: number): number | undefined {
  return a.kind[k] === EMPTY ? undefined : a.kind[k] === DATE ? NaN : a.num[k]!;
}

/** Operand as Decimal: undefined = empty, null = not a number. */
function dOp(a: ColumnData, k: number): Decimal | null | undefined {
  return a.kind[k] === EMPTY ? undefined : a.kind[k] === DATE ? null : decOf(a, k);
}

type BinOp = 'add' | 'sub' | 'mul' | 'div';

function binF(op: BinOp, x: number | undefined, y: number | undefined): number {
  if (x === undefined && y === undefined) return NaN;
  const a = x ?? 0;
  const b = y ?? 0;
  switch (op) {
    case 'add':
      return a + b;
    case 'sub':
      return a - b;
    case 'mul':
      return a * b;
    case 'div':
      return b === 0 ? NaN : a / b;
  }
}

function binD(op: BinOp, x: Decimal | undefined, y: Decimal | undefined): Decimal | null {
  if (x === undefined && y === undefined) return null;
  const a = x ?? ZERO;
  const b = y ?? ZERO;
  switch (op) {
    case 'add':
      return a.plus(b);
    case 'sub':
      return a.minus(b);
    case 'mul':
      return a.times(b);
    case 'div':
      return b.isZero() ? null : a.div(b);
  }
}

const ZERO = new Decimal(0);

function numericCands(env: RelationEnv, out: ColumnData): Cand[] {
  if (nonEmptyCount(out) === 0 || numericShare(out) < 0.9 || kindShare(out, DATE) > 0) return [];
  let kOut = 0;
  for (let k = 0; k < out.n; k++) {
    const nk = out.numKey[k];
    if (nk !== null && nk !== undefined) kOut = Math.max(kOut, decimalsOf(nk));
  }
  kOut = Math.min(kOut, 10);
  const ctx: NumCtx = { out, kOut, tolAbs: 0.5 * 10 ** -kOut };
  const nums: number[] = [];
  env.src.forEach((a, s) => {
    if (nonEmptyCount(a) > 0 && kindShare(a, DATE) === 0 && numericShare(a) >= 0.9) nums.push(s);
  });
  const cands: Cand[] = [];
  const need = (env.minCoverage - SLACK) * env.sample.length;
  /** Sample rows where pre holds; -1 as soon as `need` can't be reached. */
  const sampleHits = (pre: (k: number) => boolean): number => {
    let n = 0;
    let left = env.sample.length;
    for (const k of env.sample) {
      left--;
      if (pre(k)) n++;
      else if (n + left < need) return -1;
    }
    return n;
  };

  /** The candidate "output = input * constant" or "input + constant" for source column `s`. */
  const constCand = (a: ColumnData, s: number, rel: 'mulConst' | 'addConst', constText: string): Cand => {
    const c = Number(constText);
    const cd = new Decimal(constText);
    return {
      body: { rel, in: [s], const: c, constText },
      rank: RANK[rel],
      round: kOut,
      pre: (k) => {
        const x = fOp(a, k);
        if (x === undefined) return matchF(ctx, k, NaN);
        if (Number.isNaN(x)) return false;
        return matchF(ctx, k, rel === 'mulConst' ? x * c : x + c);
      },
      test: (k) => {
        const x = dOp(a, k);
        if (x === undefined) return matchD(ctx, k, null);
        if (x === null) return 0;
        return matchD(ctx, k, rel === 'mulConst' ? x.times(cd) : x.plus(cd));
      },
    };
  };

  for (const s of nums) {
    const a = env.src[s]!;
    // Rows with the largest |input| give the most precise ratio / difference.
    const top: number[] = [];
    for (const k of env.sample) {
      const x = fOp(a, k);
      if (x === undefined || Number.isNaN(x) || x === 0 || Number.isNaN(out.num[k]!) || out.kind[k] === EMPTY) continue;
      top.push(k);
      top.sort((p, q) => Math.abs(a.num[q]!) - Math.abs(a.num[p]!));
      if (top.length > 3) top.pop();
    }
    const mulConsts = new Set<string>();
    const divConsts = new Set<string>();
    const addConsts = new Set<string>();
    for (const k of top) {
      const x = a.num[k]!;
      const o = out.num[k]!;
      const r = o / x;
      const d = o - x;
      for (let dp = 0; dp <= 8; dp++) {
        const c = Number(r.toFixed(dp));
        if (c !== 0 && Number.isFinite(c)) mulConsts.add(canonNum(c));
      }
      if (Number.isFinite(r) && r !== 0) mulConsts.add(canonNum(r));
      // The same factor read the other way round: the output is the input DIVIDED by a constant (x / 1.17), which is
      // an exact, round number where the factor (0.854701...) is not.
      const q = x / o;
      for (let dp = 0; dp <= 8; dp++) {
        const c = Number(q.toFixed(dp));
        if (c !== 0 && Number.isFinite(c)) divConsts.add(canonNum(c));
      }
      if (Number.isFinite(q) && q !== 0) divConsts.add(canonNum(q));
      for (let dp = 0; dp <= kOut + 2; dp++) {
        const c = Number(d.toFixed(dp));
        if (c !== 0 && Number.isFinite(c)) addConsts.add(canonNum(c));
      }
    }
    /** The constant (of a set) that fits the most sample rows, the shortest among equals; null when none reaches `need`. */
    const bestConst = (consts: Set<string>, apply: (x: number, c: number) => number): { text: string; hits: number } | null => {
      let best: { text: string; hits: number } | null = null;
      for (const text of consts) {
        const c = Number(text);
        const pre = (k: number): boolean => {
          const x = fOp(a, k);
          if (x === undefined) return matchF(ctx, k, NaN);
          if (Number.isNaN(x)) return false;
          return matchF(ctx, k, apply(x, c));
        };
        const hits = sampleHits(pre);
        if (hits >= need && (best === null || hits > best.hits || (hits === best.hits && text.length < best.text.length))) best = { text, hits };
      }
      return best;
    };
    const mulBest = bestConst(mulConsts, (x, c) => x * c);
    const divBest = bestConst(divConsts, (x, c) => x / c);
    const addBest = bestConst(addConsts, (x, c) => x + c);

    // A factor and a divisor that both fit are the same rule written two ways (x * 0.854701 and x / 1.17): the one with
    // the roundest constant (fewest significant digits) is the real one. A tie keeps the factor, and a divisor that
    // fits fewer rows than the factor is a different rule, not a rounder way to say it.
    if (divBest !== null && (mulBest === null || (divBest.hits >= mulBest.hits && significantDigits(divBest.text) < significantDigits(mulBest.text)))) {
      const divisorText = divBest.text;
      const d = Number(divisorText);
      const dd = new Decimal(divisorText);
      const factor = new Decimal(1).div(dd).toSignificantDigits(15);
      cands.push({
        body: { rel: 'mulConst', in: [s], const: factor.toNumber(), constText: factor.toString(), divisor: d, divisorText },
        rank: RANK.mulConst,
        round: kOut,
        pre: (k) => {
          const x = fOp(a, k);
          if (x === undefined) return matchF(ctx, k, NaN);
          if (Number.isNaN(x)) return false;
          return matchF(ctx, k, x / d);
        },
        test: (k) => {
          const x = dOp(a, k);
          if (x === undefined) return matchD(ctx, k, null);
          if (x === null) return 0;
          return matchD(ctx, k, x.div(dd));
        },
      });
    } else if (mulBest !== null) {
      cands.push(constCand(a, s, 'mulConst', mulBest.text));
    }
    if (addBest !== null) cands.push(constCand(a, s, 'addConst', addBest.text));
  }

  // Two columns.
  const ops: BinOp[] = ['add', 'sub', 'mul', 'div'];
  for (const s1 of nums) {
    for (const s2 of nums) {
      if (s1 === s2) continue;
      const a = env.src[s1]!;
      const b = env.src[s2]!;
      for (const op of ops) {
        if ((op === 'add' || op === 'mul') && s1 > s2) continue;
        const pre = (k: number): boolean => {
          const x = fOp(a, k);
          const y = fOp(b, k);
          if ((x !== undefined && Number.isNaN(x)) || (y !== undefined && Number.isNaN(y))) return false;
          return matchF(ctx, k, binF(op, x, y));
        };
        // Early-exit sample pass.
        const allowed = Math.floor(env.sample.length * (1 - (env.minCoverage - SLACK)));
        let fails = 0;
        let ok = true;
        for (const k of env.sample) {
          if (!pre(k) && ++fails > allowed) {
            ok = false;
            break;
          }
        }
        if (!ok) continue;
        cands.push({
          body: { rel: op, in: [s1, s2] },
          rank: RANK[op],
          round: kOut,
          pre,
          test: (k) => {
            const x = dOp(a, k);
            const y = dOp(b, k);
            if (x === null || y === null) return 0;
            return matchD(ctx, k, binD(op, x, y));
          },
        });
      }
    }
  }

  // Sum of 3+ columns: subset sums on a few rows, then the sample.
  const pool = nums.slice(0, 16);
  if (pool.length >= 3) {
    const probe: number[] = [];
    for (const k of env.sample) {
      if (out.kind[k] !== EMPTY && !Number.isNaN(out.num[k]!)) probe.push(k);
      if (probe.length >= 3) break;
    }
    if (probe.length > 0) {
      const n = pool.length;
      const size = 1 << n;
      let alive = new Uint8Array(size).fill(1);
      for (const k of probe) {
        const vals = pool.map((s) => {
          const x = fOp(env.src[s]!, k);
          return x === undefined ? 0 : x;
        });
        const sums = new Float64Array(size);
        const next = new Uint8Array(size);
        for (let m = 1; m < size; m++) {
          const low = m & -m;
          const bit = 31 - Math.clz32(low);
          sums[m] = sums[m ^ low]! + vals[bit]!;
          next[m] = alive[m]! && !Number.isNaN(sums[m]!) && matchF(ctx, k, sums[m]!) ? 1 : 0;
        }
        alive = next;
      }
      const masks: number[] = [];
      for (let m = 1; m < size; m++) {
        let bits = 0;
        for (let x = m; x; x &= x - 1) bits++;
        if (bits >= 3 && alive[m]) masks.push(m);
      }
      masks.sort((p, q) => {
        let bp = 0;
        let bq = 0;
        for (let x = p; x; x &= x - 1) bp++;
        for (let x = q; x; x &= x - 1) bq++;
        return bp - bq || p - q;
      });
      for (const m of masks.slice(0, 5)) {
        const cols = pool.filter((_, i) => (m >> i) & 1);
        const srcCols = cols.map((s) => env.src[s]!);
        const pre = (k: number): boolean => {
          let sum = 0;
          let any = false;
          for (const c of srcCols) {
            const x = fOp(c, k);
            if (x === undefined) continue;
            if (Number.isNaN(x)) return false;
            any = true;
            sum += x;
          }
          return matchF(ctx, k, any ? sum : NaN);
        };
        if (sampleHits(pre) < need) continue;
        cands.push({
          body: { rel: 'sum', in: cols },
          rank: RANK.sum,
          round: kOut,
          pre,
          test: (k) => {
            let sum: Decimal | null = null;
            for (const c of srcCols) {
              const x = dOp(c, k);
              if (x === undefined) continue;
              if (x === null) return 0;
              sum = sum === null ? x : sum.plus(x);
            }
            return matchD(ctx, k, sum);
          },
        });
      }
    }
  }
  return cands;
}

// ---------- stage 4: value maps ----------

const MAX_MAP_VALUES = 50;

function valueMapCands(env: RelationEnv, out: ColumnData): Cand[] {
  const outDistinct = new Set<string>();
  for (let k = 0; k < out.n; k++) if (out.kind[k] !== EMPTY) outDistinct.add(out.text[k]!);
  if (outDistinct.size < 2) return [];
  const cands: Cand[] = [];
  env.src.forEach((a, s) => {
    const ks = keys(a);
    const table = new Map<string, Map<string, number>>();
    const display = new Map<string, string>();
    for (let k = 0; k < a.n; k++) {
      const key = ks[k] ?? '';
      let m = table.get(key);
      if (!m) {
        if (table.size >= MAX_MAP_VALUES) return;
        m = new Map();
        table.set(key, m);
        display.set(key, a.kind[k] === EMPTY ? '' : a.text[k]!);
      }
      bump(m, out.kind[k] === EMPTY ? '' : out.text[k]!);
    }
    if (table.size >= a.n || table.size < 2) return;
    // DECISION: a value map is evidence only when its keys repeat — rows whose key was already
    // seen confirm the mapping. With (almost) one row per key, any column "maps" onto any other
    // (e.g. 19 dates → 19 warehouses assigned by another system): that is memorizing, not a rule,
    // and must stay `unknown` so pre-flight can report it. Require on average ≥ 1.5 rows per key.
    const confirmingRows = a.n - table.size;
    if (confirmingRows < Math.max(2, Math.ceil(table.size / 2))) return;
    const map = new Map<string, string>();
    let identity = true;
    // DECISION (found by the engine stress test, eval/STRESS.md): the repeats must confirm at least two of the values the map
    // writes. When only one value's keys repeat ("Low" on 28 rows) and every other value is written once ("High" on two
    // names seen once), the map is "mostly Low" with the exceptions memorized - any column with repeating names "maps" so.
    const confirmedValues = new Set<string>();
    for (const [key, m] of table) {
      const to = mode(m)!;
      map.set(key, to);
      if ((m.get(to) ?? 0) >= 2) confirmedValues.add(to);
      if (normFast(display.get(key)!).toLowerCase() !== normFast(to).toLowerCase()) identity = false;
    }
    if (identity || confirmedValues.size < 2) return;
    const pairs: [string, string][] = [...map.entries()]
      .map(([key, to]) => [display.get(key)!, to] as [string, string])
      .sort((p, q) => (p[0] < q[0] ? -1 : p[0] > q[0] ? 1 : 0));
    cands.push({
      body: { rel: 'valueMap', in: [s], pairs },
      rank: RANK.valueMap,
      test: (k) => ((out.kind[k] === EMPTY ? '' : out.text[k]!) === map.get(ks[k] ?? '') ? 1 : 0),
    });
  });
  return cands;
}

// ---------- entry points ----------

function relationKey(r: RelationBody): string {
  const { rel, in: ins, ...rest } = r as RelationBody & Record<string, unknown>;
  return `${rel}|${ins.join(',')}|${JSON.stringify(rest)}`;
}

/** The rank a relation kind has in the best-first order (lower is simpler): what a newly found relation has to beat. */
export function relationRank(rel: RelationBody['rel']): number {
  return RANK[rel];
}

export function sortRelations(rels: Relation[]): Relation[] {
  const rank = (r: Relation): number =>
    RANK[r.rel] + (r.rel === 'concat' && r.skipEmpty ? 0.5 : 0) + ('round' in r && r.round !== undefined ? 0.25 : 0);
  return rels.sort(
    (a, b) =>
      b.coverage - a.coverage ||
      rank(a) - rank(b) ||
      a.in.length - b.in.length ||
      (a.in[0] ?? -1) - (b.in[0] ?? -1),
  );
}

/**
 * Every relation of one output column with coverage >= minCoverage, best
 * first. Stages run from simplest to most expensive and stop once a stage
 * explains the column on every row. `outFormat` is the output column's Excel
 * number format (used as the `to` of dates written as real dates).
 */
export function findRelations(env: RelationEnv, out: ColumnData, outIndex: number, outFormat?: string): Relation[] {
  return findRelationsGuarded(env, out, outIndex, outFormat).relations;
}

export interface GuardedRelations {
  relations: Relation[];
  /**
   * Set when every row holds the same value and the input can write that value too (`constantSources`: a copy, the month
   * or year of a date column, a fixed part of a text): no `constant` relation is reported for it, and the columns that can
   * write it are listed here. Such a column is never built as a constant: it is a question for the user (fastPath.ts `ambiguityOf`),
   * or, with no data reading to build, left to the AI step (`chooseColumnRelation`).
   */
  derivableConstant?: number[];
  /** With `derivableConstant`: the value every row holds (the constant the user may mean, readings.ts). */
  derivableValue?: PayloadCell;
}

/** `findRelations`, and what its constant guard found (see `GuardedRelations`). */
export function findRelationsGuarded(env: RelationEnv, out: ColumnData, outIndex: number, outFormat?: string): GuardedRelations {
  if (env.total === 0) return { relations: [] };
  if (nonEmptyCount(out) === 0) {
    return { relations: [{ rel: 'constant', in: [], value: null, out: outIndex, coverage: 1, matched: env.total, total: env.total, failing: [], failCount: 0 }] };
  }
  const guard: ConstantGuard = {};
  // Stages run from simplest to most expensive; each one is skipped once an earlier stage explained the column on every row.
  const stages: (() => Cand[])[] = [
    () => stage1(env, out, guard),
    () => [
      ...padCands(env, out),
      ...substrCands(env, out),
      ...splitCands(env, out),
      ...concatCands(env, out),
      ...dateCands(env, out, outFormat),
      ...numberFormatCands(env, out),
    ],
  ];
  const later: (() => Cand[])[] = [() => numericCands(env, out), () => valueMapCands(env, out)];
  const found: Relation[] = [];
  const seen = new Set<string>();
  const explained = (): boolean => found.some((r) => r.coverage === 1);
  const run = (stage: () => Cand[]): void => {
    for (const cand of stage()) {
      const key = relationKey(cand.body);
      if (seen.has(key)) continue;
      seen.add(key);
      if (!passesSample(env, cand)) continue;
      const rel = evaluate(env, out, outIndex, cand);
      if (rel === null) continue;
      if (rel.rel === 'normalize') {
        const c = normalizeCase(env.src[rel.in[0]]!, out, env.total);
        if (c !== undefined) rel.case = c;
      }
      found.push(rel);
    }
  };
  for (const stage of stages) {
    run(stage);
    if (explained()) break;
  }
  // Fixed text around input values: only when nothing simpler explained the column (limits.learn.template).
  if (!explained()) {
    const template = templateRelation(env, out, outIndex);
    if (template !== null) found.push(template);
  }
  for (const stage of later) {
    if (explained()) break;
    run(stage);
  }
  // A concat found both with and without skipEmpty: keep the better one.
  const out1 = sortRelations(found).filter((r, i, all) => {
    if (r.rel !== 'concat') return true;
    return !all.slice(0, i).some((q) => q.rel === 'concat' && q.in.join(',') === r.in.join(',') && q.separator === r.separator);
  });
  const result: GuardedRelations = { relations: out1.slice(0, MAX_RELATIONS) };
  if (guard.sources !== undefined) {
    result.derivableConstant = guard.sources;
    if (guard.value !== undefined) result.derivableValue = guard.value;
  }
  return result;
}

// ---------- summary shapes: aggregates per group ----------

const AGG_ORDER: SummaryAgg[] = ['sum', 'count', 'average', 'min', 'max', 'first', 'last'];

/** Float aggregate of a column over rows: NaN when not numeric, undefined when no value. */
function aggF(col: ColumnData, rows: number[], fn: SummaryAgg): number | undefined {
  let sum = 0;
  let cnt = 0;
  let ne = 0;
  let pick: number | undefined;
  for (const r of rows) {
    if (col.kind[r] === EMPTY) continue;
    ne++;
    const v = col.kind[r] === DATE ? col.date[r]! : col.num[r]!;
    if (Number.isNaN(v)) {
      if (fn === 'sum' || fn === 'average' || fn === 'min' || fn === 'max') return NaN;
      if (fn === 'first' && pick === undefined) return NaN;
      if (fn === 'last') pick = NaN;
      continue;
    }
    cnt++;
    sum += v;
    if (fn === 'first' && pick === undefined) pick = v;
    else if (fn === 'last') pick = v;
    else if (fn === 'min' && (pick === undefined || v < pick)) pick = v;
    else if (fn === 'max' && (pick === undefined || v > pick)) pick = v;
  }
  if (fn === 'count') return ne;
  if (fn === 'sum') return cnt > 0 ? sum : undefined;
  if (fn === 'average') return cnt > 0 ? sum / cnt : undefined;
  return pick;
}

/** Exact aggregate check of one group against one output cell (1 = holds). */
export function aggHolds(col: ColumnData, rows: number[], fn: SummaryAgg, out: ColumnData, j: number): boolean {
  const oEmpty = out.kind[j] === EMPTY;
  if (fn === 'first' || fn === 'last' || ((fn === 'min' || fn === 'max') && kindShare(out, DATE) > 0)) {
    // Typed pick: compare as values.
    let pick = -1;
    for (const r of rows) {
      if (col.kind[r] === EMPTY) continue;
      if (fn === 'first') {
        pick = r;
        break;
      }
      if (fn === 'last') pick = r;
      else {
        const v = col.date[r]!;
        if (Number.isNaN(v)) return false;
        if (pick < 0 || (fn === 'min' ? v < col.date[pick]! : v > col.date[pick]!)) pick = r;
      }
    }
    if (pick < 0) return oEmpty;
    return eqTyped(col, out, pick, j) || (col.numKey[pick] !== null && col.numKey[pick] === out.numKey[j]);
  }
  if (fn === 'count') {
    let ne = 0;
    for (const r of rows) if (col.kind[r] !== EMPTY) ne++;
    return out.numKey[j] === String(ne);
  }
  let sum = ZERO;
  let cnt = 0;
  let pick: Decimal | null = null;
  for (const r of rows) {
    if (col.kind[r] === EMPTY) continue;
    const d = col.kind[r] === DATE ? null : decOf(col, r);
    if (d === null) return false;
    cnt++;
    if (fn === 'sum' || fn === 'average') sum = sum.plus(d);
    else if (pick === null || (fn === 'min' ? d.lt(pick) : d.gt(pick))) pick = d;
  }
  if (cnt === 0) return oEmpty || out.numKey[j] === '0';
  const o = decOf(out, j);
  if (o === null) return false;
  const v = fn === 'sum' ? sum : fn === 'average' ? sum.div(cnt) : pick!;
  if (v.toSignificantDigits(15).eq(o)) return true;
  // Averages are often shown rounded.
  return fn === 'average' && o.decimalPlaces() >= 1 && v.toDecimalPlaces(o.decimalPlaces(), Decimal.ROUND_HALF_UP).eq(o);
}

/**
 * Relations of a summary output's column: the group column is a copy, every
 * other column is an aggregate of an input column over each group (verified
 * on every group), or a constant.
 */
export function summaryRelations(
  inCols: ColumnData[],
  out: ColumnData,
  outIndex: number,
  groups: number[][],
  groupIn: number,
  isGroupOut: boolean,
  minCoverage: number,
): Relation[] {
  const total = groups.length;
  if (total === 0) return [];
  if (nonEmptyCount(out) === 0) {
    return [{ rel: 'constant', in: [], value: null, out: outIndex, coverage: 1, matched: total, total, failing: [], failCount: 0 }];
  }
  const found: Relation[] = [];
  const make = (body: RelationBody, holds: (j: number) => boolean): void => {
    let matched = 0;
    const failing: number[] = [];
    const maxFails = total - Math.ceil(minCoverage * total - 1e-9);
    for (let j = 0; j < total; j++) {
      if (holds(j)) matched++;
      else {
        if (failing.length < MAX_FAILING) failing.push(j);
        if (j + 1 - matched > maxFails) return;
      }
    }
    if (matched / total < minCoverage) return;
    found.push({ ...body, out: outIndex, coverage: matched / total, matched, total, failing, failCount: total - matched } as Relation);
  };
  if (isGroupOut) {
    const g = inCols[groupIn]!;
    make({ rel: 'copy', in: [groupIn] }, (j) => keys(g)[groups[j]![0]!] === keys(out)[j]);
  }
  const counts = new Map<string, number>();
  for (let j = 0; j < total; j++) if (out.kind[j] !== EMPTY) bump(counts, out.text[j]!);
  const top = mode(counts);
  if (top !== null && counts.get(top)! / total >= minCoverage && counts.size === 1) {
    let firstRow = 0;
    while (out.text[firstRow] !== top) firstRow++;
    make({ rel: 'constant', in: [], value: payloadCell(out, firstRow) }, (j) => out.text[j] === top);
  }
  const outNumeric = numericShare(out) >= 0.9;
  inCols.forEach((col, i) => {
    for (const fn of AGG_ORDER) {
      if (!outNumeric && fn !== 'first' && fn !== 'last' && !((fn === 'min' || fn === 'max') && kindShare(out, DATE) > 0)) continue;
      // Float pre-filter on every group (early exit), exact confirmation after.
      if (outNumeric && fn !== 'first' && fn !== 'last') {
        let fails = 0;
        const allowed = total - Math.ceil(minCoverage * total - 1e-9);
        let ok = true;
        for (let j = 0; j < total && ok; j++) {
          const v = aggF(col, groups[j]!, fn);
          const o = out.num[j]!;
          const hit =
            v === undefined
              ? out.kind[j] === EMPTY || o === 0
              : !Number.isNaN(v) && !Number.isNaN(o) && Math.abs(v - o) <= 0.5 * 10 ** -Math.min(10, decimalsOf(out.numKey[j] ?? '0')) + 1e-9 * Math.max(1, Math.abs(o));
          if (!hit && ++fails > allowed) ok = false;
        }
        if (!ok) continue;
      }
      make({ rel: 'aggregate', in: [i], fn }, (j) => aggHolds(col, groups[j]!, fn, out, j));
    }
  });
  return sortRelations(found).slice(0, MAX_RELATIONS);
}
