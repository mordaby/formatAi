// The words for a conversion's status (SPEC 8.11 badges, 8.12 "needs review"), in one place for My formats, one format and the editor.
import type { ConversionStatus, FormatSummary } from '@formatai/shared';
import type { I18n } from '../../i18n';
import type { BadgeTone } from '../../ui';

/** "Verified", "3 differences", "Needs review", ... for one source. */
export function statusLabel(t: I18n['t'], status: ConversionStatus, acceptedDifferences: number): string {
  switch (status) {
    case 'verified':
      return t('status.verified');
    case 'differencesAccepted':
      return t(acceptedDifferences === 1 ? 'status.differencesAccepted.one' : 'status.differencesAccepted.other', { n: acceptedDifferences });
    case 'userConfirmed':
      return t('status.userConfirmed');
    case 'draft':
      return t('status.draft');
    case 'needsReview':
      return t('status.needsReview');
  }
}

/** Teal for what is checked, amber for what needs a look (SPEC 8.11), plain for the rest. */
export function statusTone(status: ConversionStatus): BadgeTone {
  switch (status) {
    case 'verified':
      return 'verified';
    case 'differencesAccepted':
    case 'needsReview':
      return 'check';
    default:
      return 'neutral';
  }
}

/** The statuses of a format's sources, as counts in the order a person cares about: what needs review first. */
export function statusCounts(t: I18n['t'], statuses: FormatSummary['statuses']): { status: ConversionStatus; text: string }[] {
  const order: ConversionStatus[] = ['needsReview', 'differencesAccepted', 'userConfirmed', 'draft', 'verified'];
  const out: { status: ConversionStatus; text: string }[] = [];
  for (const status of order) {
    const n = statuses[status];
    if (n) out.push({ status, text: t(`formats.count.${status}` as const, { n }) });
  }
  return out;
}

/** "3/1/2026" in the UI's language. */
export function shortDate(iso: string, lang: 'he' | 'en'): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(lang === 'he' ? 'he-IL' : 'en-GB');
}
