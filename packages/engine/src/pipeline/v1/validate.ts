// Validations (SPEC 8.8). The `type` check runs automatically during
// normalization; this module runs the declared ones.
//
// DECISION: where validations run. SPEC 8.2 lists validations last, but a
// "block" must keep a row out of the output *and* out of every subtotal, grand
// total, summary row and title aggregate. So all declared validations run on
// the final row values (after computed columns and value maps) and *before*
// sort/group/layout. Flags are emitted only for rows that reach the output:
// flags already raised on a row that a validation then blocks are dropped, and
// the row is listed in summary.blockedRows instead (one entry per blocked
// row, naming the first blocking validation).

import Decimal from 'decimal.js';
import type { Validation } from '@formatai/shared';
import type { RunSummary } from '../../types';
import { isValidIsraeliId } from '../../values/israeliId';
import { parseNumber } from '../../values/numbers';
import { normalizeText, padLeft } from '../../values/text';
import { flagRow, slotOrThrow, type Origin, type Row, type RunCtx } from './rows';
import { DateVal, canonicalKey, normKey, parseConstDate, toText, type Val } from './values';

interface Failure {
  params?: Record<string, string | number>;
  suggestion?: string | number;
}

const PASS = null;
const FAIL: Failure = {};
const DIGITS_RE = /^\d+$/;

type Check = (v: Val) => Failure | null;

function makeCheck(val: Exclude<Validation, { rule: 'unique' }>): Check {
  switch (val.rule) {
    case 'required':
      return (v) => (v === null ? FAIL : PASS);

    case 'israeliIdChecksum':
      return (v) => (v === null || isValidIsraeliId(toText(v).trim()) ? PASS : FAIL);

    case 'range': {
      const min = val.min !== undefined ? new Decimal(val.min) : null;
      const max = val.max !== undefined ? new Decimal(val.max) : null;
      const params: Record<string, number> = {};
      if (val.min !== undefined) params.min = val.min;
      if (val.max !== undefined) params.max = val.max;
      const failure: Failure = { params };
      return (v) => {
        // Non-numbers are already reported by the type check.
        const n = v instanceof Decimal ? v : typeof v === 'string' ? parseNumber(v) : null;
        if (n === null) return PASS;
        if (min !== null && n.lt(min)) return failure;
        if (max !== null && n.gt(max)) return failure;
        return PASS;
      };
    }

    case 'lengthEquals': {
      const length = val.length;
      const params = { length };
      return (v) => {
        if (v === null) return PASS;
        const t = toText(v);
        const len = Array.from(t).length;
        if (len === length) return PASS;
        // Padding is the one mechanical fix: an all-digit value that is too short.
        if (len < length && DIGITS_RE.test(t)) return { params, suggestion: padLeft(t, length, '0') };
        return { params };
      };
    }

    case 'oneOf': {
      const allowed = new Set(val.values.map((s) => normalizeText(s)));
      return (v) => (v === null || allowed.has(normKey(v)) ? PASS : FAIL);
    }

    case 'dateRange': {
      const from = parseConstDate(val.from);
      const to = parseConstDate(val.to);
      const failure: Failure = { params: { from: val.from, to: val.to } };
      return (v) => {
        if (!(v instanceof DateVal)) return PASS; // empty, or not a date (type check covers it)
        if (from !== null && v.serial < from.serial) return failure;
        if (to !== null && v.serial > to.serial) return failure;
        return PASS;
      };
    }
  }
}

// DECISION: every validation except `required` passes on an empty value.
// DECISION: `unique` flags (or blocks) the second and later occurrences of a
// value, with params {firstRow}; the first occurrence stays. Repeats within one
// expand family (rows of the same input row) don't count as duplicates.
/**
 * Runs the declared validations in order over the rows (in pipeline order).
 * A row blocked by one validation isn't checked by later ones.
 */
export function applyValidations(
  ctx: RunCtx,
  rows: Row[],
  validations: Validation[],
  summary: RunSummary,
): Row[] {
  if (validations.length === 0) return rows;
  const blocked: (Validation | null)[] = new Array<Validation | null>(rows.length).fill(null);

  for (const val of validations) {
    const slot = slotOrThrow(ctx.plan, val.column);
    const messageKey = `flag.validation.${val.rule}`;
    let check: (v: Val, origin: Origin) => Failure | null;
    if (val.rule === 'unique') {
      const seen = new Map<string, Origin>();
      check = (v, origin) => {
        if (v === null) return PASS;
        const key = canonicalKey(v);
        const first = seen.get(key);
        if (first === undefined) {
          seen.set(key, origin);
          return PASS;
        }
        if (first === origin) return PASS;
        return { params: { firstRow: first.rowNumber } };
      };
    } else {
      const c = makeCheck(val);
      check = (v) => c(v);
    }

    for (let i = 0; i < rows.length; i++) {
      if (blocked[i] !== null) continue;
      const row = rows[i] as Row;
      const v = row.v[slot] ?? null;
      const failure = check(v, row.o);
      if (failure === null) continue;
      if (val.severity === 'block') {
        blocked[i] = val;
        continue;
      }
      flagRow(ctx, row, slot, {
        column: val.column,
        rule: val.rule,
        value: v,
        messageKey,
        ...(failure.params !== undefined ? { params: { ...failure.params } } : {}),
        ...(failure.suggestion !== undefined ? { suggestion: failure.suggestion } : {}),
      });
    }
  }

  const out: Row[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] as Row;
    const b = blocked[i];
    if (b === null || b === undefined) out.push(row);
    else summary.blockedRows.push({ rowNumber: row.o.rowNumber, rule: b.rule, column: b.column });
  }
  return out;
}
