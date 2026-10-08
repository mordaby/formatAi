import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  applyDocumentLang,
  codeText,
  directionOf,
  initialLang,
  interpolate,
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

export interface I18nWordingProps {
  /** Message texts to say instead of the dictionaries', per language (with the same `{param}` placeholders). Null: as the dictionaries say. */
  messages: { en: Partial<Record<MessageKey, string>>; he: Partial<Record<MessageKey, string>> } | null;
  /** A shared code's text to say instead (undefined from it: as the shared messages say). */
  code?: ((lang: Lang, msg: CodeMessage) => string | undefined) | undefined;
  children: ReactNode;
}

/**
 * Another wording for the screens under it (the input wording while "Formats with several sources" is off, app/Features.tsx): the same
 * language and direction, with these texts over the dictionaries'.
 */
export function I18nWording({ messages, code, children }: I18nWordingProps) {
  const base = useI18n();
  const value = useMemo<I18n>(() => {
    if (!messages && !code) return base;
    const own = messages?.[base.lang];
    return {
      ...base,
      t: (key, params) => {
        const text = own?.[key];
        return text !== undefined ? interpolate(text, params) : base.t(key, params);
      },
      code: (msg) => code?.(base.lang, msg) ?? base.code(msg),
    };
  }, [base, messages, code]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}
