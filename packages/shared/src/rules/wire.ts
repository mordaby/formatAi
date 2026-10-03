// The LLM-facing "wire" shape of LearnResult (LEARN_PROMPT §5) and its JSON Schema.
//
// One problem this file solves (confirmed against the current provider docs - Anthropic
// via the `claude-api` skill; OpenAI via
// `apps/api/src/llm/schema/toOpenAiStrictSchema.ts`'s own doc comment - before writing
// any of this):
//
// Open dictionaries. OpenAI strict mode and Anthropic structured outputs both require
// `additionalProperties: false` on every object and reject `additionalProperties` set to
// anything else - so no genuine open dictionary (arbitrary keys with a fixed value
// schema) is allowed anywhere in the schema. LEARN_PROMPT names three:
//   - transform.valueMaps[].map                 (Record<input value, output value>)
//   - transform.expand (columnsToRows).labels    (Record<column id, label text>)
//   - transform.expand (fixedFanOut).rows[].set  (Record<column id, formula text>)
// This file's own "no open-dictionary objects" test found a fourth, structurally
// identical problem the prose doesn't name:
//   - output.summaryRows[].cells / group.summaryRows[].cells (Record<output header, SummaryAgg>)
// Each becomes, on the wire, an array of `{ key, value }` pairs instead.
//
// learn-v5 (SPEC 8.3/LEARN_PROMPT §2): the LLM writes every expression as FORMULA TEXT
// (e.g. "round(amount * 0.17, 2)") instead of a JSON tree - `packages/engine/src/
// formula`'s `parseFormula`/`printFormula` convert between that text and the real,
// recursive `Expr` AST every other part of the system still uses unchanged (stored
// rules, the engine, the type checker, every golden/eval fixture). This sidesteps the
// earlier "Expr is recursive, structured outputs can't express that" problem entirely -
// there's no longer an Expr sub-schema on the wire at all, just a plain `z.string()` at
// each of the four positions SPEC 8.3 defines (`transform.computed[].expr`,
// `input.rowFilters[].expr`, `transform.expand` (fixedFanOut)'s `rows[].set` values,
// `transform.functions[].body`) - which is also what shrank the wire schema from ~92,700
// to a few thousand characters (the old fixed-depth Expr chain, repeated at each of
// `limits.rules.maxExprDepth` levels, was almost the entire size). `apps/api/src/learn`
// runs `packages/engine`'s `formulaRulesFromWire`/`formulaRulesToWire` immediately after
// (before)/before (after) this file's own `fromWire`/`toWire` pair conversion, turning
// formula text into/out of real `Expr` trees; this file itself never parses or prints a
// formula - it only knows these four positions are strings now, not Expr sub-schemas.
//
// Both problems (open dictionaries here, Expr-as-text in `packages/engine/src/formula`)
// are schema-SHAPE-only: at runtime, `toWire`/`fromWire` convert between the wire shape
// (pairs) and the real `LearnResult`/`Rules` shape (records) that
// `checkRules`/`typeCheck`/the engine already work with. Nothing downstream of
// `fromWire` needs to know the wire format ever existed.
import { z } from 'zod';
import type { SummaryAgg } from '../payload';
import {
  AssumptionSchema,
  buildComputedSchema,
  buildExpandSchema,
  buildGroupSchema,
  buildRowFilterSchema,
  buildRulesFunctionSchema,
  buildRulesOutputSchema,
  buildSummaryRowSchema,
  buildValueMapSchema,
  DedupeSchema,
  HeaderRowSchema,
  InputColumnSchema,
  InputSheetSelectorSchema,
  RulesTableSchema,
  SortKeySchema,
  StopAtSchema,
  SummaryAggSchema,
  buildUnsupportedSchema,
  ValidationSchema,
  type Expand,
  type Expr,
  type Group,
  type LearnResult,
  type Rules,
  type RulesOutput,
  type RulesTransform,
  type SummaryRow,
  type ValueMap,
} from './schema';

// ---------- WirePair and the generic record <-> pairs conversion ----------

export interface WirePair<V> {
  key: string;
  value: V;
}

function wirePairArraySchema<V extends z.ZodType>(value: V): z.ZodType<WirePair<z.infer<V>>[]> {
  return z.array(z.strictObject({ key: z.string(), value })) as unknown as z.ZodType<WirePair<z.infer<V>>[]>;
}

function recordToPairs<V>(record: Record<string, V>): WirePair<V>[] {
  return Object.entries(record).map(([key, value]) => ({ key, value }));
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Defensive inverse of `recordToPairs`, for untrusted, not-yet-validated LLM JSON
 * (`fromWire`). Only converts a value that actually looks like `{key,value}[]` with
 * string keys; anything else (a missing field, the LLM writing a bare record anyway,
 * garbage) is returned UNCHANGED rather than guessed at or thrown on - the real
 * validation gate is the `LearnResultSchema.safeParse` call that must follow `fromWire`
 * (SPEC 9.2 layer 1 "structure"), which reports a precise `schema` problem instead.
 */
function pairsToRecord(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  const record: Record<string, unknown> = {};
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry.key !== 'string' || !('value' in entry)) {
      return value;
    }
    record[entry.key] = entry.value;
  }
  return record;
}

// ---------- Expr positions are formula TEXT on the wire (learn-v5) ----------
// SPEC 8.3's four Expr positions (`transform.computed[].expr`, `input.rowFilters[].expr`,
// `transform.expand` (fixedFanOut)'s `rows[].set` values, `transform.functions[].body`)
// are plain strings here - formula text, parsed/printed by `packages/engine/src/formula`
// one layer up (`apps/api/src/learn`), never by this file. Cast to `z.ZodType<Expr>` only
// to satisfy `schema.ts`'s `buildXSchema(exprSchema: z.ZodType<Expr>)` factories, which
// this file reuses purely for their STRUCTURAL shape (they're never `.parse()`d - the
// real gate is `LearnResultSchema.safeParse`, run only after `fromWire` AND
// `formulaRulesFromWire` have already turned these strings back into real `Expr` trees).
const WireExprSchema = z.string() as unknown as z.ZodType<Expr>;

// ---------- Wire schema pieces (see file doc comment, point 1) ----------

const wireStringMapSchema = wirePairArraySchema(z.string());
const wireExprMapSchema = wirePairArraySchema(WireExprSchema);
const wireCellsSchema = wirePairArraySchema(SummaryAggSchema);

const WireSummaryRowSchema = buildSummaryRowSchema(wireCellsSchema);
const WireGroupSchema = buildGroupSchema(WireSummaryRowSchema);
const WireRulesOutputSchema = buildRulesOutputSchema(WireSummaryRowSchema);
const WireExpandSchema = buildExpandSchema({ labelsSchema: wireStringMapSchema, setSchema: wireExprMapSchema });
const WireRowFilterSchema = buildRowFilterSchema(WireExprSchema);
const WireComputedSchema = buildComputedSchema(WireExprSchema);
const WireValueMapSchema = buildValueMapSchema(wireStringMapSchema);
const WireRulesFunctionSchema = buildRulesFunctionSchema(WireExprSchema);

// learn-v7: the optional functionRequest / explanation notes, with no pattern or length caps on the wire (see `buildFunctionRequestSchema`).
const WireUnsupportedSchema = buildUnsupportedSchema(false);

const WireRulesInputSchema = z.strictObject({
  sheet: InputSheetSelectorSchema,
  headerRow: HeaderRowSchema,
  stopAt: StopAtSchema.optional(),
  columns: z.array(InputColumnSchema).min(1),
  rowFilters: z.array(WireRowFilterSchema).optional(),
});

const WireRulesTransformSchema = z.strictObject({
  dedupe: DedupeSchema.optional(),
  expand: WireExpandSchema.optional(),
  functions: z.array(WireRulesFunctionSchema).optional(),
  tables: z.array(RulesTableSchema).optional(),
  computed: z.array(WireComputedSchema),
  valueMaps: z.array(WireValueMapSchema),
  sort: z.array(SortKeySchema),
  group: WireGroupSchema.optional(),
});

/** The full wire-shaped `LearnResult` schema (LEARN_PROMPT §5), used only to generate
 * `learnResultWireJsonSchema()` - never called with `.parse()`/`.safeParse()` directly.
 * The real validation gate is `LearnResultSchema` (SPEC 9.2 layer 1), run on
 * `fromWire`'s output. */
const WireLearnResultSchema = z.strictObject({
  schemaVersion: z.literal(1),
  input: WireRulesInputSchema,
  transform: WireRulesTransformSchema,
  output: WireRulesOutputSchema,
  validations: z.array(ValidationSchema),
  unsupported: z.array(WireUnsupportedSchema),
  assumptions: z.array(AssumptionSchema),
});

/**
 * The JSON Schema sent to the LLM as the structured-output constraint for a learn or
 * repair call (SPEC 9.1, LEARN_PROMPT §5): no open dictionaries, and every Expr position
 * a plain string (learn-v5 formula text) rather than a recursive/fixed-depth tree (see
 * the file doc comment). Use this - never `./jsonSchema.ts`'s `learnResultJsonSchema()` -
 * as the `schema` passed to `apps/api/src/llm`'s `complete()`.
 */
export function learnResultWireJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(WireLearnResultSchema) as Record<string, unknown>;
}

// ---------- Wire-shaped TypeScript types (derived from the real interfaces) ----------

export type WireExpand =
  | (Omit<Extract<Expand, { mode: 'columnsToRows' }>, 'labels'> & { labels?: WirePair<string>[] })
  | Extract<Expand, { mode: 'splitCell' }>
  | (Omit<Extract<Expand, { mode: 'fixedFanOut' }>, 'rows'> & { rows: { set: WirePair<Expr>[] }[] });

export type WireValueMap = Omit<ValueMap, 'map'> & { map: WirePair<string>[] };

export type WireSummaryRow = Omit<SummaryRow, 'cells'> & { cells: WirePair<SummaryAgg>[] };

export type WireGroup = Omit<Group, 'summaryRows'> & { summaryRows?: WireSummaryRow[] };

export type WireRulesOutput = Omit<RulesOutput, 'summaryRows'> & { summaryRows?: WireSummaryRow[] };

export type WireRulesTransform = Omit<RulesTransform, 'expand' | 'valueMaps' | 'group'> & {
  expand?: WireExpand;
  valueMaps: WireValueMap[];
  group?: WireGroup;
};

/** The wire-shaped counterpart of `LearnResult` (or `Rules`, via the generic - `toWire`
 * preserves any extra fields such as `name`/`meta` through the `T` type parameter, so
 * `toWire(storedRules)` still carries them for `previousRules` in a repair block). */
export type WireLearnResult<T extends LearnResult = LearnResult> = Omit<T, 'transform' | 'output'> & {
  transform: WireRulesTransform;
  output: WireRulesOutput;
};

// ---------- toWire: real (record-shaped) -> wire (pairs) ----------

function summaryRowToWire(row: SummaryRow): WireSummaryRow {
  return { ...row, cells: recordToPairs(row.cells) };
}

function groupToWire(group: Group | undefined): WireGroup | undefined {
  if (!group) return undefined;
  return { ...group, summaryRows: group.summaryRows?.map(summaryRowToWire) };
}

function expandToWire(expand: Expand | undefined): WireExpand | undefined {
  if (!expand) return undefined;
  if (expand.mode === 'columnsToRows') {
    return { ...expand, labels: expand.labels ? recordToPairs(expand.labels) : undefined };
  }
  if (expand.mode === 'fixedFanOut') {
    return { ...expand, rows: expand.rows.map((r) => ({ set: recordToPairs(r.set) })) };
  }
  return expand;
}

function transformToWire(transform: RulesTransform): WireRulesTransform {
  return {
    ...transform,
    expand: expandToWire(transform.expand),
    valueMaps: transform.valueMaps.map((vm) => ({ ...vm, map: recordToPairs(vm.map) })),
    group: groupToWire(transform.group),
  };
}

function outputToWire(output: RulesOutput): WireRulesOutput {
  return { ...output, summaryRows: output.summaryRows?.map(summaryRowToWire) };
}

/**
 * Converts a real `LearnResult`/`Rules` object to its wire shape (LEARN_PROMPT §4:
 * `previousRules` in a repair block is sent in wire form, matching the shape the LLM
 * itself writes, so the same JSON notation is used consistently on both sides of the
 * conversation).
 */
export function toWire<T extends LearnResult>(rules: T): WireLearnResult<T> {
  return {
    ...rules,
    transform: transformToWire(rules.transform),
    output: outputToWire(rules.output),
  };
}

// ---------- fromWire: wire (pairs, untrusted) -> real (record-shaped) ----------

function summaryRowFromWire(row: unknown): unknown {
  if (!isRecord(row)) return row;
  return { ...row, cells: pairsToRecord(row.cells) };
}

function summaryRowsFromWire(rows: unknown): unknown {
  return Array.isArray(rows) ? rows.map(summaryRowFromWire) : rows;
}

function groupFromWire(group: unknown): unknown {
  if (!isRecord(group)) return group;
  return {
    ...group,
    summaryRows: group.summaryRows === undefined ? undefined : summaryRowsFromWire(group.summaryRows),
  };
}

function expandFromWire(expand: unknown): unknown {
  if (!isRecord(expand)) return expand;
  if (expand.mode === 'columnsToRows') {
    return { ...expand, labels: expand.labels === undefined ? undefined : pairsToRecord(expand.labels) };
  }
  if (expand.mode === 'fixedFanOut') {
    if (!Array.isArray(expand.rows)) return expand;
    return {
      ...expand,
      rows: expand.rows.map((r) => (isRecord(r) ? { ...r, set: pairsToRecord(r.set) } : r)),
    };
  }
  return expand;
}

function transformFromWire(transform: unknown): unknown {
  if (!isRecord(transform)) return transform;
  const valueMaps = Array.isArray(transform.valueMaps)
    ? transform.valueMaps.map((vm) => (isRecord(vm) ? { ...vm, map: pairsToRecord(vm.map) } : vm))
    : transform.valueMaps;
  return {
    ...transform,
    expand: transform.expand === undefined ? undefined : expandFromWire(transform.expand),
    valueMaps,
    group: transform.group === undefined ? undefined : groupFromWire(transform.group),
  };
}

function outputFromWire(output: unknown): unknown {
  if (!isRecord(output)) return output;
  return {
    ...output,
    summaryRows: output.summaryRows === undefined ? undefined : summaryRowsFromWire(output.summaryRows),
  };
}

/**
 * Reshapes raw, untrusted, not-yet-validated LLM JSON from the wire's `{key,value}[]`
 * pairs back into the real, record-shaped `LearnResult` (SPEC 8) - the inverse of
 * `toWire`. Returns `unknown` and never throws: the LLM's JSON is only *constrained* by
 * the wire schema at the provider, not guaranteed to match it byte-for-byte (a
 * provider that doesn't fully enforce its schema, or a repair call where the model
 * changed a field it shouldn't have), so a shape this function doesn't recognize is
 * passed through unchanged. The caller must always follow this with
 * `LearnResultSchema.safeParse` (SPEC 9.2 layer 1 "structure"), which is the real
 * validation gate and turns anything still wrong into a precise `schema` problem.
 */
export function fromWire(json: unknown): unknown {
  if (!isRecord(json)) return json;
  return {
    ...json,
    transform: json.transform === undefined ? undefined : transformFromWire(json.transform),
    output: json.output === undefined ? undefined : outputFromWire(json.output),
  };
}
