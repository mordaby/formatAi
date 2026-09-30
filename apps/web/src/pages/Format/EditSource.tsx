// Edit a saved source (SPEC 8.11, 8.12): its rules open in the same map, editor and static checks as a fresh learn, but with no
// example (files are not stored). The live counter says so and offers an optional drop zone; saving writes a new version, and a
// change to the output side is said to be a change to the FORMAT, for all its sources, before and after.
import type { ConversionDetail, Format, FormatDetail, UpdateConversionRequest, UpdateConversionResponse } from '@formatai/shared';
import { tiers } from '@formatai/shared';
import { useMemo, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { LinkButton } from '../../app/LinkButton';
import { useMe } from '../../app/Me';
import { RequireSignIn } from '../../app/RequireSignIn';
import { useLoad } from '../../app/useLoad';
import { Cell } from '../../components/Cell';
import { EditorStore, type ExampleInputColumn } from '../../editor';
import { useI18n } from '../../i18n';
import { useServices } from '../../services';
import { Button, InlineMessage, Spinner } from '../../ui';
import { SaveFailureMessage } from '../Result/SaveMessages';
import { useSave } from '../Result/useSave';
import { Workbench, type WorkbenchInfo } from '../Result/Workbench';
import { ExampleDrop } from './ExampleDrop';
import { safeReturnTo } from './returnTo';
import { Versions } from './Versions';

export default function EditSourcePage() {
  const { t } = useI18n();
  return (
    <RequireSignIn title={t('formats.title')}>
      <EditSourceLoader />
    </RequireSignIn>
  );
}

function EditSourceLoader() {
  const { t } = useI18n();
  const { api } = useServices();
  const { id = '', conversionId = '' } = useParams();
  const [params] = useSearchParams();
  // Convert opens this editor with the way back to itself ("Change the rule"): only a same-site path is ever followed.
  const returnTo = safeReturnTo(params.get('returnTo'));
  const data = useLoad(
    async (signal) => {
      const [conversion, format] = await Promise.all([api.registry.getConversion(conversionId, signal), api.registry.getFormat(id, signal)]);
      return { conversion, format: format.format, sourceCount: format.conversions.length };
    },
    [id, conversionId],
  );
  // What the last save said (kept here, above the editor, because a change to the format loads everything again).
  const [notice, setNotice] = useState<UpdateConversionResponse | null>(null);

  if (data.state.status === 'loading') {
    return (
      <main id="main" className="page" tabIndex={-1}>
        <p className="muted">
          <Spinner size={14} /> {t('edit.loading')}
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
              {t(missing ? 'format.notFound' : 'edit.loadFailed')}
            </InlineMessage>
          </div>
        </section>
      </main>
    );
  }

  const { conversion, format, sourceCount } = data.state.data;
  return (
    <EditSource
      // A new version of the source or the format (a restore, a change that reached the format) starts the editor over from it.
      key={`${conversion.id}:${conversion.version}:${format.version}`}
      conversion={conversion}
      format={format}
      sourceCount={sourceCount}
      notice={notice}
      returnTo={returnTo}
      onSaved={(res) => {
        setNotice(res);
        if (res.formatChanged) data.reload();
      }}
      onRestored={() => {
        setNotice(null);
        data.reload();
      }}
      onReload={() => {
        setNotice(null);
        data.reload();
      }}
    />
  );
}

interface EditSourceProps {
  conversion: ConversionDetail;
  format: FormatDetail;
  sourceCount: number;
  notice: UpdateConversionResponse | null;
  /** A same-site path to go back to (Convert), or null. */
  returnTo: string | null;
  onSaved(res: UpdateConversionResponse): void;
  onRestored(): void;
  onReload(): void;
}

function EditSource({ conversion, format, sourceCount, notice, returnTo, onSaved, onRestored, onReload }: EditSourceProps) {
  const { t } = useI18n();
  const { api } = useServices();
  const me = useMe();
  const [store] = useState(() => new EditorStore(conversion.rules, { format: { sourceCount }, exceptions: conversion.exampleExceptions }));
  // The format as the format lock (SPEC 8.12) compares with.
  const target = useMemo(() => ({ output: format.output, layout: format.layout, outputValidations: format.outputValidations }) as Format, [format]);

  const [example, setExample] = useState<{ exampleId: string; exampleInput: ExampleInputColumn[]; input: File } | null>(null);
  const save = useSave<UpdateConversionResponse>();
  const version = useRef(conversion.version);
  const [savedVersion, setSavedVersion] = useState(conversion.version);

  const doSave = (info: WorkbenchInfo): void => {
    if (!info.metaStatus) return;
    const body: UpdateConversionRequest = {
      rules: info.rules,
      status: info.metaStatus,
      acceptedDifferences: info.differences ?? 0,
      exampleExceptions: info.exceptions,
      baseVersion: version.current,
    };
    void save.run({
      persist: () => api.registry.updateConversion(conversion.id, body),
      afterSaved: (res) => {
        version.current = res.conversion.version;
        setSavedVersion(res.conversion.version);
        info.editor.markSaved();
        onSaved(res);
      },
    });
  };

  const failure = save.state.status === 'error' ? save.state.error : undefined;
  const conflict = failure?.kind === 'api' && failure.code === 'versionConflict';

  const actions = (info: WorkbenchInfo) => {
    // Saved, and nothing newer to save: the way on is back to converting (when Convert sent the person here).
    if (returnTo && notice && !info.dirty) {
      return (
        <LinkButton variant="primary" to={returnTo} iconEnd="arrow">
          {t('edit.backToConvert')}
        </LinkButton>
      );
    }
    return (
      <>
        <Button variant="primary" loading={save.state.status === 'saving'} disabled={!info.dirty || info.metaStatus === null} onClick={() => doSave(info)}>
          {t('edit.save')}
        </Button>
        {!info.dirty ? <p className="muted">{t('edit.nothingToSave')}</p> : null}
      </>
    );
  };

  const banners = (info: WorkbenchInfo) => (
    <>
      {returnTo && (
        <p className="edit-back">
          <Link to={returnTo} data-testid="back-to-convert">
            {t('edit.backToConvert')}
          </Link>
        </p>
      )}
      {info.formatChange && (
        <div data-testid="format-change-warning">
          <InlineMessage tone="warn">{t(info.sourceCount === 1 ? 'edit.formatChange.warn.one' : 'edit.formatChange.warn.other', { n: info.sourceCount })}</InlineMessage>
        </div>
      )}
      {conflict ? (
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
      ) : failure ? (
        <SaveFailureMessage failure={failure} onSignIn={() => undefined} />
      ) : null}
      {notice && <SavedNotice notice={notice} formatId={format.id} />}
    </>
  );

  return (
    <Workbench
      store={store}
      exampleId={example?.exampleId}
      exampleInput={example?.exampleInput}
      inputFile={example?.input ?? null}
      tier={me.tier}
      // No format lock here: an edit of the output side IS an edit of the format (SPEC 8.12) - it is said before saving and reaches every source.
      formatChangeNote="banner"
      name={conversion.sourceName}
      learnedNote={t('edit.note', { format: format.name })}
      previewLimit={tiers[me.tier].previewRows}
      onSignIn={() => undefined}
      actions={actions}
      banners={banners}
      noExample={<ExampleDrop target={target} onLoaded={setExample} />}
      noExampleText={t('edit.noExample.title')}
      footer={
        <>
          <Versions conversionId={conversion.id} refreshKey={savedVersion} onRestored={onRestored} />
          <p>
            <Link to={`/formats/${format.id}`}>
              <Cell value={format.name} />
            </Link>
          </p>
        </>
      }
    />
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
