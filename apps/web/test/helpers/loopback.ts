import { RpcClient, type WorkerHandle } from '../../src/worker/rpcClient';
import type { WorkerToMain } from '../../src/worker/protocol';
import { serveMethods, type WorkerScopeLike } from '../../src/worker/runtime';

/**
 * Both ends of the worker RPC in one thread: the real worker-side runtime (serveMethods)
 * wired to the real RpcClient through a loopback that structured-clones every message
 * (and honours transfer lists), as postMessage does.
 */
export function loopbackWorker(methods: Parameters<typeof serveMethods>[1]): WorkerHandle {
  let toWorker: ((ev: { data: unknown }) => void) | undefined;
  let toMain: { message(data: WorkerToMain): void; error(message: string): void } | undefined;

  const scope: WorkerScopeLike = {
    postMessage: (message, transfer) => {
      const cloned = structuredClone(message, transfer ? { transfer } : undefined) as WorkerToMain;
      queueMicrotask(() => toMain?.message(cloned));
    },
    addEventListener: (_type, listener) => {
      toWorker = listener;
    },
  };
  serveMethods(scope, methods);

  return {
    post: (message, transfer) => {
      const cloned = structuredClone(message, transfer ? { transfer } : undefined);
      queueMicrotask(() => toWorker?.({ data: cloned }));
    },
    terminate: () => {},
    listen: (handlers) => {
      toMain = handlers;
    },
  };
}

export function loopback(methods: Parameters<typeof serveMethods>[1]) {
  const handle = loopbackWorker(methods);
  return new RpcClient({ createWorker: () => handle, defaultTimeoutMs: 5000 });
}
