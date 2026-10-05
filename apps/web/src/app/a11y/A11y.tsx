import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { A11Y_STORAGE_KEY, applyPrefs, DEFAULT_PREFS, readPrefs, writePrefs, type A11yPrefs } from './prefs';

export interface A11yApi {
  prefs: A11yPrefs;
  /** Changes one setting. */
  set<K extends keyof A11yPrefs>(key: K, value: A11yPrefs[K]): void;
  /** Back to the defaults (and nothing kept in storage). */
  reset(): void;
}

const A11yContext = createContext<A11yApi | null>(null);

export function useA11y(): A11yApi {
  const ctx = useContext(A11yContext);
  if (!ctx) throw new Error('useA11y must be used inside <A11yProvider>');
  return ctx;
}

/**
 * Holds the accessibility choices: they are put on <html> (so they reach the whole page, dialogs included) and kept in this browser's
 * localStorage. Another tab changing them is followed (`storage` event).
 */
export function A11yProvider({ children }: { children: ReactNode }) {
  const [prefs, setPrefs] = useState<A11yPrefs>(() => readPrefs());

  useEffect(() => {
    applyPrefs(prefs);
    writePrefs(prefs);
  }, [prefs]);

  useEffect(() => {
    const onStorage = (e: StorageEvent): void => {
      if (e.key === null || e.key === A11Y_STORAGE_KEY) setPrefs(readPrefs());
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const set = useCallback<A11yApi['set']>((key, value) => {
    setPrefs((p) => ({ ...p, [key]: value }));
  }, []);

  const reset = useCallback(() => {
    setPrefs({ ...DEFAULT_PREFS });
  }, []);

  const value = useMemo<A11yApi>(() => ({ prefs, set, reset }), [prefs, set, reset]);
  return <A11yContext.Provider value={value}>{children}</A11yContext.Provider>;
}
