import { useEffect, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { LanguageToggle } from '../components/LanguageToggle';
import { useI18n } from '../i18n';
import { AccountMenu, AuthNoticeBar } from './AccountMenu';
import { A11yProvider, useA11y } from './a11y/A11y';
import { AccessibilityWidget } from './a11y/AccessibilityWidget';
import { useDocumentTitle } from './documentTitle';
import { FeedbackProvider, useFeedback } from './Feedback';
import { useMe } from './Me';
import { useReducedMotion } from './useReducedMotion';

/**
 * The frame around every screen: skip link, header (wordmark, language toggle, sign in) and
 * footer, and the floating accessibility button. `<html dir>` is owned by the i18n provider, so everything in here simply follows it.
 * Screens render their own `<main id="main">`.
 */
export function Shell({ children }: { children: ReactNode }) {
  return (
    <A11yProvider>
      <FeedbackProvider>
        <ShellFrame>{children}</ShellFrame>
      </FeedbackProvider>
    </A11yProvider>
  );
}

function ShellFrame({ children }: { children: ReactNode }) {
  const { t, dir, lang } = useI18n();
  const { user } = useMe();
  const feedback = useFeedback();
  // Motion stops when the system asks for less (prefers-reduced-motion) and when the person turns it off in the accessibility panel.
  const systemReduced = useReducedMotion();
  const { prefs } = useA11y();
  const reduced = systemReduced || prefs.motion;
  useDocumentTitle();

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
            {user ? (
              <>
                <Link className="app-header__link" to="/convert">
                  {t('conv.nav')}
                </Link>
                <Link className="app-header__link" to="/formats">
                  {t('account.myFormats')}
                </Link>
              </>
            ) : null}
            <LanguageToggle />
            <AccountMenu />
          </div>
        </div>
      </header>
      <AuthNoticeBar />
      {children}
      <footer className="app-footer">
        <div className="app-footer__inner">
          <nav aria-label={t('footer.label')} className="app-footer__nav">
            <Link to="/business">{t('footer.business')}</Link>
            <Link to="/privacy">{t('footer.privacy')}</Link>
            <Link to="/terms">{t('footer.terms')}</Link>
            <Link to="/accessibility">{t('footer.accessibility')}</Link>
            <button type="button" className="app-footer__link" onClick={feedback.open}>
              {t('footer.feedback')}
            </button>
          </nav>
          <p className="app-footer__note">{t('app.tagline')}</p>
        </div>
      </footer>
      <AccessibilityWidget />
    </div>
  );
}
