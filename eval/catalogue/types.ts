// The catalogue's data model. Read README.md first: it explains what the catalogue measures
// and how to add a transformation type.
//
// One `CatalogueType` is one KIND of real-world spreadsheet transformation ("first 3 characters
// of a code", "running total", "split a cell into rows"). It carries everything needed to
// measure it without a human in the loop:
//
//   - a seeded generator for realistic synthetic INPUT rows (Hebrew or English),
//   - the EXPECTED output, computed by plain TypeScript (the "oracle": what a person making the
//     example by hand would have produced) - independent of the rules language,
//   - a REFERENCE RULE written in our rules language (formula text + the rules structure), or
//     `rule: null` plus the missing capability when the language cannot express it.
//
// The runner (run-catalogue.ts) then measures each type on two layers, and a later phase adds a
// third (`ai`) without changing anything here:
//     language - does the reference rule parse, type-check and reproduce the expected output?
//     fast     - does the free code engine (pair analysis + strict fast path) detect it from the
//                example pair alone, and does what it learned generalize to a "next month" file?
import type { ColumnType, OutputColumnAgg, Validation } from '@formatai/shared';
import type { FormulaRowFilter, FormulaRulesTransform, OutputFileSpec } from '@formatai/engine';
import type { Rng } from '../cases/lib/prng';
import type { CapabilityId } from './capabilities';

// ---------- Values ----------

/** A calendar date. Written as a real Excel date cell (or as text, see `InCol.dateAs`). */
export interface Ymd {
  y: number;
  m: number;
  d: number;
}

/** One cell value in the oracle. `null` = empty cell. Numbers are plain JS numbers, already rounded the way the
 * reference rule rounds them (the oracle must not depend on float noise). */
export type V = string | number | boolean | null | Ymd;

/** A row keyed by column id (the input column ids, plus any id created by a row operation). */
export type Row = Record<string, V>;

// ---------- Topics ----------

export const TOPICS = ['extraction', 'cleanup', 'formatting', 'combining', 'logic', 'lookups', 'arithmetic', 'dates', 'acrossRows', 'rowOps', 'structure'] as const;
export type TopicId = (typeof TOPICS)[number];

export const TOPIC_TITLES: Readonly<Record<TopicId, string>> = {
  extraction: 'Text extraction',
  cleanup: 'Text cleanup',
  formatting: 'Formatting',
  combining: 'Combining columns',
  logic: 'Logic',
  lookups: 'Lookups',
  arithmetic: 'Arithmetic',
  dates: 'Dates',
  acrossRows: 'Across rows',
  rowOps: 'Row operations',
  structure: 'Structure',
};

// ---------- Generation ----------

export interface GenCtx {
  rng: Rng;
  /** How many rows to generate (20-40). */
  n: number;
  lang: 'he' | 'en';
  /** 'next' = the "next month" file of the hold-out: same generator, other data. A type whose rule generalizes beyond the values seen in the
   * example (a fallback branch, a threshold) should let the next file contain a value the example never showed (see `unseen` in data.ts). */
  variant: 'example' | 'next';
}

/** One INPUT column, in file order. */
export interface InCol {
  /** The column id the rules use (ASCII, formula-safe: letters, digits, underscore). */
  id: string;
  /** The header text in the input file (Hebrew or English). */
  header: string;
  /** The declared type in the reference rule. */
  type: ColumnType;
  padLeft?: number;
  inputFormats?: string[];
  /** For a date value. 'excel' (default) = a real Excel date cell; any other string is a token format
   * ("DD/MM/YYYY", "YYYY-MM-DD", "D MMMM YYYY") the date is written as TEXT in. On a `date` column the reference rule lists it in
   * `inputFormats`; on a `text` column the rule reads it itself (`toDate(col, format)`). */
  dateAs?: string;
  /** Excel number format of the written cells (numbers), e.g. "#,##0.00". */
  format?: string;
}

// ---------- Expected output ----------

/** One OUTPUT column: its header, the oracle, and (for the reference rule) how it is produced. */
export interface OutCol {
  header: string;
  /** Copy the column with this id (an input column, an id the rule's `expand` creates, or an earlier computed id). */
  from?: string;
  /** Formula text (see packages/engine/src/formula) of a computed column in the reference rule. Needs `value`. */
  formula?: string;
  /** The computed column's id in the reference rule (default `c1`, `c2`, ... by output position). */
  id?: string;
  /** The computed column's declared type (default 'text'). */
  type?: ColumnType;
  /** Number or date format of the output cells (Excel style for numbers, "DD/MM/YYYY" tokens for dates). */
  format?: string;
  /** Output-column aggregate (only for a summary output whose rule groups with `showDetailRows: false`). */
  agg?: OutputColumnAgg;
  /** The expected value of this column for `row` (`i` = index among the rows the output columns see, `all` = all of them).
   * Default for a `from` column: `row[from]`. */
  value?: (row: Row, i: number, all: readonly Row[]) => V;
}

/** The expected output as a whole, for a type whose shape the column-by-column model cannot describe (a pivot). */
export interface ExpectedTable {
  headers: string[];
  rows: V[][];
}

// ---------- Reference rule ----------

/** The reference rule, as the part a type author writes: everything NOT derivable from `input` and `outputs`.
 * Expressions are formula text, exactly as the AI step writes them. Input columns, computed columns (from
 * `OutCol.formula`) and output columns are assembled by kit.ts. */
export interface RuleSpec {
  input?: { rowFilters?: FormulaRowFilter[] };
  transform?: Partial<FormulaRulesTransform>;
  output?: { titleRows?: unknown[]; summaryRows?: unknown[] };
  validations?: Validation[];
}

/** Why a type cannot be expressed: which capability the rules language lacks, and what exactly is missing for THIS type. */
export interface Missing {
  capability: CapabilityId;
  detail: string;
  /** A partial way to say a restricted form of this type with today's language (a closed set, a fixed maximum), when there is one. */
  workaround?: string;
}

// ---------- The type itself ----------

export interface CatalogueType {
  /** `<topic>.<name>`, unique, lowercase, kebab-case after the dot (used by `--types`). */
  id: string;
  topic: TopicId;
  title: string;
  /** What a user is trying to do, in one sentence. */
  description: string;
  /** Language of the data, the headers and the sheets (direction follows). */
  lang: 'he' | 'en';
  /** Free-form tags (traps/features), for grouping in later reports. */
  tags?: string[];
  input: InCol[];
  /** Seeded generator of the INPUT rows (20-40). Must be deterministic given `g.rng`. */
  generate: (g: GenCtx) => Row[];
  /** Row operations as the oracle sees them (filter, dedupe, split, unpivot, group, sort ...): turns the input rows into the rows
   * the output columns are computed from. Default: the input rows as they are. */
  reshape?: (rows: Row[]) => Row[];
  /** The output columns, in file order. Not needed when `table` is given. */
  outputs: OutCol[];
  /** Escape hatch: extra output rows (totals, subtotals) added after the oracle built the data rows. */
  finalize?: (out: V[][], rows: readonly Row[]) => V[][];
  /** Escape hatch: the whole expected table (pivot, where the headers come from the data). Takes the place of `outputs`/`reshape`. */
  table?: (rows: Row[]) => ExpectedTable;
  /** Title lines above the header in the expected output (text, or null for a blank row), possibly built from the data (a month). */
  titles?: (rows: readonly Row[]) => (string | null)[];
  /** Output file settings (default xlsx). */
  outFile?: OutputFileSpec;
  /** The reference rule's non-derivable part, or `null` when the language cannot express this type (then `missing` says why). */
  rule: RuleSpec | null;
  missing?: Missing;
}

/** Identity helper: gives a type definition full type checking and autocompletion where it is written. */
export function defineType(t: CatalogueType): CatalogueType {
  return t;
}

// ---------- Measurement records (one per type x seed). A later phase adds `ai` without touching the rest ----------

export interface LanguageRecord {
  /** The language can express it: a reference rule exists (and, if `reproduces` is false, the catalogue itself is broken). */
  expressible: boolean;
  capability?: CapabilityId;
  missingDetail?: string;
  workaround?: string;
  /** Formula text parsed, schema (RulesSchema) passed, checkRules and typeCheck found nothing. */
  valid?: boolean;
  problems?: string[];
  /** convertFile(reference rule, input) equals the expected output (and the "next" one). */
  reproduces?: boolean;
  mismatch?: string;
}

export interface UnsolvedColumn {
  out: number;
  header: string;
  /** derived = the input determines it (dependsOn/bands/contains hint); related = relations were found but the fast path declined
   * to use them; external = nothing in the input explains it. */
  cls: 'derived' | 'related' | 'external';
  /** dependsOn | bands | contains | window:<fn> (an across-row pattern the free engine sees but does not write) for derived; the best relation kind for related; '' for external. */
  hint: string;
  /** Why the strict path declined it (columnNotFullyExplained | ambiguousColumn | thinEvidence | rowsNotBuilt). */
  reason: string;
  /** Every relation the analysis found at >= 0.9, "kind@coverage". */
  relations: string[];
}

/** solved = local path, verified, and the next file converts exactly. overfit = local and verified on the example, but the next file does not convert
 * exactly (a false positive: verification is looser than the exact comparison). unverified = the local path built rules that fail the engine's own
 * verification. partial = some columns built, the rest need the AI step. none = blocked, or nothing built. */
export type FastStatus = 'solved' | 'overfit' | 'unverified' | 'partial' | 'none';

export interface FastRecord {
  path: 'local' | 'partial' | 'blocked' | 'notReady' | 'error';
  status: FastStatus;
  /** local path: the learned rules reproduce the example. partial: they reproduce the solved columns. */
  verified: boolean | null;
  solvedColumns: string[];
  totalColumns: number;
  unsolved: UnsolvedColumn[];
  /** Pre-flight issues (non-info): block reasons or the rowsNotAligned warning; readiness issues for 'notReady'. */
  blockedBy: string[];
  /** Why the strict fast path declined (reason code + params), when it did. */
  fastReason?: string;
  /** Layout/row parts the local result does not build (group, summaryRows, sort, rows, droppedRows ...). */
  needsAiParts: string[];
  /** local path only: the learned rules convert the "next month" file exactly. 'n/a' when not local. */
  holdOut: 'pass' | 'fail' | 'n/a';
  holdOutDetail?: string;
  /** A short description of what the local rules look like (the relations used), for the report. */
  how?: string;
  /** The strict path declined (rows expand), but the local partial builder produced a COMPLETE rules file (every column, expand, nothing left for the AI step):
   * `verified` and `holdOut` then come from the full verification of those rules. */
  viaPartial?: boolean;
  error?: string;
  ms: number;
}

/** Reserved for the AI phase (`--ai haiku`): the same facts the fast layer records, plus cost. Nothing reads it yet. */
export interface AiRecord {
  model: string;
  path: string;
  verified: boolean;
  holdOut: 'pass' | 'fail' | 'n/a';
  llmCalls: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  latencyMs: number;
  error?: string;
}

export interface CatalogueRecord {
  type: string;
  topic: TopicId;
  title: string;
  lang: 'he' | 'en';
  seed: number;
  rowsIn: number;
  rowsOut: number;
  language: LanguageRecord;
  fast: FastRecord;
  ai?: AiRecord;
}
