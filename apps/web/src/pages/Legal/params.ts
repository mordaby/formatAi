// The values the legal texts fill into their `{tokens}` (i18n/legal.ts): all of them from config - the numbers from `limits`, the names and
// addresses from `webConfig.legal` - so a policy can never say 40 rows while the code says 30, and the owner fills a placeholder in one place.
import { limits } from '@formatai/shared';
import { webConfig } from '../../config';
import { interpolate, type Lang } from '../../i18n';
import type { LegalPageId } from '../../i18n/legal';

export type LegalParams = Record<string, string | number>;

/** The date, in the language of the page ("5 באוקטובר 2026" / "5 October 2026"). */
export function legalDate(lang: Lang, iso: string): string {
  return new Intl.DateTimeFormat(lang === 'he' ? 'he-IL' : 'en-GB', { dateStyle: 'long', timeZone: 'UTC' }).format(new Date(`${iso}T00:00:00Z`));
}

export function legalParams(lang: Lang, page: LegalPageId): LegalParams {
  const legal = webConfig.legal;
  return {
    operator: legal.operator[lang],
    contactEmail: legal.contactEmail,
    jurisdiction: legal.jurisdiction[lang],
    hosting: legal.hosting[lang],
    a11yCoordinator: legal.accessibility.coordinator[lang],
    a11yEmail: legal.accessibility.email,
    a11yPhone: legal.accessibility.phone[lang],
    date: legalDate(lang, legal.updated[page]),
    // what AI learning sends (SPEC 7.3): the same numbers the payload is capped with
    pairs: limits.payload.maxPairs,
    dropped: limits.payload.maxDropped,
    rounds: limits.learn.loop.maxRounds,
    rows: limits.learn.loop.maxRowsTotal,
    // how long things live: the same numbers the API's TTL indexes are built from (apps/api/src/db.ts `ensureIndexes`)
    cacheDays: limits.cache.ttlDays,
    sessionDays: limits.auth.sessionDays,
    cookieDays: limits.protection.anonCookieMaxAgeDays,
    counterGraceDays: limits.protection.counterGraceHours / 24,
    llmMonths: limits.retention.aiCallRecordsMonths,
    formsMonths: limits.retention.formsMonths,
    eventsMonths: limits.retention.eventsMonths,
  };
}

/** A legal string with its `{tokens}` filled in. */
export function fillLegal(text: string, params: LegalParams): string {
  return interpolate(text, params);
}
