import { useCallback, useEffect, useRef, useState } from 'react';
import { isApiError, type ApiFailureCode } from '../api';

export type Loaded<T> =
  | { status: 'loading' }
  | { status: 'ready'; data: T }
  | { status: 'error'; code: ApiFailureCode | 'other' };

export interface UseLoad<T> {
  state: Loaded<T>;
  /** Loads again (the old data stays on screen until the new arrives). */
  reload(): void;
  /** Replace the data without a request (after an edit whose answer is known). An updater function does nothing until there is data. */
  set(data: T | ((old: T) => T)): void;
}

/** A small "load this when the screen opens" hook: aborts on leaving, keeps the last data while reloading. */
export function useLoad<T>(load: (signal: AbortSignal) => Promise<T>, deps: readonly unknown[], enabled = true): UseLoad<T> {
  const [state, setState] = useState<Loaded<T>>({ status: 'loading' });
  const [tick, setTick] = useState(0);
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    if (!enabled) return;
    const abort = new AbortController();
    loadRef
      .current(abort.signal)
      .then((data) => {
        if (!abort.signal.aborted) setState({ status: 'ready', data });
      })
      .catch((e: unknown) => {
        if (abort.signal.aborted || (e instanceof DOMException && e.name === 'AbortError')) return;
        setState({ status: 'error', code: isApiError(e) ? e.code : 'other' });
      });
    return () => abort.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, tick, ...deps]);

  const reload = useCallback(() => setTick((n) => n + 1), []);
  const set = useCallback((data: T | ((old: T) => T)) => {
    setState((s) => {
      if (typeof data !== 'function') return { status: 'ready', data };
      return s.status === 'ready' ? { status: 'ready', data: (data as (old: T) => T)(s.data) } : s;
    });
  }, []);
  return { state, reload, set };
}
