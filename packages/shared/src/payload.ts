// The learn payload (LEARN_PROMPT.md §3) and the repair block (§4).
// Built in the browser (packages/engine learn/payload), sent to POST /api/learn,
// and the only user-derived content the LLM ever sees. Contains no file names,
// no UI language and no user identity.

import { z } from 'zod';
import { limits } from './config/limits';
import type { Format } from './format';
import type { OutputFile } from './rules/schema';

/** A sample cell. Numbers are JSON numbers; real Excel dates are ISO "YYYY-MM-DD" strings; text dates stay as written. */
export type PayloadCell = string | number | boolean | null;

export type ProfileType =
  | 'text'
  | 'integer'
  | 'decimal'
  | 'currency'
  | 'percent'
  | 'date'
  | 'boolean'
  | 'idLike'
  | 'empty';

/** `stats` keys are included only when relevant, to save tokens (LEARN_PROMPT §3). */
export interface PayloadColumnStats {
  /** Share of empty cells, 0..1. */
  empty?: number;
  /** Distinct ratio 0..1 (omit when `values` is given). */
  distinct?: number;
  /** Distinct count, when small. */
  values?: number;
  /** [min, max] text length. */
  len?: [number, number];
  /** [min, max] numeric value, or ISO dates for date columns. */
  range?: [number, number] | [string, string];
  key?: boolean;
  leadingZerosLost?: boolean;
  israeliId?: boolean;
  /** Dates stored as Excel serial numbers. */
  serialDates?: boolean;
}

export interface PayloadColumn {
  /** 0-based position. */
  i: number;
  header: string;
  type: ProfileType;
  /** D = digit, A = Latin letter, H = Hebrew letter, other characters literal; "|" separates alternatives. */
  shape?: string;
  stats?: PayloadColumnStats;
  /** Output columns only: Excel number format of the data cells. */
  format?: string;
  /** Output columns only: column width (Excel character units). */
  width?: number;
}

export interface InputLayout {
  /** 0-based row index of the header row. */
  headerRow: number;
  /** Rows above the header to skip. */
  rowsAbove: number;
  /** Values that start footer rows to stop at (e.g. "סה\"כ"). */
  footerFirstCell: string[];
}

export interface TitleRowLayout {
  /** 0-based row index in the output sheet. */
  row: number;
  text?: string;
  blank?: boolean;
  bold?: boolean;
  /** The title contains a date/period derived from an input column. */
  containsDate?: { in: number; agg: 'min' | 'max'; format: string };
}

/** Aggregates a summary row can show per column (generic; replaces sum-only totals). */
export type SummaryAgg = 'sum' | 'count' | 'min' | 'max' | 'average' | 'first' | 'last';

/** A summary row detected in the example output (after all data, or after each group). */
export interface SummaryRowLayout {
  /** Label text as it appears (label words are sent real, SPEC 7.2). */
  label?: string;
  /** Output column holding the label. */
  labelOut?: number;
  bold?: boolean;
  /** Per output column, the aggregate that explains the value on ALL groups/rows of the real data. */
  cells: { out: number; agg: SummaryAgg }[];
}

export interface OutputLayout {
  sheetName: string;
  direction: 'rtl' | 'ltr';
  language: 'he' | 'en';
  titleRows: TitleRowLayout[];
  /** 0-based row index of the header row in the output sheet. */
  headerRow: number;
  headerBold: boolean;
  /** One row per group, no detail rows. */
  summary: boolean;
  groupBy: {
    out: number;
    blankRowsAfter: number;
    /** Summary rows after each group. */
    summaryRows?: SummaryRowLayout[];
  } | null;
  /** Summary rows after all data rows. */
  summaryRows: SummaryRowLayout[];
  sort: { out: number; dir: 'asc' | 'desc' }[] | null;
}

/** An aligned pair, or (when rows expand) a family: one input row and all its output rows, in order. */
export type Sample =
  | { in: PayloadCell[]; out: PayloadCell[] }
  | { in: PayloadCell[]; out: PayloadCell[][] };

// ---------- Hints (LEARN_PROMPT §3) ----------
// Computed on ALL rows of the real data. `in` = input column positions, `out` = output column position.
// With masking on, values inside hints (pairs, filter values, constants) are masked with the same map as samples.

interface HintBase {
  /** Share of aligned rows where the relation holds, 0..1. */
  coverage: number;
  /** Sample indices where it fails (only when coverage < 1). */
  failsOn?: number[];
}

type Round = { round?: number };

export type ColumnHint = HintBase & { out: number } & (
  | { rel: 'copy'; in: [number] }
  | { rel: 'normalize'; in: [number] }
  | { rel: 'padLeft'; in: [number]; length: number; char?: string }
  | { rel: 'substr'; in: [number]; from: 'start' | 'end' | number; length: number }
  | { rel: 'concat'; in: number[]; separator: string }
  | { rel: 'valueMap'; in: [number]; pairs: [string, string][] }
  | { rel: 'constant'; in: []; value: PayloadCell }
  | { rel: 'dateFormat'; in: [number]; from: string; to: string }
  | { rel: 'numberFormat'; in: [number]; format: string }
  | ({ rel: 'mulConst' | 'addConst'; in: [number]; const: number } & Round)
  | ({ rel: 'add' | 'sub' | 'mul' | 'div'; in: [number, number] } & Round)
  | ({ rel: 'sum'; in: number[] } & Round)
  // v1 amendment (M1): fn widened from 'sum'|'count'|'min'|'max' to the full
  // SummaryAgg set (adds 'average'|'first'|'last'), matching what the pair
  // analysis's summaryRelations actually tests for a summary output's columns
  // (SPEC 8.6 v4) - LEARN_PROMPT.md §3 updated to match.
  | { rel: 'aggregate'; in: [number]; fn: SummaryAgg }
);

export type RowHint = HintBase &
  (
    | {
        rel: 'filter';
        in: [number];
        keptValues?: PayloadCell[];
        droppedValues?: PayloadCell[];
        // v1 amendment (M1): value widened from `number` to `number | string` so a
        // date threshold (dropped.ts reports it as an ISO "YYYY-MM-DD" string, the
        // same convention samples/dropped cells use for real dates) can be sent as
        // a fact instead of silently truncated - LEARN_PROMPT.md §3 updated to match.
        droppedWhen?: { op: 'isEmpty' | 'notEmpty' | 'gt' | 'gte' | 'lt' | 'lte'; value?: number | string };
      }
    | { rel: 'dedupe'; in: number[]; keys: number[] | 'all'; keep: 'first' | 'last' }
  );

export type ExpandHint = HintBase &
  (
    | { rel: 'expand'; mode: 'columnsToRows'; in: number[]; labelOut: number; valueOut: number; skipEmpty: boolean }
    | { rel: 'expand'; mode: 'splitCell'; in: [number]; separator: string; out: number }
    | { rel: 'expand'; mode: 'fixedFanOut'; size: number; positions: ColumnHint[][] }
  );

export type Hint = ColumnHint | RowHint | ExpandHint;

export interface LearnPayload {
  masking: boolean;
  input: {
    sheetName: string;
    direction: 'rtl' | 'ltr';
    layout: InputLayout;
    columns: PayloadColumn[];
  };
  output: {
    /** Detected by code from the example output (SPEC 8.13). */
    file: OutputFile;
    layout: OutputLayout;
    columns: PayloadColumn[];
  };
  /** Attach mode only (SPEC 8.12): the existing format this input must produce. Layout is normalized to output headers. */
  target?: {
    output: Format['output'];
    layout: Format['layout'];
    validations: Format['outputValidations'];
  };
  /** Up to 12 pairs, or up to 6 families when rows expand. */
  samples: Sample[];
  /** Up to 5 input rows that don't appear in the output. */
  dropped?: PayloadCell[][];
  hints: Hint[];
  /** Output column positions that can't be produced from the input. */
  skipColumns?: number[];
}

// ---------- Repair (LEARN_PROMPT §4) ----------

export type RepairProblem =
  /** learn-v5: a formula-text parse failure (SPEC 8.3/`packages/engine/src/formula`) -
   * kept separate from `schema` so the product can track "how often models write
   * invalid formulas" (offset is the character offset within that one formula string,
   * not the payload). */
  | { kind: 'formula'; path: string; offset: number; message: string }
  | { kind: 'schema'; path: string; message: string }
  | { kind: 'reference'; message: string }
  | {
      kind: 'diff';
      out: number;
      /** Index into payload.samples. */
      sample?: number;
      /** Row inside a family sample, 0-based. */
      familyRow?: number;
      /** A failing row from the browser's full verification (masked when masking is on). */
      row?: { in: PayloadCell[]; out: PayloadCell[] };
      expected?: PayloadCell;
      actual: PayloadCell;
    }
  | { kind: 'rowCount'; expected: number; actual: number }
  | { kind: 'layout'; message: string }
  | { kind: 'formatMismatch'; path: string; message: string }
  | { kind: 'type'; path: string; message: string }
  | { kind: 'limit'; path?: string; message: string };

export interface RepairBlock<Rules = unknown> {
  mode: 'repair';
  previousRules: Rules;
  /** At most 10 `diff` problems. */
  problems: RepairProblem[];
}

/** Appended to the repair user content (LEARN_PROMPT §4). */
export const REPAIR_INSTRUCTION = 'Fix only what the problems require. Keep everything else identical.';

// ---------- LearnPayload validation (routes/learn.ts: "validated minimally - shape
// and size", not a full structural mirror of every Hint variant) ----------
//
// The API never re-derives or deeply re-validates payload content: the browser built
// it, the JSON body is already capped at `limits.api.maxBodyBytes` (SPEC 15), and the
// only thing that ever actually gets executed is the LLM's structured output, which
// IS fully schema-validated (SPEC 9.2). This schema exists to reject an obviously
// malformed or oversized body cheaply, before a learn ever reaches the LLM (SPEC 9.5
// "Code first") - it checks the top-level shape and the SPEC 7.3/7.4 size limits, and
// deliberately uses `z.looseObject`/`z.unknown()` for the nested layout and hint
// shapes rather than re-encoding every `Hint`/`TitleRowLayout`/`SummaryRowLayout`
// variant a second time.

const PayloadCellSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

const PROFILE_TYPES = [
  'text',
  'integer',
  'decimal',
  'currency',
  'percent',
  'date',
  'boolean',
  'idLike',
  'empty',
] as const;
const ProfileTypeSchema = z.enum(PROFILE_TYPES);

const PayloadColumnSchema = z.looseObject({
  i: z.number().int().min(0),
  header: z.string(),
  type: ProfileTypeSchema,
  shape: z.string().optional(),
  stats: z.looseObject({}).optional(),
  format: z.string().optional(),
  width: z.number().optional(),
});

const SampleSchema = z.looseObject({
  in: z.array(PayloadCellSchema),
  out: z.union([z.array(PayloadCellSchema), z.array(z.array(PayloadCellSchema))]),
});

/** `samples` may hold up to `maxPairs` pairs OR up to `maxFamilies` families (SPEC
 * 7.3); either way it never exceeds the larger of the two. */
const MAX_SAMPLES = Math.max(limits.payload.maxPairs, limits.payload.maxFamilies);

export const LearnPayloadSchema = z.looseObject({
  masking: z.boolean(),
  input: z.looseObject({
    sheetName: z.string(),
    direction: z.enum(['rtl', 'ltr']),
    layout: z.looseObject({}),
    columns: z.array(PayloadColumnSchema).min(1).max(limits.payload.maxColumns),
  }),
  output: z.looseObject({
    file: z.looseObject({ type: z.enum(['xlsx', 'csv', 'txt']) }),
    layout: z.looseObject({}),
    columns: z.array(PayloadColumnSchema).min(1).max(limits.payload.maxColumns),
  }),
  target: z.looseObject({}).optional(),
  samples: z.array(SampleSchema).min(1).max(MAX_SAMPLES),
  dropped: z.array(z.array(PayloadCellSchema)).max(limits.payload.maxDropped).optional(),
  hints: z.array(z.unknown()),
  skipColumns: z.array(z.number().int().min(0)).optional(),
});
