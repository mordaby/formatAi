// Users (SPEC 11, 14.2): search by email or name; each user's plan, when they joined, how many AI learns they used this period (against their
// limit) and how many formats they have; set the plan (free <-> paid: a visitor has no user) and the AI-learn limit. Every change is written to
// the audit log, shown under the list. There is no way to delete a user.
import { limits, tiers, type AdminUserRow } from '@formatai/shared';
import { useId, useState, type FormEvent } from 'react';
import { useLoad } from '../../app/useLoad';
import { useI18n } from '../../i18n';
import { useServices } from '../../services';
import { Badge, Button, InlineMessage } from '../../ui';
import { Audit } from './Audit';
import { dayText, numberText } from './format';
import { LoadFailed, Loading, Scroll } from './parts';

export function Users() {
  const { t, lang } = useI18n();
  const { api } = useServices();
  const [typed, setTyped] = useState('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<string | null>(null);
  const list = useLoad((signal) => api.admin.users({ q, page }, signal), [q, page]);
  const audit = useLoad((signal) => api.admin.audit(signal), []);
  const searchId = useId();

  const search = (e: FormEvent): void => {
    e.preventDefault();
    setEditing(null);
    setPage(1);
    setQ(typed.trim());
  };

  const saved = (user: AdminUserRow): void => {
    list.set((old) => ({ ...old, users: old.users.map((u) => (u.id === user.id ? user : u)) }));
    setEditing(null);
    audit.reload();
  };

  const data = list.state.status === 'ready' ? list.state.data : null;
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  return (
    <div className="admin-panel">
      <form className="admin-search" role="search" onSubmit={search}>
        <div className="field admin-search__field">
          <label className="field__label" htmlFor={searchId}>
            {t('admin.users.search')}
          </label>
          <input id={searchId} className="input" type="search" dir="auto" maxLength={limits.admin.maxSearchChars} value={typed} onChange={(e) => setTyped(e.target.value)} />
        </div>
        <Button type="submit" variant="secondary">
          {t('admin.users.searchButton')}
        </Button>
      </form>

      {list.state.status === 'loading' && <Loading />}
      {list.state.status === 'error' && <LoadFailed onRetry={list.reload} />}
      {data && (
        <>
          <p className="muted tabular" data-testid="users-count">
            {data.total === 1 ? t('admin.users.count.one') : t('admin.users.count.other', { n: numberText(lang, data.total) })}
          </p>
          {data.users.length === 0 ? (
            <p className="muted">{t('admin.users.empty')}</p>
          ) : (
            <Scroll>
              <table className="admin-table admin-table--wide" data-testid="users-table">
                <thead>
                  <tr>
                    <th scope="col">{t('admin.users.col.user')}</th>
                    <th scope="col">{t('admin.users.col.plan')}</th>
                    <th scope="col">{t('admin.users.col.joined')}</th>
                    <th scope="col">{t('admin.users.col.ai')}</th>
                    <th scope="col" className="num">
                      {t('admin.users.col.formats')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.users.map((u) => (
                    <UserRow key={u.id} u={u} editing={editing === u.id} onEdit={() => setEditing(u.id)} onCancel={() => setEditing(null)} onSaved={saved} />
                  ))}
                </tbody>
              </table>
            </Scroll>
          )}
          {pages > 1 && (
            <nav className="admin-pager" aria-label={t('admin.users.pager')}>
              <Button size="sm" variant="secondary" disabled={data.page <= 1} onClick={() => setPage(data.page - 1)}>
                {t('admin.users.prev')}
              </Button>
              <span className="muted tabular">{t('admin.users.page', { page: data.page, pages })}</span>
              <Button size="sm" variant="secondary" disabled={data.page >= pages} onClick={() => setPage(data.page + 1)}>
                {t('admin.users.next')}
              </Button>
            </nav>
          )}
        </>
      )}

      {audit.state.status === 'ready' && <Audit entries={audit.state.data} />}
    </div>
  );
}

function UserRow({ u, editing, onEdit, onCancel, onSaved }: { u: AdminUserRow; editing: boolean; onEdit(): void; onCancel(): void; onSaved(user: AdminUserRow): void }) {
  const { t, lang } = useI18n();
  const display = u.name ?? u.emails[0] ?? u.id;
  const { used, limit, period } = u.aiLearns;
  const custom = u.limitOverrides.aiLearns !== undefined;
  return (
    <>
      <tr data-testid="user-row" data-user-id={u.id}>
        {/* Edit sits with the name, so on a narrow screen (the table scrolls sideways) it is never off to the side. */}
        <td>
          <div className="admin-fn__box">
            <bdi>{display}</bdi>
            {u.emails.map((email) => (
              <span key={email} className="muted admin-fn__purpose" dir="ltr">
                {email}
              </span>
            ))}
            {!editing && (
              <Button size="sm" variant="ghost" icon="pencil" onClick={onEdit} aria-label={`${t('admin.users.edit')}: ${display}`}>
                {t('admin.users.edit')}
              </Button>
            )}
          </div>
        </td>
        <td>
          <Badge tone={u.tier === 'paid' ? 'verified' : 'neutral'}>{t(u.tier === 'paid' ? 'account.tier.paid' : 'account.tier.registered')}</Badge>
        </td>
        <td className="tabular" dir="ltr">
          {dayText(u.createdAt)}
        </td>
        <td className="tabular">
          {used === null || limit === null || period === 'unlimited'
            ? t('admin.users.ai.unlimited')
            : t(`admin.users.ai.${period}`, { used: numberText(lang, used), limit: numberText(lang, limit) })}
          {custom ? <span className="muted"> ({t('admin.users.ai.custom')})</span> : null}
        </td>
        <td className="num tabular">{numberText(lang, u.formats)}</td>
      </tr>
      {editing && (
        <tr data-testid="user-editor">
          <td colSpan={5} className="admin-editor-cell">
            <Editor u={u} display={display} onCancel={onCancel} onSaved={onSaved} />
          </td>
        </tr>
      )}
    </>
  );
}

/** The plan and the AI-learn limit of one user. Only what changed is sent; an empty limit field takes the override away. */
function Editor({ u, display, onCancel, onSaved }: { u: AdminUserRow; display: string; onCancel(): void; onSaved(user: AdminUserRow): void }) {
  const { t } = useI18n();
  const { api } = useServices();
  const [tier, setTier] = useState<AdminUserRow['tier']>(u.tier);
  const [override, setOverride] = useState(u.limitOverrides.aiLearns === undefined ? '' : String(u.limitOverrides.aiLearns));
  const [problem, setProblem] = useState<'invalid' | 'failed' | null>(null);
  const [busy, setBusy] = useState(false);
  const planId = useId();
  const overrideId = useId();

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    const text = override.trim();
    if (text !== '' && !/^\d{1,6}$/.test(text)) {
      setProblem('invalid');
      return;
    }
    const current = u.limitOverrides.aiLearns;
    const next = text === '' ? undefined : Number(text);
    const body: { tier?: AdminUserRow['tier']; limitOverrides?: Record<string, number> | null } = {};
    if (tier !== u.tier) body.tier = tier;
    if (next !== current) body.limitOverrides = next === undefined ? null : { aiLearns: next };
    if (Object.keys(body).length === 0) {
      onCancel();
      return;
    }
    setBusy(true);
    setProblem(null);
    try {
      onSaved(await api.admin.updateUser(u.id, body));
    } catch {
      setProblem('failed');
      setBusy(false);
    }
  };

  const tierCount = tiers[tier].aiLearns.count;
  return (
    <form className="admin-editor" onSubmit={(e) => void submit(e)} aria-label={t('admin.users.edit.title', { name: display })}>
      <h3 className="admin-block__sub">
        <bdi>{t('admin.users.edit.title', { name: display })}</bdi>
      </h3>
      <div className="admin-editor__fields">
        <div className="field">
          <label className="field__label" htmlFor={planId}>
            {t('admin.users.edit.plan')}
          </label>
          <select id={planId} className="input" value={tier} onChange={(e) => setTier(e.target.value === 'paid' ? 'paid' : 'registered')}>
            <option value="registered">{t('account.tier.registered')}</option>
            <option value="paid">{t('account.tier.paid')}</option>
          </select>
        </div>
        <div className="field">
          <label className="field__label" htmlFor={overrideId}>
            {t('admin.users.edit.override')}
          </label>
          <input
            id={overrideId}
            className="input input--number"
            type="text"
            inputMode="numeric"
            dir="ltr"
            value={override}
            aria-invalid={problem === 'invalid' || undefined}
            onChange={(e) => setOverride(e.target.value)}
          />
          <span className="field__hint">{t('admin.users.edit.overrideHint', { n: tierCount })}</span>
        </div>
      </div>
      {problem && <InlineMessage tone={problem === 'invalid' ? 'warn' : 'error'}>{t(problem === 'invalid' ? 'admin.users.edit.invalid' : 'admin.users.edit.saveFailed')}</InlineMessage>}
      <div className="row">
        <Button type="submit" variant="primary" size="sm" loading={busy}>
          {t('admin.users.edit.save')}
        </Button>
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
          {t('admin.users.edit.cancel')}
        </Button>
      </div>
    </form>
  );
}
