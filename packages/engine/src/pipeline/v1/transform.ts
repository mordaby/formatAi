// Steps 6-7 (SPEC 8.2): computed columns and value maps.

import type { Computed, ValueMap } from '@formatai/shared';
import { compileExpr, newEvalCx, resetCx, type Fn } from './expr';
import { coerceTo, newIssue } from './normalize';
import { flagRow, slotOrThrow, type Row, type RunCtx } from './rows';
import { normText, toText } from './values';

/**
 * Computed columns run in order, once per (expanded) row, and may reference
 * earlier computed ids. Each result is coerced to the declared type. A problem
 * (division by zero, text that isn't a number, a value that doesn't fit the
 * type) leaves the cell empty or as-is and flags it.
 */
export function applyComputed(ctx: RunCtx, rows: Row[], computed: Computed[]): void {
  if (computed.length === 0) return;
  const env = { slotOf: ctx.plan.slotOf, language: ctx.language };
  const compiled: { id: string; slot: number; fn: Fn; type: Computed['type'] }[] = computed.map((c) => ({
    id: c.id,
    slot: slotOrThrow(ctx.plan, c.id),
    fn: compileExpr(c.expr, env),
    type: c.type,
  }));
  const cx = newEvalCx();
  const issue = newIssue();

  for (const row of rows) {
    const v = row.v;
    for (const c of compiled) {
      resetCx(cx);
      const raw = c.fn(v, cx);
      if (cx.problem !== null) {
        v[c.slot] = null;
        flagRow(ctx, row, c.slot, {
          column: c.id,
          rule: 'expr',
          value: cx.problemValue,
          messageKey: cx.problem,
        });
        continue;
      }
      const val = coerceTo(raw, c.type, issue);
      v[c.slot] = val;
      if (issue.key !== null) {
        flagRow(ctx, row, c.slot, {
          column: c.id,
          rule: 'type',
          value: raw,
          messageKey: issue.key,
          params: { type: c.type },
        });
      }
    }
  }
}

/**
 * Value maps: the cell's text is looked up exactly, then after normalizeText.
 * A hit replaces the value; a miss keeps it, flagged with
 * "flag.valueMapMissing" when onMissing is "flag". Empty cells are left alone.
 */
export function applyValueMaps(ctx: RunCtx, rows: Row[], maps: ValueMap[]): void {
  for (const vm of maps) {
    const slot = slotOrThrow(ctx.plan, vm.column);
    const exact = new Map<string, string>();
    const loose = new Map<string, string>();
    for (const [from, to] of Object.entries(vm.map)) {
      exact.set(from, to);
      const k = normText(from);
      if (!loose.has(k)) loose.set(k, to);
    }
    for (const row of rows) {
      const v = row.v[slot] ?? null;
      if (v === null) continue;
      const t = toText(v);
      const to = exact.get(t) ?? loose.get(normText(t));
      if (to !== undefined) {
        row.v[slot] = to === '' ? null : to;
      } else if (vm.onMissing === 'flag') {
        flagRow(ctx, row, slot, {
          column: vm.column,
          rule: 'valueMap',
          value: v,
          messageKey: 'flag.valueMapMissing',
        });
      }
    }
  }
}
