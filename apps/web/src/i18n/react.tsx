import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  applyDocumentLang,
  codeText,
  directionOf,
  initialLang,
  otherLang,
  translate,
  writeLangCookie,
  type CodeMessage,
  type Direction,
  type Lang,
  type MessageParams,
} from './core';
import type { MessageKey } from './dictionaries';

export interface I18n {
  lang: Lang;
  /** Direction of the UI (follows the language). The sheet direction is separate. */
  dir: Direction;
  setLang(lang: Lang): void;
  /** Switch between Hebrew and English. */
  toggle(): void;
  t(key: MessageKey, params?: MessageParams): string;
  /** Text for a shared code (unsupported / assumption / pre-flight / flag). */
  code(msg: CodeMessage): string;
}

const I18nContext = createContext<I18n | null>(null);

export interface I18nProviderProps {
  /** Fixes the starting language (tests, or a saved profile). Default: cookie, then the browser language. */
  initial?: Lang;
  children: ReactNode;
}

export function I18nProvider({ initial, children }: I18nProviderProps) {
  const [lang, setLangState] = useState<Lang>(() => initial ?? initialLang());

  // Keeps <html lang dir> in step with the language (also on first render).
  useEffect(() => {
    applyDocumentLang(lang);
  }, [lang]);

  const setLang = useCallback((next: Lang) => {
    writeLangCookie(next);
    setLangState(next);
  }, []);

  const value = useMemo<I18n>(
    () => ({
      lang,
      dir: directionOf(lang),
      setLang,
      toggle: () => setLang(otherLang(lang)),
      t: (key, params) => translate(lang, key, params),
      code: (msg) => codeText(lang, msg),
    }),
    [lang, setLang],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18n {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error('useI18n must be used inside <I18nProvider>');
  return ctx;
}
