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

const ExprLeafSchema = z.union([
  z.strictObject({ col: z.string() }),
  z.strictObject({ const: ExprConstValueSchema }),
  z.strictObject({ param: z.string().min(1) }),
]);

// dateAdd needs "exactly one of days|months|years" (SPEC 8.3), which a single
// z.discriminatedUnion('op', ...) branch can't express (all three shapes share the
// literal op "dateAdd"). Modeled as its own z.union of three strict shapes and joined
// into the outer union alongside the op-discriminated union below, rather than inside it.
// Wrapped in z.lazy (like ExprSchema itself) since it references ExprSchema before that
// const finishes initializing.
const DateAddSchema: z.ZodType<Extract<ExprNode, { op: 'dateAdd' }>> = z.lazy(() =>
  z.union([
    z.strictObject({ op: z.literal('dateAdd'), arg: ExprSchema, days: z.number().int() }),
    z.strictObject({ op: z.literal('dateAdd'), arg: ExprSchema, months: z.number().int() }),
    z.strictObject({ op: z.literal('dateAdd'), arg: ExprSchema, years: z.number().int() }),
  ]),
);

const nonZeroInt = z
  .number()
  .int()
  .refine((v) => v !== 0, 'index must be non-zero (1-based; negative counts from the end)');

export const ExprSchema: z.ZodType<Expr> = z.lazy(() =>
  z.union([
    ExprLeafSchema,
    DateAddSchema,
    z.discriminatedUnion('op', [
      z.strictObject({ op: z.literal('add'), args: z.array(ExprSchema).min(1) }),
      z.strictObject({ op: z.literal('sub'), args: z.array(ExprSchema).min(1) }),
      z.strictObject({ op: z.literal('mul'), args: z.array(ExprSchema).min(1) }),
      z.strictObject({ op: z.literal('div'), args: z.array(ExprSchema).min(1) }),
      z.strictObject({ op: z.literal('neg'), arg: ExprSchema }),
      z.strictObject({ op: z.literal('abs'), arg: ExprSchema }),
      z.strictObject({ op: z.literal('floor'), arg: ExprSchema }),
      z.strictObject({ op: z.literal('ceil'), arg: ExprSchema }),
      z.strictObject({ op: z.literal('mod'), args: z.tuple([ExprSchema, ExprSchema]) }),
      z.strictObject({ op: z.literal('min'), args: z.array(ExprSchema).min(1) }),
      z.strictObject({ op: z.literal('max'), args: z.array(ExprSchema).min(1) }),
      z.strictObject({ op: z.literal('round'), arg: ExprSchema, digits: z.number().int() }),
      z.strictObject({ op: z.literal('concat'), args: z.array(ExprSchema).min(1) }),
      z.strictObject({
        op: z.literal('substr'),
        arg: ExprSchema,
        start: z.number().int(),
        length: z.number().int(),
      }),
      z.strictObject({ op: z.literal('trim'), arg: ExprSchema }),
      z.strictObject({ op: z.literal('upper'), arg: ExprSchema }),
      z.strictObject({ op: z.literal('lower'), arg: ExprSchema }),
      z.strictObject({ op: z.literal('length'), arg: ExprSchema }),
      z.strictObject({
        op: z.literal('replaceText'),
        arg: ExprSchema,
        find: z.string(),
        with: z.string(),
      }),
      z.strictObject({
        op: z.literal('padLeft'),
        arg: ExprSchema,
        length: z.number().int().positive(),
        char: z.string().min(1).max(1),
      }),
      z.strictObject({
        op: z.literal('split'),
        arg: ExprSchema,
        separator: z.string().min(1),
        index: nonZeroInt,
      }),
      z.strictObject({ op: z.literal('toNumber'), arg: ExprSchema }),
      z.strictObject({ op: z.literal('toText'), arg: ExprSchema, format: z.string().optional() }),
      z.strictObject({
        op: z.literal('datePart'),
        arg: ExprSchema,
        part: z.enum(['year', 'month', 'day']),
      }),
      z.strictObject({ op: z.literal('dateFormat'), arg: ExprSchema, format: z.string() }),
      z.strictObject({
        op: z.literal('dateDiff'),
        args: z.tuple([ExprSchema, ExprSchema]),
        unit: z.enum(['days', 'months', 'years']),
      }),
      z.strictObject({ op: z.literal('endOfMonth'), arg: ExprSchema }),
      z.strictObject({
        op: z.literal('if'),
        cond: ExprSchema,
        then: ExprSchema,
        else: ExprSchema,
      }),
      z.strictObject({
        op: z.literal('switch'),
        cases: z.array(z.strictObject({ when: ExprSchema, then: ExprSchema })).min(1),
        else: ExprSchema,
      }),
      z.strictObject({ op: z.literal('coalesce'), args: z.array(ExprSchema).min(1) }),
      z.strictObject({
        op: z.literal('lookup'),
        table: z.string().min(1),
        key: ExprSchema,
        return: z.string().min(1),
        onMissing: z.enum(['flag', 'empty', 'keep']),
      }),
      z.strictObject({ op: z.literal('call'), fn: z.string().min(1), args: z.array(ExprSchema) }),
      z.strictObject({ op: z.literal('eq'), args: z.tuple([ExprSchema, ExprSchema]) }),
      z.strictObject({ op: z.literal('ne'), args: z.tuple([ExprSchema, ExprSchema]) }),
      z.strictObject({ op: z.literal('gt'), args: z.tuple([ExprSchema, ExprSchema]) }),
      z.strictObject({ op: z.literal('gte'), args: z.tuple([ExprSchema, ExprSchema]) }),
      z.strictObject({ op: z.literal('lt'), args: z.tuple([ExprSchema, ExprSchema]) }),
      z.strictObject({ op: z.literal('lte'), args: z.tuple([ExprSchema, ExprSchema]) }),
      z.strictObject({ op: z.literal('isEmpty'), arg: ExprSchema }),
      z.strictObject({ op: z.literal('notEmpty'), arg: ExprSchema }),
      z.strictObject({
        op: z.literal('oneOf'),
        arg: ExprSchema,
        values: z.array(ExprConstValueSchema).min(1),
      }),
      z.strictObject({ op: z.literal('startsWith'), arg: ExprSchema, text: z.string() }),
      z.strictObject({ op: z.literal('endsWith'), arg: ExprSchema, text: z.string() }),
      z.strictObject({ op: z.literal('contains'), arg: ExprSchema, text: z.string() }),
      z.strictObject({ op: z.literal('and'), args: z.array(ExprSchema).min(1) }),
      z.strictObject({ op: z.literal('or'), args: z.array(ExprSchema).min(1) }),
      z.strictObject({ op: z.literal('not'), arg: ExprSchema }),
    ]),
  ]),
);

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

export const RowFilterSchema = z.union([
  SimpleRowFilterSchema,
  z.strictObject({ expr: ExprSchema }),
]);

// ---------- input (SPEC 8.1) ----------

export interface RulesInput {
  sheet: InputSheetSelector;
  headerRow: HeaderRow;
  stopAt?: StopAt;
  columns: InputColumn[];
  rowFilters?: RowFilter[];
}
export const RulesInputSchema = z.strictObject({
  sheet: InputSheetSelectorSchema,
  headerRow: HeaderRowSchema,
  stopAt: StopAtSchema.optional(),
  columns: z.array(InputColumnSchema).min(1),
  rowFilters: z.array(RowFilterSchema).optional(),
});

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

export const ExpandSchema = z.discriminatedUnion('mode', [
  z.strictObject({
    mode: z.literal('columnsToRows'),
    columns: z.array(z.string()).min(1),
    labelId: z.string().min(1),
    labels: z.record(z.string(), z.string()).optional(),
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
    rows: z
      .array(z.strictObject({ set: z.record(z.string(), ExprSchema) }))
      .min(1),
  }),
]);

// ---------- transform.computed (SPEC 8.2 step 6) ----------

export interface Computed {
  id: string;
  type: ColumnType;
  expr: Expr;
}
export const ComputedSchema = z.strictObject({
  id: z.string().min(1),
  type: ColumnTypeSchema,
  expr: ExprSchema,
});

// ---------- transform.valueMaps ----------

export interface ValueMap {
  column: string;
  map: Record<string, string>;
  onMissing: 'flag' | 'keep';
}
export const ValueMapSchema = z.strictObject({
  column: z.string(),
  map: z.record(z.string(), z.string()),
  onMissing: z.enum(['flag', 'keep']),
});

// ---------- transform.sort ----------

export interface SortKey {
  column: string;
  dir: 'asc' | 'desc';
}
export const SortKeySchema = z.strictObject({
  column: z.string(),
  dir: z.enum(['asc', 'desc']),
});

// ---------- transform.group ----------

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
  subtotal?: GroupSubtotal;
  blankRowsAfter?: number;
}
export const GroupSchema = z.strictObject({
  by: z.string(),
  showDetailRows: z.boolean(),
  subtotal: GroupSubtotalSchema.optional(),
  blankRowsAfter: z.number().int().min(0).optional(),
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
export const RulesFunctionSchema = z.strictObject({
  name: z.string().min(1),
  params: z.array(FunctionParamSchema),
  returns: ValueTypeSchema,
  body: ExprSchema,
});

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
export const RulesTransformSchema = z.strictObject({
  dedupe: DedupeSchema.optional(),
  expand: ExpandSchema.optional(),
  functions: z.array(RulesFunctionSchema).optional(),
  tables: z.array(RulesTableSchema).optional(),
  computed: z.array(ComputedSchema),
  valueMaps: z.array(ValueMapSchema),
  sort: z.array(SortKeySchema),
  group: GroupSchema.optional(),
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

export const OUTPUT_COLUMN_AGGS = ['sum', 'count', 'min', 'max', 'first'] as const;
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
  grandTotal?: GrandTotal;
}
export const RulesOutputSchema = z.strictObject({
  file: OutputFileSchema.optional(),
  sheetName: z.string(),
  direction: z.enum(['rtl', 'ltr']),
  language: z.enum(['he', 'en']),
  titleRows: z.array(TitleRowSchema),
  columns: z.array(OutputColumnRuleSchema).min(1),
  headerStyle: HeaderStyleSchema.optional(),
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
export const RulesSchema = z.strictObject({
  ...learnResultShape,
  name: z.string().min(1),
  meta: RulesMetaSchema,
});
