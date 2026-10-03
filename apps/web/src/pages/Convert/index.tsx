// Convert a file (SPEC 5 C, 8.15, 16.1 screen 6): drop a file, we find which saved source it is, run its conversion(s) in the
// worker (a source that feeds several formats asks which), let the user decide about flagged rows BEFORE each file is written
// (SPEC 21 v5 item 5), then download it (or all of them in a zip). No LLM call, no upload.
import { tiers, type Tier } from '@formatai/shared';
import { useEffect, useRef } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useI18n } from '../../i18n';
import { Button, DropZone, Icon, InlineMessage, Spinner } from '../../ui';
import { ChooseFormats } from './ChooseFormats';
import { ChooseSource } from './ChooseSource';
import { convertErrorText } from './errors';
import { AccountGate } from './Gate';
import { isolate } from './logic';
import { MapColumns } from './MapColumns';
import { MissingColumns } from './MissingColumns';
import { ReviewRows } from './ReviewRows';
import { RunDone } from './RunDone';
import { RunResults } from './RunResults';
import { editSourceUrl } from './session';
import { useConvertFlow, type Phase, type Target } from './useConvertFlow';

/** Phases where the dropped file is still just a file (the user may swap it); later the file is context. */
const SHOWS_DROP: ReadonlySet<Phase['kind']> = new Set(['idle', 'matching', 'choose', 'noMatch', 'missing', 'running', 'error']);

/** The conversion a phase is working on, when it has one (the "Matched to X of Y" line). */
function targetOf(phase: Phase): Target | null {
  return phase.kind === 'running' || phase.kind === 'review' || phase.kind === 'writing' ? phase.target : null;
}

export default function ConvertPage() {
  const { t } = useI18n();
  return (
    <main id="main" className="page page--convert" tabIndex={-1}>
      <section className="tool">
        <div className="view convert">
          <header className="tool__head">
            <h1>{t('conv.title')}</h1>
            <p className="lead">{t('conv.lead')}</p>
          </header>
          <AccountGate title="conv.wall.title" text="conv.wall.text">
            {(user) => <ConvertTool tier={user.tier} />}
          </AccountGate>
        </div>
      </section>
    </main>
  );
}

function ConvertTool({ tier }: { tier: Tier }) {
  const i18n = useI18n();
  const { t } = i18n;
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const formatId = params.get('format');
  const wantsResume = params.get('resume') === '1';
  const flow = useConvertFlow({ enabled: true, formatId, maxBytes: tiers[tier].maxFileBytes });
  const { phase, sources } = flow;

  // Coming back from the rules editor: convert the held file again, with the edited rules.
  const resumed = useRef(false);
  useEffect(() => {
    if (!wantsResume || resumed.current || sources.status !== 'ready') return;
    resumed.current = true;
    flow.resume();
    navigate(formatId ? `/convert?format=${encodeURIComponent(formatId)}` : '/convert', { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wantsResume, sources.status]);

  // Only sources that feed a format can run; on `?format=`, only that format's conversion of them (SPEC 8.15).
  const { entries } = flow;
  const restrictedName = formatId && sources.status === 'ready' ? sources.entries.flatMap((e) => e.conversions).find((c) => c.formatId === formatId)?.formatName : undefined;
  const target = targetOf(phase);

  const changeRule = (): void => {
    if (phase.kind !== 'review') return;
    flow.holdForEditing(phase.target);
    const back = `/convert?resume=1${formatId ? `&format=${encodeURIComponent(formatId)}` : ''}`;
    // The way back is the address of the page as it is now, so the browser's Back button returns here too.
    navigate(back, { replace: true });
    navigate(editSourceUrl(phase.target.formatId, phase.target.conversionId, back));
  };

  let body;
  if (sources.status === 'loading') {
    body = (
      <p className="muted conv__wait" role="status">
        <Spinner size={16} /> {t('conv.loading')}
      </p>
    );
  } else if (sources.status === 'error') {
    body = <InlineMessage tone="error">{t('conv.sourcesError')}</InlineMessage>;
  } else if (entries.length === 0) {
    body = (
      <InlineMessage
        tone="info"
        title={t('conv.noSources.title')}
        actions={
          <>
            <Link className="btn btn--primary" to="/">
              {t('conv.noSources.action')}
            </Link>
            <Link className="btn btn--ghost" to="/formats">
              {t('conv.noSources.formats')}
            </Link>
          </>
        }
      >
        {t(formatId ? 'conv.noSources.textFormat' : 'conv.noSources.text')}
      </InlineMessage>
    );
  } else {
    body = (
      <>
        {SHOWS_DROP.has(phase.kind) ? (
          <DropZone
            label={t('conv.drop.label')}
            caption={t('conv.drop.caption')}
            file={flow.file}
            info={flow.file ? { status: 'ready', rows: null, columns: null } : undefined}
            onFile={flow.start}
            onClear={flow.reset}
            maxBytes={tiers[tier].maxFileBytes}
            disabled={phase.kind === 'matching' || phase.kind === 'running'}
          />
        ) : flow.file ? (
          <p className="conv__file">
            <Icon name="file" size={16} /> {t('conv.file', { name: isolate(flow.file.name) })}
          </p>
        ) : null}
        {target ? (
          <p className="muted conv__target" data-testid="target-line">
            {t('conv.match.auto', { source: isolate(target.sourceName), format: isolate(target.formatName) })}
          </p>
        ) : phase.kind === 'mapping' || phase.kind === 'missing' || phase.kind === 'formats' ? (
          <p className="muted conv__target" data-testid="target-line">
            {t('conv.match.source', { source: isolate(phase.source.name) })}
          </p>
        ) : null}

        {phase.kind === 'idle' ? <p className="muted">{t('conv.private')}</p> : null}
        {phase.kind === 'matching' ? (
          <p className="muted conv__wait" role="status">
            <Spinner size={16} /> {t('conv.matching')}
          </p>
        ) : null}
        {phase.kind === 'running' || phase.kind === 'writing' ? (
          <p className="muted conv__wait" role="status">
            <Spinner size={16} /> {t(phase.kind === 'running' ? 'conv.running' : 'conv.writing')}
          </p>
        ) : null}
        {phase.kind === 'choose' ? <ChooseSource options={phase.options} entries={entries} onChoose={flow.choose} /> : null}
        {phase.kind === 'noMatch' ? (
          <InlineMessage
            tone="block"
            title={t('conv.noMatch.title')}
            todo={t('conv.noMatch.todo')}
            actions={
              <Link className="btn btn--secondary" to="/formats">
                {t('conv.noMatch.action')}
              </Link>
            }
          >
            {t('conv.noMatch.text')}
          </InlineMessage>
        ) : null}
        {phase.kind === 'mapping' ? (
          <MapColumns sourceName={phase.source.name} formats={phase.source.conversions.map((c) => c.formatName)} match={phase.match} onSubmit={flow.submitMapping} onCancel={flow.reset} />
        ) : null}
        {phase.kind === 'missing' ? (
          <MissingColumns sourceName={phase.source.name} formats={phase.source.conversions.map((c) => c.formatName)} missing={phase.missing} onAnotherFile={flow.reset} />
        ) : null}
        {phase.kind === 'formats' ? <ChooseFormats source={phase.source} onContinue={flow.chooseFormats} onCancel={flow.reset} /> : null}
        {phase.kind === 'review' ? (
          <ReviewRows
            target={phase.target}
            step={phase.step}
            rows={phase.rows}
            rowInputs={phase.rowInputs}
            choices={phase.choices}
            onChoice={flow.setChoice}
            onKeepAll={flow.keepAll}
            onSkipAll={flow.skipAll}
            onClear={flow.clearChoices}
            onChangeRule={changeRule}
            onCreate={flow.create}
          />
        ) : null}
        {phase.kind === 'done' ? <RunDone target={phase.target} finished={phase.finished} aliasNotSaved={flow.aliasNotSaved} onDownload={flow.download} onAnother={flow.reset} /> : null}
        {phase.kind === 'results' ? (
          <RunResults
            sourceName={phase.source.name}
            results={phase.results}
            failed={phase.failed}
            aliasNotSaved={flow.aliasNotSaved}
            packing={flow.packing}
            packError={flow.packError}
            onDownloadOne={flow.downloadOne}
            onDownloadAll={flow.downloadAll}
            onAnother={flow.reset}
          />
        ) : null}
        {phase.kind === 'error' ? (
          <InlineMessage
            tone="error"
            actions={
              <Button variant="secondary" onClick={flow.reset}>
                {t('conv.error.tryAgain')}
              </Button>
            }
          >
            {convertErrorText(i18n, phase.error)}
          </InlineMessage>
        ) : null}
      </>
    );
  }

  return (
    <>
      {formatId && restrictedName ? (
        <p className="muted" data-testid="only-format">
          {t('conv.onlyFormat', { format: isolate(restrictedName) })} <Link to="/convert">{t('conv.allFormats')}</Link>
        </p>
      ) : null}
      {body}
    </>
  );
}
