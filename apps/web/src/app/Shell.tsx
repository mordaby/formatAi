import { useEffect, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { LanguageToggle } from '../components/LanguageToggle';
import { useI18n } from '../i18n';
import { Button } from '../ui';
import { useSignIn } from './SignIn';
import { useReducedMotion } from './useReducedMotion';

/**
 * The frame around every screen: skip link, header (wordmark, language toggle, sign in) and
 * footer. `<html dir>` is owned by the i18n provider, so everything in here simply follows it.
 * Screens render their own `<main id="main">`.
 */
export function Shell({ children }: { children: ReactNode }) {
  const { t, dir, lang } = useI18n();
  const signIn = useSignIn();
  const reduced = useReducedMotion();

  // Dialogs render in a portal outside this element, so the class also goes on <html>.
  useEffect(() => {
    document.documentElement.classList.toggle('reduce-motion', reduced);
    return () => document.documentElement.classList.remove('reduce-motion');
  }, [reduced]);

  return (
    <div className={reduced ? 'app reduce-motion' : 'app'} dir={dir} lang={lang} data-testid="app">
      <a className="skip-link" href="#main">
        {t('skip.toMain')}
      </a>
      <header className="app-header">
        <div className="app-header__inner">
          <Link className="wordmark" to="/" aria-label={t('app.name')}>
            <span aria-hidden="true">
              format<span className="wordmark__ai">AI</span>
            </span>
          </Link>
          <div className="app-header__actions">
            <LanguageToggle />
            <Button variant="secondary" size="sm" onClick={() => signIn.open('save')}>
              {t('header.signIn')}
            </Button>
          </div>
        </div>
      </header>
      {children}
      <footer className="app-footer">
        <div className="app-footer__inner">
          <nav aria-label={t('footer.label')} className="app-footer__nav">
            <Link to="/business">{t('footer.business')}</Link>
            <Link to="/privacy">{t('footer.privacy')}</Link>
            <Link to="/terms">{t('footer.terms')}</Link>
          </nav>
          <p className="app-footer__note">{t('app.tagline')}</p>
        </div>
      </footer>
    </div>
  );
}
