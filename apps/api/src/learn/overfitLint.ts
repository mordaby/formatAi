// SPEC 9.2 layer 6 "Overfitting lint": never a rejection. Each finding becomes an
// `assumptions` entry with reasonCode `overfitSuspected` (SPEC 8.10/`codes.ts`),
// code-added rather than LLM-written, so the rules map shows it as a "Please check"
// line (SPEC 8.11) even though the LLM never wrote that assumption itself.
//
// These are heuristics over the small sample the API sees (LEARN_PROMPT: at most 12
// pairs / 6 families), not a full evaluator - SPEC 9.2 names four kinds of finding and
// leaves the exact thresholds unspecified ("far larger than any other column's"), so
// each one documents the call it makes.
import type { Assumption, Expr, LearnPayload, LearnResult, PayloadCell, Rules } from '@formatai/shared';

/** Every distinct value that appears anywhere in a sample's `in` row, keyed by
 * `JSON.stringify` (stable across string/number/boolean), mapped to how many
 * DISTINCT sample rows contain it at least once. A value found in exactly one row is
 * a candidate for "hard-coded from that row" (SPEC 9.2 layer 6, first and second
 * bullets - a filter's literal is checked the same way as a computed constant, since
 * evaluating the filter's condition against every sample would need a full
 * expression evaluator this lint deliberately doesn't carry). */
function sampleValueRowCounts(payload: LearnPayload): Map<string, number> {
  const counts = new Map<string, number>();
  for (const sample of payload.samples) {
    const seen = new Set<string>();
    for (const cell of sample.in) {
      if (cell === null) continue;
      const key = JSON.stringify(cell);
      if (seen.has(key)) continue;
      seen.add(key);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return counts;
}

/** DECISION: trivial literals that are legitimately reused across every rule
 * regardless of the data (rounding digits, signs, blank-string checks) are excluded
 * from the "appears in only one sample row" check, or every rules file would flag
 * `{const: 0}`/`{const: 1}` on its first `round`/`mul`. */
function isTrivialConst(v: PayloadCell): boolean {
  return v === null || typeof v === 'boolean' || v === '' || v === 0 || v === 1 || v === -1;
}

function exprChildren(e: Expr): Expr[] {
  if ('col' in e || 'const' in e || 'param' in e) return [];
  const children: Expr[] = [];
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) {
      for (const item of v) walk(item);
      return;
    }
    if (v !== null && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      if ('col' in o || 'const' in o || 'param' in o || typeof o.op === 'string') {
        children.push(o as unknown as Expr);
        return;
      }
      for (const value of Object.values(o)) walk(value);
    }
  };
  for (const [key, value] of Object.entries(e)) {
    if (key === 'op') continue;
    walk(value);
  }
  return children;
}

function countNodes(e: Expr): number {
  let n = 1;
  for (const c of exprChildren(e)) n += countNodes(c);
  return n;
}

function walkConsts(e: Expr, visit: (v: PayloadCell) => void): void {
  if ('const' in e) {
    visit(e.const as PayloadCell);
    return;
  }
  if ('col' in e || 'param' in e) return;
  if (e.op === 'switch') {
    for (const c of e.cases) {
      walkConsts(c.when, visit);
      walkConsts(c.then, visit);
    }
    walkConsts(e.else, visit);
    return;
  }
  for (const c of exprChildren(e)) walkConsts(c, visit);
}

/** The output column (by header) whose `from` traces to this computed/id, when one
 * exists - omitted from the assumption otherwise (SPEC 8.10: "outputColumn is omitted
 * for row-level guesses such as filters"). */
function outputHeaderFor(rules: LearnResult | Rules, id: string): string | undefined {
  return rules.output.columns.find((c) => c.from === id)?.header;
}

interface LintCtx {
  rules: LearnResult | Rules;
  valueRowCounts: Map<string, number>;
  sampleCount: number;
  found: Assumption[];
  seen: Set<string>;
}

function add(ctx: LintCtx, outputColumn: string | undefined): void {
  const key = outputColumn ?? '';
  if (ctx.seen.has(key)) return; // one "Please check" line per column/row-level guess
  ctx.seen.add(key);
  const assumption: Assumption = { reasonCode: 'overfitSuspected' };
  if (outputColumn !== undefined) assumption.outputColumn = outputColumn;
  ctx.found.push(assumption);
}

/** Bullets 1-2 (SPEC 9.2 layer 6): a constant, anywhere in an expression, equal to a
 * value seen in exactly one sample row. */
function lintConstants(ctx: LintCtx, expr: Expr, outputColumn: string | undefined): void {
  walkConsts(expr, (v) => {
    if (isTrivialConst(v)) return;
    if (ctx.valueRowCounts.get(JSON.stringify(v)) === 1) add(ctx, outputColumn);
  });
}

/** Bullet 3: a switch, value map or table with one entry per sample row. */
function lintOneEntryPerSample(ctx: LintCtx): void {
  const { rules, sampleCount } = ctx;
  if (sampleCount < 2) return; // one sample row always has "one entry per row" trivially

  for (const vm of rules.transform.valueMaps) {
    if (Object.keys(vm.map).length === sampleCount) {
      add(ctx, outputHeaderFor(rules, vm.column));
    }
  }
  for (const table of rules.transform.tables ?? []) {
    if (table.rows.length === sampleCount) add(ctx, undefined);
  }

  const visitSwitches = (expr: Expr, outputColumn: string | undefined): void => {
    if ('col' in expr || 'const' in expr || 'param' in expr) return;
    if (expr.op === 'switch' && expr.cases.length === sampleCount) add(ctx, outputColumn);
    for (const c of exprChildren(expr)) visitSwitches(c, outputColumn);
  };
  for (const c of rules.transform.computed) visitSwitches(c.expr, outputHeaderFor(rules, c.id));
  for (const fn of rules.transform.functions ?? []) visitSwitches(fn.body, undefined);
}

/** Bullet 4: an expression far larger than any other column's. DECISION: "far larger"
 * is read as more than 3x the largest of every other output column's own expression
 * (a floor of 8 nodes keeps two small, ordinary expressions from tripping this on each
 * other - e.g. a plain `round(mul(...))` is already 4-5 nodes). */
function lintOutlierSize(ctx: LintCtx): void {
  const { rules } = ctx;
  const computedById = new Map(rules.transform.computed.map((c) => [c.id, c] as const));
  const sizeByColumn = new Map<string, number>();
  for (const col of rules.output.columns) {
    if (col.from === null) continue;
    const computed = computedById.get(col.from);
    sizeByColumn.set(col.header, computed ? countNodes(computed.expr) : 1);
  }
  const entries = [...sizeByColumn.entries()];
  if (entries.length < 2) return;

  for (const [header, size] of entries) {
    const otherMax = Math.max(0, ...entries.filter(([h]) => h !== header).map(([, s]) => s));
    if (size >= 8 && size > otherMax * 3) add(ctx, header);
  }
}

/**
 * Runs every overfitting-lint heuristic and returns the `overfitSuspected`
 * assumptions to append to `rules.assumptions` (SPEC 9.2 layer 6). Never mutates
 * `rules`; the caller decides how to merge the result in.
 */
export function overfitLint(rules: LearnResult | Rules, payload: LearnPayload): Assumption[] {
  const ctx: LintCtx = {
    rules,
    valueRowCounts: sampleValueRowCounts(payload),
    sampleCount: payload.samples.length,
    found: [],
    seen: new Set(),
  };

  for (const c of rules.transform.computed) {
    lintConstants(ctx, c.expr, outputHeaderFor(rules, c.id));
  }
  for (const f of rules.input.rowFilters ?? []) {
    if ('expr' in f) {
      lintConstants(ctx, f.expr, undefined);
    } else if ('value' in f && f.value !== null) {
      const values = Array.isArray(f.value) ? f.value : [f.value];
      for (const v of values) {
        if (!isTrivialConst(v) && ctx.valueRowCounts.get(JSON.stringify(v)) === 1) {
          add(ctx, undefined);
        }
      }
    }
  }
  lintOneEntryPerSample(ctx);
  lintOutlierSize(ctx);

  return ctx.found;
}
