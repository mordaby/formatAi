// SPEC 9.6 "Fallback" (owner request 2026-10-05): when the primary provider (`LLM_PROVIDER`, Anthropic in production) cannot serve a call,
// the SAME request - same purpose, same system prompt, same content blocks, same schema - is made once more, at once, on the fallback
// provider (`LLM_FALLBACK_PROVIDER`), in the same slot: a first-try call (a learn or a repair) on the fallback's first-try model, an
// escalation on its escalation model. The learn itself does not know: its checks, repairs, quota and ledger run as for any call, and the
// result says which provider and model answered (`CompleteResult.fallback`).
//
// When a call fails over: a provider-level failure, i.e. an `LlmError` whose adapter set `unavailable` - a network error, a timeout, HTTP 429,
// 5xx, Anthropic's overloaded error (529), and 401 / 403. Never on a wrong answer (the checks' problems go through repair as before), a
// cut-off answer (`truncated`: repair), a refusal or invalid JSON (the provider answered), or a 400 invalid request (our bug: it fails
// loudly, here and on the fallback alike).
//
// DECISION (401 / 403, a bad or revoked key): fail over AND log an error on every such failure. A misconfigured primary key is the owner's
// to fix, but it should not take the product down meanwhile; the circuit breaker below then keeps the calls on the fallback, so the log line
// comes back once per cool-down until the key is fixed.
//
// The circuit breaker: after `limits.llm.fallback.tripAfter` consecutive primary failures (each within `windowMs` of the latest), every call
// goes straight to the fallback for `coolDownMs` (recorded with reason `circuitOpen`); then the primary is tried again, and one more failure
// trips it again at once. Any answer from the primary - a whole one, a cut-off one, a refusal, a 400 - shows it is up and resets the count.
// In memory: the service runs one instance (`render.yaml`), and a restart simply starts closed.
import { limits, type LlmProviderName } from '@formatai/shared';
import type { Env } from '../env.js';
import { LlmError, type CallFallback, type FallbackReason } from './errors.js';
import { createProvider, resolveFallbackModel, type ModelPurpose } from './registry.js';
import type { CallPurpose, CompleteRequest, CompleteResult, LlmProvider } from './types.js';

/** The model slot of a call: an escalation is the escalation slot; a learn or a repair call (always on the first-try model) the first-try. */
export function slotOf(purpose: CallPurpose): ModelPurpose {
  return purpose === 'escalation' ? 'escalation' : 'firstTry';
}

export interface CircuitBreakerOptions {
  tripAfter: number;
  windowMs: number;
  coolDownMs: number;
  /** The clock (tests). */
  now?: () => number;
}

export interface CircuitBreaker {
  /** True while tripped: the call goes straight to the fallback. The first check after the cool-down closes it again (the next call probes). */
  isOpen(): boolean;
  /** A primary failure that failed over; returns true when this one tripped the breaker. */
  recordFailure(): boolean;
  /** The primary answered (whatever the answer): the failure count starts again. */
  recordSuccess(): void;
}

export function createCircuitBreaker(opts: CircuitBreakerOptions): CircuitBreaker {
  const now = opts.now ?? Date.now;
  let failures: number[] = [];
  let openUntil: number | null = null;
  // After a cool-down the primary is on probation: its next failure trips the breaker again without waiting for `tripAfter` more.
  let probing = false;

  const trip = (t: number): void => {
    openUntil = t + opts.coolDownMs;
    failures = [];
    probing = false;
  };

  return {
    isOpen() {
      if (openUntil === null) return false;
      if (now() < openUntil) return true;
      openUntil = null;
      probing = true;
      return false;
    },
    recordFailure() {
      const t = now();
      if (probing) {
        trip(t);
        return true;
      }
      failures = failures.filter((f) => t - f <= opts.windowMs);
      failures.push(t);
      if (failures.length >= opts.tripAfter) {
        trip(t);
        return true;
      }
      return false;
    },
    recordSuccess() {
      failures = [];
      probing = false;
    },
  };
}

export interface FallbackTarget {
  name: LlmProviderName;
  /** Built only when a call needs it, so a primary that works never needs the fallback's key at hand (a developer's machine). */
  create: () => LlmProvider;
  /** The fallback's model for a slot. */
  model: (slot: ModelPurpose) => string;
}

export interface FallbackDeps {
  primary: LlmProvider;
  /** Null when no fallback is configured: the primary's error is the call's. */
  fallback: FallbackTarget | null;
  breaker: CircuitBreaker;
  /** Where the fail-over lines go (default: the console). Names, reasons and model ids only - never a payload or a key (SPEC 15). */
  log?: Pick<Console, 'warn' | 'error'>;
}

/**
 * One call through the primary, failing over to the fallback as described above. Throws the primary's error when it is not a fail-over
 * trigger (or no fallback is configured), and the fallback's when the fallback fails too - marked with `fallback` and the fallback's
 * `model`, so the ledger records which provider was tried last.
 */
export async function completeWithFallback(req: CompleteRequest, deps: FallbackDeps): Promise<CompleteResult> {
  const { primary, fallback, breaker } = deps;
  const log = deps.log ?? console;
  if (!fallback) return primary.complete(req);

  if (breaker.isOpen()) return callFallback(req, primary.name, fallback, 'circuitOpen');

  try {
    const result = await primary.complete(req);
    breaker.recordSuccess();
    return result;
  } catch (err) {
    if (!(err instanceof LlmError)) throw err; // a bug of ours, not the provider's state
    if (!err.unavailable) {
      // The provider answered (a refusal, invalid JSON, a 400 ...): it is up, and the error is the request's or the answer's.
      breaker.recordSuccess();
      throw err;
    }
    const tripped = breaker.recordFailure();
    if (err.unavailable === 'auth') {
      log.error(
        `[llm] ${primary.name} refused the API key (${err.message}); this call and the next ones go to ${fallback.name} - fix the ${primary.name} key`,
      );
    } else {
      log.warn(`[llm] ${primary.name} unavailable (${err.unavailable}) for a ${req.purpose} call; failing over to ${fallback.name}`);
    }
    if (tripped) {
      log.warn(
        `[llm] ${limits.llm.fallback.tripAfter}+ ${primary.name} failures in a row: calls go straight to ${fallback.name} for ${Math.round(limits.llm.fallback.coolDownMs / 1000)} s`,
      );
    }
    return callFallback(req, primary.name, fallback, err.unavailable);
  }
}

async function callFallback(req: CompleteRequest, from: LlmProviderName, target: FallbackTarget, reason: FallbackReason): Promise<CompleteResult> {
  const model = target.model(slotOf(req.purpose));
  const fallback: CallFallback = { from, reason };
  try {
    const result = await target.create().complete({ ...req, model });
    return { ...result, fallback };
  } catch (err) {
    const e = err instanceof LlmError ? err : new LlmError('providerError', target.name, `the fallback provider ${target.name} failed unexpectedly`, { cause: err });
    const why = reason === 'circuitOpen' ? `${from}'s circuit is open` : `${from} was unavailable: ${reason}`;
    throw new LlmError(e.kind, e.provider, `${e.message} (on the fallback; ${why})`, {
      cause: e,
      ...(e.unavailable ? { unavailable: e.unavailable } : {}),
      model,
      fallback,
    });
  }
}

/** One breaker per primary provider, for the life of the process (one instance: `render.yaml`). */
const breakers = new Map<LlmProviderName, CircuitBreaker>();

export function breakerFor(primary: LlmProviderName): CircuitBreaker {
  let breaker = breakers.get(primary);
  if (!breaker) {
    const { tripAfter, windowMs, coolDownMs } = limits.llm.fallback;
    breaker = createCircuitBreaker({ tripAfter, windowMs, coolDownMs });
    breakers.set(primary, breaker);
  }
  return breaker;
}

/** Test-only: forgets every breaker's state. */
export function resetCircuitBreakers(): void {
  breakers.clear();
}

/**
 * The fallback wiring for `env`, or null when `LLM_FALLBACK_PROVIDER` is unset. The primary of a call that has a fallback gets the shorter
 * SDK timeout and fewer retries of `limits.llm.fallback` (see there): the fallback is what follows a failure, not a ten-minute wait.
 */
export function fallbackDepsOf(env: Env): FallbackDeps {
  const name = env.LLM_FALLBACK_PROVIDER;
  if (!name) return { primary: createProvider(env), fallback: null, breaker: breakerFor(env.LLM_PROVIDER) };
  const { primaryTimeoutMs, primaryMaxRetries } = limits.llm.fallback;
  return {
    primary: createProvider(env, env.LLM_PROVIDER, { timeoutMs: primaryTimeoutMs, maxRetries: primaryMaxRetries }),
    fallback: { name, create: () => createProvider(env, name), model: (slot) => resolveFallbackModel(env, slot)! },
    breaker: breakerFor(env.LLM_PROVIDER),
  };
}
