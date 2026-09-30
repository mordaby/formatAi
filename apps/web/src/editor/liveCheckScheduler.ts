// The live check as a small scheduler (SPEC 8.11 "Live check"): React-free, so a fake worker tests it.
//
//  - Every edit calls `update`; the check runs once the edits have paused for `debounceMs` (~150 ms).
//  - One check runs at a time. An edit that arrives while one runs replaces whatever was waiting, and the
//    running check's result, being for older rules, is dropped: the worker can't be interrupted (killing
//    it would lose the example in its memory), so "cancelling" a stale request means never showing it and
//    never queueing more than the newest one.
//  - `apply` runs the same check on every row (above 5,000 example rows the live check only sees a subset).
//  - Static checks (SPEC 9.2 layers 1-5) run in the same cycle, so problems show as soon as they exist.
import type { Format, Tier } from '@formatai/shared';
import { editorConfig } from './config';
import type { LiveCheckResult, StaticCheckOptions, StaticProblem } from '../worker/editorApi';
import type { EngineCallOptions, LiveCheckOptions } from '../worker/engineClient';
import type { EditableRules } from './types';

/** The part of the engine client the scheduler needs (a fake in tests). */
export interface CheckEngine {
  liveCheck(exampleId: string, rules: EditableRules, options?: LiveCheckOptions, opts?: EngineCallOptions): Promise<LiveCheckResult>;
  fullCheck(exampleId: string, rules: EditableRules, options?: { exceptions?: number[] }, opts?: EngineCallOptions): Promise<LiveCheckResult>;
  staticChecks(rules: EditableRules, options: StaticCheckOptions, opts?: EngineCallOptions): Promise<StaticProblem[]>;
}

export interface CheckInput {
  rules: EditableRules;
  exceptions: number[];
  /** `EditorState.rev`: which version of the rules this is. */
  rev: number;
}

export interface LiveCheckState {
  status: 'idle' | 'checking' | 'ready' | 'noExample' | 'error';
  /** The last finished live (or full) result, and the revision it was for. */
  live: LiveCheckResult | null;
  liveRev: number | null;
  /** The last result that covered every row (a live check on a small example counts), and its revision. */
  full: LiveCheckResult | null;
  fullRev: number | null;
  /** Static-check problems, and the revision they were for (null before the first run). */
  staticProblems: StaticProblem[] | null;
  staticRev: number | null;
  /** The newest revision asked for: a result with another revision is out of date. */
  latestRev: number | null;
  /** An all-rows check (Apply) is queued or running. */
  applying: boolean;
  error: { code?: string; message: string } | null;
}

export interface SchedulerOptions {
  engine: CheckEngine;
  /** Undefined when there is no example: only the static checks run. */
  exampleId: string | undefined;
  tier: Tier;
  format?: Format | undefined;
  debounceMs?: number;
}

const INITIAL: LiveCheckState = {
  status: 'idle',
  live: null,
  liveRev: null,
  full: null,
  fullRev: null,
  staticProblems: null,
  staticRev: null,
  latestRev: null,
  applying: false,
  error: null,
};

interface Waiter {
  resolve(result: LiveCheckResult | null): void;
  reject(error: unknown): void;
}

function errorInfo(e: unknown): { code?: string; message: string } {
  const code = (e as { code?: unknown } | null)?.code;
  return { ...(typeof code === 'string' ? { code } : {}), message: e instanceof Error ? e.message : String(e) };
}

export class LiveCheckScheduler {
  private state: LiveCheckState = INITIAL;
  private readonly listeners = new Set<() => void>();
  private input: CheckInput | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private inFlight = false;
  private fullWanted = false;
  private waiters: Waiter[] = [];
  private stopped = false;
  private exampleGone = false;

  constructor(private readonly options: SchedulerOptions) {}

  getState = (): LiveCheckState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private set(patch: Partial<LiveCheckState>): void {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }

  private clearTimer(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** Allow checks to run (again): a React effect that was cleaned up and re-run starts the same scheduler again. */
  start(): void {
    this.stopped = false;
  }

  /** Stop: pending timers are cleared, results still in flight are dropped, waiting `apply` calls get null. */
  dispose(): void {
    this.stopped = true;
    this.clearTimer();
    const waiters = this.waiters;
    this.waiters = [];
    this.fullWanted = false;
    for (const w of waiters) w.resolve(null);
  }

  /**
   * The rules or exceptions changed. Debounced; `immediate` runs the check now (the first one, when the editor opens).
   * The state's `latestRev` moves at once, so a result for older rules is known to be out of date.
   */
  update(input: CheckInput, opts: { immediate?: boolean } = {}): void {
    this.input = input;
    this.set({ latestRev: input.rev });
    this.clearTimer();
    if (opts.immediate) {
      this.pump();
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.pump();
    }, this.options.debounceMs ?? editorConfig.debounceMs);
  }

  /** "Apply": the check on every row, for the latest rules. Resolves with the result (null when there is no example or it was stopped). */
  apply(): Promise<LiveCheckResult | null> {
    if (!this.input || this.options.exampleId === undefined || this.exampleGone) return Promise.resolve(null);
    // Nothing newer to check and the last live result already covered every row: that is the answer.
    const s = this.state;
    if (s.full && s.fullRev === this.input.rev && !this.timer && !this.inFlight) return Promise.resolve(s.full);
    return new Promise<LiveCheckResult | null>((resolve, reject) => {
      this.waiters.push({ resolve, reject });
      this.fullWanted = true;
      this.clearTimer();
      this.set({ applying: true });
      this.pump();
    });
  }

  private pump(): void {
    if (this.stopped || this.inFlight || !this.input) return;
    void this.run(this.input);
  }

  private async run(input: CheckInput): Promise<void> {
    this.inFlight = true;
    const wantFull = this.fullWanted;
    this.fullWanted = false;
    const waiters = this.waiters;
    this.waiters = [];
    const { engine, exampleId, tier, format } = this.options;
    const exceptions = input.exceptions;
    this.set({ status: 'checking' });

    const [check, stat] = await Promise.allSettled([
      exampleId === undefined || this.exampleGone
        ? Promise.resolve(null)
        : wantFull
          ? engine.fullCheck(exampleId, input.rules, { exceptions })
          : engine.liveCheck(exampleId, input.rules, { exceptions }),
      engine.staticChecks(input.rules, { tier, ...(format ? { format } : {}) }),
    ]);
    this.inFlight = false;

    const outOfDate = this.input !== null && this.input.rev !== input.rev;
    if (this.stopped) {
      for (const w of waiters) w.resolve(null);
      return;
    }

    if (outOfDate) {
      // Older rules: show nothing of it. An Apply that was waiting is answered by the next run.
      if (wantFull || waiters.length > 0) {
        this.fullWanted = true;
        this.waiters = [...waiters, ...this.waiters];
      }
      this.set({ status: this.state.live ? 'ready' : 'idle', applying: this.fullWanted });
      if (this.timer === undefined) this.pump();
      return;
    }

    const patch: Partial<LiveCheckState> = { applying: false };
    if (stat.status === 'fulfilled') {
      patch.staticProblems = stat.value;
      patch.staticRev = input.rev;
    }
    let result: LiveCheckResult | null = null;
    let failure: unknown;
    if (check.status === 'fulfilled') {
      result = check.value;
      if (result) {
        patch.live = result;
        patch.liveRev = input.rev;
        if (!result.partial) {
          patch.full = result;
          patch.fullRev = input.rev;
        }
      }
      patch.status = exampleId === undefined ? 'noExample' : 'ready';
      patch.error = null;
    } else {
      failure = check.reason;
      const info = errorInfo(failure);
      if (info.code === 'exampleGone') {
        this.exampleGone = true;
        patch.status = 'noExample';
        patch.error = info;
      } else {
        patch.status = 'error';
        patch.error = info;
      }
    }
    if (stat.status === 'rejected' && failure === undefined) {
      failure = stat.reason;
      patch.status = 'error';
      patch.error = errorInfo(stat.reason);
    }
    this.set(patch);

    for (const w of waiters) {
      if (failure !== undefined) w.reject(failure);
      else w.resolve(result);
    }

    // An Apply that came in while this ran: this result answers it when it already covered every row.
    if (this.fullWanted && this.waiters.length > 0) {
      if (failure === undefined && result && !result.partial) {
        const late = this.waiters;
        this.waiters = [];
        this.fullWanted = false;
        this.set({ applying: false });
        for (const w of late) w.resolve(result);
      } else if (this.timer === undefined) {
        this.pump();
      }
    }
  }
}
