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

// ---------- Expressions (SPEC 8.3, LEARN_PROMPT "Operations") ----------
// A recursive AST. zod v4 supports recursive schemas via z.lazy + an explicit
// z.ZodType<T> annotation (SPEC 8.3 permits spelling to a fixed depth only as a
// fallback "if the provider's structured output doesn't support recursive
// schemas" - it does here). Depth <= 6 is enforced in code by checkRules, not
// by the schema itself.

export type ExprConstValue = string | number | boolean | null;

export type ExprLeaf = { col: string } | { const: ExprConstValue };

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
  | 'and'
  | 'or'
  | 'not';

export type ExprNode =
  | { op: 'add' | 'sub' | 'mul' | 'div'; args: Expr[] }
  | { op: 'neg' | 'abs'; arg: Expr }
  | { op: 'round'; arg: Expr; digits: number }
  | { op: 'concat'; args: Expr[] }
  | { op: 'substr'; arg: Expr; start: number; length: number }
  | { op: 'trim' | 'upper' | 'lower'; arg: Expr }
  | { op: 'replaceText'; arg: Expr; find: string; with: string }
  | { op: 'padLeft'; arg: Expr; length: number; char: string }
  | { op: 'datePart'; arg: Expr; part: 'year' | 'month' | 'day' }
  | { op: 'dateFormat'; arg: Expr; format: string }
  | { op: 'if'; cond: Expr; then: Expr; else: Expr }
  | { op: 'coalesce'; args: Expr[] }
  | { op: 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte'; args: [Expr, Expr] }
  | { op: 'isEmpty' | 'notEmpty'; arg: Expr }
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
]);

export const ExprSchema: z.ZodType<Expr> = z.lazy(() =>
  z.union([
    ExprLeafSchema,
    z.discriminatedUnion('op', [
      z.strictObject({ op: z.literal('add'), args: z.array(ExprSchema).min(1) }),
      z.strictObject({ op: z.literal('sub'), args: z.array(ExprSchema).min(1) }),
      z.strictObject({ op: z.literal('mul'), args: z.array(ExprSchema).min(1) }),
      z.strictObject({ op: z.literal('div'), args: z.array(ExprSchema).min(1) }),
      z.strictObject({ op: z.literal('neg'), arg: ExprSchema }),
      z.strictObject({ op: z.literal('abs'), arg: ExprSchema }),
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
        op: z.literal('datePart'),
        arg: ExprSchema,
        part: z.enum(['year', 'month', 'day']),
      }),
      z.strictObject({ op: z.literal('dateFormat'), arg: ExprSchema, format: z.string() }),
      z.strictObject({
        op: z.literal('if'),
        cond: ExprSchema,
        then: ExprSchema,
        else: ExprSchema,
      }),
      z.strictObject({ op: z.literal('coalesce'), args: z.array(ExprSchema).min(1) }),
      z.strictObject({ op: z.literal('eq'), args: z.tuple([ExprSchema, ExprSchema]) }),
      z.strictObject({ op: z.literal('ne'), args: z.tuple([ExprSchema, ExprSchema]) }),
      z.strictObject({ op: z.literal('gt'), args: z.tuple([ExprSchema, ExprSchema]) }),
      z.strictObject({ op: z.literal('gte'), args: z.tuple([ExprSchema, ExprSchema]) }),
      z.strictObject({ op: z.literal('lt'), args: z.tuple([ExprSchema, ExprSchema]) }),
      z.strictObject({ op: z.literal('lte'), args: z.tuple([ExprSchema, ExprSchema]) }),
      z.strictObject({ op: z.literal('isEmpty'), arg: ExprSchema }),
      z.strictObject({ op: z.literal('notEmpty'), arg: ExprSchema }),
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
  | { column: string; op: 'oneOf' | 'notOneOf'; value: FilterScalar[] };

const FilterScalarSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

export const RowFilterSchema = z.discriminatedUnion('op', [
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

// ---------- transform (SPEC 8.1 / LEARN_PROMPT §5: dedupe/expand optional, rest required) ----------

export interface RulesTransform {
  dedupe?: Dedupe;
  expand?: Expand;
  computed: Computed[];
  valueMaps: ValueMap[];
  sort: SortKey[];
  group?: Group;
}
export const RulesTransformSchema = z.strictObject({
  dedupe: DedupeSchema.optional(),
  expand: ExpandSchema.optional(),
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

// ---------- output (SPEC 8.1) ----------

export interface RulesOutput {
  sheetName: string;
  direction: 'rtl' | 'ltr';
  language: 'he' | 'en';
  titleRows: TitleRow[];
  columns: OutputColumnRule[];
  headerStyle?: HeaderStyle;
  grandTotal?: GrandTotal;
}
export const RulesOutputSchema = z.strictObject({
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

const DateStringSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');

export type Validation =
  | { column: string; rule: 'required'; severity: ValidationSeverity }
  | { column: string; rule: 'israeliIdChecksum'; severity: ValidationSeverity }
  | { column: string; rule: 'range'; min?: number; max?: number; severity: ValidationSeverity }
  | { column: string; rule: 'lengthEquals'; length: number; severity: ValidationSeverity }
  | { column: string; rule: 'oneOf'; values: string[]; severity: ValidationSeverity }
  | { column: string; rule: 'unique'; severity: ValidationSeverity }
  | { column: string; rule: 'dateRange'; from: string; to: string; severity: ValidationSeverity };

export const ValidationSchema = z.discriminatedUnion('rule', [
  z.strictObject({ column: z.string(), rule: z.literal('required'), severity: SeveritySchema }),
  z.strictObject({
    column: z.string(),
    rule: z.literal('israeliIdChecksum'),
    severity: SeveritySchema,
  }),
  z.strictObject({
    column: z.string(),
    rule: z.literal('range'),
    min: z.number().optional(),
    max: z.number().optional(),
    severity: SeveritySchema,
  }),
  z.strictObject({
    column: z.string(),
    rule: z.literal('lengthEquals'),
    length: z.number().int().positive(),
    severity: SeveritySchema,
  }),
  z.strictObject({
    column: z.string(),
    rule: z.literal('oneOf'),
    values: z.array(z.string()).min(1),
    severity: SeveritySchema,
  }),
  z.strictObject({ column: z.string(), rule: z.literal('unique'), severity: SeveritySchema }),
  z.strictObject({
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
] as const;
export type RulesMetaStatus = (typeof RULES_META_STATUSES)[number];

export const RULES_META_LEARN_PATHS = ['local', 'llm', 'cache'] as const;
export type RulesMetaLearnPath = (typeof RULES_META_LEARN_PATHS)[number];

export interface RulesMeta {
  source: RulesMetaSource;
  status: RulesMetaStatus;
  model?: string;
  promptVersion?: string;
  masking?: boolean;
  learnPath?: RulesMetaLearnPath;
  createdAt?: string;
}
export const RulesMetaSchema = z.strictObject({
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
