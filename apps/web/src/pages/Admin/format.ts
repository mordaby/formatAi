// Small formatters of the admin view: numbers, dates and dollars as an admin reads them. Money and dates are LTR text in either UI language.
import type { Lang } from '../../i18n';

/** 1,234 (or 1,234 in Hebrew: the same digits, the language's grouping). */
export function numberText(lang: Lang, n: number): string {
  return n.toLocaleString(lang === 'he' ? 'he-IL' : 'en-US');
}

/** `$0.0350`: a cent or less is shown to four places (an AI call costs a fraction of a cent), a dollar or more to two. Null is not known: the caller says "n/a". */
export function usdText(n: number): string {
  return `$${n.toFixed(n >= 1 ? 2 : 4)}`;
}

/** `yyyy-mm-dd` of an ISO instant, in UTC (the overview's days are UTC days). */
export function dayText(iso: string): string {
  return iso.slice(0, 10);
}
