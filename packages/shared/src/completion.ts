// Completion mode (LEARN_PROMPT "Completing a partial rules file"): the pure questions about a rules file that both the browser's main thread
// (what to ask the AI step for; is this answer worth using) and the engine (the payload, the fixed lock, the API's checks) ask. They only read
// rules, so they live here and the main thread never has to import the engine as code.
import type { AiStepPartCode } from './aiReadiness';
import { stripAiNotes } from './rules/aiNotes';
import { LearnResultSchema, type LearnResult, type Rules } from './rules/schema';

/** What a completion call has to produce: output column positions (0-based) and layout parts. */
export interface CompletionPlan {
  columns: number[];
  parts: AiStepPartCode[];
}

/** `rules` as a plain `LearnResult` (a stored `Rules` also carries `name` and `meta`). */
export function learnResultOf(rules: LearnResult | Rules): LearnResult {
  return {
    schemaVersion: rules.schemaVersion,
    input: rules.input,
    transform: rules.transform,
    output: rules.output,
    validations: rules.validations,
    // learn-v7: the AI step's notes on an unsupported column (a guess, a function request) are never sent back to it
    unsupported: stripAiNotes(rules).unsupported,
    assumptions: rules.assumptions,
  };
}

/** Whether `rules` could be sent as `complete.fixed` (the API parses it with the same schema). */
export function isCompletable(rules: LearnResult | Rules): boolean {
  return LearnResultSchema.safeParse(learnResultOf(rules)).success;
}

/**
 * The layout parts (`AiStepPartCode`) of `candidates` that `rules` still lack: the local partial result says what it
 * could not build, and the user may have added some of it by hand since (a sort key, a filter, a title...).
 */
export function missingParts(rules: LearnResult | Rules, candidates: readonly AiStepPartCode[]): AiStepPartCode[] {
  const has = (code: AiStepPartCode): boolean => {
    switch (code) {
      case 'rows':
        return rules.transform.expand !== undefined;
      case 'droppedRows':
        return (rules.input.rowFilters?.length ?? 0) > 0 || rules.transform.dedupe !== undefined;
      case 'sort':
        return rules.transform.sort.length > 0;
      case 'group':
        return rules.transform.group !== undefined;
      case 'summaryRows':
        return (rules.output.summaryRows?.length ?? 0) > 0 || (rules.transform.group?.summaryRows?.length ?? 0) > 0;
      case 'dateTitle':
        return rules.output.titleRows.some((t) => 'parts' in t);
      case 'blankRows':
        return (rules.transform.group?.blankRowsAfter ?? 0) > 0;
    }
  };
  return candidates.filter((code) => !has(code));
}

/**
 * The output columns the answer honestly reports as unsupported: no `from` AND an `unsupported` entry for the header (any reason code).
 * Such a column is left empty on purpose - "needs your input", not an error - so no check compares it with the example. A `from: null`
 * column with no entry is something else (a reference problem for the API's checks), and a column with a `from` is never one of these.
 */
export function columnsReportedUnsupported(rules: LearnResult | Rules): number[] {
  const headers = new Set(rules.unsupported.map((u) => u.outputColumn));
  const out: number[] = [];
  rules.output.columns.forEach((c, i) => {
    if (c.from === null && headers.has(c.header)) out.push(i);
  });
  return out;
}

/**
 * The output columns that have a rule (0-based positions): a `from`, and no `unsupported` entry saying the column cannot be produced.
 * These are the columns a learn is checked on when some column has none (the same rule as the editor's live check): a partial, correct
 * rules file beats a complete, wrong one (SPEC 4), so what is not produced is never counted as a mismatch.
 */
export function columnsWithRule(rules: LearnResult | Rules): number[] {
  const headers = new Set(rules.unsupported.map((u) => u.outputColumn));
  const out: number[] = [];
  rules.output.columns.forEach((c, i) => {
    if (c.from !== null && !headers.has(c.header)) out.push(i);
  });
  return out;
}

/**
 * DECISION: an answer that produced nothing of what was asked is no completion (and no success for the quota): it is a fixedMismatch for the
 * API's checks (so it is repaired), and the browser keeps the user's rules and reports the learn as failed.
 *
 * What an answer actually produced of what was asked: how many of the listed output columns got a rule, and how many of the listed layout
 * parts the answer has that the fixed rules lacked. A listed column the answer reports as unsupported is ANSWERED (the fixed lock accepts
 * it: it has an `unsupported` entry) but not PRODUCED, so it does not count here. An answer that reports every listed column as
 * unsupported and builds no listed part produced nothing - it is no completion, however clean its lock.
 */
export function completionProduced(
  result: LearnResult | Rules,
  fixed: LearnResult | Rules,
  asked: { columns: readonly number[]; parts: readonly AiStepPartCode[] },
): { columns: number; parts: number } {
  const columns = asked.columns.filter((i) => result.output.columns[i]?.from != null).length;
  const lacking = new Set(missingParts(fixed, asked.parts));
  const parts = asked.parts.filter((p) => lacking.has(p) && missingParts(result, [p]).length === 0).length;
  return { columns, parts };
}

export interface CompletionPlanOptions {
  /** The layout parts the local partial result said it could not build (`PartialInfo.needsAiParts`); default none. */
  parts?: readonly AiStepPartCode[];
}

/**
 * The share of the output columns that already have a rule. Every column counts as one the AI step could fill - also one the pair analysis
 * could not trace to the input (external) or one an earlier answer reported as unsupported: code finding no relation is not proof that none
 * exists (owner rule: skip only what is certain to fail). 1 when there are no columns.
 */
export function fixedColumnShare(rules: LearnResult | Rules): number {
  const total = rules.output.columns.length;
  if (total === 0) return 1;
  return rules.output.columns.filter((col) => col.from !== null).length / total;
}

/**
 * What is missing from `rules`, for a completion call: EVERY output column with no `from` (a column no detector explained, or one an earlier
 * answer called `externalData`, is still the AI step's to try - it may report it as unsupported again), and the layout parts of
 * `options.parts` the rules still lack. The plan is empty when nothing is missing.
 */
export function completionPlan(rules: LearnResult | Rules, options: CompletionPlanOptions = {}): CompletionPlan {
  const columns: number[] = [];
  rules.output.columns.forEach((c, i) => {
    if (c.from === null) columns.push(i);
  });
  return { columns, parts: missingParts(rules, options.parts ?? []) };
}
