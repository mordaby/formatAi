// Scoring a run against its case's meta.json `expect` (SPEC 10, eval/cases/README.md).
import type { LearnFromExamplesResult } from '@formatai/engine';
import type { CaseMeta, ExpectClassification } from './caseLoader.js';

/** What actually happened, in the same vocabulary as `meta.json`'s `expect`. */
export type Classification =
  | { kind: 'verified' }
  | { kind: 'unsupported'; codes: string[] }
  | { kind: 'blocked'; reason: string }
  /** The LLM never returned anything usable, even after repair - not one of the three
   * `expect` forms SPEC 10 lists, so it never counts as "expectation met". */
  | { kind: 'failed' }
  /** Rules exist, nothing is unsupported, but full verification still didn't pass. */
  | { kind: 'notVerified' };

export function classify(result: LearnFromExamplesResult): Classification {
  if (result.path === 'blocked') {
    const reason = result.preflight.issues.find((i) => i.severity === 'block')?.code ?? result.preflight.issues[0]?.code ?? 'unknown';
    return { kind: 'blocked', reason };
  }
  if (!result.rules) return { kind: 'failed' };
  if (result.unsupported.length > 0) return { kind: 'unsupported', codes: result.unsupported.map((u) => u.reasonCode) };
  // Completion mode: an answer that changed the rules it had to keep is not a success, however well it matches the example.
  if (result.completion && result.completion.fixedProblems.length > 0) return { kind: 'notVerified' };
  if (result.verification?.verified) return { kind: 'verified' };
  return { kind: 'notVerified' };
}

/** A short, stable string form of a classification, used for grouping/reporting and
 * for the per-case table (e.g. "verified", "blocked:identicalFiles",
 * "unsupported:externalData", "notVerified", "failed"). */
export function classificationLabel(c: Classification): string {
  switch (c.kind) {
    case 'verified':
    case 'failed':
    case 'notVerified':
      return c.kind;
    case 'blocked':
      return `blocked:${c.reason}`;
    case 'unsupported':
      return `unsupported:${c.codes.join('+')}`;
  }
}

function expectationFor(meta: CaseMeta, masking: boolean): ExpectClassification {
  return typeof meta.expect === 'string' ? meta.expect : masking ? meta.expect.masking_on : meta.expect.masking_off;
}

/**
 * Everything the answer produced matches the example (a column it reports as unsupported is not compared, SPEC 4/8.10): a plain learn's own
 * verification (which covers the columns that have a rule, and is never true when none has), or - in completion mode - the fixed lock held
 * and the answer matched the example as far as the AI step is responsible for it.
 */
function producedMatches(result: LearnFromExamplesResult): boolean {
  if (result.completion) return result.completion.fixedProblems.length === 0 && result.completion.matches;
  return result.verification?.verified === true;
}

/**
 * Whether this run's outcome satisfies its case's expectation (SPEC 10's report
 * "expectation met" column).
 *
 * DECISION (SPEC 21 v7 note): for `unsupported:<code>`, only the AI step's own report counts - the answer lists
 * the column in `unsupported` with that code (`externalData` for a column whose values are not in the input). Pre-flight no longer
 * routes a column code could not explain to `skipColumns`: "code found no relation" is not certainty, so the LLM is asked about
 * it like any other column, and a run that never reached the LLM does not meet this expectation.
 *
 * An honest "cannot produce this column" is the expected answer, not a failure: the expectation is met when the report is there AND
 * everything else the answer produced matches the example (`producedMatches`) - a partial, correct rules file beats a complete, wrong one.
 * An answer that reports every column as unsupported produced nothing, so it never meets it.
 *
 * DECISION (owner amendment, 2026-10-06): `answered` are the columns the case's own answers took out (`meta.answers`, `applyCaseAnswers`:
 * "Save without it" to a list copied from the example, asked at save, which code reports with `overfit`). Such a column counts as the
 * expected report: the user said at save what the AI step did not, and the column needs their input - the end state the case expects. An `overfit` the
 * guards wrote is not one (the AI step copied rows even after its repair).
 */
export function expectationMet(meta: CaseMeta, masking: boolean, result: LearnFromExamplesResult, classification: Classification, answered: readonly string[] = []): boolean {
  const expect = expectationFor(meta, masking);

  if (expect === 'verified') return classification.kind === 'verified';

  if (expect.startsWith('blocked:')) {
    const reason = expect.slice('blocked:'.length);
    return classification.kind === 'blocked' && classification.reason === reason;
  }

  if (expect.startsWith('unsupported:')) {
    const code = expect.slice('unsupported:'.length);
    const reported = classification.kind === 'unsupported' && (classification.codes.includes(code) || result.unsupported.some((u) => answered.includes(u.outputColumn)));
    return reported && producedMatches(result);
  }

  return false;
}
