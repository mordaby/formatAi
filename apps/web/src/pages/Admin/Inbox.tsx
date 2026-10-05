// Leads and feedback (SPEC 13, 14.2): what people wrote to us through the forms, newest first, read-only. The text is theirs: it is shown as
// text (never as markup) and as it was written (`dir="auto"`, so Hebrew and English both read right).
import { useLoad } from '../../app/useLoad';
import { useI18n } from '../../i18n';
import { useServices } from '../../services';
import { dayText } from './format';
import { LoadFailed, Loading, Scroll } from './parts';

export function Inbox() {
  const { t } = useI18n();
  const { api } = useServices();
  const load = useLoad((signal) => api.admin.contacts(signal), []);
  return (
    <div className="admin-panel">
      <header className="admin-panel__head">
        <h2>{t('admin.inbox.title')}</h2>
        <p className="lead">{t('admin.inbox.lead')}</p>
      </header>
      {load.state.status === 'loading' && <Loading />}
      {load.state.status === 'error' && <LoadFailed onRetry={load.reload} />}
      {load.state.status === 'ready' &&
        (load.state.data.length === 0 ? (
          <p className="muted">{t('admin.inbox.empty')}</p>
        ) : (
          <Scroll>
            <table className="admin-table admin-table--wide" data-testid="inbox-table">
              <thead>
                <tr>
                  <th scope="col">{t('admin.inbox.col.date')}</th>
                  <th scope="col">{t('admin.inbox.col.type')}</th>
                  <th scope="col">{t('admin.inbox.col.from')}</th>
                  <th scope="col">{t('admin.inbox.col.message')}</th>
                  <th scope="col">{t('admin.inbox.col.page')}</th>
                </tr>
              </thead>
              <tbody>
                {load.state.data.map((c) => (
                  <tr key={`${c.source}-${c.id}`} data-testid="inbox-row">
                    <td className="tabular" dir="ltr">
                      {c.createdAt ? dayText(c.createdAt) : t('admin.na')}
                    </td>
                    <td>
                      {t(`admin.inbox.source.${c.source}`)}
                      {c.kind !== c.source ? <span className="muted"> · {c.kind}</span> : null}
                      {c.rating !== undefined ? <span className="muted tabular"> · {t('admin.inbox.rating', { n: c.rating })}</span> : null}
                    </td>
                    <td className="admin-fn">
                      {c.name ? <bdi>{c.name}</bdi> : null}
                      {c.company ? (
                        <span className="muted admin-fn__purpose">
                          <bdi>{c.company}</bdi>
                          {c.role ? <> · <bdi>{c.role}</bdi></> : null}
                        </span>
                      ) : null}
                      {c.email ? (
                        <span className="muted admin-fn__purpose" dir="ltr">
                          {c.email}
                        </span>
                      ) : null}
                    </td>
                    <td className="admin-message" dir="auto">
                      {c.message ?? ''}
                    </td>
                    <td className="tabular" dir="ltr">
                      {c.page ?? ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Scroll>
        ))}
    </div>
  );
}
