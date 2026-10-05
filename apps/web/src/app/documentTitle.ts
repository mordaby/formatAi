import { useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { useI18n, type MessageKey } from '../i18n';

/** The title key of a screen, by its address (WCAG 2.4.2: every page has a title that says what it is). */
export function titleKeyOf(pathname: string): MessageKey {
  if (pathname === '/formats') return 'title.formats';
  if (pathname.startsWith('/formats/')) return 'title.format';
  switch (pathname) {
    case '/result':
      return 'title.result';
    case '/convert':
    case '/batch':
      return 'title.convert';
    case '/business':
      return 'title.business';
    case '/privacy':
      return 'title.privacy';
    case '/terms':
      return 'title.terms';
    case '/accessibility':
      return 'title.accessibility';
    default:
      return 'title.home';
  }
}

/**
 * Keeps the browser tab's title in step with the screen and the language ("Privacy policy | formatAI"), and - when the address changes
 * (not on the first load) - moves the focus to the new screen's `<main>`, so a keyboard or screen-reader user lands on the new content instead
 * of on a link that is no longer there. (A change of the #hash alone, like the contents list's, is left to the browser.)
 */
export function useDocumentTitle(): void {
  const { t } = useI18n();
  const { pathname } = useLocation();
  const key = titleKeyOf(pathname);
  const title = key === 'title.home' ? t('app.name') : `${t(key)} | ${t('app.name')}`;

  useEffect(() => {
    document.title = title;
  }, [title]);

  const first = useRef(true);
  const previous = useRef(pathname);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (previous.current === pathname) return;
    previous.current = pathname;
    document.getElementById('main')?.focus({ preventScroll: false });
  }, [pathname]);
}
