// The typed main-thread facade over the engine worker: learn / convert / verify.
// Owns the RpcClient and the default (real) Worker factory; tests inject a fake.
import type { LearnResult, Rules } from '@formatai/shared';
import { webConfig } from '../config';
import type {
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
  subset?: boolean;
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
  fullCheck(exampleId: string, rules: LearnResult | Rules, options?: { exceptions?: number[] }, opts?: EngineCallOptions): Promise<LiveCheckResult>;
  /** SPEC 9.2 layers 1-5 on the rules: structure, references, types, limits and (inside a format) the format lock. */
  staticChecks(rules: LearnResult | Rules, options: StaticCheckOptions, opts?: EngineCallOptions): Promise<StaticProblem[]>;
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
  ): Promise<EngineMethodMap[M]['result']> {
    return rpc.call(method, args, {
      transfer,
      timeoutMs: opts?.timeoutMs ?? timeouts[method],
      ...(opts?.signal ? { signal: opts.signal } : {}),
      ...(opts?.onProgress ? { onProgress: (p: unknown) => opts.onProgress?.(p as EngineMethodMap[M]['progress']) } : {}),
      ...(host ? { host } : {}),
    });
  }

  return {
    learn: (args, host, opts) =>
      call('learn', args, transfersOf(args.input, args.output), opts, {
        callLearn: host.callLearn,
        callRepair: host.callRepair,
      } as unknown as HostFunctions),
    convert: (args, opts) => call('convert', args, transfersOf(args.file), opts),
    verify: (args, opts) => call('verify', args, transfersOf(args.input, args.output), opts),
    inspect: (args, opts) => call('inspect', args, transfersOf(args.file), opts),
    loadExample: (args, opts) => call('loadExample', args, transfersOf(args.input, args.output), opts),
    liveCheck: (exampleId, rules, options, opts) =>
      call('liveCheck', { exampleId, rules, ...(options?.exceptions ? { exceptions: options.exceptions } : {}), ...(options?.subset === undefined ? {} : { subset: options.subset }) }, [], opts),
    fullCheck: (exampleId, rules, options, opts) =>
      call('fullCheck', { exampleId, rules, ...(options?.exceptions ? { exceptions: options.exceptions } : {}) }, [], opts),
    staticChecks: (rules, options, opts) => call('staticChecks', { rules, ...options }, [], opts),
    terminate: () => rpc.terminate(),
  };
}

let shared: EngineClient | undefined;
/** The app-wide engine client; its worker is only spawned on the first call. */
export function getEngine(): EngineClient {
  return (shared ??= createEngineClient());
}
