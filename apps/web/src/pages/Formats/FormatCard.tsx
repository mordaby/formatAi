import type { FormatSummary } from '@formatai/shared';
import { useId, useState } from 'react';
import { Link } from 'react-router-dom';
import { LinkButton } from '../../app/LinkButton';
import { useLoad } from '../../app/useLoad';
import { Cell } from '../../components/Cell';
import { isolate } from '../Convert/logic';
import { useI18n } from '../../i18n';
import { useServices } from '../../services';
import { Badge, Button, Dialog, Icon, InlineMessage, Spinner } from '../../ui';
import { TextField } from '../Result/fields';
import { shortDate, statusCounts, statusLabel, statusTone } from './statusText';

export interface FormatCardProps {
  format: FormatSummary;
  /** The server's answer to a rename. */
  onRenamed(format: FormatSummary): void;
  /** After the format is gone (its slot is free again). */
  onDeleted(id: string): void;
  /** Conversion id -> the names of the OTHER formats its source also feeds (SPEC 8.15): a hint on the source line. */
  alsoFeeds?: ReadonlyMap<string, readonly string[]>;
  /** Changes when a source was renamed elsewhere on the page: the open list of sources reads again. */
  sourcesVersion?: number;
}

/** One format of My formats (SPEC 16.1 screen 5): its name, "← N sources", the status of the sources, and what can be done with it. */
export function FormatCard({ format, onRenamed, onDeleted, alsoFeeds, sourcesVersion = 0 }: FormatCardProps) {
  const { t, lang } = useI18n();
  const { api } = useServices();
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(format.name);
  const [renameFailed, setRenameFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteFailed, setDeleteFailed] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const listId = useId();

  const sources = useLoad((signal) => api.registry.getFormat(format.id, signal), [format.id, format.sources, sourcesVersion], expanded);

  const counts = statusCounts(t, format.statuses);
  const number = (n: number): string => n.toLocaleString(lang === 'he' ? 'he-IL' : 'en-US');

  const rename = async (): Promise<void> => {
    const next = name.trim();
    if (next === '' || next === format.name) {
      setRenaming(false);
      return;
    }
    setBusy(true);
    setRenameFailed(false);
    try {
      onRenamed(await api.registry.renameFormat(format.id, next));
      setRenaming(false);
    } catch {
      setRenameFailed(true);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (): Promise<void> => {
    setBusy(true);
    setDeleteFailed(false);
    try {
      await api.registry.deleteFormat(format.id);
      setConfirmDelete(false);
      onDeleted(format.id);
    } catch {
      setDeleteFailed(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="format-card" data-format-id={format.id} data-testid="format-card">
      <div className="format-card__head">
        {renaming ? (
          <form
            className="format-card__rename"
            onSubmit={(e) => {
              e.preventDefault();
              void rename();
            }}
          >
            <TextField label={t('formats.renameLabel')} value={name} onChange={setName} />
            <div className="format-card__renameActions">
              <Button type="submit" variant="primary" size="sm" loading={busy}>
                {t('formats.renameSave')}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setRenaming(false);
                  setName(format.name);
                  setRenameFailed(false);
                }}
              >
                {t('formats.renameCancel')}
              </Button>
            </div>
            {renameFailed ? <InlineMessage tone="error">{t('formats.renameFailed')}</InlineMessage> : null}
          </form>
        ) : (
          <h2 className="format-card__name">
            <Cell value={format.name} />
          </h2>
        )}
        <button type="button" className="format-card__sources" aria-expanded={expanded} aria-controls={expanded ? listId : undefined} onClick={() => setExpanded((e) => !e)}>
          <span className="src-arrow" aria-hidden="true">
            ←
          </span>
          <span>{format.sources === 0 ? t('formats.sources.none') : t(format.sources === 1 ? 'formats.sources.one' : 'formats.sources.other', { n: format.sources })}</span>
          <Icon name={expanded ? 'chevronUp' : 'chevronDown'} size={14} />
        </button>
        {counts.length > 0 && (
          <div className="format-card__badges">
            {counts.map((c) => (
              <Badge key={c.status} tone={statusTone(c.status)}>
                {c.text}
              </Badge>
            ))}
          </div>
        )}
      </div>

      <p className="muted tabular format-card__meta">
        {t('formats.meta', { columns: format.outputColumns, type: format.fileType })} ·{' '}
        {format.runCount === 0 ? t('formats.runs.never') : t(format.runCount === 1 ? 'formats.runs.one' : 'formats.runs.other', { n: number(format.runCount) })}
        {format.lastRunAt ? ` · ${t('formats.lastRun', { date: shortDate(format.lastRunAt, lang) })}` : ''}
      </p>

      {expanded && (
        <div id={listId} className="format-card__list">
          {sources.state.status === 'loading' && (
            <p className="muted">
              <Spinner size={14} /> {t('formats.loading')}
            </p>
          )}
          {sources.state.status === 'error' && <InlineMessage tone="error">{t('format.loadFailed')}</InlineMessage>}
          {sources.state.status === 'ready' && (
            <ul className="source-list">
              {sources.state.data.conversions.map((c) => (
                <li key={c.id} className="source-list__item" data-conversion-id={c.id}>
                  <Link to={`/formats/${format.id}/sources/${c.id}`}>
                    <Cell value={c.sourceName} />
                  </Link>
                  <Badge tone={statusTone(c.status)}>{statusLabel(t, c.status, c.acceptedDifferences)}</Badge>
                  {alsoFeeds?.get(c.id) ? <span className="muted">{t('formats.alsoFeeds', { names: alsoFeeds.get(c.id)!.map(isolate).join(', ') })}</span> : null}
                </li>
              ))}
              {sources.state.data.conversions.length === 0 && <li className="muted">{t('format.noSources')}</li>}
            </ul>
          )}
        </div>
      )}

      <div className="format-card__actions" role="group" aria-label={t('formats.actions', { name: format.name })}>
        <LinkButton variant="secondary" size="sm" to={`/convert?format=${encodeURIComponent(format.id)}`}>
          {t('formats.convert')}
        </LinkButton>
        <LinkButton variant="secondary" size="sm" to={`/formats/${format.id}/add-source`}>
          {t('formats.addSource')}
        </LinkButton>
        <LinkButton variant="secondary" size="sm" to={`/formats/${format.id}`} state={{ edit: true }}>
          {t('formats.editRules')}
        </LinkButton>
        <Button variant="ghost" size="sm" onClick={() => setRenaming(true)} disabled={renaming}>
          {t('formats.rename')}
        </Button>
        <Button variant="ghost" size="sm" icon="trash" onClick={() => setConfirmDelete(true)}>
          {t('formats.delete')}
        </Button>
      </div>

      <Dialog open={confirmDelete} onClose={() => setConfirmDelete(false)} title={t('formats.deleteTitle', { name: format.name })}>
        <p>{t(format.sources === 0 ? 'formats.deleteText.none' : format.sources === 1 ? 'formats.deleteText.one' : 'formats.deleteText.other', { n: format.sources })}</p>
        {deleteFailed ? <InlineMessage tone="error">{t('formats.deleteFailed')}</InlineMessage> : null}
        <div className="dialog__foot">
          <Button variant="primary" loading={busy} onClick={() => void remove()}>
            {t('formats.deleteConfirm')}
          </Button>
          <Button variant="ghost" onClick={() => setConfirmDelete(false)}>
            {t('formats.deleteCancel')}
          </Button>
        </div>
      </Dialog>
    </li>
  );
}
