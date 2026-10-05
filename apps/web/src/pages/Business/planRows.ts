// The plans table of "For business" (SPEC 11, 16.1 screen 7): one row per thing a plan includes, one cell per tier. Every number comes from the
// tier config (`tiers`) - nothing here is typed twice - so changing a limit changes the page.
import { tiers, type AiLearnQuota, type Tier, type TierLimits } from '@formatai/shared';
import type { I18n, MessageKey } from '../../i18n';

export const PLAN_TIERS: readonly Tier[] = ['anonymous', 'registered', 'paid'];

export interface PlanHead {
  tier: Tier;
  name: MessageKey;
  for: MessageKey;
}

export const PLAN_HEADS: readonly PlanHead[] = [
  { tier: 'anonymous', name: 'plan.free', for: 'plan.free.for' },
  { tier: 'registered', name: 'plan.registered', for: 'plan.registered.for' },
  { tier: 'paid', name: 'plan.paid', for: 'plan.paid.for' },
];

export interface PlanRow {
  /** The row's name (also the label of its value in the narrow, per-plan layout). */
  label: MessageKey;
  /** One cell per tier, in `PLAN_TIERS` order. */
  cells: string[];
}

function aiText(t: I18n['t'], quota: AiLearnQuota, nf: Intl.NumberFormat): string {
  if (quota.period === 'unlimited') return t('plan.val.unlimited');
  if (quota.count === 0) return t('plan.val.notIncluded');
  return t(quota.period === 'month' ? 'plan.val.perMonth' : quota.period === 'day' ? 'plan.val.perDay' : 'plan.val.lifetime', { n: nf.format(quota.count) });
}

function formatsText(t: I18n['t'], l: TierLimits, nf: Intl.NumberFormat): string {
  if (l.savedFormats === 'unlimited') return l.newSavedFormatsPerMonth ? t('plan.val.newPerMonth', { n: nf.format(l.newSavedFormatsPerMonth) }) : t('plan.val.unlimited');
  return l.savedFormats === 0 ? t('plan.val.notIncluded') : nf.format(l.savedFormats);
}

function sourcesText(t: I18n['t'], l: TierLimits, nf: Intl.NumberFormat): string {
  if (l.sourcesPerFormat === 'unlimited') return t('plan.val.unlimited');
  return l.sourcesPerFormat === 0 ? t('plan.val.notIncluded') : nf.format(l.sourcesPerFormat);
}

export function planRows(t: I18n['t'], lang: string): PlanRow[] {
  const nf = new Intl.NumberFormat(lang);
  const each = (cell: (l: TierLimits) => string): string[] => PLAN_TIERS.map((tier) => cell(tiers[tier]));
  return [
    { label: 'plan.row.rows', cells: each((l) => nf.format(l.maxRowsPerFile)) },
    { label: 'plan.row.columns', cells: each((l) => nf.format(l.maxColumns)) },
    { label: 'plan.row.files', cells: each((l) => nf.format(l.filesPerRun)) },
    { label: 'plan.row.formats', cells: each((l) => formatsText(t, l, nf)) },
    { label: 'plan.row.sources', cells: each((l) => sourcesText(t, l, nf)) },
    { label: 'plan.row.ai', cells: each((l) => aiText(t, l.aiLearns, nf)) },
    { label: 'plan.row.download', cells: each((l) => (l.previewRows === null ? t('plan.val.full') : t('plan.val.preview', { n: nf.format(l.previewRows) }))) },
  ];
}
