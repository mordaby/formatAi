// Step 5 (SPEC 8.5): one input row -> several output rows. Every other column is
// copied to each new row, the rows of one family stay together in family order,
// and every new row keeps the source row's rowNumber (it shares its Origin).

import type { Expand, InputColumn } from '@formatai/shared';
import { compileExpr, newEvalCx, resetCx, type Fn } from './expr';
import { coerceTo, newIssue } from './normalize';
import { childRow, flagRow, markFlagged, slotOrThrow, type Row, type RunCtx } from './rows';
import { decInt, isBlankText, toText, type Val } from './values';

export function applyExpand(
  ctx: RunCtx,
  rows: Row[],
  ex: Expand,
  inputColumns: InputColumn[],
): Row[] {
  switch (ex.mode) {
    case 'columnsToRows':
      return columnsToRows(ctx, rows, ex, inputColumns);
    case 'splitCell':
      return splitCell(ctx, rows, ex);
    case 'fixedFanOut':
      return fixedFanOut(ctx, rows, ex);
  }
}

/**
 * One new row per listed column: labelId holds the label, valueId the cell
 * (coerced to valueType). The listed columns are cleared afterwards (gone).
 * With skipEmpty, empty cells make no row; a source row whose listed cells are
 * all empty then makes no rows at all.
 */
function columnsToRows(
  ctx: RunCtx,
  rows: Row[],
  ex: Extract<Expand, { mode: 'columnsToRows' }>,
  inputColumns: InputColumn[],
): Row[] {
  const plan = ctx.plan;
  const srcSlots = ex.columns.map((id) => slotOrThrow(plan, id));
  // DECISION: labels default to the rule column's `header` (the header in the
  // example input), not the new file's spelling, so a header matched by alias
  // or by normalization still yields the same label every month.
  const labels = ex.columns.map((id) => {
    const own = ex.labels !== undefined && Object.hasOwn(ex.labels, id) ? ex.labels[id] : undefined;
    return own ?? inputColumns.find((c) => c.id === id)?.header ?? id;
  });
  const labelSlot = slotOrThrow(plan, ex.labelId);
  const valueSlot = slotOrThrow(plan, ex.valueId);
  const issue = newIssue();
  const out: Row[] = [];

  for (const row of rows) {
    for (let k = 0; k < srcSlots.length; k++) {
      const s = srcSlots[k] as number;
      const v = row.v[s] ?? null;
      if (ex.skipEmpty && v === null) continue;
      const nv = row.v.slice();
      for (const t of srcSlots) nv[t] = null;
      const label = labels[k] as string;
      nv[labelSlot] = label === '' ? null : label;
      nv[valueSlot] = coerceTo(v, ex.valueType, issue);
      const child = childRow(row, nv);
      const srcWasFlagged = child.flagged?.has(s) === true;
      if (child.flagged !== null) for (const t of srcSlots) child.flagged.delete(t);
      if (srcWasFlagged) {
        markFlagged(child, valueSlot); // the cell was already flagged by its type check
      } else if (issue.key !== null) {
        flagRow(ctx, child, valueSlot, {
          column: ex.valueId,
          rule: 'type',
          value: v,
          messageKey: issue.key,
          params: { type: ex.valueType },
        });
      }
      out.push(child);
    }
  }
  return out;
}

/**
 * One new row per part of the cell, split on a literal separator. partId holds
 * the part (trimmed when `trim`), indexId its 1-based position, countId the
 * number of parts. With skipEmpty, empty parts make no row (and a row whose
 * parts are all empty makes no rows); without it an empty cell gives one row
 * with an empty part, index 1 of 1.
 */
function splitCell(ctx: RunCtx, rows: Row[], ex: Extract<Expand, { mode: 'splitCell' }>): Row[] {
  const plan = ctx.plan;
  const srcSlot = slotOrThrow(plan, ex.column);
  const partSlot = slotOrThrow(plan, ex.partId);
  const indexSlot = ex.indexId !== undefined ? slotOrThrow(plan, ex.indexId) : -1;
  const countSlot = ex.countId !== undefined ? slotOrThrow(plan, ex.countId) : -1;
  const out: Row[] = [];

  for (const row of rows) {
    const text = toText(row.v[srcSlot] ?? null);
    let parts = text.split(ex.separator);
    if (ex.trim) parts = parts.map((p) => p.trim());
    if (ex.skipEmpty) parts = parts.filter((p) => !isBlankText(p));
    const count = parts.length;
    for (let i = 0; i < count; i++) {
      const p = parts[i] as string;
      const nv = row.v.slice();
      nv[partSlot] = isBlankText(p) ? null : p;
      if (indexSlot >= 0) nv[indexSlot] = decInt(i + 1);
      if (countSlot >= 0) nv[countSlot] = decInt(count);
      out.push(childRow(row, nv));
    }
  }
  return out;
}

/**
 * Every input row becomes one row per entry of `rows`, in order. Each entry's
 * `set` expressions are evaluated on the *source* row (not on the new row being
 * built), then create or overwrite those columns on the new row.
 */
function fixedFanOut(ctx: RunCtx, rows: Row[], ex: Extract<Expand, { mode: 'fixedFanOut' }>): Row[] {
  const env = { slotOf: ctx.plan.slotOf, language: ctx.language };
  const entries: { id: string; slot: number; fn: Fn }[][] = ex.rows.map((r) =>
    Object.entries(r.set).map(([id, expr]) => ({
      id,
      slot: slotOrThrow(ctx.plan, id),
      fn: compileExpr(expr, env),
    })),
  );
  const cx = newEvalCx();
  const out: Row[] = [];

  for (const row of rows) {
    const src: readonly Val[] = row.v;
    for (const setList of entries) {
      const nv = src.slice();
      const child = childRow(row, nv);
      for (const e of setList) {
        resetCx(cx);
        nv[e.slot] = e.fn(src, cx);
        if (cx.problem !== null) {
          flagRow(ctx, child, e.slot, {
            column: e.id,
            rule: 'expr',
            value: cx.problemValue,
            messageKey: cx.problem,
          });
        }
      }
      out.push(child);
    }
  }
  return out;
}
