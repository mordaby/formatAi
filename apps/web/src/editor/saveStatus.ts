// Saving (SPEC 8.11 "Saving"): the status the Save button shows, as a pure function of what has been checked.
//
//   blocked              a static check (SPEC 9.2 layers 1-5) found a problem: nothing can be saved until it is fixed
//   checking             a check is still running, or the last full check is for older rules
//   checkFailed          the check itself failed (the worker timed out or crashed): press Apply to try again
//   noExample            no example in memory: the rules can't be verified (save as `userConfirmed`)
//   verified             every row matches, not counting one-off exceptions
//   differences (N)      "Save with N differences": saved as `differencesAccepted`, the badge shows N
import type { Rules } from '@formatai/shared';
import type { LiveCheckResult, StaticProblem } from '../worker/editorApi';
import { explainStaticProblems, type ExplainedProblem } from './explain';
import type { EditableRules } from './types';

export type SaveStatus =
  | { kind: 'blocked'; problems: ExplainedProblem[] }
  | { kind: 'checking' }
  | { kind: 'checkFailed'; message: string }
  | { kind: 'noExample' }
  | { kind: 'verified' }
  | { kind: 'differences'; differences: number };

export interface SaveInputs {
  rules: EditableRules;
  /** Static-check problems for the current rules, or null while they are still being computed. */
  staticProblems: readonly StaticProblem[] | null;
  /** The example is in memory (an `exampleId` exists and the worker still holds it). */
  hasExample: boolean;
  /** An all-rows check of the current rules and exceptions, or null if there is none yet (or only a partial/old one). */
  fullCheck: LiveCheckResult | null;
  /** The last check failed to run at all (not a mismatch: an error from the worker). */
  checkError?: { code?: string; message: string } | null;
}

export function computeSaveStatus(input: SaveInputs): SaveStatus {
  if (input.staticProblems === null) return { kind: 'checking' };
  if (input.staticProblems.length > 0) return { kind: 'blocked', problems: explainStaticProblems(input.rules, input.staticProblems) };
  if (!input.hasExample) return { kind: 'noExample' };
  if (input.fullCheck === null || input.fullCheck.partial) {
    return input.checkError ? { kind: 'checkFailed', message: input.checkError.message } : { kind: 'checking' };
  }
  if (input.fullCheck.verified) return { kind: 'verified' };
  return { kind: 'differences', differences: input.fullCheck.differences };
}

/** The `meta.status` a save with this status gets (SPEC 13). `blocked` and `checking` cannot be saved. */
export function metaStatusOf(status: SaveStatus): 'verified' | 'differencesAccepted' | 'userConfirmed' | null {
  switch (status.kind) {
    case 'verified':
      return 'verified';
    case 'differences':
      return 'differencesAccepted';
    case 'noExample':
      return 'userConfirmed';
    default:
      return null;
  }
}

/** N of "Save with N differences" (the badge), or null for any other status. */
export function differencesOf(status: SaveStatus): number | null {
  return status.kind === 'differences' ? status.differences : null;
}

/** A stored conversion with the status this save gives it (a fresh learn has no `meta` yet: the caller builds it). */
export function stampStatus(rules: Rules, status: SaveStatus): Rules {
  const meta = metaStatusOf(status);
  return meta === null ? rules : { ...rules, meta: { ...rules.meta, status: meta } };
}
