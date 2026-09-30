// Saving edits of a saved source (SPEC 8.11 "Saving", 8.12): PATCH /api/conversions/:id writes a new version, and a change to the
// output side is a change to the FORMAT - said before saving and after. Shared by the saved-source editor and by the Result screen
// once a learn has been saved (from then on it is the editor of that source).
import type { UpdateConversionRequest, UpdateConversionResponse } from '@formatai/shared';
import { useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Cell } from '../../components/Cell';
import { useI18n } from '../../i18n';
import { useServices } from '../../services';
import { Button, InlineMessage } from '../../ui';
import { SaveFailureMessage } from '../Result/SaveMessages';
import { useSave, type SaveFailure, type UseSave } from '../Result/useSave';
import type { WorkbenchInfo } from '../Result/Workbench';

export interface SourceSaver {
  save: UseSave<UpdateConversionResponse>;
  /** Changes with every version saved here (the list of versions reads again). */
  savedVersion: number;
  failure: SaveFailure | undefined;
  /** Someone else saved a newer version in the meantime. */
  conflict: boolean;
  /** Saves `info.rules` as a new version of the source (nothing when it cannot be saved right now). */
  doSave(info: WorkbenchInfo): void;
  /** The source is now at this version (opened from the server, or restored). */
  setVersion(version: number): void;
}

export interface SourceSaveOptions {
  /** The saved source the rules belong to (read when saving). */
  conversionId: string;
  /** The version the editor was opened from (or the first save wrote). */
  version: number;
  /** After a successful save (the editor is marked saved before this is called). */
  onSaved(res: UpdateConversionResponse): void;
}

export function useSourceSave({ conversionId, version, onSaved }: SourceSaveOptions): SourceSaver {
  const { api } = useServices();
  const save = useSave<UpdateConversionResponse>();
  const current = useRef(version);
  const [savedVersion, setSavedVersion] = useState(version);

  const setVersion = (next: number): void => {
    current.current = next;
    setSavedVersion(next);
  };

  const doSave = (info: WorkbenchInfo): void => {
    if (!info.metaStatus) return;
    const body: UpdateConversionRequest = {
      rules: info.rules,
      status: info.metaStatus,
      acceptedDifferences: info.differences ?? 0,
      exampleExceptions: info.exceptions,
      baseVersion: current.current,
    };
    void save.run({
      persist: () => api.registry.updateConversion(conversionId, body),
      afterSaved: (res) => {
        setVersion(res.conversion.version);
        info.editor.markSaved();
        onSaved(res);
      },
    });
  };

  const failure = save.state.status === 'error' ? save.state.error : undefined;
  const conflict = failure?.kind === 'api' && failure.code === 'versionConflict';
  return { save, savedVersion, failure, conflict, doSave, setVersion };
}

/** "Save changes" (only while there is something to save), and - `extra` - the other buttons beside it. */
export function SaveChangesActions({ info, saver, extra }: { info: WorkbenchInfo; saver: SourceSaver; extra?: ReactNode }) {
  const { t } = useI18n();
  return (
    <>
      <div className="result-head__buttons">
        <Button variant="primary" loading={saver.save.state.status === 'saving'} disabled={!info.dirty || info.metaStatus === null} onClick={() => saver.doSave(info)}>
          {t('edit.save')}
        </Button>
        {extra}
      </div>
      {!info.dirty ? <p className="muted">{t('edit.nothingToSave')}</p> : null}
    </>
  );
}

export interface SourceMessagesProps {
  info: WorkbenchInfo;
  saver: SourceSaver;
  /** What the last save said, if there was one. */
  notice: UpdateConversionResponse | null;
  formatId: string;
  /** "Reload" after a save that lost to another edit. */
  onReload(): void;
  onSignIn(): void;
}

/** Between the header and the live check: the format-change warning, what stopped the last save, and what the last save did. */
export function SourceMessages({ info, saver, notice, formatId, onReload, onSignIn }: SourceMessagesProps) {
  const { t } = useI18n();
  return (
    <>
      {info.formatChange && (
        <div data-testid="format-change-warning">
          <InlineMessage tone="warn">{t(info.sourceCount === 1 ? 'edit.formatChange.warn.one' : 'edit.formatChange.warn.other', { n: info.sourceCount })}</InlineMessage>
        </div>
      )}
      {saver.conflict ? (
        <InlineMessage
          tone="warn"
          actions={
            <Button variant="secondary" size="sm" onClick={onReload}>
              {t('edit.reload')}
            </Button>
          }
        >
          {t('edit.conflict')}
        </InlineMessage>
      ) : saver.failure ? (
        <SaveFailureMessage failure={saver.failure} onSignIn={onSignIn} />
      ) : null}
      {notice && <SavedNotice notice={notice} formatId={formatId} />}
    </>
  );
}

/** After a save: which version it is, and - when it changed the format - who else it reached and which sources now need a look. */
function SavedNotice({ notice, formatId }: { notice: UpdateConversionResponse; formatId: string }) {
  const { t } = useI18n();
  return (
    <div className="saved-notice" data-testid="saved-notice">
      <InlineMessage tone="info">{t('edit.saved', { version: notice.conversion.version })}</InlineMessage>
      {notice.formatChanged && (
        <InlineMessage tone="info">
          {notice.affectedSources === 0
            ? t('edit.formatChange.done.none')
            : t(notice.affectedSources === 1 ? 'edit.formatChange.done.one' : 'edit.formatChange.done.other', { n: notice.affectedSources })}
        </InlineMessage>
      )}
      {notice.needsReview.length > 0 && (
        <InlineMessage tone="warn" title={t(notice.needsReview.length === 1 ? 'edit.needsReview.one' : 'edit.needsReview.other', { n: notice.needsReview.length })} todo={t('edit.needsReview.text')}>
          <ul className="problem-list">
            {notice.needsReview.map((s) => (
              <li key={s.id}>
                <Link to={`/formats/${formatId}/sources/${s.id}`}>
                  <Cell value={s.sourceName} />
                </Link>
              </li>
            ))}
          </ul>
        </InlineMessage>
      )}
    </div>
  );
}
