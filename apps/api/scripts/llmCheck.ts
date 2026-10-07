// `pnpm --filter @formatai/api llm-check -- --provider openai|anthropic` (SPEC 9.6, issue #45): ONE small real learn call, to check a
// provider's key and request parameters before production relies on them. The payload is built from a bundled synthetic eval case
// (`eval/cases/crm-rename-reorder`: made-up customers) with masking ON, exactly as the browser builds one; the answer goes through the
// API's own checks (`runChecks`, SPEC 9.2 layers 1-7). It prints the model, the latency, the tokens, whether the answer was cut off and
// whether it passed - and, on a failure, the provider's error. Never the key: it is read from the environment or the repository's `.env`
// (`loadEnv`), and anything that looks like one is cut out of every line printed.
//
// It calls the named provider directly - never through the fallback - so each provider is checked on its own.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { aiReadiness, analyzePair, createMasker, preflight, readWorkbook, sniffDelimitedText } from '@formatai/engine';
import { learnPromptOf, learnResultWireJsonSchema, models, type LearnPayload, type RepairProblem } from '@formatai/shared';
import { loadEnv, repoRoot, type Env } from '../src/env.js';
import { runChecks } from '../src/learn/checks.js';
import { createProvider, LlmError, resolveFallbackModel, resolveModel, type CompleteResult, type LlmProvider, type ModelPurpose } from '../src/llm/index.js';

/** The providers a real check can call (the dev CLI and the fake need no key and have nothing to check here). */
export const CHECKABLE_PROVIDERS = ['anthropic', 'openai'] as const;
export type CheckableProvider = (typeof CHECKABLE_PROVIDERS)[number];

const KEY_NAMES: Record<CheckableProvider, 'ANTHROPIC_API_KEY' | 'OPENAI_API_KEY'> = { anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY' };

/** The bundled synthetic case the payload is built from. */
export const CHECK_CASE = 'crm-rename-reorder';

export interface LlmCheckArgs {
  provider: CheckableProvider;
  slot: ModelPurpose;
  /** `--model`: a model id to call instead of the slot's. */
  model?: string;
}

export type ParsedArgs = { ok: true; args: LlmCheckArgs } | { ok: false; help: boolean; message: string };

export const USAGE = [
  'usage: pnpm --filter @formatai/api llm-check -- --provider anthropic|openai [--escalation] [--model <id>]',
  '  --provider    the provider to call (its key: ANTHROPIC_API_KEY / OPENAI_API_KEY, from the environment or the repository .env)',
  '  --escalation  call the escalation slot\'s model (default: the first-try slot)',
  '  --model       call this model id instead of the slot\'s',
].join('\n');

/** The command line, without the node and script paths. A literal `--` (pnpm passes it through) is skipped. */
export function parseLlmCheckArgs(argv: readonly string[]): ParsedArgs {
  let provider: string | undefined;
  let model: string | undefined;
  let slot: ModelPurpose = 'firstTry';
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i]!;
    if (raw === '--') continue;
    if (raw === '--help' || raw === '-h') return { ok: false, help: true, message: USAGE };
    const [flag, inline] = raw.startsWith('--') && raw.includes('=') ? [raw.slice(0, raw.indexOf('=')), raw.slice(raw.indexOf('=') + 1)] : [raw, undefined];
    const value = (): string | undefined => {
      if (inline !== undefined) return inline;
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) return undefined;
      i++;
      return next;
    };
    if (flag === '--provider') {
      provider = value();
      if (provider === undefined) return { ok: false, help: false, message: `--provider needs a value (${CHECKABLE_PROVIDERS.join(' or ')})\n${USAGE}` };
    } else if (flag === '--model') {
      model = value();
      if (!model) return { ok: false, help: false, message: `--model needs a model id\n${USAGE}` };
    } else if (flag === '--escalation' && inline === undefined) {
      slot = 'escalation';
    } else {
      return { ok: false, help: false, message: `unknown argument "${raw}"\n${USAGE}` };
    }
  }
  if (provider === undefined) return { ok: false, help: false, message: `--provider is required\n${USAGE}` };
  if (!(CHECKABLE_PROVIDERS as readonly string[]).includes(provider)) {
    return { ok: false, help: false, message: `--provider must be ${CHECKABLE_PROVIDERS.join(' or ')} (got "${provider}")\n${USAGE}` };
  }
  return { ok: true, args: { provider: provider as CheckableProvider, slot, ...(model ? { model } : {}) } };
}

/** The model a check calls: `--model`, else the slot's as the app would resolve it for that provider (primary or fallback), else config. */
export function checkModelOf(env: Env, args: LlmCheckArgs): string {
  if (args.model) return args.model;
  if (args.provider === env.LLM_PROVIDER) return resolveModel(env, args.slot);
  if (args.provider === env.LLM_FALLBACK_PROVIDER) return resolveFallbackModel(env, args.slot)!;
  return models[args.provider][args.slot];
}

/** Cuts anything that looks like an API key - the given secrets, and `sk-...` tokens even when partly starred - out of a line. */
export function redactKeys(text: string, secrets: readonly (string | undefined)[]): string {
  let out = text;
  for (const s of secrets) if (s && s.length >= 8) out = out.split(s).join('[key]');
  return out.replace(/\bsk-[A-Za-z0-9_*-]{4,}/g, '[key]');
}

/** The learn payload of the bundled case, masked with a fresh random key (as a browser session would). */
export async function buildCheckPayload(caseDir = path.join(repoRoot, 'eval', 'cases', CHECK_CASE)): Promise<LearnPayload> {
  const inputBytes = new Uint8Array(readFileSync(path.join(caseDir, 'input.csv')));
  const outputBytes = new Uint8Array(readFileSync(path.join(caseDir, 'output.csv')));
  const inputWb = await readWorkbook(inputBytes, 'input.csv');
  const outputWb = await readWorkbook(outputBytes, 'output.csv');
  const analysis = analyzePair(inputWb, outputWb, { outputSniff: sniffDelimitedText(outputBytes) });
  const pf = preflight(analysis, 'registered');
  if (!analysis.ok || pf.status === 'block') throw new Error(`the bundled case ${CHECK_CASE} did not pass the pre-flight check`);
  const readiness = aiReadiness(analysis, pf, { masker: createMasker(crypto.getRandomValues(new Uint8Array(32))) });
  if (!readiness.ready || !readiness.built) throw new Error(`the bundled case ${CHECK_CASE} is not ready for the AI step`);
  return readiness.built.payload;
}

export interface LlmCheckReport {
  provider: CheckableProvider;
  /** The model asked for. */
  model: string;
  payloadBytes: number;
  masking: boolean;
  /** The call's own outcome. */
  result?: Pick<CompleteResult, 'model' | 'latencyMs' | 'usage' | 'costUsd'> & { truncated: boolean };
  /** SPEC 9.2 layers 1-7 found nothing (null: no answer to check). */
  verified: boolean | null;
  /** How many of each problem kind the checks found (kinds only - the messages hold the masked payload's words). */
  problems: Partial<Record<RepairProblem['kind'], number>>;
  error?: { kind: string; unavailable?: string; status?: number; type?: string; message: string };
}

/** The provider error's own diagnostics (status, type, message) without the request, for a 400 "unsupported parameter" and the like. */
function errorOf(err: unknown, secrets: readonly (string | undefined)[]): NonNullable<LlmCheckReport['error']> {
  if (!(err instanceof LlmError)) return { kind: 'unexpected', message: redactKeys(err instanceof Error ? err.message : String(err), secrets) };
  const cause = err.cause as { status?: unknown; type?: unknown; error?: { error?: { type?: unknown; message?: unknown }; type?: unknown; message?: unknown; param?: unknown; code?: unknown }; message?: unknown } | undefined;
  const status = typeof cause?.status === 'number' ? cause.status : undefined;
  const body = cause?.error;
  const type = [body?.error?.type, body?.type, cause?.type, body?.code].find((t): t is string => typeof t === 'string');
  // A 401 / 403 message can quote part of the key: only our own text then. Otherwise the provider's message says what was wrong.
  const providerMessage = [body?.error?.message, body?.message, cause?.message].find((m): m is string => typeof m === 'string');
  const param = typeof body?.param === 'string' ? ` (param: ${body.param})` : '';
  const message = err.unavailable === 'auth' || !providerMessage ? err.message : `${err.message}: ${providerMessage}${param}`;
  return { kind: err.kind, ...(err.unavailable ? { unavailable: err.unavailable } : {}), ...(status ? { status } : {}), ...(type ? { type } : {}), message: redactKeys(message, secrets) };
}

/**
 * Makes the one call and runs the API's checks on the answer. Never throws for a provider failure: it is in the report. `provider` is for
 * tests (a mocked client); by default the named provider is built with the SDK's own retries off and a 2-minute limit, so the check shows
 * the provider as it is and does not hang.
 */
export async function runLlmCheck(env: Env, args: LlmCheckArgs, payload: LearnPayload, provider?: LlmProvider): Promise<LlmCheckReport> {
  const model = checkModelOf(env, args);
  const prompt = learnPromptOf();
  const schema = learnResultWireJsonSchema();
  const secrets = [env.ANTHROPIC_API_KEY, env.OPENAI_API_KEY];
  const base = { provider: args.provider, model, payloadBytes: new TextEncoder().encode(JSON.stringify(payload)).length, masking: payload.masking };
  provider ??= createProvider(env, args.provider, { timeoutMs: 120_000, maxRetries: 0 });
  let result: CompleteResult;
  try {
    result = await provider.complete({
      system: prompt.system,
      content: [{ text: JSON.stringify(payload), cache: true }],
      schema,
      model,
      purpose: args.slot === 'escalation' ? 'escalation' : 'learn',
    });
  } catch (err) {
    return { ...base, verified: null, problems: {}, error: errorOf(err, secrets) };
  }
  const served = { model: result.model, latencyMs: result.latencyMs, usage: result.usage, costUsd: result.costUsd, truncated: result.truncated === true };
  if (result.truncated) return { ...base, result: served, verified: null, problems: { truncated: 1 } };
  const checked = runChecks(result.json, payload, { tier: 'registered' });
  const problems: LlmCheckReport['problems'] = {};
  for (const p of checked.problems) problems[p.kind] = (problems[p.kind] ?? 0) + 1;
  return { ...base, result: served, verified: checked.problems.length === 0, problems };
}

/** The lines printed for a report (no payload, no answer text, no key). */
export function formatLlmCheckReport(r: LlmCheckReport): string {
  const lines = [`llm-check: ${r.provider}, model ${r.model} (case ${CHECK_CASE}, masking ${r.masking ? 'on' : 'off'}, payload ${r.payloadBytes} bytes)`];
  if (r.result) {
    const u = r.result.usage;
    lines.push(
      `  served by:  ${r.result.model}`,
      `  latency:    ${(r.result.latencyMs / 1000).toFixed(1)} s`,
      `  tokens:     ${u.tokensIn} in, ${u.tokensOut} out, ${u.tokensCachedRead} cache read, ${u.tokensCachedWrite} cache write`,
      `  cost:       $${r.result.costUsd.toFixed(5)} (configured prices)`,
      `  truncated:  ${r.result.truncated ? 'YES - cut off at the output limit' : 'no'}`,
    );
  }
  const kinds = Object.entries(r.problems).map(([k, n]) => `${k} ${n}`).join(', ');
  lines.push(`  verified:   ${r.verified === null ? 'n/a (no whole answer)' : r.verified ? 'yes - passed the API checks' : `no - problems: ${kinds}`}`);
  if (r.error) {
    const e = r.error;
    lines.push(`  error:      ${e.kind}${e.unavailable ? ` (unavailable: ${e.unavailable})` : ''}${e.status ? `, HTTP ${e.status}` : ''}${e.type ? `, ${e.type}` : ''}`, `              ${e.message}`);
  }
  return lines.join('\n');
}

async function main(): Promise<number> {
  const parsed = parseLlmCheckArgs(process.argv.slice(2));
  if (!parsed.ok) {
    (parsed.help ? console.log : console.error)(parsed.message);
    return parsed.help ? 0 : 2;
  }
  const env = loadEnv();
  const keyName = KEY_NAMES[parsed.args.provider];
  if (!env[keyName]) {
    console.error(`llm-check: ${keyName} is not set (in the environment or the repository's .env) - nothing was called`);
    return 2;
  }
  const report = await runLlmCheck(env, parsed.args, await buildCheckPayload());
  console.log(formatLlmCheckReport(report));
  return report.verified ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().then(
    (code) => process.exit(code),
    (err: unknown) => {
      console.error(`llm-check failed: ${redactKeys(err instanceof Error ? err.message : String(err), [process.env.ANTHROPIC_API_KEY, process.env.OPENAI_API_KEY])}`);
      process.exit(2);
    },
  );
}

