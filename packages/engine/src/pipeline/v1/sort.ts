// Step 8 (SPEC 8.2): stable, typed sort.
//
// DECISION: text is compared by Unicode code point after normalizeText, never
// by locale collation (determinism: the same file sorts the same everywhere).
// DECISION: empty values sort last in both directions. Mixed types in one
// column follow Excel's ascending order numbers/dates < text < booleans (reversed
// for "desc"). Ties keep the input order, so expand families stay together.

import Decimal from 'decimal.js';
import type { SortKey } from '@formatai/shared';
import { slotOrThrow, type Row, type RunCtx } from './rows';
import { DateVal, ONE, ZERO, cmpCodePoints, normKey, type Val } from './values';

const RANK_NUM = 0;
const RANK_TEXT = 1;
const RANK_BOOL = 2;
const RANK_EMPTY = 3;

/** Precomputed sort key of one value. */
export interface KeyPart {
  rank: number;
  /** Numbers and booleans. */
  num: Decimal | null;
  /** Dates: the serial (compared as a plain integer when both sides are dates). */
  ser: number;
  text: string | null;
}

export function keyPart(v: Val): KeyPart {
  if (v === null) return { rank: RANK_EMPTY, num: null, ser: 0, text: null };
  if (v instanceof Decimal) return { rank: RANK_NUM, num: v, ser: 0, text: null };
  if (v instanceof DateVal) return { rank: RANK_NUM, num: null, ser: v.serial, text: null };
  if (typeof v === 'boolean') return { rank: RANK_BOOL, num: v ? ONE : ZERO, ser: 0, text: null };
  return { rank: RANK_TEXT, num: null, ser: 0, text: normKey(v) };
}

function cmpNum(a: KeyPart, b: KeyPart): number {
  if (a.num === null && b.num === null) return a.ser === b.ser ? 0 : a.ser < b.ser ? -1 : 1;
  const x = a.num ?? new Decimal(a.ser);
  const y = b.num ?? new Decimal(b.ser);
  return x.cmp(y);
}

/** Ascending comparison of two key parts, empties last. */
export function cmpKeyPart(a: KeyPart, b: KeyPart, desc: boolean): number {
  if (a.rank === RANK_EMPTY || b.rank === RANK_EMPTY) {
    if (a.rank === b.rank) return 0;
    return a.rank === RANK_EMPTY ? 1 : -1;
  }
  let c: number;
  if (a.rank !== b.rank) c = a.rank - b.rank;
  else if (a.rank === RANK_TEXT) c = cmpCodePoints(a.text as string, b.text as string);
  else c = cmpNum(a, b);
  return desc ? -c : c;
}

export function applySort(ctx: RunCtx, rows: Row[], sort: SortKey[]): Row[] {
  if (sort.length === 0 || rows.length < 2) return rows;
  const slots = sort.map((s) => slotOrThrow(ctx.plan, s.column));
  const desc = sort.map((s) => s.dir === 'desc');
  const keys: KeyPart[][] = slots.map((slot) => rows.map((r) => keyPart(r.v[slot] ?? null)));
  const idx = rows.map((_, i) => i);
  idx.sort((i, j) => {
    for (let k = 0; k < slots.length; k++) {
      const col = keys[k] as KeyPart[];
      const c = cmpKeyPart(col[i] as KeyPart, col[j] as KeyPart, desc[k] as boolean);
      if (c !== 0) return c;
    }
    return i - j; // explicit stability
  });
  return idx.map((i) => rows[i] as Row);
}
