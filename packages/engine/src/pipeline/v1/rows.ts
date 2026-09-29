// Row model and flag plumbing for the v1 pipeline.
//
// Every column id used anywhere in the rules gets a fixed "slot" (array index),
// so a row is a flat Val[] and expressions resolve column ids once, at compile time.

import type { ColumnType } from '@formatai/shared';
import type { Flag } from '../../types';
import { flagValue, type Val } from './values';

/** The input row a pipeline row came from. Shared by every row of an expand family. */
export interface Origin {
  /** 1-based Excel row number of the input row. */
  rowNumber: number;
  /** Flags raised before expand (type checks, dedupe): they belong to the input row. */
  flags: Flag[] | null;
  /** Set once these flags have been emitted (a family emits them once). */
  emitted: boolean;
}

export interface Row {
  v: Val[];
  o: Origin;
  /** Flags raised on this (possibly expanded) row: expressions, value maps, validations. */
  flags: Flag[] | null;
  /** Slots whose output cell should be highlighted. Allocated only when needed. */
  flagged: Set<number> | null;
}

export interface SlotPlan {
  slotOf: Map<string, number>;
  /** Declared type per slot, when known (fixedFanOut-created ids have none). */
  types: (ColumnType | undefined)[];
  width: number;
}

export interface RunCtx {
  fileName: string | undefined;
  language: 'he' | 'en';
  date1904: boolean;
  plan: SlotPlan;
}

export interface FlagInit {
  column: string;
  rule: string;
  value: Val | number;
  messageKey: string;
  params?: Record<string, string | number>;
  suggestion?: string | number;
}

export function makeFlag(ctx: RunCtx, rowNumber: number, init: FlagInit): Flag {
  const flag: Flag = {
    rowNumber,
    column: init.column,
    rule: init.rule,
    value: flagValue(init.value),
    messageKey: init.messageKey,
  };
  if (ctx.fileName !== undefined) flag.fileName = ctx.fileName;
  if (init.params !== undefined) flag.params = init.params;
  if (init.suggestion !== undefined) flag.suggestion = init.suggestion;
  return flag;
}

export function markFlagged(row: Row, slot: number): void {
  if (slot < 0) return;
  if (row.flagged === null) row.flagged = new Set();
  row.flagged.add(slot);
}

/** Adds a flag to the input row (pre-expand stages). */
export function flagOrigin(ctx: RunCtx, row: Row, slot: number, init: FlagInit): void {
  const f = makeFlag(ctx, row.o.rowNumber, init);
  if (row.o.flags === null) row.o.flags = [];
  row.o.flags.push(f);
  markFlagged(row, slot);
}

/** Adds a flag to this (possibly expanded) row. */
export function flagRow(ctx: RunCtx, row: Row, slot: number, init: FlagInit): void {
  const f = makeFlag(ctx, row.o.rowNumber, init);
  if (row.flags === null) row.flags = [];
  row.flags.push(f);
  markFlagged(row, slot);
}

/** A new row of the same family (expand): copies values and highlighted cells. */
export function childRow(parent: Row, values: Val[]): Row {
  return {
    v: values,
    o: parent.o,
    flags: null,
    flagged: parent.flagged === null ? null : new Set(parent.flagged),
  };
}

export function slotOrThrow(plan: SlotPlan, id: string): number {
  const s = plan.slotOf.get(id);
  if (s === undefined) throw new InternalRulesError(`unknown column id "${id}"`);
  return s;
}

/** Thrown for rules that passed validation but still can't run; runRules maps it to invalidRules. */
export class InternalRulesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InternalRulesError';
  }
}
