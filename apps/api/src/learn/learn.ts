// SPEC 9.1-9.4, LEARN_PROMPT §1: the learn/repair/escalation call sequence for one
// learn. Every call is a single stateless request (no chat history) - see
// `apps/api/src/llm`'s `complete()`, the one function every call goes through
// (SPEC 9.6).
import { formulaRulesToWire } from '@formatai/engine';
import {
  emptyEstimate,
  estimateCall,
  LEARN_SYSTEM_PROMPT_V7,
  learnResultWireJsonSchema,
  limits,
  promptVersion,
  REPAIR_INSTRUCTION,
  toWire,
  withRows,
  type LearnPayload,
  type LearnResult,
  type PayloadCell,
  type RepairBlock,
  type RepairProblem,
  type Sample,
  type Tier,
  type TokenEstimate,
} from '@formatai/shared';
import { loadEnv, type Env } from '../env.js';
import {
  complete as defaultComplete,
  LlmError,
  resolveModel,
  type CallPurpose,
  type CompleteRequest,
  type CompleteResult,
  type ContentBlock,
} from '../llm/index.js';
import { runChecks } from './checks.js';

export type { CallPurpose } from '../llm/index.js';

/** The shape of `apps/api/src/llm`'s `complete()` (SPEC 9.6's one LLM interface). */
export type CompleteFn = (req: CompleteRequest, env?: Env) => Promise<CompleteResult>;

/** One `llm_calls` ledger entry (SPEC 13), minus the fields only the caller of
 * `learn`/`repairFromBrowser` can supply (ts, userId/anonId, learnId, cacheHit - it
 * knows the request's identity and DB; this module only knows the call itself). */
export interface LlmCallRecord {
  purpose: CallPurpose;
  model: string;
  promptVersion: string;
  masking: boolean;
  tokensIn: number;
  tokensOut: number;
  /** SPEC 13 `llm_calls.tokensCached`: DECISION - the ledger has one combined field
   * where the provider layer tracks read/write separately (`LlmUsage`); summed here,
   * since both represent cache-related token volume for cost purposes. */
  tokensCached: number;
  costUsd: number;
  /** OUR OWN token count for this call (the learning-loop proposal, section 4), priced with the providers' published
   * prices - NOT the provider-reported fields above, which for the dev CLI include Claude Code's own overhead and thinking
   * tokens. Counts and a price only, never any text. See `@formatai/shared`'s `tokenEstimate`. */
  estimate: TokenEstimate;
  latencyMs: number;
  /** 'verified' (zero problems), 'needsRepair' (some problems, rules still returned),
   * or 'error:<LlmErrorKind>' (the call itself failed - SPEC 15: never the payload). */
  outcome: string;
  /** How many of each `RepairProblem` kind this one call's attempt produced - COUNTS
   * ONLY, never formula text or any other payload/response content (SPEC 15), so the
   * product can track things like "how often models write invalid formulas" from the
   * ledger alone. See `eval/lib`'s report for the human-readable version (which also
   * has the actual messages, via `LearnOptions.onAttempt` - a dev-only path this ledger
   * record deliberately doesn't carry). */
  problemCounts: Record<RepairProblem['kind'], number>;
}

/** Every `RepairProblem` kind, for `problemCounts` (SPEC 15: counts only, never text). */
const REPAIR_PROBLEM_KINDS = ['formula', 'schema', 'reference', 'type', 'limit', 'formatMismatch', 'fixedMismatch', 'diff', 'rowCount', 'layout', 'unsupportedDespiteEvidence'] as const;

export function countProblems(problems: readonly RepairProblem[]): Record<RepairProblem['kind'], number> {
  const counts = Object.fromEntries(REPAIR_PROBLEM_KINDS.map((k) => [k, 0])) as Record<RepairProblem['kind'], number>;
  for (const p of problems) counts[p.kind] += 1;
  return counts;
}

export interface LearnOptions {
  tier: Tier;
  env?: Env;
  /** Cooperative cancellation only: checked between rounds. `complete()`/the provider
   * SDKs have no abort-signal parameter to forward it into (SPEC 9.6's one interface
   * doesn't expose one), so a call already in flight always finishes. */
  signal?: AbortSignal;
  /** Dependency injection for tests, matching the pattern the provider adapters
   * themselves use (`createAnthropicProvider({ client })` etc.): overrides
   * `apps/api/src/llm`'s `complete()`. Defaults to the real one, which resolves the
   * provider from `env`/`LLM_PROVIDER` as usual (SPEC 9.6). */
  complete?: CompleteFn;
  /**
   * SPEC 10 (the eval harness): force specific models for this run, bypassing
   * `resolveModel(env, ...)` / `config/models.ts`. Lets the runner benchmark a
   * candidate model (`--models a,b`) without an env var per run; the provider itself
   * is still selected the normal way (via `env.LLM_PROVIDER`, e.g.
   * `{ ...loadEnv(), LLM_PROVIDER: 'anthropic' }` - no separate `provider` option is
   * needed since `env` already carries it).
   */
  models?: { firstTry: string; escalation: string };
  /** SPEC 10 `--no-escalation`: skip the escalation attempt entirely (the first-try
   * model and its server repair round(s) still run) for a cheaper/faster eval pass. */
  noEscalation?: boolean;
  /**
   * Dev-only observability hook, called once per LLM call made during this learn, with
   * that call's FULL `RepairProblem` list (with messages - unlike `LlmCallRecord.
   * problemCounts`, which is counts-only because it's the production ledger, SPEC 15).
   * Never persisted by this module; `eval/lib/runner.ts` uses it to report "top formula
   * error messages" (syntax messages only, no user data) without adding message text to
   * the ledger.
   */
  onAttempt?: (problems: readonly RepairProblem[]) => void;
}

export interface LearnOutcome {
  rules: LearnResult | null;
  /** True once an attempt passed every SPEC 9.2 check (layers 1-7) with zero
   * problems - NOT SPEC 9.2 layer 8 (full verification), which only the browser can
   * do, since it alone holds the full real file (SPEC 2). */
  verified: boolean;
  problems: RepairProblem[];
  calls: LlmCallRecord[];
}

interface Attempt {
  raw: unknown;
  problems: RepairProblem[];
  rules: LearnResult | null;
}

function payloadBlock(payload: LearnPayload): ContentBlock {
  // LEARN_PROMPT §1: "serialized compactly with no pretty-printing."
  return { text: JSON.stringify(payload), cache: true };
}

/** The models whose cached prefix (system prompt + schema) this learn has already written: the first call on a model writes it,
 * every later call on that model reads it. A different model (the escalation) writes its own. */
type PrefixCache = Set<string>;

function outcomeOf(problems: RepairProblem[]): string {
  return problems.length === 0 ? 'verified' : 'needsRepair';
}

/**
 * Makes one `complete()` call, runs it through `runChecks`, and returns both the
 * `LlmCallRecord` (for the ledger) and the `Attempt` (for the best-of-N selection in
 * `learn`). Never throws for a normal (schema-following-or-not) LLM response; an
 * `LlmError` from the provider (timeout, rate limit, refusal, ...) is caught, turned
 * into a zero-usage call record with `outcome: "error:<kind>"`, and a synthetic
 * `schema`-kind problem (the closest existing `RepairProblem` kind to "the call
 * itself failed" - SPEC 15: the message is the provider's own diagnostic text, never
 * payload content).
 */
async function callAndCheck(
  completeFn: CompleteFn,
  env: Env,
  purpose: CallPurpose,
  model: string,
  content: ContentBlock[],
  payload: LearnPayload,
  tier: Tier,
  prefixCache: PrefixCache,
  rows: readonly Sample[] = [],
): Promise<{ record: LlmCallRecord; attempt: Attempt }> {
  const schema = learnResultWireJsonSchema();

  try {
    const result = await completeFn({ system: LEARN_SYSTEM_PROMPT_V7, content, schema, model, purpose }, env);
    // The learning loop: checked on the samples plus every row the browser sent (`withRows`); a problem on one of those rows names the row.
    const checked = runChecks(result.json, withRows(payload, rows), { tier });
    const problems = rowsNamed(checked.problems, payload, rows);
    const { rules } = checked;
    // The estimate counts the exact text sent (system prompt, schema, every content block) and received (the raw answer).
    const estimate = estimateCall(
      result.model,
      { prefix: [LEARN_SYSTEM_PROMPT_V7, JSON.stringify(schema)], blocks: content.map((b) => b.text), answer: result.raw },
      prefixCache.has(model),
    );
    prefixCache.add(model);
    const record: LlmCallRecord = {
      purpose,
      model: result.model,
      promptVersion,
      masking: payload.masking,
      tokensIn: result.usage.tokensIn,
      tokensOut: result.usage.tokensOut,
      tokensCached: result.usage.tokensCachedRead + result.usage.tokensCachedWrite,
      costUsd: result.costUsd,
      estimate,
      latencyMs: result.latencyMs,
      outcome: outcomeOf(problems),
      problemCounts: countProblems(problems),
    };
    return { record, attempt: { raw: result.json, problems, rules } };
  } catch (err) {
    const kind = err instanceof LlmError ? err.kind : 'providerError';
    const message = err instanceof Error ? err.message : 'unknown LLM error';
    const attempt: Attempt = {
      raw: null,
      rules: null,
      problems: [{ kind: 'schema', path: '', message: `LLM call failed: ${message}` }],
    };
    const record: LlmCallRecord = {
      purpose,
      model,
      promptVersion,
      masking: payload.masking,
      tokensIn: 0,
      tokensOut: 0,
      tokensCached: 0,
      costUsd: 0,
      // DECISION: a failed call counts nothing (like the provider fields above), and does not write the cached prefix.
      estimate: emptyEstimate(model),
      latencyMs: 0,
      outcome: `error:${kind}`,
      problemCounts: countProblems(attempt.problems),
    };
    return { record, attempt };
  }
}

/** Builds the repair call's second content block (LEARN_PROMPT §4): `previousRules`
 * in WIRE form (the same notation the model itself writes), plus the problems found,
 * plus the fix-only instruction appended to the same block so the system prompt -
 * and its cache breakpoint - never changes. */
function repairContentBlock(previous: Attempt, problems: RepairProblem[]): ContentBlock {
  const repairBlock: RepairBlock<unknown> = {
    mode: 'repair',
    // `previous.rules` is null only when layer 0/1 (formula text / structure) itself
    // failed - there is then no valid Expr-tree object to print formulas from, so the
    // model's own raw output (already wire-shaped, since that's what the schema
    // constrained it to) is sent back as-is. Otherwise: print every Expr position back
    // to formula text (learn-v5) before the usual pairs conversion, so `previousRules`
    // is in exactly the notation the model itself writes.
    // `toWire`'s type is nominally `LearnResult`-only, but its runtime behavior (moving
    // valueMaps/expand/summaryRows between records and {key,value} pairs) never touches
    // Expr internals - so it works identically on the formula-wire shape too. Structural
    // cast, not a runtime one: `formulaRulesToWire`'s own return type already documents
    // exactly what changed (every Expr position is now a `string`).
    previousRules: previous.rules ? toWire(formulaRulesToWire(previous.rules) as unknown as LearnResult) : previous.raw,
    problems,
  };
  return { text: `${JSON.stringify(repairBlock)}\n${REPAIR_INSTRUCTION}` };
}

/**
 * The learning loop: a `diff` problem the sample run found on one of the browser's rows points at a sample index the model never saw (its
 * payload block is the first payload, so the cached prefix still hits). It is told the row itself instead, the way the browser tells it
 * (LEARN_PROMPT §4: `row`); a row the rules make where none is expected carries the input row and no output row.
 */
function rowsNamed(problems: RepairProblem[], payload: LearnPayload, rows: readonly Sample[]): RepairProblem[] {
  if (rows.length === 0) return problems;
  const first = payload.samples.length;
  return problems.map((p) => {
    if (p.kind !== 'diff' || p.sample === undefined || p.sample < first) return p;
    const row = rows[p.sample - first];
    if (!row) return p;
    const outRows = row.out.length > 0 && !Array.isArray(row.out[0]) ? [row.out as PayloadCell[]] : (row.out as PayloadCell[][]);
    const { sample: _sample, familyRow, ...rest } = p;
    return { ...rest, row: { in: row.in, out: outRows[familyRow ?? 0] ?? [] } };
  });
}

function bestOf(attempts: Attempt[]): Attempt {
  let best = attempts[0]!;
  for (const a of attempts) {
    if (a.problems.length < best.problems.length) best = a;
  }
  return best;
}

/** What a call sequence needs to make one more call: the provider, the model and what it was sent, the checks' inputs and the ledger. */
interface CallContext {
  completeFn: CompleteFn;
  env: Env;
  model: string;
  block: ContentBlock;
  payload: LearnPayload;
  tier: Tier;
  prefixCache: PrefixCache;
  /** The learning loop's rows (a browser round): the answers are checked on them too. */
  rows: readonly Sample[];
  calls: LlmCallRecord[];
  attempts: Attempt[];
  opts: LearnOptions;
}

/** SPEC 9.3: while `current` has problems, up to `limits.llm.serverRepairRounds` repair calls on the same model, each repairing the one before. */
async function serverRepairs(ctx: CallContext, start: Attempt): Promise<Attempt> {
  let current = start;
  for (let round = 0; round < limits.llm.serverRepairRounds && current.problems.length > 0; round++) {
    if (ctx.opts.signal?.aborted) break;
    const repair = await callAndCheck(
      ctx.completeFn,
      ctx.env,
      'repair',
      ctx.model,
      [ctx.block, repairContentBlock(current, current.problems)],
      ctx.payload,
      ctx.tier,
      ctx.prefixCache,
      ctx.rows,
    );
    ctx.calls.push(repair.record);
    ctx.attempts.push(repair.attempt);
    ctx.opts.onAttempt?.(repair.attempt.problems);
    current = repair.attempt;
  }
  return current;
}

function outcomeOfAttempts(attempts: Attempt[], calls: LlmCallRecord[]): LearnOutcome {
  const best = bestOf(attempts);
  return {
    rules: best.rules,
    verified: best.rules !== null && best.problems.length === 0,
    problems: best.problems,
    calls,
  };
}

/**
 * SPEC 5 A step 5, 9.1-9.4: one learn action, from the first-try model through its
 * server repair round(s) to the escalation model.
 *
 * Flow:
 * 1. One stateless learn call with the first-try model.
 * 2. While problems remain, up to `limits.llm.serverRepairRounds` repair calls with
 *    the SAME model (each one repairing the immediately preceding attempt).
 * 3. If problems still remain, one fresh learn call (no repair block) with the
 *    escalation model. DECISION (SPEC 9.4 + this milestone's build note): the
 *    escalation attempt gets no repair round of its own, however many
 *    `serverRepairRounds` are configured - "then no further repair."
 * 4. Returns the attempt with the fewest problems across every call made (ties keep
 *    the earliest attempt), not necessarily the last one tried.
 */
export async function learn(payload: LearnPayload, opts: LearnOptions): Promise<LearnOutcome> {
  const env = opts.env ?? loadEnv();
  const completeFn = opts.complete ?? defaultComplete;
  const block = payloadBlock(payload);
  const firstTryModel = opts.models?.firstTry ?? resolveModel(env, 'firstTry');
  const ctx: CallContext = { completeFn, env, model: firstTryModel, block, payload, tier: opts.tier, prefixCache: new Set(), rows: [], calls: [], attempts: [], opts };

  const first = await callAndCheck(completeFn, env, 'learn', firstTryModel, [block], payload, opts.tier, ctx.prefixCache);
  ctx.calls.push(first.record);
  ctx.attempts.push(first.attempt);
  opts.onAttempt?.(first.attempt.problems);

  const current = await serverRepairs(ctx, first.attempt);

  if (current.problems.length > 0 && !opts.signal?.aborted && !opts.noEscalation) {
    const escalationModel = opts.models?.escalation ?? resolveModel(env, 'escalation');
    const escalated = await callAndCheck(completeFn, env, 'escalation', escalationModel, [block], payload, opts.tier, ctx.prefixCache);
    ctx.calls.push(escalated.record);
    ctx.attempts.push(escalated.attempt);
    opts.onAttempt?.(escalated.attempt.problems);
  }

  return outcomeOfAttempts(ctx.attempts, ctx.calls);
}

/** `repairFromBrowser`'s options: a learn's, plus the learning loop's rows. */
export interface RepairOptions extends LearnOptions {
  /** Every row of the example the browser sent so far, this round's included, masked like the samples (`RepairRequest.rows`). */
  rows?: readonly Sample[];
}

/**
 * SPEC 5 A step 6, 9.3: one round of the learning loop - a browser-triggered repair call after the browser's own full verification
 * found rows the rules get wrong. The caller (the route, with its round counter per learnId) makes sure there are never more than
 * `limits.llm.browserRepairCalls` of them per learn. `previousRules` is the rules the browser has, in the answer's own vocabulary
 * (masked when masking is on) - converted to wire form here, same as every other repair call.
 *
 * Like the learn call, the round gets `limits.llm.serverRepairRounds` repair calls of its own for what the server's checks find (a
 * formula error, a type error, a row still wrong ...), on the same model; no escalation (DECISION: the escalation model is the first
 * call's fallback, not a round's). Every answer is checked on the samples PLUS every row the browser sent (`opts.rows`), so a later round
 * cannot break a row an earlier one fixed. Returns the best of the round's attempts (the fewest problems; ties keep the earliest).
 */
export async function repairFromBrowser(
  payload: LearnPayload,
  previousRules: LearnResult,
  problems: RepairProblem[],
  opts: RepairOptions,
): Promise<LearnOutcome> {
  const env = opts.env ?? loadEnv();
  const completeFn = opts.complete ?? defaultComplete;
  const block = payloadBlock(payload);
  const previous: Attempt = { raw: null, rules: previousRules, problems };
  const model = opts.models?.firstTry ?? resolveModel(env, 'firstTry');
  // DECISION: this call always comes after the learn's own first call on the same model, so the cached prefix is already there.
  const ctx: CallContext = { completeFn, env, model, block, payload, tier: opts.tier, prefixCache: new Set([model]), rows: opts.rows ?? [], calls: [], attempts: [], opts };

  const first = await callAndCheck(completeFn, env, 'repair', model, [block, repairContentBlock(previous, problems)], payload, opts.tier, ctx.prefixCache, ctx.rows);
  ctx.calls.push(first.record);
  ctx.attempts.push(first.attempt);
  opts.onAttempt?.(first.attempt.problems);

  await serverRepairs(ctx, first.attempt);
  return outcomeOfAttempts(ctx.attempts, ctx.calls);
}
