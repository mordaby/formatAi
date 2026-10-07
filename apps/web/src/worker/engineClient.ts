// The typed main-thread facade over the engine worker: learn / convert / verify.
// Owns the RpcClient and the default (real) Worker factory; tests inject a fake.
import { limits, type LearnResult, type Rules } from '@formatai/shared';
import { webConfig } from '../config';
import type { OneTimeCell } from '../editor/types';
import type {
  BatchArgs,
  BatchOutput,
  ColumnGapsArgs,
  ColumnGapsOutput,
  ConvertRunArgs,
  ConvertRunOutput,
  HeadersArgs,
  HeadersOutput,
  MatchFileArgs,
  MatchFileOutput,
  ConvertArgs,
  ConvertOutput,
  EngineMethodMap,
  EngineMethodName,
  InspectArgs,
  InspectOutput,
  LiveCheckResult,
  LoadExampleArgs,
  LoadExampleOutput,
  StaticCheckOptions,
  StaticProblem,
  LearnArgs,
  LearnHost,
  LearnOutput,
  LearnProgress,
  VerifyArgs,
  VerifyOutput,
} from './engineApi';
import { handleFromWorker, RpcClient, type HostFunctions, type WorkerHandle } from './rpcClient';

/** `exceptions`: 1-based example rows marked "fixed by hand". `subset`: false checks every row. */
export interface LiveCheckOptions {
  exceptions?: number[];
  /** SPEC 21 v12 item 20: cells the user said were a one-time change (one column each): not compared, listed apart. */
  oneTime?: OneTimeCell[];
  subset?: boolean;
  /** SPEC 21 v5 item 1: compare only these output columns (the local partial result). */
  onlyColumns?: number[];
}

export interface EngineCallOptions<P = never> {
  onProgress?: (progress: P) => void;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface EngineClient {
  learn(args: LearnArgs, host: LearnHost, opts?: EngineCallOptions<LearnProgress>): Promise<LearnOutput>;
  convert(args: ConvertArgs, opts?: EngineCallOptions): Promise<ConvertOutput>;
  verify(args: VerifyArgs, opts?: EngineCallOptions): Promise<VerifyOutput>;
  /** A quick look at one file (rows, columns), for the drop zones. */
  inspect(args: InspectArgs, opts?: EngineCallOptions): Promise<InspectOutput>;
  /**
   * The rules editor (SPEC 8.11). The example lives in the worker: `learn` returns its `exampleId`, or
   * `loadExample` reads the files again (example files are never stored). A call with an id the worker no
   * longer holds (it restarted) fails with code `exampleGone`.
   */
  loadExample(args: LoadExampleArgs, opts?: EngineCallOptions): Promise<LoadExampleOutput>;
  /** Runs the rules on the example: the live check (a subset above 5,000 rows unless `options.subset` is false). */
  liveCheck(exampleId: string, rules: LearnResult | Rules, options?: LiveCheckOptions, opts?: EngineCallOptions): Promise<LiveCheckResult>;
  /** The same check on every row (the editor's Apply). */
  fullCheck(exampleId: string, rules: LearnResult | Rules, options?: Omit<LiveCheckOptions, 'subset'>, opts?: EngineCallOptions): Promise<LiveCheckResult>;
  /** SPEC 9.2 layers 1-5 on the rules: structure, references, types, limits and (inside a format) the format lock. */
  staticChecks(rules: LearnResult | Rules, options: StaticCheckOptions, opts?: EngineCallOptions): Promise<StaticProblem[]>;
  /** Flow C (SPEC 5): the headers of a file's table. */
  readHeaders(args: HeadersArgs, opts?: EngineCallOptions): Promise<HeadersOutput>;
  /** Matches a file to the saved conversions (headers against signatures) and says whether one clearly wins. */
  matchFile(args: MatchFileArgs, opts?: EngineCallOptions): Promise<MatchFileOutput>;
  /** Which columns each conversion needs that a file (its headers, from matching) does not have: required ones, and used ones that are optional. Parses nothing. */
  columnGaps(args: ColumnGapsArgs, opts?: EngineCallOptions): Promise<ColumnGapsOutput>;
  /** Runs a conversion with per-run row decisions; in `review` mode stops before writing when rows need a look. */
  convertWithDecisions(args: ConvertRunArgs, opts?: EngineCallOptions): Promise<ConvertRunOutput>;
  /** Flow D (SPEC 5): packs converted files into a zip with the summary workbook. */
  batch(args: BatchArgs, opts?: EngineCallOptions): Promise<BatchOutput>;
  /** Kill the worker (e.g. on leaving the page). The next call starts a fresh one. */
  terminate(): void;
}

/** The real worker. The `new Worker(new URL(...), { type: 'module' })` form is what makes Vite bundle it as its own chunk. */
export function createRealWorker(): WorkerHandle {
  return handleFromWorker(new Worker(new URL('./engine.worker.ts', import.meta.url), { type: 'module' }));
}

export interface CreateEngineClientOptions {
  createWorker?: () => WorkerHandle;
  timeouts?: Partial<Record<EngineMethodName, number>>;
  /** Worker-busy time each round of AI code checks adds to the learn's timeout (default `CHECK_ROUND_ALLOWANCE_MS`). */
  checkRoundAllowanceMs?: number;
}

/**
 * AI code checks (learn-v9, SPEC 21 v14): the worker answers each round of checks on every row of the example, between two host calls, so
 * that time would count toward the learn's timeout like the analysis does. DECISION: each round grants the learn this much more busy time,
 * once, when it starts (the worker's progress `checkRound` with a new round number) - the most a round may take by its own caps, every check
 * of the round at its time budget. The learn's first try and the round for a list (a repair) each have their own rounds of checks, each
 * granted. A hung worker still times out: the allowance is bounded, and nothing else extends the learn.
 */
export const CHECK_ROUND_ALLOWANCE_MS = limits.learn.checks.timeBudgetMs * limits.learn.checks.maxChecksPerRound;

/** The busy time a learn's progress event grants: the allowance, once for each new round of AI code checks (of the first try, of a list's round). */
function checkRoundAllowance(allowanceMs: number): (progress: unknown) => number {
  const granted = new Map<string, number>();
  return (progress) => {
    const p = progress as LearnProgress;
    if (p.phase !== 'learning' || !p.checkRound) return 0;
    const n = p.checkRound.n;
    if (n <= (granted.get(p.attempt) ?? 0)) return 0;
    granted.set(p.attempt, n);
    return allowanceMs;
  };
}

function transfersOf(...files: { bytes: ArrayBuffer }[]): Transferable[] {
  return files.map((f) => f.bytes);
}

export function createEngineClient(options: CreateEngineClientOptions = {}): EngineClient {
  const timeouts: Record<EngineMethodName, number> = { ...webConfig.workerTimeoutMs, ...options.timeouts };
  const rpc = new RpcClient({
    createWorker: options.createWorker ?? createRealWorker,
    defaultTimeoutMs: Math.max(...Object.values(timeouts)),
  });

  function call<M extends EngineMethodName>(
    method: M,
    args: EngineMethodMap[M]['args'],
    transfer: Transferable[],
    opts: EngineCallOptions<EngineMethodMap[M]['progress']> | undefined,
    host?: HostFunctions,
    extraTimeOn?: (progress: unknown) => number,
  ): Promise<EngineMethodMap[M]['result']> {
    return rpc.call(method, args, {
      transfer,
      timeoutMs: opts?.timeoutMs ?? timeouts[method],
      ...(opts?.signal ? { signal: opts.signal } : {}),
      ...(opts?.onProgress ? { onProgress: (p: unknown) => opts.onProgress?.(p as EngineMethodMap[M]['progress']) } : {}),
      ...(host ? { host } : {}),
      ...(extraTimeOn ? { extraTimeOn } : {}),
    });
  }

  return {
    learn: (args, host, opts) =>
      call(
        'learn',
        args,
        transfersOf(args.input, args.output),
        opts,
        { callLearn: host.callLearn, callRepair: host.callRepair, callStep: host.callStep } as unknown as HostFunctions,
        checkRoundAllowance(options.checkRoundAllowanceMs ?? CHECK_ROUND_ALLOWANCE_MS),
      ),
    convert: (args, opts) => call('convert', args, transfersOf(args.file), opts),
    verify: (args, opts) => call('verify', args, transfersOf(args.input, args.output), opts),
    inspect: (args, opts) => call('inspect', args, transfersOf(args.file), opts),
    loadExample: (args, opts) => call('loadExample', args, transfersOf(args.input, args.output), opts),
    liveCheck: (exampleId, rules, options, opts) =>
      call('liveCheck', { exampleId, rules, ...(options?.exceptions ? { exceptions: options.exceptions } : {}), ...(options?.oneTime && options.oneTime.length > 0 ? { oneTime: options.oneTime } : {}), ...(options?.onlyColumns ? { onlyColumns: options.onlyColumns } : {}), ...(options?.subset === undefined ? {} : { subset: options.subset }) }, [], opts),
    fullCheck: (exampleId, rules, options, opts) =>
      call('fullCheck', { exampleId, rules, ...(options?.exceptions ? { exceptions: options.exceptions } : {}), ...(options?.oneTime && options.oneTime.length > 0 ? { oneTime: options.oneTime } : {}), ...(options?.onlyColumns ? { onlyColumns: options.onlyColumns } : {}) }, [], opts),
    staticChecks: (rules, options, opts) => call('staticChecks', { rules, ...options }, [], opts),
    readHeaders: (args, opts) => call('readHeaders', args, transfersOf(args.file), opts),
    matchFile: (args, opts) => call('matchFile', args, transfersOf(args.file), opts),
    columnGaps: (args, opts) => call('columnGaps', args, [], opts),
    convertWithDecisions: (args, opts) => call('convertWithDecisions', args, transfersOf(args.file), opts),
    batch: (args, opts) => call('batch', args, args.outputs.map((o) => o.bytes), opts),
    terminate: () => rpc.terminate(),
  };
}

let shared: EngineClient | undefined;
/** The app-wide engine client; its worker is only spawned on the first call. */
export function getEngine(): EngineClient {
  return (shared ??= createEngineClient());
}
