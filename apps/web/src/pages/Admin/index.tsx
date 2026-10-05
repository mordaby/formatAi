// /admin (SPEC 14.2, M4): the overview, function requests, users and their plan, leads and feedback - for admins only.
//
// DECISION: the page is not a security boundary - every admin API call is checked by the server (401 / 403), and a person who is not an admin
// would see nothing here anyway - but it does not announce itself either: a visitor or a signed-in user who is not an admin lands on Home,
// exactly as at any address that does not exist, and the nav entry is only drawn for an admin.
import { Navigate, useSearchParams } from 'react-router-dom';
import { useMe } from '../../app/Me';
import { useI18n } from '../../i18n';
import { Spinner } from '../../ui';
import { FunctionRequests } from './FunctionRequests';
import { Inbox } from './Inbox';
import { Overview } from './Overview';
import { Users } from './Users';

const TABS = ['overview', 'requests', 'users', 'inbox'] as const;
type Tab = (typeof TABS)[number];

function tabOf(raw: string | null): Tab {
  return (TABS as readonly string[]).includes(raw ?? '') ? (raw as Tab) : 'overview';
}

export default function AdminPage() {
  const { t } = useI18n();
  const me = useMe();
  const [params, setParams] = useSearchParams();
  const tab = tabOf(params.get('tab'));

  if (me.status === 'loading') {
    return (
      <main id="main" className="page" tabIndex={-1}>
        <p className="muted" role="status">
          <Spinner size={14} /> {t('admin.loading')}
        </p>
      </main>
    );
  }
  if (!me.user?.isAdmin) return <Navigate to="/" replace />;

  return (
    <main id="main" className="page page--admin" tabIndex={-1}>
      <section className="tool">
        <div className="view">
          <header className="tool__head">
            <h1>{t('admin.title')}</h1>
            <p className="lead">{t('admin.lead')}</p>
          </header>

          <nav className="admin-tabs" aria-label={t('admin.tabs')}>
            {TABS.map((id) => (
              <button
                key={id}
                type="button"
                className="admin-tabs__item"
                aria-current={id === tab ? 'page' : undefined}
                onClick={() => setParams(id === 'overview' ? {} : { tab: id }, { replace: true })}
              >
                {t(`admin.tab.${id}`)}
              </button>
            ))}
          </nav>

          {tab === 'overview' && <Overview />}
          {tab === 'requests' && <FunctionRequests />}
          {tab === 'users' && <Users />}
          {tab === 'inbox' && <Inbox />}
        </div>
      </section>
    </main>
  );
}
