// The worker side of the RPC: `serveMethods(scope, methods)` answers `call` messages by
// running the named method and posting back `result` / `error`. It knows nothing about
// the engine and touches no global, so the same code is unit-tested in-process against
// a fake scope and runs unchanged as the real worker's message loop (engine.worker.ts).
import { serializeError, type MainToWorker, type WorkerToMain } from './protocol';

export interface WorkerScopeLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(type: 'message', listener: (ev: { data: unknown }) => void): void;
}

export interface MethodContext {
  /** Post a progress event to the caller's `onProgress`. */
  progress(progress: unknown): void;
  /** Ask the main thread to run its host function `name` and await the answer. */
  host<T = unknown>(name: string, ...args: unknown[]): Promise<T>;
}

/** Return `new Transfer(value, [buffer])` from a method to move buffers instead of copying them. */
export class Transfer<T> {
  constructor(
    readonly value: T,
    readonly transfer: Transferable[],
  ) {}
}

// The args are validated by the typed client on the other side; `any` here is the
// usual heterogeneous-handler-map escape hatch, not a hole in the public API.
export type MethodMap = Record<string, (args: any, ctx: MethodContext) => unknown>;

interface HostWaiter {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

/** What a host call of a cancelled call is answered with (the method sees a normal rejection and ends). */
function cancelled(): Error {
  return Object.assign(new Error('The call was cancelled'), { name: 'AbortError', code: 'cancelled' });
}

export function serveMethods(scope: WorkerScopeLike, methods: MethodMap): void {
  const post = (message: WorkerToMain, transfer?: Transferable[]): void => scope.postMessage(message, transfer);
  const waiting = new Map<string, HostWaiter & { id: number }>();
  /** Calls the caller gave up on, until they end: what they still ask of the main thread is refused at once. */
  const gone = new Set<number>();
  let nextCb = 1;

  scope.addEventListener('message', (ev) => {
    const msg = ev.data as MainToWorker;
    if (msg.type === 'cancel') {
      gone.add(msg.id);
      for (const [key, w] of waiting) {
        if (w.id !== msg.id) continue;
        waiting.delete(key);
        w.reject(cancelled());
      }
      return;
    }
    if (msg.type === 'hostResult') {
      const key = `${msg.id}:${msg.cbId}`;
      const w = waiting.get(key);
      if (!w) return;
      waiting.delete(key);
      if (msg.ok) w.resolve(msg.value);
      else w.reject(Object.assign(new Error(msg.error.message), { name: msg.error.name, ...(msg.error.code ? { code: msg.error.code } : {}) }));
      return;
    }
    if (msg.type !== 'call') return;

    const { id, method } = msg;
    // The worker begins this call now: its timeout counts from here (it may have waited behind a long call).
    post({ type: 'started', id });
    const fn = methods[method];
    if (!fn) {
      post({ type: 'error', id, error: { name: 'Error', message: `Unknown method "${method}"`, code: 'unknownMethod' } });
      return;
    }
    const ctx: MethodContext = {
      progress: (progress) => post({ type: 'progress', id, progress }),
      host: (name, ...args) =>
        new Promise((resolve, reject) => {
          if (gone.has(id)) {
            reject(cancelled());
            return;
          }
          const cbId = nextCb++;
          waiting.set(`${id}:${cbId}`, { id, resolve: resolve as (v: unknown) => void, reject });
          post({ type: 'host', id, cbId, name, args });
        }),
    };
    // Promise.resolve().then: a synchronous throw inside a method also becomes an `error` message.
    Promise.resolve()
      .then(() => fn(msg.args, ctx))
      .then(
        (out) => {
          gone.delete(id);
          if (out instanceof Transfer) post({ type: 'result', id, value: out.value }, out.transfer);
          else post({ type: 'result', id, value: out });
        },
        (err: unknown) => {
          gone.delete(id);
          post({ type: 'error', id, error: serializeError(err) });
        },
      );
  });
}
