// The learn flow as a small state machine (SPEC 5 flow A, 16.1 "Learning progress"),
// independent of React so it is testable on its own; `useLearnFlow` is a thin wrapper.
//
//   idle -> reading -> checking -> learning -> verifying -> done
//                          |            |
//                          |            +-> warn (continue past "unknown output columns")
//                          +-> blocked | warn (Try anyway) | error
//
// Real progress comes from the worker (`LearnProgress`); steps that don't happen are
// simply never visited (the local fast path goes checking -> done, with no learning or
// verifying). The HTTP calls are made HERE, on the main thread, on the worker's behalf.
import type { LearnPayload, LearnResult, RepairProblem, Tier } from '@formatai/shared';
import type { AnalysisStage, LearnCallResult, LearnFromExamplesResult, PreflightIssue } from '@formatai/engine';
import type { Api } from '../api';
import { webConfig } from '../config';
import type { EngineClient } from '../worker/engineClient';
import type { LearnArgs, LearnHost, LearnProgress } from '../worker/engineApi';
import { CancelledError, isCancellation, toFlowError, type FlowError } from './errors';

/** What the browser actually sent to the API ("See what we send", SPEC 15). */
export interface SentRecord {
  kind: 'learn' | 'repair';
  /** True when a learn was re-sent because a cached result failed full verification (the server has no `learnId` to repair). */
  fresh?: boolean;
  payload: LearnPayload;
  previousRules?: LearnResult;
  problems?: RepairProblem[];
  /** Size of the JSON request body's payload part, in bytes (SPEC 7.3 caps it at 48 KB). */
  bytes: number;
}

interface Common {
  sent: readonly SentRecord[];
}

export type LearnFlowState =
  | { status: 'idle'; sent: readonly SentRecord[] }
  | ({ status: 'reading' } & Common)
  | ({ status: 'checking'; stage: AnalysisStage; fraction: number } & Common)
  | ({ status: 'learning'; attempt: 'learn' | 'repair' } & Common)
  | ({ status: 'verifying' } & Common)
  /** Needs the user's go-ahead (SPEC 6.4): `confirm()` continues, `cancel()` stops. */
  | ({
      status: 'warn';
      reason: 'confirmSkipColumns' | 'tryAnyway';
      issues: PreflightIssue[];
      /** For `confirmSkipColumns`: the headers of the output columns that will be left empty. */
      columns: string[];
    } & Common)
  | ({ status: 'blocked'; result: LearnFromExamplesResult } & Common)
  | ({ status: 'done'; result: LearnFromExamplesResult } & Common)
  | ({ status: 'error'; error: FlowError } & Common);

export type LearnFlowStatus = LearnFlowState['status'];

/** Just what the flow needs of a `File`, so tests don't need a real one. */
export type FileLike = Pick<File, 'name' | 'size' | 'arrayBuffer'>;

export interface StartParams {
  input: FileLike;
  output: FileLike;
  /** SPEC 7.2: on by default in the UI. */
  masking: boolean;
}

export interface LearnFlowDeps {
  engine: EngineClient;
  api: Api;
  tier: Tier;
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
}

const IDLE: LearnFlowState = { status: 'idle', sent: [] };

export class LearnFlow {
  private state: LearnFlowState = IDLE;
  private readonly listeners = new Set<() => void>();

  private runId = 0;
  private abort: AbortController | null = null;
  private gate: { resolve(): void; reject(e: Error): void } | null = null;
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
    return this.run(params, false);
  }

  /** Go ahead past a warning: leave unknown columns empty, or "Try anyway" on unaligned rows. */
  confirm(): void {
    const s = this.state;
    if (s.status !== 'warn') return;
    if (s.reason === 'confirmSkipColumns') {
      const gate = this.gate;
      this.gate = null;
      gate?.resolve();
      this.set({ status: 'learning', attempt: 'learn', sent: s.sent });
    } else if (this.lastParams) {
      void this.run(this.lastParams, true);
    }
  }

  /** Stop whatever is running (the worker is restarted) and go back to idle. */
  cancel(): void {
    this.runId++;
    this.abort?.abort();
    this.abort = null;
    const gate = this.gate;
    this.gate = null;
    gate?.reject(new CancelledError());
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
    let lastProblems: RepairProblem[] = [];
    let hostError: unknown;
    let skipConfirmed = false;

    const setPhase = (next: LearnFlowState): void => {
      if (!stale()) this.set(next);
    };
    const record = async (rec: Omit<SentRecord, 'bytes'>): Promise<void> => {
      const full: SentRecord = { ...rec, bytes: new TextEncoder().encode(JSON.stringify(rec.payload)).length };
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

    const host: LearnHost = {
      callLearn: async (payload) => {
        // SPEC 6.4: unknown output columns are shown before learning; continuing is the user's call.
        if (!skipConfirmed && payload.skipColumns && payload.skipColumns.length > 0) {
          const columns = payload.skipColumns.map((i) => payload.output.columns[i]?.header ?? String(i));
          setPhase({
            status: 'warn',
            reason: 'confirmSkipColumns',
            issues: [{ code: 'unknownOutputColumns', severity: 'warn', params: { count: columns.length } }],
            columns,
            sent,
          });
          await new Promise<void>((resolve, reject) => {
            this.gate = { resolve, reject };
          });
          skipConfirmed = true;
        }
        try {
          await record({ kind: 'learn', payload });
          const res = await this.deps.api.learn(payload, { turnstileToken: await token(), signal: abort.signal });
          learnId = res.learnId;
          lastProblems = res.problems;
          return asCallResult(res.rules, res.problems);
        } catch (e) {
          hostError = e;
          throw e;
        }
      },
      callRepair: async (payload, previousRules, problems) => {
        // A cached result has no `learnId` to repair; the server's own answer to "the browser rejected it"
        // is a fresh, uncached learn (SPEC 9.5 cache).
        const fresh = learnId === undefined;
        try {
          await record({ kind: 'repair', payload, previousRules, problems, ...(fresh ? { fresh: true } : {}) });
          const res = fresh
            ? await this.deps.api.learn(payload, { turnstileToken: await token(), noCache: true, signal: abort.signal })
            : await this.deps.api.repair(learnId!, payload, previousRules, problems, { signal: abort.signal });
          lastProblems = res.problems;
          return asCallResult(res.rules, res.problems);
        } catch (e) {
          hostError = e;
          throw e;
        }
      },
    };

    try {
      const args = await readArgs(params, this.deps.tier, tryAnyway);
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
          this.set({ status: 'warn', reason: 'tryAnyway', issues: result.preflight.issues.filter((i) => i.severity === 'warn'), columns: [], sent });
        }
      } else if (!result.rules) {
        this.set({ status: 'error', error: { kind: 'learnFailed', problems: lastProblems }, sent });
      } else {
        this.set({ status: 'done', result, sent });
      }
    } catch (e) {
      if (stale() || isCancellation(e)) return;
      this.set({ status: 'error', error: toFlowError(e, hostError), sent });
    } finally {
      if (this.abort === abort) this.abort = null;
    }
  }

  private cancelRunning(): void {
    this.abort?.abort();
    this.abort = null;
    const gate = this.gate;
    this.gate = null;
    gate?.reject(new CancelledError());
  }
}

function asCallResult(rules: LearnResult | null, problems: RepairProblem[]): LearnCallResult {
  return { rules, problems, calls: [] };
}

function stateForProgress(p: LearnProgress, sent: readonly SentRecord[]): LearnFlowState {
  switch (p.phase) {
    case 'reading':
      return { status: 'reading', sent };
    case 'checking':
      return { status: 'checking', stage: p.stage, fraction: p.fraction, sent };
    case 'learning':
      return { status: 'learning', attempt: p.attempt, sent };
    case 'verifying':
      return { status: 'verifying', sent };
  }
}

async function readArgs(params: StartParams, tier: Tier, tryAnyway: boolean): Promise<LearnArgs> {
  const [input, output] = await Promise.all([params.input.arrayBuffer(), params.output.arrayBuffer()]);
  return {
    input: { name: params.input.name, bytes: input },
    output: { name: params.output.name, bytes: output },
    masking: params.masking,
    tier,
    ...(tryAnyway ? { tryAnyway: true } : {}),
  };
}
