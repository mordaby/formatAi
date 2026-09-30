// Runs the full production pipeline (SPEC 10) for every case x model x masking x run
// combination: `learnFromExamples` (packages/engine) with `callLearn` = the API's
// `learn()` and `callRepair` = `repairFromBrowser`, called in-process (no HTTP), plus
// the hold-out check and scoring. This is the one place that actually spends tokens.
import { formatOf, learnFromExamples, type LearnFromExamplesResult } from '@formatai/engine';
import { learn, repairFromBrowser, type LearnOptions, type LlmCallRecord } from '@formatai/api/learn';
import { resolveModel } from '@formatai/api/llm';
import { loadEnv, type Env } from '@formatai/api/env';
import type { Format, LearnResult, LlmProviderName, Rules, Tier } from '@formatai/shared';
import type { CaseDef } from './caseLoader.js';
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
  path: LearnFromExamplesResult['path'];
  classification: string;
  expectationMet: boolean;
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

function sumCalls(calls: readonly LlmCallRecord[]): Pick<RunRecord, 'tokensIn' | 'tokensOut' | 'tokensCached' | 'costUsd' | 'latencyMs' | 'llmCalls'> {
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
  return { tokensIn, tokensOut, tokensCached, costUsd, latencyMs, llmCalls: calls.length };
}

function emptyTotals(): Pick<RunRecord, 'tokensIn' | 'tokensOut' | 'tokensCached' | 'costUsd' | 'latencyMs' | 'llmCalls'> {
  return { tokensIn: 0, tokensOut: 0, tokensCached: 0, costUsd: 0, latencyMs: 0, llmCalls: 0 };
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
}

export interface RunLearnResult {
  result: LearnFromExamplesResult<LlmCallRecord>;
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
  const learnOpts: LearnOptions = {
    tier: EVAL_TIER,
    env: opts.env,
    models: { firstTry: opts.model, escalation: resolveModel(opts.env, 'escalation') },
    onAttempt: (problems) => {
      for (const p of problems) if (p.kind === 'formula') formulaErrorMessages.push(p.message);
    },
    ...(opts.noEscalation ? { noEscalation: true } : {}),
  };
  const result = await learnFromExamples<LlmCallRecord>({
    input: { bytes: opts.caseDef.input.bytes, name: opts.caseDef.input.fileName },
    output: { bytes: opts.caseDef.output.bytes, name: opts.caseDef.output.fileName },
    masking: opts.masking,
    ...(opts.masking ? { key: evalMaskingKey(opts.caseDef.name, opts.model, opts.run) } : {}),
    tier: EVAL_TIER,
    ...(opts.target ? { target: opts.target } : {}),
    callLearn: (payload) => learn(payload, learnOpts),
    callRepair: (payload, previousRules, problems) => repairFromBrowser(payload, previousRules, problems, learnOpts),
  });
  return { result, formulaErrorMessages };
}

async function toRunRecord(
  caseDef: CaseDef,
  model: string,
  masking: boolean,
  run: number,
  result: LearnFromExamplesResult<LlmCallRecord>,
  formulaErrorMessages: readonly string[],
): Promise<RunRecord> {
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
    path: result.path,
    classification: classificationLabel(classification),
    expectationMet: expectationMet(caseDef.meta, masking, result, classification),
    holdOut,
    fastPath: result.path === 'local',
    schemaValid: result.path !== 'llm' || result.rules !== null,
    verifiedFirstCall: result.stages.verifiedFirstCall,
    verifiedAfterRepair: result.stages.verifiedAfterRepair,
    ...totals,
    ...formula,
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
  onProgress?: (line: string) => void;
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

  for (const model of opts.models) {
    for (const masking of opts.maskingModes) {
      for (let run = 1; run <= opts.runs; run++) {
        const label = `${model} masking=${masking ? 'on' : 'off'} run=${run}`;
        const baseResults = new Map<string, LearnFromExamplesResult<LlmCallRecord>>();

        for (const caseDef of baseCases) {
          opts.onProgress?.(`${label}: ${caseDef.name}`);
          const { result, formulaErrorMessages } = await runLearn({ caseDef, masking, model, run, env, noEscalation: opts.noEscalation });
          baseResults.set(caseDef.name, result);
          records.push(await toRunRecord(caseDef, model, masking, run, result, formulaErrorMessages));
        }

        for (const caseDef of attachedCases) {
          opts.onProgress?.(`${label}: ${caseDef.name} (attach -> ${caseDef.meta.attachTo})`);
          const baseName = caseDef.meta.attachTo!;
          const baseResult = baseResults.get(baseName);
          // DECISION: fall back to the base case's own reference.rules.json when this
          // combination's base attempt didn't produce usable rules, so a single bad
          // base run doesn't cascade into failing every source attached to it.
          const baseRules: LearnResult | Rules | undefined = baseResult?.rules ?? byName.get(baseName)?.referenceRules;
          if (!baseRules) {
            records.push(errorRecord(caseDef, model, masking, run, `base case "${baseName}" produced no rules to attach to (and has no reference.rules.json)`));
            continue;
          }
          const target: Format = formatOf(baseRules);
          const { result, formulaErrorMessages } = await runLearn({ caseDef, masking, model, run, env, noEscalation: opts.noEscalation, target });
          records.push(await toRunRecord(caseDef, model, masking, run, result, formulaErrorMessages));
        }
      }
    }
  }

  return records;
}
