// Step 3 (SPEC 8.3): row filters, ANDed. Comparisons are typed by the filter
// column's declared type: filter constants are normalized like the column's
// cells (an idLike constant is padded, a number constant becomes a Decimal, a
// date constant a date), then compared numerically / by date / by
// normalizeText equality for text.

import type { RowFilter } from '@formatai/shared';
import type { ColNorm } from './normalize';
import { normalizeConst } from './normalize';
import { comparePrepared, normKey, prepare, type Prepared, type Val } from './values';

export type RowPredicate = (v: Val) => boolean;

function eqPrepared(v: Val, p: Prepared): boolean {
  if (v === null || p.v === null) return v === p.v;
  return comparePrepared(v, p) === 0;
}

/** Builds the predicate for one filter over its column's (normalized) value. */
export function compileFilter(f: RowFilter, col: ColNorm): RowPredicate {
  switch (f.op) {
    case 'isEmpty':
      return (v) => v === null;
    case 'notEmpty':
      return (v) => v !== null;
    case 'eq':
    case 'ne': {
      const p = prepare(normalizeConst(f.value, col));
      const want = f.op === 'eq';
      return (v) => eqPrepared(v, p) === want;
    }
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const p = prepare(normalizeConst(f.value, col));
      const op = f.op;
      return (v) => {
        const k = comparePrepared(v, p);
        if (k === null) return false; // empty is never greater/less than anything
        return op === 'gt' ? k > 0 : op === 'gte' ? k >= 0 : op === 'lt' ? k < 0 : k <= 0;
      };
    }
    case 'oneOf':
    case 'notOneOf': {
      const want = f.op === 'oneOf';
      const ps = f.value.map((x) => prepare(normalizeConst(x, col)));
      if (col.cat === 'text' || col.cat === 'idLike') {
        // Fast path for text columns: one normalizeText per row, set lookup.
        const texts = new Set<string>();
        let hasEmpty = false;
        for (const p of ps) {
          if (p.v === null) hasEmpty = true;
          else texts.add(p.text);
        }
        return (v) => {
          if (v === null) return hasEmpty === want;
          if (typeof v === 'string') return texts.has(normKey(v)) === want;
          return ps.some((p) => eqPrepared(v, p)) === want;
        };
      }
      return (v) => ps.some((p) => eqPrepared(v, p)) === want;
    }
  }
}
