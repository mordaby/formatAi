// The AI measurement of the rule catalogue (`run-catalogue.ts --ai <model>`): for every type the language can express and the free engine does
// not solve (the "needs-AI set"), runs the REAL learn flow with the AI step allowed - exactly what the eval runner does (`runLearn`: the free engine
// first when `mode` is complete, then the AI step with its repair rounds and escalation) - and records what happened: path, verified on the example,
// hold-out on the next month's file, calls, tokens, latency, formula errors, the AI's unsupported codes, the NAMES of the functions it asked for, and
// whether it explained itself. Counts, codes and names only: no value of any file is ever recorded.
//
// This file is the one that spends tokens. Nothing in it chooses a provider: the caller says which (`env.LLM_PROVIDER`), or injects `complete`
// (a fake provider with canned answers: tests, and the dry run of `--provider fake`).
import type { CompleteFn } from '@formatai/api/learn';
import { createFakeProvider } from '@formatai/api/llm';
import type { Env } from '@formatai/api/env';
import { sumEstimates, toWire, type LearnResult } from '@formatai/shared';
import type { CaseDef } from '../lib/caseLoader';
import { checkHoldOut } from '../lib/holdout';
import { runLearn } from '../lib/runner';
import { classify, classificationLabel } from '../lib/score';
import { aiStatusOf, mergeRecords, planAiWork, type AiPlan } from './aiRecords';
import { assembleWire } from './kit';
import { measure, prepare, type Prepared } from './measure';
import type { AiConfigRecord, AiRecord, CatalogueRecord, CatalogueType } from './types';

// ---------- One (type, seed) ----------

export interface AiMeasureOptions extends AiConfigRecord {
  env: Env;
  /** Replaces the LLM call (a fake provider with canned answers). Default: the real provider of `env`. */
  complete?: CompleteFn;
}

function caseOf(p: Prepared): CaseDef {
  return {
    name: `${p.type.id}#${p.seed}`,
    dir: '',
    meta: { difficulty: 'catalogue', domain: p.type.topic, features: [], expect: 'verified' },
    input: { fileName: p.input.name, bytes: p.input.bytes },
    output: { fileName: p.output.name, bytes: p.output.bytes },
    next: { input: { fileName: p.nextInput.name, bytes: p.nextInput.bytes }, output: { fileName: p.nextOutput.name, bytes: p.nextOutput.bytes } },
  };
}

function configOf(o: AiConfigRecord): AiConfigRecord {
  return { model: o.model, provider: o.provider, mode: o.mode, masking: o.masking, noEscalation: o.noEscalation };
}

const ZERO = { llmCalls: 0, tokensIn: 0, tokensOut: 0, tokensCached: 0, costUsd: 0, latencyMs: 0, formulaErrors: 0, callErrors: 0 };

/** The real flow on one prepared (type, seed). Never throws: a run that threw is a record with `error` (so `--resume` runs it again). */
export async function measureAi(p: Prepared, opts: AiMeasureOptions): Promise<AiRecord> {
  const config = configOf(opts);
  const at = new Date().toISOString();
  // The answer the AI step gave last, BEFORE its notes are taken out of the rules: the function requests' names are read from it.
  let lastRules: LearnResult | null = null;
  try {
    const ran = await runLearn({
      caseDef: caseOf(p),
      masking: opts.masking,
      model: opts.model,
      run: 1,
      env: opts.env,
      noEscalation: opts.noEscalation,
      mode: opts.mode,
      ...(opts.complete ? { complete: opts.complete } : {}),
      onLearnOutcome: (outcome) => {
        if (outcome.rules) lastRules = outcome.rules;
      },
    });
    const { result } = ran;
    const classification = classify(result);

    const calls = result.calls;
    const sums = { ...ZERO, llmCalls: calls.length };
    for (const c of calls) {
      sums.tokensIn += c.tokensIn;
      sums.tokensOut += c.tokensOut;
      sums.tokensCached += c.tokensCached;
      sums.costUsd += c.costUsd;
      sums.latencyMs += c.latencyMs;
      sums.formulaErrors += c.problemCounts.formula;
      if (c.outcome.startsWith('error:')) sums.callErrors += 1;
    }

    let holdOut: AiRecord['holdOut'] = 'n/a';
    if (result.rules) {
      try {
        holdOut = (await checkHoldOut(result.rules, { input: { fileName: p.nextInput.name, bytes: p.nextInput.bytes }, output: { fileName: p.nextOutput.name, bytes: p.nextOutput.bytes } })).ok ? 'pass' : 'fail';
      } catch {
        holdOut = 'fail';
      }
    }

    const rules = lastRules as LearnResult | null;
    const functionRequests = (rules?.unsupported ?? []).flatMap((u) => (u.functionRequest ? [u.functionRequest.name] : []));
    const outcomes = [...new Set(calls.map((c) => c.outcome))];
    const everyCallFailed = calls.length > 0 && sums.callErrors === calls.length;
    const record: AiRecord = {
      ...config,
      path: result.path,
      classification: classificationLabel(classification),
      verified: classification.kind === 'verified',
      holdOut,
      ...sums,
      estimate: sumEstimates(calls.map((c) => c.estimate)),
      unsupported: result.unsupported.map((u) => u.reasonCode),
      functionRequests,
      explanation: (result.aiNotes ?? []).some((n) => n.explanation !== undefined),
      ...(ran.completion ? { completion: ran.completion } : {}),
      ...(everyCallFailed ? { error: `every LLM call failed (${outcomes.join(', ')})` } : {}),
      at,
    };
    return record;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { ...config, path: 'error', classification: 'error', verified: false, holdOut: 'n/a', ...ZERO, unsupported: [], functionRequests: [], explanation: false, error: message.slice(0, 200), at };
  }
}

// ---------- The fake provider for a dry run ----------

/** A fake provider that answers every call of a (type, seed) with the type's REFERENCE rule (in the AI step's wire shape): the pipeline runs end to end
 * with no LLM and no cost, and a type whose reference rule is right comes out verified. It knows nothing of masking (it answers in real words), so a
 * dry run that means to show verified results uses `--masking off`. Token counts are zero: nothing was measured. */
export function referenceAnswerFake(type: CatalogueType, copies = 6): CompleteFn {
  const fake = createFakeProvider();
  const json = toWire(assembleWire(type) as unknown as LearnResult);
  for (let i = 0; i < copies; i++) fake.enqueue({ json });
  return (req) => fake.complete(req);
}

// ---------- The whole run ----------

export interface AiRunOptions {
  config: AiConfigRecord;
  env: Env;
  /** The types selected by --types (all by default). */
  types: readonly CatalogueType[];
  seeds: readonly number[];
  /** Everything results.json holds (free layers and earlier AI results). */
  records: readonly CatalogueRecord[];
  chunk?: { index: number; total: number } | undefined;
  resume: boolean;
  /** Overwrite AI results recorded under another configuration. */
  replace: boolean;
  /** Build the plan and stop: no LLM call (the free layers of a missing pair are still measured: the plan needs them). */
  planOnly?: boolean;
  /** Write the free-layer records of --dump here when the free layers of a missing pair are measured. */
  dumpDir?: string;
  /** The fake provider (or any CompleteFn) to use for a type; undefined = the real provider of `env`. */
  completeFor?: (type: CatalogueType, seed: number) => CompleteFn | undefined;
  /** Called with the full merged records every time they changed (the caller writes results.json: a crash must not lose paid-for work). */
  onRecords?: (records: CatalogueRecord[]) => void;
  log?: (line: string) => void;
  /** Checked between pairs: true = stop cleanly after the current one (Ctrl-C). */
  shouldStop?: () => boolean;
  order?: readonly string[];
}

export interface AiRunResult {
  records: CatalogueRecord[];
  plan: AiPlan;
  /** AI measurements made now. */
  measured: number;
  stopped: boolean;
}

export class AiConflictError extends Error {}

export async function runAiMeasurement(o: AiRunOptions): Promise<AiRunResult> {
  const log = o.log ?? (() => {});
  // learn() reaches the LLM through env.LLM_PROVIDER: a run that says one provider while the environment says another would spend tokens somewhere it did not mean to.
  if (o.env.LLM_PROVIDER !== o.config.provider) throw new Error(`runAiMeasurement: the configuration says provider ${o.config.provider} but the environment says ${o.env.LLM_PROVIDER}`);
  const mergeOpts = o.order ? { order: o.order } : {};
  let records = [...o.records];

  // 1. The free layers of every selected (type, seed) must be there: they decide who needs the AI step. A missing pair is measured now (free, no LLM).
  const have = new Set(records.map((r) => `${r.type}#${r.seed}`));
  const missing = o.types.flatMap((type) => o.seeds.filter((seed) => !have.has(`${type.id}#${seed}`)).map((seed) => ({ type, seed })));
  if (missing.length > 0) {
    log(`measuring the free layers of ${missing.length} (type, seed) pair(s) results.json does not have yet (no LLM) ...`);
    const fresh: CatalogueRecord[] = [];
    for (const { type, seed } of missing) fresh.push(await measure(type, seed, o.dumpDir !== undefined ? { dumpDir: o.dumpDir } : {}));
    records = mergeRecords(records, fresh, mergeOpts);
    o.onRecords?.(records);
  }

  // 2. The plan.
  const selected = new Set(o.types.map((t) => t.id));
  const plan = planAiWork({ types: o.types, records: records.filter((r) => selected.has(r.type)), seeds: o.seeds, chunk: o.chunk, config: o.config, resume: o.resume });
  if (plan.conflicts.length > 0 && !o.replace && !o.planOnly) {
    const other = [...new Set(records.filter((r) => r.ai && plan.conflicts.some((c) => c.type.id === r.type && c.seed === r.seed)).map((r) => `${r.ai!.model}/${r.ai!.mode}/masking ${r.ai!.masking ? 'on' : 'off'}${r.ai!.noEscalation ? '/no escalation' : ''}`))];
    throw new AiConflictError(
      `${plan.conflicts.length} (type, seed) pair(s) already hold AI results of another configuration (${other.join('; ')}). Running would overwrite them: ` +
        'use `--out <other dir>` to keep both (the free layers are re-measured there in a minute), or `--replace` to overwrite.',
    );
  }
  if (o.planOnly) return { records, plan, measured: 0, stopped: false };

  // 3. One pair at a time (providers rate-limit; a failure of one must not cost the rest). The file is written after every pair.
  let measured = 0;
  let stopped = false;
  const total = plan.todo.length;
  for (const { type, seed } of plan.todo) {
    if (o.shouldStop?.()) {
      stopped = true;
      break;
    }
    const p = await prepare(type, seed);
    const complete = o.completeFor?.(type, seed);
    const ai = await measureAi(p, { ...o.config, env: o.env, ...(complete ? { complete } : {}) });
    const free = records.find((r) => r.type === type.id && r.seed === seed)!;
    records = mergeRecords(records, [{ ...free, ai }], mergeOpts);
    o.onRecords?.(records);
    measured++;
    log(`[${measured}/${total}] ${describeAi(type.id, seed, ai)}`);
  }
  return { records, plan, measured, stopped };
}

// ---------- Printing ----------

const usd = (v: number | null): string => (v === null ? 'n/a' : `$${v.toFixed(4)}`);

function k(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

const STATUS_WORD = { learned: 'learned (verified + hold-out)', verifiedOnly: 'verified only (hold-out fails)', failed: 'not learned', error: 'ERROR (will be redone by --resume)' } as const;

/** One progress line for a measured pair. */
export function describeAi(typeId: string, seed: number, a: AiRecord): string {
  const parts = [
    `${typeId.padEnd(40)} seed ${seed}`,
    `${a.path} / ${STATUS_WORD[aiStatusOf(a)]}`,
    `${a.llmCalls} call(s), in ${k(a.tokensIn)} out ${k(a.tokensOut)}${a.tokensCached > 0 ? ` cached ${k(a.tokensCached)}` : ''}, ${(a.latencyMs / 1000).toFixed(1)} s`,
  ];
  const e = a.estimate;
  if (e && a.llmCalls > 0) parts.push(`est. in ${k(e.inputTokens)} / cached ${k(e.cachedInputTokens)} / write ${k(e.cacheWriteTokens)} / out ${k(e.outputTokens)}, ${usd(e.costUsd)}`);
  if (a.classification !== 'verified') parts.push(a.classification);
  if (a.formulaErrors > 0) parts.push(`${a.formulaErrors} formula error(s)`);
  if (a.functionRequests.length > 0) parts.push(`asks for ${a.functionRequests.join(', ')}`);
  if (a.error) parts.push(a.error);
  return parts.join('  |  ');
}
