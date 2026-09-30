// How the AI-learn quota is said in words (SPEC 11, 21 v5 item 2): "AI formats left this month: 2", and what a free
// sign-in includes. The numbers and the period come from config / the API, never from here.
import { tiers, type AiLearnQuotaState } from '@formatai/shared';
import type { I18n } from '../i18n';

/** "AI formats left this month: N" (or today / in total / no limit). */
export function aiLeftLabel(t: I18n['t'], quota: AiLearnQuotaState): string {
  if (quota.remaining === null || quota.period === 'unlimited') return t('account.aiLeft.unlimited');
  return t(`account.aiLeft.${quota.period}`, { n: quota.remaining });
}

/** "3 AI formats a month included": what signing in free gives (the registered tier's config). */
export function includedLabel(t: I18n['t']): string {
  const { count, period } = tiers.registered.aiLearns;
  if (period === 'unlimited') return t('partial.included.unlimited');
  return t(`partial.included.${period}`, { n: count });
}
