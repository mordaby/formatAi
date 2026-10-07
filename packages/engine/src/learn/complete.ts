// Completion mode (LEARN_PROMPT "Completing a partial rules file"): the user already has part of the rules - the
// columns code solved, what they edited - and the AI step only has to produce what is missing. This module holds
// the `complete` payload field (`completePayloadOf`, with the constants masked like the samples when masking is on);
// what is missing (`completionPlan`) and what an answer produced (`completionProduced`) are pure questions about a rules
// file and live in `@formatai/shared`, re-exported here.
import type { AiStepPartCode, CompletePayload, LearnResult, Rules } from '@formatai/shared';
import { learnResultOf, toWire } from '@formatai/shared';
import { formulaRulesToWire } from '../formula';
import type { PairAnalysis } from './analyze';
import { maskRules, type Masker } from './mask';
import { maskFixedRules, withoutListEntries } from './maskFixed';

export {
  columnsReportedUnsupported,
  columnsWithRule,
  completionPlan,
  completionProduced,
  isCompletable,
  learnResultOf,
  missingParts,
  type CompletionPlan,
  type CompletionPlanOptions,
} from '@formatai/shared';

/** What `learnFromExamples` takes to run in completion mode: the rules to keep, and what is missing. */
export interface CompleteOptions {
  /** The current rules, exactly as they are on screen (real constants, Expr trees). `name`/`meta` are ignored. */
  fixedRules: LearnResult | Rules;
  columns: readonly number[];
  parts: readonly AiStepPartCode[];
}

/**
 * The `complete` field of the learn payload. `fixed` is the rules in wire form (formula text, `{ key, value }` pairs):
 * with a masker the constants are masked FIRST (on the real Expr trees, where a constant is a `{ const }` leaf),
 * then printed - masking formula text directly would turn every function name into a fake word.
 *
 * Amendment 2026-10-07 (engine audit): each constant is masked the way its column is (`maskFixedRules`, the column classification, given
 * the example's `analysis`; without one every constant is masked, `maskRules`), and every lookup table and value map goes with its shape
 * only, no entry (`withoutListEntries`: nothing filled is ever sent).
 */
export function completePayloadOf(options: CompleteOptions, masker?: Masker, analysis?: PairAnalysis): CompletePayload {
  const plain = withoutListEntries(learnResultOf(options.fixedRules));
  const masked = masker ? (analysis ? maskFixedRules(plain, masker, analysis) : maskRules(plain, masker)) : plain;
  return {
    fixed: toWire(formulaRulesToWire(masked) as unknown as LearnResult) as unknown as Record<string, unknown>,
    columns: [...options.columns],
    parts: [...options.parts],
  };
}

/** Every label text in the rules to keep (title rows, summary-row labels): sent real, like the labels of the example output. */
export function fixedLabelTexts(rules: LearnResult | Rules): string[] {
  const texts: string[] = [];
  for (const t of rules.output.titleRows) {
    if ('text' in t) texts.push(t.text);
    if ('parts' in t) for (const p of t.parts) if ('text' in p) texts.push(p.text);
  }
  for (const s of rules.output.summaryRows ?? []) if (s.label) texts.push(s.label);
  for (const s of rules.transform.group?.summaryRows ?? []) if (s.label) texts.push(s.label);
  return texts;
}
