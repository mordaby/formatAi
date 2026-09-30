// One format and its sources (SPEC 16.1 screen 5, 8.12): the sources with their status, a way in to each one's rules, and the
// two things a format is for - converting a file, and adding another source.
import { Link, Navigate, useLocation, useParams } from 'react-router-dom';
import { LinkButton } from '../../app/LinkButton';
import { RequireSignIn } from '../../app/RequireSignIn';
import { useLoad } from '../../app/useLoad';
import { Cell } from '../../components/Cell';
import { useI18n } from '../../i18n';
import { useServices } from '../../services';
import { Button, InlineMessage, Spinner } from '../../ui';
import { SourceRow } from './SourceRow';

export default function FormatPage() {
  const { t } = useI18n();
  return (
    <RequireSignIn title={t('formats.title')}>
      <FormatDetail />
    </RequireSignIn>
  );
}

function FormatDetail() {
  const { t } = useI18n();
  const { api } = useServices();
  const { id = '' } = useParams();
  const location = useLocation();
  const data = useLoad((signal) => api.registry.getFormat(id, signal), [id]);

  const wantsEdit = (location.state as { edit?: boolean } | null)?.edit === true;

  if (data.state.status === 'loading') {
    return (
      <main id="main" className="page" tabIndex={-1}>
        <p className="muted">
          <Spinner size={14} /> {t('formats.loading')}
        </p>
      </main>
    );
  }
  if (data.state.status === 'error') {
    const missing = data.state.code === 'notFound';
    return (
      <main id="main" className="page" tabIndex={-1}>
        <section className="tool">
          <div className="view">
            <InlineMessage
              tone={missing ? 'block' : 'error'}
              actions={
                missing ? (
                  <LinkButton variant="primary" size="sm" to="/formats">
                    {t('format.back')}
                  </LinkButton>
                ) : (
                  <Button variant="secondary" size="sm" onClick={data.reload}>
                    {t('error.tryAgain')}
                  </Button>
                )
              }
            >
              {t(missing ? 'format.notFound' : 'format.loadFailed')}
            </InlineMessage>
          </div>
        </section>
      </main>
    );
  }

  const { format, conversions } = data.state.data;
  // "Edit rules" on a format with one source goes straight to that source.
  if (wantsEdit && conversions.length === 1) return <Navigate to={`/formats/${id}/sources/${conversions[0]!.id}`} replace />;

  return (
    <main id="main" className="page" tabIndex={-1}>
      <section className="tool">
        <div className="view">
          <p>
            <Link to="/formats">{t('format.back')}</Link>
          </p>
          <header className="tool__head formats__head">
            <div>
              <h1>
                <Cell value={format.name} />
              </h1>
              <p className="muted tabular">{t('format.summary', { columns: format.outputColumns, type: format.fileType })}</p>
            </div>
            <div className="format-card__actions">
              <LinkButton variant="secondary" to={`/convert?format=${encodeURIComponent(format.id)}`}>
                {t('formats.convert')}
              </LinkButton>
              <LinkButton variant="primary" to={`/formats/${format.id}/add-source`}>
                {t('formats.addSource')}
              </LinkButton>
            </div>
          </header>

          <section aria-labelledby="sources-title" className="format-sources">
            <h2 id="sources-title">{t('format.sources')}</h2>
            {conversions.length === 0 ? (
              <p className="muted">{t('format.noSources')}</p>
            ) : (
              <ul className="source-rows" data-testid="source-rows">
                {conversions.map((c) => (
                  <SourceRow
                    key={c.id}
                    formatId={format.id}
                    source={c}
                    onRenamed={(next) => data.set((old) => ({ ...old, conversions: old.conversions.map((x) => (x.id === next.id ? next : x)) }))}
                    onDeleted={(cid) => data.set((old) => ({ ...old, conversions: old.conversions.filter((x) => x.id !== cid) }))}
                  />
                ))}
              </ul>
            )}
          </section>
        </div>
      </section>
    </main>
  );
}
