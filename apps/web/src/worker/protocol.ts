// The wire protocol between the main thread and the engine worker (SPEC 2/4/15).
// Plain, structured-cloneable messages only: a request id, a method name, args, and
// transferable ArrayBuffers (file bytes move to the worker, converted bytes move back,
// neither is copied). Progress events, errors as plain objects, and "host" calls - the
// worker asking the main thread to do something for it (the HTTP learn/repair call:
// the worker holds no network code, so file data and the masking key can never be
// sent by the worker itself).

export interface SerializedError {
  name: string;
  message: string;
  /** e.g. `unsupportedFileType` from the engine's reader. */
  code?: string;
}

export type MainToWorker =
  | { type: 'call'; id: number; method: string; args: unknown }
  | { type: 'hostResult'; id: number; cbId: number; ok: true; value: unknown }
  | { type: 'hostResult'; id: number; cbId: number; ok: false; error: SerializedError };

export type WorkerToMain =
  | { type: 'progress'; id: number; progress: unknown }
  | { type: 'host'; id: number; cbId: number; name: string; args: unknown[] }
  | { type: 'result'; id: number; value: unknown }
  | { type: 'error'; id: number; error: SerializedError };

export function serializeError(e: unknown): SerializedError {
  if (e instanceof Error) {
    const code = (e as { code?: unknown }).code;
    return typeof code === 'string' ? { name: e.name, message: e.message, code } : { name: e.name, message: e.message };
  }
  return { name: 'Error', message: typeof e === 'string' ? e : 'Unknown error' };
}
