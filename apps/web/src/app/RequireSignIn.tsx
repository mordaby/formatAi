import { Fragment, useEffect, useRef, type ReactNode } from 'react';
import { useI18n } from '../i18n';
import { useTrack } from '../services';
import { Button, InlineMessage, Spinner } from '../ui';
import { useMe } from './Me';
import { SignInButtons, useSignIn } from './SignIn';

/**
 * The screens that belong to an account (My formats, a format, adding a source): a visitor sees why and how to sign in instead
 * of an error, and the screen itself once someone is signed in.
 *
 * A session that ends while the screen is open (a save refused for it reads who is signed in again, and so does coming back to the tab)
 * does NOT take the screen away: what is on it - an Add-source learn, an AI format spent on it, unsaved edits - lives only in memory. It
 * stays, with the sign-in wall over it; the sign-in happens in a new tab, so this one is left exactly as it is, and coming back to it
 * (signed in) carries on where it was. Someone else signing in instead starts the screen afresh: the work was the other account's.
 */
export function RequireSignIn({ title, children }: { title: string; children: ReactNode }) {
  const me = useMe();
  const { t } = useI18n();
  const signIn = useSignIn();
  const track = useTrack();
  // Who the screen was opened for (the last signed-in user); null until someone was.
  const owner = useRef<string | null>(null);
  if (me.user) owner.current = me.user.id;
  // (signing out here is no session that ended: the screen is a visitor's from then on)
  else if (me.signedOut) owner.current = null;
  const expired = me.user === null && owner.current !== null;
  const { refresh } = me;

  // The visitor's page of this screen is a sign-in wall too (SPEC 14.1 `signin_wall_shown`, trigger `formats`): once per time it shows.
  const walled = me.user === null && !expired && me.status === 'ready';
  useEffect(() => {
    if (walled) track('signin_wall_shown', { trigger: 'formats' });
  }, [walled, track]);

  // The wall, once, when the session ends; and coming back to this tab (from the sign-in tab) reads who is signed in at once. The screen
  // going away (signing out goes home) takes its wall with it.
  useEffect(() => {
    if (!expired) return;
    signIn.open('expired', { newTab: true });
    const look = (): void => {
      if (document.visibilityState !== 'hidden') void refresh();
    };
    window.addEventListener('focus', look);
    document.addEventListener('visibilitychange', look);
    return () => {
      window.removeEventListener('focus', look);
      document.removeEventListener('visibilitychange', look);
      signIn.close();
    };
  }, [expired, signIn, refresh]);

  if (me.user || expired) {
    return (
      <Fragment key={owner.current ?? ''}>
        {expired ? (
          <div className="session-expired" data-testid="session-expired">
            <InlineMessage
              tone="warn"
              actions={
                <Button variant="primary" size="sm" onClick={() => signIn.open('expired', { newTab: true })}>
                  {t('header.signIn')}
                </Button>
              }
            >
              {t('signIn.expired')}
            </InlineMessage>
          </div>
        ) : null}
        {children}
      </Fragment>
    );
  }
  return (
    <main id="main" className="page" tabIndex={-1}>
      <section className="tool">
        <div className="view">
          <header className="tool__head">
            <h1>{title}</h1>
            {me.status === 'loading' ? (
              <p className="muted">
                <Spinner size={14} /> {t('formats.loading')}
              </p>
            ) : (
              <p className="lead">{t('signIn.formats')}</p>
            )}
          </header>
          {me.status === 'ready' ? <SignInButtons /> : null}
        </div>
      </section>
    </main>
  );
}
