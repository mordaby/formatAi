import type { ConversionSummary } from '@formatai/shared';
import { useState } from 'react';
import { isApiError } from '../../api';
import { LinkButton } from '../../app/LinkButton';
import { Cell } from '../../components/Cell';
import { useI18n } from '../../i18n';
import { useServices } from '../../services';
import { Badge, Button, Dialog, InlineMessage } from '../../ui';
import { TextField } from '../Result/fields';
import { shortDate, statusLabel, statusTone } from '../Formats/statusText';

export interface SourceRowProps {
  formatId: string;
  source: ConversionSummary;
  onRenamed(source: ConversionSummary): void;
  onDeleted(id: string): void;
  /**
   * "Formats with several sources" is on: the row is a source (rename, delete). Off: it is one of the format's input files - named by its saved
   * name, with no rename, and "Remove this input file" only when it is not the format's last one (the format itself is deleted from My formats).
   */
  explicit: boolean;
  /** The format has other inputs besides this one. */
  others: boolean;
}

/** One source of a format: its name, status and last run, and what can be done with it (edit its rules, rename, delete). */
export function SourceRow({ formatId, source, onRenamed, onDeleted, explicit, others }: SourceRowProps) {
  const { t, code, lang } = useI18n();
  const { api } = useServices();
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(source.sourceName);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const rename = async (): Promise<void> => {
    const next = name.trim();
    if (next === '' || next === source.sourceName) {
      setRenaming(false);
      return;
    }
    setBusy(true);
    setProblem(null);
    try {
      const res = await api.registry.updateConversion(source.id, { sourceName: next });
      onRenamed(res.conversion);
      setRenaming(false);
    } catch (e) {
      // "Another source of this format already has that name", or the plain failure.
      setProblem(isApiError(e) && e.code === 'nameTaken' ? code({ kind: 'apiError', code: 'nameTaken' }) : t('formats.renameFailed'));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (): Promise<void> => {
    setBusy(true);
    setProblem(null);
    try {
      await api.registry.deleteConversion(source.id);
      setConfirmDelete(false);
      onDeleted(source.id);
    } catch {
      setProblem(t('formats.deleteFailed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="source-row" data-conversion-id={source.id} data-testid="source-row">
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
                  setName(source.sourceName);
                  setProblem(null);
                }}
              >
                {t('formats.renameCancel')}
              </Button>
            </div>
          </form>
        ) : (
          <h3 className="source-row__name">
            <Cell value={source.sourceName} />
          </h3>
        )}
        <Badge tone={statusTone(source.status)}>{statusLabel(t, source.status, source.acceptedDifferences)}</Badge>
      </div>
      <p className="muted tabular">
        {source.runCount === 0 ? t('format.source.never') : t(source.runCount === 1 ? 'formats.runs.one' : 'formats.runs.other', { n: source.runCount })}
        {source.lastRun ? ` · ${t('format.source.lastRun', { rows: source.lastRun.rows, flagged: source.lastRun.flagged })}` : ''}
        {source.lastRunAt ? ` · ${t('formats.lastRun', { date: shortDate(source.lastRunAt, lang) })}` : ''}
      </p>
      {source.status === 'needsReview' && <p className="muted">{t('format.source.changed')}</p>}
      {problem ? <InlineMessage tone="error">{problem}</InlineMessage> : null}
      <div className="format-card__actions">
        <LinkButton variant="secondary" size="sm" to={`/formats/${formatId}/sources/${source.id}`}>
          {t('format.source.edit')}
        </LinkButton>
        {explicit ? (
          <Button variant="ghost" size="sm" onClick={() => setRenaming(true)} disabled={renaming}>
            {t('format.source.rename')}
          </Button>
        ) : null}
        {explicit || others ? (
          <Button variant="ghost" size="sm" icon="trash" onClick={() => setConfirmDelete(true)}>
            {t('format.source.delete')}
          </Button>
        ) : null}
      </div>

      <Dialog open={confirmDelete} onClose={() => setConfirmDelete(false)} title={t('format.source.deleteTitle', { name: source.sourceName })}>
        <p>{t('format.source.deleteText')}</p>
        <div className="dialog__foot">
          <Button variant="primary" loading={busy} onClick={() => void remove()}>
            {t('format.source.deleteConfirm')}
          </Button>
          <Button variant="ghost" onClick={() => setConfirmDelete(false)}>
            {t('formats.deleteCancel')}
          </Button>
        </div>
      </Dialog>
    </li>
  );
}
