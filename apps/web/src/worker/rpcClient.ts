// The main-thread side of the worker RPC (SPEC 15: parse in a worker, with a timeout).
//
// - `call(method, args, opts)` -> Promise: request id, method, args, transferables.
// - Progress events go to `opts.onProgress`.
// - The worker may call back into `opts.host[name]` (e.g. the HTTP learn call): the
//   main thread does the network, the worker never does.
// - Worker errors arrive as plain objects and are rethrown as `RpcRemoteError`.
// - Timeout: if a call is still running after `timeoutMs` of worker-busy time, the
//   worker is terminated and re-created on the next call, and the call rejects with
//   `RpcTimeoutError`. The timer is paused while a host callback is in flight, so a
//   slow LLM response is never mistaken for a hung parser. A progress event may grant
//   the call more busy time (`opts.extraTimeOn`): work the caller knows is coming and
//   bounded (the learn's rounds of AI code checks) is not mistaken for a hang either.
// - `opts.signal` aborts the same way (terminate + restart).
//
// The worker is created lazily through `createWorker`, so tests can pass a fake and
// nothing spawns a real Worker until the first call.
import type { MainToWorker, SerializedError, WorkerToMain } from './protocol';

/** The few things the client needs from a worker; `handleFromWorker` adapts a real `Worker`. */
export interface WorkerHandle {
  post(message: MainToWorker, transfer?: Transferable[]): void;
  terminate(): void;
  /** Called once, right after creation. */
  listen(handlers: { message(data: WorkerToMain): void; error(message: string): void }): void;
}

export function handleFromWorker(worker: Worker): WorkerHandle {
  return {
    post: (message, transfer) => worker.postMessage(message, transfer ?? []),
    terminate: () => worker.terminate(),
    listen: ({ message, error }) => {
      worker.onmessage = (ev: MessageEvent) => message(ev.data as WorkerToMain);
      worker.onerror = (ev: ErrorEvent) => error(ev.message || 'Worker error');
      worker.onmessageerror = () => error('Worker message could not be deserialized');
    },
  };
}

export class RpcTimeoutError extends Error {
  readonly code = 'workerTimeout';
  constructor(
    readonly method: string,
    readonly timeoutMs: number,
  ) {
    super(`Worker call "${method}" timed out after ${timeoutMs} ms`);
    this.name = 'RpcTimeoutError';
  }
}

export class RpcAbortedError extends Error {
  readonly code = 'workerAborted';
  constructor(readonly method: string) {
    super(`Worker call "${method}" was cancelled`);
    this.name = 'RpcAbortedError';
  }
}

/** The worker died (uncaught error, failed to load) or was restarted under this call. */
export class RpcWorkerError extends Error {
  readonly code = 'workerCrashed';
  constructor(message: string) {
    super(message);
    this.name = 'RpcWorkerError';
  }
}

/** An error thrown inside the worker, rebuilt from its plain-object form. */
export class RpcRemoteError extends Error {
  readonly code: string | undefined;
  readonly remoteName: string;
  constructor(e: SerializedError) {
    super(e.message);
    this.name = 'RpcRemoteError';
    this.remoteName = e.name;
    this.code = e.code;
  }
}

export type HostFunctions = Record<string, (...args: never[]) => unknown>;

export interface CallOptions {
  transfer?: Transferable[];
  onProgress?: (progress: unknown) => void;
  /** Functions the worker may call on the main thread, by name. */
  host?: HostFunctions;
  /** Worker-busy time before the call is abandoned. Defaults to the client's `defaultTimeoutMs`. */
  timeoutMs?: number;
  /**
   * Worker-busy time a progress event grants the call on top of `timeoutMs`, in ms (0: none). Asked of every progress event, before
   * `onProgress`; while a host callback is in flight (the timer paused) the time is added for when it resumes.
   */
  extraTimeOn?: (progress: unknown) => number;
  signal?: AbortSignal;
}

export interface RpcClientOptions {
  createWorker: () => WorkerHandle;
  defaultTimeoutMs: number;
}

interface Pending {
  id: number;
  method: string;
  resolve(value: unknown): void;
  reject(error: Error): void;
  opts: CallOptions;
  timeoutMs: number;
  timer: ReturnType<typeof setTimeout> | undefined;
  /** Busy time still available, valid while the timer is paused. */
  remainingMs: number;
  armedAt: number;
  hostInFlight: number;
  cleanup: () => void;
}

export class RpcClient {
  private worker: WorkerHandle | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();

  constructor(private readonly options: RpcClientOptions) {}

  call<T = unknown>(method: string, args: unknown, opts: CallOptions = {}): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (opts.signal?.aborted) {
        reject(new RpcAbortedError(method));
        return;
      }
      const worker = this.ensureWorker();
      const id = this.nextId++;
      const timeoutMs = opts.timeoutMs ?? this.options.defaultTimeoutMs;
      const onAbort = (): void => this.failCall(id, new RpcAbortedError(method));
      const p: Pending = {
        id,
        method,
        resolve: resolve as (v: unknown) => void,
        reject,
        opts,
        timeoutMs,
        timer: undefined,
        remainingMs: timeoutMs,
        armedAt: 0,
        hostInFlight: 0,
        cleanup: () => opts.signal?.removeEventListener('abort', onAbort),
      };
      this.pending.set(id, p);
      opts.signal?.addEventListener('abort', onAbort, { once: true });
      this.arm(p, timeoutMs);
      try {
        worker.post({ type: 'call', id, method, args }, opts.transfer);
      } catch (e) {
        this.settle(p);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  /** Terminates the worker (if any). Pending calls reject; the next call creates a fresh worker. */
  terminate(): void {
    this.restartWorker(new RpcWorkerError('Worker was terminated'));
  }

  // ---------- internals ----------

  private ensureWorker(): WorkerHandle {
    if (this.worker) return this.worker;
    const worker = this.options.createWorker();
    this.worker = worker;
    worker.listen({
      message: (data) => {
        if (this.worker === worker) this.onMessage(data);
      },
      error: (message) => {
        if (this.worker === worker) this.restartWorker(new RpcWorkerError(message));
      },
    });
    return worker;
  }

  private onMessage(msg: WorkerToMain): void {
    const p = this.pending.get(msg.id);
    if (!p) return;
    switch (msg.type) {
      case 'progress': {
        const extra = p.opts.extraTimeOn?.(msg.progress) ?? 0;
        if (extra > 0) this.extend(p, extra);
        p.opts.onProgress?.(msg.progress);
        return;
      }
      case 'result':
        this.settle(p);
        p.resolve(msg.value);
        return;
      case 'error':
        this.settle(p);
        p.reject(new RpcRemoteError(msg.error));
        return;
      case 'host':
        void this.runHost(p, msg.cbId, msg.name, msg.args);
        return;
    }
  }

  private async runHost(p: Pending, cbId: number, name: string, args: unknown[]): Promise<void> {
    this.pause(p);
    p.hostInFlight++;
    let reply: MainToWorker;
    try {
      const fn = p.opts.host?.[name];
      if (!fn) throw Object.assign(new Error(`No host function "${name}"`), { code: 'unknownHost' });
      const value = await (fn as (...a: unknown[]) => unknown)(...args);
      reply = { type: 'hostResult', id: p.id, cbId, ok: true, value };
    } catch (e) {
      const code = (e as { code?: unknown } | null)?.code;
      reply = {
        type: 'hostResult',
        id: p.id,
        cbId,
        ok: false,
        error: {
          name: e instanceof Error ? e.name : 'Error',
          message: e instanceof Error ? e.message : String(e),
          ...(typeof code === 'string' ? { code } : {}),
        },
      };
    }
    // The call may have finished, timed out or been aborted while we waited.
    if (this.pending.get(p.id) !== p) return;
    p.hostInFlight--;
    if (p.hostInFlight === 0) this.arm(p, p.remainingMs);
    this.worker?.post(reply);
  }

  private arm(p: Pending, ms: number): void {
    p.remainingMs = ms;
    p.armedAt = Date.now();
    p.timer = setTimeout(() => this.failCall(p.id, new RpcTimeoutError(p.method, p.timeoutMs)), ms);
  }

  private pause(p: Pending): void {
    if (p.timer === undefined) return;
    clearTimeout(p.timer);
    p.timer = undefined;
    p.remainingMs = Math.max(0, p.remainingMs - (Date.now() - p.armedAt));
  }

  /** More busy time for a running call: added to what is left, the timer re-armed (or, paused, the time is there when it resumes). */
  private extend(p: Pending, ms: number): void {
    if (p.timer === undefined) {
      p.remainingMs += ms;
      return;
    }
    this.pause(p);
    this.arm(p, p.remainingMs + ms);
  }

  private settle(p: Pending): void {
    if (p.timer !== undefined) clearTimeout(p.timer);
    p.timer = undefined;
    p.cleanup();
    this.pending.delete(p.id);
  }

  /** Reject one call and treat the worker as stuck: terminate it and drop the other pending calls. */
  private failCall(id: number, error: Error): void {
    const p = this.pending.get(id);
    if (!p) return;
    this.settle(p);
    p.reject(error);
    this.restartWorker(new RpcWorkerError('Worker was restarted while this call was running'));
  }

  private restartWorker(reason: RpcWorkerError): void {
    const worker = this.worker;
    this.worker = null;
    worker?.terminate();
    for (const p of [...this.pending.values()]) {
      this.settle(p);
      p.reject(reason);
    }
  }
}
