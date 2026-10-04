// Runs the full production pipeline (SPEC 10) for every case x model x masking x run
// combination: `learnFromExamples` (packages/engine) with `callLearn` = the API's
// `learn()` and `callRepair` = `repairFromBrowser` (one round of the learning loop, with
// the rows the loop sent), called in-process (no HTTP), plus the hold-out check and
// scoring. This is the one place that actually spends tokens.
import { completionPlan, formatOf, learnFromExamples, type LearnFromExamplesResult } from '@formatai/engine';
import { learn, repairFromBrowser, type CompleteFn, type LearnOptions, type LearnOutcome, type LlmCallRecord } from '@formatai/api/learn';
import { resolveModel } from '@formatai/api/llm';
import { loadEnv, type Env } from '@formatai/api/env';
import { sumEstimates, type Format, type LearnResult, type LlmProviderName, type Rules, type Tier } from '@formatai/shared';
import type { CaseDef } from './caseLoader.js';
import type { EvalMode } from './args.js';
import { checkHoldOut } from './holdout.js';
import { classify, classificationLabel, expectationMet } from './score.js';

/** SPEC 10: the eval harness tests model/prompt quality, not tier limits - run every
 * case at the most permissive tier so a case's own size never triggers a tier block. */
export const EVAL_TIER: Tier = 'paid';

export interface RunRecord {
  case: string;
  domain: string;
  difficulty: string;
  features: string[];
  model: string;
  masking: boolean;
  run: number;
  /** Which way the AI step was asked to work (only set by a run that may use `complete`; absent = `full`). */
  mode?: EvalMode;
  path: LearnFromExamplesResult['path'];
  classification: string;
  expectationMet: boolean;
  /** The case's `meta.expectNote`, when it has one (what the expected outcome means in words; the report prints it). */
  expectNote?: string;
  holdOut: 'pass' | 'fail' | 'n/a';
  fastPath: boolean;
  /** DECISION: no per-call layer-1 signal is threaded out of `learn()` today (only
   * the aggregate `outcome`/best-of-N `problems` are) - approximated as "the LLM
   * eventually produced a structurally valid object" (`rules !== null`), which is
   * exactly what layer-1 (structure) failing would prevent (`runChecks`: "rules:
   * null - when layer 1 itself failed"). Always true off the LLM path. */
  schemaValid: boolean;
  verifiedFirstCall: boolean;
  verifiedAfterRepair: boolean;
  tokensIn: number;
  tokensOut: number;
  tokensCached: number;
  costUsd: number;
  latencyMs: number;
  llmCalls: number;
  /** OUR OWN token count over this run's LLM calls (the learning-loop proposal, section 4; `LlmCallRecord.estimate`, priced with
   * `config/pricing.ts`) - the numbers to compare runs by, since the dev CLI's `tokens*` above include Claude Code's own overhead and
   * thinking tokens. `estCostUsd` is null when a model of the run has no price. */
  estInTokens: number;
  estCachedTokens: number;
  estCacheWriteTokens: number;
  estOutTokens: number;
  estCostUsd: number | null;
  /** The learning loop (SPEC 9.3, `result.loop`): the rounds this learn made (browser-triggered repairs), the rows of the example they sent,
   * and how the loop ended ('verified' or the stop reason: noProgress, roundCap, rowCap, payloadCap, nothingToSend). 0 / 0 / '' when the AI
   * step was not called or brought back no rules. */
  loopRounds: number;
  loopRowsSent: number;
  loopEnd: string;
  /** Product tracking (SPEC 9.2's `formula`-kind `RepairProblem`, from each
   * `LlmCallRecord.problemCounts.formula`): how many formula-text parse failures this
   * run's LLM calls produced, across the learn call and every repair/escalation call. */
  formulaErrorCount: number;
  /** The learn (first) call's own formula-error count - "did the model write an
   * invalid formula on its first try", independent of whether repair later fixed it. */
  firstCallFormulaErrors: number;
  /** True when the first call had >=1 formula error and a LATER call (repair or
   * escalation) had zero - i.e. the model corrected its own invalid formula. */
  formulaFixedByRepair: boolean;
  /** Size of the learn payload the AI step was sent (the first call's; 0 when no call was made) - the input-size proxy
   * that does not need a real model. */
  payloadBytes?: number;
  /** `complete` mode: output columns the local step solved (kept fixed) / left for the AI step, and layout parts left. */
  fixedColumns?: number;
  missingColumns?: number;
  missingParts?: number;
  /** `complete` mode: why no completion call was made (the local step finished, or the AI cannot help). */
  completionSkipped?: string;
  error?: string;
}

/** Dev-only, message-carrying detail behind `formulaErrorCount` (SPEC 15: never part of
 * the production ledger, which is counts-only) - kept OUTSIDE `RunRecord`/`results.csv`
 * (a CSV cell is the wrong place for a list of strings) and consumed only by
 * `report.ts`'s "top formula error messages". Keyed by array index, parallel to the
 * `RunRecord[]` a single `runMatrix` call returns. */
export const formulaErrorMessagesByRecord = new WeakMap<RunRecord, readonly string[]>();

function buildEnv(provider: LlmProviderName): Env {
  return { ...loadEnv(), LLM_PROVIDER: provider };
}

function formulaStats(calls: readonly LlmCallRecord[]): Pick<RunRecord, 'formulaErrorCount' | 'firstCallFormulaErrors' | 'formulaFixedByRepair'> {
  if (calls.length === 0) return { formulaErrorCount: 0, firstCallFormulaErrors: 0, formulaFixedByRepair: false };
  const formulaErrorCount = calls.reduce((sum, c) => sum + c.problemCounts.formula, 0);
  const firstCallFormulaErrors = calls[0]!.problemCounts.formula;
  const lastCallFormulaErrors = calls[calls.length - 1]!.problemCounts.formula;
  const formulaFixedByRepair = firstCallFormulaErrors > 0 && calls.length > 1 && lastCallFormulaErrors === 0;
  return { formulaErrorCount, firstCallFormulaErrors, formulaFixedByRepair };
}

type CallTotals = Pick<RunRecord, 'tokensIn' | 'tokensOut' | 'tokensCached' | 'costUsd' | 'latencyMs' | 'llmCalls' | 'estInTokens' | 'estCachedTokens' | 'estCacheWriteTokens' | 'estOutTokens' | 'estCostUsd'>;

function sumCalls(calls: readonly LlmCallRecord[]): CallTotals {
  let tokensIn = 0;
  let tokensOut = 0;
  let tokensCached = 0;
  let costUsd = 0;
  let latencyMs = 0;
  for (const c of calls) {
    tokensIn += c.tokensIn;
    tokensOut += c.tokensOut;
    tokensCached += c.tokensCached;
    costUsd += c.costUsd;
    latencyMs += c.latencyMs;
  }
  const est = sumEstimates(calls.map((c) => c.estimate));
  return {
    tokensIn,
    tokensOut,
    tokensCached,
    costUsd,
    latencyMs,
    llmCalls: calls.length,
    estInTokens: est.inputTokens,
    estCachedTokens: est.cachedInputTokens,
    estCacheWriteTokens: est.cacheWriteTokens,
    estOutTokens: est.outputTokens,
    estCostUsd: est.costUsd,
  };
}

function emptyTotals(): CallTotals {
  return { tokensIn: 0, tokensOut: 0, tokensCached: 0, costUsd: 0, latencyMs: 0, llmCalls: 0, estInTokens: 0, estCachedTokens: 0, estCacheWriteTokens: 0, estOutTokens: 0, estCostUsd: 0 };
}

/** A deterministic (not cryptographically random) masking key, so `--runs > 1` and
 * repeat invocations of the eval are reproducible (SPEC 10 "Regression"). The real
 * product always generates this randomly per browser session (SPEC 7.2) - this
 * substitution is fine here because masking's purpose (never sending real data to the
 * LLM) doesn't depend on the key's unpredictability, only on it being unknown to the
 * model, which a fixed-but-unpublished eval-only key still satisfies. */
function evalMaskingKey(caseName: string, model: string, run: number): Uint8Array {
  return new TextEncoder().encode(`eval:${caseName}:${model}:${run}`);
}

export interface RunOneOptions {
  caseDef: CaseDef;
  masking: boolean;
  model: string;
  run: number;
  env: Env;
  noEscalation: boolean;
  target?: Format;
  /** Default 'full'. An attach case (`target`) always runs full: the local step knows nothing of the format lock. */
  mode?: EvalMode;
  /** Replaces the LLM call (`LearnOptions.complete`): a test or a dry run passes a fake provider with canned answers here. Default: the real provider of `env`. */
  complete?: CompleteFn;
  /** Called with every outcome of `learn()` / `repairFromBrowser()`: the answer BEFORE the AI notes are taken out of the rules (the catalogue's
   * AI measurement reads the function-request names from it). Observer only. */
  onLearnOutcome?: (outcome: LearnOutcome) => void;
}

export interface RunLearnResult {
  result: LearnFromExamplesResult<LlmCallRecord>;
  /** The mode that was asked for (an attach case asked for 'complete' runs full, and says so in `completion.skipped`). */
  mode: EvalMode;
  /** Size of the first payload sent to the AI step. */
  payloadBytes: number;
  /** `complete` mode facts. */
  completion?: { fixedColumns: number; missingColumns: number; missingParts: number; skipped?: string };
  /**
   * Every `formula`-kind `RepairProblem` MESSAGE seen across every LLM call this run
   * made (learn, repair rounds, escalation) - via `LearnOptions.onAttempt`, the one
   * dev-only path that carries message text (the ledger's own `LlmCallRecord.
   * problemCounts` is counts-only, SPEC 15). These are syntax-only formula-parse
   * messages (e.g. "expected \")\" at 17") with no user data, so the report can list the
   * most common ones (`report.ts`'s "top formula error messages").
   */
  formulaErrorMessages: string[];
}

/** Runs `learnFromExamples` for one case, under one model/masking/run combination. */
export async function runLearn(opts: RunOneOptions): Promise<RunLearnResult> {
  const formulaErrorMessages: string[] = [];
  let payloadBytes = 0;
  const learnOpts: LearnOptions = {
    tier: EVAL_TIER,
    env: opts.env,
    models: { firstTry: opts.model, escalation: resolveModel(opts.env, 'escalation') },
    onAttempt: (problems) => {
      for (const p of problems) if (p.kind === 'formula') formulaErrorMessages.push(p.message);
    },
    ...(opts.noEscalation ? { noEscalation: true } : {}),
    ...(opts.complete ? { complete: opts.complete } : {}),
  };
  const common = {
    input: { bytes: opts.caseDef.input.bytes, name: opts.caseDef.input.fileName },
    output: { bytes: opts.caseDef.output.bytes, name: opts.caseDef.output.fileName },
    masking: opts.masking,
    ...(opts.masking ? { key: evalMaskingKey(opts.caseDef.name, opts.model, opts.run) } : {}),
    tier: EVAL_TIER,
  };
  const callLearn = async (payload: Parameters<typeof learn>[0]) => {
    if (payloadBytes === 0) payloadBytes = new TextEncoder().encode(JSON.stringify(payload)).length;
    const outcome = await learn(payload, learnOpts);
    opts.onLearnOutcome?.(outcome);
    return outcome;
  };
  // A round of the learning loop, exactly as the API's /api/learn/repair runs it: the answer checked on the samples plus every row sent.
  // (The loop itself - which rows, when to stop - is `learnFromExamples`' own, the same code the browser runs.)
  const callRepair: Parameters<typeof learnFromExamples<LlmCallRecord>>[0]['callRepair'] = async (payload, previousRules, problems, round) => {
    const outcome = await repairFromBrowser(payload, previousRules, problems, { ...learnOpts, rows: round.rows });
    opts.onLearnOutcome?.(outcome);
    return outcome;
  };

  const wantsComplete = opts.mode === 'complete' && !opts.target;
  if (!wantsComplete) {
    const result = await learnFromExamples<LlmCallRecord>({ ...common, ...(opts.target ? { target: opts.target } : {}), callLearn, callRepair });
    // (an attach case asked to run in complete mode is still counted under it, with the note that it ran full)
    return {
      result,
      mode: opts.mode ?? 'full',
      payloadBytes,
      formulaErrorMessages,
      ...(opts.mode === 'complete' ? { completion: { fixedColumns: 0, missingColumns: 0, missingParts: 0, skipped: 'attach case (ran full)' } } : {}),
    };
  }

  // complete: the local step first (what a visitor gets, no LLM) ...
  const local = await learnFromExamples<LlmCallRecord>({
    ...common,
    ai: 'notAllowed',
    callLearn: async () => {
      throw new Error('the local step never calls the AI step');
    },
  });
  const solvedPartial = local.path === 'partial' && local.partial?.reason === 'aiNotAllowed' && local.rules !== null;
  if (!solvedPartial) {
    // The local step finished it (fast path) or blocked it: nothing to complete.
    return { result: local, mode: 'complete', payloadBytes, formulaErrorMessages, completion: { fixedColumns: local.partial?.solved.length ?? local.rules?.output.columns.length ?? 0, missingColumns: 0, missingParts: 0, skipped: local.path } };
  }
  // ... then the AI step on what is missing only, the local rules kept as the fixed part.
  const rules = local.rules!;
  const plan = completionPlan(rules, { parts: local.partial!.needsAiParts });
  const fixedColumns = rules.output.columns.length - plan.columns.length;
  if (plan.columns.length === 0 && plan.parts.length === 0) {
    // The local rules cover every column and part, yet the strict fast path would not accept them (rows that change shape go to the AI
    // step, SPEC 6.5): there is nothing to complete, so - exactly as on the Result screen - the AI step runs as a full learn.
    const result = await learnFromExamples<LlmCallRecord>({ ...common, callLearn, callRepair });
    return { result, mode: 'complete', payloadBytes, formulaErrorMessages, completion: { fixedColumns, missingColumns: 0, missingParts: 0, skipped: 'nothingMissing (ran full)' } };
  }
  const result = await learnFromExamples<LlmCallRecord>({
    ...common,
    complete: { fixedRules: rules, columns: plan.columns, parts: plan.parts },
    callLearn,
    callRepair,
  });
  return { result, mode: 'complete', payloadBytes, formulaErrorMessages, completion: { fixedColumns, missingColumns: plan.columns.length, missingParts: plan.parts.length } };
}

async function toRunRecord(
  caseDef: CaseDef,
  model: string,
  masking: boolean,
  run: number,
  ran: RunLearnResult,
  /** Set when the matrix ran more than one mode: every record then says which one it was. */
  tagMode: boolean,
): Promise<RunRecord> {
  const { result, formulaErrorMessages } = ran;
  const classification = classify(result);
  const totals = result.path === 'llm' ? sumCalls(result.calls) : emptyTotals();
  const formula = result.path === 'llm' ? formulaStats(result.calls) : formulaStats([]);

  let holdOut: RunRecord['holdOut'] = 'n/a';
  if (caseDef.next && result.rules) {
    const h = await checkHoldOut(result.rules, caseDef.next);
    holdOut = h.ok ? 'pass' : 'fail';
  }

  const record: RunRecord = {
    case: caseDef.name,
    domain: caseDef.meta.domain,
    difficulty: caseDef.meta.difficulty,
    features: caseDef.meta.features,
    model,
    masking,
    run,
    ...(tagMode ? { mode: ran.mode } : {}),
    path: result.path,
    classification: classificationLabel(classification),
    expectationMet: expectationMet(caseDef.meta, masking, result, classification),
    ...(caseDef.meta.expectNote ? { expectNote: caseDef.meta.expectNote } : {}),
    holdOut,
    fastPath: result.path === 'local',
    schemaValid: result.path !== 'llm' || result.rules !== null,
    verifiedFirstCall: result.stages.verifiedFirstCall,
    verifiedAfterRepair: result.stages.verifiedAfterRepair,
    ...totals,
    loopRounds: result.loop?.rounds ?? 0,
    loopRowsSent: result.loop?.rowsSent ?? 0,
    loopEnd: result.loop?.end ?? '',
    ...formula,
    ...(tagMode
      ? {
          payloadBytes: ran.payloadBytes,
          ...(ran.completion
            ? {
                fixedColumns: ran.completion.fixedColumns,
                missingColumns: ran.completion.missingColumns,
                missingParts: ran.completion.missingParts,
                ...(ran.completion.skipped ? { completionSkipped: ran.completion.skipped } : {}),
              }
            : {}),
        }
      : {}),
  };
  if (formulaErrorMessages.length > 0) formulaErrorMessagesByRecord.set(record, formulaErrorMessages);
  return record;
}

function errorRecord(caseDef: CaseDef, model: string, masking: boolean, run: number, error: string): RunRecord {
  return {
    case: caseDef.name,
    domain: caseDef.meta.domain,
    difficulty: caseDef.meta.difficulty,
    features: caseDef.meta.features,
    model,
    masking,
    run,
    path: 'blocked',
    classification: 'error',
    expectationMet: false,
    holdOut: 'n/a',
    fastPath: false,
    schemaValid: false,
    verifiedFirstCall: false,
    verifiedAfterRepair: false,
    ...emptyTotals(),
    loopRounds: 0,
    loopRowsSent: 0,
    loopEnd: '',
    ...formulaStats([]),
    error,
  };
}

export interface RunMatrixOptions {
  cases: CaseDef[];
  models: string[];
  /** true = masking on. */
  maskingModes: boolean[];
  runs: number;
  provider: LlmProviderName;
  noEscalation: boolean;
  /** Which modes to run (default `['full']`); see `EvalMode`. */
  modes?: EvalMode[];
  onProgress?: (line: string) => void;
  /** Replaces the LLM call (`RunOneOptions.complete`): a test passes a fake provider with canned answers. Default: the real provider. */
  complete?: CompleteFn;
}

/**
 * Runs every case x model x masking x run combination (SPEC 10's runner). Registry
 * cases (`meta.attachTo`) are learned after their base case, in the SAME combination,
 * using `formatOf(baseRules)` as `target` - falling back to the base case's own
 * `reference.rules.json` when the base failed to produce usable rules in this
 * particular combination (`// DECISION` below), so one bad base attempt doesn't
 * silently fail every source attached to it.
 */
export async function runMatrix(opts: RunMatrixOptions): Promise<RunRecord[]> {
  const env = buildEnv(opts.provider);
  const records: RunRecord[] = [];

  const baseCases = opts.cases.filter((c) => !c.meta.attachTo);
  const attachedCases = opts.cases.filter((c) => c.meta.attachTo);
  const byName = new Map(opts.cases.map((c) => [c.name, c] as const));

  const modes: EvalMode[] = opts.modes && opts.modes.length > 0 ? opts.modes : ['full'];
  // Every record says which mode it ran only when the matrix ran a mode other than plain 'full' (a full-only report stays as it always was).
  const tagMode = modes.some((m) => m !== 'full');

  for (const model of opts.models) {
    for (const masking of opts.maskingModes) {
      for (let run = 1; run <= opts.runs; run++) {
        for (const mode of modes) {
          const label = `${model} masking=${masking ? 'on' : 'off'} run=${run}${tagMode ? ` mode=${mode}` : ''}`;
          const baseResults = new Map<string, LearnFromExamplesResult<LlmCallRecord>>();

          for (const caseDef of baseCases) {
            opts.onProgress?.(`${label}: ${caseDef.name}`);
            const ran = await runLearn({ caseDef, masking, model, run, env, noEscalation: opts.noEscalation, mode, ...(opts.complete ? { complete: opts.complete } : {}) });
            baseResults.set(caseDef.name, ran.result);
            records.push(await toRunRecord(caseDef, model, masking, run, ran, tagMode));
          }

          for (const caseDef of attachedCases) {
            opts.onProgress?.(`${label}: ${caseDef.name} (attach -> ${caseDef.meta.attachTo})`);
            const baseName = caseDef.meta.attachTo!;
            const baseResult = baseResults.get(baseName);
            // DECISION: fall back to the base case's own reference.rules.json when this
            // combination's base attempt didn't produce usable rules, so a single bad
            // base run doesn't cascade into failing every source attached to it. (In complete mode a local PARTIAL
            // result is not usable rules for a format either: only a finished one is.)
            const usable = mode === 'complete' && baseResult?.path === 'partial' ? null : baseResult?.rules;
            const baseRules: LearnResult | Rules | undefined = usable ?? byName.get(baseName)?.referenceRules;
            if (!baseRules) {
              records.push(errorRecord(caseDef, model, masking, run, `base case "${baseName}" produced no rules to attach to (and has no reference.rules.json)`));
              continue;
            }
            const target: Format = formatOf(baseRules);
            const ran = await runLearn({ caseDef, masking, model, run, env, noEscalation: opts.noEscalation, target, mode, ...(opts.complete ? { complete: opts.complete } : {}) });
            records.push(await toRunRecord(caseDef, model, masking, run, ran, tagMode));
          }
        }
      }
    }
  }

  return records;
}
