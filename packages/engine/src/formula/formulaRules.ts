// learn-v5: converts every one of SPEC 8.3's four Expr positions
// (`transform.computed[].expr`, `input.rowFilters[].expr`, `transform.expand`
// (fixedFanOut)'s `rows[].set` values, `transform.functions[].body`) between formula
// TEXT (the LLM/editor wire format, `packages/shared/src/rules/wire.ts`'s `{key,value}`
// pairs already turned back into a plain record by `fromWire`) and the real `Expr` AST
// every other part of the system (the type checker, `checkRules`, the engine, every
// saved/golden rules file) has always used unchanged.
//
// `formulaRulesFromWire` is the untrusted-input direction (raw LLM JSON, after shared's
// `fromWire`): defensive like `fromWire` itself - a shape it doesn't recognize is passed
// through unchanged, and a formula string that fails to parse is left AS a string (so
// the subsequent `LearnResultSchema.safeParse` still reports it, just without a precise
// offset) while a `formula`-kind `RepairProblem` (SPEC 9.3, with an `offset` INTO that
// formula string) is recorded for the repair call. `formulaRulesToWire` is the outbound
// direction (real rules -> formula text), used to print `previousRules` in a repair
// block the same way the LLM itself writes formulas.
import type { Computed, Expand, LearnResult, RepairProblem, RowFilter, RulesFunction, RulesInput, RulesTransform } from '@formatai/shared';
import { parseFormula, type FormulaParseContext } from './parseFormula';
import { printFormula } from './printFormula';

// ---------- Formula-wire TypeScript shapes (Expr -> string at the four positions) ----------

export type FormulaRowFilter = Exclude<RowFilter, { expr: unknown }> | { expr: string };
export type FormulaComputed = Omit<Computed, 'expr'> & { expr: string };
export type FormulaExpand =
  | Extract<Expand, { mode: 'columnsToRows' }>
  | Extract<Expand, { mode: 'splitCell' }>
  | (Omit<Extract<Expand, { mode: 'fixedFanOut' }>, 'rows'> & { rows: { set: Record<string, string> }[] });
export type FormulaRulesFunction = Omit<RulesFunction, 'body'> & { body: string };

export type FormulaRulesInput = Omit<RulesInput, 'rowFilters'> & { rowFilters?: FormulaRowFilter[] };
export type FormulaRulesTransform = Omit<RulesTransform, 'computed' | 'expand' | 'functions'> & {
  computed: FormulaComputed[];
  expand?: FormulaExpand;
  functions?: FormulaRulesFunction[];
};

/** The formula-wire-shaped counterpart of `LearnResult` (or `Rules`, via the generic -
 * matching `wire.ts`'s `WireLearnResult<T>` pattern so extra fields like `name`/`meta`
 * pass through for a repair call's `previousRules`). */
export type FormulaWireResult<T extends LearnResult = LearnResult> = Omit<T, 'input' | 'transform'> & {
  input: FormulaRulesInput;
  transform: FormulaRulesTransform;
};

// ---------- formulaRulesToWire: real (Expr trees) -> formula wire (text) ----------

function rowFilterToFormula(f: RowFilter): FormulaRowFilter {
  if ('expr' in f) return { expr: printFormula(f.expr) };
  return f;
}

function expandToFormula(expand: Expand | undefined): FormulaExpand | undefined {
  if (!expand) return undefined;
  if (expand.mode !== 'fixedFanOut') return expand;
  return {
    ...expand,
    rows: expand.rows.map((row) => {
      const set: Record<string, string> = {};
      for (const [id, expr] of Object.entries(row.set)) set[id] = printFormula(expr);
      return { set };
    }),
  };
}

function transformToFormula(transform: RulesTransform): FormulaRulesTransform {
  return {
    ...transform,
    computed: transform.computed.map((c) => ({ ...c, expr: printFormula(c.expr) })),
    expand: expandToFormula(transform.expand),
    functions: transform.functions?.map((fn) => ({ ...fn, body: printFormula(fn.body) })),
  };
}

/** Prints every Expr position in a real `LearnResult`/`Rules` as formula text - the
 * outbound half of learn-v5's wire format (SPEC 9.3: a repair call's `previousRules`). */
export function formulaRulesToWire<T extends LearnResult>(rules: T): FormulaWireResult<T> {
  return {
    ...rules,
    input: { ...rules.input, rowFilters: rules.input.rowFilters?.map(rowFilterToFormula) },
    transform: transformToFormula(rules.transform),
  };
}

// ---------- formulaRulesFromWire: formula wire (text, untrusted) -> real (Expr trees) ----------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function parseAt(value: unknown, path: string, ctx: FormulaParseContext, problems: RepairProblem[]): unknown {
  if (typeof value !== 'string') return value; // not a string: not our concern - schema validation reports it
  const result = parseFormula(value, ctx);
  if (result.ok) return result.expr;
  problems.push({ kind: 'formula', path, offset: result.error.offset, message: result.error.message });
  return value;
}

function rowFiltersFromWire(rowFilters: unknown, base: FormulaParseContext, problems: RepairProblem[]): unknown {
  if (!Array.isArray(rowFilters)) return rowFilters;
  return rowFilters.map((f, i) => {
    if (!isRecord(f) || !('expr' in f)) return f;
    return { ...f, expr: parseAt(f.expr, `input.rowFilters[${i}].expr`, base, problems) };
  });
}

function computedFromWire(computed: unknown, base: FormulaParseContext, problems: RepairProblem[]): unknown {
  if (!Array.isArray(computed)) return computed;
  // The one position where across-row (window) functions can run (step 6); everywhere else they are a parse error.
  const ctx: FormulaParseContext = { ...base, allowWindows: true };
  return computed.map((c, i) => {
    if (!isRecord(c)) return c;
    return { ...c, expr: parseAt(c.expr, `transform.computed[${i}].expr`, ctx, problems) };
  });
}

function expandFromWire(expand: unknown, base: FormulaParseContext, problems: RepairProblem[]): unknown {
  if (!isRecord(expand) || expand.mode !== 'fixedFanOut' || !Array.isArray(expand.rows)) return expand;
  return {
    ...expand,
    rows: expand.rows.map((row, ri) => {
      if (!isRecord(row) || !isRecord(row.set)) return row;
      const set: Record<string, unknown> = {};
      for (const [id, v] of Object.entries(row.set)) {
        set[id] = parseAt(v, `transform.expand.rows[${ri}].set.${id}`, base, problems);
      }
      return { ...row, set };
    }),
  };
}

/** Extracts a function's own declared param NAMES (defensively - this runs before
 * `LearnResultSchema.safeParse`, so `fn.params` isn't guaranteed well-formed yet), for
 * that function body's formula-parse context (SPEC 8.14: params, never `col`). */
function paramNamesOf(fn: Record<string, unknown>): string[] {
  if (!Array.isArray(fn.params)) return [];
  const names: string[] = [];
  for (const p of fn.params) {
    if (isRecord(p) && typeof p.name === 'string') names.push(p.name);
  }
  return names;
}

function functionsFromWire(functions: unknown, base: FormulaParseContext, problems: RepairProblem[]): unknown {
  if (!Array.isArray(functions)) return functions;
  return functions.map((fn, i) => {
    if (!isRecord(fn)) return fn;
    const ctx: FormulaParseContext = { ...base, params: paramNamesOf(fn) };
    return { ...fn, body: parseAt(fn.body, `transform.functions[${i}].body`, ctx, problems) };
  });
}

/**
 * Parses every formula-text position in an untrusted, wire-decoded (record-shaped,
 * `@formatai/shared`'s `fromWire` already applied) LLM response back into real `Expr`
 * trees. Never throws; returns `unknown` (like `fromWire`) since the result isn't
 * zod-validated yet - the caller always follows this with `LearnResultSchema.safeParse`
 * (SPEC 9.2 layer 1), which is the real structural gate.
 */
export function formulaRulesFromWire(
  json: unknown,
  opts: { promptOpsOnly?: boolean } = {},
): { rules: unknown; problems: RepairProblem[] } {
  const problems: RepairProblem[] = [];
  const base: FormulaParseContext = opts.promptOpsOnly ? { promptOpsOnly: true } : {};
  if (!isRecord(json)) return { rules: json, problems };

  const input = isRecord(json.input) ? { ...json.input, rowFilters: rowFiltersFromWire(json.input.rowFilters, base, problems) } : json.input;

  let transform = json.transform;
  if (isRecord(transform)) {
    transform = {
      ...transform,
      computed: computedFromWire(transform.computed, base, problems),
      expand: transform.expand === undefined ? undefined : expandFromWire(transform.expand, base, problems),
      functions: transform.functions === undefined ? undefined : functionsFromWire(transform.functions, base, problems),
    };
  }

  return { rules: { ...json, input, transform }, problems };
}
