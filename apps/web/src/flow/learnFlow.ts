// The learn flow as a small state machine (SPEC 5 flow A, 16.1 "Learning progress"),
// independent of React so it is testable on its own; `useLearnFlow` is a thin wrapper.
//
//   idle -> reading -> checking -> learning -> verifying -> done
//                          |            |         ^          |
//                          |            |         +----------+  a round of the learning loop (at most 3), as the engine's driver decides
//                          |            +-> warn (continue past "unknown output columns")
//                          +-> blocked | warn (Try anyway) | error
//
// `learning` may first go through rounds of AI code checks (learn-v9, at most 3, `checkRound`): code answers the AI step's checks on every
// row and the next step (POST /api/learn/step) carries them, until the rules come.
//
// Real progress comes from the worker (`LearnProgress`); steps that don't happen are
// simply never visited (the local fast path goes checking -> done, with no learning or
// verifying). The HTTP calls are made HERE, on the main thread, on the worker's behalf.
import { limits, payloadBytes, stepBytes, withRows, type AiLearnQuotaState, type CheckRound, type Format, type LearnPayload, type LearnResponse, type LearnResult, type RepairProblem, type RepairResponse, type Sample, type Tier } from '@formatai/shared';
import type { AnalysisStage, CompleteOptions, LearnCallResult, PreflightIssue } from '@formatai/engine';
import type { Api } from '../api';
import { learnRequest, repairRequest, stepRequest, type LearnRequestOptions, type RepairRequestOptions } from '../api/learnRequests';
import { webConfig } from '../config';
import type { EngineClient } from '../worker/engineClient';
import type { CheckRoundInfo, LearnArgs, LearnHost, LearnOutput, LearnProgress, LoopRoundInfo, SentColumns } from '../worker/engineApi';
import { isCancellation, toFlowError, type FlowError } from './errors';

/**
 * What the browser actually sent to the API ("See what we send", SPEC 15): the learn, each step of AI code checks (`step`: the checks the AI
 * step asked and what code answered, every round so far), then each round of the learning loop.
 */
export interface SentRecord {
  kind: 'learn' | 'repair' | 'step';
  /**
   * A round of the learning loop sent as a fresh learn, because a cached result failed full verification (the server has no `learnId` to
   * repair): it carries the payload only (`noCache`, `rulesNow`) - no previous rules, no problems, no rows.
   */
  fresh?: boolean;
  /** A round of the learning loop: the learn already had its one repair for a rule that copies rows (the request's `overfitRepaired`). */
  overfitRepaired?: boolean;
  payload: LearnPayload;
  previousRules?: LearnResult;
  problems?: RepairProblem[];
  /** A round of the learning loop, or of AI code checks (a step): which one, of how many at most. */
  round?: { n: number; of: number };
  /** A round of the learning loop: every row of the example sent so far, masked (the request's `rows`). */
  rows?: Sample[];
  /**
   * A step of AI code checks, or the round for a list sent again with its own (docs/proposals/saved-format-contents.md section 4): every round
   * so far, this one last - the checks and code's answers, masked like the samples (the request's `rounds`).
   */
  rounds?: CheckRound[];
  /** Size of the JSON request body's payload part (a step: the payload with its rounds), in bytes (SPEC 7.3 caps it at 48 KB). */
  bytes: number;
  /** The learn request: per column of the example, whether masking hides its values (shown beside the JSON; not part of the request). */
  columns?: SentColumns;
}

interface Common {
  sent: readonly SentRecord[];
}

/**
 * What the AI step reported (SPEC 21 v5 items 2-3): the learn's id (the browser reports its own full
 * verification against it), whether it counts against the quota yet, the failed attempts so far on this
 * example pair, and what is left of the quota. Absent when the AI step was never called.
 */
export interface AiInfo {
  learnId?: string | undefined;
  counted?: boolean | undefined;
  failedAttempts?: number | undefined;
  quota?: AiLearnQuotaState | undefined;
  /** The failed-attempt cap on this pair was reached (the AI is not called for it any more). */
  exhausted?: boolean | undefined;
  /** The server returned saved rules for this exact structure without an LLM call (SPEC 9.5). */
  cached?: boolean | undefined;
}

/**
 * What a flow tells the app about the AI step as soon as it knows (`LearnFlowDeps.onAi`): what is left of the AI formats, as the server just
 * said (an answer, a round, a step, an outcome report), or a refusal (for the quota, or because the session is gone).
 */
export type AiEvent = { quota: AiLearnQuotaState } | { error: FlowError };

export type LearnFlowState =
  | { status: 'idle'; sent: readonly SentRecord[] }
  | ({ status: 'reading' } & Common)
  | ({ status: 'checking'; stage: AnalysisStage; fraction: number } & Common)
  | ({
      status: 'learning';
      attempt: 'learn' | 'repair';
      /** Headers of the output columns code could not find in the input file (SPEC 6.4, informational): the AI step tries them. Only on the first try. */
      unexplained?: string[];
      /** A round of the learning loop (a repair): its number, the most there may be, and how many rows the rules got wrong it sends. */
      round?: LoopRoundInfo;
      /** A round of AI code checks (the first try): the AI step asked code to check ideas on every row - which round, of how many at most. */
      checkRound?: CheckRoundInfo;
    } & Common)
  | ({ status: 'verifying' } & Common)
  /** Needs the user's go-ahead (SPEC 6.4 "rows couldn't be aligned"): `confirm()` tries anyway, `cancel()` stops. */
  | ({
      status: 'warn';
      reason: 'tryAnyway';
      issues: PreflightIssue[];
    } & Common)
  | ({ status: 'blocked'; result: LearnOutput } & Common)
  /** SPEC 21 v5 item 4: the AI readiness gate stopped the AI step (`result.readiness` says why); nothing was used up. */
  | ({ status: 'notReady'; result: LearnOutput } & Common)
  /**
   * `result.exampleId` is the example the worker kept for the rules editor's live check (SPEC 8.11). `result.path`
   * 'partial' is the local result shown before the AI step (`result.partial`); `ai` is set when the AI step ran.
   */
  | ({ status: 'done'; result: LearnOutput; ai?: AiInfo; /** The user went on past "rows couldn't be aligned" (SPEC 6.4): the same learn has to be run the same way again (after signing in). */ tryAnyway?: boolean } & Common)
  | ({ status: 'error'; error: FlowError } & Common);

export type LearnFlowStatus = LearnFlowState['status'];

/** Just what the flow needs of a `File`, so tests don't need a real one. */
export type FileLike = Pick<File, 'name' | 'size' | 'arrayBuffer'>;

export interface StartParams {
  input: FileLike;
  output: FileLike;
  /** SPEC 7.2: on by default in the UI. */
  masking: boolean;
  /**
   * SPEC 21 v5 item 1: 'notAllowed' (not signed in) never reaches the AI step: the learn ends with the local
   * result (`path: 'partial'`) when the fast path can't finish it. Default: 'allowed'.
   */
  ai?: 'allowed' | 'notAllowed';
  /** SPEC 5 A2 attach mode: the format this source must produce. */
  target?: Format;
  /** Continue past "rows couldn't be aligned" (SPEC 6.4) without asking: the same learn, run again after a sign-in. */
  tryAnyway?: boolean;
  /**
   * Completion mode (LEARN_PROMPT "Completing a partial rules file"): the AI step only produces what is missing from the rules the user has
   * (`fixedRules`), which it must leave unchanged. `exampleId`: the example the screen's live check already uses, kept by the worker.
   * The result carries `completion`; nothing is replaced here - the caller decides what to do with a result that passes (or fails) the lock,
   * and so the caller reports how it ended (`/outcome`), once it has decided: an answer it does not use is never reported as verified.
   */
  complete?: CompleteOptions & { exampleId?: string | undefined };
}

export interface LearnFlowDeps {
  engine: EngineClient;
  api: Api;
  tier: Tier;
  /** Read at the start of every learn, so a sign-in that happens while the screen is open does not replace the flow. Wins over `tier`. */
  getTier?: () => Tier;
  /**
   * Resolves once it is known who is using the app (`/api/me` has answered). Awaited at the start of every learn, BEFORE `getTier` and
   * `getAi` are read: a learn started while the answer is still on its way must not run as a visitor's (no AI step, the anonymous limits)
   * when the person is signed in.
   */
  ready?: () => Promise<void>;
  /** Whether the AI step is allowed, for a learn that did not say (`StartParams.ai`): read after `ready`. Default: allowed. */
  getAi?: () => 'allowed' | 'notAllowed';
  /** A fresh Cloudflare Turnstile token per learn call, when Turnstile is on (SPEC 9.5). */
  getTurnstileToken?: () => Promise<string | undefined>;
  maxFileBytes?: number;
  /**
   * Called after a payload has been recorded in `state.sent` (so a UI can show it) and
   * before it is sent. Throw to stop the send: the flow ends in an `error` state. Lets a
   * screen offer "review what we send" (SPEC 5 A step 4), and keeps the debug page from
   * spending LLM calls by accident.
   */
  beforeSend?: (record: SentRecord) => void | Promise<void>;
  /**
   * Every flow tells the app the same way (C10): the quota after each answer of the API and each outcome report, and a refusal the run ended
   * with (the app shows the quota everywhere, and reads who is signed in again when the session is gone). See app/aiReport.ts.
   */
  onAi?: (event: AiEvent) => void;
}

const IDLE: LearnFlowState = { status: 'idle', sent: [] };

export class LearnFlow {
  private state: LearnFlowState = IDLE;
  private readonly listeners = new Set<() => void>();

  private runId = 0;
  private abort: AbortController | null = null;
  private lastParams: StartParams | null = null;

  constructor(private readonly deps: LearnFlowDeps) {}

  // ---------- store ----------

  getState = (): LearnFlowState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private set(next: LearnFlowState): void {
    this.state = next;
    for (const l of this.listeners) l();
  }

  // ---------- actions ----------

  /** Start (or restart) a learn from an example input/output pair. */
  start(params: StartParams): Promise<void> {
    this.lastParams = params;
    return this.run(params, params.tryAnyway === true);
  }

  /** Go ahead past a warning: "Try anyway" on unaligned rows. */
  confirm(): void {
    const s = this.state;
    if (s.status !== 'warn') return;
    if (this.lastParams) void this.run(this.lastParams, true);
  }

  /** Stop whatever is running and go back to idle (the worker is told to drop the call; it is not restarted, so what it holds for other screens stays). */
  cancel(): void {
    this.runId++;
    this.abort?.abort();
    this.abort = null;
    this.set(IDLE);
  }

  reset(): void {
    this.cancel();
  }

  // ---------- the run ----------

  private async run(params: StartParams, tryAnyway: boolean): Promise<void> {
    this.cancelRunning();
    const runId = ++this.runId;
    const abort = new AbortController();
    this.abort = abort;
    const stale = (): boolean => runId !== this.runId;

    let sent: readonly SentRecord[] = [];
    let learnId: string | undefined;
    /** The loop's rows that went with no learnId (see `callRepair`): never sent, so never counted against the fresh learn's rounds. */
    let rowsBeforeLearnId = 0;
    let ai: AiInfo | undefined;
    let lastProblems: RepairProblem[] = [];
    let hostError: unknown;
    const setPhase = (next: LearnFlowState): void => {
      if (!stale()) this.set(next);
    };
    const record = async (rec: Omit<SentRecord, 'bytes'>): Promise<void> => {
      // (a loop round's rows count with the payload: the byte cap holds for the payload with every row sent added to it; a step's rounds the same)
      const full: SentRecord = { ...rec, bytes: rec.rounds ? stepBytes(withRows(rec.payload, rec.rows ?? []), rec.rounds) : payloadBytes(withRows(rec.payload, rec.rows ?? [])) };
      sent = [...sent, full];
      if (!stale()) this.set({ ...this.state, sent } as LearnFlowState);
      await this.deps.beforeSend?.(full);
    };

    setPhase({ status: 'reading', sent });

    const maxBytes = this.deps.maxFileBytes ?? webConfig.maxFileBytes;
    for (const f of [params.input, params.output]) {
      if (f.size > maxBytes) {
        setPhase({ status: 'error', error: { kind: 'fileTooLarge', fileName: f.name, bytes: f.size, maxBytes }, sent });
        return;
      }
    }

    const token = (): Promise<string | undefined> => this.deps.getTurnstileToken?.() ?? Promise.resolve(undefined);

    // Who is using the app has to be known before the tier and the AI step are decided (see `LearnFlowDeps.ready`).
    try {
      await this.deps.ready?.();
    } catch {
      // Not knowing is the same as nobody signed in: the learn goes on with what `getTier`/`getAi` say.
    }
    if (stale()) return;

    const host: LearnHost = {
      callLearn: async (payload, columns) => {
        try {
          await record({ kind: 'learn', payload, ...(columns ? { columns } : {}) });
          const res = await this.deps.api.learn(payload, { turnstileToken: await token(), signal: abort.signal });
          learnId = res.learnId;
          lastProblems = res.problems;
          ai = { learnId: res.learnId, counted: res.counted, failedAttempts: res.failedAttempts, quota: res.quota, cached: res.cached };
          if (res.quota && !stale()) this.deps.onAi?.({ quota: res.quota });
          return asCallResult(res);
        } catch (e) {
          hostError = e;
          throw e;
        }
      },
      callRepair: async (payload, previousRules, problems, round) => {
        // The round for a list (docs/proposals/saved-format-contents.md section 4) of a cached answer: there is no learn to repair, and the fresh
        // learn that stands in for a loop round would not carry its question - nothing is sent (the list stays, and is asked about at Save).
        if (round.list && learnId === undefined) return { rules: null, problems: [], calls: [] };
        // A cached result has no `learnId` to repair; the server's own answer to "the browser rejected it"
        // is a fresh, uncached learn (SPEC 9.5 cache).
        const fresh = learnId === undefined;
        // DECISION: a fresh learn carries no rows (it is a learn, not a round), so the rows of that round never left the browser; the later
        // rounds, under the fresh learn's own learnId, send only the rows sent since (the server counts rows per round from its own rounds).
        // DECISION (AI code checks): it stands in for a round of the loop, and loop rounds carry no checks - so it is sent `rulesNow`: the
        // AI step must answer with the rules (learn-v9's "answer with the rules now"), never ask checks the loop has no way to answer.
        if (fresh) rowsBeforeLearnId = round.rows.length;
        const rows = fresh ? [] : round.rows.slice(rowsBeforeLearnId);
        // What the repair carries besides the payload, the rules and the problems - recorded and sent as one (`sentBody` builds the same body).
        // (the round for a list, learn-v9: sent again with its rounds of checks answered - `LoopRound.checks`)
        const opts: RepairRequestOptions = { rows, overfitRepaired: round.overfitRepaired, rounds: round.checks };
        try {
          const n = { n: round.round, of: round.maxRounds };
          await record(fresh ? { kind: 'repair', fresh: true, payload, round: n } : { kind: 'repair', payload, previousRules, problems, round: n, ...recordedRepair(opts) });
          const res = fresh
            ? await this.deps.api.learn(payload, { turnstileToken: await token(), ...FRESH_LEARN, signal: abort.signal })
            : await this.deps.api.repair(learnId!, payload, previousRules, problems, { signal: abort.signal, ...opts });
          lastProblems = res.problems;
          // (the next round repairs the fresh learn, under its own learnId)
          if (fresh) learnId = (res as LearnResponse).learnId;
          ai = {
            ...ai,
            ...(fresh ? { learnId: (res as LearnResponse).learnId } : {}),
            counted: res.counted,
            failedAttempts: res.failedAttempts,
            quota: res.quota ?? ai?.quota,
          };
          if (res.quota && !stale()) this.deps.onAi?.({ quota: res.quota });
          return asCallResult(res);
        } catch (e) {
          hostError = e;
          throw e;
        }
      },
      // AI code checks (learn-v9, SPEC 21 v14): the AI step asked checks; the worker answered them on every row (masked like the samples) and
      // this sends every round so far under the learn's own id - which stays the learn's id for the later steps and for the loop's repairs.
      callStep: async (payload, rounds) => {
        try {
          // (A checks answer always comes with a learnId: a cached answer is rules, never checks.)
          if (learnId === undefined) throw new Error("A step of AI code checks needs the learn's id");
          await record({ kind: 'step', payload, rounds, round: { n: rounds.length, of: limits.learn.checks.maxRounds } });
          const res = await this.deps.api.step(learnId, payload, rounds, { signal: abort.signal });
          lastProblems = res.problems;
          ai = { ...ai, counted: res.counted, failedAttempts: res.failedAttempts, quota: res.quota ?? ai?.quota };
          if (res.quota && !stale()) this.deps.onAi?.({ quota: res.quota });
          return asCallResult(res);
        } catch (e) {
          hostError = e;
          throw e;
        }
      },
    };

    try {
      const args = await readArgs(params, this.deps.getTier?.() ?? this.deps.tier, tryAnyway, params.ai ?? this.deps.getAi?.());
      if (stale()) return; // cancelled or superseded while the files were being read
      const result = await this.deps.engine.learn(args, host, {
        signal: abort.signal,
        onProgress: (p) => {
          if (!stale()) this.set(stateForProgress(p, sent));
        },
      });
      if (stale()) return;

      if (result.path === 'blocked') {
        const hardBlock = result.preflight.issues.some((i) => i.severity === 'block');
        if (hardBlock) this.set({ status: 'blocked', result, sent });
        else {
          // Only "rows couldn't be aligned" (SPEC 6.4): the user may try anyway.
          this.set({ status: 'warn', reason: 'tryAnyway', issues: result.preflight.issues.filter((i) => i.severity === 'warn'), sent });
        }
      } else if (result.path === 'notReady') {
        this.set({ status: 'notReady', result, sent });
      } else if (!result.rules) {
        this.set({ status: 'error', error: { kind: 'learnFailed', problems: lastProblems }, sent });
      } else {
        this.set({ status: 'done', result, sent, ...(ai ? { ai } : {}), ...(tryAnyway ? { tryAnyway: true } : {}) });
        // SPEC 21 v5 item 3: the browser reports its own full verification, and the answer says what counted. (Not a completion: whether its
        // answer is used is the caller's decision - the lock, the match, and the user's edits made meanwhile - so the caller reports it.)
        if (result.path === 'llm' && ai?.learnId && result.verification && !params.complete) {
          void this.reportOutcome(runId, ai.learnId, result.verification.verified ? 'verified' : 'failed');
        }
      }
    } catch (e) {
      if (stale() || isCancellation(e)) return;
      const error = toFlowError(e, hostError);
      this.set({ status: 'error', error, sent });
      if (error.kind === 'api') this.deps.onAi?.({ error });
    } finally {
      if (this.abort === abort) this.abort = null;
    }
  }

  /** Reports how the learn ended (best effort: the result is already on screen) and folds the answer into `ai`. */
  private async reportOutcome(runId: number, learnId: string, outcome: 'verified' | 'failed'): Promise<void> {
    try {
      const res = await this.deps.api.registry.learnOutcome(learnId, outcome);
      if (runId === this.runId) this.deps.onAi?.({ quota: res.quota });
      const s = this.state;
      if (runId !== this.runId || s.status !== 'done') return;
      this.set({ ...s, ai: { ...s.ai, learnId, counted: res.counted, failedAttempts: res.failedAttempts, quota: res.quota, exhausted: res.exhausted } });
    } catch {
      // Nothing to tell the user: the server keeps its own count, and the learn counted when it verified there.
    }
  }

  private cancelRunning(): void {
    this.abort?.abort();
    this.abort = null;
  }
}

/** The fresh learn that stands in for a round of the learning loop: uncached, and it must answer with the rules (learn-v9). */
const FRESH_LEARN: LearnRequestOptions = { noCache: true, rulesNow: true };

/** What a repair's record keeps of its options (only what is there): exactly what `sentBody` gives back to the request builder. */
function recordedRepair(opts: RepairRequestOptions): Pick<SentRecord, 'rows' | 'overfitRepaired' | 'rounds'> {
  return {
    ...(opts.rows && opts.rows.length > 0 ? { rows: opts.rows } : {}),
    ...(opts.overfitRepaired ? { overfitRepaired: true } : {}),
    ...(opts.rounds && opts.rounds.length > 0 ? { rounds: opts.rounds } : {}),
  };
}

/**
 * The JSON body of the request a record stands for, exactly as `Api` sends it ("See what we send" shows it): built by the same request builders
 * the API client uses (api/learnRequests.ts), so the two cannot drift - apart from the learn's id (a repair's `learnId`, a step's `token`) and
 * the Turnstile token, which carry nothing from the files. A fresh learn in a loop round is a learn: the payload, `noCache` and `rulesNow`.
 */
export function sentBody(rec: SentRecord): object {
  switch (rec.kind) {
    case 'learn':
      return learnRequest(rec.payload);
    case 'step': {
      const { token: _token, ...body } = stepRequest('', rec.payload, rec.rounds ?? []);
      return body;
    }
    case 'repair': {
      if (rec.fresh) return learnRequest(rec.payload, FRESH_LEARN);
      const { learnId: _learnId, ...body } = repairRequest('', rec.payload, rec.previousRules!, rec.problems ?? [], { rows: rec.rows, overfitRepaired: rec.overfitRepaired, rounds: rec.rounds });
      return body;
    }
  }
}

/**
 * What the engine's learn needs of an answer: the rules, the problems, (learn-v8) the alternatives, which it tests on every row, and (learn-v9)
 * the checks the AI step asked instead of answering - present, even empty with `droppedChecks`, it is a checks answer the engine answers.
 */
function asCallResult(res: RepairResponse): LearnCallResult {
  const { rules, problems, alternatives, overfitRepaired, checks, droppedChecks } = res;
  return {
    rules,
    problems,
    calls: [],
    ...(alternatives && alternatives.length > 0 ? { alternatives } : {}),
    ...(overfitRepaired ? { overfitRepaired: true } : {}),
    ...(checks ? { checks } : {}),
    ...(checks && droppedChecks && droppedChecks.length > 0 ? { droppedChecks } : {}),
  };
}

function stateForProgress(p: LearnProgress, sent: readonly SentRecord[]): LearnFlowState {
  switch (p.phase) {
    case 'reading':
      return { status: 'reading', sent };
    case 'checking':
      return { status: 'checking', stage: p.stage, fraction: p.fraction, sent };
    case 'learning':
      return {
        status: 'learning',
        attempt: p.attempt,
        ...(p.unexplained && p.unexplained.length > 0 ? { unexplained: p.unexplained } : {}),
        ...(p.round ? { round: p.round } : {}),
        ...(p.checkRound ? { checkRound: p.checkRound } : {}),
        sent,
      };
    case 'verifying':
      return { status: 'verifying', sent };
  }
}

async function readArgs(params: StartParams, tier: Tier, tryAnyway: boolean, ai: 'allowed' | 'notAllowed' | undefined): Promise<LearnArgs> {
  const [input, output] = await Promise.all([params.input.arrayBuffer(), params.output.arrayBuffer()]);
  return {
    input: { name: params.input.name, bytes: input },
    output: { name: params.output.name, bytes: output },
    masking: params.masking,
    tier,
    ...(tryAnyway ? { tryAnyway: true } : {}),
    ...(ai ? { ai } : {}),
    ...(params.target ? { target: params.target } : {}),
    ...(params.complete ? { complete: { fixedRules: params.complete.fixedRules, columns: params.complete.columns, parts: params.complete.parts }, ...(params.complete.exampleId ? { keepExampleId: params.complete.exampleId } : {}) } : {}),
  };
}
