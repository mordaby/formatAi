// Framework-free i18n core (SPEC 16.2): language detection, cookie, <html lang dir>,
// and typed message lookup. No dependencies; React glue is in ./react.tsx.
import {
  aiAttemptsExhaustedMessages,
  aiLearnsLimitMessages,
  apiErrorMessages,
  assumptionMessages,
  flagMessages,
  limitMessages,
  preflightBlockMessages,
  preflightWarnMessages,
  unsupportedMessages,
  type ApiErrorCode,
  type AiLearnPeriod,
  type AssumptionReasonCode,
  type FlagMessageKey,
  type LimitCode,
  type Localized,
  type PreflightBlockReason,
  type PreflightWarnReason,
  type UnsupportedReasonCode,
} from '@formatai/shared';
import { webConfig } from '../config';
import { en, he, type MessageKey } from './dictionaries';

export type Lang = 'he' | 'en';
export type Direction = 'rtl' | 'ltr';
export const LANGS: readonly Lang[] = ['he', 'en'];

const dictionaries: Record<Lang, Record<MessageKey, string>> = { en, he };

export function isLang(value: unknown): value is Lang {
  return value === 'he' || value === 'en';
}

/** SPEC 16.2: `<html dir>` follows the UI language. (The sheet's own direction is separate: see SheetDirection.) */
export function directionOf(lang: Lang): Direction {
  return lang === 'he' ? 'rtl' : 'ltr';
}

/** The other language, for the header toggle. */
export function otherLang(lang: Lang): Lang {
  return lang === 'he' ? 'en' : 'he';
}

// ---------- detection ----------

/** 'he', 'he-IL' and the legacy 'iw' mean Hebrew; 'en', 'en-US'... mean English. */
function langOfTag(tag: string): Lang | undefined {
  const primary = tag.toLowerCase().split(/[-_]/)[0];
  if (primary === 'he' || primary === 'iw') return 'he';
  if (primary === 'en') return 'en';
  return undefined;
}

export interface LangSources {
  /** The saved cookie value, if any. */
  cookie?: string | undefined;
  /** `navigator.languages` (preferred first) or `[navigator.language]`. */
  languages?: readonly string[] | undefined;
}

/**
 * SPEC 16.2: the saved choice wins; otherwise the first browser language we support;
 * otherwise English.
 */
export function detectLang(sources: LangSources): Lang {
  if (isLang(sources.cookie)) return sources.cookie;
  for (const tag of sources.languages ?? []) {
    const lang = langOfTag(tag);
    if (lang) return lang;
  }
  return 'en';
}

export function browserLanguages(nav: Pick<Navigator, 'language' | 'languages'> | undefined = typeof navigator === 'undefined' ? undefined : navigator): string[] {
  if (!nav) return [];
  if (nav.languages && nav.languages.length > 0) return [...nav.languages];
  return nav.language ? [nav.language] : [];
}

// ---------- cookie ----------

type CookieDoc = Pick<Document, 'cookie'>;

export function readLangCookie(doc: CookieDoc = document): string | undefined {
  const name = `${webConfig.languageCookie.name}=`;
  for (const part of doc.cookie.split(';')) {
    const trimmed = part.trim();
    if (trimmed.startsWith(name)) return decodeURIComponent(trimmed.slice(name.length)) || undefined;
  }
  return undefined;
}

export function writeLangCookie(lang: Lang, doc: CookieDoc = document): void {
  const { name, maxAgeSeconds } = webConfig.languageCookie;
  doc.cookie = `${name}=${encodeURIComponent(lang)}; Path=/; Max-Age=${maxAgeSeconds}; SameSite=Lax`;
}

/** The language for this browser right now: cookie, then browser language, then English. */
export function initialLang(): Lang {
  return detectLang({ cookie: readLangCookie(), languages: browserLanguages() });
}

// ---------- <html lang dir> ----------

export function applyDocumentLang(lang: Lang, root: HTMLElement = document.documentElement): void {
  root.lang = lang;
  root.dir = directionOf(lang);
}

// ---------- lookup ----------

export type MessageParams = Record<string, string | number>;

/** Fills `{name}` placeholders; a placeholder without a param is left as written. */
export function interpolate(template: string, params?: MessageParams): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => (name in params ? String(params[name]) : whole));
}

export function translate(lang: Lang, key: MessageKey, params?: MessageParams): string {
  return interpolate(dictionaries[lang][key], params);
}

export function localize(lang: Lang, text: Localized, params?: MessageParams): string {
  return interpolate(text[lang], params);
}

/** The shared package's code vocabularies, resolved to text in `lang`. */
export type CodeMessage =
  | { kind: 'unsupported'; code: UnsupportedReasonCode }
  | { kind: 'assumption'; code: AssumptionReasonCode }
  | { kind: 'preflight'; code: PreflightBlockReason | PreflightWarnReason; params?: MessageParams }
  | { kind: 'flag'; code: FlagMessageKey | (string & {}); params?: MessageParams }
  /** An API error code; `limitHit` is shown as the text for its specific `limit` when there is one. */
  | { kind: 'apiError'; code: ApiErrorCode; limit?: LimitCode | undefined; period?: AiLearnPeriod | undefined; counted?: boolean | undefined };

export function codeText(lang: Lang, msg: CodeMessage): string {
  switch (msg.kind) {
    case 'unsupported':
      return localize(lang, unsupportedMessages[msg.code]);
    case 'assumption':
      return localize(lang, assumptionMessages[msg.code]);
    case 'preflight': {
      const block = (preflightBlockMessages as Record<string, Localized>)[msg.code];
      const warn = (preflightWarnMessages as Record<string, Localized>)[msg.code];
      const text = block ?? warn;
      return text ? localize(lang, text, msg.params) : msg.code;
    }
    case 'apiError': {
      // SPEC 21 v5: the AI-learn quota and the failed-attempt stop each say more than the generic text.
      if (msg.code === 'limitHit' && msg.limit === 'aiLearns' && msg.period && msg.period !== 'unlimited') return localize(lang, aiLearnsLimitMessages[msg.period]);
      if (msg.code === 'aiAttemptsExhausted' && msg.counted !== undefined) return localize(lang, aiAttemptsExhaustedMessages[msg.counted ? 'counted' : 'notCounted']);
      return localize(lang, msg.code === 'limitHit' && msg.limit ? limitMessages[msg.limit] : apiErrorMessages[msg.code]);
    }
    case 'flag': {
      const text = (flagMessages as Record<string, Localized>)[msg.code];
      // Flag keys come from the engine; an unknown key shows as itself rather than crashing the page.
      return text ? localize(lang, text, msg.params) : msg.code;
    }
  }
}
