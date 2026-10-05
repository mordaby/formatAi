// Function requests (SPEC 8.10, 13, 14.2; issue #40): every function the AI step asked for and the language lacks, grouped by name and signature,
// with how often and by how many people, when it was first and last seen, and its topic. A request holds a name, a purpose and a signature
// only. Once enough different people have asked, "Open GitHub issue" opens GitHub's new-issue form with the request filled in - the admin
// submits it herself (no token, no call from here) - and "Mark as opened" records it so it is not offered twice.
import { limits, type AdminFunctionRequest, type AdminFunctionRequestsResponse } from '@formatai/shared';
import { useState } from 'react';
import { useLoad } from '../../app/useLoad';
import { useI18n } from '../../i18n';
import { useServices } from '../../services';
import { Badge, Button, InlineMessage } from '../../ui';
import { dayText, numberText } from './format';
import { LoadFailed, Loading, Scroll } from './parts';

export function FunctionRequests() {
  const { t, lang } = useI18n();
  const { api } = useServices();
  const load = useLoad((signal) => api.admin.functionRequests(signal), []);
  const [busy, setBusy] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  const setStatus = async (id: string, status: 'new' | 'issueOpened'): Promise<void> => {
    setBusy(id);
    setFailed(false);
    try {
      const next = await api.admin.setFunctionRequestStatus(id, status);
      load.set((old: AdminFunctionRequestsResponse) => ({ ...old, requests: old.requests.map((r) => (r.id === id ? next : r)) }));
    } catch {
      setFailed(true);
    } finally {
      setBusy(null);
    }
  };

  const threshold = limits.learn.functionRequests.issueThreshold;
  return (
    <div className="admin-panel">
      <header className="admin-panel__head">
        <h2>{t('admin.fr.title')}</h2>
        <p className="lead">{t('admin.fr.lead', { n: threshold })}</p>
      </header>

      {failed && <InlineMessage tone="error">{t('admin.fr.updateFailed')}</InlineMessage>}
      {load.state.status === 'loading' && <Loading />}
      {load.state.status === 'error' && <LoadFailed onRetry={load.reload} />}
      {load.state.status === 'ready' &&
        (load.state.data.requests.length === 0 ? (
          <p className="muted" data-testid="fr-empty">
            {t('admin.fr.empty')}
          </p>
        ) : (
          <Scroll>
            <table className="admin-table admin-table--wide" data-testid="fr-table">
              <thead>
                <tr>
                  <th scope="col">{t('admin.fr.col.function')}</th>
                  <th scope="col">{t('admin.fr.col.topic')}</th>
                  <th scope="col" className="num">
                    {t('admin.fr.col.times')}
                  </th>
                  <th scope="col" className="num">
                    {t('admin.fr.col.people')}
                  </th>
                  <th scope="col">{t('admin.fr.col.first')}</th>
                  <th scope="col">{t('admin.fr.col.last')}</th>
                </tr>
              </thead>
              <tbody>
                {load.state.data.requests.map((r) => (
                  <Row key={r.id} r={r} threshold={threshold} busy={busy === r.id} onStatus={(s) => void setStatus(r.id, s)} num={(v) => numberText(lang, v)} />
                ))}
              </tbody>
            </table>
          </Scroll>
        ))}
    </div>
  );
}

function Row({ r, threshold, busy, onStatus, num }: { r: AdminFunctionRequest; threshold: number; busy: boolean; onStatus(status: 'new' | 'issueOpened'): void; num(v: number): string }) {
  const { t } = useI18n();
  const missing = threshold - r.distinctOwners;
  return (
    <tr data-testid="fr-row" data-name={r.name}>
      {/* The status and the actions sit with the function, so on a narrow screen (the table scrolls sideways) they are never off to the side. */}
      <td>
        <div className="admin-fn__box">
          <code className="admin-code" dir="ltr">
            {r.signature}
          </code>
          <span className="muted admin-fn__purpose" dir="auto">
            {r.purpose}
          </span>
          <div className="admin-actions">
            <Badge tone={r.status === 'issueOpened' || r.status === 'approved' ? 'verified' : 'neutral'}>{t(`admin.fr.status.${r.status}`)}</Badge>
            {r.issueUrl ? (
              <>
                <a className="btn btn--primary btn--sm" href={r.issueUrl} target="_blank" rel="noopener noreferrer">
                  {t('admin.fr.openIssue')}
                </a>
                <Button size="sm" variant="secondary" loading={busy} onClick={() => onStatus('issueOpened')}>
                  {t('admin.fr.markOpened')}
                </Button>
                <span className="muted admin-actions__hint">{t('admin.fr.issueHint')}</span>
              </>
            ) : null}
            {r.status === 'issueOpened' ? (
              <Button size="sm" variant="ghost" loading={busy} onClick={() => onStatus('new')}>
                {t('admin.fr.offerAgain')}
              </Button>
            ) : null}
            {r.status === 'new' && !r.atThreshold ? <span className="muted">{missing === 1 ? t('admin.fr.needMore.one') : t('admin.fr.needMore.other', { n: missing })}</span> : null}
          </div>
        </div>
      </td>
      <td>{r.topic}</td>
      <td className="num tabular">{num(r.count)}</td>
      <td className="num tabular">{num(r.distinctOwners)}</td>
      <td className="tabular" dir="ltr">
        {dayText(r.firstSeen)}
      </td>
      <td className="tabular" dir="ltr">
        {dayText(r.lastSeen)}
      </td>
    </tr>
  );
}
