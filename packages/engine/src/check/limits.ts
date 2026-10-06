// SPEC 9.2 layer 4 ("Limits and safety") / SPEC 21 (v3 amendments): "checkLimits(rules,
// tier) -> problems[] for depth, node budget (after expanding calls), function and
// table counts, call-graph cycles, table key uniqueness and the rule count."
//
// Pure, structural checks - no type information needed, unlike typeCheck.ts. Some of
// these overlap on purpose with `packages/shared/src/rules/check.ts` (SPEC 9.2 places
// depth, an acyclic call graph and unique table keys under layer 4 "Limits", even
// though `checkRules`, which runs earlier as layer 2 "References", already guards them
// defensively while resolving `call`/`lookup` references). Both are kept in sync
// through the same `limits.rules.maxExprDepth` config value, so they can never disagree.
import type { Computed, Expr, ExprNode, LearnResult, Rules, RulesFunction, RulesTable, Tier } from '@formatai/shared';
import { contentLimitMessage, contentLimitProblems, limits, tiers } from '@formatai/shared';

export interface LimitProblem {
  kind: 'limit';
  path?: string;
  message: string;
}

// ---------- Generic expression-tree walking (structure only, no type info) ----------
// Deliberately op-agnostic (unlike typeCheck.ts's per-op switch, which needs to know
// each op's argument roles to type them): every Expr-shaped value reachable from an
// op's own fields - however that op is shaped (`arg`, `args`, `cond`/`then`/`else`,
// `cases`, `key`, ...) - is a child, full stop. That is all depth/node counting needs.

function looksLikeExpr(v: unknown): v is Expr {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return 'col' in o || 'const' in o || 'param' in o || typeof o.op === 'string';
}

function visitValue(value: unknown, visit: (child: Expr) => void): void {
  if (Array.isArray(value)) {
    for (const item of value) visitValue(item, visit);
    return;
  }
  if (looksLikeExpr(value)) {
    visit(value);
    return;
  }
  if (typeof value === 'object' && value !== null) {
    for (const v of Object.values(value)) visitValue(v, visit);
  }
}

/** Every direct child Expr of a node, regardless of which op it is (leaves have none). */
function exprChildren(expr: Expr): Expr[] {
  if ('col' in expr || 'const' in expr || 'param' in expr) return [];
  const children: Expr[] = [];
  for (const [key, value] of Object.entries(expr)) {
    if (key === 'op') continue;
    visitValue(value, (child) => children.push(child));
  }
  return children;
}

/** A window node's `by` / `order` columns are references too, but plain strings a generic child walk does not see. */
function windowRefIds(expr: Expr): string[] {
  if (!('op' in expr) || expr.op !== 'window') return [];
  return [...(expr.by ?? []), ...(expr.order ?? []).map((k) => k.column)];
}

type WindowNode = Extract<ExprNode, { op: 'window' }>;

/** Every across-row function call in `expr` (and its children). */
function windowNodes(expr: Expr, into: WindowNode[] = []): WindowNode[] {
  if ('op' in expr && expr.op === 'window') into.push(expr);
  for (const child of exprChildren(expr)) windowNodes(child, into);
  return into;
}

function exprDepth(expr: Expr): number {
  const children = exprChildren(expr);
  if (children.length === 0) return 1;
  return 1 + Math.max(...children.map(exprDepth));
}

// ---------- Node budgets, after expanding function calls (SPEC 8.3, 21) ----------

interface LimitsCtx {
  functionsByName: ReadonlyMap<string, RulesFunction>;
}

/**
 * Counts every node in `expr`, inlining a function's body at every `call` site (SPEC
 * 8.3: "200 nodes per output column after expanding function calls"; SPEC 21/test: "a
 * function used 3 times counts 3x"). `visiting` guards against runaway recursion on a
 * cyclic call graph; `checkRules` and this file's own `findCallGraphCycles` both already
 * reject cycles, so this is a last-resort safety net, not the primary defense.
 */
function countNodes(expr: Expr, ctx: LimitsCtx, visiting: ReadonlySet<string> = new Set()): number {
  if ('col' in expr || 'const' in expr || 'param' in expr) return 1;
  let count = 1;
  for (const child of exprChildren(expr)) count += countNodes(child, ctx, visiting);
  if (expr.op === 'call' && !visiting.has(expr.fn)) {
    const fn = ctx.functionsByName.get(expr.fn);
    if (fn) count += countNodes(fn.body, ctx, new Set([...visiting, expr.fn]));
  }
  return count;
}

/**
 * The node count charged to one output column: its own feeding expression plus - SPEC
 * 21/task: "count the computed chain feeding that column too" - every `transform.
 * computed` step upstream of it, transitively (e.g. computed B reads computed A via
 * `{col:'A'}`: A's own nodes are added on top of the single node that reference costs
 * in B). DECISION: only `transform.computed` chains are walked here, not `expand`
 * (SPEC 8.14/21 names "the computed chain" specifically; expand-created ids that feed a
 * column directly - e.g. a `splitCell` part - contribute no further expression of their
 * own to add).
 */
function nodeCountForId(id: string, computedById: ReadonlyMap<string, Computed>, ctx: LimitsCtx, visiting: Set<string>): number {
  const computed = computedById.get(id);
  if (!computed || visiting.has(id)) return 0;
  visiting.add(id);
  let total = countNodes(computed.expr, ctx);
  for (const child of exprChildren(computed.expr)) {
    total += sumReferencedComputedNodes(child, computedById, ctx, visiting);
  }
  for (const id of windowRefIds(computed.expr)) total += nodeCountForId(id, computedById, ctx, visiting);
  visiting.delete(id);
  return total;
}

function sumReferencedComputedNodes(
  expr: Expr,
  computedById: ReadonlyMap<string, Computed>,
  ctx: LimitsCtx,
  visiting: Set<string>,
): number {
  if ('col' in expr) return nodeCountForId(expr.col, computedById, ctx, visiting);
  if ('const' in expr || 'param' in expr) return 0;
  let total = 0;
  for (const child of exprChildren(expr)) total += sumReferencedComputedNodes(child, computedById, ctx, visiting);
  for (const id of windowRefIds(expr)) total += nodeCountForId(id, computedById, ctx, visiting);
  return total;
}

// ---------- Acyclic call graph (defensive; SPEC 9.2 layer 4) ----------

function findCallGraphCycle(functions: readonly RulesFunction[]): string[] | undefined {
  const byName = new Map(functions.map((fn) => [fn.name, fn] as const));
  const calleesOf = (fn: RulesFunction): string[] => {
    const callees: string[] = [];
    const walk = (e: Expr): void => {
      if ('col' in e || 'const' in e || 'param' in e) return;
      if (e.op === 'call') callees.push(e.fn);
      for (const child of exprChildren(e)) walk(child);
    };
    walk(fn.body);
    return callees;
  };

  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>(functions.map((fn) => [fn.name, WHITE] as const));
  const stack: string[] = [];

  function dfs(name: string): string[] | undefined {
    color.set(name, GRAY);
    stack.push(name);
    const fn = byName.get(name);
    if (fn) {
      for (const callee of calleesOf(fn)) {
        if (!byName.has(callee)) continue; // unknown callee: checkRules reports this
        const c = color.get(callee);
        if (c === GRAY) return [...stack, callee];
        if (c === WHITE) {
          const found = dfs(callee);
          if (found) return found;
        }
      }
    }
    stack.pop();
    color.set(name, BLACK);
    return undefined;
  }

  for (const fn of functions) {
    if (color.get(fn.name) === WHITE) {
      const cycle = dfs(fn.name);
      if (cycle) return cycle;
    }
  }
  return undefined;
}

// ---------- Table key uniqueness (defensive; SPEC 9.2 layer 4) ----------

function findDuplicateTableKeys(table: RulesTable): unknown[] {
  const seen = new Set<unknown>();
  const duplicates: unknown[] = [];
  for (const row of table.rows) {
    const key = row[0] ?? null;
    if (seen.has(key)) duplicates.push(key);
    else seen.add(key);
  }
  return duplicates;
}

// ---------- Rule counting (SPEC 8.14/11) ----------

/**
 * SPEC 8.14: "Every function, table, output column, filter, dedupe, expand, sort,
 * group and validation counts as one rule." DECISION: SPEC 8.14 names "sort" itself
 * (singular) as one countable item, not "one rule per sort key" - the rules-map editor
 * (8.11) likewise shows one "Sort" line under Layout regardless of how many keys it
 * has. Counted here as at most one rule for the whole `transform.sort` list (zero when
 * it's empty), not one per key.
 *
 * Docs/proposals/window-operations.md: each across-row (window) function call counts as one rule too, on top of the output column
 * it feeds (like sort and group, a window is a step of its own).
 *
 * SPEC 21 v4: each `summaryRows` entry (`output.summaryRows` and
 * `transform.group.summaryRows`) counts as one rule too. The deprecated
 * `grandTotal`/`subtotal` were never counted on their own (folded into "group" above,
 * or free for `grandTotal`) - that stays unchanged for stored rules files that still
 * carry them (SPEC 21 v4 backward compatibility), so an old-style rules file's rule
 * count doesn't retroactively grow.
 */
function countRules(rules: LearnResult | Rules): number {
  const functions = rules.transform.functions?.length ?? 0;
  const tables = rules.transform.tables?.length ?? 0;
  const outputColumns = rules.output.columns.length;
  const filters = rules.input.rowFilters?.length ?? 0;
  const dedupe = rules.transform.dedupe ? 1 : 0;
  const expand = rules.transform.expand ? 1 : 0;
  const sort = rules.transform.sort.length > 0 ? 1 : 0;
  const group = rules.transform.group ? 1 : 0;
  const validations = rules.validations.length;
  const outputSummaryRows = rules.output.summaryRows?.length ?? 0;
  const groupSummaryRows = rules.transform.group?.summaryRows?.length ?? 0;
  const windows = rules.transform.computed.reduce((n, c) => n + windowNodes(c.expr).length, 0);
  return (
    functions +
    tables +
    outputColumns +
    filters +
    dedupe +
    expand +
    sort +
    group +
    validations +
    outputSummaryRows +
    groupSummaryRows +
    windows
  );
}

// ---------- The public entry point ----------

export function checkLimits(rules: LearnResult | Rules, tier: Tier): LimitProblem[] {
  const problems: LimitProblem[] = [];
  const functions = rules.transform.functions ?? [];
  const tables = rules.transform.tables ?? [];
  const ctx: LimitsCtx = { functionsByName: new Map(functions.map((fn) => [fn.name, fn] as const)) };
  const computedById = new Map(rules.transform.computed.map((c) => [c.id, c] as const));

  // ----- depth, per expression (SPEC 8.3: depth 8) -----
  const topLevelExprs: { path: string; expr: Expr }[] = [];
  rules.input.rowFilters?.forEach((f, i) => {
    if ('expr' in f) topLevelExprs.push({ path: `input.rowFilters[${i}].expr`, expr: f.expr });
  });
  rules.transform.computed.forEach((c, i) => topLevelExprs.push({ path: `transform.computed[${i}].expr`, expr: c.expr }));
  functions.forEach((fn, i) => topLevelExprs.push({ path: `transform.functions[${i}].body`, expr: fn.body }));
  if (rules.transform.expand?.mode === 'fixedFanOut') {
    rules.transform.expand.rows.forEach((row, ri) => {
      for (const [id, expr] of Object.entries(row.set)) {
        topLevelExprs.push({ path: `transform.expand.rows[${ri}].set.${id}`, expr });
      }
    });
  }
  for (const { path, expr } of topLevelExprs) {
    const depth = exprDepth(expr);
    if (depth > limits.rules.maxExprDepth) {
      problems.push({
        kind: 'limit',
        path,
        message: `expression nesting depth ${depth} exceeds the maximum of ${limits.rules.maxExprDepth}`,
      });
    }
  }

  // ----- node budget per output column, after expanding calls (SPEC 8.3, 21) -----
  rules.output.columns.forEach((col, i) => {
    if (col.from === null) return;
    const nodeCount = nodeCountForId(col.from, computedById, ctx, new Set());
    if (nodeCount > limits.rules.maxNodesPerOutputColumn) {
      problems.push({
        kind: 'limit',
        path: `output.columns[${i}]`,
        message: `output column "${col.header}" uses ${nodeCount} expression nodes (limit ${limits.rules.maxNodesPerOutputColumn})`,
      });
    }
  });

  // ----- across-row functions: how many, and how many columns each `by:` / `order:` names (docs/proposals/window-operations.md) -----
  const windows: { path: string; node: WindowNode }[] = [];
  for (const { path, expr } of topLevelExprs) for (const node of windowNodes(expr)) windows.push({ path, node });
  if (windows.length > limits.rules.maxWindowOps) {
    problems.push({
      kind: 'limit',
      path: 'transform.computed',
      message: `${windows.length} across-row functions (runningSum, rank, ...) exceed the maximum of ${limits.rules.maxWindowOps} per file`,
    });
  }
  for (const { path, node } of windows) {
    for (const [what, n] of [['by', node.by?.length ?? 0], ['order', node.order?.length ?? 0]] as const) {
      if (n > limits.rules.maxWindowKeys) {
        problems.push({
          kind: 'limit',
          path,
          message: `${node.fn}() names ${n} columns in ${what}:, more than the maximum of ${limits.rules.maxWindowKeys}`,
        });
      }
    }
  }

  // ----- function and table counts (SPEC 8.3: 20 functions, 20 tables of up to 500 rows) -----
  if (functions.length > limits.rules.maxFunctions) {
    problems.push({
      kind: 'limit',
      path: 'transform.functions',
      message: `${functions.length} functions exceeds the maximum of ${limits.rules.maxFunctions}`,
    });
  }
  if (tables.length > limits.rules.maxTables) {
    problems.push({
      kind: 'limit',
      path: 'transform.tables',
      message: `${tables.length} tables exceeds the maximum of ${limits.rules.maxTables}`,
    });
  }
  tables.forEach((table, i) => {
    if (table.rows.length > limits.rules.maxTableRows) {
      problems.push({
        kind: 'limit',
        path: `transform.tables[${i}]`,
        message: `table "${table.name}" has ${table.rows.length} rows, exceeding the maximum of ${limits.rules.maxTableRows}`,
      });
    }
    const duplicateKeys = findDuplicateTableKeys(table);
    for (const key of duplicateKeys) {
      problems.push({
        kind: 'limit',
        path: `transform.tables[${i}]`,
        message: `table "${table.name}" has a duplicate key "${String(key)}"`,
      });
    }
  });

  // ----- what one input column reads another way (SPEC 8.4a `readAs`): a cap per column, so a rules file stays small -----
  rules.input.columns.forEach((col, i) => {
    const n = col.readAs === undefined ? 0 : Object.keys(col.readAs).length;
    if (n > limits.rules.maxReadAsPerColumn) {
      problems.push({
        kind: 'limit',
        path: `input.columns[${i}].readAs`,
        message: `column "${col.header}" reads ${n} cell texts another way, exceeding the maximum of ${limits.rules.maxReadAsPerColumn}`,
      });
    }
  });

  // ----- what one saved format may keep (docs/proposals/saved-format-contents.md section 7; SPEC 21 v15): a value map's entries, one value's
  // characters, one version's bytes (shared `contentLimitProblems`, which the server checks again on every route that stores rules) -----
  for (const p of contentLimitProblems(rules)) {
    problems.push({ kind: 'limit', ...(p.code === 'rulesBytes' ? { path: '' } : { path: p.path }), message: contentLimitMessage(p) });
  }

  // ----- acyclic call graph (defensive; SPEC 8.14 already makes it acyclic by
  // construction via "a function may call only functions defined above it", enforced
  // by checkRules) -----
  const cycle = findCallGraphCycle(functions);
  if (cycle) {
    problems.push({
      kind: 'limit',
      path: 'transform.functions',
      message: `function call graph has a cycle: ${cycle.join(' -> ')}`,
    });
  }

  // ----- rule count vs. tier (SPEC 8.14, 11) -----
  const ruleCount = countRules(rules);
  const tierLimit = tiers[tier].rulesPerFormat;
  if (ruleCount > tierLimit) {
    problems.push({
      kind: 'limit',
      message: `${ruleCount} rules exceeds the "${tier}" tier's limit of ${tierLimit} rules per format`,
    });
  }

  return problems;
}
