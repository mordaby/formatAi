// Add a source to an existing format (SPEC 5 A2, 8.12, 8.15): say which source the file is (detect it, pick one the company already has, or
// name a new one), drop its input file and an output made from it by hand;
// the output must match the format (same headers in order, same file type) or the screen says which columns differ. Then the
// learn runs in attach mode - the format is the `target`, the AI only decides how THIS input produces the format's columns - and
// the result opens in the same map and editor, ready to save as a new conversion of the format (a link from the source to it).
import type { AttachSourceRequest, AttachSourceResponse, Format, FormatDetail, SourceStructure, SourceSummary } from '@formatai/shared';
import { limits, promptVersion } from '@formatai/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { useLearnSession } from '../../app/LearnSession';
import { LinkButton } from '../../app/LinkButton';
import { useMe } from '../../app/Me';
import { RequireSignIn } from '../../app/RequireSignIn';
import { SendPanel } from '../../app/SendPanel';
import { useSignIn } from '../../app/SignIn';
import { useFileInfo } from '../../app/useFileInfo';
import { useLoad } from '../../app/useLoad';
import { webConfig } from '../../config';
import { EditorStore } from '../../editor';
import type { AiInfo } from '../../flow/learnFlow';
import { useLearnFlow } from '../../flow/useLearnFlow';
import { Cell } from '../../components/Cell';
import { useI18n } from '../../i18n';
import { useServices } from '../../services';
import { Button, DropZone, Icon, InlineMessage, Spinner } from '../../ui';
import { isolate } from '../Convert/logic';
import { HomeMasking } from '../HomeMasking';
import { LearningError } from '../LearningError';
import { LearningNotReady } from '../LearningNotReady';
import { LearningPreflight } from '../LearningPreflight';
import { LearningProgress } from '../LearningProgress';
import { isRunning, useProgressVisible, useStepHistory } from '../learningSteps';
import { SelectField, TextField, type Option } from '../Result/fields';
import { compareOutput, fileTypeOfName, type OutputMismatch, type OutputFileType } from '../Result/matchFormat';
import { SaveFailureMessage } from '../Result/SaveMessages';
import { defaultFormatName } from '../Result/session';
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
  // The format, and the company's sources for the chooser. The list is a convenience (SPEC 8.15): when it can't be read the chooser still
  // offers "detect automatically" and "a new source", and the server has the last word on a name in use.
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

/** What the chooser can say (SPEC 5 A2): let the server detect it, use one of the company's sources, or make a new one. */
const AUTO = 'auto';
const NEW = 'new';
const EXISTING = 'source:';

interface AddSourceProps {
  format: FormatDetail;
  sourceCount: number;
  /** The company's sources (SPEC 8.15): what the chooser offers, and the names a new one can't take. */
  sources: SourceSummary[];
  /** The names of this format's sources (also names taken: a fallback for when the list of all sources could not be read). */
  formatSourceNames: string[];
}

function AddSource({ format, sourceCount, sources, formatSourceNames }: AddSourceProps) {
  const { t, code } = useI18n();
  const { api } = useServices();
  const me = useMe();
  const meRef = useRef(me);
  meRef.current = me;
  const signIn = useSignIn();
  const location = useLocation();
  const session = useLearnSession();
  const fromSession = (location.state as { fromSession?: boolean } | null)?.fromSession === true && session.input !== null && session.output !== null;

  // (a stable function: a new one every render would make a new flow every render, and drop the learn in progress)
  const getTier = useCallback(() => meRef.current.tier, []);
  const flow = useLearnFlow({ getTier });
  const target = useMemo(() => formatOf(format), [format]);

  const [choice, setChoice] = useState<string>(AUTO);
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
  const existingId = choice.startsWith(EXISTING) ? choice.slice(EXISTING.length) : undefined;
  const existing = existingId === undefined ? undefined : sources.find((s) => s.id === existingId);
  // The name field is for a source that is about to be created: required for "a new source", optional when the server detects (it is used
  // only if nothing matches), and gone when one of the company's sources is chosen.
  const nameShown = existingId === undefined;
  const nameTrimmed = nameShown ? sourceName.trim() : '';
  // Source names belong to the company, not to the format (SPEC 8.15): a new name is compared with ALL of them, case-insensitively.
  const takenNames = useMemo(() => [...sources.map((s) => s.name), ...formatSourceNames], [sources, formatSourceNames]);
  const nameTaken = nameTrimmed !== '' && takenNames.some((n) => n.trim().toLowerCase() === nameTrimmed.toLowerCase());
  const nameNeeded = choice === NEW;

  // The chooser's options. DECISION: a source that already feeds this format is listed but not selectable - a format takes a source once
  // (a conversion is a link between the two), so picking it could only fail.
  const options: Option[] = useMemo(
    () => [
      { value: AUTO, label: t('add.source.auto') },
      ...sources.map((s) => {
        const feedsThis = s.conversions.some((c) => c.formatId === format.id);
        return { value: `${EXISTING}${s.id}`, label: feedsThis ? t('add.source.feedsThis', { name: isolate(s.name) }) : s.name, disabled: feedsThis };
      }),
      { value: NEW, label: t('add.source.new') },
    ],
    [sources, format.id, t],
  );

  // The structure of the chosen existing source, for the browser's own source-lock check of the result (SPEC 8.15). Fetched as soon as it
  // is chosen (the learn takes longer than this). When it can't be fetched the browser skips that check; the server still enforces it.
  const [structure, setStructure] = useState<{ id: string; structure: SourceStructure } | null>(null);
  useEffect(() => {
    if (existingId === undefined) return;
    let live = true;
    api.registry.getSource(existingId).then(
      (d) => {
        if (live) setStructure({ id: existingId, structure: { inputSignature: d.inputSignature, inputReading: d.inputReading, inputValidations: d.inputValidations } });
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [api, existingId]);

  const ready =
    (!nameNeeded || nameTrimmed !== '') &&
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

  let view;
  if (state.status === 'warn' || state.status === 'blocked') {
    view = <LearningPreflight key={state.status} state={state} onConfirm={flow.confirm} onCancel={flow.cancel} onSignIn={() => signIn.open('keepGoing')} />;
  } else if (state.status === 'notReady') {
    view = <LearningNotReady key="notReady" result={state.result} onChangeFiles={flow.reset} />;
  } else if (state.status === 'error') {
    view = <LearningError key="error" error={state.error} onRetry={begin} onChangeFiles={flow.reset} onSignIn={() => signIn.open('keepGoing')} />;
  } else if (state.status === 'done' && state.result.rules) {
    view = (
      <AttachResult
        key="result"
        result={state.result}
        ai={state.ai}
        format={format}
        target={target}
        sourceCount={sourceCount}
        source={
          existingId !== undefined
            ? { kind: 'existing', id: existingId, name: existing?.name ?? '', ...(structure?.id === existingId ? { structure: structure.structure } : {}) }
            : { kind: choice === NEW ? 'new' : 'auto', name: nameTrimmed }
        }
        input={input}
        masking={masking}
        onChangeFiles={flow.reset}
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

        <SelectField label={t('add.source.label')} value={choice} options={options} onChange={setChoice} className="add-name" />
        {nameShown && (
          <TextField
            label={t('add.sourceName')}
            hint={nameTaken ? undefined : t(nameNeeded ? 'add.sourceNameHint' : 'add.sourceNameOptional')}
            value={sourceName}
            onChange={setSourceName}
            invalid={nameTaken}
            className="add-name"
          />
        )}
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
          {!ready && mismatches.length === 0 && <p className="learn-row__hint">{t(nameNeeded ? 'add.needFiles' : 'add.needFiles.noName')}</p>}
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
  format: FormatDetail;
  target: Format;
  sourceCount: number;
  /** Which source the file is (the chooser): detected by the server, one of the company's, or a new one. */
  source: SourceChoiceProp;
  input: File | null;
  masking: boolean;
  onChangeFiles(): void;
}

type SourceChoiceProp =
  | { kind: 'auto' | 'new'; name: string }
  /** `structure`: the chosen source's structure, when it could be fetched: turns on the browser's source-lock check. */
  | { kind: 'existing'; id: string; name: string; structure?: SourceStructure };

/** The learned source, in the same map and editor as any result; saving adds it to the format (the format lock is checked live and by the server). */
function AttachResult({ result, ai, format, target, source, input, masking, onChangeFiles }: AttachResultProps) {
  const { t } = useI18n();
  const { api } = useServices();
  const me = useMe();
  const navigate = useNavigate();
  const rules = result.rules!;
  const [store] = useState(() => new EditorStore(rules));
  const save = useSave<AttachSourceResponse>();
  // What the header calls the result before it is saved: the source's name, or - when the server will pick it - the file's.
  const shownName = source.name !== '' ? source.name : defaultFormatName(input?.name, t('result.untitled'));

  const doSave = (info: WorkbenchInfo): void => {
    if (!info.metaStatus || !input) return;
    const learnPath = result.path === 'llm' ? (ai?.cached ? 'cache' : 'llm') : 'local';
    // The example input's HEADERS (structure only): what the server matches against the company's sources when none was chosen (SPEC 8.15).
    const inputHeaders = result.exampleInput?.map((c) => c.header);
    const body: AttachSourceRequest = {
      rules: info.rules,
      status: info.metaStatus,
      acceptedDifferences: info.differences ?? 0,
      exampleExceptions: info.exceptions,
      learnPath,
      masking,
      // Chooser -> wire: a chosen source is `sourceId`, "a new source" forces one (`newSource`, 409 if the name is in use), and "detect"
      // sends only the legacy `sourceName` (used if the server has to create one; nothing when the field was left empty).
      ...(source.kind === 'existing' ? { sourceId: source.id } : source.kind === 'new' ? { newSource: { name: source.name } } : source.name !== '' ? { sourceName: source.name } : {}),
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
            .then((r) => me.setQuota(r.quota))
            .catch(() => undefined);
        }
        void me.refreshFormats();
      },
      download: { file: input, rules: info.rules },
    });
  };

  const failure = save.state.status === 'error' ? save.state.error : undefined;
  const problemsTitle =
    failure?.kind !== 'api' ? undefined : failure.code === 'formatMismatch' ? t('add.saveMismatch.title') : failure.code === 'sourceMismatch' ? t('add.saveSourceMismatch.title') : undefined;

  const actions = (info: WorkbenchInfo) => {
    if (save.state.status === 'saved') {
      return (
        <Button variant="primary" onClick={() => navigate(`/formats/${format.id}`)}>
          {t('save.viewFormats')}
        </Button>
      );
    }
    const label = info.differences && info.differences > 0 ? t(info.differences === 1 ? 'save.differences.one' : 'save.differences.other', { n: info.differences }) : t('add.save');
    return (
      <Button variant="primary" loading={save.state.status === 'saving'} disabled={info.metaStatus === null} onClick={() => doSave(info)}>
        {label}
      </Button>
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
          {save.state.value.sourceReused && <p data-testid="source-reused">{t('save.sourceReused', { source: isolate(save.state.value.sourceReused.name) })}</p>}
        </InlineMessage>
      )}
      {failure && <SaveFailureMessage failure={failure} onSignIn={() => undefined} {...(problemsTitle ? { problemsTitle } : {})} />}
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
      // DECISION: the source lock runs in the browser only when the user explicitly chose an existing source. Otherwise there is nothing to
      // compare with yet (a new source is made from these very rules; "detect" is decided by the server). Aliases are ignored by that check
      // (see runStaticChecks). The saved-source editor does not pass it at all: there an input-side edit is a source edit that reaches
      // the source and its other conversions (SPEC 8.15), not a rejection.
      {...(source.kind === 'existing' && source.structure ? { source: source.structure } : {})}
      verification={result.verification}
      name={shownName}
      learnedNote={t('edit.note', { format: format.name })}
      previewLimit={null}
      onSignIn={() => undefined}
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
