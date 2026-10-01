// Rules language v1 (SPEC.md section 8; operations vocabulary from LEARN_PROMPT.md).
// Every object schema is strict (additionalProperties: false) except genuine
// open dictionaries (valueMaps.map, expand.columnsToRows.labels, fixedFanOut set),
// which by design take arbitrary keys taken from the user's own data.
import { z } from 'zod';
import {
  ASSUMPTION_REASON_CODES,
  UNSUPPORTED_REASON_CODES,
  type AssumptionReasonCode,
  type UnsupportedReasonCode,
} from '../codes';
// `SummaryAgg` is canonically declared in payload.ts (LEARN_PROMPT §3's
// `output.layout.summaryRows`/`groupBy.summaryRows`, keyed by output *position*);
// the rules-language `SummaryRow.cells` below uses the same aggregate names, keyed
// by output *header* instead (SPEC 8.12). Imported as a type only (erased at compile
// time), so re-using it here creates no runtime dependency on payload.ts, only a
// type-level one - and avoids two independently-declared literal unions drifting apart.
import type { SummaryAgg } from '../payload';

// ---------- Column type (SPEC 8.1) ----------

export const COLUMN_TYPES = [
  'text',
  'integer',
  'decimal',
  'currency',
  'percent',
  'date',
  'boolean',
  'idLike',
] as const;
export type ColumnType = (typeof COLUMN_TYPES)[number];
export const ColumnTypeSchema = z.enum(COLUMN_TYPES);

// ---------- Value types for the expression type system (SPEC 8.3, 8.14) ----------
// DECISION: SPEC 8.3 defines a narrower type system for expressions/functions than
// ColumnType above ("Every value has one type: text, idLike, integer, decimal, date
// or boolean" - no currency/percent, which are profile-only types from SPEC 7.1 that
// normalize to decimal before they ever reach the rules language). `currency`/`percent`
// are kept in ColumnType only because M0 golden fixtures already declare input columns
// with them (SPEC amendments require old rules files to keep loading unchanged).
// VALUE_TYPES is used where SPEC 8.3/8.14 actually specifies this narrower set:
// transform.functions[].params[].type and .returns. Everywhere else (InputColumn.type,
// Computed.type, expand.valueType) keeps using the wider ColumnType, unchanged from v1.
export const VALUE_TYPES = ['text', 'idLike', 'integer', 'decimal', 'date', 'boolean'] as const;
export type ValueType = (typeof VALUE_TYPES)[number];
export const ValueTypeSchema = z.enum(VALUE_TYPES);

// ---------- Expressions (SPEC 8.3, LEARN_PROMPT "Operations") ----------
// A recursive AST. zod v4 supports recursive schemas via z.lazy + an explicit
// z.ZodType<T> annotation (SPEC 8.3 permits spelling to a fixed depth only as a
// fallback "if the provider's structured output doesn't support recursive
// schemas" - it does here). Depth <= 6 is enforced in code by checkRules, not
// by the schema itself.

export type ExprConstValue = string | number | boolean | null;

/** `keepChars`' closed set of named character classes (Unicode-aware: Hebrew letters are letters). */
export const KEEP_CHARS_CLASSES = ['digits', 'letters', 'lettersAndDigits'] as const;
export type KeepCharsClass = (typeof KEEP_CHARS_CLASSES)[number];

/**
 * True for a real calendar date written YYYY-MM-DD, between 1900-01-01 and 9999-12-31 (the range
 * the engine's dates can hold). Used by the `dateLiteral` schema and the formula parser; character
 * checks only, no regular expression.
 */
export function isIsoDateLiteral(s: string): boolean {
  if (s.length !== 10 || s[4] !== '-' || s[7] !== '-') return false;
  const digits = (from: number, to: number): number | undefined => {
    let n = 0;
    for (let i = from; i < to; i++) {
      const c = s.charCodeAt(i) - 48;
      if (c < 0 || c > 9) return undefined;
      n = n * 10 + c;
    }
    return n;
  };
  const y = digits(0, 4);
  const m = digits(5, 7);
  const d = digits(8, 10);
  if (y === undefined || m === undefined || d === undefined) return false;
  if (y < 1900 || m < 1 || m > 12 || d < 1) return false;
  // 1900 counts as a leap year, like Excel (and the engine's own calendar).
  const leap = y === 1900 || (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const days = m === 2 ? (leap ? 29 : 28) : [4, 6, 9, 11].includes(m) ? 30 : 31;
  return d <= days;
}

/** `param` is a leaf usable only inside a `transform.functions[].body` (SPEC 8.14);
 * `checkRules` rejects it everywhere else, and rejects `col` inside a function body. */
export type ExprLeaf = { col: string } | { const: ExprConstValue } | { param: string };

/** The condition-producing subset of Expr, usable anywhere an Expr is (e.g. `if.cond`). */
export type ConditionOp =
  | 'eq'
  | 'ne'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'isEmpty'
  | 'notEmpty'
  | 'oneOf'
  | 'startsWith'
  | 'endsWith'
  | 'contains'
  | 'and'
  | 'or'
  | 'not';

export type ExprNode =
  | { op: 'add' | 'sub' | 'mul' | 'div'; args: Expr[] }
  | { op: 'neg' | 'abs' | 'floor' | 'ceil'; arg: Expr }
  | { op: 'mod'; args: [Expr, Expr] }
  | { op: 'min' | 'max'; args: Expr[] }
  | { op: 'round'; arg: Expr; digits: number }
  | { op: 'concat'; args: Expr[] }
  | { op: 'substr'; arg: Expr; start: number; length: number }
  | { op: 'trim' | 'upper' | 'lower'; arg: Expr }
  | { op: 'length'; arg: Expr }
  | { op: 'replaceText'; arg: Expr; find: string; with: string }
  | { op: 'padLeft'; arg: Expr; length: number; char: string }
  /** SPEC 8.3: `index` is 1-based; negative counts from the end. Never 0. */
  | { op: 'split'; arg: Expr; separator: string; index: number }
  | { op: 'toNumber'; arg: Expr }
  | { op: 'toText'; arg: Expr; format?: string }
  | { op: 'datePart'; arg: Expr; part: 'year' | 'month' | 'day' }
  | { op: 'dateFormat'; arg: Expr; format: string }
  // DECISION: SPEC 8.3 writes dateAdd's amount the same way as e.g. round's `digits`
  // (a bare parameter next to `arg`, not a sub-expression), and requires "exactly one
  // of days|months|years". Modeled as a literal integer (not an Expr) on exactly one
  // of three keys, matching LEARN_PROMPT §"Operations": `dateAdd: "arg", "days"|"months"|"years"`.
  | ({ op: 'dateAdd'; arg: Expr } & (
      | { days: number; months?: never; years?: never }
      | { months: number; days?: never; years?: never }
      | { years: number; days?: never; months?: never }
    ))
  | { op: 'dateDiff'; args: [Expr, Expr]; unit: 'days' | 'months' | 'years' }
  | { op: 'endOfMonth'; arg: Expr }
  // Added after learn-v6 (formula text only so far - see `inPrompt` in the engine's OP_SIGNATURES):
  /** 1 = Sunday ... 7 = Saturday. */
  | { op: 'weekday'; arg: Expr }
  /** (year, month, day) -> a date; an impossible date is empty and flagged. */
  | { op: 'makeDate'; args: [Expr, Expr, Expr] }
  /** Text read with a date format (D, DD, M, MM, MMMM, MMM, YY, YYYY + literal separators). */
  | { op: 'toDate'; arg: Expr; format: string }
  /** A fixed date, written YYYY-MM-DD (formula: date("2026-01-31")). Has no Expr children. */
  | { op: 'dateLiteral'; value: string }
  | { op: 'keepChars'; arg: Expr; chars: KeepCharsClass }
  | { op: 'titleCase'; arg: Expr }
  /** 1-based position of the first occurrence of `search` (literal text), 0 when absent. */
  | { op: 'find'; arg: Expr; search: string }
  | { op: 'if'; cond: Expr; then: Expr; else: Expr }
  | { op: 'switch'; cases: { when: Expr; then: Expr }[]; else: Expr }
  | { op: 'coalesce'; args: Expr[] }
  | {
      op: 'lookup';
      table: string;
      key: Expr;
      return: string;
      onMissing: 'flag' | 'empty' | 'keep';
    }
  | { op: 'call'; fn: string; args: Expr[] }
  | { op: 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte'; args: [Expr, Expr] }
  | { op: 'isEmpty' | 'notEmpty'; arg: Expr }
  | { op: 'oneOf'; arg: Expr; values: ExprConstValue[] }
  | { op: 'startsWith' | 'endsWith' | 'contains'; arg: Expr; text: string }
  | { op: 'and' | 'or'; args: Expr[] }
  | { op: 'not'; arg: Expr };

export type Expr = ExprLeaf | ExprNode;

/** The subset of ExprNode that are conditions (per ConditionOp). Exported for callers
 * that build/inspect `if.cond` nodes without re-deriving the union by hand. */
export type Condition = Extract<ExprNode, { op: ConditionOp }>;

const ExprConstValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

/** Exported for `./wire.ts`: a leaf has depth 1 by definition (SPEC 8.3/`checkRules`'s
 * `exprDepth`), so this is the base case of the depth-bounded Expr chain it builds -
 * and also the leaf alternative inside every level of `buildExprSchema` below. */
export const ExprLeafSchema = z.union([
  z.strictObject({ col: z.string() }),
  z.strictObject({ const: ExprConstValueSchema }),
  z.strictObject({ param: z.string().min(1) }),
]);

// dateAdd needs "exactly one of days|months|years" (SPEC 8.3), which a single
// z.discriminatedUnion('op', ...) branch can't express (all three shapes share the
// literal op "dateAdd"). Modeled as its own z.union of three strict shapes and joined
// into the outer union alongside the op-discriminated union below, rather than inside it.
// Parameterized by `child` (see `buildExprSchema` below) instead of self-referencing
// `ExprSchema` directly, so `./wire.ts` can build the same shape at a bounded depth.
function buildDateAddSchema(child: z.ZodType<Expr>): z.ZodType<Extract<ExprNode, { op: 'dateAdd' }>> {
  return z.union([
    z.strictObject({ op: z.literal('dateAdd'), arg: child, days: z.number().int() }),
    z.strictObject({ op: z.literal('dateAdd'), arg: child, months: z.number().int() }),
    z.strictObject({ op: z.literal('dateAdd'), arg: child, years: z.number().int() }),
  ]);
}

const nonZeroInt = z
  .number()
  .int()
  .refine((v) => v !== 0, 'index must be non-zero (1-based; negative counts from the end)');

/**
 * Builds one "level" of the Expr node union - SPEC 8.3's whole "Operations" list, with
 * every Expr-shaped child field (`arg`, `args`, `cond`/`then`/`else`, `cases[].when`/
 * `.then`, `key`, ...) typed as `child` instead of self-referencing `Expr`. The real,
 * unbounded `ExprSchema` below is just this function applied to itself through `z.lazy`.
 *
 * `./wire.ts` calls this repeatedly, without self-reference, to build a strictly
 * decreasing (non-recursive) chain of JSON Schema `$defs` for the LLM-facing wire
 * schema: level 0 is `ExprLeafSchema` alone (depth budget exhausted - only a leaf
 * fits), level N is `buildExprSchema(level N-1)` (one more level of nesting allowed).
 * SPEC 8.3: "If the provider's structured output doesn't support recursive schemas,
 * spell expressions out to a fixed depth in the schema." Confirmed (via the
 * `claude-api` skill, against the current Anthropic structured-outputs docs) that
 * every model in the registry (`claude-haiku-4-5`, `claude-sonnet-5`) supports
 * `$ref`/`$def` but NOT a genuinely recursive (self-referencing/cyclic) schema; a
 * strictly-decreasing `$ref` chain (level N -> level N-1 -> ... -> level 0, never
 * back up) is not "recursive" in that sense, so it is unaffected.
 */
export function buildExprSchema(child: z.ZodType<Expr>): z.ZodType<Expr> {
  return z.union([
    ExprLeafSchema,
    buildDateAddSchema(child),
    z.discriminatedUnion('op', [
      z.strictObject({ op: z.literal('add'), args: z.array(child).min(1) }),
      z.strictObject({ op: z.literal('sub'), args: z.array(child).min(1) }),
      z.strictObject({ op: z.literal('mul'), args: z.array(child).min(1) }),
      z.strictObject({ op: z.literal('div'), args: z.array(child).min(1) }),
      z.strictObject({ op: z.literal('neg'), arg: child }),
      z.strictObject({ op: z.literal('abs'), arg: child }),
      z.strictObject({ op: z.literal('floor'), arg: child }),
      z.strictObject({ op: z.literal('ceil'), arg: child }),
      z.strictObject({ op: z.literal('mod'), args: z.tuple([child, child]) }),
      z.strictObject({ op: z.literal('min'), args: z.array(child).min(1) }),
      z.strictObject({ op: z.literal('max'), args: z.array(child).min(1) }),
      z.strictObject({ op: z.literal('round'), arg: child, digits: z.number().int() }),
      z.strictObject({ op: z.literal('concat'), args: z.array(child).min(1) }),
      z.strictObject({
        op: z.literal('substr'),
        arg: child,
        start: z.number().int(),
        length: z.number().int(),
      }),
      z.strictObject({ op: z.literal('trim'), arg: child }),
      z.strictObject({ op: z.literal('upper'), arg: child }),
      z.strictObject({ op: z.literal('lower'), arg: child }),
      z.strictObject({ op: z.literal('length'), arg: child }),
      z.strictObject({
        op: z.literal('replaceText'),
        arg: child,
        find: z.string(),
        with: z.string(),
      }),
      z.strictObject({
        op: z.literal('padLeft'),
        arg: child,
        length: z.number().int().positive(),
        char: z.string().min(1).max(1),
      }),
      z.strictObject({
        op: z.literal('split'),
        arg: child,
        separator: z.string().min(1),
        index: nonZeroInt,
      }),
      z.strictObject({ op: z.literal('toNumber'), arg: child }),
      z.strictObject({ op: z.literal('toText'), arg: child, format: z.string().optional() }),
      z.strictObject({
        op: z.literal('datePart'),
        arg: child,
        part: z.enum(['year', 'month', 'day']),
      }),
      z.strictObject({ op: z.literal('dateFormat'), arg: child, format: z.string() }),
      z.strictObject({
        op: z.literal('dateDiff'),
        args: z.tuple([child, child]),
        unit: z.enum(['days', 'months', 'years']),
      }),
      z.strictObject({ op: z.literal('endOfMonth'), arg: child }),
      z.strictObject({ op: z.literal('weekday'), arg: child }),
      z.strictObject({ op: z.literal('makeDate'), args: z.tuple([child, child, child]) }),
      z.strictObject({ op: z.literal('toDate'), arg: child, format: z.string().min(1) }),
      z.strictObject({
        op: z.literal('dateLiteral'),
        value: z.string().refine(isIsoDateLiteral, 'must be a real date written YYYY-MM-DD'),
      }),
      z.strictObject({ op: z.literal('keepChars'), arg: child, chars: z.enum(KEEP_CHARS_CLASSES) }),
      z.strictObject({ op: z.literal('titleCase'), arg: child }),
      z.strictObject({ op: z.literal('find'), arg: child, search: z.string().min(1) }),
      z.strictObject({
        op: z.literal('if'),
        cond: child,
        then: child,
        else: child,
      }),
      z.strictObject({
        op: z.literal('switch'),
        cases: z.array(z.strictObject({ when: child, then: child })).min(1),
        else: child,
      }),
      z.strictObject({ op: z.literal('coalesce'), args: z.array(child).min(1) }),
      z.strictObject({
        op: z.literal('lookup'),
        table: z.string().min(1),
        key: child,
        return: z.string().min(1),
        onMissing: z.enum(['flag', 'empty', 'keep']),
      }),
      z.strictObject({ op: z.literal('call'), fn: z.string().min(1), args: z.array(child) }),
      z.strictObject({ op: z.literal('eq'), args: z.tuple([child, child]) }),
      z.strictObject({ op: z.literal('ne'), args: z.tuple([child, child]) }),
      z.strictObject({ op: z.literal('gt'), args: z.tuple([child, child]) }),
      z.strictObject({ op: z.literal('gte'), args: z.tuple([child, child]) }),
      z.strictObject({ op: z.literal('lt'), args: z.tuple([child, child]) }),
      z.strictObject({ op: z.literal('lte'), args: z.tuple([child, child]) }),
      z.strictObject({ op: z.literal('isEmpty'), arg: child }),
      z.strictObject({ op: z.literal('notEmpty'), arg: child }),
      z.strictObject({
        op: z.literal('oneOf'),
        arg: child,
        values: z.array(ExprConstValueSchema).min(1),
      }),
      z.strictObject({ op: z.literal('startsWith'), arg: child, text: z.string() }),
      z.strictObject({ op: z.literal('endsWith'), arg: child, text: z.string() }),
      z.strictObject({ op: z.literal('contains'), arg: child, text: z.string() }),
      z.strictObject({ op: z.literal('and'), args: z.array(child).min(1) }),
      z.strictObject({ op: z.literal('or'), args: z.array(child).min(1) }),
      z.strictObject({ op: z.literal('not'), arg: child }),
    ]),
  ]) as z.ZodType<Expr>;
}

export const ExprSchema: z.ZodType<Expr> = z.lazy(() => buildExprSchema(ExprSchema));

// ---------- input.sheet / headerRow / stopAt (SPEC 8.1) ----------

export type InputSheetSelector =
  | { pick: 'first' }
  | { pick: 'name'; name: string }
  | { pick: 'index'; index: number };

export const InputSheetSelectorSchema = z.discriminatedUnion('pick', [
  z.strictObject({ pick: z.literal('first') }),
  z.strictObject({ pick: z.literal('name'), name: z.string() }),
  z.strictObject({ pick: z.literal('index'), index: z.number().int().min(0) }),
]);

export type HeaderRow = 'auto' | number;
export const HeaderRowSchema = z.union([z.literal('auto'), z.number().int().min(0)]);

export interface StopAt {
  when: 'firstCellMatches';
  values: string[];
}
export const StopAtSchema = z.strictObject({
  when: z.literal('firstCellMatches'),
  values: z.array(z.string()).min(1),
});

// ---------- input.columns (SPEC 8.1) ----------

export interface InputColumn {
  id: string;
  header: string;
  aliases?: string[];
  type: ColumnType;
  required?: boolean;
  padLeft?: number;
  inputFormats?: string[];
}
export const InputColumnSchema = z.strictObject({
  id: z.string().min(1),
  header: z.string(),
  aliases: z.array(z.string()).optional(),
  type: ColumnTypeSchema,
  required: z.boolean().optional(),
  padLeft: z.number().int().positive().optional(),
  inputFormats: z.array(z.string().min(1)).optional(),
});

// ---------- input.rowFilters (SPEC 8.3) ----------

export const ROW_FILTER_OPS = [
  'eq',
  'ne',
  'gt',
  'gte',
  'lt',
  'lte',
  'isEmpty',
  'notEmpty',
  'oneOf',
  'notOneOf',
] as const;
export type RowFilterOp = (typeof ROW_FILTER_OPS)[number];

export type FilterScalar = string | number | boolean | null;

export type RowFilter =
  | { column: string; op: 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte'; value: FilterScalar }
  | { column: string; op: 'isEmpty' | 'notEmpty' }
  | { column: string; op: 'oneOf' | 'notOneOf'; value: FilterScalar[] }
  // SPEC 8.3: "{ column, op, value? } for simple cases, or { expr } where expr is any
  // condition." Schema-level this just takes any Expr; that its result type is boolean
  // is a static TYPE check (SPEC 9.2 layer 3), which is the engine's typeCheck, not ours.
  | { expr: Expr };

const FilterScalarSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

const SimpleRowFilterSchema = z.discriminatedUnion('op', [
  z.strictObject({ column: z.string(), op: z.literal('eq'), value: FilterScalarSchema }),
  z.strictObject({ column: z.string(), op: z.literal('ne'), value: FilterScalarSchema }),
  z.strictObject({ column: z.string(), op: z.literal('gt'), value: FilterScalarSchema }),
  z.strictObject({ column: z.string(), op: z.literal('gte'), value: FilterScalarSchema }),
  z.strictObject({ column: z.string(), op: z.literal('lt'), value: FilterScalarSchema }),
  z.strictObject({ column: z.string(), op: z.literal('lte'), value: FilterScalarSchema }),
  z.strictObject({ column: z.string(), op: z.literal('isEmpty') }),
  z.strictObject({ column: z.string(), op: z.literal('notEmpty') }),
  z.strictObject({
    column: z.string(),
    op: z.literal('oneOf'),
    value: z.array(FilterScalarSchema).min(1),
  }),
  z.strictObject({
    column: z.string(),
    op: z.literal('notOneOf'),
    value: z.array(FilterScalarSchema).min(1),
  }),
]);

/** Parameterized by `exprSchema` so `./wire.ts` can build the same shape with a
 * depth-bounded Expr instead of the real, self-referencing `ExprSchema`. */
export function buildRowFilterSchema(exprSchema: z.ZodType<Expr>): z.ZodType<RowFilter> {
  return z.union([SimpleRowFilterSchema, z.strictObject({ expr: exprSchema })]) as z.ZodType<RowFilter>;
}
export const RowFilterSchema = buildRowFilterSchema(ExprSchema);

// ---------- input (SPEC 8.1) ----------

export interface RulesInput {
  sheet: InputSheetSelector;
  headerRow: HeaderRow;
  stopAt?: StopAt;
  columns: InputColumn[];
  rowFilters?: RowFilter[];
}
/** Parameterized by `exprSchema` (see `buildRowFilterSchema`) for `./wire.ts`. */
export function buildRulesInputSchema(exprSchema: z.ZodType<Expr>): z.ZodType<RulesInput> {
  return z.strictObject({
    sheet: InputSheetSelectorSchema,
    headerRow: HeaderRowSchema,
    stopAt: StopAtSchema.optional(),
    columns: z.array(InputColumnSchema).min(1),
    rowFilters: z.array(buildRowFilterSchema(exprSchema)).optional(),
  });
}
export const RulesInputSchema = buildRulesInputSchema(ExprSchema);

// ---------- transform.dedupe (SPEC 8.4) ----------

export interface Dedupe {
  keys: string[] | 'all';
  keep: 'first' | 'last';
  action: 'remove' | 'flag';
}
export const DedupeSchema = z.strictObject({
  keys: z.union([z.array(z.string()).min(1), z.literal('all')]),
  keep: z.enum(['first', 'last']),
  action: z.enum(['remove', 'flag']),
});

// ---------- transform.expand (SPEC 8.5) ----------

export type Expand =
  | {
      mode: 'columnsToRows';
      columns: string[];
      labelId: string;
      labels?: Record<string, string>;
      valueId: string;
      valueType: ColumnType;
      skipEmpty: boolean;
    }
  | {
      mode: 'splitCell';
      column: string;
      separator: string;
      trim: boolean;
      partId: string;
      indexId?: string;
      countId?: string;
      skipEmpty: boolean;
    }
  | {
      mode: 'fixedFanOut';
      rows: { set: Record<string, Expr> }[];
    };

/**
 * Parameterized by two pre-built schemas for the operation's two genuine open
 * dictionaries: `labelsSchema` for `columnsToRows.labels` (`Record<string,string>` by
 * default) and `setSchema` for `fixedFanOut.rows[].set` (`Record<string,Expr>` by
 * default). `./wire.ts` passes wire-array (`{key,value}[]`) shapes instead, so the
 * LLM-facing JSON Schema has no open dictionaries at all (OpenAI strict mode and
 * Anthropic structured outputs both reject `additionalProperties` other than `false`).
 */
export function buildExpandSchema(opts: {
  labelsSchema: z.ZodType;
  setSchema: z.ZodType;
}): z.ZodType<Expand> {
  return z.discriminatedUnion('mode', [
    z.strictObject({
      mode: z.literal('columnsToRows'),
      columns: z.array(z.string()).min(1),
      labelId: z.string().min(1),
      labels: opts.labelsSchema.optional(),
      valueId: z.string().min(1),
      valueType: ColumnTypeSchema,
      skipEmpty: z.boolean(),
    }),
    z.strictObject({
      mode: z.literal('splitCell'),
      column: z.string(),
      separator: z.string().min(1),
      trim: z.boolean(),
      partId: z.string().min(1),
      indexId: z.string().min(1).optional(),
      countId: z.string().min(1).optional(),
      skipEmpty: z.boolean(),
    }),
    z.strictObject({
      mode: z.literal('fixedFanOut'),
      rows: z.array(z.strictObject({ set: opts.setSchema })).min(1),
    }),
  ]) as unknown as z.ZodType<Expand>;
}
export const ExpandSchema = buildExpandSchema({
  labelsSchema: z.record(z.string(), z.string()),
  setSchema: z.record(z.string(), ExprSchema),
});

// ---------- transform.computed (SPEC 8.2 step 6) ----------

export interface Computed {
  id: string;
  type: ColumnType;
  expr: Expr;
}
/** Parameterized by `exprSchema` (see `buildExprSchema`) for `./wire.ts`. */
export function buildComputedSchema(exprSchema: z.ZodType<Expr>): z.ZodType<Computed> {
  return z.strictObject({
    id: z.string().min(1),
    type: ColumnTypeSchema,
    expr: exprSchema,
  });
}
export const ComputedSchema = buildComputedSchema(ExprSchema);

// ---------- transform.valueMaps ----------

export interface ValueMap {
  column: string;
  map: Record<string, string>;
  onMissing: 'flag' | 'keep';
}
/** Parameterized by `mapSchema` (the open dictionary) for `./wire.ts`. */
export function buildValueMapSchema(mapSchema: z.ZodType): z.ZodType<ValueMap> {
  return z.strictObject({
    column: z.string(),
    map: mapSchema,
    onMissing: z.enum(['flag', 'keep']),
  }) as unknown as z.ZodType<ValueMap>;
}
export const ValueMapSchema = buildValueMapSchema(z.record(z.string(), z.string()));

// ---------- transform.sort ----------

export interface SortKey {
  column: string;
  dir: 'asc' | 'desc';
}
export const SortKeySchema = z.strictObject({
  column: z.string(),
  dir: z.enum(['asc', 'desc']),
});

// ---------- summaryRows (SPEC 8.12 v4: generic summary rows) ----------
// v4 DECISION (replaces the v1-v3 sum-only `output.grandTotal` / `group.subtotal`):
// a summary row names its cells by OUTPUT HEADER, not by id, so - like the rest of
// `output` - it belongs to the format and is identical across every source of that
// format (SPEC 8.12), with no id-to-header translation needed. `count` counts
// non-empty cells (blocked rows never count, same as today); `min`/`max` work on
// numbers and dates; `sum`/`average` need a numeric column (checked by the engine's
// typeCheck, since this schema has no type information); `first`/`last` are the
// first/last non-empty value of the rows the row summarizes (the group, or - for
// `output.summaryRows` - all rows).

export const SUMMARY_AGGS = ['sum', 'count', 'min', 'max', 'average', 'first', 'last'] as const;
export const SummaryAggSchema = z.enum(SUMMARY_AGGS);

export interface SummaryRow {
  /** Label text, as written (omit for a summary row with no label). */
  label?: string;
  /** Output header of the column that shows `label`. When omitted, the engine uses
   * the first output column with no entry in `cells` (falling back to column 0). */
  labelColumn?: string;
  bold?: boolean;
  /** Output header -> the aggregate that fills that column's cell. */
  cells: Record<string, SummaryAgg>;
}
/** Parameterized by `cellsSchema` (the open dictionary) for `./wire.ts`. Not one of
 * the three open dictionaries LEARN_PROMPT §5 names explicitly, but structurally the
 * same problem (`Record<output header, SummaryAgg>`), so it gets the same treatment -
 * confirmed by the "no open-dictionary objects" test in `wire.test.ts`. */
export function buildSummaryRowSchema(cellsSchema: z.ZodType): z.ZodType<SummaryRow> {
  return z.strictObject({
    label: z.string().optional(),
    labelColumn: z.string().optional(),
    bold: z.boolean().optional(),
    cells: cellsSchema,
  }) as unknown as z.ZodType<SummaryRow>;
}
export const SummaryRowSchema = buildSummaryRowSchema(z.record(z.string(), SummaryAggSchema));

// ---------- transform.group ----------

/** @deprecated SPEC 21 v4: replaced by `Group.summaryRows`. Stored rules files
 * (`RulesSchema`) may still carry it; the LLM (`LearnResultSchema`) never writes it -
 * the engine translates it into a `summaryRows` entry at run time (SPEC 21 v4). */
export interface GroupSubtotal {
  labelColumn: string;
  label: string;
  sum: string[];
}
export const GroupSubtotalSchema = z.strictObject({
  labelColumn: z.string(),
  label: z.string(),
  sum: z.array(z.string()).min(1),
});

export interface Group {
  by: string;
  showDetailRows: boolean;
  /** @deprecated SPEC 21 v4: replaced by `summaryRows`. */
  subtotal?: GroupSubtotal;
  blankRowsAfter?: number;
  /** SPEC 8.12 v4: summary rows after this group, in order, before `blankRowsAfter`. */
  summaryRows?: SummaryRow[];
}
/** Parameterized by `summaryRowSchema` (see `buildSummaryRowSchema`) for `./wire.ts`.
 * No `z.ZodType<Group>` return annotation (unlike the other `buildX` factories above) -
 * `StoredGroupSchema` below needs `.extend()`, which a `z.ZodType`-erased return type
 * would lose; the plain object-literal type this infers is close enough to `Group` for
 * every call site (`.safeParse().data` flowing into a `Group`/`RulesTransform`-typed
 * variable) to still typecheck structurally. */
export function buildGroupSchema(summaryRowSchema: z.ZodType<SummaryRow>) {
  return z.strictObject({
    by: z.string(),
    showDetailRows: z.boolean(),
    blankRowsAfter: z.number().int().min(0).optional(),
    summaryRows: z.array(summaryRowSchema).optional(),
  });
}
export const GroupSchema = buildGroupSchema(SummaryRowSchema);
/** SPEC 21 v4 backward compatibility: accepts the deprecated `subtotal` too, for
 * stored rules files (`RulesSchema`) only - never for `LearnResultSchema`. */
export const StoredGroupSchema = GroupSchema.extend({
  subtotal: GroupSubtotalSchema.optional(),
});

// ---------- transform.functions / transform.tables (SPEC 8.14) ----------

export interface FunctionParam {
  name: string;
  type: ValueType;
}
export const FunctionParamSchema = z.strictObject({
  name: z.string().min(1),
  type: ValueTypeSchema,
});

export interface RulesFunction {
  name: string;
  params: FunctionParam[];
  returns: ValueType;
  body: Expr;
}
/** Parameterized by `exprSchema` (see `buildExprSchema`) for `./wire.ts`. */
export function buildRulesFunctionSchema(exprSchema: z.ZodType<Expr>): z.ZodType<RulesFunction> {
  return z.strictObject({
    name: z.string().min(1),
    params: z.array(FunctionParamSchema),
    returns: ValueTypeSchema,
    body: exprSchema,
  }) as unknown as z.ZodType<RulesFunction>;
}
export const RulesFunctionSchema = buildRulesFunctionSchema(ExprSchema);

export type TableCellValue = string | number | boolean | null;
const TableCellValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

export interface RulesTable {
  name: string;
  columns: string[];
  rows: TableCellValue[][];
}
export const RulesTableSchema = z.strictObject({
  name: z.string().min(1),
  columns: z.array(z.string().min(1)).min(1),
  rows: z.array(z.array(TableCellValueSchema)),
});

// ---------- transform (SPEC 8.1 / LEARN_PROMPT §5: dedupe/expand optional, rest required) ----------

export interface RulesTransform {
  dedupe?: Dedupe;
  expand?: Expand;
  computed: Computed[];
  valueMaps: ValueMap[];
  sort: SortKey[];
  group?: Group;
  /** SPEC 8.14: reusable logic, both optional so v1 rules files keep loading. */
  functions?: RulesFunction[];
  tables?: RulesTable[];
}
/**
 * Parameterized by the same Expr/open-dictionary building blocks as its parts, for
 * `./wire.ts`: `exprSchema` (see `buildExprSchema`), `stringMapSchema` (the open
 * dictionary behind `valueMaps[].map` and `expand.columnsToRows.labels` -
 * `Record<string,string>` by default), `exprMapSchema` (behind
 * `expand.fixedFanOut.rows[].set` - `Record<string,Expr>` by default) and
 * `summaryRowSchema` (see `buildSummaryRowSchema`, behind `group.summaryRows`).
 */
// No `z.ZodType<RulesTransform>` return annotation - see `buildGroupSchema`'s comment;
// `StoredRulesTransformSchema` below needs `.extend()`.
export function buildRulesTransformSchema(opts: {
  exprSchema: z.ZodType<Expr>;
  stringMapSchema: z.ZodType;
  exprMapSchema: z.ZodType;
  summaryRowSchema: z.ZodType<SummaryRow>;
}) {
  return z.strictObject({
    dedupe: DedupeSchema.optional(),
    expand: buildExpandSchema({ labelsSchema: opts.stringMapSchema, setSchema: opts.exprMapSchema }).optional(),
    functions: z.array(buildRulesFunctionSchema(opts.exprSchema)).optional(),
    tables: z.array(RulesTableSchema).optional(),
    computed: z.array(buildComputedSchema(opts.exprSchema)),
    valueMaps: z.array(buildValueMapSchema(opts.stringMapSchema)),
    sort: z.array(SortKeySchema),
    group: buildGroupSchema(opts.summaryRowSchema).optional(),
  });
}
export const RulesTransformSchema = buildRulesTransformSchema({
  exprSchema: ExprSchema,
  stringMapSchema: z.record(z.string(), z.string()),
  exprMapSchema: z.record(z.string(), ExprSchema),
  summaryRowSchema: SummaryRowSchema,
});
/** SPEC 21 v4 backward compatibility: `group` accepts the deprecated `subtotal`
 * (`StoredGroupSchema`), for stored rules files (`RulesSchema`) only. */
export const StoredRulesTransformSchema = RulesTransformSchema.extend({
  group: StoredGroupSchema.optional(),
});

// ---------- output.titleRows (SPEC 8.7) ----------

export type TitleRowPart = { text: string } | { agg: 'min' | 'max'; column: string; format: string };
export type TitleRow =
  | { text: string; bold?: boolean }
  | { blank: true }
  | { parts: TitleRowPart[]; bold?: boolean };

const TitleRowPartSchema = z.union([
  z.strictObject({ text: z.string() }),
  z.strictObject({ agg: z.enum(['min', 'max']), column: z.string(), format: z.string() }),
]);

export const TitleRowSchema = z.union([
  z.strictObject({ text: z.string(), bold: z.boolean().optional() }),
  z.strictObject({ blank: z.literal(true) }),
  z.strictObject({ parts: z.array(TitleRowPartSchema).min(1), bold: z.boolean().optional() }),
]);

// ---------- output.columns / headerStyle / grandTotal (SPEC 8.1, 8.6) ----------

/** SPEC 8.6/21 v4: the same aggregate set as `SummaryAgg` (extended with `average`
 * and `last` in v4, for consistency between a summary output's per-column `agg` and
 * a generic summary row's `cells` aggregate). */
export const OUTPUT_COLUMN_AGGS = SUMMARY_AGGS;
export type OutputColumnAgg = (typeof OUTPUT_COLUMN_AGGS)[number];

export interface OutputColumnRule {
  header: string;
  from: string | null;
  format?: string;
  width?: number;
  agg?: OutputColumnAgg;
}
export const OutputColumnRuleSchema = z.strictObject({
  header: z.string(),
  from: z.union([z.string(), z.null()]),
  format: z.string().optional(),
  width: z.number().positive().optional(),
  agg: z.enum(OUTPUT_COLUMN_AGGS).optional(),
});

export interface HeaderStyle {
  bold?: boolean;
}
export const HeaderStyleSchema = z.strictObject({ bold: z.boolean().optional() });

/** @deprecated SPEC 21 v4: replaced by `RulesOutput.summaryRows`. Stored rules files
 * (`RulesSchema`) may still carry it; the LLM (`LearnResultSchema`) never writes it -
 * the engine translates it into a `summaryRows` entry at run time (SPEC 21 v4). */
export interface GrandTotal {
  labelColumn: string;
  label: string;
  sum: string[];
}
export const GrandTotalSchema = z.strictObject({
  labelColumn: z.string(),
  label: z.string(),
  sum: z.array(z.string()).min(1),
});

// ---------- output.file (SPEC 8.13) ----------

export const OUTPUT_FILE_TYPES = ['xlsx', 'csv', 'txt'] as const;
export type OutputFileType = (typeof OUTPUT_FILE_TYPES)[number];

export const OUTPUT_FILE_DELIMITERS = [',', '\t', ';', '|'] as const;
export type OutputFileDelimiter = (typeof OUTPUT_FILE_DELIMITERS)[number];

export const OUTPUT_FILE_ENCODINGS = ['utf8bom', 'utf8', 'windows1255'] as const;
export type OutputFileEncoding = (typeof OUTPUT_FILE_ENCODINGS)[number];

export const OUTPUT_FILE_QUOTES = ['minimal', 'all', 'none'] as const;
export type OutputFileQuote = (typeof OUTPUT_FILE_QUOTES)[number];

export interface OutputFile {
  type: OutputFileType;
  delimiter?: OutputFileDelimiter;
  header?: boolean;
  encoding?: OutputFileEncoding;
  quote?: OutputFileQuote;
}
export const OutputFileSchema = z.strictObject({
  type: z.enum(OUTPUT_FILE_TYPES),
  delimiter: z.enum(OUTPUT_FILE_DELIMITERS).optional(),
  header: z.boolean().optional(),
  encoding: z.enum(OUTPUT_FILE_ENCODINGS).optional(),
  quote: z.enum(OUTPUT_FILE_QUOTES).optional(),
});

/** SPEC 8.13: "The default is `{ type: 'xlsx' }`" when `output.file` is absent. */
export const DEFAULT_OUTPUT_FILE: OutputFile = { type: 'xlsx' };

// ---------- output (SPEC 8.1) ----------

export interface RulesOutput {
  file?: OutputFile;
  sheetName: string;
  direction: 'rtl' | 'ltr';
  language: 'he' | 'en';
  titleRows: TitleRow[];
  columns: OutputColumnRule[];
  headerStyle?: HeaderStyle;
  /** @deprecated SPEC 21 v4: replaced by `summaryRows`. */
  grandTotal?: GrandTotal;
  /** SPEC 8.12 v4: summary rows after all data rows, in order. */
  summaryRows?: SummaryRow[];
}
// No `z.ZodType<RulesOutput>` return annotation - see `buildGroupSchema`'s comment;
// `StoredRulesOutputSchema` below needs `.extend()`.
export function buildRulesOutputSchema(summaryRowSchema: z.ZodType<SummaryRow>) {
  return z.strictObject({
    file: OutputFileSchema.optional(),
    sheetName: z.string(),
    direction: z.enum(['rtl', 'ltr']),
    language: z.enum(['he', 'en']),
    titleRows: z.array(TitleRowSchema),
    columns: z.array(OutputColumnRuleSchema).min(1),
    headerStyle: HeaderStyleSchema.optional(),
    summaryRows: z.array(summaryRowSchema).optional(),
  });
}
export const RulesOutputSchema = buildRulesOutputSchema(SummaryRowSchema);
/** SPEC 21 v4 backward compatibility: accepts the deprecated `grandTotal` too, for
 * stored rules files (`RulesSchema`) only - never for `LearnResultSchema`. */
export const StoredRulesOutputSchema = RulesOutputSchema.extend({
  grandTotal: GrandTotalSchema.optional(),
});

// ---------- validations (SPEC 8.8) ----------

export type ValidationSeverity = 'flag' | 'block';
const SeveritySchema = z.enum(['flag', 'block']);

/** SPEC 8.8: `on` defaults to "input". "output" means `column` names an output header
 * instead of an input/computed id, and the check belongs to the format (8.12). */
export type ValidationOn = 'input' | 'output';
const ValidationOnSchema = z.enum(['input', 'output']).optional();

const DateStringSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');

export type Validation =
  | { on?: ValidationOn; column: string; rule: 'required'; severity: ValidationSeverity }
  | { on?: ValidationOn; column: string; rule: 'israeliIdChecksum'; severity: ValidationSeverity }
  | {
      on?: ValidationOn;
      column: string;
      rule: 'range';
      min?: number;
      max?: number;
      severity: ValidationSeverity;
    }
  | {
      on?: ValidationOn;
      column: string;
      rule: 'lengthEquals';
      length: number;
      severity: ValidationSeverity;
    }
  | {
      on?: ValidationOn;
      column: string;
      rule: 'oneOf';
      values: string[];
      severity: ValidationSeverity;
    }
  | { on?: ValidationOn; column: string; rule: 'unique'; severity: ValidationSeverity }
  | {
      on?: ValidationOn;
      column: string;
      rule: 'dateRange';
      from: string;
      to: string;
      severity: ValidationSeverity;
    };

export const ValidationSchema = z.discriminatedUnion('rule', [
  z.strictObject({
    on: ValidationOnSchema,
    column: z.string(),
    rule: z.literal('required'),
    severity: SeveritySchema,
  }),
  z.strictObject({
    on: ValidationOnSchema,
    column: z.string(),
    rule: z.literal('israeliIdChecksum'),
    severity: SeveritySchema,
  }),
  z.strictObject({
    on: ValidationOnSchema,
    column: z.string(),
    rule: z.literal('range'),
    min: z.number().optional(),
    max: z.number().optional(),
    severity: SeveritySchema,
  }),
  z.strictObject({
    on: ValidationOnSchema,
    column: z.string(),
    rule: z.literal('lengthEquals'),
    length: z.number().int().positive(),
    severity: SeveritySchema,
  }),
  z.strictObject({
    on: ValidationOnSchema,
    column: z.string(),
    rule: z.literal('oneOf'),
    values: z.array(z.string()).min(1),
    severity: SeveritySchema,
  }),
  z.strictObject({
    on: ValidationOnSchema,
    column: z.string(),
    rule: z.literal('unique'),
    severity: SeveritySchema,
  }),
  z.strictObject({
    on: ValidationOnSchema,
    column: z.string(),
    rule: z.literal('dateRange'),
    from: DateStringSchema,
    to: DateStringSchema,
    severity: SeveritySchema,
  }),
]);

// ---------- unsupported / assumptions (SPEC 8.10) ----------

export interface Unsupported {
  outputColumn: string;
  reasonCode: UnsupportedReasonCode;
}
export const UnsupportedSchema = z.strictObject({
  outputColumn: z.string(),
  reasonCode: z.enum(UNSUPPORTED_REASON_CODES),
});

export interface Assumption {
  outputColumn?: string;
  reasonCode: AssumptionReasonCode;
}
export const AssumptionSchema = z.strictObject({
  outputColumn: z.string().optional(),
  reasonCode: z.enum(ASSUMPTION_REASON_CODES),
});

// ---------- LearnResult (LEARN_PROMPT §5) and Rules (SPEC 8.1) ----------

const learnResultShape = {
  schemaVersion: z.literal(1),
  input: RulesInputSchema,
  transform: RulesTransformSchema,
  output: RulesOutputSchema,
  validations: z.array(ValidationSchema),
  unsupported: z.array(UnsupportedSchema),
  assumptions: z.array(AssumptionSchema),
};

export interface LearnResult {
  schemaVersion: 1;
  input: RulesInput;
  transform: RulesTransform;
  output: RulesOutput;
  validations: Validation[];
  unsupported: Unsupported[];
  assumptions: Assumption[];
}
export const LearnResultSchema = z.strictObject(learnResultShape);

// meta.source / meta.status per SPEC 5 (flow B, kept in the schema now, not built yet)
// and SPEC 13 (formats.status).
export const RULES_META_SOURCES = ['examplePair', 'inputDescription', 'descriptionOnly'] as const;
export type RulesMetaSource = (typeof RULES_META_SOURCES)[number];

export const RULES_META_STATUSES = [
  'verified',
  'differencesAccepted',
  'userConfirmed',
  'draft',
  // SPEC 8.12 "Editing a format": conversions whose `from` references stop resolving
  // after a format edit become needsReview, since example files aren't stored for
  // re-verification (SPEC 13 formats.status/conversions.status already listed it).
  'needsReview',
] as const;
export type RulesMetaStatus = (typeof RULES_META_STATUSES)[number];

export const RULES_META_LEARN_PATHS = ['local', 'llm', 'cache'] as const;
export type RulesMetaLearnPath = (typeof RULES_META_LEARN_PATHS)[number];

export interface RulesMeta {
  /** SPEC 8.12/13: set once this conversion belongs to a saved format. */
  formatId?: string;
  /** SPEC 8.12/13: the source name (e.g. the supplier) this conversion was taught for. */
  sourceName?: string;
  source: RulesMetaSource;
  status: RulesMetaStatus;
  model?: string;
  promptVersion?: string;
  masking?: boolean;
  learnPath?: RulesMetaLearnPath;
  createdAt?: string;
}
export const RulesMetaSchema = z.strictObject({
  formatId: z.string().min(1).optional(),
  sourceName: z.string().min(1).optional(),
  source: z.enum(RULES_META_SOURCES),
  status: z.enum(RULES_META_STATUSES),
  model: z.string().optional(),
  promptVersion: z.string().optional(),
  masking: z.boolean().optional(),
  learnPath: z.enum(RULES_META_LEARN_PATHS).optional(),
  createdAt: z.string().optional(),
});

export interface Rules extends LearnResult {
  name: string;
  meta: RulesMeta;
}
/** SPEC 21 v4 backward compatibility: unlike `LearnResultSchema`, a stored rules file
 * may still carry the deprecated `transform.group.subtotal` / `output.grandTotal`
 * (`StoredRulesTransformSchema` / `StoredRulesOutputSchema`) - a format learned before
 * v4 keeps loading and running exactly as before. The LLM never writes them; see
 * `LearnResultSchema` below. */
export const RulesSchema = z.strictObject({
  ...learnResultShape,
  transform: StoredRulesTransformSchema,
  output: StoredRulesOutputSchema,
  name: z.string().min(1),
  meta: RulesMetaSchema,
});
