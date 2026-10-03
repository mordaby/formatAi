// Which input columns a conversion's rules actually USE, and what a new file does to them (SPEC 8.15, 21 v11 items 4-7). A column counts as
// `required` only when the example had no empty cell in it, so a column a format reads but that had empty cells in the example
// is declared optional: when it disappears from a later file the engine still runs and leaves what it feeds empty. The browser
// uses these pure functions (through the worker) to tell the user BEFORE that happens, per format. None of them changes how a
// run behaves, and none reads a value: headers, ids and counts only.
import type { ColumnType, Expr, LearnResult, Rules } from '@formatai/shared';
import { limits } from '@formatai/shared';
import { exprChildren } from '../pipeline/v1/expr';
import { mapHeaders } from '../pipeline/v1/normalize';
import type { Flag } from '../types';

/**
 * The ids of the declared input columns the rules read, in declaration order: what an output column is built from (through
 * computed columns, and across-row functions' `by` / `order`), and what decides which rows there are or in which order (row
 * filters, duplicate keys, expand, sort, group, title rows, input-side checks).
 *
 * DECISION: an input-side check (`validations`, not `on: "output"`) counts as a use, and so does `dedupe.keys: "all"` (every
 * declared column): with the column gone a check can no longer run, and rows that differed only in it collapse into one - the
 * silent kind of loss this exists to prevent. A value map is not a use on its own (it only changes a column something else
 * reads). A computed column nothing reads is not a use of the columns it would read.
 */
export function inputColumnsUsed(rules: LearnResult | Rules): string[] {
  const declared = rules.input.columns;
  const inputIds = new Set(declared.map((c) => c.id));
  const computed = new Map(rules.transform.computed.map((c) => [c.id, c.expr] as const));
  const used = new Set<string>();
  const walked = new Set<string>();

  const readId = (id: string): void => {
    if (inputIds.has(id)) used.add(id);
    const expr = computed.get(id);
    if (expr !== undefined && !walked.has(id)) {
      walked.add(id);
      readExpr(expr);
    }
  };
  const readExpr = (e: Expr): void => {
    if ('col' in e) {
      readId(e.col);
      return;
    }
    if ('const' in e || 'param' in e) return;
    if (e.op === 'window') {
      for (const id of e.by ?? []) readId(id);
      for (const key of e.order ?? []) readId(key.column);
    }
    for (const child of exprChildren(e)) readExpr(child);
  };

  // What the output is built from.
  for (const c of rules.output.columns) if (c.from !== null) readId(c.from);
  for (const row of rules.output.titleRows) {
    if ('parts' in row) for (const part of row.parts) if ('agg' in part) readId(part.column);
  }
  const total = rules.output.grandTotal;
  if (total) {
    readId(total.labelColumn);
    for (const id of total.sum) readId(id);
  }
  const group = rules.transform.group;
  if (group) {
    readId(group.by);
    if (group.subtotal) {
      readId(group.subtotal.labelColumn);
      for (const id of group.subtotal.sum) readId(id);
    }
  }
  for (const key of rules.transform.sort) readId(key.column);

  // What decides which rows there are.
  for (const f of rules.input.rowFilters ?? []) {
    if ('expr' in f) readExpr(f.expr);
    else readId(f.column);
  }
  const dedupe = rules.transform.dedupe;
  if (dedupe) {
    if (dedupe.keys === 'all') for (const c of declared) readId(c.id);
    else for (const id of dedupe.keys) readId(id);
  }
  const expand = rules.transform.expand;
  if (expand) {
    if (expand.mode === 'columnsToRows') for (const id of expand.columns) readId(id);
    else if (expand.mode === 'splitCell') readId(expand.column);
    else for (const row of expand.rows) for (const e of Object.values(row.set)) readExpr(e);
  }

  // A check on an input column.
  for (const v of rules.validations) if ((v.on ?? 'input') !== 'output') readId(v.column);

  return declared.filter((c) => used.has(c.id)).map((c) => c.id);
}

export interface InputColumnGap {
  id: string;
  /** The header the rules declare. */
  header: string;
  /** The conversion cannot run without it (`input.columns[].required`); otherwise it is used but optional. */
  required: boolean;
}

/**
 * The columns a conversion needs that a file with these headers does not have: every missing REQUIRED column, and every missing
 * column the rules USE though it is optional (`inputColumnsUsed`). Found the way a run finds them (`mapHeaders`: exact, then
 * alias, then normalized), so this cannot disagree with the run. A declared column nothing uses may be missing: it is not listed.
 */
export function missingInputColumns(rules: LearnResult | Rules, headers: readonly string[]): InputColumnGap[] {
  const { src } = mapHeaders(rules.input.columns, [...headers]);
  const used = new Set(inputColumnsUsed(rules));
  return rules.input.columns.flatMap((c, i) => {
    if ((src[i] as number) >= 0) return [];
    const required = c.required === true;
    return required || used.has(c.id) ? [{ id: c.id, header: c.header, required }] : [];
  });
}

export interface UnlikeColumn {
  id: string;
  header: string;
  /** The type the rules read it as. */
  type: ColumnType;
  /** Rows whose value did not parse as that type. */
  rows: number;
}

/**
 * "Same name, different meaning": the used input columns whose values (at least `share` of them) failed to parse as the saved
 * type, from a run's flags. Only counts are looked at - never a cell value. `rowsIn` (the run summary's) is the denominator: the
 * run does not report how many cells of one column were non-empty, and a share of all rows is never larger than a share of the
 * non-empty ones, so this errs towards saying nothing. Smaller shares are the flagged-rows review's business, not this.
 */
export function unlikeColumns(rules: LearnResult | Rules, flags: readonly Flag[], rowsIn: number, share: number = limits.matching.parseFailShare): UnlikeColumn[] {
  if (rowsIn <= 0) return [];
  const used = new Set(inputColumnsUsed(rules));
  const failed = new Map<string, Set<number>>();
  for (const f of flags) {
    if (f.rule !== 'type' || !f.messageKey.startsWith('flag.parseFailed.') || !used.has(f.column)) continue;
    const rows = failed.get(f.column);
    if (rows) rows.add(f.rowNumber);
    else failed.set(f.column, new Set([f.rowNumber]));
  }
  return rules.input.columns.flatMap((c) => {
    const rows = failed.get(c.id)?.size ?? 0;
    return rows > 0 && rows / rowsIn >= share ? [{ id: c.id, header: c.header, type: c.type, rows }] : [];
  });
}
