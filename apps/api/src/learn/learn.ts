// SPEC 9.1-9.4, LEARN_PROMPT §1: the learn/repair/escalation call sequence for one
// learn. Every call is a single stateless request (no chat history) - see
// `apps/api/src/llm`'s `complete()`, the one function every call goes through
// (SPEC 9.6).
//
// AI code checks (learn-v9, docs/proposals/ai-code-checks.md; SPEC 21 v14): the first call of a learn - and of each step, which carries
// every round so far - may answer with CHECKS instead of the rules. `learn()` then returns them (validated, capped: `acceptChecks`) with no
// rules and no repair; the browser answers them on every row and calls again (`POST /api/learn/step`, `rounds`). The content blocks of a
// step: the payload (cached), then one block per round - what the AI step asked and what code answered - the newest one cached too, so the
// next step reads all of it from the cache; after the last allowed round one more block says "answer with the rules now". Every call of a
// learn-v9 learn is sent the one step schema (`{ checks, rules }`), so the provider's cached prefix holds across them; a call that must
// answer with the rules (the last round, a repair, the escalation) and asks checks anyway has a schema problem, and the repair round
// answers with the rules. From the rules on, everything is as before (the checks, repair, escalation - which gets the rounds too).
import { formulaRulesToWire } from '@formatai/engine';
import {
  acceptChecks,
  emptyEstimate,
  estimateCall,
  learnPromptOf,
  learnResultWireJsonSchema,
  learnStepWireJsonSchema,
  limits,
  REPAIR_INSTRUCTION_V7,
  RULES_NOW_INSTRUCTION_V9,
  splitStepAnswer,
  toWire,
  withRows,
  type Check,
  type CheckRound,
  type LearnAlternative,
  type LearnPayload,
  type LearnPrompt,
  type PromptVersion,
  type LearnResult,
  type LlmProviderName,
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
  type CallFallback,
  type CallPurpose,
  type CompleteRequest,
  type CompleteResult,
  type ContentBlock,
  type FallbackReason,
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
  /** The model that answered (or, for a failed call, the one that was tried last: the fallback's when it was tried). */
  model: string;
  /** The provider that answered (or was tried last), SPEC 9.6. */
  provider: LlmProviderName;
  /** SPEC 9.6 "Fallback": the call was made on the fallback provider, because the primary could not serve it (`fallbackReason`). */
  fallback?: true;
  /** Why: the primary's failure (`UnavailableReason`), or `circuitOpen` (the primary was not tried). Set with `fallback`. */
  fallbackReason?: FallbackReason;
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
   * 'truncated' (the answer was cut off at the output-token limit: prompt audit X2; usage and cost are the call's own),
   * or 'error:<LlmErrorKind>' (the call itself failed - SPEC 15: never the payload). */
  outcome: string;
  /** How many of each `RepairProblem` kind this one call's attempt produced - COUNTS
   * ONLY, never formula text or any other payload/response content (SPEC 15), so the
   * product can track things like "how often models write invalid formulas" from the
   * ledger alone. See `eval/lib`'s report for the human-readable version (which also
   * has the actual messages, via `LearnOptions.onAttempt` - a dev-only path this ledger
   * record deliberately doesn't carry). learn-v8: `invalidAlternative` counts the
   * alternatives the answer gave that were dropped (`runChecks`; never a repair problem); `overfitFallback` the columns code
   * reported as unsupported because their rule copied rows (SPEC 9.2 layer 6; never a repair problem either). */
  problemCounts: ProblemCounts;
  /** A `check` call (learn-v9): the checks the answer asked that the API kept, and the ones it dropped. Counts only; absent on any other call. */
  checks?: { asked: number; dropped: number };
}

/** Every `RepairProblem` kind, for `problemCounts` (SPEC 15: counts only, never text). */
const REPAIR_PROBLEM_KINDS = ['formula', 'schema', 'reference', 'type', 'limit', 'formatMismatch', 'fixedMismatch', 'diff', 'rowCount', 'layout', 'unsupportedDespiteEvidence', 'truncated', 'overfit', 'list'] as const;

/** Prompt audit X2: the problem of an answer cut off at the output-token limit (no payload text: SPEC 15). */
const TRUNCATED_PROBLEM: RepairProblem = {
  kind: 'truncated',
  message: 'The previous answer was cut off at the output limit before it was complete, so none of it could be read: write the whole answer again, shorter.',
};

/**
 * The ledger's per-call counts: each `RepairProblem` kind, plus the answer's dropped alternatives (learn-v8) and the output columns code
 * reported as unsupported because their rule still copied rows of the example after the learn's one repair for it (`overfitFallback`,
 * SPEC 9.2 layer 6 - the `overfit` problems are the findings that asked for that repair).
 */
export type ProblemCounts = Record<RepairProblem['kind'] | 'invalidAlternative' | 'overfitFallback', number>;

export function countProblems(problems: readonly RepairProblem[], invalidAlternatives = 0, overfitFallbacks = 0): ProblemCounts {
  const counts = Object.fromEntries(REPAIR_PROBLEM_KINDS.map((k) => [k, 0])) as ProblemCounts;
  for (const p of problems) counts[p.kind] += 1;
  counts.invalidAlternative = invalidAlternatives;
  counts.overfitFallback = overfitFallbacks;
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
  /** SPEC 10 `--prompt`: send another prompt version than the current one (`promptVersion`), with the wire schema it was written for, so
   * two versions can be compared on the same code. The production routes never set it. */
  prompt?: PromptVersion;
  /**
   * Dev-only observability hook, called once per LLM call made during this learn, with
   * that call's FULL `RepairProblem` list (with messages - unlike `LlmCallRecord.
   * problemCounts`, which is counts-only because it's the production ledger, SPEC 15).
   * Never persisted by this module; `eval/lib/runner.ts` uses it to report "top formula
   * error messages" (syntax messages only, no user data) without adding message text to
   * the ledger.
   */
  onAttempt?: (problems: readonly RepairProblem[]) => void;
  /**
   * The learn already had its one repair for a rule that copies rows of the example (SPEC 9.2 layer 6): an `overfit` problem was sent in an
   * earlier call of it - a server repair, or a loop round (`RepairRequest.overfitRepaired`). Every answer is then checked with `overfit:
   * 'fallBack'`: such a rule is reported as unsupported by code, never sent back again.
   */
  overfitRepaired?: boolean;
  /**
   * AI code checks (learn-v9, `prompt: 'learn-v9'`): every round of checks so far, this step's last - what the AI step asked and what code
   * answered (`POST /api/learn/step`'s `rounds`). Empty or absent: the learn's first call. Ignored by a prompt version without checks.
   */
  rounds?: readonly CheckRound[];
  /**
   * learn-v9: no checks at all - the first call is told to answer with the rules (as after the last round), and checks are a schema problem
   * for its repair round (`LearnRequest.rulesNow`: the browser's fresh learn in a round of the learning loop). Ignored without checks.
   */
  rulesNow?: boolean;
}

export interface LearnOutcome {
  rules: LearnResult | null;
  /**
   * AI code checks (learn-v9): the AI step asked code to check ideas before it answers - `rules` is null, `verified` false, `problems` empty,
   * and no repair was made. Validated and capped (`acceptChecks`). The caller answers them and makes the next step (`rounds`).
   */
  checks?: Check[];
  /** With `checks`: one short line per check the API dropped, for the next round's `dropped`. */
  droppedChecks?: string[];
  /** learn-v8: the alternatives of the kept answer that passed their checks (`runChecks`), in its own vocabulary. Never part of `rules`. */
  alternatives?: LearnAlternative[];
  /** True once an attempt passed every SPEC 9.2 check (layers 1-7) with zero
   * problems - NOT SPEC 9.2 layer 8 (full verification), which only the browser can
   * do, since it alone holds the full real file (SPEC 2). */
  verified: boolean;
  problems: RepairProblem[];
  calls: LlmCallRecord[];
  /** True once this learn had its one repair for a rule that copies rows (it was, or a call of this sequence sent an `overfit` problem). */
  overfitRepaired?: boolean;
}

interface Attempt {
  raw: unknown;
  problems: RepairProblem[];
  rules: LearnResult | null;
  alternatives: LearnAlternative[];
  /** learn-v9: the answer asked these checks (where it may) instead of answering with the rules; `rules` is null. */
  checks?: Check[];
  droppedChecks?: string[];
}

function payloadBlock(payload: LearnPayload): ContentBlock {
  // LEARN_PROMPT §1: "serialized compactly with no pretty-printing."
  return { text: JSON.stringify(payload), cache: true };
}

/**
 * learn-v9: the block of one round of checks, after the payload (LEARN_PROMPT §1, "Checking with code"): `{ round, checks, answers }`, and
 * `dropped` when the API did not run some of what was asked. DECISION: the newest round carries a cache breakpoint as the payload does - the
 * next step sends the same blocks again and one more, so it reads everything up to here from the cache (Anthropic: system, payload and
 * newest round = 3 breakpoints of the 4 allowed; OpenAI caches the longest prefix it has seen, whatever is marked).
 */
function roundBlock(round: CheckRound, n: number, newest: boolean): ContentBlock {
  const block = { round: n, checks: round.checks, answers: round.answers, ...(round.dropped && round.dropped.length > 0 ? { dropped: round.dropped } : {}) };
  return { text: JSON.stringify(block), ...(newest ? { cache: true } : {}) };
}

/** learn-v9: the instruction block of a call that must answer with the rules - after the last round of checks, and the escalation's. */
const RULES_NOW_BLOCK: ContentBlock = { text: RULES_NOW_INSTRUCTION_V9 };

/** learn-v9: the problem of an answer that asked checks where it had to answer with the rules (a schema problem: the repair answers with rules). */
const CHECKS_NOT_NOW: RepairProblem = {
  kind: 'schema',
  path: 'checks',
  message: 'No more checks: answer with the rules ("checks": null, "rules": the rules file).',
};

/** The models whose cached prefix (system prompt + schema) this learn has already written: the first call on a model writes it,
 * every later call on that model reads it. A different model (the escalation) writes its own. */
type PrefixCache = Set<string>;

/** The ledger's fallback fields of a call (SPEC 13): `fallback: true` and the reason, or nothing on a call the primary served. */
function fallbackFields(fallback: CallFallback | undefined): Pick<LlmCallRecord, 'fallback' | 'fallbackReason'> {
  return fallback ? { fallback: true, fallbackReason: fallback.reason } : {};
}

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
 * payload content). An answer cut off at the output-token limit (`CompleteResult.truncated`,
 * prompt audit X2) is neither: the call is recorded with its own usage and `outcome:
 * "truncated"`, and its one problem is a `truncated` one (never checked: nothing of it parses).
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
  prompt: LearnPrompt,
  rows: readonly Sample[] = [],
  overfit: 'repair' | 'fallBack' = 'repair',
  /** learn-v9: this call may answer with checks (the learn's first call or a step's, while rounds are left). */
  checksAllowed = false,
): Promise<{ record: LlmCallRecord; attempt: Attempt }> {
  // learn-v9: one schema for every call of the learn (the cache); any other version, the rules schema it was written for.
  const schema = prompt.checks ? learnStepWireJsonSchema() : learnResultWireJsonSchema({ alternatives: prompt.alternatives });
  const promptVersion = prompt.version;

  try {
    const result = await completeFn({ system: prompt.system, content, schema, model, purpose }, env);
    // learn-v9: the answer unwrapped - its rules are checked as any answer; checks asked where they may be are validated and kept (no rules,
    // no problem); checks where the rules were due, or neither, are a schema problem for the repair round.
    const step = prompt.checks && !result.truncated ? splitStepAnswer(result.json) : null;
    const asked = step?.kind === 'checks' && checksAllowed ? { ...acceptChecks(step.checks), raw: step.checks.length } : null;
    const answer = step === null ? result.json : step.kind === 'rules' ? step.rules : null;
    const noRules = { rules: null, alternatives: [], invalidAlternatives: 0, overfitFallbacks: 0 };
    // The learning loop: checked on the samples plus every row the browser sent (`withRows`); a problem on one of those rows names the row.
    // (A cut-off answer is not checked: there is nothing whole to check.)
    const checked = result.truncated
      ? { problems: [TRUNCATED_PROBLEM], ...noRules }
      : asked
        ? { problems: [], ...noRules }
        : step !== null && step.kind !== 'rules'
          ? { problems: [step.kind === 'checks' ? CHECKS_NOT_NOW : { kind: 'schema' as const, path: '', message: step.message }], ...noRules }
          : runChecks(answer, withRows(payload, rows), { tier, alternatives: prompt.alternatives, overfit });
    const problems = rowsNamed(checked.problems, payload, rows);
    const { rules, alternatives } = checked;
    // The estimate counts the exact text sent (system prompt, schema, every content block) and received (the raw answer), priced as the
    // model that answered (the fallback's own prices on a fallback call). Its cached prefix is that model's: a fallback call writes the
    // fallback model's prefix, never reads the primary's.
    const prefixKey = result.fallback ? `${result.provider}:${result.model}` : model;
    const estimate = estimateCall(
      result.model,
      { prefix: [prompt.system, JSON.stringify(schema)], blocks: content.map((b) => b.text), answer: result.raw },
      prefixCache.has(prefixKey),
    );
    prefixCache.add(prefixKey);
    // DECISION: a call that asked checks is recorded as purpose `check` and outcome `checks` (the request went out as the call it was - the
    // learn's first, or a step's - and only the answer says what it became), with the checks it asked and the ones dropped: counts only.
    const record: LlmCallRecord = {
      purpose: asked ? 'check' : purpose,
      model: result.model,
      provider: result.provider,
      ...fallbackFields(result.fallback),
      promptVersion,
      masking: payload.masking,
      tokensIn: result.usage.tokensIn,
      tokensOut: result.usage.tokensOut,
      tokensCached: result.usage.tokensCachedRead + result.usage.tokensCachedWrite,
      costUsd: result.costUsd,
      estimate,
      latencyMs: result.latencyMs,
      outcome: result.truncated ? 'truncated' : asked ? 'checks' : outcomeOf(problems),
      problemCounts: countProblems(problems, checked.invalidAlternatives, checked.overfitFallbacks),
      ...(asked ? { checks: { asked: asked.checks.length, dropped: asked.raw - asked.checks.length } } : {}),
    };
    // (`raw` is what a repair sends back when nothing parsed: for learn-v9 the rules part of the answer, never a checks answer.)
    const raw = result.truncated ? null : answer;
    const attempt: Attempt = { raw, problems, rules, alternatives, ...(asked ? { checks: asked.checks, droppedChecks: asked.dropped } : {}) };
    return { record, attempt };
  } catch (err) {
    const kind = err instanceof LlmError ? err.kind : 'providerError';
    const message = err instanceof Error ? err.message : 'unknown LLM error';
    const attempt: Attempt = {
      raw: null,
      rules: null,
      problems: [{ kind: 'schema', path: '', message: `LLM call failed: ${message}` }],
      alternatives: [],
    };
    // A call that failed on the fallback too is recorded as the fallback's (the last provider tried), with why it was tried.
    const failed = err instanceof LlmError ? err : null;
    const record: LlmCallRecord = {
      purpose,
      model: failed?.model ?? model,
      provider: failed?.provider ?? env.LLM_PROVIDER,
      ...fallbackFields(failed?.fallback),
      promptVersion,
      masking: payload.masking,
      tokensIn: 0,
      tokensOut: 0,
      tokensCached: 0,
      costUsd: 0,
      // DECISION: a failed call counts nothing (like the provider fields above), and does not write the cached prefix.
      estimate: emptyEstimate(failed?.model ?? model),
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
 * and its cache breakpoint - never changes. The instruction is the prompt version's own
 * (`LearnPrompt.repair`: learn-v8's says what a row in a problem is, learn-v7 keeps its own). */
function repairContentBlock(previous: Attempt, problems: RepairProblem[], prompt: LearnPrompt): ContentBlock {
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
  return { text: `${JSON.stringify(repairBlock)}\n${prompt.repair}` };
}

/**
 * The learning loop: a `diff` problem the sample run found on one of the browser's rows points at a sample index the model never saw (its
 * payload block is the first payload, so the cached prefix still hits). It is told the row itself instead, the way the browser tells it
 * (LEARN_PROMPT §4: `row`). `row.out` is always the example's own output row - `[]` for a row the rules make where none is expected, whose
 * made row the problem already carries in `made` (prompt audit X1: one meaning, as the browser sends it).
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

/** Whether an attempt has a rule that copies rows of the example: an `overfit` problem, or a column code reported for it (reason `overfit`). */
function copiesRows(a: Attempt): boolean {
  return a.problems.some((p) => p.kind === 'overfit') || (a.rules?.unsupported.some((u) => u.reasonCode === 'overfit') ?? false);
}

/**
 * The attempt with the fewest problems (ties keep the earliest). DECISION (prompt audit X2): an attempt with no rules - a call that failed
 * or was cut off, an answer whose structure did not parse - never beats one with rules, whatever the counts: its one `truncated` or
 * "call failed" problem is not fewer mistakes than a real answer's two, and keeping it would lose that answer for the browser's loop.
 * DECISION (SPEC 9.2 layer 6): next, an attempt whose rule copies rows of the example never beats one without: a rule that fits a
 * hand-edited row by its position hides that row's difference, so counting problems would prefer it to the honest rule with the row wrong.
 */
function bestOf(attempts: Attempt[]): Attempt {
  const worse = (a: Attempt, b: Attempt): boolean =>
    (a.rules === null) !== (b.rules === null)
      ? a.rules === null
      : copiesRows(a) !== copiesRows(b)
        ? copiesRows(a)
        : a.problems.length > b.problems.length;
  let best = attempts[0]!;
  for (const a of attempts) {
    if (worse(best, a)) best = a;
  }
  return best;
}

/** What a call sequence needs to make one more call: the provider, the model and what it was sent, the checks' inputs and the ledger. */
interface CallContext {
  completeFn: CompleteFn;
  env: Env;
  model: string;
  /** What every call of the sequence starts with: the payload block, and (learn-v9) one block per round of checks. */
  head: ContentBlock[];
  payload: LearnPayload;
  tier: Tier;
  prefixCache: PrefixCache;
  /** The learning loop's rows (a browser round): the answers are checked on them too. */
  rows: readonly Sample[];
  prompt: LearnPrompt;
  calls: LlmCallRecord[];
  attempts: Attempt[];
  opts: LearnOptions;
  /** The learn's one repair for a rule that copies rows has been made (SPEC 9.2 layer 6): every answer from then on is checked with `fallBack`. */
  overfitRepaired: boolean;
}

/** How an answer's rule that copies rows is checked: one repair per learn (`repair`), then the honest fallback. */
const overfitMode = (ctx: Pick<CallContext, 'overfitRepaired'>): 'repair' | 'fallBack' => (ctx.overfitRepaired ? 'fallBack' : 'repair');

/** SPEC 9.3: while `current` has problems, up to `limits.llm.serverRepairRounds` repair calls on the same model, each repairing the one before. */
async function serverRepairs(ctx: CallContext, start: Attempt): Promise<Attempt> {
  let current = start;
  for (let round = 0; round < limits.llm.serverRepairRounds && current.problems.length > 0; round++) {
    if (ctx.opts.signal?.aborted) break;
    // A repair that carries an `overfit` problem is the learn's one repair for it.
    if (current.problems.some((p) => p.kind === 'overfit')) ctx.overfitRepaired = true;
    const repair = await callAndCheck(
      ctx.completeFn,
      ctx.env,
      'repair',
      ctx.model,
      [...ctx.head, repairContentBlock(current, current.problems, ctx.prompt)],
      ctx.payload,
      ctx.tier,
      ctx.prefixCache,
      ctx.prompt,
      ctx.rows,
      overfitMode(ctx),
    );
    ctx.calls.push(repair.record);
    ctx.attempts.push(repair.attempt);
    ctx.opts.onAttempt?.(repair.attempt.problems);
    current = repair.attempt;
  }
  return current;
}

/**
 * learn-v9: the outcome of a first call that asked checks (a learn's, a step's, a list round's) - the checks, no rules, no repair: the
 * caller answers them and calls again. Null when the call answered otherwise.
 */
function checksOutcome(first: Attempt, ctx: CallContext): LearnOutcome | null {
  if (!first.checks) return null;
  const dropped = first.droppedChecks ?? [];
  return {
    rules: null,
    checks: first.checks,
    ...(dropped.length > 0 ? { droppedChecks: dropped } : {}),
    verified: false,
    problems: [],
    calls: ctx.calls,
    ...(ctx.overfitRepaired ? { overfitRepaired: true } : {}),
  };
}

function outcomeOfAttempts(ctx: CallContext): LearnOutcome {
  const best = bestOf(ctx.attempts);
  return {
    rules: best.rules,
    ...(best.rules !== null && best.alternatives.length > 0 ? { alternatives: best.alternatives } : {}),
    verified: best.rules !== null && best.problems.length === 0,
    problems: best.problems,
    calls: ctx.calls,
    ...(ctx.overfitRepaired ? { overfitRepaired: true } : {}),
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
 *
 * learn-v9 (AI code checks, see the file header): when the first call (of the learn, or of a step: `opts.rounds`) answers with checks while
 * rounds are left, that is the outcome - `checks`, no rules, no repair, no escalation. After the last round the call is told to answer with
 * the rules; one that asks checks anyway gets the repair round like any schema problem. The repairs and the escalation get the rounds too.
 */
export async function learn(payload: LearnPayload, opts: LearnOptions): Promise<LearnOutcome> {
  const env = opts.env ?? loadEnv();
  const completeFn = opts.complete ?? defaultComplete;
  const block = payloadBlock(payload);
  const firstTryModel = opts.models?.firstTry ?? resolveModel(env, 'firstTry');
  const prompt = learnPromptOf(opts.prompt);
  const rounds = prompt.checks ? (opts.rounds ?? []) : [];
  const head = [block, ...rounds.map((round, i) => roundBlock(round, i + 1, i === rounds.length - 1))];
  const checksLeft = prompt.checks === true && opts.rulesNow !== true && rounds.length < limits.learn.checks.maxRounds;
  // learn-v9: a call that must answer with the rules says so in one more block (after the last round; the escalation).
  const rulesNow = prompt.checks ? [RULES_NOW_BLOCK] : [];
  const ctx: CallContext = { completeFn, env, model: firstTryModel, head, payload, tier: opts.tier, prefixCache: new Set(), rows: [], prompt, calls: [], attempts: [], opts, overfitRepaired: opts.overfitRepaired === true };

  const firstContent = checksLeft || !prompt.checks ? head : [...head, ...rulesNow];
  const first = await callAndCheck(completeFn, env, 'learn', firstTryModel, firstContent, payload, opts.tier, ctx.prefixCache, prompt, [], overfitMode(ctx), checksLeft);
  ctx.calls.push(first.record);
  ctx.attempts.push(first.attempt);
  opts.onAttempt?.(first.attempt.problems);
  const asked = checksOutcome(first.attempt, ctx);
  if (asked) return asked;

  const current = await serverRepairs(ctx, first.attempt);

  if (current.problems.length > 0 && !opts.signal?.aborted && !opts.noEscalation) {
    const escalationModel = opts.models?.escalation ?? resolveModel(env, 'escalation');
    const escalated = await callAndCheck(completeFn, env, 'escalation', escalationModel, [...head, ...rulesNow], payload, opts.tier, ctx.prefixCache, prompt, [], overfitMode(ctx));
    ctx.calls.push(escalated.record);
    ctx.attempts.push(escalated.attempt);
    opts.onAttempt?.(escalated.attempt.problems);
  }

  return outcomeOfAttempts(ctx);
}

/** `repairFromBrowser`'s options: a learn's, plus the learning loop's rows. */
export interface RepairOptions extends LearnOptions {
  /** Every row of the example the browser sent so far, this round's included, masked like the samples (`RepairRequest.rows`). */
  rows?: readonly Sample[];
  /**
   * Logic first (docs/proposals/saved-format-contents.md section 4): a list's round - its problems carry a `list` problem - may be answered
   * with AI code checks under learn-v9 while rounds are left (`rounds`, `RepairRequest.rounds`) and another call of the round can follow:
   * `mayCheck` (the route: a repair call of the learn is left; the eval: the loop's caps). Ignored on any other round.
   */
  mayCheck?: boolean;
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
  const previous: Attempt = { raw: null, rules: previousRules, problems, alternatives: [] };
  const model = opts.models?.firstTry ?? resolveModel(env, 'firstTry');
  const prompt = learnPromptOf(opts.prompt);
  // DECISION: this call always comes after the learn's own first call on the same model, so the cached prefix is already there.
  // (A round whose problems carry an `overfit` problem is the learn's one repair for it: its answers are checked with `fallBack`.)
  const overfitRepaired = opts.overfitRepaired === true || problems.some((p) => p.kind === 'overfit');
  // (learn-v9: a round of the learning loop answers with the rules - its repair instruction says so; it carries no rounds of checks.)
  const ctx: CallContext = { completeFn, env, model, head: [block], payload, tier: opts.tier, prefixCache: new Set([model]), rows: opts.rows ?? [], prompt, calls: [], attempts: [], opts, overfitRepaired };
  // Logic first (docs/proposals/saved-format-contents.md section 4): a list's round, learn-v9, may ask checks first ("a band on the total
  // fits", "every key always gives one value") while rounds are left and another call of the round may follow. Its repair block then ends
  // with learn-v7's fix-only instruction (no "answer with the rules": the system prompt says checks may come first), its rounds of checks follow
  // it, and the round's last call is told to answer with the rules (the version's own instruction, or the rules-now block after rounds).
  // DECISION: no new prompt text - learn-v7's instruction and learn-v9's blocks as they are.
  const list = prompt.checks === true && problems.some((p) => p.kind === 'list');
  const rounds = list ? (opts.rounds ?? []) : [];
  const checksLeft = list && opts.mayCheck === true && rounds.length < limits.learn.checks.maxRounds;
  const content = [
    block,
    repairContentBlock(previous, problems, checksLeft ? { ...prompt, repair: REPAIR_INSTRUCTION_V7 } : prompt),
    ...rounds.map((round, i) => roundBlock(round, i + 1, i === rounds.length - 1)),
    ...(rounds.length > 0 && !checksLeft ? [RULES_NOW_BLOCK] : []),
  ];

  const first = await callAndCheck(completeFn, env, 'repair', model, content, payload, opts.tier, ctx.prefixCache, prompt, ctx.rows, overfitMode(ctx), checksLeft);
  ctx.calls.push(first.record);
  ctx.attempts.push(first.attempt);
  opts.onAttempt?.(first.attempt.problems);
  const asked = checksOutcome(first.attempt, ctx);
  if (asked) return asked;

  await serverRepairs(ctx, first.attempt);
  return outcomeOfAttempts(ctx);
}
