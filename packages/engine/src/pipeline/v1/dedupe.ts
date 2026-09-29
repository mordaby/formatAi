// Step 4 (SPEC 8.4): duplicates. Rows are compared on the key columns (or every
// input column for "all") after type normalization, via canonicalKey.

import type { Dedupe } from '@formatai/shared';
import type { RunSummary } from '../../types';
import { flagOrigin, type Row, type RunCtx } from './rows';
import { canonicalKey } from './values';

export interface DedupeTarget {
  /** Key slots, in key order. */
  slots: number[];
  /** Column ids of the key slots. */
  ids: string[];
}

function rowKey(row: Row, slots: number[]): string | null {
  let key = '';
  let allEmpty = true;
  for (let i = 0; i < slots.length; i++) {
    const v = row.v[slots[i] as number] ?? null;
    if (v !== null) allEmpty = false;
    key += (i === 0 ? '' : '\u0000') + canonicalKey(v);
  }
  // DECISION: rows whose key values are all empty are never duplicates of each
  // other (an empty key identifies nothing; removing such rows would lose data).
  return allEmpty ? null : key;
}

/**
 * Applies dedupe. With keep "first" the later copies are the extras; with
 * "last", the earlier ones. "remove" drops the extras and lists them in the
 * summary; "flag" keeps every row and flags each extra copy with
 * "flag.duplicateOf" {duplicateOf}. Returns the rows that remain.
 */
export function applyDedupe(
  ctx: RunCtx,
  rows: Row[],
  rule: Dedupe,
  target: DedupeTarget,
  summary: RunSummary,
): Row[] {
  const keys = rows.map((r) => rowKey(r, target.slots));
  // Index of the kept copy for every key.
  const keeper = new Map<string, number>();
  for (let i = 0; i < rows.length; i++) {
    const k = keys[i];
    if (k === null || k === undefined) continue;
    if (rule.keep === 'last' || !keeper.has(k)) keeper.set(k, i);
  }

  // DECISION: a dedupe flag's `column` is the first key id (the first input
  // column for "all"); every key cell of the extra copy is highlighted.
  const flagColumn = target.ids[0] ?? '';
  const flagSlot = target.slots[0] ?? -1;

  const out: Row[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] as Row;
    const k = keys[i];
    const keepIdx = k === null || k === undefined ? i : (keeper.get(k) ?? i);
    if (keepIdx === i) {
      out.push(row);
      continue;
    }
    const duplicateOf = (rows[keepIdx] as Row).o.rowNumber;
    if (rule.action === 'remove') {
      summary.duplicatesRemoved.push({ rowNumber: row.o.rowNumber, duplicateOf });
      continue;
    }
    flagOrigin(ctx, row, flagSlot, {
      column: flagColumn,
      rule: 'dedupe',
      value: flagSlot >= 0 ? (row.v[flagSlot] ?? null) : null,
      messageKey: 'flag.duplicateOf',
      params: { duplicateOf },
    });
    for (const s of target.slots) {
      if (row.flagged === null) row.flagged = new Set();
      row.flagged.add(s);
    }
    summary.duplicatesFlagged++;
    out.push(row);
  }
  return out;
}
