// Completion mode (LEARN_PROMPT "Completing a partial rules file"): the pure questions about a rules file that both the browser's main thread
// (what to ask the AI step for; is this answer worth using) and the engine (the payload, the fixed lock, the API's checks) ask. They only read
// rules, so they live here and the main thread never has to import the engine as code.
import type { AiStepPartCode } from './aiReadiness';
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
    unsupported: rules.unsupported,
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
 * DECISION: an answer that produced nothing of what was asked is no completion (and no success for the quota): it is a fixedMismatch for the
 * API's checks (so it is repaired), and the browser keeps the user's rules and reports the learn as failed.
 *
 * What an answer actually produced of what was asked: how many of the listed output columns got a rule, and how many of the listed layout
 * parts the answer has that the fixed rules lacked. An answer that reports every listed column as unsupported and builds no listed part
 * produced nothing - it is no completion, however clean its lock.
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
  /** Output positions whose values are not in the input at all (`preflight.skipColumns`): the AI step can't produce them. */
  skipColumns?: readonly number[];
}

/**
 * The share of the output columns that already have a rule, counting only columns a rule could fill
 * (not `skipColumns`, not external data). 1 when there is nothing to count.
 */
export function fixedColumnShare(rules: LearnResult | Rules, options: CompletionPlanOptions = {}): number {
  const skip = new Set(options.skipColumns ?? []);
  const external = new Set(rules.unsupported.filter((u) => u.reasonCode === 'externalData').map((u) => u.outputColumn));
  let fillable = 0;
  let fixed = 0;
  rules.output.columns.forEach((col, i) => {
    if (skip.has(i) || external.has(col.header)) return;
    fillable++;
    if (col.from !== null) fixed++;
  });
  return fillable === 0 ? 1 : fixed / fillable;
}

/**
 * What is missing from `rules`, for a completion call: every output column with no `from` (and not external data:
 * a column the pair analysis or the AI step called `externalData` is data no rule can produce), and the layout
 * parts of `options.parts` the rules still lack. The plan is empty when nothing is missing.
 */
export function completionPlan(rules: LearnResult | Rules, options: CompletionPlanOptions = {}): CompletionPlan {
  const skip = new Set(options.skipColumns ?? []);
  const external = new Set(rules.unsupported.filter((u) => u.reasonCode === 'externalData').map((u) => u.outputColumn));
  const columns: number[] = [];
  rules.output.columns.forEach((c, i) => {
    if (c.from === null && !skip.has(i) && !external.has(c.header)) columns.push(i);
  });
  return { columns, parts: missingParts(rules, options.parts ?? []) };
}
