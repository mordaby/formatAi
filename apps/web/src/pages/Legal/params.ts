// The values the legal texts fill into their `{tokens}` (i18n/legal.ts): all of them from config - the numbers from `limits`, the names and
// addresses from `webConfig.legal` - so a policy can never say 40 rows while the code says 30, and the owner fills a placeholder in one place.
import { limits } from '@formatai/shared';
import { webConfig } from '../../config';
import { interpolate, type Lang } from '../../i18n';

export type LegalParams = Record<string, string | number>;

/** The date, in the language of the page ("5 באוקטובר 2026" / "5 October 2026"). */
export function legalDate(lang: Lang, iso: string = webConfig.legal.updated): string {
  return new Intl.DateTimeFormat(lang === 'he' ? 'he-IL' : 'en-GB', { dateStyle: 'long', timeZone: 'UTC' }).format(new Date(`${iso}T00:00:00Z`));
}

export function legalParams(lang: Lang): LegalParams {
  const legal = webConfig.legal;
  return {
    operator: legal.operator[lang],
    contactEmail: legal.contactEmail,
    jurisdiction: legal.jurisdiction[lang],
    hosting: legal.hosting[lang],
    a11yCoordinator: legal.accessibility.coordinator[lang],
    a11yEmail: legal.accessibility.email,
    a11yPhone: legal.accessibility.phone[lang],
    date: legalDate(lang),
    // what AI learning sends (SPEC 7.3): the same numbers the payload is capped with
    pairs: limits.payload.maxPairs,
    dropped: limits.payload.maxDropped,
    rounds: limits.learn.loop.maxRounds,
    rows: limits.learn.loop.maxRowsTotal,
    // how long things live
    cacheDays: limits.cache.ttlDays,
    sessionDays: limits.auth.sessionDays,
    cookieDays: limits.protection.anonCookieMaxAgeDays,
    llmMonths: legal.retentionMonths.aiCallRecords,
    formsMonths: legal.retentionMonths.forms,
  };
}

/** A legal string with its `{tokens}` filled in. */
export function fillLegal(text: string, params: LegalParams): string {
  return interpolate(text, params);
}
