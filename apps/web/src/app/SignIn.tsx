import type { AuthProviderId } from '@formatai/shared';
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { signInUrl } from '../api/auth';
import { useI18n, type MessageKey } from '../i18n';
import { useServices } from '../services';
import { Button, Dialog, InlineMessage, Spinner } from '../ui';
import { useMe } from './Me';
import { openInNewTab, redirectTo } from './redirect';

/** Why the wall opened: a plain "Sign in", "you ran into a limit", "finish with the AI step", "see your formats", or "your sign-in has ended". */
export type SignInReason = 'save' | 'download' | 'keepGoing' | 'ai' | 'formats' | 'expired';

/** `newTab`: the sign-in happens in a new tab and this page stays exactly as it is (a page whose work lives only in memory). */
export interface SignInOptions {
  newTab?: boolean;
}

export interface SignInApi {
  /** Opens the sign-in wall (SPEC 5 E). Does nothing when someone is already signed in. */
  open(reason?: SignInReason, opts?: SignInOptions): void;
  close(): void;
  /**
   * Sends the browser to the provider (and back to this page). What is registered with `setBeforeRedirect` runs first, so
   * what has been learned so far can be kept across the trip (SPEC 5 E). With `newTab`, the provider opens in a new tab instead and this
   * page is left alone (nothing to keep: it does not go anywhere); coming back to it reads who is signed in again.
   */
  start(provider: AuthProviderId, opts?: SignInOptions): Promise<void>;
  /**
   * The screen that holds the learned rules registers how to keep them; pass null to unregister. `reason` is why the wall was open when
   * the provider was chosen (null: it was not, e.g. the buttons of a popup): Home's "Learn with AI" opens the 'ai' wall, and that is the
   * learn to carry across the trip.
   */
  setBeforeRedirect(fn: ((trip: { reason: SignInReason | null }) => Promise<void>) | null): void;
}

const SignInContext = createContext<SignInApi | null>(null);

export function useSignIn(): SignInApi {
  const ctx = useContext(SignInContext);
  if (!ctx) throw new Error('useSignIn must be used inside <SignInProvider>');
  return ctx;
}

const REASON_TEXT: Record<SignInReason, MessageKey> = {
  save: 'signIn.save',
  download: 'signIn.download',
  keepGoing: 'signIn.keepGoing',
  ai: 'signIn.ai',
  formats: 'signIn.formats',
  expired: 'signIn.expired',
};

/** Owns the sign-in wall and the one way out of the app to a provider. */
export function SignInProvider({ children }: { children: ReactNode }) {
  const { api } = useServices();
  const me = useMe();
  const location = useLocation();
  const [state, setState] = useState<{ open: boolean; reason: SignInReason; newTab: boolean }>({ open: false, reason: 'save', newTab: false });
  const beforeRedirect = useRef<((trip: { reason: SignInReason | null }) => Promise<void>) | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  const meRef = useRef(me);
  meRef.current = me;
  const whereRef = useRef(location);
  whereRef.current = location;

  const open = useCallback((reason: SignInReason = 'save', opts?: SignInOptions) => {
    if (meRef.current.user) return;
    setState({ open: true, reason, newTab: opts?.newTab === true });
  }, []);
  const close = useCallback(() => setState((s) => ({ ...s, open: false })), []);
  const setBeforeRedirect = useCallback((fn: ((trip: { reason: SignInReason | null }) => Promise<void>) | null) => {
    beforeRedirect.current = fn;
  }, []);
  const start = useCallback(
    async (provider: AuthProviderId, opts?: SignInOptions) => {
      const at = whereRef.current;
      if (opts?.newTab) {
        openInNewTab(signInUrl(api.baseUrl, provider, `${at.pathname}${at.search}`));
        return;
      }
      try {
        await beforeRedirect.current?.({ reason: stateRef.current.open ? stateRef.current.reason : null });
      } catch {
        // Keeping the learned rules is a courtesy: a browser that will not store them must not stop the sign-in.
      }
      redirectTo(signInUrl(api.baseUrl, provider, `${at.pathname}${at.search}`));
    },
    [api],
  );

  const value = useMemo<SignInApi>(() => ({ open, close, start, setBeforeRedirect }), [open, close, start, setBeforeRedirect]);
  return (
    <SignInContext.Provider value={value}>
      {children}
      <SignInWall open={state.open && !me.user} reason={state.reason} newTab={state.newTab} onClose={close} />
    </SignInContext.Provider>
  );
}

/**
 * "Continue with Google" first, then "Continue with Microsoft" - only the providers the server offers (SPEC 12). Clicking
 * one navigates to the provider through the API, which brings the browser back here.
 */
export function SignInButtons({ primary = true, newTab = false }: { primary?: boolean; /** Sign in in a new tab: this page stays as it is. */ newTab?: boolean }) {
  const { t } = useI18n();
  const { providers } = useMe();
  const signIn = useSignIn();
  const [going, setGoing] = useState<AuthProviderId | null>(null);
  const [failed, setFailed] = useState(false);
  const [opened, setOpened] = useState(false);

  if (providers === null) {
    return (
      <p className="muted signin__status">
        <Spinner size={14} /> {t('signIn.loading')}
      </p>
    );
  }
  if (providers.length === 0) return <InlineMessage tone="info">{t('signIn.noProviders')}</InlineMessage>;

  const go = async (provider: AuthProviderId): Promise<void> => {
    setFailed(false);
    if (newTab) {
      // (this page does not go anywhere: the buttons stay, and say where the sign-in is)
      try {
        await signIn.start(provider, { newTab: true });
        setOpened(true);
      } catch {
        setFailed(true);
      }
      return;
    }
    setGoing(provider);
    try {
      await signIn.start(provider);
    } catch {
      setGoing(null);
      setFailed(true);
    }
  };

  return (
    <div className="signin__buttons">
      {providers.map((provider, i) => (
        <Button
          key={provider}
          variant={primary && i === 0 ? 'primary' : 'secondary'}
          block
          className="signin__button"
          disabled={going !== null}
          loading={going === provider}
          onClick={() => void go(provider)}
        >
          {t(provider === 'google' ? 'signIn.google' : 'signIn.microsoft')}
        </Button>
      ))}
      {going !== null && (
        <p className="muted" role="status">
          {t('signIn.going', { provider: t(going === 'google' ? 'provider.google' : 'provider.microsoft') })}
        </p>
      )}
      {newTab ? (
        <p className="muted" role="status">
          {opened ? t('signIn.newTab.opened') : null}
        </p>
      ) : null}
      {failed && <InlineMessage tone="error">{t('signIn.failed')}</InlineMessage>}
    </div>
  );
}

export interface SignInWallProps {
  open: boolean;
  reason?: SignInReason;
  /** The sign-in happens in a new tab: this page, and what is on it, stays as it is. */
  newTab?: boolean;
  onClose(): void;
}

/** SPEC 5 E: "Sign in to save this format and reuse it on next month's file." Google first, then Microsoft. */
export function SignInWall({ open, reason = 'save', newTab = false, onClose }: SignInWallProps) {
  const { t } = useI18n();
  return (
    <Dialog open={open} onClose={onClose} title={t('signIn.title')}>
      <p>{t(REASON_TEXT[reason])}</p>
      <SignInButtons newTab={newTab} />
      <p className="muted">{newTab ? t('signIn.newTab') : `${t('signIn.kept')} ${t('signIn.keptLocal')}`}</p>
    </Dialog>
  );
}
