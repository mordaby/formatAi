// Across-row ("window") patterns (docs/proposals/window-operations.md, SPEC 6.2 step 4): an output column that is not a function of its own
// input row but of the rows around it - a group's total shown on every row, how many rows share the customer, a running total, the
// previous row's value, a rank, a row number. Found by testing a few definitions on ALL aligned rows with exact decimal arithmetic,
// over the rows in the INPUT's order (what the engine will run), never on a sample.
//
// Only the ORDER-INDEPENDENT patterns are ever built by the free engine: `groupSum(x, by: g)` and `groupCount(by: g)` give the same value
// whatever order the rows come in. Everything else here (running sums, row numbers, previous / next, fill down, rank, a group's average,
// minimum, maximum) is found only to be a hint for the AI step, which is sent once learn-v7 documents window functions
// (`limits.learn.window.hintsEnabled`); the output order may differ from the file order, and which one the example follows is itself a finding.
//
// Guards, so a simpler or different truth is not taken for a window: the pattern must hold on at least `limits.learn.window.minRows` aligned
// rows; a group total must differ from its own column somewhere (else it is a copy) and the groups must be 2+ with at least one of 2+ rows; the
// group column is never the alignment key and must be text, an id or an integer. Two columns (or two groups) that fit equally well are an
// ambiguity: both are reported, the free engine builds none, and the hint carries the other as `alt`.

import Decimal from 'decimal.js';
import { limits, type ProfileType, type WindowFn } from '@formatai/shared';
import { DATE, EMPTY, TEXT, decOf, decimalsOf, keys, nonEmptyCount, normFast, numericShare, type ColumnData } from './cells';
import { MAX_FAILING } from './relations';
import type { Relation, WindowFinding, WindowOrder } from './types';

/** Numeric input columns tried as the column a window reads. */
const MAX_X = limits.analysis.windows.maxValueColumns;
/** Group columns tried for the order-independent patterns (a group total, a count per group). */
const MAX_BY = limits.analysis.windows.maxGroupColumns;
/** Group columns tried for the order-dependent patterns, whose test is a pass over all rows each. */
const MAX_BY_ORDERED = limits.analysis.windows.maxOrderedGroupColumns;
/** Other readings kept in a finding's `alt`, and as relations (enough to see an ambiguity). */
const MAX_ALT = limits.analysis.windows.maxAlternatives;

const NUMERIC_TYPES: ReadonlySet<ProfileType> = new Set<ProfileType>(['integer', 'decimal', 'currency', 'percent']);
const GROUP_TYPES: ReadonlySet<ProfileType> = new Set<ProfileType>(['text', 'idLike', 'integer']);
const RANKABLE_TYPES: ReadonlySet<ProfileType> = new Set<ProfileType>(['integer', 'decimal', 'currency', 'percent', 'date']);
const POSITIVE_INTEGER = /^[1-9]\d{0,8}$/;

export interface WindowInputs {
  /** The input columns, gathered to the aligned rows (aligned order = output order). */
  src: readonly ColumnData[];
  /** The input row of each aligned row: the "file order" is the aligned rows sorted by it. */
  inIdx: ArrayLike<number>;
  profile: readonly { type: ProfileType }[];
  /** The alignment key's input columns: never a group column. */
  keyColumns: readonly number[];
  minCoverage: number;
}

/** The rows with one value of a group column. */
interface Groups {
  col: number;
  /** Group of each aligned row. */
  gid: Int32Array;
  /** Rows per group. */
  size: Int32Array;
  count: number;
}

interface Check {
  matched: number;
  failing: number[];
  failCount: number;
}

type Order = 'file' | 'output';

function groupKey(col: ColumnData, k: number): string {
  return col.kind[k] === EMPTY ? '' : col.kind[k] === TEXT ? normFast(col.text[k] as string) : (col.text[k] as string);
}

export class WindowDetector {
  private readonly K: number;
  private readonly minRows = limits.learn.window.minRows;
  /** Aligned rows in the input's row order. */
  private readonly fileOrder: number[];
  /** The input order is the order the output shows (the aligned rows are already in input order). */
  private readonly sameOrder: boolean;
  private readonly xCols: number[] = [];
  private readonly rankCols: number[] = [];
  private groupCache: Groups[] | undefined;
  private readonly keySets = new Map<number, Set<string>>();

  constructor(private readonly inp: WindowInputs) {
    this.K = inp.src[0]?.n ?? 0;
    this.fileOrder = Array.from({ length: this.K }, (_, k) => k).sort((a, b) => (inp.inIdx[a] as number) - (inp.inIdx[b] as number) || a - b);
    this.sameOrder = this.fileOrder.every((k, i) => k === i);
    inp.src.forEach((col, i) => {
      const t = inp.profile[i]?.type;
      if (t === undefined || nonEmptyCount(col) < this.minRows) return;
      if (NUMERIC_TYPES.has(t) && this.xCols.length < MAX_X) this.xCols.push(i);
      if (RANKABLE_TYPES.has(t) && this.rankCols.length < MAX_X) this.rankCols.push(i);
    });
  }

  // ---------- candidate group columns and the order rows are walked in ----------

  private groups(): Groups[] {
    if (this.groupCache !== undefined) return this.groupCache;
    const found: Groups[] = [];
    const K = this.K;
    this.inp.src.forEach((col, i) => {
      const t = this.inp.profile[i]?.type;
      if (found.length >= MAX_BY || t === undefined || !GROUP_TYPES.has(t) || this.inp.keyColumns.includes(i)) return;
      const ids = new Map<string, number>();
      const gid = new Int32Array(K);
      const sizes: number[] = [];
      for (let k = 0; k < K; k++) {
        const kk = groupKey(col, k);
        let g = ids.get(kk);
        if (g === undefined) {
          g = sizes.length;
          ids.set(kk, g);
          sizes.push(0);
        }
        gid[k] = g;
        sizes[g] = (sizes[g] as number) + 1;
      }
      // 2+ groups, and some value repeated: otherwise the "group" is one row or the whole table.
      if (sizes.length >= 2 && sizes.length < K) found.push({ col: i, gid, size: Int32Array.from(sizes), count: sizes.length });
    });
    this.groupCache = found;
    return found;
  }

  private groupsForOrder(): (Groups | null)[] {
    return [null, ...this.groups().slice(0, MAX_BY_ORDERED)];
  }

  private orders(): Order[] {
    return this.sameOrder ? ['file'] : ['file', 'output'];
  }

  /** The aligned rows of each group (`null` = one group of all rows), each walked in the input's order or in the output's. */
  private sequences(by: Groups | null, order: Order): number[][] {
    const walk = order === 'file' ? this.fileOrder : Array.from({ length: this.K }, (_, k) => k);
    if (by === null) return [walk];
    const lists: number[][] = Array.from({ length: by.count }, () => []);
    for (const k of walk) (lists[by.gid[k] as number] as number[]).push(k);
    return lists;
  }

  // ---------- checking expected values against the output ----------

  private get maxFails(): number {
    return this.K - Math.ceil(this.inp.minCoverage * this.K - 1e-9);
  }

  /** Runs `holds` on every aligned row; null as soon as the minimum coverage cannot be reached any more. */
  private scan(holds: (k: number) => boolean, keepFailing = true): Check | null {
    const failing: number[] = [];
    let fails = 0;
    for (let k = 0; k < this.K; k++) {
      if (holds(k)) continue;
      if (++fails > this.maxFails) return null;
      if (keepFailing && failing.length < MAX_FAILING) failing.push(k);
    }
    return { matched: this.K - fails, failing, failCount: fails };
  }

  /** The output cell is `exp` (to the 15 significant digits a cell keeps); empty when `exp` is null. */
  private exactHolds(out: ColumnData, k: number, exp: Decimal | null): boolean {
    if (exp === null) return out.kind[k] === EMPTY;
    const o = decOf(out, k);
    return o !== null && exp.toSignificantDigits(15).eq(o);
  }

  /** A float look at a cell against a float expectation (NaN = empty): a cheap necessary condition before the exact test. */
  private closeHolds(out: ColumnData, k: number, exp: number): boolean {
    if (Number.isNaN(exp)) return out.kind[k] === EMPTY;
    const o = out.num[k] as number;
    if (Number.isNaN(o)) return false;
    return Math.abs(exp - o) <= 0.5 * 10 ** -Math.min(10, decimalsOf(out.numKey[k] ?? '0')) + 1e-9 * Math.max(1, Math.abs(o));
  }

  /** The output is not simply a copy of `x`. */
  private differsFrom(out: ColumnData, x: ColumnData): boolean {
    for (let k = 0; k < this.K; k++) if (out.numKey[k] !== x.numKey[k]) return true;
    return false;
  }

  private finding(out: number, fn: WindowFn, parts: Partial<Pick<WindowFinding, 'in' | 'order' | 'ties'>> & { by?: Groups | null }, check: Check): WindowFinding {
    const f: WindowFinding = {
      out,
      fn,
      in: parts.in ?? [],
      by: parts.by == null ? [] : [parts.by.col],
      order: parts.order ?? 'file',
      coverage: check.matched / this.K,
      matched: check.matched,
      total: this.K,
      failing: check.failing,
      failCount: check.failCount,
      built: false,
    };
    if (parts.ties !== undefined) f.ties = parts.ties;
    return f;
  }

  // ---------- group patterns: order-independent ----------

  /** The output's cell is the same on every row of a group (on at least the minimum share of rows): a necessary condition of any group pattern. */
  private constantWithinGroups(out: ColumnData, g: Groups): boolean {
    const ok = keys(out);
    const first = new Array<string | null | undefined>(g.count).fill(undefined);
    let fails = 0;
    for (let k = 0; k < this.K; k++) {
      const gi = g.gid[k] as number;
      const v = ok[k] ?? null;
      if (first[gi] === undefined) first[gi] = v;
      else if (first[gi] !== v && ++fails > this.maxFails) return false;
    }
    return true;
  }

  /** Per group: float sum, how many numbers, smallest and largest (and the rows that hold them), of column `x`. */
  private groupStats(x: number, g: Groups): { sum: Float64Array; n: Int32Array; min: Float64Array; max: Float64Array; minRow: Int32Array; maxRow: Int32Array } {
    const col = this.inp.src[x] as ColumnData;
    const sum = new Float64Array(g.count);
    const n = new Int32Array(g.count);
    const min = new Float64Array(g.count).fill(NaN);
    const max = new Float64Array(g.count).fill(NaN);
    const minRow = new Int32Array(g.count).fill(-1);
    const maxRow = new Int32Array(g.count).fill(-1);
    for (let k = 0; k < this.K; k++) {
      const v = col.num[k] as number;
      if (Number.isNaN(v) || col.kind[k] === DATE) continue;
      const gi = g.gid[k] as number;
      sum[gi] = (sum[gi] as number) + v;
      n[gi] = (n[gi] as number) + 1;
      if (Number.isNaN(min[gi] as number) || v < (min[gi] as number)) {
        min[gi] = v;
        minRow[gi] = k;
      }
      if (Number.isNaN(max[gi] as number) || v > (max[gi] as number)) {
        max[gi] = v;
        maxRow[gi] = k;
      }
    }
    return { sum, n, min, max, minRow, maxRow };
  }

  /** Exact (decimal.js) sums of column `x` per group, null for a group with no number; added in file order. */
  private exactGroupSums(x: number, g: Groups): (Decimal | null)[] {
    const col = this.inp.src[x] as ColumnData;
    const sums = new Array<Decimal | null>(g.count).fill(null);
    for (const k of this.fileOrder) {
      const d = col.kind[k] === DATE ? null : decOf(col, k);
      if (d === null) continue;
      const gi = g.gid[k] as number;
      const s = sums[gi] as Decimal | null;
      sums[gi] = s === null ? d : s.plus(d);
    }
    return sums;
  }

  /** `groupCount(by: g)`, and a group's total / average / minimum / maximum of one column on every row. */
  private groupFindings(out: ColumnData, o: number): WindowFinding[] {
    const found: WindowFinding[] = [];
    const countLike = this.countLike(out);
    for (const g of this.groups()) {
      if (!this.constantWithinGroups(out, g)) continue;
      if (countLike) {
        const count = this.scan((k) => out.numKey[k] === String(g.size[g.gid[k] as number]));
        if (count !== null) found.push(this.finding(o, 'groupCount', { by: g }, count));
      }
      for (const x of this.xCols) {
        const xc = this.inp.src[x] as ColumnData;
        if (!this.differsFrom(out, xc)) continue; // a copy of the column
        const st = this.groupStats(x, g);
        const gid = g.gid;
        const near = (f: (gi: number) => number): boolean => this.scan((k) => this.closeHolds(out, k, f(gid[k] as number)), false) !== null;
        const sumNear = near((gi) => ((st.n[gi] as number) > 0 ? (st.sum[gi] as number) : NaN));
        const avgNear = near((gi) => ((st.n[gi] as number) > 0 ? (st.sum[gi] as number) / (st.n[gi] as number) : NaN));
        if (sumNear || avgNear) {
          const sums = this.exactGroupSums(x, g);
          if (sumNear) {
            const exact = this.scan((k) => this.exactHolds(out, k, sums[gid[k] as number] as Decimal | null));
            if (exact !== null) found.push(this.finding(o, 'groupSum', { in: [x], by: g }, exact));
          }
          if (avgNear) {
            const exact = this.scan((k) => {
              const s = sums[gid[k] as number] as Decimal | null;
              return this.exactHolds(out, k, s === null ? null : s.dividedBy(st.n[gid[k] as number] as number));
            });
            if (exact !== null) found.push(this.finding(o, 'groupAvg', { in: [x], by: g }, exact));
          }
        }
        for (const fn of ['groupMin', 'groupMax'] as const) {
          const row = fn === 'groupMin' ? st.minRow : st.maxRow;
          const hit = this.scan((k) => {
            const r = row[gid[k] as number] as number;
            return r < 0 ? out.kind[k] === EMPTY : out.numKey[k] === xc.numKey[r];
          });
          if (hit !== null) found.push(this.finding(o, fn, { in: [x], by: g }, hit));
        }
      }
    }
    return found;
  }

  /** The cells are positive whole numbers no bigger than the number of rows: the only kind a count, a row number or a rank can be. */
  private countLike(out: ColumnData): boolean {
    let ne = 0;
    let ok = 0;
    for (let k = 0; k < this.K; k++) {
      if (out.kind[k] === EMPTY) continue;
      ne++;
      if ((out.num[k] as number) <= this.K && POSITIVE_INTEGER.test(out.numKey[k] ?? '')) ok++;
    }
    return ne > 0 && ok / ne >= this.inp.minCoverage;
  }

  // ---------- order-dependent patterns (hints only) ----------

  /** `rowNumber([by: g])` and `runningSum(x[, by: g])`: walked in the input's order, else (when the two differ) the output's. */
  private orderedFindings(out: ColumnData, o: number): WindowFinding[] {
    const found: WindowFinding[] = [];
    const countLike = this.countLike(out);
    for (const order of this.orders()) {
      let hit = false;
      for (const by of this.groupsForOrder()) {
        const seqs = this.sequences(by, order);
        if (countLike) {
          const rn = new Float64Array(this.K);
          for (const list of seqs) list.forEach((k, i) => (rn[k] = i + 1));
          const number = this.scan((k) => out.num[k] === rn[k]);
          if (number !== null) {
            found.push(this.finding(o, 'rowNumber', { by, order }, number));
            hit = true;
          }
        }
        for (const x of this.xCols) {
          const xc = this.inp.src[x] as ColumnData;
          const run = new Float64Array(this.K).fill(NaN);
          for (const list of seqs) {
            let acc = NaN;
            for (const k of list) {
              const v = xc.num[k] as number;
              if (!Number.isNaN(v) && xc.kind[k] !== DATE) acc = Number.isNaN(acc) ? v : acc + v;
              run[k] = acc;
            }
          }
          if (this.scan((k) => this.closeHolds(out, k, run[k] as number), false) === null || !this.differsFrom(out, xc)) continue;
          const exact = new Array<Decimal | null>(this.K).fill(null);
          for (const list of seqs) {
            let acc: Decimal | null = null;
            for (const k of list) {
              const d = xc.kind[k] === DATE ? null : decOf(xc, k);
              if (d !== null) acc = acc === null ? d : acc.plus(d);
              exact[k] = acc;
            }
          }
          const check = this.scan((k) => this.exactHolds(out, k, exact[k] as Decimal | null));
          if (check !== null) {
            found.push(this.finding(o, 'runningSum', { in: [x], by, order }, check));
            hit = true;
          }
        }
      }
      // The output-order reading is worth reporting only when the input order does not explain the column.
      if (hit) break;
    }
    return found;
  }

  /** The distinct matching keys of input column `x`, for a quick "could the output's values come from it" look. */
  private keySet(x: number): Set<string> {
    let s = this.keySets.get(x);
    if (s === undefined) {
      s = new Set<string>();
      for (const k of keys(this.inp.src[x] as ColumnData)) if (k !== null) s.add(k);
      this.keySets.set(x, s);
    }
    return s;
  }

  /** `previous(x)`, `next(x)`, `fillDown(x)` of any column: the value of a neighbouring row, compared as typed values. */
  private neighbourFindings(out: ColumnData, o: number): WindowFinding[] {
    const found: WindowFinding[] = [];
    const ok = keys(out);
    const outKeys = ok.filter((v): v is string => v !== null);
    for (const order of this.orders()) {
      let hit = false;
      for (let x = 0; x < this.inp.src.length; x++) {
        const xc = this.inp.src[x] as ColumnData;
        // A fill-down column may hold only a few values (a category written once per block): two are enough to tell it from a constant.
        if (nonEmptyCount(xc) < 2) continue;
        // The output's values must come from the column at all.
        const set = this.keySet(x);
        const contained = outKeys.filter((v) => set.has(v)).length;
        if (contained < this.inp.minCoverage * outKeys.length) continue;
        const xk = keys(xc);
        let copy = true;
        for (let k = 0; k < this.K && copy; k++) if ((ok[k] ?? null) !== (xk[k] ?? null)) copy = false;
        if (copy) continue;
        for (const by of this.groupsForOrder()) {
          const seqs = this.sequences(by, order);
          for (const fn of ['previous', 'next', 'fillDown'] as const) {
            const expected = new Array<string | null>(this.K).fill(null);
            for (const list of seqs) {
              let last: string | null = null;
              for (let i = 0; i < list.length; i++) {
                const k = list[i] as number;
                if (fn === 'previous') expected[k] = i === 0 ? null : (xk[list[i - 1] as number] ?? null);
                else if (fn === 'next') expected[k] = i === list.length - 1 ? null : (xk[list[i + 1] as number] ?? null);
                else {
                  const v = xk[k] ?? null;
                  if (v !== null) last = v;
                  expected[k] = last;
                }
              }
            }
            const check = this.scan((k) => (ok[k] ?? null) === expected[k]);
            if (check !== null) {
              found.push(this.finding(o, fn, { in: [x], by, order }, check));
              hit = true;
            }
          }
        }
      }
      if (hit) break;
    }
    return found;
  }

  /** `rank(order: k[, by: g], ties: min|dense)`: the position by one numeric or date column, ascending or descending. */
  private rankFindings(out: ColumnData, o: number): WindowFinding[] {
    const found: WindowFinding[] = [];
    if (!this.countLike(out)) return found;
    for (const kc of this.rankCols) {
      const col = this.inp.src[kc] as ColumnData;
      const value = (k: number): number => (col.kind[k] === DATE ? (col.date[k] as number) : (col.num[k] as number));
      for (const by of this.groupsForOrder()) {
        const ranks = {
          asc: { min: new Float64Array(this.K).fill(NaN), dense: new Float64Array(this.K).fill(NaN) },
          desc: { min: new Float64Array(this.K).fill(NaN), dense: new Float64Array(this.K).fill(NaN) },
        };
        for (const list of this.sequences(by, 'file')) {
          const rows = list.filter((k) => col.kind[k] !== EMPTY && !Number.isNaN(value(k)));
          const counts = new Map<number, number>();
          for (const k of rows) counts.set(value(k), (counts.get(value(k)) ?? 0) + 1);
          const distinct = [...counts.keys()].sort((a, b) => a - b);
          const info = new Map<number, { before: number; index: number }>();
          let acc = 0;
          distinct.forEach((v, index) => {
            info.set(v, { before: acc, index });
            acc += counts.get(v) as number;
          });
          for (const k of rows) {
            const v = value(k);
            const { before, index } = info.get(v) as { before: number; index: number };
            const n = counts.get(v) as number;
            ranks.asc.min[k] = 1 + before;
            ranks.asc.dense[k] = index + 1;
            ranks.desc.min[k] = 1 + (rows.length - before - n);
            ranks.desc.dense[k] = distinct.length - index;
          }
        }
        for (const dir of ['asc', 'desc'] as const) {
          const hits: { ties: 'min' | 'dense'; check: Check }[] = [];
          for (const ties of ['min', 'dense'] as const) {
            const r = ranks[dir][ties];
            const check = this.scan((k) => (Number.isNaN(r[k] as number) ? out.kind[k] === EMPTY : out.num[k] === r[k]));
            if (check !== null) hits.push({ ties, check });
          }
          if (hits.length === 0) continue;
          // Both readings fit when the key has no ties: the default (min) stands, nothing forces dense.
          const best = hits.find((h) => h.ties === 'min') ?? (hits[0] as (typeof hits)[number]);
          const order: WindowOrder = [{ in: kc, dir }];
          found.push(this.finding(o, 'rank', { by, order, ties: best.ties }, best.check));
        }
      }
    }
    return found;
  }

  // ---------- the entry point ----------

  /**
   * Every window pattern output column `o` follows (coverage >= the minimum), best first, with readings that fit equally well folded into
   * `alt`; and the relations the fast path may build from them (the exact, order-independent ones, all of them, so that an ambiguity stays
   * visible). Needs enough aligned rows; the numeric patterns need a numeric output column.
   */
  detect(out: ColumnData, o: number): { findings: WindowFinding[]; relations: Relation[] } {
    const none = { findings: [], relations: [] };
    if (this.K < this.minRows || nonEmptyCount(out) < this.minRows) return none;
    const raw: WindowFinding[] = [];
    if (numericShare(out) >= limits.analysis.numericColumnShare) raw.push(...this.groupFindings(out, o), ...this.orderedFindings(out, o), ...this.rankFindings(out, o));
    raw.push(...this.neighbourFindings(out, o));
    if (raw.length === 0) return none;

    // Built = the free engine writes it: order-independent and exact on every row.
    for (const f of raw) f.built = (f.fn === 'groupSum' || f.fn === 'groupCount') && f.coverage === 1;

    // Best first: exact over partial, built over hint-only, no group over a group (a global running total beats one per group that
    // fits as well), the input's order over the output's.
    const preference = (f: WindowFinding): number =>
      (f.coverage === 1 ? 0 : 100) + (f.built ? 0 : 10) + (f.by.length === 0 ? 0 : 1) + (f.order === 'output' ? 5 : 0);
    raw.sort((a, b) => preference(a) - preference(b) || b.coverage - a.coverage || (a.in[0] ?? -1) - (b.in[0] ?? -1) || (a.by[0] ?? -1) - (b.by[0] ?? -1));

    const relations: Relation[] = raw
      .filter((f) => f.built)
      .slice(0, MAX_ALT + 1)
      .map(
        (f): Relation =>
          ({
            rel: 'window',
            fn: f.fn as 'groupSum' | 'groupCount',
            in: f.in,
            by: f.by as [number],
            out: f.out,
            coverage: f.coverage,
            matched: f.matched,
            total: f.total,
            failing: f.failing,
            failCount: f.failCount,
          }) as Relation,
      );

    // Findings: the best reading of each function; another exact reading of the same function and kind (both global, or both by a group) is an `alt`.
    const findings: WindowFinding[] = [];
    for (const f of raw) {
      const same = findings.find((g) => g.fn === f.fn);
      if (same === undefined) {
        findings.push({ ...f });
        continue;
      }
      if (same.coverage === 1 && f.coverage === 1 && same.order === f.order && (same.by.length === 0) === (f.by.length === 0) && (same.alt?.length ?? 0) < MAX_ALT) {
        (same.alt ??= []).push({ ...(f.in.length > 0 ? { in: f.in } : {}), ...(f.by.length > 0 ? { by: f.by } : {}) });
      }
    }
    return { findings: findings.slice(0, 4), relations };
  }
}
