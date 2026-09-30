// The company's sources, under the formats on My formats (SPEC 8.15): each kind of incoming file with the formats it feeds, its statuses,
// and the two things that are about the source itself - rename it, and delete it once it feeds no format. My formats stays format-centric
// (a format's card lists its sources); this is the other way to look at the same registry, and it is where a source with no format
// left (its format was deleted) can still be found. A full source editor is not here: a source's rules are edited from a conversion.
import type { SourceSummary } from '@formatai/shared';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { isApiError } from '../../api';
import { Cell } from '../../components/Cell';
import { useI18n } from '../../i18n';
import { isolate } from '../Convert/logic';
import { useServices } from '../../services';
import { Badge, Button, Dialog, InlineMessage } from '../../ui';
import { TextField } from '../Result/fields';
import { shortDate, statusCounts, statusTone } from './statusText';

export interface SourcesSectionProps {
  sources: SourceSummary[];
  /** The server's answer to a rename. */
  onRenamed(source: SourceSummary): void;
  /** After the source is gone. */
  onDeleted(id: string): void;
  /** The list is out of date (the server says this source feeds a format after all): read it again. */
  onStale(): void;
}

export function SourcesSection({ sources, onRenamed, onDeleted, onStale }: SourcesSectionProps) {
  const { t } = useI18n();
  return (
    <section aria-labelledby="my-sources-title" className="format-sources" data-testid="sources-section">
      <h2 id="my-sources-title">{t('sources.title')}</h2>
      <p className="muted">{t('sources.lead')}</p>
      <ul className="source-rows" data-testid="source-list">
        {sources.map((s) => (
          <SourceCard key={s.id} source={s} onRenamed={onRenamed} onDeleted={onDeleted} onStale={onStale} />
        ))}
      </ul>
    </section>
  );
}

function SourceCard({ source, onRenamed, onDeleted, onStale }: { source: SourceSummary } & Omit<SourcesSectionProps, 'sources'>) {
  const { t, code, lang } = useI18n();
  const { api } = useServices();
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(source.name);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteProblem, setDeleteProblem] = useState<string | null>(null);

  // The formats it feeds, once each (a conversion is one link from the source to a format).
  const formats = [...new Map(source.conversions.map((c) => [c.formatId, c.formatName])).entries()];
  const counts = statusCounts(t, source.statuses);
  // DECISION: delete is offered only while the source feeds no format (the server refuses it otherwise: 409 `sourceInUse`, told plainly if
  // this list was out of date). A source that feeds a format leaves through its conversions.
  const canDelete = source.conversions.length === 0;

  const rename = async (): Promise<void> => {
    const next = name.trim();
    if (next === '' || next === source.name) {
      setRenaming(false);
      return;
    }
    setBusy(true);
    setProblem(null);
    try {
      const res = await api.registry.updateSource(source.id, { name: next });
      onRenamed(res.source);
      setRenaming(false);
    } catch (e) {
      // "You already have a source with that name" (source names are unique per company, case-insensitively), or the plain failure.
      setProblem(isApiError(e, 'nameTaken') ? code({ kind: 'apiError', code: 'nameTaken' }) : t('formats.renameFailed'));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (): Promise<void> => {
    setBusy(true);
    setDeleteProblem(null);
    try {
      await api.registry.deleteSource(source.id);
      setConfirmDelete(false);
      onDeleted(source.id);
    } catch (e) {
      if (isApiError(e, 'sourceInUse')) {
        setDeleteProblem(code({ kind: 'apiError', code: 'sourceInUse' }));
        onStale();
      } else {
        setDeleteProblem(t('sources.deleteFailed'));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="source-row" data-source-id={source.id} data-testid="source-card">
      <div className="source-row__main">
        {renaming ? (
          <form
            className="format-card__rename"
            onSubmit={(e) => {
              e.preventDefault();
              void rename();
            }}
          >
            <TextField label={t('format.source.renameLabel')} value={name} onChange={setName} />
            <div className="format-card__renameActions">
              <Button type="submit" variant="primary" size="sm" loading={busy}>
                {t('formats.renameSave')}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setRenaming(false);
                  setName(source.name);
                  setProblem(null);
                }}
              >
                {t('formats.renameCancel')}
              </Button>
            </div>
          </form>
        ) : (
          <h3 className="source-row__name">
            <Cell value={source.name} />
          </h3>
        )}
        {counts.map((c) => (
          <Badge key={c.status} tone={statusTone(c.status)}>
            {c.text}
          </Badge>
        ))}
      </div>
      {problem ? <InlineMessage tone="block">{problem}</InlineMessage> : null}

      <div className="source-list__item">
        <span>{formats.length === 0 ? t('sources.feeds.none') : t(formats.length === 1 ? 'sources.feeds.one' : 'sources.feeds.other', { n: formats.length })}</span>
        {formats.map(([id, formatName]) => (
          <Link key={id} to={`/formats/${id}`}>
            <Cell value={formatName} />
          </Link>
        ))}
      </div>
      <p className="muted tabular">
        {t(source.columns === 1 ? 'sources.columns.one' : 'sources.columns.other', { n: source.columns })} ·{' '}
        {source.runCount === 0 ? t('formats.runs.never') : t(source.runCount === 1 ? 'formats.runs.one' : 'formats.runs.other', { n: source.runCount })}
        {source.lastRunAt ? ` · ${t('formats.lastRun', { date: shortDate(source.lastRunAt, lang) })}` : ''}
      </p>

      <div className="format-card__actions" role="group" aria-label={t('sources.actions', { name: source.name })}>
        <Button variant="ghost" size="sm" onClick={() => setRenaming(true)} disabled={renaming}>
          {t('formats.rename')}
        </Button>
        {canDelete ? (
          <Button variant="ghost" size="sm" icon="trash" onClick={() => setConfirmDelete(true)}>
            {t('formats.delete')}
          </Button>
        ) : (
          <span className="muted">{t('sources.inUse')}</span>
        )}
      </div>

      <Dialog
        open={confirmDelete}
        onClose={() => {
          setConfirmDelete(false);
          setDeleteProblem(null);
        }}
        title={t('sources.deleteTitle', { name: isolate(source.name) })}
      >
        <p>{t('sources.deleteText')}</p>
        {deleteProblem ? <InlineMessage tone="error">{deleteProblem}</InlineMessage> : null}
        <div className="dialog__foot">
          <Button variant="primary" loading={busy} onClick={() => void remove()}>
            {t('sources.deleteConfirm')}
          </Button>
          <Button variant="ghost" onClick={() => setConfirmDelete(false)}>
            {t('formats.deleteCancel')}
          </Button>
        </div>
      </Dialog>
    </li>
  );
}
