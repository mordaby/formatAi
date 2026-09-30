// The AI readiness gate (SPEC 21 v5 item 4): the AI step is the critical, costly path, so before any LLM
// call code checks that the call can succeed. The gate is deliberately MINIMAL - it stops only what is
// certain to fail even with the AI, and lets every ambiguous case (few rows, some unmatched rows, a messy
// column) go to the LLM. None of the outcomes consume a learn.
//
//   - BLOCK  `noRowsMatched`: no output data row could be matched to an input row, so there are no
//     example pairs to learn from (the two files don't seem to come from the same data).
//   - NO CALL `onlyExternalColumns`: every column code couldn't explain is external data (its values
//     aren't in the input file), and nothing else needs the AI - it can't help. The learn finishes
//     locally (`partialRules`), those columns marked "needs your input". Not a block.
//   - BLOCK  `inputColumnsTooMany` / `outputColumnsTooMany` / `payloadTooLarge`: the payload is still over
//     its caps (`limits.payload`) after trimming; the issue says which part is too large.
//
// Pure and synchronous. Run by `learnFromExamples` right before building the payload / calling `callLearn`.

import type { AiReadinessIssueCode, Format, LearnPayload } from '@formatai/shared';
import { limits } from '@formatai/shared';
import type { PairAnalysis } from './analyze';
import type { CompleteOptions } from './complete';
import type { Masker } from './mask';
import { partialRules, type PartialRulesResult } from './partial';
import { buildPayload, type BuildPayloadResult, type PayloadCaps } from './payload';
import type { PreflightResult } from './preflight';

export interface AiReadinessIssue {
  code: AiReadinessIssueCode;
  /** Numbers and strings for the i18n message (see `aiReadinessMessages`), never cell values. */
  params?: Record<string, string | number>;
}

export type AiReadiness =
  | {
      ready: true;
      /** The payload the check built (with the given masker/target), so the caller doesn't build it twice. */
      built?: BuildPayloadResult;
    }
  | { ready: false; issues: AiReadinessIssue[] };

export interface AiReadinessOptions {
  /** SPEC 7.2: the masker the real payload will use, so the size checked is the size sent. */
  masker?: Masker;
  /** SPEC 8.12/A2: attach mode. The output must equal the format's, which the AI step is told to copy, so
   * the local finish for "only external columns" doesn't apply. */
  target?: Format;
  /** Completion mode (LEARN_PROMPT "Completing a partial rules file"): the rules to keep and what is missing. The local finish
   * for "only external columns" doesn't apply (the caller already decided the AI step is wanted), and `built.payload.complete` carries them. */
  complete?: CompleteOptions;
  caps?: PayloadCaps;
  /** An already-built `partialRules` result for this analysis (saves building it twice); `null` when there is
   * none to be had (then "only external columns left" can't be told, and the AI step runs). */
  partial?: PartialRulesResult | null;
}

function issue(code: AiReadinessIssueCode, params?: Record<string, string | number>): AiReadinessIssue {
  return params ? { code, params } : { code };
}

function payloadBytes(payload: LearnPayload): number {
  return new TextEncoder().encode(JSON.stringify(payload)).length;
}

/**
 * Whether the AI step can succeed for this pair (see the file header). `preflight` must not be a block.
 * Returns `{ ready: true }` (with the payload it built), or the issues, each with a code and params.
 * When the only issue is `onlyExternalColumns`, the learn isn't stopped - it finishes locally.
 */
export function aiReadiness(analysis: PairAnalysis, preflight: PreflightResult, opts: AiReadinessOptions = {}): AiReadiness {
  const caps = opts.caps ?? limits.payload;

  // ---- BLOCK: nothing to learn from ----
  if (analysis.alignment.rows.length === 0) return { ready: false, issues: [issue('noRowsMatched')] };

  // ---- NO CALL: only external columns are left ----
  if (opts.target === undefined && opts.complete === undefined) {
    const partial = opts.partial === undefined ? partialRules(analysis, preflight) : opts.partial;
    if (partial !== null && !('reason' in partial) && partial.external.length > 0 && partial.needsAi.length === 0 && partial.needsAiParts.length === 0) {
      return { ready: false, issues: [issue('onlyExternalColumns', { count: partial.external.length, columns: partial.external.join(', ') })] };
    }
  }

  // ---- BLOCK: the payload can't fit its caps ----
  const issues: AiReadinessIssue[] = [];
  if (analysis.input.columnCount > caps.maxColumns) issues.push(issue('inputColumnsTooMany', { count: analysis.input.columnCount, limit: caps.maxColumns }));
  if (analysis.output.columnCount > caps.maxColumns) issues.push(issue('outputColumnsTooMany', { count: analysis.output.columnCount, limit: caps.maxColumns }));
  if (issues.length > 0) return { ready: false, issues };

  const built = buildPayload(analysis, preflight, {
    ...(opts.masker ? { masker: opts.masker } : {}),
    ...(opts.target ? { target: opts.target } : {}),
    ...(opts.complete ? { complete: opts.complete } : {}),
    caps,
  });
  const bytes = payloadBytes(built.payload);
  if (bytes > caps.maxBytes) {
    return { ready: false, issues: [issue('payloadTooLarge', { kb: Math.ceil(bytes / 1024), limitKb: Math.floor(caps.maxBytes / 1024) })] };
  }
  return { ready: true, built };
}
