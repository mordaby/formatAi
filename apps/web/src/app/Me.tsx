import type { AiLearnQuotaState, AuthProviderId, AuthRedirectError, MeUser, Tier } from '@formatai/shared';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { readAuthReturn, withoutAuthReturn } from '../api/auth';
import { webConfig } from '../config';
import { readLangCookie, useI18n } from '../i18n';
import { useServices } from '../services';
import { redirectTo } from './redirect';

/** What the API said when it sent the browser back (`?authError=` / `?linked=`), shown once in plain words. */
export type AuthNotice = { kind: 'error'; code: AuthRedirectError } | { kind: 'linked'; provider: AuthProviderId };

/**
 * Who is using the app (SPEC 12): the signed-in user or nobody, the providers the server can sign in with, and what is
 * left of the AI learns. Everything that depends on being signed in - the tier a learn is checked against, whether the
 * AI step may run, the account menu, My formats - reads this.
 */
/** A quota as a screen reports it: the server's whole state, or only what changed (none left, after a refusal) - `limit` then stays as known. */
export type AiQuotaUpdate = Omit<AiLearnQuotaState, 'limit'> & { limit?: number | null };

export interface Me {
  /** `loading` until `/api/me` has answered once. */
  status: 'loading' | 'ready';
  user: MeUser | null;
  /** `anonymous` until signed in, then the user's tier. */
  tier: Tier;
  /** The providers the server offers (Google first); `null` until known. */
  providers: AuthProviderId[] | null;
  /** What is left of the AI learns (null when unknown, or not signed in). */
  quota: AiLearnQuotaState | null;
  notice: AuthNotice | null;
  /** How many formats the signed-in user has saved (null: not signed in, or not known yet). Home offers "Run a format" first when there are some. */
  formatCount: number | null;
  /** Reads the format count again (after saving, renaming or deleting one). */
  refreshFormats(): Promise<void>;
  /** The format count, when a screen has just read the list itself. */
  setFormatCount(count: number): void;
  /** Reads `/api/me` again (after signing in or out somewhere else, or when a learn changed the quota). */
  refresh(): Promise<void>;
  /** POST /api/auth/logout. Resolves false when it did not work. */
  signOut(): Promise<boolean>;
  /**
   * A learn (or its outcome) reported the quota: show it. MERGED into what is known (API audit P2): an update without the user's `limit` (a
   * refusal that only says none are left) keeps the one the server said before.
   */
  setQuota(quota: AiQuotaUpdate | undefined): void;
  dismissNotice(): void;
  /** Starts linking the other provider: the browser goes to it and comes back with `?linked=`. Resolves false when it could not start. */
  linkProvider(provider: AuthProviderId): Promise<boolean>;
}

const MeContext = createContext<Me | null>(null);

export function useMe(): Me {
  const ctx = useContext(MeContext);
  if (!ctx) throw new Error('useMe must be used inside <MeProvider>');
  return ctx;
}

export function MeProvider({ children }: { children: ReactNode }) {
  const { api } = useServices();
  // Tests may hand over a partial Api: with no sign-in client, everyone is simply anonymous.
  const auth = api.auth as typeof api.auth | undefined;
  const { lang, setLang } = useI18n();
  const location = useLocation();
  const navigate = useNavigate();

  const [status, setStatus] = useState<Me['status']>('loading');
  const [user, setUser] = useState<MeUser | null>(null);
  const [providers, setProviders] = useState<AuthProviderId[] | null>(null);
  const [quota, setQuotaState] = useState<AiLearnQuotaState | null>(null);
  const [notice, setNotice] = useState<AuthNotice | null>(null);
  const [formatCount, setFormatCount] = useState<number | null>(null);

  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    if (!auth) {
      setStatus('ready');
      return;
    }
    try {
      const next = await auth.me();
      // (the same person again is not a change: nothing that reads `user` needs to run for it)
      if (alive.current) setUser((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
    } catch {
      // The server is unreachable: keep what we know (anonymous, at the start).
    } finally {
      if (alive.current) setStatus('ready');
    }
  }, [auth]);

  // First look: who am I, and which providers can I offer.
  useEffect(() => {
    void refresh();
    if (!auth) {
      setProviders([]);
      return;
    }
    auth
      .providers()
      .then((list) => {
        if (alive.current) setProviders(list);
      })
      .catch(() => {
        if (alive.current) setProviders([]);
      });
  }, [auth, refresh]);

  // DECISION: signing in (or out) in another tab - or a session that ran out - is noticed when the person comes back to this one, so a screen that
  // was waiting for a sign-in (the local result with "Sign in to finish") does not stay that way until a reload, which would lose it.
  const lastLook = useRef(Date.now());
  useEffect(() => {
    if (!auth) return;
    const look = (): void => {
      if (document.visibilityState === 'hidden') return;
      const now = Date.now();
      if (now - lastLook.current < webConfig.meRefreshMinGapMs) return;
      lastLook.current = now;
      void refresh();
    };
    document.addEventListener('visibilitychange', look);
    window.addEventListener('focus', look);
    return () => {
      document.removeEventListener('visibilitychange', look);
      window.removeEventListener('focus', look);
    };
  }, [auth, refresh]);

  // Coming back from the provider: read the answer once, say it, and clean the address bar.
  const returned = useRef(false);
  useEffect(() => {
    if (returned.current) return;
    const back = readAuthReturn(location.search);
    if (!back) return;
    returned.current = true;
    setNotice(back);
    navigate({ pathname: location.pathname, search: withoutAuthReturn(location.search), hash: location.hash }, { replace: true });
  }, [location, navigate]);

  // What is left of the AI learns, once we know who is signed in.
  const userId = user?.id ?? null;
  useEffect(() => {
    if (!userId || !auth) {
      setQuotaState(null);
      return;
    }
    let live = true;
    auth
      .quota()
      .then((q) => {
        if (live) setQuotaState(q);
      })
      .catch(() => {
        // Not shown until a learn reports it.
      });
    return () => {
      live = false;
    };
  }, [auth, userId]);

  // SPEC 16.2: the language is saved in the profile of a signed-in user. On a new device (no cookie) the profile decides; after
  // that the toggle does, and every change is saved. A failed save just leaves the profile as it was.
  const syncedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!user || !auth) {
      syncedFor.current = null;
      return;
    }
    if (syncedFor.current !== user.id) {
      syncedFor.current = user.id;
      if (user.uiLanguage && user.uiLanguage !== lang && readLangCookie() === undefined) {
        setLang(user.uiLanguage);
        return;
      }
    }
    if (user.uiLanguage !== lang) {
      auth
        .setLanguage(lang)
        .then((updated) => {
          if (updated && alive.current) setUser(updated);
        })
        .catch(() => undefined);
    }
  }, [user, auth, lang, setLang]);

  const registry = api.registry as typeof api.registry | undefined;
  const refreshFormats = useCallback(async () => {
    if (!registry) return;
    try {
      const list = await registry.listFormats();
      if (alive.current) setFormatCount(list.length);
    } catch {
      // unknown stays unknown
    }
  }, [registry]);
  useEffect(() => {
    if (!userId) {
      setFormatCount(null);
      return;
    }
    void refreshFormats();
  }, [userId, refreshFormats]);

  const signOut = useCallback(async () => {
    if (!auth) return false;
    try {
      await auth.logout();
    } catch {
      return false;
    }
    if (alive.current) {
      setUser(null);
      setQuotaState(null);
      setFormatCount(null);
    }
    return true;
  }, [auth]);

  const linkProvider = useCallback(
    async (provider: AuthProviderId) => {
      if (!auth) return false;
      try {
        const url = await auth.linkStart(provider, location.pathname);
        redirectTo(url);
        return true;
      } catch {
        return false;
      }
    },
    [auth, location.pathname],
  );

  const setQuota = useCallback((next: AiQuotaUpdate | undefined) => {
    if (next) setQuotaState((prev) => ({ limit: null, ...prev, ...next }));
  }, []);
  const dismissNotice = useCallback(() => setNotice(null), []);

  const value = useMemo<Me>(
    () => ({ status, user, tier: user?.tier ?? 'anonymous', providers, quota, notice, formatCount, refreshFormats, setFormatCount, refresh, signOut, setQuota, dismissNotice, linkProvider }),
    [status, user, providers, quota, notice, formatCount, refreshFormats, setFormatCount, refresh, signOut, setQuota, dismissNotice, linkProvider],
  );
  return <MeContext.Provider value={value}>{children}</MeContext.Provider>;
}
