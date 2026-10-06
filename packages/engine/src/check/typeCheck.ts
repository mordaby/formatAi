// SPEC 9.2 layer 3 / SPEC 21 (v3 amendments): "a static type check of every expression,
// filter and function body against the declared column types and the operation
// signatures (8.3). Each output column's result type must fit its output type."
//
// Pure and usable in both the browser and the API (SPEC 21: "typeCheck(rules,
// inputProfile?) -> problems[], pure and usable in the browser and the API"). Reads
// `OP_SIGNATURES` (./signatures) instead of hard-coding operation types inline, per
// SPEC 8.3's "the signature table ... is the single source for the type checker, the
// editor and the prompt."
//
// Complements `checkRules` (packages/shared/src/rules/check.ts): that pass already
// guarantees every `col`/`param`/`call`/`lookup` reference exists, ids don't collide,
// and depth is within budget. This pass assumes references already resolve (an
// unresolved reference here simply yields an `undefined` type, and is silently skipped
// rather than re-reported, to avoid duplicate noise) and checks *types* on top of that.
import type {
  ColumnType,
  Expr,
  ExprConstValue,
  LearnResult,
  OutputColumnRule,
  RowFilter,
  Rules,
  RulesTable,
  SummaryAgg,
  SummaryRow,
  Validation,
} from '@formatai/shared';
import { fits, OP_SIGNATURES, unify, WINDOW_SIGNATURES, windowShapeProblem, type ArgSpec, type ResultSpec, type SigType } from './signatures';

export interface TypeProblem {
  kind: 'type';
  /** Dotted/bracketed path to the offending field, e.g. "transform.computed[1].expr.args[0]". */
  path: string;
  /** Precise enough to drive the LLM repair call (SPEC 9.2), e.g.
   * "expected decimal, got text; use toNumber". */
  message: string;
}

export interface TypeCheckOptions {
  /** The example input file's detected column profile (SPEC 7). When given, declared
   * input column types are checked against it too. */
  inputProfile?: { header: string; type: string }[];
  /** The format's declared output types, keyed by output header. When given, each
   * output column's source type must fit the declared one (SPEC 9.2: "Each output
   * column's result type must fit its output type"). */
  outputTypes?: Record<string, string>;
}

// ---------- Small type-lattice glue on top of ./signatures ----------

/** ColumnType (SPEC 7.1, wider - includes currency/percent) -> the narrower SPEC 8.3
 * expression value type. "currency"/"percent" columns normalize to decimal before
 * reaching the rules language (see schema.ts's ColumnType/VALUE_TYPES comment). */
export function columnTypeToValueType(t: ColumnType): SigType {
  switch (t) {
    case 'currency':
    case 'percent':
      return 'decimal';
    case 'text':
    case 'integer':
    case 'decimal':
    case 'date':
    case 'boolean':
    case 'idLike':
      return t;
  }
}

function inferConstType(v: ExprConstValue): SigType | undefined {
  if (v === null) return undefined; // an empty literal is compatible with anything; see call sites
  if (typeof v === 'boolean') return 'boolean';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'decimal';
  return 'text';
}

/**
 * The type an output column shows once its `agg` is applied (summary output, `group.showDetailRows: false`, SPEC 8.6): a count is an integer
 * whatever is counted (a text or id column too), an average a decimal, a sum a number (an integer for integers), and min / max / first / last
 * keep the source type. Without a summary output (no group, or one that shows its detail rows) the engine ignores `agg`, so the column
 * keeps the type of what it reads.
 */
function typeAfterAgg(agg: SummaryAgg | undefined, source: SigType, summaryOutput: boolean): SigType {
  if (!summaryOutput || agg === undefined) return source;
  switch (agg) {
    case 'count':
      return 'integer';
    case 'average':
      return 'decimal';
    case 'sum':
      return source === 'integer' ? 'integer' : 'decimal';
    case 'min':
    case 'max':
    case 'first':
    case 'last':
      return source;
  }
}

function suggestionFor(expected: SigType, actual: SigType): string | undefined {
  if ((expected === 'decimal' || expected === 'integer') && (actual === 'text' || actual === 'idLike')) {
    return 'use toNumber';
  }
  if (expected === 'text' && actual !== 'text' && actual !== 'idLike') {
    return 'use toText';
  }
  return undefined;
}

function mismatchMessage(expected: SigType, actual: SigType): string {
  const suggestion = suggestionFor(expected, actual);
  return `expected ${expected}, got ${actual}${suggestion ? `; ${suggestion}` : ''}`;
}

/** Checks one already-inferred argument type against what an op's signature expects,
 * pushing a `TypeProblem` on mismatch. `undefined` (unknown/erroneous - already
 * reported deeper in the tree, or an unresolved reference `checkRules` covers) is
 * silently accepted so problems don't cascade. */
function checkArgFits(
  actual: SigType | undefined,
  expected: SigType | 'any',
  path: string,
  problems: TypeProblem[],
): void {
  if (actual === undefined || expected === 'any') return;
  if (!fits(actual, expected)) {
    problems.push({ kind: 'type', path, message: mismatchMessage(expected, actual) });
  }
}

function resolveResult(spec: ResultSpec, argTypes: readonly (SigType | undefined)[]): SigType | undefined {
  switch (spec.kind) {
    case 'fixed':
      return spec.type;
    case 'boolean':
      return 'boolean';
    case 'numericPreserveInteger': {
      // SPEC 8.3: decimal, "integer when all args integer". An unknown (undefined)
      // arg type can't be proven integer, so it falls back to the safe, wider decimal.
      const allInteger = argTypes.length > 0 && argTypes.every((t) => t === 'integer');
      return allInteger ? 'integer' : 'decimal';
    }
    case 'unify': {
      const known = argTypes.filter((t): t is SigType => t !== undefined);
      return unify(known);
    }
    case 'dynamic':
      return undefined; // resolved by the lookup/call call sites in inferType, not here
  }
}

// ---------- Function/table context (SPEC 8.14) ----------

interface FnInfo {
  params: { name: string; type: SigType }[];
  returns: SigType;
}

interface TableInfo {
  columns: readonly string[];
  /** Inferred from `rows[][columnIndex]` (SPEC: "result type inferred from the returned
   * column's values"). `undefined` when the column is empty or holds mixed JS types
   * that don't share a common one. */
  columnTypes: (SigType | undefined)[];
  keyType: SigType | undefined;
}

interface TypeCheckCtx {
  functionsByName: ReadonlyMap<string, FnInfo>;
  tablesByName: ReadonlyMap<string, TableInfo>;
}

function inferTableColumnType(table: RulesTable, columnIndex: number): SigType | undefined {
  const values = table.rows
    .map((row) => row[columnIndex])
    .filter((v): v is Exclude<typeof v, undefined | null> => v !== undefined && v !== null);
  if (values.length === 0) return undefined;
  const types: (SigType | undefined)[] = values.map((v) => inferConstType(v));
  const known = types.filter((t): t is SigType => t !== undefined);
  if (known.length !== types.length) return undefined;
  return unify(known);
}

/** Builds the functions/tables type context, and - along the way - type-checks every
 * function body against its own declared params/returns (SPEC 9.2: "function params/
 * returns (body must fit `returns`)"). `checkRules` already guarantees a function only
 * calls functions defined above it, so it's safe to build the whole map up front. */
function buildContext(rules: LearnResult | Rules, problems: TypeProblem[]): TypeCheckCtx {
  const functionsByName = new Map<string, FnInfo>();
  const functions = rules.transform.functions ?? [];
  for (const fn of functions) {
    functionsByName.set(fn.name, { params: fn.params.map((p) => ({ name: p.name, type: p.type })), returns: fn.returns });
  }

  const tablesByName = new Map<string, TableInfo>();
  const tables = rules.transform.tables ?? [];
  for (const table of tables) {
    const columnTypes = table.columns.map((_, ci) => inferTableColumnType(table, ci));
    tablesByName.set(table.name, { columns: table.columns, columnTypes, keyType: columnTypes[0] });
  }

  const ctx: TypeCheckCtx = { functionsByName, tablesByName };

  functions.forEach((fn, i) => {
    const paramTypes = new Map(fn.params.map((p) => [p.name, p.type] as const));
    const bodyType = inferType(fn.body, { paramTypes }, ctx, `transform.functions[${i}].body`, problems);
    if (bodyType !== undefined && !fits(bodyType, fn.returns)) {
      problems.push({ kind: 'type', path: `transform.functions[${i}].body`, message: mismatchMessage(fn.returns, bodyType) });
    }
  });

  return ctx;
}

// ---------- Expression type inference ----------

interface TypeScope {
  /** `col` ids in scope, for a top-level expr. Omitted while checking a function body. */
  colTypes?: ReadonlyMap<string, SigType>;
  /** A function body's declared param types. Omitted for top-level exprs. */
  paramTypes?: ReadonlyMap<string, SigType>;
}

/** Infers an expression's static type, pushing every mismatch found along the way as a
 * `TypeProblem`. Returns `undefined` when the type can't be determined (an unresolved
 * `col`/`param`/`call`/`lookup` reference - `checkRules` reports those - or a cascaded
 * error from a child), so callers can skip further checks without duplicating problems. */
function inferType(
  expr: Expr,
  scope: TypeScope,
  ctx: TypeCheckCtx,
  path: string,
  problems: TypeProblem[],
): SigType | undefined {
  if ('col' in expr) return scope.colTypes?.get(expr.col);
  if ('const' in expr) return inferConstType(expr.const);
  if ('param' in expr) return scope.paramTypes?.get(expr.param);

  switch (expr.op) {
    // ---- Group A: a single `arg: Expr` child, homogeneous expected type ----
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
    case 'oneOf':
    case 'startsWith':
    case 'endsWith':
    case 'contains':
    case 'not': {
      const sig = OP_SIGNATURES[expr.op];
      const argSpec = sig.args as Extract<ArgSpec, { shape: 'unary' }>;
      const argType = inferType(expr.arg, scope, ctx, `${path}.arg`, problems);
      checkArgFits(argType, argSpec.type, `${path}.arg`, problems);
      return resolveResult(sig.result, [argType]);
    }

    // ---- Group B: a fixed-length `args` tuple (2 or 3), homogeneous expected type ----
    case 'mod':
    case 'dateDiff':
    case 'makeDate': {
      const sig = OP_SIGNATURES[expr.op];
      const argSpec = sig.args as Extract<ArgSpec, { shape: 'fixedSameType' }>;
      const types = expr.args.map((a, i) => inferType(a, scope, ctx, `${path}.args[${i}]`, problems));
      types.forEach((t, i) => checkArgFits(t, argSpec.type, `${path}.args[${i}]`, problems));
      return resolveResult(sig.result, types);
    }

    // ---- Group C: variadic `args`, homogeneous expected type ----
    case 'add':
    case 'sub':
    case 'mul':
    case 'div':
    case 'min':
    case 'max':
    case 'concat':
    case 'and':
    case 'or': {
      const sig = OP_SIGNATURES[expr.op];
      const argSpec = sig.args as Extract<ArgSpec, { shape: 'variadicSameType' }>;
      const types = expr.args.map((a, i) => inferType(a, scope, ctx, `${path}.args[${i}]`, problems));
      types.forEach((t, i) => checkArgFits(t, argSpec.type, `${path}.args[${i}]`, problems));
      return resolveResult(sig.result, types);
    }

    // ---- Group D: variadic `args` that must unify to one common ("same-kind") type ----
    case 'coalesce':
    case 'eq':
    case 'ne':
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const sig = OP_SIGNATURES[expr.op];
      const types = expr.args.map((a, i) => inferType(a, scope, ctx, `${path}.args[${i}]`, problems));
      const known = types.filter((t): t is SigType => t !== undefined);
      const unified = unify(known);
      if (known.length >= 2 && unified === undefined) {
        problems.push({
          kind: 'type',
          path,
          message: `arguments must be the same kind of value; got ${known.join(', ')}`,
        });
      }
      return resolveResult(sig.result, types);
    }

    // ---- Group E: irregular shapes ----
    // A literal op with no Expr child: its type is fixed (date). The literal itself is
    // validated by the schema/parser, not here.
    case 'dateLiteral':
      return resolveResult(OP_SIGNATURES.dateLiteral.result, []);

    // An across-row function (docs/proposals/window-operations.md): its column must suit the function (a number to add up, a number or a
    // date for min/max, anything to carry down); the group and order columns can be of any type. Stored JSON gets the same shape check
    // the formula parser gives text (a column where one is needed, no order on a group total, rank needs an order).
    case 'window': {
      const shape = windowShapeProblem(expr);
      if (shape !== undefined) {
        problems.push({ kind: 'type', path, message: shape });
        return undefined;
      }
      const sig = WINDOW_SIGNATURES[expr.fn];
      let argType: SigType | undefined;
      if (expr.arg !== undefined) {
        if (!('col' in expr.arg)) {
          problems.push({ kind: 'type', path: `${path}.arg`, message: `${expr.fn}() reads a column id; make a computed column first for anything calculated` });
          return undefined;
        }
        argType = inferType(expr.arg, scope, ctx, `${path}.arg`, problems);
        if (argType !== undefined && sig.argType === 'numeric' && !fits(argType, 'decimal')) {
          const hint = argType === 'text' || argType === 'idLike' ? '; use toNumber in a computed column first' : '';
          problems.push({ kind: 'type', path: `${path}.arg`, message: `expected decimal, got ${argType}${hint}` });
        } else if (argType !== undefined && sig.argType === 'numericOrDate' && !fits(argType, 'decimal') && argType !== 'date') {
          const hint = argType === 'text' || argType === 'idLike' ? '; use toNumber or a date column first (in a computed column)' : '';
          problems.push({ kind: 'type', path: `${path}.arg`, message: `expected decimal or date, got ${argType}${hint}` });
        }
      }
      switch (sig.result) {
        case 'numericPreserve':
          return argType === 'integer' ? 'integer' : 'decimal';
        case 'decimal':
          return 'decimal';
        case 'integer':
          return 'integer';
        case 'argType':
          return argType;
      }
    }

    case 'if': {
      const condType = inferType(expr.cond, scope, ctx, `${path}.cond`, problems);
      checkArgFits(condType, 'boolean', `${path}.cond`, problems);
      const thenType = inferType(expr.then, scope, ctx, `${path}.then`, problems);
      const elseType = inferType(expr.else, scope, ctx, `${path}.else`, problems);
      const known = [thenType, elseType].filter((t): t is SigType => t !== undefined);
      const unified = unify(known);
      if (known.length === 2 && unified === undefined) {
        problems.push({
          kind: 'type',
          path,
          message: `"then" and "else" must be the same kind of value; got ${thenType} and ${elseType}`,
        });
      }
      return unified;
    }

    case 'switch': {
      const branchTypes: (SigType | undefined)[] = [];
      expr.cases.forEach((c, i) => {
        const whenType = inferType(c.when, scope, ctx, `${path}.cases[${i}].when`, problems);
        checkArgFits(whenType, 'boolean', `${path}.cases[${i}].when`, problems);
        branchTypes.push(inferType(c.then, scope, ctx, `${path}.cases[${i}].then`, problems));
      });
      branchTypes.push(inferType(expr.else, scope, ctx, `${path}.else`, problems));
      const known = branchTypes.filter((t): t is SigType => t !== undefined);
      const unified = unify(known);
      if (known.length >= 2 && unified === undefined) {
        problems.push({
          kind: 'type',
          path,
          message: `switch branches must be the same kind of value; got ${known.join(', ')}`,
        });
      }
      return unified;
    }

    case 'lookup': {
      const keyType = inferType(expr.key, scope, ctx, `${path}.key`, problems);
      const table = ctx.tablesByName.get(expr.table);
      if (!table) return undefined; // unknown table: checkRules already reports it
      if (keyType !== undefined && table.keyType !== undefined && unify([keyType, table.keyType]) === undefined) {
        problems.push({
          kind: 'type',
          path: `${path}.key`,
          message: `expected ${table.keyType} (the key type of table "${expr.table}"), got ${keyType}`,
        });
      }
      const returnIndex = table.columns.indexOf(expr.return);
      if (returnIndex === -1) return undefined; // unknown column: checkRules already reports it
      return table.columnTypes[returnIndex];
    }

    case 'call': {
      const fn = ctx.functionsByName.get(expr.fn);
      if (!fn) return undefined; // unknown function: checkRules already reports it
      expr.args.forEach((a, i) => {
        const argType = inferType(a, scope, ctx, `${path}.args[${i}]`, problems);
        const param = fn.params[i];
        if (param) checkArgFits(argType, param.type, `${path}.args[${i}]`, problems);
      });
      return fn.returns;
    }

    default: {
      const exhaustive: never = expr;
      throw new Error(`typeCheck: unhandled op ${JSON.stringify(exhaustive)}`);
    }
  }
}

// ---------- Row filters, validations, profile/outputTypes checks ----------

const NUMERIC_ONLY: ReadonlySet<SigType> = new Set(['integer', 'decimal']);

function checkSimpleFilterValue(
  f: Extract<RowFilter, { column: string }>,
  colTypes: ReadonlyMap<string, SigType>,
  path: string,
  problems: TypeProblem[],
): void {
  const colType = colTypes.get(f.column);
  if (colType === undefined) return; // unknown column: checkRules already reports it

  let values: (string | number | boolean | null)[];
  switch (f.op) {
    case 'isEmpty':
    case 'notEmpty':
      return;
    case 'oneOf':
    case 'notOneOf':
      values = f.value;
      break;
    default:
      values = [f.value];
  }
  for (const v of values) {
    if (v === null) continue; // an empty comparand suits any column
    const vType = inferConstType(v);
    if (vType !== undefined && unify([vType, colType]) === undefined) {
      problems.push({
        kind: 'type',
        path: `${path}.value`,
        message: `filter value does not suit column "${f.column}" (${colType}): got ${vType}`,
      });
      return; // one problem per filter is enough
    }
  }
}

function checkValidationParam(
  v: Validation,
  index: number,
  finalTypes: ReadonlyMap<string, SigType>,
  outputColumns: readonly OutputColumnRule[],
  problems: TypeProblem[],
): void {
  const on = v.on ?? 'input';
  let colType: SigType | undefined;
  if (on === 'output') {
    const outCol = outputColumns.find((c) => c.header === v.column);
    colType = outCol?.from != null ? finalTypes.get(outCol.from) : undefined;
  } else {
    colType = finalTypes.get(v.column);
  }
  if (colType === undefined) return;

  const path = `validations[${index}]`;
  switch (v.rule) {
    case 'range':
      if (!NUMERIC_ONLY.has(colType)) {
        problems.push({ kind: 'type', path, message: `range applies to a numeric column; "${v.column}" is ${colType}` });
      }
      return;
    case 'dateRange':
      if (colType !== 'date') {
        problems.push({ kind: 'type', path, message: `dateRange applies to a date column; "${v.column}" is ${colType}` });
      }
      return;
    case 'cutoffRange': {
      // A number range on a numeric column, a date range (ISO dates) on a date column.
      const dates = typeof v.low === 'string';
      if (dates ? colType !== 'date' : !NUMERIC_ONLY.has(colType)) {
        problems.push({ kind: 'type', path, message: `cutoffRange with ${dates ? 'dates' : 'numbers'} applies to a ${dates ? 'date' : 'numeric'} column; "${v.column}" is ${colType}` });
      }
      return;
    }
    case 'lengthEquals':
      if (!fits(colType, 'text')) {
        problems.push({ kind: 'type', path, message: `lengthEquals applies to a text column; "${v.column}" is ${colType}` });
      }
      return;
    case 'israeliIdChecksum':
      if (!fits(colType, 'text')) {
        problems.push({ kind: 'type', path, message: `israeliIdChecksum applies to a text/idLike column; "${v.column}" is ${colType}` });
      }
      return;
    case 'required':
    case 'oneOf':
    case 'unique':
    case 'sameAs': // any column type is fine (its expression is type-checked on its own, in `typeCheck`)
      return;
  }
}

/** SPEC 8.12 v4: a summary row's `cells` name output headers, and their aggregate
 * (`SummaryAgg`) constrains the source output column's final type: `sum`/`average`
 * need a numeric column; `min`/`max` need numeric or date; `count`/`first`/`last`
 * accept any type. */
function checkSummaryRow(
  row: SummaryRow,
  path: string,
  finalTypes: ReadonlyMap<string, SigType>,
  outputColumns: readonly OutputColumnRule[],
  problems: TypeProblem[],
): void {
  for (const [header, agg] of Object.entries(row.cells)) {
    const outCol = outputColumns.find((c) => c.header === header);
    const colType = outCol?.from != null ? finalTypes.get(outCol.from) : undefined;
    if (colType === undefined) continue; // unresolved column: checkRules already reports it
    if (agg === 'sum' || agg === 'average') {
      if (!NUMERIC_ONLY.has(colType)) {
        problems.push({
          kind: 'type',
          path: `${path}.cells.${header}`,
          message: `${agg} applies to a numeric column; "${header}" is ${colType}`,
        });
      }
    } else if (agg === 'min' || agg === 'max') {
      if (!NUMERIC_ONLY.has(colType) && colType !== 'date') {
        problems.push({
          kind: 'type',
          path: `${path}.cells.${header}`,
          message: `${agg} applies to a numeric or date column; "${header}" is ${colType}`,
        });
      }
    }
  }
}

/** SPEC 7's profile categories are looser/wider than the rules language's ColumnType
 * (e.g. "number" rather than integer/decimal/currency/percent); compared by family
 * rather than requiring an exact string match. Unrecognized profile/declared strings
 * are skipped rather than flagged, so an evolving profile vocabulary can't produce
 * false positives here. */
const TYPE_FAMILY: Readonly<Record<string, 'numeric' | 'text' | 'date' | 'boolean'>> = {
  integer: 'numeric',
  decimal: 'numeric',
  currency: 'numeric',
  percent: 'numeric',
  number: 'numeric',
  text: 'text',
  idLike: 'text',
  string: 'text',
  date: 'date',
  boolean: 'boolean',
  bool: 'boolean',
};

function familyOf(t: string): 'numeric' | 'text' | 'date' | 'boolean' | undefined {
  return TYPE_FAMILY[t];
}

/** The nominal SigType that stands in for a whole family, for a `fits` check (SPEC 8.3's
 * widening already makes 'decimal'/'text' accept their narrower family members). */
const FAMILY_NOMINAL: Record<'numeric' | 'text' | 'date' | 'boolean', SigType> = {
  numeric: 'decimal',
  text: 'text',
  date: 'date',
  boolean: 'boolean',
};

// ---------- The public entry point ----------

/**
 * The type each computed column's formula gives, in order - each seeing the input columns as declared and every earlier computed column as
 * what ITS formula gives (not as declared). For code that writes computed columns nobody declared a type for: the AI's code checks
 * (`learn/checks.ts`) declare what this says, and `typeCheck` then reports only the real mismatches inside the formulas. `undefined`: no type
 * could be found (an unknown reference, a mismatch inside, an empty literal) - `typeCheck` / `checkRules` say what. Rules with `expand` are
 * not read here (the ids it creates are not in scope).
 */
export function inferComputedTypes(rules: LearnResult | Rules): (SigType | undefined)[] {
  const ignored: TypeProblem[] = [];
  const ctx = buildContext(rules, ignored);
  const colTypes = new Map<string, SigType>();
  for (const col of rules.input.columns) colTypes.set(col.id, columnTypeToValueType(col.type));
  return rules.transform.computed.map((c, i) => {
    const t = inferType(c.expr, { colTypes }, ctx, `transform.computed[${i}].expr`, ignored);
    if (t !== undefined) colTypes.set(c.id, t);
    return t;
  });
}

export function typeCheck(rules: LearnResult | Rules, opts?: TypeCheckOptions): TypeProblem[] {
  const problems: TypeProblem[] = [];
  const ctx = buildContext(rules, problems);

  // ----- input columns -----
  const colTypes = new Map<string, SigType>();
  rules.input.columns.forEach((col, i) => {
    colTypes.set(col.id, columnTypeToValueType(col.type));

    if (opts?.inputProfile) {
      const profileEntry = opts.inputProfile.find((p) => p.header === col.header);
      if (profileEntry) {
        const declaredFamily = familyOf(col.type);
        const profileFamily = familyOf(profileEntry.type);
        if (declaredFamily && profileFamily && declaredFamily !== profileFamily) {
          problems.push({
            kind: 'type',
            path: `input.columns[${i}].type`,
            message: `expected ${profileEntry.type} (from the input file), got ${col.type}`,
          });
        }
      }
    }
  });

  // ----- rowFilters (SPEC 9.2: "rowFilters exprs must be boolean") -----
  rules.input.rowFilters?.forEach((f, i) => {
    if ('expr' in f) {
      const t = inferType(f.expr, { colTypes }, ctx, `input.rowFilters[${i}].expr`, problems);
      checkArgFits(t, 'boolean', `input.rowFilters[${i}].expr`, problems);
    } else {
      checkSimpleFilterValue(f, colTypes, `input.rowFilters[${i}]`, problems);
    }
  });

  // ----- expand (SPEC 8.5): columnsToRows valueType, labels text; splitCell part text,
  // index/count integer; fixedFanOut ids get the (unified) type of their set exprs -----
  const afterExpand = new Map(colTypes);
  if (rules.transform.expand) {
    const ex = rules.transform.expand;
    if (ex.mode === 'columnsToRows') {
      for (const c of ex.columns) afterExpand.delete(c);
      afterExpand.set(ex.labelId, 'text');
      afterExpand.set(ex.valueId, columnTypeToValueType(ex.valueType));
    } else if (ex.mode === 'splitCell') {
      afterExpand.set(ex.partId, 'text');
      if (ex.indexId) afterExpand.set(ex.indexId, 'integer');
      if (ex.countId) afterExpand.set(ex.countId, 'integer');
    } else {
      const typesById = new Map<string, SigType[]>();
      ex.rows.forEach((row, ri) => {
        for (const [id, expr] of Object.entries(row.set)) {
          const t = inferType(expr, { colTypes }, ctx, `transform.expand.rows[${ri}].set.${id}`, problems);
          if (t !== undefined) {
            const arr = typesById.get(id);
            if (arr) arr.push(t);
            else typesById.set(id, [t]);
          }
        }
      });
      for (const [id, types] of typesById) {
        const unified = unify(types);
        if (unified === undefined) {
          problems.push({
            kind: 'type',
            path: `transform.expand.rows[].set.${id}`,
            message: `fixedFanOut rows produce incompatible types for "${id}": ${types.join(', ')}`,
          });
        } else {
          afterExpand.set(id, unified);
        }
      }
    }
  }

  // ----- computed (sequential; declared type must fit the expr's inferred type) -----
  const availableTypes = new Map(afterExpand);
  rules.transform.computed.forEach((c, i) => {
    const exprType = inferType(c.expr, { colTypes: availableTypes }, ctx, `transform.computed[${i}].expr`, problems);
    const declared = columnTypeToValueType(c.type);
    if (exprType !== undefined && !fits(exprType, declared)) {
      problems.push({ kind: 'type', path: `transform.computed[${i}].expr`, message: mismatchMessage(declared, exprType) });
    }
    availableTypes.set(c.id, declared);
  });

  const finalTypes = availableTypes;

  // ----- output columns vs. opts.outputTypes (SPEC 9.2: "Each output column's result
  // type must fit its output type") -----
  if (opts?.outputTypes) {
    const summaryOutput = rules.transform.group !== undefined && !rules.transform.group.showDetailRows;
    rules.output.columns.forEach((col, i) => {
      if (col.from === null) return;
      const declaredRaw = opts.outputTypes?.[col.header];
      if (declaredRaw === undefined) return;
      const readType = finalTypes.get(col.from);
      if (readType === undefined) return;
      const srcType = typeAfterAgg(col.agg, readType, summaryOutput);
      const family = familyOf(declaredRaw);
      const nominal = family ? FAMILY_NOMINAL[family] : undefined;
      if (nominal && !fits(srcType, nominal)) {
        problems.push({
          kind: 'type',
          path: `output.columns[${i}]`,
          message: `expected ${declaredRaw} (the format's declared type), got ${srcType}`,
        });
      }
    });
  }

  // ----- validations' params must suit their column -----
  rules.validations.forEach((v, i) => checkValidationParam(v, i, finalTypes, rules.output.columns, problems));
  // The other rule of an open question (`sameAs`, SPEC 8.8) is an expression over the columns there are when input checks run.
  rules.validations.forEach((v, i) => {
    if (v.rule === 'sameAs') inferType(v.expr, { colTypes: finalTypes }, ctx, `validations[${i}].expr`, problems);
  });

  // ----- summary rows (SPEC 8.12 v4): sum/average need numeric, min/max need
  // numeric or date -----
  rules.output.summaryRows?.forEach((row, i) =>
    checkSummaryRow(row, `output.summaryRows[${i}]`, finalTypes, rules.output.columns, problems),
  );
  rules.transform.group?.summaryRows?.forEach((row, i) =>
    checkSummaryRow(row, `transform.group.summaryRows[${i}]`, finalTypes, rules.output.columns, problems),
  );

  return problems;
}
