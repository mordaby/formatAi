// Saving from the Result screen (SPEC 5 A step 8, A2, 8.11 "Saving", 11): one small state machine for "keep it on the server". What is
// saved (a new format, a new source, new rules for a source) is the caller's `persist` function; this file owns the busy state and the way
// failures are told. It never downloads anything: the file is its own button (`useDownload`).
import type { AiLearnPeriod, ApiProblem, LimitCode } from '@formatai/shared';
import { useCallback, useRef, useState } from 'react';
import { ApiError, type ApiFailureCode } from '../../api';

export type SaveFailure = {
  kind: 'api';
  code: ApiFailureCode;
  limit?: LimitCode | undefined;
  period?: AiLearnPeriod | undefined;
  counted?: boolean | undefined;
  problems?: ApiProblem[] | undefined;
};

export type SaveState<T = unknown> =
  | { status: 'idle' }
  | { status: 'saving' }
  | { status: 'saved'; value: T }
  | { status: 'error'; error: SaveFailure };

export function toSaveFailure(e: unknown): SaveFailure {
  if (e instanceof ApiError) return { kind: 'api', code: e.code, limit: e.limit, period: e.period, counted: e.counted, problems: e.problems };
  return { kind: 'api', code: 'unknown' };
}

export interface SaveRunOptions<T> {
  /** Writes to the server. A rejection is told to the user as it is (a limit, a mismatch, a name in use...). */
  persist(): Promise<T>;
  /** After a successful `persist`: e.g. tell the server the learn was saved with accepted differences. Never blocks or fails the save. */
  afterSaved?(value: T): void;
}

export interface UseSave<T> {
  state: SaveState<T>;
  run(options: SaveRunOptions<T>): Promise<void>;
  reset(): void;
}

export function useSave<T = unknown>(): UseSave<T> {
  const [state, setState] = useState<SaveState<T>>({ status: 'idle' });
  const busy = useRef(false);

  const run = useCallback(async (options: SaveRunOptions<T>) => {
    if (busy.current) return;
    busy.current = true;
    setState({ status: 'saving' });
    try {
      let value: T;
      try {
        value = await options.persist();
      } catch (e) {
        setState({ status: 'error', error: toSaveFailure(e) });
        return;
      }
      try {
        options.afterSaved?.(value);
      } catch {
        // best effort
      }
      setState({ status: 'saved', value });
    } finally {
      busy.current = false;
    }
  }, []);

  const reset = useCallback(() => setState({ status: 'idle' }), []);
  return { state, run, reset };
}
