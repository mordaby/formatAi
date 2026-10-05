// Code checks that go beyond what zod can express (SPEC 9.2): every referenced
// column id, function, table and param exists at the point it's used, ids are
// unique and expand-created ids don't collide, function calls only reach
// functions defined above them (so the call graph is acyclic by construction,
// SPEC 8.14), lookup tables exist with unique columns and unique first-column
// keys, and expression nesting depth stays within the configured limit (SPEC 8.3).
//
// Node budgets, rule-count limits and static TYPE checking are NOT here: SPEC 9.2
// layers 3-4 (types, limits) belong to the engine's typeCheck/checkLimits, which
// read this same rules language but need the input profile and the tier.
//
// Engine pipeline order (SPEC 8.2 / LEARN_PROMPT "Operations"):
//   read -> rowFilters -> dedupe -> expand -> computed -> valueMaps -> sort -> group -> output -> validations
import { limits } from '../config/limits';
import { WINDOW_FNS, type CutoffRangeValidation, type Expr, type ExprNode, type LearnResult, type Rules, type SummaryRow, type TableCellValue } from './schema';

export type RuleProblemKind = 'reference' | 'depth' | 'duplicateId' | 'arity';

export interface RuleProblem {
  kind: RuleProblemKind;
  /** Dotted/bracketed path to the offending field, e.g. "transform.computed[0].expr". */
  path: string;
  message: string;
}

export interface CheckRulesOptions {
  /**
   * Reject a `transform.functions` name that is one of the formula language's across-row function names (rank, next,
   * previous, ...): printed as formula text and read back, such a function would be taken for the built-in. For NEW rules
   * only (what the AI writes, what the editor adds): a stored file is never refused for it, so `call` nodes already saved
   * keep running (`runRules` does not pass this).
   */
  rejectBuiltinFunctionNames?: boolean;
}

/** SPEC 8.3 (v3): depth 8 per expression. Read from config (SPEC non-negotiable #8),
 * never hard-coded. */
const MAX_EXPR_DEPTH = limits.rules.maxExprDepth;

/** Every direct child Expr of a node (leaves have none). */
function exprChildren(e: Expr): Expr[] {
  if ('col' in e || 'const' in e || 'param' in e) return [];
  switch (e.op) {
    case 'add':
    case 'sub':
    case 'mul':
    case 'div':
    case 'concat':
    case 'coalesce':
    case 'and':
    case 'or':
    case 'min':
    case 'max':
      return e.args;
    case 'mod':
    case 'makeDate':
    case 'eq':
    case 'ne':
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte':
    case 'dateDiff':
      return e.args;
    case 'neg':
    case 'abs':
    case 'floor':
    case 'ceil':
    case 'round':
    case 'substr':
    case 'trim':
    case 'upper':
    case 'lower':
    case 'length':
    case 'replaceText':
    case 'padLeft':
    case 'split':
    case 'toNumber':
    case 'toText':
    case 'datePart':
    case 'dateFormat':
    case 'dateAdd':
    case 'endOfMonth':
    case 'weekday':
    case 'toDate':
    case 'keepChars':
    case 'titleCase':
    case 'find':
    case 'isEmpty':
    case 'notEmpty':
    case 'not':
    case 'oneOf':
    case 'startsWith':
    case 'endsWith':
    case 'contains':
      return [e.arg];
    case 'if':
      return [e.cond, e.then, e.else];
    case 'switch': {
      const children: Expr[] = [];
      for (const c of e.cases) {
        children.push(c.when, c.then);
      }
      children.push(e.else);
      return children;
    }
    case 'lookup':
      return [e.key];
    case 'call':
      return e.args;
    case 'dateLiteral':
      return [];
    case 'window':
      return e.arg === undefined ? [] : [e.arg];
  }
}

function exprDepth(e: Expr): number {
  const children = exprChildren(e);
  if (children.length === 0) return 1;
  return 1 + Math.max(...children.map(exprDepth));
}

function checkRef(
  id: string,
  available: ReadonlySet<string>,
  path: string,
  problems: RuleProblem[],
): void {
  if (!available.has(id)) {
    problems.push({ kind: 'reference', path, message: `unknown column id "${id}"` });
  }
}

/** SPEC 8.12 v4: a `SummaryRow`'s `labelColumn`/`cells` name OUTPUT HEADERS, not ids
 * (unlike the deprecated, id-based `grandTotal`/`subtotal` checked alongside it). */
function checkSummaryRowRefs(
  row: SummaryRow,
  outputHeaders: ReadonlySet<string>,
  path: string,
  problems: RuleProblem[],
): void {
  if (row.labelColumn !== undefined && !outputHeaders.has(row.labelColumn)) {
    problems.push({
      kind: 'reference',
      path: `${path}.labelColumn`,
      message: `unknown output header "${row.labelColumn}"`,
    });
  }
  for (const header of Object.keys(row.cells)) {
    if (!outputHeaders.has(header)) {
      problems.push({ kind: 'reference', path: `${path}.cells`, message: `unknown output header "${header}"` });
    }
  }
}

function addNewId(
  id: string,
  existing: ReadonlySet<string>,
  newlyAdded: Set<string>,
  path: string,
  problems: RuleProblem[],
): void {
  if (existing.has(id) || newlyAdded.has(id)) {
    problems.push({
      kind: 'duplicateId',
      path,
      message: `id "${id}" collides with an existing column id`,
    });
  } else {
    newlyAdded.add(id);
  }
}

interface ExprCheckContext {
  /** Functions in declaration order, keyed by name. A `call` inside a function body may
   * only name a function whose index is strictly less than the caller's (SPEC 8.14:
   * "A function may call only functions defined above it" - this makes the call graph
   * acyclic by construction, so no separate cycle-detection pass is needed). A top-level
   * `call` (outside any function body) may name any declared function. */
  functionsByName: Map<string, { index: number; paramCount: number }>;
  tablesByName: Map<string, { columns: ReadonlySet<string> }>;
}

interface ExprCheckScope {
  /** `col` ids in scope for a top-level expr (computed, rowFilters.expr, the fixedFanOut
   * `set` expressions). Omit when checking a function body, where `col` is never valid
   * (SPEC 8.14: "a body may use its params, constants and other functions... but never
   * col: a function sees only what it is given"). */
  colIds?: ReadonlySet<string>;
  /** A function body's declared param names. Omit for top-level exprs, where `param`
   * is never valid (SPEC 8.3: "param" leaf, "only inside a function body"). */
  paramNames?: ReadonlySet<string>;
  /** Set to the function's own index while checking that function's body, so `call`
   * can enforce "defined above it". Omitted for top-level exprs. */
  callerFunctionIndex?: number;
  /** True only for `transform.computed[].expr`: window functions (runningSum, ...) run in that step, over all rows, so
   * nowhere else (row filters and fan-out values run before it, function bodies are pure) may contain one. */
  allowWindow?: boolean;
}

/** Walks an expression tree, checking depth once for the whole tree plus, per node:
 * `col`/`param` references against the given scope, and `call`/`lookup` references
 * against the rules file's declared functions/tables. */
function checkExprTree(
  expr: Expr,
  scope: ExprCheckScope,
  ctx: ExprCheckContext,
  path: string,
  problems: RuleProblem[],
): void {
  const depth = exprDepth(expr);
  if (depth > MAX_EXPR_DEPTH) {
    problems.push({
      kind: 'depth',
      path,
      message: `expression nesting depth ${depth} exceeds the maximum of ${MAX_EXPR_DEPTH}`,
    });
  }

  const walk = (e: Expr, p: string): void => {
    if ('col' in e) {
      if (scope.colIds) {
        checkRef(e.col, scope.colIds, p, problems);
      } else {
        problems.push({
          kind: 'reference',
          path: p,
          message: 'a function body cannot reference "col"; use "param" instead',
        });
      }
      return;
    }
    if ('const' in e) return;
    if ('param' in e) {
      if (scope.paramNames) {
        if (!scope.paramNames.has(e.param)) {
          problems.push({ kind: 'reference', path: p, message: `unknown param "${e.param}"` });
        }
      } else {
        problems.push({
          kind: 'reference',
          path: p,
          message: '"param" is only allowed inside a function body',
        });
      }
      return;
    }

    const node = e as ExprNode;
    if (node.op === 'call') {
      const fn = ctx.functionsByName.get(node.fn);
      if (!fn) {
        problems.push({ kind: 'reference', path: p, message: `unknown function "${node.fn}"` });
      } else {
        if (scope.callerFunctionIndex !== undefined && fn.index >= scope.callerFunctionIndex) {
          problems.push({
            kind: 'reference',
            path: p,
            message: `function "${node.fn}" must be defined above the function that calls it`,
          });
        }
        if (node.args.length !== fn.paramCount) {
          problems.push({
            kind: 'arity',
            path: p,
            message: `function "${node.fn}" takes ${fn.paramCount} argument(s), got ${node.args.length}`,
          });
        }
      }
      node.args.forEach((a, i) => walk(a, `${p}.args[${i}]`));
      return;
    }

    if (node.op === 'window') {
      if (!scope.allowWindow) {
        problems.push({
          kind: 'reference',
          path: p,
          message: `${node.fn}() is an across-row function and works only in a computed column's formula`,
        });
      }
      if (node.arg !== undefined && !('col' in node.arg)) {
        problems.push({
          kind: 'reference',
          path: `${p}.arg`,
          message: `${node.fn}() reads a column id; make a computed column first for anything calculated`,
        });
      }
      if (scope.colIds) {
        node.by?.forEach((id, i) => checkRef(id, scope.colIds as ReadonlySet<string>, `${p}.by[${i}]`, problems));
        node.order?.forEach((k, i) => checkRef(k.column, scope.colIds as ReadonlySet<string>, `${p}.order[${i}].column`, problems));
      }
      if (node.arg !== undefined) walk(node.arg, `${p}.arg`);
      return;
    }

    if (node.op === 'lookup') {
      const table = ctx.tablesByName.get(node.table);
      if (!table) {
        problems.push({ kind: 'reference', path: p, message: `unknown table "${node.table}"` });
      } else if (!table.columns.has(node.return)) {
        problems.push({
          kind: 'reference',
          path: p,
          message: `table "${node.table}" has no column "${node.return}"`,
        });
      }
      walk(node.key, `${p}.key`);
      return;
    }

    exprChildren(node).forEach((child, i) => walk(child, `${p}[${i}]`));
  };

  walk(expr, path);
}

/** Builds the functions/tables lookup context and checks their own declarations
 * (SPEC 8.14): unique names, unique params, unique table columns, unique first-column
 * (key) values, and - for each function body - that it only references its own params,
 * never `col`, and only calls functions defined above it. */
function checkFunctionsAndTables(
  rules: LearnResult | Rules,
  problems: RuleProblem[],
  opts: CheckRulesOptions,
): ExprCheckContext {
  const functionsByName = new Map<string, { index: number; paramCount: number }>();
  const functions = rules.transform.functions ?? [];
  functions.forEach((fn, i) => {
    if (opts.rejectBuiltinFunctionNames === true && (WINDOW_FNS as readonly string[]).includes(fn.name)) {
      problems.push({
        kind: 'duplicateId',
        path: `transform.functions[${i}].name`,
        message: `function name "${fn.name}" is a built-in function of the formula language; choose another name`,
      });
    }
    if (functionsByName.has(fn.name)) {
      problems.push({
        kind: 'duplicateId',
        path: `transform.functions[${i}].name`,
        message: `duplicate function name "${fn.name}"`,
      });
    } else {
      functionsByName.set(fn.name, { index: i, paramCount: fn.params.length });
    }
  });

  const tablesByName = new Map<string, { columns: ReadonlySet<string> }>();
  const tables = rules.transform.tables ?? [];
  tables.forEach((table, i) => {
    const columns = new Set(table.columns);
    if (tablesByName.has(table.name)) {
      problems.push({
        kind: 'duplicateId',
        path: `transform.tables[${i}].name`,
        message: `duplicate table name "${table.name}"`,
      });
    } else {
      tablesByName.set(table.name, { columns });
    }

    const seenColumns = new Set<string>();
    table.columns.forEach((col, ci) => {
      if (seenColumns.has(col)) {
        problems.push({
          kind: 'duplicateId',
          path: `transform.tables[${i}].columns[${ci}]`,
          message: `duplicate column name "${col}" in table "${table.name}"`,
        });
      } else {
        seenColumns.add(col);
      }
    });

    // SPEC 8.14: "The first column is the key and must be unique."
    const seenKeys = new Set<TableCellValue>();
    table.rows.forEach((row, ri) => {
      const key = row[0] ?? null;
      if (seenKeys.has(key)) {
        problems.push({
          kind: 'duplicateId',
          path: `transform.tables[${i}].rows[${ri}][0]`,
          message: `duplicate key "${String(key)}" in table "${table.name}"`,
        });
      } else {
        seenKeys.add(key);
      }
    });
  });

  const ctx: ExprCheckContext = { functionsByName, tablesByName };

  functions.forEach((fn, i) => {
    const paramNames = new Set<string>();
    fn.params.forEach((p, pi) => {
      if (paramNames.has(p.name)) {
        problems.push({
          kind: 'duplicateId',
          path: `transform.functions[${i}].params[${pi}].name`,
          message: `duplicate param name "${p.name}" in function "${fn.name}"`,
        });
      } else {
        paramNames.add(p.name);
      }
    });
    checkExprTree(
      fn.body,
      { paramNames, callerFunctionIndex: i },
      ctx,
      `transform.functions[${i}].body`,
      problems,
    );
  });

  return ctx;
}

/**
 * Validates cross-references, id uniqueness/collisions and expression depth in
 * an already schema-valid LearnResult/Rules object. Complements zod validation;
 * it does not re-check shapes zod already enforces, static types (engine typeCheck)
 * or size/count limits (engine checkLimits).
 */
export function checkRules(rules: LearnResult | Rules, opts: CheckRulesOptions = {}): RuleProblem[] {
  const problems: RuleProblem[] = [];

  // ----- Step -1: functions and tables (SPEC 8.14), independent of the row pipeline -----
  const ctx = checkFunctionsAndTables(rules, problems, opts);

  // ----- Step 0: input column ids must be unique -----
  const inputIds = new Set<string>();
  rules.input.columns.forEach((col, i) => {
    if (inputIds.has(col.id)) {
      problems.push({
        kind: 'duplicateId',
        path: `input.columns[${i}].id`,
        message: `duplicate column id "${col.id}"`,
      });
    } else {
      inputIds.add(col.id);
    }
  });

  // ----- Step 1: rowFilters (against ids from read) -----
  rules.input.rowFilters?.forEach((f, i) => {
    if ('expr' in f) {
      checkExprTree(f.expr, { colIds: inputIds }, ctx, `input.rowFilters[${i}].expr`, problems);
    } else {
      checkRef(f.column, inputIds, `input.rowFilters[${i}].column`, problems);
    }
  });

  // ----- Step 2: dedupe (against ids from read, before expand) -----
  if (rules.transform.dedupe) {
    const { keys } = rules.transform.dedupe;
    if (keys !== 'all') {
      keys.forEach((k, i) => checkRef(k, inputIds, `transform.dedupe.keys[${i}]`, problems));
    }
  }

  // ----- Step 3: expand -----
  const afterExpand = new Set(inputIds);
  const newIdsFromExpand = new Set<string>();

  if (rules.transform.expand) {
    const ex = rules.transform.expand;
    if (ex.mode === 'columnsToRows') {
      ex.columns.forEach((c, i) =>
        checkRef(c, inputIds, `transform.expand.columns[${i}]`, problems),
      );
      // SPEC 8.5: "The listed columns aren't available after this step."
      for (const c of ex.columns) afterExpand.delete(c);

      addNewId(ex.labelId, afterExpand, newIdsFromExpand, 'transform.expand.labelId', problems);
      addNewId(ex.valueId, afterExpand, newIdsFromExpand, 'transform.expand.valueId', problems);
      afterExpand.add(ex.labelId);
      afterExpand.add(ex.valueId);
    } else if (ex.mode === 'splitCell') {
      checkRef(ex.column, inputIds, 'transform.expand.column', problems);

      addNewId(ex.partId, afterExpand, newIdsFromExpand, 'transform.expand.partId', problems);
      afterExpand.add(ex.partId);
      if (ex.indexId) {
        addNewId(
          ex.indexId,
          afterExpand,
          newIdsFromExpand,
          'transform.expand.indexId',
          problems,
        );
        afterExpand.add(ex.indexId);
      }
      if (ex.countId) {
        addNewId(
          ex.countId,
          afterExpand,
          newIdsFromExpand,
          'transform.expand.countId',
          problems,
        );
        afterExpand.add(ex.countId);
      }
    } else {
      // fixedFanOut: "set creates or overwrites columns for that row" - overwriting
      // an existing id is explicitly allowed, so no collision check here, only
      // reference/depth checks on the expressions (checked against pre-expand ids,
      // since fixedFanOut runs directly on the read+filtered+deduped row).
      ex.rows.forEach((row, ri) => {
        for (const [id, expr] of Object.entries(row.set)) {
          checkExprTree(
            expr,
            { colIds: inputIds },
            ctx,
            `transform.expand.rows[${ri}].set.${id}`,
            problems,
          );
          afterExpand.add(id);
        }
      });
    }
  }

  // ----- Step 4: computed (sequential; may reference earlier computed ids) -----
  const availableForComputed = new Set(afterExpand);
  rules.transform.computed.forEach((c, i) => {
    checkExprTree(
      c.expr,
      { colIds: availableForComputed, allowWindow: true },
      ctx,
      `transform.computed[${i}].expr`,
      problems,
    );
    if (availableForComputed.has(c.id)) {
      problems.push({
        kind: 'duplicateId',
        path: `transform.computed[${i}].id`,
        message: `id "${c.id}" collides with an existing column id`,
      });
    } else {
      availableForComputed.add(c.id);
    }
  });

  // Ids available from here on (valueMaps, sort, group, output, validations).
  const finalIds = availableForComputed;

  // ----- Step 5: valueMaps -----
  rules.transform.valueMaps.forEach((vm, i) => {
    checkRef(vm.column, finalIds, `transform.valueMaps[${i}].column`, problems);
  });

  // ----- Step 6: sort -----
  rules.transform.sort.forEach((s, i) => {
    checkRef(s.column, finalIds, `transform.sort[${i}].column`, problems);
  });

  // Output headers, needed below by group/output summaryRows (SPEC 8.12 v4, headers
  // not ids) and by "on: output" validations (SPEC 8.8).
  const outputHeaders = new Set(rules.output.columns.map((c) => c.header));

  // ----- Step 7: group -----
  if (rules.transform.group) {
    const g = rules.transform.group;
    checkRef(g.by, finalIds, 'transform.group.by', problems);
    if (g.subtotal) {
      checkRef(g.subtotal.labelColumn, finalIds, 'transform.group.subtotal.labelColumn', problems);
      g.subtotal.sum.forEach((id, i) =>
        checkRef(id, finalIds, `transform.group.subtotal.sum[${i}]`, problems),
      );
    }
    g.summaryRows?.forEach((row, i) =>
      checkSummaryRowRefs(row, outputHeaders, `transform.group.summaryRows[${i}]`, problems),
    );
  }

  // ----- Step 8: output -----
  rules.output.columns.forEach((col, i) => {
    if (col.from !== null) {
      checkRef(col.from, finalIds, `output.columns[${i}].from`, problems);
    }
  });
  rules.output.titleRows.forEach((tr, i) => {
    if ('parts' in tr) {
      tr.parts.forEach((p, pi) => {
        if ('agg' in p) {
          checkRef(p.column, finalIds, `output.titleRows[${i}].parts[${pi}].column`, problems);
        }
      });
    }
  });
  if (rules.output.grandTotal) {
    checkRef(rules.output.grandTotal.labelColumn, finalIds, 'output.grandTotal.labelColumn', problems);
    rules.output.grandTotal.sum.forEach((id, i) =>
      checkRef(id, finalIds, `output.grandTotal.sum[${i}]`, problems),
    );
  }
  rules.output.summaryRows?.forEach((row, i) =>
    checkSummaryRowRefs(row, outputHeaders, `output.summaryRows[${i}]`, problems),
  );

  // ----- Step 9: validations (SPEC 8.8: "on" input columns/computed ids, or "output" headers) -----
  rules.validations.forEach((v, i) => {
    const on = v.on ?? 'input';
    if (on === 'output') {
      if (!outputHeaders.has(v.column)) {
        problems.push({
          kind: 'reference',
          path: `validations[${i}].column`,
          message: `unknown output header "${v.column}"`,
        });
      }
    } else {
      checkRef(v.column, finalIds, `validations[${i}].column`, problems);
    }
    if (v.rule === 'cutoffRange') checkCutoffRange(v, `validations[${i}]`, problems);
    // The other rule of an open question (SPEC 8.8 `sameAs`): it runs where input checks run, so it may read every column there is then
    // (an across-row function only works in a computed column's formula).
    if (v.rule === 'sameAs') checkExprTree(v.expr, { colIds: finalIds }, ctx, `validations[${i}].expr`, problems);
  });

  return problems;
}

/**
 * A cut-off check (SPEC 8.8) is well formed: its three values are all numbers or all ISO dates, `low` is below `high`, and the value
 * the rule uses is inside the range (at an edge only where the cut-off may equal it, `includes`).
 */
function checkCutoffRange(v: CutoffRangeValidation, path: string, problems: RuleProblem[]): void {
  const kinds = new Set([typeof v.low, typeof v.high, typeof v.value]);
  if (kinds.size !== 1) {
    problems.push({ kind: 'reference', path, message: 'a cut-off check holds three numbers or three dates' });
    return;
  }
  const [low, high, value] = [v.low, v.high, v.value] as [number | string, number | string, number | string];
  if (!(low < high)) {
    problems.push({ kind: 'reference', path: `${path}.low`, message: 'the low edge of a cut-off check must be below its high edge' });
    return;
  }
  const inside = v.includes === 'high' ? value > low && value <= high : value >= low && value < high;
  if (!inside) problems.push({ kind: 'reference', path: `${path}.value`, message: 'the cut-off a check names must be inside its range' });
}
