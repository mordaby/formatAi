import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { useI18n } from '../i18n';
import { Badge, Button, Dialog } from '../ui';

/** Why the wall opened: a plain "Sign in" (save the format) or "you ran into a limit". */
export type SignInReason = 'save' | 'keepGoing';

export interface SignInApi {
  /** Opens the sign-in wall (SPEC 5 E). */
  open(reason?: SignInReason): void;
  close(): void;
}

const SignInContext = createContext<SignInApi | null>(null);

export function useSignIn(): SignInApi {
  const ctx = useContext(SignInContext);
  if (!ctx) throw new Error('useSignIn must be used inside <SignInProvider>');
  return ctx;
}

/** Owns the sign-in wall. M3 replaces the two "coming soon" buttons with the real Google and Microsoft flows. */
export function SignInProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<{ open: boolean; reason: SignInReason }>({ open: false, reason: 'save' });
  const open = useCallback((reason: SignInReason = 'save') => setState({ open: true, reason }), []);
  const close = useCallback(() => setState((s) => ({ ...s, open: false })), []);
  const api = useMemo<SignInApi>(() => ({ open, close }), [open, close]);
  return (
    <SignInContext.Provider value={api}>
      {children}
      <SignInWall open={state.open} reason={state.reason} onClose={close} />
    </SignInContext.Provider>
  );
}

export interface SignInWallProps {
  open: boolean;
  reason?: SignInReason;
  onClose(): void;
}

/** SPEC 5 E: "Sign in to save this format and reuse it on next month's file." Google first, then Microsoft. */
export function SignInWall({ open, reason = 'save', onClose }: SignInWallProps) {
  const { t } = useI18n();
  return (
    <Dialog open={open} onClose={onClose} title={t('signIn.title')}>
      <p>{t(reason === 'save' ? 'signIn.save' : 'signIn.keepGoing')}</p>
      <div className="signin__buttons">
        <Button variant="secondary" block disabled className="signin__button">
          <span>{t('signIn.google')}</span>
          <Badge>{t('signIn.soon')}</Badge>
        </Button>
        <Button variant="secondary" block disabled className="signin__button">
          <span>{t('signIn.microsoft')}</span>
          <Badge>{t('signIn.soon')}</Badge>
        </Button>
      </div>
      <p className="muted">{t('signIn.soonNote')}</p>
      <p className="muted">{t('signIn.kept')}</p>
    </Dialog>
  );
}
