// Add a source to an existing format (SPEC 5 A2, 8.12, 8.15): optionally name it, drop its input file and an output made from it by hand;
// which Source object it belongs to is automatic and silent (SPEC 8.15: there is no source UI in the MVP);
// the output must match the format (same headers in order, same file type) or the screen says which columns differ. Then the
// learn runs in attach mode - the format is the `target`, the AI only decides how THIS input produces the format's columns - and
// the result opens in the same map and editor, ready to save as a new conversion of the format (a link from the source to it).
import type { AttachSourceRequest, AttachSourceResponse, Format, FormatDetail, SourceSummary } from '@formatai/shared';
import { defaultSourceName, limits, promptVersion } from '@formatai/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { isAiQuotaHit, useAiLimit } from '../../app/AiLimit';
import { useOnAi } from '../../app/aiReport';
import { useLearnSession } from '../../app/LearnSession';
import { LinkButton } from '../../app/LinkButton';
import { useMe } from '../../app/Me';
import { RequireSignIn } from '../../app/RequireSignIn';
import { SendPanel, SentLink } from '../../app/SendPanel';
import { useSignIn } from '../../app/SignIn';
import { useFileInfo } from '../../app/useFileInfo';
import { useLoad } from '../../app/useLoad';
import { webConfig } from '../../config';
import { copiedListsOf, EditorStore, findingsToConfirm } from '../../editor';
import type { AiInfo, SentRecord } from '../../flow/learnFlow';
import { useLearnFlow } from '../../flow/useLearnFlow';
import { Cell } from '../../components/Cell';
import { useI18n } from '../../i18n';
import { useServices } from '../../services';
import { Button, DropZone, Icon, InlineMessage, Spinner } from '../../ui';
import { HomeMasking } from '../HomeMasking';
import { LearningError } from '../LearningError';
import { LearningNotReady } from '../LearningNotReady';
import { LearningPreflight } from '../LearningPreflight';
import { LearningProgress } from '../LearningProgress';
import { isRunning, useProgressVisible, useStepHistory } from '../learningSteps';
import { TextField } from '../Result/fields';
import { useCopiedListGate } from '../Result/CopiedListSave';
import { compareOutput, fileTypeOfName, type OutputMismatch, type OutputFileType } from '../Result/matchFormat';
import { SaveFailureMessage } from '../Result/SaveMessages';
import { defaultFormatName } from '../Result/session';
import { useDownload } from '../Result/useDownload';
import { useSave } from '../Result/useSave';
import { Workbench, type WorkbenchInfo } from '../Result/Workbench';
import type { LearnOutput } from '../../worker/engineApi';

export default function AddSourcePage() {
  const { t } = useI18n();
  return (
    <RequireSignIn title={t('formats.title')}>
      <AddSourceLoader />
    </RequireSignIn>
  );
}

function AddSourceLoader() {
  const { t } = useI18n();
  const { api } = useServices();
  const { id = '' } = useParams();
  // The format, and the names the company's sources already use. The list is a convenience (SPEC 8.15): when it can't be read the save
  // goes on, and the server has the last word on a name in use.
  const data = useLoad(async (signal) => {
    const [detail, sources] = await Promise.all([
      api.registry.getFormat(id, signal),
      (async (): Promise<SourceSummary[]> => {
        try {
          return await api.registry.listSources(signal);
        } catch {
          return [];
        }
      })(),
    ]);
    return { detail, sources };
  }, [id]);

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
  const { detail, sources } = data.state.data;
  return <AddSource format={detail.format} sourceCount={detail.conversions.length} sources={sources} formatSourceNames={detail.conversions.map((c) => c.sourceName)} />;
}

/** The format as a `Format` for the learn (the API keeps it opaque). */
function formatOf(detail: FormatDetail): Format {
  return { output: detail.output, layout: detail.layout, outputValidations: detail.outputValidations } as Format;
}

interface OutputRead {
  status: 'reading' | 'ready' | 'unreadable' | 'noTable';
  headers: string[];
  fileType: OutputFileType;
}

/** The output's headers, read in the worker (nothing is sent), and its file type from the name. */
function useOutputRead(file: File | null): OutputRead | undefined {
  const { engine } = useServices();
  const [entry, setEntry] = useState<{ file: File; read: OutputRead } | null>(null);
  useEffect(() => {
    if (!file) {
      setEntry(null);
      return;
    }
    let live = true;
    const fileType = fileTypeOfName(file.name);
    setEntry({ file, read: { status: 'reading', headers: [], fileType } });
    (async () => {
      let read: OutputRead;
      try {
        const res = await engine.readHeaders({ file: { name: file.name, bytes: await file.arrayBuffer() } });
        read = res.ok ? { status: 'ready', headers: res.headers, fileType } : { status: res.reason === 'noTable' ? 'noTable' : 'unreadable', headers: [], fileType };
      } catch {
        read = { status: 'unreadable', headers: [], fileType };
      }
      if (live) setEntry({ file, read });
    })();
    return () => {
      live = false;
    };
  }, [engine, file]);
  if (!file) return undefined;
  return entry?.file === file ? entry.read : { status: 'reading', headers: [], fileType: fileTypeOfName(file.name) };
}

interface AddSourceProps {
  format: FormatDetail;
  sourceCount: number;
  /** The company's sources (SPEC 8.15): only their names are used, for the names a new one can't take. */
  sources: SourceSummary[];
  /** The names of this format's sources (also names taken: a fallback for when the list of all sources could not be read). */
  formatSourceNames: string[];
}

function AddSource({ format, sourceCount, sources, formatSourceNames }: AddSourceProps) {
  const { t, code } = useI18n();
  const me = useMe();
  const meRef = useRef(me);
  meRef.current = me;
  const signIn = useSignIn();
  const location = useLocation();
  const session = useLearnSession();
  const fromSession = (location.state as { fromSession?: boolean } | null)?.fromSession === true && session.input !== null && session.output !== null;

  // (a stable function: a new one every render would make a new flow every render, and drop the learn in progress)
  const getTier = useCallback(() => meRef.current.tier, []);
  // What the learn learns about the AI step (what is left, a refusal) is told the app the same way as everywhere (app/aiReport.ts).
  const onAi = useOnAi();
  const flow = useLearnFlow({ getTier, onAi });
  const target = useMemo(() => formatOf(format), [format]);

  const [sourceName, setSourceName] = useState('');
  const [input, setInput] = useState<File | null>(fromSession ? session.input : null);
  const [output, setOutput] = useState<File | null>(fromSession ? session.output : null);
  const [masking, setMasking] = useState(session.masking);
  const [sendOpen, setSendOpen] = useState(false);
  const inputInfo = useFileInfo(input, 'input');
  const outputInfo = useFileInfo(output, 'output');
  const outputRead = useOutputRead(output);

  const { state } = flow;
  const steps = useStepHistory(state);
  const progressVisible = useProgressVisible(state);

  const headerless = (format.output as { file?: { header?: boolean } }).file?.header === false;
  const formatShape = useMemo(
    () => ({ headers: format.outputHeaders, fileType: format.fileType as OutputFileType, headerless }),
    [format.outputHeaders, format.fileType, headerless],
  );
  const mismatches: OutputMismatch[] = outputRead?.status === 'ready' ? compareOutput(formatShape, { headers: outputRead.headers, fileType: outputRead.fileType }) : [];
  // DECISION (SPEC 8.15, MVP): which Source object this file belongs to is automatic and silent - the server recognizes one of the company's
  // sources from the example input's headers and reuses it, or creates one. The name is optional; empty, the server names it.
  const nameTrimmed = sourceName.trim();
  // Source names belong to the company, not to the format (SPEC 8.15): a new name is compared with ALL of them, case-insensitively.
  const takenNames = useMemo(() => [...sources.map((s) => s.name), ...formatSourceNames], [sources, formatSourceNames]);
  const nameTaken = nameTrimmed !== '' && takenNames.some((n) => n.trim().toLowerCase() === nameTrimmed.toLowerCase());

  const ready =
    !nameTaken &&
    input !== null &&
    output !== null &&
    inputInfo?.status !== 'unreadable' &&
    outputInfo?.status !== 'unreadable' &&
    outputRead?.status === 'ready' &&
    mismatches.length === 0;

  const begin = (): void => {
    if (!ready || !input || !output) return;
    void flow.start({ input, output, masking, ai: 'allowed', target });
  };

  // The AI step was refused for the quota: the out-of-AI-formats dialog says so (and when they come back) over the form, the files kept -
  // not an error screen. (The known quota is 0 from here on: `onAi` said so.)
  const aiLimit = useAiLimit();
  const quotaError = state.status === 'error' && isAiQuotaHit(state.error) ? state.error : undefined;
  const { cancel: reset } = flow;
  useEffect(() => {
    if (!quotaError) return;
    reset();
    aiLimit.open({ period: quotaError.period });
  }, [quotaError, reset, aiLimit]);

  let view;
  if (state.status === 'warn' || state.status === 'blocked') {
    view = <LearningPreflight key={state.status} state={state} onConfirm={flow.confirm} onCancel={flow.cancel} onSignIn={() => signIn.open('keepGoing')} />;
  } else if (state.status === 'notReady') {
    view = <LearningNotReady key="notReady" result={state.result} onChangeFiles={flow.cancel} />;
  } else if (state.status === 'error' && !quotaError) {
    view = <LearningError key="error" error={state.error} onRetry={begin} onChangeFiles={flow.cancel} onSignIn={() => signIn.open('keepGoing')} />;
  } else if (state.status === 'done' && state.result.rules) {
    view = (
      <AttachResult
        key="result"
        result={state.result}
        ai={state.ai}
        sent={state.sent}
        format={format}
        target={target}
        sourceCount={sourceCount}
        sourceName={nameTrimmed}
        input={input}
        masking={masking}
        onChangeFiles={flow.cancel}
      />
    );
  } else if (progressVisible && isRunning(state)) {
    view = (
      <LearningProgress key="progress" state={state} steps={steps} inputName={input?.name} outputName={output?.name} masking={masking} onCancel={flow.cancel} />
    );
  } else {
    view = (
      <div className="view" key="form">
        <p>
          <Link to="/formats">{t('format.back')}</Link>
        </p>
        <header className="tool__head">
          <h1>{t('add.title', { name: format.name })}</h1>
          <p className="lead">{t('add.lead')}</p>
        </header>

        <div className="add-format" data-testid="add-format-columns">
          <p className="muted">{t('add.formatIs', { n: format.outputHeaders.length })}</p>
          <ol className="chips">
            {format.outputHeaders.map((h, i) => (
              <li key={`${i}-${h}`}>
                <Cell value={h} />
              </li>
            ))}
          </ol>
        </div>

        {fromSession ? <InlineMessage tone="info">{t('add.fromMatch')}</InlineMessage> : null}

        <TextField
          label={t('add.sourceName')}
          hint={nameTaken ? undefined : t('add.sourceNameHint')}
          value={sourceName}
          onChange={setSourceName}
          invalid={nameTaken}
          className="add-name"
        />
        {nameTaken ? <InlineMessage tone="block">{code({ kind: 'apiError', code: 'nameTaken' })}</InlineMessage> : null}

        <div className="zones">
          <DropZone
            label={t('home.input.title')}
            caption={t('home.input.caption')}
            file={input}
            info={inputInfo}
            onFile={setInput}
            onClear={() => setInput(null)}
            maxBytes={webConfig.maxFileBytes}
            disabled={isRunning(state)}
          />
          <span className="zones__arrow" aria-hidden="true">
            <Icon name="arrow" size={22} />
          </span>
          <DropZone
            label={t('home.output.title')}
            caption={t('home.output.caption')}
            file={output}
            info={outputInfo}
            onFile={setOutput}
            onClear={() => setOutput(null)}
            maxBytes={webConfig.maxFileBytes}
            disabled={isRunning(state)}
          />
        </div>

        {outputRead?.status === 'reading' && (
          <p className="muted">
            <Spinner size={14} /> {t('add.checking')}
          </p>
        )}
        {mismatches.length > 0 && <MismatchList mismatches={mismatches} />}

        <HomeMasking masking={masking} onChange={setMasking} disabled={isRunning(state)} />
        <div className="privacy">
          <p className="privacy__line">
            <Icon name="lock" size={16} />
            <span>{t('masking.always')}</span>
            <Button variant="link" aria-expanded={sendOpen} onClick={() => setSendOpen((o) => !o)}>
              {t('sendPanel.title')}
            </Button>
          </p>
          {sendOpen && <SendPanel sent={flow.state.sent} masking={masking} onClose={() => setSendOpen(false)} />}
        </div>

        <div className="learn-row">
          <Button variant="primary" iconEnd="arrow" disabled={!ready} loading={isRunning(state)} onClick={begin}>
            {t('add.learn')}
          </Button>
          {!ready && mismatches.length === 0 && <p className="learn-row__hint">{t('add.needFiles')}</p>}
        </div>
      </div>
    );
  }

  // The result screen brings its own <main>.
  if (state.status === 'done' && state.result.rules) return view;
  return (
    <main id="main" className="page" tabIndex={-1}>
      <section className="tool">{view}</section>
    </main>
  );
}

/** Which columns differ, in words, and what to do about it (SPEC 5 A2 step 1). */
export function MismatchList({ mismatches }: { mismatches: OutputMismatch[] }) {
  const { t } = useI18n();
  const typeName = (type: OutputFileType): string => t(`add.type.${type}` as const);
  return (
    <InlineMessage tone="block" title={t('add.mismatch.title')} todo={t('add.mismatch.todo')}>
      <ul className="problem-list" data-testid="output-mismatch">
        {mismatches.map((m, i) => (
          <li key={i} data-kind={m.kind}>
            {m.kind === 'fileType'
              ? t('add.mismatch.file', { expected: typeName(m.expected), actual: typeName(m.actual) })
              : m.kind === 'count'
                ? t('add.mismatch.count', { expected: m.expected, actual: m.actual })
                : m.kind === 'column'
                  ? t('add.mismatch.column', { n: m.n, expected: m.expected, actual: m.actual })
                  : m.kind === 'missing'
                    ? t('add.mismatch.missing', { n: m.n, expected: m.expected })
                    : t('add.mismatch.extra', { n: m.n, actual: m.actual })}
          </li>
        ))}
      </ul>
    </InlineMessage>
  );
}

interface AttachResultProps {
  result: LearnOutput;
  ai: AiInfo | undefined;
  /** What the learn sent ("See what we send", SPEC 15): shown with the result too. */
  sent: readonly SentRecord[];
  format: FormatDetail;
  target: Format;
  sourceCount: number;
  /** The name typed for the file's source ('' = none: the server names it, unless it recognizes one of the company's). */
  sourceName: string;
  input: File | null;
  masking: boolean;
  onChangeFiles(): void;
}

/** The learned source, in the same map and editor as any result; saving adds it to the format (the format lock is checked live and by the server). */
function AttachResult({ result, ai, sent, format, target, sourceName, input, masking, onChangeFiles }: AttachResultProps) {
  const { t } = useI18n();
  const { api } = useServices();
  const me = useMe();
  const signIn = useSignIn();
  const onAi = useOnAi();
  const navigate = useNavigate();
  const rules = result.rules!;
  // The session ended (a save refused for it): read who is signed in, and sign in again in a new tab - this page, the learn and the edits
  // stay as they are (RequireSignIn keeps the screen while the wall is up).
  const signInAgain = (): void => {
    void me.refresh();
    signIn.open('expired', { newTab: true });
  };
  const [store] = useState(() => new EditorStore(rules));
  const save = useSave<AttachSourceResponse>();
  // A list copied from the example (owner decision 2026-10-06), and an identifier-shaped value (docs/proposals/saved-format-contents.md
  // section 6): asked at Save only, in one popup, before the source is stored (`CopiedListSave`).
  const copied = useMemo(() => copiedListsOf(result.path === 'llm' ? result.oneTimers?.questions : undefined), [result]);
  const gate = useCopiedListGate();
  // What the header calls the result before it is saved: the name typed, or - when the server will pick it - the file's.
  const shownName = sourceName !== '' ? sourceName : defaultFormatName(input?.name, t('result.untitled'));

  const doSave = (info: WorkbenchInfo): void => {
    if (!info.metaStatus || !input) return;
    const learnPath = result.path === 'llm' ? (ai?.cached ? 'cache' : 'llm') : 'local';
    // The example input's HEADERS (structure only): what the server matches against the company's sources (SPEC 8.15).
    const inputHeaders = result.exampleInput?.map((c) => c.header);
    const suggestedSourceName = defaultSourceName(input.name);
    const body: AttachSourceRequest = {
      rules: info.rules,
      status: info.metaStatus,
      acceptedDifferences: info.differences ?? 0,
      exampleExceptions: info.exceptions,
      learnPath,
      masking,
      // The name typed is used if the server has to create a source; left empty, the example input file's name is the default
      // (SPEC 21 v11 item 9), and the server makes it unique. Nothing when no name is left of it ("Source N").
      ...(sourceName !== '' ? { sourceName } : suggestedSourceName !== '' ? { suggestedSourceName } : {}),
      ...(inputHeaders && inputHeaders.length > 0 ? { inputHeaders } : {}),
      ...(learnPath === 'local' ? {} : { promptVersion }),
    };
    void save.run({
      persist: () => api.registry.attachSource(format.id, body),
      afterSaved: () => {
        info.editor.markSaved();
        if (info.metaStatus === 'differencesAccepted' && ai?.learnId) {
          api.registry
            .learnOutcome(ai.learnId, 'accepted')
            .then((r) => onAi({ quota: r.quota }))
            .catch(() => undefined);
        }
        void me.refreshFormats();
      },
    });
  };

  const failure = save.state.status === 'error' ? save.state.error : undefined;
  const problemsTitle =
    failure?.kind !== 'api' ? undefined : failure.code === 'formatMismatch' ? t('add.saveMismatch.title') : failure.code === 'sourceMismatch' ? t('add.saveSourceMismatch.title') : undefined;

  // "Download the file": the example input converted with the rules as they are on screen, before or after saving. Saving never does it.
  const download = useDownload();
  const downloadButton = (info: WorkbenchInfo) =>
    input ? (
      <Button variant="secondary" loading={download.status === 'busy'} disabled={info.status.kind === 'blocked'} onClick={() => download.run(input, info.rules)}>
        {t('conv.done.download')}
      </Button>
    ) : null;

  const actions = (info: WorkbenchInfo) => {
    if (save.state.status === 'saved') {
      return (
        <div className="result-head__buttons">
          <Button variant="primary" onClick={() => navigate(`/formats/${format.id}`)}>
            {t('save.viewFormats')}
          </Button>
          {downloadButton(info)}
        </div>
      );
    }
    const label = info.differences && info.differences > 0 ? t(info.differences === 1 ? 'save.differences.one' : 'save.differences.other', { n: info.differences }) : t('add.save');
    return (
      <>
        <div className="result-head__buttons">
          <Button
            variant="primary"
            loading={save.state.status === 'saving' || gate.waiting}
            disabled={info.metaStatus === null}
            onClick={() => gate.save(info, findingsToConfirm(info.rules, copied), doSave)}
          >
            {label}
          </Button>
          {downloadButton(info)}
        </div>
        {gate.view(info)}
      </>
    );
  };

  const banners = () => (
    <>
      {ai?.exhausted || ((ai?.failedAttempts ?? 0) > 0 && result.verification?.verified !== true) ? (
        <InlineMessage tone={ai?.exhausted ? 'warn' : 'info'} {...(ai?.exhausted ? { title: t('aiExhausted.title', { n: limits.learn.maxFailedAiAttempts }) } : {})}>
          {ai?.exhausted ? t('aiExhausted.todo') : t('ai.attempt', { n: ai?.failedAttempts ?? 0, max: limits.learn.maxFailedAiAttempts })}
        </InlineMessage>
      ) : null}
      {save.state.status === 'saved' && (
        <InlineMessage tone="info" actions={<Link to={`/formats/${format.id}`}>{t('save.viewFormats')}</Link>}>
          {/* the name is the server's word: it chose it when nothing was typed */}
          <p>{t('add.saved', { source: save.state.value.source.name, format: format.name })}</p>
        </InlineMessage>
      )}
      {failure && <SaveFailureMessage failure={failure} onSignIn={signInAgain} {...(problemsTitle ? { problemsTitle } : {})} />}
      {download.status === 'failed' && <InlineMessage tone="warn">{t('result.downloadFailed')}</InlineMessage>}
      <SentLink sent={sent} masking={masking} />
    </>
  );

  return (
    <Workbench
      store={store}
      trackUnsaved={save.state.status !== 'saved'}
      exampleId={result.exampleId}
      exampleInput={result.exampleInput}
      inputFile={input}
      tier={me.tier}
      format={target}
      // DECISION: no source lock in the browser: which Source object this becomes is decided by the server when it is saved (SPEC 8.15).
      verification={result.verification}
      name={shownName}
      learnedNote={t('edit.note', { format: format.name })}
      previewLimit={null}
      onSignIn={signInAgain}
      actions={actions}
      banners={banners}
      footer={
        <div>
          <Button variant="ghost" size="sm" onClick={onChangeFiles}>
            {t('add.changeFiles')}
          </Button>
        </div>
      }
    />
  );
}
