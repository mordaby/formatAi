// The typed main-thread facade over the engine worker: learn / convert / verify.
// Owns the RpcClient and the default (real) Worker factory; tests inject a fake.
import { webConfig } from '../config';
import type {
  ConvertArgs,
  ConvertOutput,
  EngineMethodMap,
  EngineMethodName,
  LearnArgs,
  LearnHost,
  LearnOutput,
  LearnProgress,
  VerifyArgs,
  VerifyOutput,
} from './engineApi';
import { handleFromWorker, RpcClient, type HostFunctions, type WorkerHandle } from './rpcClient';

export interface EngineCallOptions<P = never> {
  onProgress?: (progress: P) => void;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface EngineClient {
  learn(args: LearnArgs, host: LearnHost, opts?: EngineCallOptions<LearnProgress>): Promise<LearnOutput>;
  convert(args: ConvertArgs, opts?: EngineCallOptions): Promise<ConvertOutput>;
  verify(args: VerifyArgs, opts?: EngineCallOptions): Promise<VerifyOutput>;
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
    terminate: () => rpc.terminate(),
  };
}

let shared: EngineClient | undefined;
/** The app-wide engine client; its worker is only spawned on the first call. */
export function getEngine(): EngineClient {
  return (shared ??= createEngineClient());
}
