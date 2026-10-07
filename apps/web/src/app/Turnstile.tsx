import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useI18n } from '../i18n';
import { useServices } from '../services';
import { readSession } from './Features';
import { TurnstileController } from './turnstileController';

export interface TurnstileApi {
  /** A fresh Turnstile token for one learn call; `undefined` when Turnstile is off (no site key) or no token came in time. Stable identity. */
  getToken(): Promise<string | undefined>;
  /** Set once `/api/session` has answered and reported a site key. */
  controller: TurnstileController | undefined;
  /** The site key `/api/session` reported (undefined: Turnstile is off, or the session has not answered yet): what a form's own widget is made from (see `useFormTurnstile`). */
  siteKey: string | undefined;
  /** Settles once `/api/session` has answered (or failed): a form waits for it before it asks for a token. Stable identity. */
  sessionKnown(): Promise<void>;
}

const TurnstileContext = createContext<TurnstileApi | null>(null);

export function useTurnstile(): TurnstileApi {
  const ctx = useContext(TurnstileContext);
  if (!ctx) throw new Error('useTurnstile must be used inside <TurnstileProvider>');
  return ctx;
}

/** Like `useTurnstile`, but `null` outside a provider: a form shown in a partial tree (a test) simply has no widget. */
export function useOptionalTurnstile(): TurnstileApi | null {
  return useContext(TurnstileContext);
}

/**
 * Asks `/api/session` once for the anonymous visitor's limits and the Turnstile site key. Only
 * when a key comes back is Cloudflare's script ever loaded (by <TurnstileSlot>); in dev, without
 * a key, nothing is loaded and learns go without a token.
 */
export function TurnstileProvider({ children }: { children: ReactNode }) {
  const { api } = useServices();
  const { lang } = useI18n();
  const langRef = useRef<string>(lang);
  langRef.current = lang;

  const [controller, setController] = useState<TurnstileController | undefined>(undefined);
  const [siteKey, setSiteKey] = useState<string | undefined>(undefined);
  const controllerRef = useRef<TurnstileController | undefined>(undefined);
  const sessionRef = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    let alive = true;
    // (the same answer the feature switches are read from: asked once)
    sessionRef.current = readSession(api)
      .then((session) => {
        if (!alive) return;
        const key = session.turnstileSiteKey;
        const next = key ? new TurnstileController({ siteKey: key, getLanguage: () => langRef.current }) : undefined;
        controllerRef.current = next;
        setController(next);
        setSiteKey(key || undefined);
      })
      // The API being unreachable is reported where it matters: when the learn itself is sent.
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [api]);

  const getToken = useCallback(async (): Promise<string | undefined> => {
    await sessionRef.current;
    return controllerRef.current?.getToken();
  }, []);

  const sessionKnown = useCallback(() => sessionRef.current, []);

  const value = useMemo<TurnstileApi>(() => ({ getToken, controller, siteKey, sessionKnown }), [getToken, controller, siteKey, sessionKnown]);
  return <TurnstileContext.Provider value={value}>{children}</TurnstileContext.Provider>;
}

/** Where the widget lives (next to the learn button). Empty, and invisible, unless Cloudflare asks the visitor for something. */
export function TurnstileSlot() {
  const { controller } = useTurnstile();
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!controller || !box.current) return;
    return controller.attach(box.current);
  }, [controller]);
  return <div className="turnstile" ref={box} data-turnstile={controller ? 'on' : 'off'} />;
}
