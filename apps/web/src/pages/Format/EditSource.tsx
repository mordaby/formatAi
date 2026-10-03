// Edit a saved source (SPEC 8.11, 8.12): its rules open in the same map, editor and static checks as a fresh learn, but with no
// example (files are not stored). The live counter says so and offers an optional drop zone; saving writes a new version, and a
// change to the output side is said to be a change to the FORMAT, for all its sources, before and after.
import type { ConversionDetail, Format, FormatDetail, UpdateConversionResponse } from '@formatai/shared';
import { tiers } from '@formatai/shared';
import { useMemo, useState } from 'react';
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
import { Workbench, type WorkbenchInfo } from '../Result/Workbench';
import { ExampleDrop } from './ExampleDrop';
import { safeReturnTo } from './returnTo';
import { SaveChangesActions, SourceMessages, useSourceSave } from './sourceSave';
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
  const me = useMe();
  // `source`: how many formats this conversion's source feeds - an edit of the input side is then said to change all of them (SPEC 8.15).
  const [store] = useState(() => new EditorStore(conversion.rules, { format: { sourceCount }, source: { formats: conversion.sourceFormats }, exceptions: conversion.exampleExceptions }));
  // The format as the format lock (SPEC 8.12) compares with.
  const target = useMemo(() => ({ output: format.output, layout: format.layout, outputValidations: format.outputValidations }) as Format, [format]);

  const [example, setExample] = useState<{ exampleId: string; exampleInput: ExampleInputColumn[]; input: File } | null>(null);
  const saver = useSourceSave({ conversionId: conversion.id, version: conversion.version, onSaved });

  const actions = (info: WorkbenchInfo) => {
    // Saved, and nothing newer to save: the way on is back to converting (when Convert sent the person here).
    if (returnTo && notice && !info.dirty) {
      return (
        <LinkButton variant="primary" to={returnTo} iconEnd="arrow">
          {t('edit.backToConvert')}
        </LinkButton>
      );
    }
    return <SaveChangesActions info={info} saver={saver} />;
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
      <SourceMessages info={info} saver={saver} notice={notice} formatId={format.id} onReload={onReload} onSignIn={() => undefined} />
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
      // DECISION: no source lock here either (`source` is not passed): an edit of the input side is an edit of the SOURCE (SPEC 8.15) - written to the
      // source and to every other conversion of it, and said after saving (`sourceChanged`) - not a rejection. Only Add a source, which joins an
      // existing source it must fit, runs the browser's source-lock check (and it ignores aliases: the server merges them into the source on reuse).
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
          <Versions conversionId={conversion.id} refreshKey={saver.savedVersion} onRestored={onRestored} />
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
