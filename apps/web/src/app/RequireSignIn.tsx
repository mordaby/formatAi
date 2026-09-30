import type { ReactNode } from 'react';
import { useI18n } from '../i18n';
import { Spinner } from '../ui';
import { useMe } from './Me';
import { SignInButtons } from './SignIn';

/**
 * The screens that belong to an account (My formats, a format, adding a source): a visitor sees why and how to sign in instead
 * of an error, and the screen itself once someone is signed in.
 */
export function RequireSignIn({ title, children }: { title: string; children: ReactNode }) {
  const me = useMe();
  const { t } = useI18n();
  if (me.user) return <>{children}</>;
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
