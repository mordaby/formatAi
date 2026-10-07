// "See what we send" before the learn (owner, 2026-10-07; SPEC 15): the request the AI step would get for this example, shown before
// anything is learned, with a switch per column (hidden / sent as is). It is built by the SAME code as the learn's own request -
// `aiRequestOf`, which `learnFromExamples` calls too: the masker made from the session key, and the AI readiness gate's payload builder - on
// the same analysis with the same user choices (`withColumnChoices`, read by the one column classification), so the rows shown are the rows
// that go, value for value. Pure and synchronous given the analysis; the caller keeps the analysis (the browser's worker does).
import type { Format, LearnPayload, Tier } from '@formatai/shared';
import type { PairAnalysis, UserColumnChoices } from './analyze';
import { sendColumns, withColumnChoices, type SendColumn } from './classify';
import type { CompleteOptions } from './complete';
import { createMasker, type Masker } from './mask';
import { preflight, type PreflightResult } from './preflight';
import { aiReadiness, type AiReadiness, type AiReadinessIssue } from './readiness';

export interface AiRequestOptions {
  /** SPEC 7.2: masking on or off. */
  masking: boolean;
  /** The session's masking key (required with masking on): the same key gives the same fakes, in the preview and in the learn. */
  key?: Uint8Array | undefined;
  target?: Format | undefined;
  complete?: CompleteOptions | undefined;
  patternHints?: boolean | undefined;
}

/**
 * The masker and the payload the AI step gets for this example (SPEC 7.2, 7.3): the learn's own (`learnFromExamples`) and the preview's
 * (`sendPreview`) - one function, so the two cannot differ. The readiness gate builds the payload (`aiReadiness`).
 */
export function aiRequestOf(analysis: PairAnalysis, pf: PreflightResult, opts: AiRequestOptions): { masker: Masker | undefined; readiness: AiReadiness } {
  if (opts.masking && !opts.key) throw new Error('aiRequestOf: masking is on but no key was given');
  const masker = opts.masking ? createMasker(opts.key!) : undefined;
  const readiness = aiReadiness(analysis, pf, {
    ...(masker ? { masker } : {}),
    ...(opts.target ? { target: opts.target } : {}),
    ...(opts.complete ? { complete: opts.complete } : {}),
    ...(opts.patternHints === false ? { patternHints: false } : {}),
  });
  return { masker, readiness };
}

export interface SendPreviewOptions {
  tier: Tier;
  masking: boolean;
  key?: Uint8Array | undefined;
  /** The user's choices so far (none: as code decided). */
  userColumnChoices?: UserColumnChoices | undefined;
}

/**
 * What "See what we send" shows: per column, whether it is hidden (`SendColumn`), and the request - `ready`: the payload, exactly as the
 * learn would send it; `blocked`: the pre-flight stops this example (nothing can be learned, nothing goes); `notReady`: the readiness gate
 * stops the AI step (nothing goes; `issues` say why).
 */
export type SendPreview =
  | { status: 'ready'; payload: LearnPayload; columns: { input: SendColumn[]; output: SendColumn[] } }
  | { status: 'blocked'; columns: { input: SendColumn[]; output: SendColumn[] } }
  | { status: 'notReady'; issues: AiReadinessIssue[]; columns: { input: SendColumn[]; output: SendColumn[] } };

export function sendPreview(analysis: PairAnalysis, opts: SendPreviewOptions): SendPreview {
  const chosen = withColumnChoices(analysis, opts.userColumnChoices);
  const columns = sendColumns(chosen, opts.masking);
  const pf = preflight(chosen, opts.tier);
  if (pf.status === 'block') return { status: 'blocked', columns };
  const { readiness } = aiRequestOf(chosen, pf, { masking: opts.masking, key: opts.key });
  if (!readiness.ready) return { status: 'notReady', issues: readiness.issues, columns };
  return { status: 'ready', payload: readiness.built!.payload, columns };
}
