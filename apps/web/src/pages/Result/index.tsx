// The Result screen (SPEC 16.1 screen 4, 8.11) for a fresh learn: the working part (`Workbench`) plus what is specific to a learn -
// the local result before the AI step (SPEC 21 v5), the AI quota, "this looks like your format X" (SPEC 5 A2), and saving.
// Once the learn is saved (a format and its first source) the SAME screen becomes the editor of that source: its address is the
// source's own, the example files stay in the worker for the live check, and every further save is a new version of the source.
import { defaultSourceName, limits, promptVersion, tiers, type CreateFormatRequest, type CreateFormatResponse, type UpdateConversionResponse } from '@formatai/shared';
import { completionPlan, fixedColumnShare, isCompletable } from '@formatai/shared';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { aiLeftLabel } from '../../app/aiQuota';
import { LeaveDialog } from '../../app/LeaveGuard';
import { useLearnSession } from '../../app/LearnSession';
import { useMe } from '../../app/Me';
import { useSignIn } from '../../app/SignIn';
import { Cell } from '../../components/Cell';
import type { AiInfo } from '../../flow/learnFlow';
import type { UseLearnFlow } from '../../flow/useLearnFlow';
import { useI18n } from '../../i18n';
import { useServices } from '../../services';
import { Button, Dialog, InlineMessage } from '../../ui';
import type { LearnOutput } from '../../worker/engineApi';
import { SaveChangesActions, SourceMessages, useSourceSave } from '../Format/sourceSave';
import { Versions } from '../Format/Versions';
import { columnKey, DeepAnalysisPanel, partKey, type MissingColumn } from './DeepAnalysisPanel';
import { PartialSignInDialog } from './PartialResult';
import { SaveFailureMessage } from './SaveMessages';
import { applyCompletionNotes, defaultFormatName, getResultSession, sourcePath, type SavedSource } from './session';
import { TryAnotherFile } from './TryAnotherFile';
import { useCompletion } from './useCompletion';
import { useFormatMatch } from './useFormatMatch';
import { useDownload } from './useDownload';
import { useSave } from './useSave';
import { Workbench, type WorkbenchInfo } from './Workbench';

/** The props are exactly what `useLearnFlow` returns: `state` (status 'done' here), and the flow's actions. */
export type ResultPageProps = UseLearnFlow;

export function ResultPage({ state }: ResultPageProps) {
  if (state.status !== 'done' || !state.result.rules) return null;
  return <ResultScreen result={state.result} ai={state.ai} />;
}

function ResultScreen({ result, ai }: { result: LearnOutput; ai: AiInfo | undefined }) {
  const { t } = useI18n();
  const { api } = useServices();
  const session = useLearnSession();
  const signIn = useSignIn();
  const me = useMe();
  const navigate = useNavigate();
  const location = useLocation();
  const tierLimits = tiers[me.tier];

  // The edits (and the name, and where the learn was saved) live in the session, not in this component: they survive leaving the screen
  // and the sign-in wall.
  const kept = getResultSession(result, defaultFormatName(session.output?.name, t('result.untitled')));
  const [name, setName] = useState(kept.name);
  const rules = result.rules!;

  // Once saved (SPEC 8.12) this screen is the editor of the new source: the address is the source's own (a reload lands in the normal
  // saved-source editor, which needs no example files), and saving again writes a new version of it.
  const [source, setSource] = useState<SavedSource | undefined>(kept.source);
  const [notice, setNotice] = useState<UpdateConversionResponse | null>(null);
  const saver = useSourceSave({
    conversionId: source?.conversionId ?? '',
    version: source?.version ?? 0,
    onSaved: (res) => {
      const next = { ...kept.source!, version: res.conversion.version };
      kept.source = next;
      setSource(next);
      setNotice(res);
    },
  });
  useEffect(() => {
    if (source && location.pathname !== sourcePath(source)) navigate(sourcePath(source), { replace: true });
  }, [source, location.pathname, navigate]);

  // "Download the file", before and after saving: the example input, converted with the rules as they are on screen. Saving never does it.
  const download = useDownload();

  // "Start over" from a saved result: the way home is taken first, and the session is forgotten once this screen is gone (forgetting it
  // first would show the saved source's plain editor for a moment).
  const startingOver = useRef(false);
  const forget = useRef(session.startOver);
  forget.current = session.startOver;
  useEffect(
    () => () => {
      if (startingOver.current) forget.current();
    },
    [],
  );
  const goHome = (): void => {
    if (source) startingOver.current = true;
    else session.startOver();
    navigate('/');
  };
  // Starting over throws the edits away: ask first when there are unsaved ones.
  const startOver = (): void => (kept.store.getState().dirty ? setConfirmStartOver(true) : goHome());

  // "Finish with AI" (completion mode): the AI step produces only what is missing and the rules on screen stay as they are; an
  // answer that passes the fixed lock and the verification replaces them (see useCompletion). It never runs unless the user chose it: the
  // panel's button, or Home's "Learn with AI" (acted on below, once per result).
  // learn-v7: the notes of an applied answer go into the session (never into the rules): see `ResultSession.aiNotes`.
  const completion = useCompletion(kept.store, result.exampleId, (asked, notes) => applyCompletionNotes(kept, asked, notes));
  const completed = completion.completed;
  const [confirmWhole, setConfirmWhole] = useState(false);
  // What the AI step reported for the answer on screen (the completion's, once one has been applied).
  const aiInfo = completed ? completed.ai : ai;
  const { setQuota } = me;
  const quotaNow = completed?.ai?.quota;
  useEffect(() => {
    if (quotaNow) setQuota(quotaNow);
  }, [quotaNow, setQuota]);

  // SPEC 21 v5 item 1: the free engine's own result, shown before the AI step. Once the AI step has completed it, it is an ordinary result.
  const partial = result.path === 'partial' && !completed ? result.partial : undefined;
  const aiPending = partial?.reason === 'aiNotAllowed';

  // What the AI step would be asked for, from the rules as they are on screen right now: EVERY output column with no rule (also one code found
  // no trace of in the input: that is not certainty) and the layout parts the free result could not build and the rules still lack.
  const liveRules = useSyncExternalStore(kept.store.subscribe, () => kept.store.getState().rules);
  // What the AI step noted about the columns it could not build (its guess, a recorded function request), by header. Memory only; read each render.
  const aiNotes = new Map((kept.aiNotes ?? []).map((n) => [n.header, n] as const));
  const missing = useMemo(() => {
    const plan = completionPlan(liveRules, { parts: partial?.needsAiParts ?? [] });
    const external = new Set(partial?.external ?? []);
    const columns: MissingColumn[] = plan.columns.map((index) => {
      const header = liveRules.output.columns[index]!.header;
      return { index, header, external: external.has(header) };
    });
    // Completion mode needs something to ask for, rules that still line up with the example (no column added or removed), and enough already
    // solved (under limits.learn.completionMinFixedShare of the columns a 'complete the rest' request is just a worse-shaped full learn: first
    // Haiku eval). Otherwise the deep analysis is the whole learn again, which replaces the rules.
    const aligned = result.exampleOutputColumns === undefined || liveRules.output.columns.length === result.exampleOutputColumns;
    const enoughFixed = fixedColumnShare(liveRules) >= limits.learn.completionMinFixedShare;
    const any = columns.length > 0 || plan.parts.length > 0;
    return { columns, parts: plan.parts, any, completable: any && aligned && enoughFixed && isCompletable(liveRules) };
  }, [liveRules, partial, result.exampleOutputColumns]);
  // The free result with fields missing and nothing from the AI step yet. A visitor cannot save it (sign in first); a signed-in user still can deliver
  // it - download it, or save it with those fields as "needs your input" - while the panel offers the deep analysis.
  const incomplete = aiPending && (!me.user || missing.any);
  const guestWaiting = aiPending && !me.user;
  // The ticks of the panel: what the user took out of the request (everything else is asked for).
  const [unticked, setUnticked] = useState<ReadonlySet<string>>(new Set());
  const toggle = (key: string, ticked: boolean): void =>
    setUnticked((prev) => {
      const next = new Set(prev);
      if (ticked) next.delete(key);
      else next.add(key);
      return next;
    });

  const [popupOpen, setPopupOpen] = useState(false);
  const [confirmStartOver, setConfirmStartOver] = useState(false);
  const popupShown = useRef(false);
  useEffect(() => {
    if (aiPending && me.status === 'ready' && !me.user && !popupShown.current) {
      popupShown.current = true;
      setPopupOpen(true);
    }
  }, [aiPending, me.status, me.user]);

  const save = useSave<CreateFormatResponse>();
  const match = useFormatMatch(me.user !== null && !incomplete && !source, rules);

  const doSave = (info: WorkbenchInfo): void => {
    const file = session.input;
    if (!info.metaStatus || !file) return;
    const learnPath = completed ? 'llm' : result.path === 'llm' ? (ai?.cached ? 'cache' : 'llm') : 'local';
    // SPEC 8.15 "Saving": the server looks for one of the caller's sources this example input matches and reuses it, or creates one - silently,
    // there is no source UI in the MVP. What it matches on is the example input's HEADERS (structure only - the file and its values never
    // leave the computer); the rules alone would give a subset.
    const inputHeaders = result.exampleInput?.map((c) => c.header);
    // A new source is named after the example input file, without what changes from file to file ("orders 2026-09.xlsx" is "orders"); nothing
    // is sent when nothing is left of the name (the server then names it "Source N"). Only the file's name is used, never a cell.
    const suggestedSourceName = defaultSourceName(file.name);
    const body: CreateFormatRequest = {
      name,
      rules: info.rules,
      status: info.metaStatus,
      acceptedDifferences: info.differences ?? 0,
      exampleExceptions: info.exceptions,
      learnPath,
      masking: session.masking,
      ...(suggestedSourceName !== '' ? { suggestedSourceName } : {}),
      ...(inputHeaders && inputHeaders.length > 0 ? { inputHeaders } : {}),
      ...(learnPath === 'local' ? {} : { promptVersion }),
    };
    void save.run({
      persist: () => api.registry.createFormat(body),
      // SPEC 21 v5 item 3: saving with accepted differences is what makes an AI learn that did not verify count.
      afterSaved: (res) => {
        // What is on screen is what was saved: "Unsaved changes" goes, and leaving no longer asks.
        info.editor.markSaved();
        // From here on the screen edits that source: an edit of the output side is an edit of the format, and the next save is a new version.
        info.editor.store.setFormat({ sourceCount: 1 });
        // ... and of its source: an edit of the input side changes every format that source feeds (said only when that is more than one).
        info.editor.store.setSource({ formats: res.source.formats });
        const next: SavedSource = { formatId: res.format.id, conversionId: res.conversion.id, version: res.conversion.version };
        saver.setVersion(next.version);
        kept.source = next;
        setSource(next);
        if (info.metaStatus === 'differencesAccepted' && aiInfo?.learnId) {
          api.registry
            .learnOutcome(aiInfo.learnId, 'accepted')
            .then((r) => me.setQuota(r.quota))
            .catch(() => undefined);
        }
      },
    });
  };

  // A save after the first one (or an attempt at it) has been made: the first save's message has done its job.
  const laterSave = source !== undefined && (notice !== null || saver.save.state.status !== 'idle');

  // The source as the server has it now (a save that lost to another edit, or an earlier version restored): the editor starts over from it.
  const reload = async (from: SavedSource): Promise<void> => {
    try {
      const [conversion, format] = await Promise.all([api.registry.getConversion(from.conversionId), api.registry.getFormat(from.formatId)]);
      kept.store.reset(conversion.rules, { format: { sourceCount: format.conversions.length }, source: { formats: conversion.sourceFormats }, exceptions: conversion.exampleExceptions });
      saver.setVersion(conversion.version);
      saver.save.reset();
      setNotice(null);
      const next = { ...from, version: conversion.version };
      kept.source = next;
      setSource(next);
    } catch {
      // Nothing changed on screen; the message with "Reload" is still there to try again.
    }
  };

  const learnWhole = (): void => {
    // The user has said the rules may go: leaving this screen for the new learn is not "leaving with unsaved changes".
    kept.store.markSaved();
    kept.deepRun = true;
    session.finishWithAi();
  };
  const hasEdits = (): boolean => kept.store.getState().dirty || kept.store.getState().edited.size > 0;
  /**
   * "Finish with AI", the one AI button: completion mode for the ticked fields when it can be, the whole learn when not (after asking, when there are
   * edits). DECISION: nothing missing (the free rules cover every column and part, yet the strict fast path would not accept them - rows that
   * change shape go to the AI step) or rules that no longer line up with the example's output columns (columns added or removed) leave nothing
   * to complete, so the button runs the whole learn instead.
   */
  const runDeep = (): void => {
    if (missing.completable) {
      const columns = missing.columns.filter((c) => !unticked.has(columnKey(c))).map((c) => c.index);
      const parts = missing.parts.filter((code) => !unticked.has(partKey(code)));
      if (columns.length + parts.length === 0) return;
      kept.deepRun = true;
      completion.start({ fixedRules: kept.store.getState().rules, columns, parts });
    } else if (hasEdits()) setConfirmWhole(true);
    else learnWhole();
  };
  // Home's "Learn with AI" (signed in, or signed in since): the AI step starts by itself right after the free result, once per result, when
  // fields are missing - the same completion / whole-learn logic as the button. A whole learn that would replace edits waits for the user.
  const runRef = useRef(runDeep);
  runRef.current = runDeep;
  const autoStart =
    session.deepAnalysis && me.user !== null && aiPending && !source && missing.any && me.quota?.remaining !== 0 && (missing.completable || !hasEdits());
  useEffect(() => {
    if (!autoStart || kept.deepRun) return;
    runRef.current();
  }, [autoStart, kept]);
  // What the deep analysis is working on right now (read-only on the map and in the editor until it is done).
  const analysing = useMemo(
    () => (completion.running && completion.asked ? { columns: new Set(completion.asked.columns), parts: completion.asked.parts } : undefined),
    [completion.running, completion.asked],
  );

  const actions = (info: WorkbenchInfo) => {
    if (guestWaiting) {
      // Nothing to save yet: the one action is in the panel below (sign in).
      return <p className="muted">{t('partial.saveHint')}</p>;
    }
    if (source) {
      const file = session.input;
      return (
        <SaveChangesActions
          info={info}
          saver={saver}
          extra={
            file ? (
              <Button variant="secondary" loading={download.status === 'busy'} disabled={info.status.kind === 'blocked'} onClick={() => download.run(file, info.rules)}>
                {t('result.download')}
              </Button>
            ) : null
          }
        />
      );
    }
    const label =
      info.differences && info.differences > 0 ? t(info.differences === 1 ? 'save.differences.one' : 'save.differences.other', { n: info.differences }) : t('result.save');
    const saving = save.state.status === 'saving';
    const file = session.input;
    return (
      <>
        <div className="result-head__buttons">
          <Button
            // (while the panel asks for the deep analysis, that is the one primary action)
            variant={incomplete ? 'secondary' : 'primary'}
            loading={saving}
            // A visitor is asked to sign in (SPEC 5 E); a signed-in user needs rules that can be saved right now - and the AI step not at work on them.
            disabled={completion.running || (me.user ? info.metaStatus === null : info.status.kind === 'blocked')}
            onClick={() => (me.user ? doSave(info) : signIn.open('save'))}
          >
            {label}
          </Button>
          {/* For someone who already has the output and wants only the format: saving does not download. A visitor is asked to sign in (SPEC 11). */}
          {file ? (
            <Button
              variant="secondary"
              loading={download.status === 'busy'}
              disabled={completion.running || info.status.kind === 'blocked'}
              onClick={() => (me.user ? download.run(file, info.rules) : signIn.open('download'))}
            >
              {t('conv.done.download')}
            </Button>
          ) : null}
        </div>
        {!me.user && tierLimits.previewRows !== null ? <p className="muted">{t('result.freeHint', { n: tierLimits.previewRows })}</p> : null}
      </>
    );
  };

  // The panel: whenever the free result has fields missing, while the deep analysis works, and after it (what it solved, what still needs input).
  const panelVisible = !source && (aiPending || completion.running || completion.outcome !== null || (me.user !== null && missing.columns.length > 0));


  // "Learn with AI" and the free engine solved everything (the fast path): no AI call was made and nothing is counted - said, so that the
  // click is not left looking like it did nothing. (With fields missing the AI step starts by itself, see `autoStart`.)
  const aiNotNeeded = session.deepAnalysis && me.user !== null && !source && !partial && !completed && result.path === 'local';

  const banners = (info: WorkbenchInfo) => (
    <>
      {aiNotNeeded && (
        <InlineMessage tone="info">
          <p data-testid="ai-not-needed">{t('deep.notNeeded')}</p>
        </InlineMessage>
      )}
      {panelVisible && (
        <DeepAnalysisPanel
          free={aiPending}
          total={liveRules.output.columns.length}
          columns={missing.columns}
          parts={missing.parts}
          who={me.status === 'loading' ? 'checking' : me.user ? 'user' : 'guest'}
          quota={me.quota}
          completion={completion}
          aiNotes={aiNotes}
          unticked={unticked}
          onToggle={toggle}
          whole={!missing.completable}
          primary={incomplete}
          onRun={runDeep}
          onSignIn={() => setPopupOpen(true)}
          onDownload={() => {
            const file = session.input;
            if (!me.user) signIn.open('download'); // (a visitor keeps the preview; the file itself is for signed-in users)
            else if (file) download.run(file, kept.store.getState().rules);
          }}
          downloading={download.status === 'busy'}
        />
      )}
      {match.format && !match.dismissed && (
        <InlineMessage
          tone="info"
          title={t('match.title', { name: match.format.name })}
          actions={
            <>
              <Button variant="primary" size="sm" onClick={() => navigate(`/formats/${match.format!.id}/add-source`, { state: { fromSession: true } })}>
                {t('match.add')}
              </Button>
              <Button variant="ghost" size="sm" onClick={match.dismiss}>
                {t('match.dismiss')}
              </Button>
            </>
          }
        >
          {t('match.text')}
        </InlineMessage>
      )}
      {aiInfo && <AiNote ai={aiInfo} verified={(completed ? completed.verification : result.verification)?.verified === true} />}
      {/* What the first save said, until a later save has something to say. */}
      {!laterSave && save.state.status === 'saved' && (
        <InlineMessage tone="info" actions={<Link to="/formats">{t('save.viewFormats')}</Link>}>
          <p>{t('save.done', { name })}</p>
        </InlineMessage>
      )}
      {!laterSave && save.state.status === 'error' && <SaveFailureMessage failure={save.state.error} onSignIn={() => signIn.open('save')} />}
      {source && (
        <SourceMessages info={info} saver={saver} notice={notice} formatId={source.formatId} onReload={() => void reload(source)} onSignIn={() => signIn.open('save')} />
      )}
      {download.status === 'failed' && <InlineMessage tone="warn">{t('result.downloadFailed')}</InlineMessage>}
    </>
  );

  return (
    <>
      <Workbench
        stepper
        store={kept.store}
        // (an edit of the output side of a saved source is an edit of the format: said by the banners, once)
        formatChangeNote={source ? 'banner' : 'panel'}
        exampleId={result.exampleId}
        exampleInput={result.exampleInput}
        inputFile={session.input}
        tier={me.tier}
        partial={partial}
        aiNotes={aiNotes}
        ambiguous={result.ambiguous}
        analysing={analysing}
        verification={completed ? completed.verification : result.verification}
        name={name}
        // A saved format is renamed from its own page (the name was saved with it).
        onRename={
          source
            ? undefined
            : (next) => {
                setName(next);
                kept.name = next;
              }
        }
        learnedNote={
          source
            ? t('edit.note', { format: name })
            : t(partial ? (incomplete ? 'partial.note' : 'flow.path.local') : completed || result.path !== 'local' ? 'flow.path.llm' : 'flow.path.local')
        }
        previewLimit={tierLimits.previewRows}
        onSignIn={() => signIn.open('download')}
        actions={actions}
        banners={banners}
        footer={
          <>
            <TryAnotherFile getRules={() => kept.store.getState().rules} tier={me.tier} onSignIn={() => signIn.open('download')} />
            {source && (
              <>
                <Versions conversionId={source.conversionId} refreshKey={saver.savedVersion} onRestored={() => void reload(source)} />
                <p>
                  <Link to={`/formats/${source.formatId}`}>
                    <Cell value={name} />
                  </Link>
                </p>
              </>
            )}
            <div>
              <Button variant="ghost" size="sm" onClick={startOver}>
                {t('result.startOver')}
              </Button>
            </div>
          </>
        }
      />
      <LeaveDialog
        open={confirmStartOver}
        onStay={() => setConfirmStartOver(false)}
        onLeave={() => {
          setConfirmStartOver(false);
          if (source) {
            // The edits are being thrown away: they no longer hold the screen back.
            kept.store.markSaved();
            goHome();
          } else {
            // (The screen goes home by itself once there is no result: see ResultRoute.)
            session.startOver();
          }
        }}
      />
      <Dialog open={confirmWhole} onClose={() => setConfirmWhole(false)} title={t('partial.whole.title')}>
        <p>{t('partial.whole.body')}</p>
        <div className="dialog__actions">
          <Button variant="primary" onClick={() => setConfirmWhole(false)}>
            {t('partial.whole.keep')}
          </Button>
          <Button
            variant="secondary"
            onClick={() => {
              setConfirmWhole(false);
              learnWhole();
            }}
          >
            {t('partial.whole.confirm')}
          </Button>
        </div>
      </Dialog>
      {partial && aiPending && !me.user && (
        <PartialSignInDialog open={popupOpen} partial={partial} totalColumns={rules.output.columns.length} onClose={() => setPopupOpen(false)} />
      )}
    </>
  );
}

/** What the AI step reported: how many AI formats are left, and - when the result did not match every row - which try this was. */
function AiNote({ ai, verified }: { ai: AiInfo; verified: boolean }) {
  const { t, code } = useI18n();
  const max = limits.learn.maxFailedAiAttempts;
  const tried = ai.failedAttempts ?? 0;
  if (!ai.quota && (verified || tried === 0)) return null;
  return (
    <div className="ai-note" data-testid="ai-note">
      {ai.exhausted ? (
        <InlineMessage tone="warn" title={t('aiExhausted.title', { n: max })} todo={t('aiExhausted.todo')}>
          {code({ kind: 'apiError', code: 'aiAttemptsExhausted', counted: ai.counted === true })}
        </InlineMessage>
      ) : !verified && tried > 0 ? (
        <InlineMessage tone="info">{t('ai.attempt', { n: tried, max })}</InlineMessage>
      ) : null}
      {ai.quota ? <p className="muted tabular">{aiLeftLabel(t, ai.quota)}</p> : null}
    </div>
  );
}

export default ResultPage;
