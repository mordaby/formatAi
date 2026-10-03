// Across-row ("window") functions (SPEC 8.3, docs/proposals/window-operations.md), evaluated in step 6 over the rows that
// remain after filters, duplicates and expand (a row a `block` validation leaves out later still counts: validations run after).
//
// Each window node is computed for ALL rows at once (column-major) into a hidden row slot; the computed column's expression
// then runs per row and reads it (transform.ts). Semantics:
//   - A partition is the rows with the same `by` values (all rows without `by:`); an empty value is a partition of its own, like
//     `group.by`. Rows are compared by `canonicalKey`, the identity dedupe and group use.
//   - A partition is walked in FILE order (the order the rows have right before step 6) unless `order:` says otherwise. `order:`
//     sorts with the output sort's own typed comparison (numbers and dates by value, text by code point, empties last in either
//     direction); equal keys keep file order, so the walk is always fully determined.
//   - Numbers are decimal.js, added strictly in walk order: no floats, no clock, no locale, no randomness.
//   - A window raises no flags of its own: a cell that did not parse is already flagged (and skipped here, as `sum` skips it).
// Cost: one partition map per distinct `by`, one sorted index per distinct (`by`, `order`), cached for the run; each window is then
// a single O(n) pass.

import Decimal from 'decimal.js';
import type { Expr, ExprNode, WindowOrderKey } from '@formatai/shared';
import { exprChildren } from './expr';
import { InternalRulesError, type Row } from './rows';
import { cmpKeyPart, keyPart, type KeyPart } from './sort';

/** The sort keys of one column over all rows, with each number's nearest double beside it (a fast first look, never the answer on its own). */
interface KeyColumn {
  parts: KeyPart[];
  approx: Float64Array;
}

/**
 * `cmpKeyPart` (the output sort's own typed comparison), made faster for numbers and dates: two values whose nearest doubles differ are in
 * the order of those doubles (rounding to the nearest double never swaps two different values), so only equal doubles - the rare, close
 * values and genuine ties - go to the exact decimal comparison. The result is always exactly `cmpKeyPart`'s.
 */
function cmpKeys(col: KeyColumn, i: number, j: number, desc: boolean): number {
  const a = col.parts[i] as KeyPart;
  const b = col.parts[j] as KeyPart;
  if (a.rank === 0 && b.rank === 0) {
    const x = col.approx[i] as number;
    const y = col.approx[j] as number;
    if (x !== y) return (x < y ? -1 : 1) * (desc ? -1 : 1);
  }
  return cmpKeyPart(a, b, desc);
}
import { DateVal, canonicalKey, decInt, toNum, type Val } from './values';

export type WindowNode = Extract<ExprNode, { op: 'window' }>;

/** The across-row function calls in `expr`, children first. A node that appears twice appears twice. */
export function collectWindows(expr: Expr, into: WindowNode[] = []): WindowNode[] {
  if (!('op' in expr)) return into;
  for (const child of exprChildren(expr)) collectWindows(child, into);
  if (expr.op === 'window') into.push(expr);
  return into;
}

/** How many window nodes a rules file's computed columns hold (the hidden row slots a run needs). */
export function countWindows(computed: readonly { expr: Expr }[]): number {
  let n = 0;
  for (const c of computed) n += collectWindows(c.expr).length;
  return n;
}

function cmpNumberOrDate(a: Decimal | DateVal, b: Decimal | DateVal): number {
  if (a instanceof DateVal && b instanceof DateVal) return a.serial === b.serial ? 0 : a.serial < b.serial ? -1 : 1;
  const x = a instanceof DateVal ? new Decimal(a.serial) : a;
  const y = b instanceof DateVal ? new Decimal(b.serial) : b;
  return x.cmp(y);
}

export class WindowEngine {
  private readonly n: number;
  private readonly partitionCache = new Map<string, number[][]>();
  private readonly orderedCache = new Map<string, number[][]>();
  private readonly keyCache = new Map<number, KeyColumn>();

  constructor(
    private readonly rows: readonly Row[],
    private readonly slotOf: ReadonlyMap<string, number>,
  ) {
    this.n = rows.length;
  }

  private slot(id: string): number {
    const s = this.slotOf.get(id);
    if (s === undefined) throw new InternalRulesError(`unknown column id "${id}"`);
    return s;
  }

  private val(i: number, slot: number): Val {
    return (this.rows[i] as Row).v[slot] ?? null;
  }

  /** Row indices of each partition, ascending (file order); partitions in order of first appearance. */
  private partitions(by: readonly string[] | undefined): number[][] {
    const slots = (by ?? []).map((id) => this.slot(id));
    const cacheKey = slots.join(',');
    const hit = this.partitionCache.get(cacheKey);
    if (hit !== undefined) return hit;
    let groups: number[][];
    if (slots.length === 0) {
      groups = [Array.from({ length: this.n }, (_, i) => i)];
      if (this.n === 0) groups = [];
    } else {
      const byKey = new Map<string, number[]>();
      for (let i = 0; i < this.n; i++) {
        let key: string;
        if (slots.length === 1) key = canonicalKey(this.val(i, slots[0] as number));
        else {
          key = '';
          for (const s of slots) {
            const k = canonicalKey(this.val(i, s));
            key += `${k.length}:${k}`;
          }
        }
        const g = byKey.get(key);
        if (g === undefined) byKey.set(key, [i]);
        else g.push(i);
      }
      groups = [...byKey.values()];
    }
    this.partitionCache.set(cacheKey, groups);
    return groups;
  }

  private keyColumn(slot: number): KeyColumn {
    let keys = this.keyCache.get(slot);
    if (keys === undefined) {
      const parts = new Array<KeyPart>(this.n);
      const approx = new Float64Array(this.n);
      for (let i = 0; i < this.n; i++) {
        const p = keyPart(this.val(i, slot));
        parts[i] = p;
        approx[i] = p.num !== null ? p.num.toNumber() : p.ser;
      }
      keys = { parts, approx };
      this.keyCache.set(slot, keys);
    }
    return keys;
  }

  /** The partitions with each one's rows in walk order: file order, or sorted by `order` (ties by file order). */
  private ordered(by: readonly string[] | undefined, order: readonly WindowOrderKey[] | undefined): number[][] {
    const groups = this.partitions(by);
    if (order === undefined || order.length === 0) return groups;
    const slots = order.map((k) => this.slot(k.column));
    const cacheKey = `${(by ?? []).map((id) => this.slot(id)).join(',')}|${order.map((k, i) => `${slots[i]}${k.dir}`).join(',')}`;
    const hit = this.orderedCache.get(cacheKey);
    if (hit !== undefined) return hit;
    const keys = slots.map((s) => this.keyColumn(s));
    const desc = order.map((k) => k.dir === 'desc');
    const sorted = groups.map((g) => {
      if (g.length < 2) return g;
      return g.slice().sort((i, j) => {
        for (let k = 0; k < keys.length; k++) {
          const c = cmpKeys(keys[k] as KeyColumn, i, j, desc[k] as boolean);
          if (c !== 0) return c;
        }
        return i - j; // explicit stability: equal keys keep file order
      });
    });
    this.orderedCache.set(cacheKey, sorted);
    return sorted;
  }

  /** The window's value on every row (indexed like `rows`). */
  compute(node: WindowNode): Val[] {
    const out = new Array<Val>(this.n).fill(null);
    if (this.n === 0) return out;
    const x = node.arg === undefined ? -1 : 'col' in node.arg ? this.slot(node.arg.col) : -2;
    if (x === -2) throw new InternalRulesError(`${node.fn}() reads a column id`);
    const xs = (i: number): Val => this.val(i, x);

    switch (node.fn) {
      case 'runningSum': {
        for (const g of this.ordered(node.by, node.order)) {
          let acc: Decimal | null = null;
          for (const i of g) {
            const d = toNum(xs(i));
            if (d !== null && d !== undefined) acc = acc === null ? d : acc.plus(d);
            out[i] = acc;
          }
        }
        return out;
      }
      case 'groupSum':
      case 'groupAvg': {
        for (const g of this.partitions(node.by)) {
          let acc: Decimal | null = null;
          let count = 0;
          for (const i of g) {
            const d = toNum(xs(i));
            if (d !== null && d !== undefined) {
              acc = acc === null ? d : acc.plus(d);
              count++;
            }
          }
          // The average is the exact quotient at decimal.js's default precision, like the `average` summary.
          const v = acc === null ? null : node.fn === 'groupAvg' ? acc.dividedBy(count) : acc;
          for (const i of g) out[i] = v;
        }
        return out;
      }
      case 'groupMin':
      case 'groupMax': {
        const wantMin = node.fn === 'groupMin';
        for (const g of this.partitions(node.by)) {
          let best: Decimal | DateVal | null = null;
          for (const i of g) {
            const v = xs(i);
            if (!(v instanceof Decimal) && !(v instanceof DateVal)) continue; // empty, or text that did not parse
            if (best === null) best = v;
            else {
              const c = cmpNumberOrDate(v, best);
              if (wantMin ? c < 0 : c > 0) best = v;
            }
          }
          for (const i of g) out[i] = best;
        }
        return out;
      }
      case 'groupCount': {
        for (const g of this.partitions(node.by)) {
          let count = g.length;
          if (x >= 0) {
            count = 0;
            for (const i of g) if (xs(i) !== null) count++;
          }
          const v = decInt(count);
          for (const i of g) out[i] = v;
        }
        return out;
      }
      case 'previous':
      case 'next': {
        const back = node.fn === 'previous';
        for (const g of this.ordered(node.by, node.order)) {
          for (let k = 0; k < g.length; k++) {
            const other = back ? k - 1 : k + 1;
            out[g[k] as number] = other < 0 || other >= g.length ? null : xs(g[other] as number);
          }
        }
        return out;
      }
      case 'fillDown': {
        for (const g of this.ordered(node.by, node.order)) {
          let last: Val = null;
          for (const i of g) {
            const v = xs(i);
            if (v !== null) last = v;
            out[i] = last;
          }
        }
        return out;
      }
      case 'rowNumber': {
        for (const g of this.ordered(node.by, node.order)) {
          for (let k = 0; k < g.length; k++) out[g[k] as number] = decInt(k + 1);
        }
        return out;
      }
      case 'rank': {
        const order = node.order;
        if (order === undefined || order.length === 0) throw new InternalRulesError('rank() needs order:');
        const slots = order.map((k) => this.slot(k.column));
        const keys = slots.map((s) => this.keyColumn(s));
        const dense = node.ties === 'dense';
        const same = (i: number, j: number): boolean => {
          for (const col of keys) if (cmpKeys(col, i, j, false) !== 0) return false;
          return true;
        };
        for (const g of this.ordered(node.by, order)) {
          let counted = 0;
          let groupsSeen = 0;
          let prev = -1;
          let current: Decimal = decInt(0);
          for (const i of g) {
            // An empty first key has no place in the ranking: no rank, and the row is not counted.
            if (this.val(i, slots[0] as number) === null) continue;
            counted++;
            if (prev === -1 || !same(prev, i)) {
              groupsSeen++;
              current = decInt(dense ? groupsSeen : counted);
            }
            out[i] = current;
            prev = i;
          }
        }
        return out;
      }
    }
  }
}
