// The admin audit log (SPEC 13 `admin_audit`): who changed what and when, newest first. Read-only; the server writes it before it makes a change.
import type { AdminAuditEntry } from '@formatai/shared';
import { useI18n, type I18n } from '../../i18n';
import { Block } from './parts';

/** `2026-10-05 12:30 UTC`. */
function timeText(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

/** One side of a change in words: a plan, the limits that were set, a request's status. */
function valueText(t: I18n['t'], action: AdminAuditEntry['action'], value: unknown): string {
  if (action === 'user.tier') return value === 'paid' ? t('account.tier.paid') : t('account.tier.registered');
  if (action === 'functionRequest.status') {
    return value === 'new' || value === 'issueOpened' || value === 'approved' || value === 'declined' ? t(`admin.fr.status.${value}`) : String(value);
  }
  if (typeof value !== 'object' || value === null || Object.keys(value).length === 0) return t('admin.audit.noOverride');
  return Object.entries(value as Record<string, unknown>)
    .map(([key, n]) => (key === 'aiLearns' ? t('admin.audit.override.aiLearns', { n: String(n) }) : `${key} ${String(n)}`))
    .join(', ');
}

export function Audit({ entries }: { entries: readonly AdminAuditEntry[] }) {
  const { t } = useI18n();
  return (
    <Block title={t('admin.audit.title')}>
      {entries.length === 0 ? (
        <p className="muted">{t('admin.audit.empty')}</p>
      ) : (
        <ul className="admin-audit" data-testid="audit-list">
          {entries.map((e) => (
            <li key={e.id}>
              <span className="muted tabular admin-audit__time" dir="ltr">
                {timeText(e.ts)}
              </span>{' '}
              <bdi>
                {t(`admin.audit.${e.action}`, {
                  admin: e.adminEmail ?? t('admin.audit.unknownAdmin'),
                  target: e.targetLabel ?? t('admin.audit.unknownTarget'),
                  before: valueText(t, e.action, e.before),
                  after: valueText(t, e.action, e.after),
                })}
              </bdi>
            </li>
          ))}
        </ul>
      )}
    </Block>
  );
}
