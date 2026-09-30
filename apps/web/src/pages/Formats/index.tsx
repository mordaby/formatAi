// My formats (SPEC 16.1 screen 5): each format with its sources underneath, and what can be done with it. (The company's Source objects
// of SPEC 8.15 have no screen in the MVP: they are created and reused automatically, and silently, when a format is saved.)
import { tiers } from '@formatai/shared';
import { useEffect } from 'react';
import { LinkButton } from '../../app/LinkButton';
import { useMe } from '../../app/Me';
import { RequireSignIn } from '../../app/RequireSignIn';
import { useLoad } from '../../app/useLoad';
import { useI18n } from '../../i18n';
import { useServices } from '../../services';
import { Button, InlineMessage, Spinner } from '../../ui';
import { FormatCard } from './FormatCard';

export default function FormatsPage() {
  const { t } = useI18n();
  return (
    <RequireSignIn title={t('formats.title')}>
      <Formats />
    </RequireSignIn>
  );
}

function Formats() {
  const { t } = useI18n();
  const { api } = useServices();
  const me = useMe();
  const formats = useLoad((signal) => api.registry.listFormats(signal), []);
  const { setFormatCount } = me;

  // The list is the freshest word on how many formats there are: Home's "Convert a file" reads the same number.
  const count = formats.state.status === 'ready' ? formats.state.data.length : undefined;
  useEffect(() => {
    if (count !== undefined) setFormatCount(count);
  }, [count, setFormatCount]);

  const cap = tiers[me.tier].savedFormats;
  return (
    <main id="main" className="page" tabIndex={-1}>
      <section className="tool">
        <div className="view">
          <header className="tool__head formats__head">
            <div>
              <h1>{t('formats.title')}</h1>
              <p className="lead">{t('formats.lead')}</p>
              {count !== undefined && typeof cap === 'number' ? <p className="muted tabular">{t('formats.slots', { used: count, max: cap })}</p> : null}
            </div>
            <LinkButton variant="primary" to="/" state={{ teach: true }} iconEnd="arrow">
              {t('formats.teach')}
            </LinkButton>
          </header>

          {formats.state.status === 'loading' && (
            <p className="muted">
              <Spinner size={14} /> {t('formats.loading')}
            </p>
          )}
          {formats.state.status === 'error' && (
            <InlineMessage
              tone="error"
              actions={
                <Button variant="secondary" size="sm" onClick={formats.reload}>
                  {t('error.tryAgain')}
                </Button>
              }
            >
              {t('formats.loadFailed')}
            </InlineMessage>
          )}
          {formats.state.status === 'ready' &&
            (formats.state.data.length === 0 ? (
              <div className="formats__empty" data-testid="formats-empty">
                <h2>{t('formats.empty.title')}</h2>
                <p className="muted">{t('formats.empty.text')}</p>
              </div>
            ) : (
              <ul className="format-list" data-testid="format-list">
                {formats.state.data.map((format) => (
                  <FormatCard
                    key={format.id}
                    format={format}
                    onRenamed={(next) => formats.set((old) => old.map((f) => (f.id === next.id ? next : f)))}
                    onDeleted={(id) => formats.set((old) => old.filter((f) => f.id !== id))}
                  />
                ))}
              </ul>
            ))}

        </div>
      </section>
    </main>
  );
}
