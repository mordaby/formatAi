// My formats (SPEC 16.1 screen 5): each format with its sources underneath, and what can be done with it - and, under the list, the
// company's sources (SPEC 8.15) with the formats each one feeds.
import { tiers } from '@formatai/shared';
import { useEffect, useMemo, useState } from 'react';
import { LinkButton } from '../../app/LinkButton';
import { useMe } from '../../app/Me';
import { RequireSignIn } from '../../app/RequireSignIn';
import { useLoad } from '../../app/useLoad';
import { useI18n } from '../../i18n';
import { useServices } from '../../services';
import { Button, InlineMessage, Spinner } from '../../ui';
import { FormatCard } from './FormatCard';
import { SourcesSection } from './SourcesSection';

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
  // The company's sources (SPEC 8.15). Read here, once, for the section under the list and for "also feeds" on the format cards; a rename or
  // a delete made in one place is shown in the other by reading again (no cache shared between pages).
  const sources = useLoad((signal) => api.registry.listSources(signal), []);
  const [renamedSources, setRenamedSources] = useState(0);
  const { setFormatCount } = me;
  const { reload: reloadSources } = sources;

  // Conversion id -> the OTHER formats its source feeds.
  const sourceList = sources.state.status === 'ready' ? sources.state.data : undefined;
  const alsoFeeds = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const s of sourceList ?? []) {
      for (const c of s.conversions) {
        const others = [...new Set(s.conversions.filter((x) => x.formatId !== c.formatId).map((x) => x.formatName))];
        if (others.length > 0) map.set(c.conversionId, others);
      }
    }
    return map;
  }, [sourceList]);

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
                    alsoFeeds={alsoFeeds}
                    sourcesVersion={renamedSources}
                    onRenamed={(next) => {
                      formats.set((old) => old.map((f) => (f.id === next.id ? next : f)));
                      // (a source's "feeds ..." names the format)
                      reloadSources();
                    }}
                    onDeleted={(id) => {
                      formats.set((old) => old.filter((f) => f.id !== id));
                      // The formats' sources stay (SPEC 8.15), but each now feeds one format fewer - and may be deletable.
                      reloadSources();
                    }}
                  />
                ))}
              </ul>
            ))}

          {sources.state.status === 'error' && (
            <InlineMessage
              tone="error"
              actions={
                <Button variant="secondary" size="sm" onClick={sources.reload}>
                  {t('error.tryAgain')}
                </Button>
              }
            >
              {t('sources.loadFailed')}
            </InlineMessage>
          )}
          {/* Hidden while there are no sources. */}
          {sourceList && sourceList.length > 0 && (
            <SourcesSection
              sources={sourceList}
              onRenamed={(next) => {
                sources.set((old) => old.map((s) => (s.id === next.id ? next : s)));
                // The format cards that are open name the source: they read again.
                setRenamedSources((n) => n + 1);
              }}
              onDeleted={(id) => sources.set((old) => old.filter((s) => s.id !== id))}
              onStale={reloadSources}
            />
          )}
        </div>
      </section>
    </main>
  );
}
