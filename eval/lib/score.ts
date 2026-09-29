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
 * Whether this run's outcome satisfies its case's expectation (SPEC 10's report
 * "expectation met" column).
 *
 * DECISION: for `unsupported:<code>`, a column the LLM was never even asked about
 * because pre-flight already routed it to `skipColumns` (LEARN_PROMPT: "Do not list
 * them in unsupported; they are already reported") also counts, when `<code>` is
 * `externalData` - the one reasonCode SPEC 6.4 itself gives for why a column becomes a
 * skipColumn ("They probably come from another source"). This is exactly "the column
 * appears in unsupported/skipColumns with that code" from this milestone's build note.
 */
export function expectationMet(meta: CaseMeta, masking: boolean, result: LearnFromExamplesResult, classification: Classification): boolean {
  const expect = expectationFor(meta, masking);

  if (expect === 'verified') return classification.kind === 'verified';

  if (expect.startsWith('blocked:')) {
    const reason = expect.slice('blocked:'.length);
    return classification.kind === 'blocked' && classification.reason === reason;
  }

  if (expect.startsWith('unsupported:')) {
    const code = expect.slice('unsupported:'.length);
    if (classification.kind === 'unsupported' && classification.codes.includes(code)) return true;
    if (code === 'externalData' && result.preflight.skipColumns.length > 0) return true;
    return false;
  }

  return false;
}
