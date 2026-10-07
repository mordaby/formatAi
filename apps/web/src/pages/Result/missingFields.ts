// What the AI step would be asked for, from the rules as they are on screen right now (the Result screen and Add a source): EVERY output
// column with no rule (also one code found no trace of in the input: that is not certainty) and the layout parts the free result could not
// build and the rules still lack.
import { completionPlan, fixedColumnShare, isCompletable, limits } from '@formatai/shared';
import type { PartialInfo } from '@formatai/engine';
import type { EditableRules } from '../../editor';
import type { MissingColumn } from './DeepAnalysisPanel';

export interface MissingFields {
  columns: MissingColumn[];
  parts: ReturnType<typeof completionPlan>['parts'];
  /** Something is left for the AI step. */
  any: boolean;
  /** It can be asked for alone (completion mode); otherwise the deep analysis is the whole learn again. */
  completable: boolean;
}

/** `exampleOutputColumns`: how many columns the example output has (undefined: not known). */
export function missingFields(rules: EditableRules, partial: PartialInfo | undefined, exampleOutputColumns: number | undefined): MissingFields {
  const plan = completionPlan(rules, { parts: partial?.needsAiParts ?? [] });
  const external = new Set(partial?.external ?? []);
  const columns: MissingColumn[] = plan.columns.map((index) => {
    const header = rules.output.columns[index]!.header;
    return { index, header, external: external.has(header) };
  });
  // Completion mode needs something to ask for, rules that still line up with the example (no column added or removed), and enough already
  // solved (under limits.learn.completionMinFixedShare of the columns a 'complete the rest' request is just a worse-shaped full learn: first
  // Haiku eval). Otherwise the deep analysis is the whole learn again, which replaces the rules.
  const aligned = exampleOutputColumns === undefined || rules.output.columns.length === exampleOutputColumns;
  const enoughFixed = fixedColumnShare(rules) >= limits.learn.completionMinFixedShare;
  const any = columns.length > 0 || plan.parts.length > 0;
  return { columns, parts: plan.parts, any, completable: any && aligned && enoughFixed && isCompletable(rules) };
}
