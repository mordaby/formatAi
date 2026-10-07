// How the AI-learn quota is said in words (SPEC 11, 21 v5 item 2): "AI formats left this month: 2", and what a free
// sign-in includes. The numbers and the period come from config / the API, never from here.
import { tiers, type AiLearnPeriod, type AiLearnQuotaState, type Tier } from '@formatai/shared';
import type { I18n, Lang } from '../i18n';

/**
 * When a used-up quota comes back: the first instant of the next period AS THE SERVER COUNTS IT. The server keys a user's AI learns by the
 * UTC month (`yyyy-mm`) or the UTC day (`yyyy-mm-dd`) the learn falls in (apps/api/src/protection/keys.ts `aiLearnsKey`), so a month's
 * count starts again at 00:00 UTC on the 1st, a day's at the next 00:00 UTC. `null`: it never comes back (`lifetime`), or there is no limit.
 */
export function aiRenewsAt(period: AiLearnPeriod, now: Date): Date | null {
  if (period === 'month') return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  if (period === 'day') return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  return null;
}

/**
 * That moment in words. A month: its date ("1 November"), read in UTC like the server's months - the same date as the person's own east of
 * UTC (Israel), and never earlier than the moment itself west of it. A day: the person's own clock time it comes back at ("03:00").
 * Its spaces are non-breaking: "1 November" never splits across two lines.
 */
export function aiRenewText(lang: Lang, period: AiLearnPeriod, now: Date): string | null {
  const at = aiRenewsAt(period, now);
  if (!at) return null;
  const locale = lang === 'he' ? 'he-IL' : 'en-GB';
  const format =
    period === 'month'
      ? new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'long', timeZone: 'UTC' })
      : new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' });
  return format.format(at).replace(/\s/g, ' ');
}

/** "AI formats left this month: N" (or today / in total / no limit); with none left, when they come back ("0 · back on 1 November"). */
export function aiLeftLabel(i18n: Pick<I18n, 't' | 'lang'>, quota: AiLearnQuotaState, now: Date = new Date()): string {
  const { t, lang } = i18n;
  if (quota.remaining === null || quota.period === 'unlimited') return t('account.aiLeft.unlimited');
  if (quota.remaining === 0 && quota.period !== 'lifetime') {
    return t(`account.aiLeft.none.${quota.period}`, { date: aiRenewText(lang, quota.period, now) ?? '' });
  }
  return t(`account.aiLeft.${quota.period}`, { n: quota.remaining });
}

/** "Uses 1 AI format (2 left this month), and only if it succeeds.": what one AI step costs the person who runs it. `null`: not known yet. */
export function aiUsesLabel(t: I18n['t'], quota: AiLearnQuotaState | null): string {
  if (!quota) return t('deep.uses.unknown');
  if (quota.remaining === null || quota.period === 'unlimited') return t('deep.uses.unlimited');
  return t(`deep.uses.${quota.period}`, { n: quota.remaining });
}

/** "3 AI formats a month included": what signing in free gives (the registered tier's config). */
export function includedLabel(t: I18n['t']): string {
  const { count, period } = tiers.registered.aiLearns;
  if (period === 'unlimited') return t('partial.included.unlimited');
  return t(`partial.included.${period}`, { n: count });
}

/** None left: the period's quota is used up (a known quota of 0; an unlimited one never is). */
export function noAiLeft(quota: AiLearnQuotaState | null): boolean {
  return quota !== null && quota.remaining === 0;
}

/** The out-of-AI-formats notice in one line: "No AI formats left this month · back on 1 November" (or today / in total). */
export function aiOutLine(i18n: Pick<I18n, 't' | 'lang'>, period: AiLearnPeriod, now: Date = new Date()): string {
  const { t, lang } = i18n;
  if (period === 'month' || period === 'day') return t(`aiOut.notice.${period}`, { date: aiRenewText(lang, period, now) ?? '' });
  return t('aiOut.notice.lifetime');
}

/**
 * What the plan includes, and when they come back: "Your plan includes 3 AI formats a month. They come back on 1 November." The count is
 * the user's own as the server says it (`quota.limit`: an admin may have given this account another number), else the plan's
 * (`tiers[tier].aiLearns`); when it is not the plan's, the line says so - "Your account includes 10 ..." (API audit P2). The period is the one
 * the server counted.
 */
export function aiPlanLine(i18n: Pick<I18n, 't' | 'lang'>, tier: Tier, period: AiLearnPeriod, now: Date = new Date(), limit: number | null = null): string {
  const { t, lang } = i18n;
  const plan = tiers[tier].aiLearns.count;
  const n = limit ?? plan;
  const whose = n === plan ? 'plan' : 'account';
  if (period === 'month' || period === 'day') return t(`aiOut.${whose}.${period}`, { n, date: aiRenewText(lang, period, now) ?? '' });
  return t(`aiOut.${whose}.lifetime`, { n });
}
