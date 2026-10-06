// AI code checks (docs/proposals/ai-code-checks.md, owner decision 2026-10-05; SPEC 21 v14): the closed list of questions the AI step may
// ask code about the WHOLE example before it answers (prompt learn-v9, "Checking with code"), the answers code gives, and a "round" (what
// the AI asked and what code answered) as the browser sends it back with each step.
//
//   AI:      { "checks": [ ...up to 4 ], "rules": null }
//   browser: computes every answer on every aligned row of the example (engine `learn/checks.ts`), masked like the samples
//   server:  POST /api/learn/step { token, payload, rounds } -> the AI again, with every round so far
//
// Five checks, each a thin question over engine code that exists (the formula parser and the runtime, the verification's cell compare, the
// masker): `test` (does this rule give this column?), `ranges` (sorted by a number or date: where does the column change?), `dependsOn` (do
// these columns decide it?), `values` (what is in it?), `rows` (show me rows where ...). Every check reads columns the way the prompt says
// (an input column is `in<i>`, an output column its header - or `out<i>` inside a formula -, a `let` id, in completion mode also the ids of
// `complete.fixed`), may add up to 3 helper columns (`let`) and a `where` condition, both formula text.
//
// Two schemas per shape: the CHECK schema below is the gate (the API validates what the model asked against it, with every cap), and the
// WIRE schema (`wire.ts`, `learnStepWireJsonSchema`) is what the provider constrains the answer to - the same shape without `maxItems`,
// length or number bounds, which not every structured-output provider takes. The caps are said in the prompt and enforced in code.
import { z } from 'zod';
import { limits } from './config/limits';
import { payloadRowCount, type LearnPayload, type PayloadCell, type Sample } from './payload';

const caps = limits.learn.checks;

export const CHECK_KINDS = ['test', 'ranges', 'dependsOn', 'values', 'rows'] as const;
export type CheckKind = (typeof CHECK_KINDS)[number];

/** A helper column of a check: `{ id, expr }` - a camelCase-ish identifier and formula text, computed on every row before the check. */
export interface CheckLet {
  id: string;
  expr: string;
}

interface CheckCommon {
  /** Up to `limits.learn.checks.maxLets` helper columns, in order (a later one may read an earlier one). */
  let?: CheckLet[];
  /** Formula text: only the rows where it is true are checked. */
  where?: string;
}

/** "Does this rule give this output column?" `column`: an output header (or `out<i>`); `rule`: formula text. */
export interface TestCheck extends CheckCommon {
  check: 'test';
  column: string;
  rule: string;
}

/** "Sorted by this number or date column: where does `column` change?" `by`: any column reference that holds numbers or dates. */
export interface RangesCheck extends CheckCommon {
  check: 'ranges';
  column: string;
  by: string;
}

/** "Does the same value of these 1-2 columns always give the same value of `column`?" */
export interface DependsOnCheck extends CheckCommon {
  check: 'dependsOn';
  column: string;
  on: string[];
}

/** "What values does this column have?" */
export interface ValuesCheck extends CheckCommon {
  check: 'values';
  column: string;
}

/** "Show me rows where ..." - at most `limits.learn.checks.maxRowsPerCheck`, in file order. */
export interface RowsCheck {
  check: 'rows';
  let?: CheckLet[];
  where: string;
  limit: number;
}

export type Check = TestCheck | RangesCheck | DependsOnCheck | ValuesCheck | RowsCheck;

// ---------- The answers (proposal section 4). Every row is a sample-shaped row of the example, masked like the samples. ----------

/** Rows a check could not show because the learn's row limit (`limits.learn.loop.maxRowsTotal`) is reached: its counts are still exact. */
interface Withheld {
  withheld?: number;
}

/** `test`: of `rows` rows (after `where`), `matched` got exactly the column's value; up to 3 that did not. */
export interface TestAnswer extends Withheld {
  rows: number;
  matched: number;
  failing: { row: Sample; expected: PayloadCell; got: PayloadCell }[];
}

/** One run of `ranges`: the rows from `from` to `to` of `by` (real numbers or ISO dates, inclusive) all have `value`. */
export interface RangesRun {
  from: number | string;
  to: number | string;
  value: PayloadCell;
  rows: number;
}

/**
 * `ranges`: `clean` - every value of `by` gives one value of the column, and there are at most `maxRuns` runs (each listed, in order);
 * otherwise `clean: false` with the number of runs and of `by` values that give more than one value (`mixed`). `noValue`: rows left out
 * because their `by` is empty or not a number or date.
 */
export type RangesAnswer =
  | { rows: number; noValue: number; clean: true; runs: RangesRun[] }
  | { rows: number; noValue: number; clean: false; runCount: number; mixed: number };

/** `dependsOn`: distinct keys (values of `on`), the rows whose key always gives one value, the keys that give more, and up to 2 such pairs. */
export interface DependsOnAnswer extends Withheld {
  rows: number;
  keys: number;
  rowsAgree: number;
  keysConflict: number;
  conflicts: { key: PayloadCell[]; values: [PayloadCell, PayloadCell]; rows: Sample[] }[];
}

/** `values`: distinct non-empty values, empty cells, the most common values (most first) and, for numbers or dates, the smallest and largest. */
export interface ValuesAnswer {
  rows: number;
  distinct: number;
  empty: number;
  top: { value: PayloadCell; rows: number }[];
  min?: number | string;
  max?: number | string;
}

/** `rows`: how many rows the condition holds for, and the first ones (file order). */
export interface RowsAnswer extends Withheld {
  matched: number;
  rows: Sample[];
}

/** A check that could not run: a formula that does not parse, an unknown column, a `by` that holds no numbers, the time budget ... */
export interface CheckError {
  error: string;
}

export type CheckAnswer = TestAnswer | RangesAnswer | DependsOnAnswer | ValuesAnswer | RowsAnswer | CheckError;

/**
 * One round, as the browser sends it back with each step (`POST /api/learn/step`): what the AI step asked (the checks the API accepted), what
 * code answered (one answer per check, in order) and, when the API dropped some of what was asked, one short line each (`dropped`).
 */
export interface CheckRound {
  checks: Check[];
  answers: CheckAnswer[];
  dropped?: string[];
}

// ---------- The gate: what the API accepts from the model ----------

/** A `let` id: an identifier the formula language reads (ASCII letters, digits, `_`; not starting with a digit). */
const LET_ID = /^[A-Za-z_][A-Za-z0-9_]{0,39}$/;

const FormulaSchema = z.string().min(1).max(caps.maxFormulaChars);
const RefSchema = z.string().min(1).max(caps.maxRefChars);
const LetSchema = z.strictObject({ id: z.string().regex(LET_ID, 'an identifier: letters, digits and _'), expr: FormulaSchema });
const LetsSchema = z.array(LetSchema).max(caps.maxLets).optional();

export const TestCheckSchema = z.strictObject({ check: z.literal('test'), column: RefSchema, rule: FormulaSchema, let: LetsSchema, where: FormulaSchema.optional() });
export const RangesCheckSchema = z.strictObject({ check: z.literal('ranges'), column: RefSchema, by: RefSchema, let: LetsSchema, where: FormulaSchema.optional() });
export const DependsOnCheckSchema = z.strictObject({
  check: z.literal('dependsOn'),
  column: RefSchema,
  on: z.array(RefSchema).min(1).max(caps.maxOn),
  let: LetsSchema,
  where: FormulaSchema.optional(),
});
export const ValuesCheckSchema = z.strictObject({ check: z.literal('values'), column: RefSchema, let: LetsSchema, where: FormulaSchema.optional() });
export const RowsCheckSchema = z.strictObject({
  check: z.literal('rows'),
  let: LetsSchema,
  where: FormulaSchema,
  limit: z.number().int().min(1).max(caps.maxRowsPerCheck),
});

export const CheckSchema: z.ZodType<Check> = z.discriminatedUnion('check', [TestCheckSchema, RangesCheckSchema, DependsOnCheckSchema, ValuesCheckSchema, RowsCheckSchema]) as unknown as z.ZodType<Check>;

/** The most `dropped` lines a round carries: one per check past the cap would be noise. */
export const MAX_DROPPED_LINES = caps.maxChecksPerRound + 1;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** The first problem of a check that failed the gate, in a few words and with no value from it (only its kind and a field name). */
function dropReason(raw: unknown, issues: readonly z.core.$ZodIssue[]): string {
  const kind = isRecord(raw) && typeof raw.check === 'string' && (CHECK_KINDS as readonly string[]).includes(raw.check) ? raw.check : null;
  if (kind === null) return `not one of the checks (${CHECK_KINDS.join(', ')})`;
  const first = issues[0];
  const field = first && first.path.length > 0 ? first.path.map(String).join('.') : '';
  if (first?.code === 'unrecognized_keys') return `"${kind}" takes no ${first.keys.map((k) => `"${k}"`).join(', ')}`;
  if (first?.code === 'too_big') return `"${kind}": ${field || 'a value'} is too long or has too many items`;
  if (first?.code === 'too_small') return `"${kind}": ${field || 'a value'} is empty or too small`;
  return `"${kind}": ${field ? `"${field}" ` : ''}is missing or of the wrong kind`;
}

/**
 * What the API takes of the checks the model asked (learn-v9): each must pass the gate (`CheckSchema`, with every cap), and at most
 * `maxChecksPerRound` are kept, in order. Every other one is dropped with one short line for the next round (`CheckRound.dropped`: "check 5
 * was not run: at most 4 checks a round"), never a repair. The lines name the check's kind and a field, never a value.
 */
export function acceptChecks(raw: readonly unknown[]): { checks: Check[]; dropped: string[] } {
  const checks: Check[] = [];
  const dropped: string[] = [];
  raw.forEach((candidate, i) => {
    const parsed = CheckSchema.safeParse(candidate);
    if (!parsed.success) dropped.push(`check ${i + 1} was not run: ${dropReason(candidate, parsed.error.issues)}`);
    else if (checks.length >= caps.maxChecksPerRound) dropped.push(`check ${i + 1} was not run: at most ${caps.maxChecksPerRound} checks a round`);
    else checks.push(parsed.data);
  });
  if (dropped.length > MAX_DROPPED_LINES) {
    const more = dropped.length - (MAX_DROPPED_LINES - 1);
    dropped.splice(MAX_DROPPED_LINES - 1, dropped.length, `${more} more checks were not run`);
  }
  return { checks, dropped };
}

// ---------- The step request: the rounds as the browser sends them (validated by the API's /api/learn/step) ----------

const CellSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const RowSchema = z.strictObject({ in: z.array(CellSchema), out: z.union([z.array(CellSchema), z.array(z.array(CellSchema))]) });
const WithheldSchema = z.number().int().min(0).optional();
const Count = z.number().int().min(0);
const Bound = z.union([z.number(), z.string()]);

const TestAnswerSchema = z.strictObject({
  rows: Count,
  matched: Count,
  failing: z.array(z.strictObject({ row: RowSchema, expected: CellSchema, got: CellSchema })).max(caps.maxFailingRows),
  withheld: WithheldSchema,
});
const RangesAnswerSchema = z.union([
  z.strictObject({ rows: Count, noValue: Count, clean: z.literal(true), runs: z.array(z.strictObject({ from: Bound, to: Bound, value: CellSchema, rows: Count })).max(caps.maxRuns) }),
  z.strictObject({ rows: Count, noValue: Count, clean: z.literal(false), runCount: Count, mixed: Count }),
]);
const DependsOnAnswerSchema = z.strictObject({
  rows: Count,
  keys: Count,
  rowsAgree: Count,
  keysConflict: Count,
  conflicts: z.array(z.strictObject({ key: z.array(CellSchema).max(caps.maxOn), values: z.tuple([CellSchema, CellSchema]), rows: z.array(RowSchema).max(2) })).max(caps.maxConflicts),
  withheld: WithheldSchema,
});
const ValuesAnswerSchema = z.strictObject({
  rows: Count,
  distinct: Count,
  empty: Count,
  top: z.array(z.strictObject({ value: CellSchema, rows: Count })).max(caps.maxValues),
  min: Bound.optional(),
  max: Bound.optional(),
});
const RowsAnswerSchema = z.strictObject({ matched: Count, rows: z.array(RowSchema).max(caps.maxRowsPerCheck), withheld: WithheldSchema });
const CheckErrorSchema = z.strictObject({ error: z.string().max(300) });

export const CheckAnswerSchema: z.ZodType<CheckAnswer> = z.union([
  TestAnswerSchema,
  RangesAnswerSchema,
  DependsOnAnswerSchema,
  ValuesAnswerSchema,
  RowsAnswerSchema,
  CheckErrorSchema,
]) as unknown as z.ZodType<CheckAnswer>;

export const CheckRoundSchema: z.ZodType<CheckRound> = z
  .strictObject({
    checks: z.array(CheckSchema).max(caps.maxChecksPerRound),
    answers: z.array(CheckAnswerSchema).max(caps.maxChecksPerRound),
    dropped: z.array(z.string().max(300)).max(MAX_DROPPED_LINES).optional(),
  })
  .refine((r) => r.answers.length === r.checks.length, 'one answer per check') as unknown as z.ZodType<CheckRound>;

/** `POST /api/learn/step`'s `rounds`: at least one, at most `limits.learn.checks.maxRounds`. */
export const CheckRoundsSchema = z.array(CheckRoundSchema).min(1).max(caps.maxRounds);

// ---------- The step's size and rows (the browser builds within them; the API refuses what is past them) ----------

/** The rows an answer shows (sample-shaped, masked like the samples). */
export function answerRows(answer: CheckAnswer): Sample[] {
  if ('failing' in answer) return answer.failing.map((f) => f.row);
  if ('conflicts' in answer) return answer.conflicts.flatMap((c) => c.rows);
  if ('matched' in answer && 'rows' in answer && Array.isArray(answer.rows)) return answer.rows;
  return [];
}

/**
 * The rows the rounds show that the payload does not already carry, counted once each (compared as JSON: a row of the example is built and
 * masked the same way wherever it is shown). With the payload's own rows they count toward `limits.learn.loop.maxRowsTotal`.
 */
export function newCheckRows(payload: Pick<LearnPayload, 'samples'>, rounds: readonly CheckRound[]): number {
  const known = new Set(payload.samples.map((s) => JSON.stringify(s)));
  const fresh = new Set<string>();
  for (const round of rounds) for (const answer of round.answers) for (const row of answerRows(answer)) {
    const key = JSON.stringify(row);
    if (!known.has(key)) fresh.add(key);
  }
  return fresh.size;
}

/** The UTF-8 size of a step's body without its token (`{ payload, rounds }`, compact JSON): what the payload byte cap holds a step to. */
export function stepBytes(payload: LearnPayload, rounds: readonly CheckRound[]): number {
  return new TextEncoder().encode(JSON.stringify({ payload, rounds })).length;
}

/**
 * Whether a step fits the caps, as the API checks it (the browser's flow never sends more): at most `maxRounds` rounds, the payload with
 * every round under the payload byte cap (`limits.payload.maxBytes`), and the rows the rounds show within the learn's row limit together
 * with the payload's own samples and dropped rows.
 */
export function stepFits(payload: LearnPayload, rounds: readonly CheckRound[]): boolean {
  if (rounds.length > caps.maxRounds) return false;
  if (payloadRowCount(payload) + newCheckRows(payload, rounds) > limits.learn.loop.maxRowsTotal) return false;
  return stepBytes(payload, rounds) <= limits.payload.maxBytes;
}

// ---------- Who gets learn-v9 in the app ----------

export const LEARN_CHECKS_MODES = ['off', 'admin', 'all'] as const;
export type LearnChecksMode = (typeof LEARN_CHECKS_MODES)[number];

/** `LEARN_CHECKS` as the API reads it: unset is the config's `limits.learn.checks.mode`; a value that is not a mode is `null` (the production check fails on it). */
export function learnChecksModeOf(raw: string | undefined): LearnChecksMode | null {
  if (raw === undefined || raw.trim() === '') return limits.learn.checks.mode;
  const v = raw.trim().toLowerCase();
  return (LEARN_CHECKS_MODES as readonly string[]).includes(v) ? (v as LearnChecksMode) : null;
}
