// Steps 6-7 (SPEC 8.2): computed columns and value maps.

import type { Computed, ExprNode, ValueMap } from '@formatai/shared';
import { compileExpr, newEvalCx, resetCx, type EvalCx, type Fn } from './expr';
import { coerceTo, newIssue } from './normalize';
import { flagRow, slotOrThrow, type Row, type RunCtx } from './rows';
import { normText, toText } from './values';
import { WindowEngine, collectWindows } from './window';

interface CompiledColumn {
  id: string;
  slot: number;
  fn: Fn;
  type: Computed['type'];
}

/**
 * Computed columns run in order, once per (expanded) row, and may reference
 * earlier computed ids. Each result is coerced to the declared type. A problem
 * (division by zero, text that isn't a number, a value that doesn't fit the
 * type) leaves the cell empty or as-is and flags it.
 *
 * A column that holds an across-row (window) function runs column-major instead: each window is first computed over ALL rows
 * (window.ts) into a hidden row slot, then the column's expression runs per row and reads it. The columns before it are complete by
 * then, so a window may read any earlier computed column, including another window's result. Rules without a window take the
 * plain row-major path below, unchanged.
 */
export function applyComputed(ctx: RunCtx, rows: Row[], computed: Computed[]): void {
  if (computed.length === 0) return;
  const windowsOf = computed.map((c) => collectWindows(c.expr));
  // Hidden slots, after the declared ones, numbered in the order planSlots counted them (see run.ts).
  const windowSlots = new Map<ExprNode, number>();
  let nextHidden = ctx.plan.windowBase;
  for (const ws of windowsOf) for (const w of ws) windowSlots.set(w, nextHidden++);
  const env = {
    slotOf: ctx.plan.slotOf,
    language: ctx.language,
    functions: ctx.functions,
    tables: ctx.tables,
    ...(windowSlots.size > 0 ? { windowSlots } : {}),
  };
  const compiled: CompiledColumn[] = computed.map((c) => ({
    id: c.id,
    slot: slotOrThrow(ctx.plan, c.id),
    fn: compileExpr(c.expr, env),
    type: c.type,
  }));
  const cx = newEvalCx();
  const issue = newIssue();

  if (windowSlots.size === 0) {
    runColumns(ctx, rows, compiled, cx, issue);
    return;
  }

  let engine: WindowEngine | undefined;
  let i = 0;
  while (i < computed.length) {
    if ((windowsOf[i] as unknown[]).length === 0) {
      let j = i;
      while (j < computed.length && (windowsOf[j] as unknown[]).length === 0) j++;
      runColumns(ctx, rows, compiled.slice(i, j), cx, issue);
      i = j;
      continue;
    }
    engine ??= new WindowEngine(rows, ctx.plan.slotOf);
    for (const w of windowsOf[i] as ExprNode[]) {
      const slot = windowSlots.get(w) as number;
      const values = engine.compute(w as Extract<ExprNode, { op: 'window' }>);
      for (let r = 0; r < rows.length; r++) (rows[r] as Row).v[slot] = values[r] ?? null;
    }
    runColumns(ctx, rows, [compiled[i] as CompiledColumn], cx, issue);
    i++;
  }
}

function runColumns(ctx: RunCtx, rows: Row[], compiled: CompiledColumn[], cx: EvalCx, issue: ReturnType<typeof newIssue>): void {
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
