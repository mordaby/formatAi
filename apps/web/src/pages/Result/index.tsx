// The Result screen (SPEC 16.1 screen 4, 8.11) for a fresh learn: the working part (`Workbench`) plus what is specific to a learn -
// the local result before the AI step (SPEC 21 v5), the AI quota, and saving - where "Save format" first asks, in the Save popup, whether
// the learned output is one of the user's saved formats (owner decision 2026-10-07: update its rules, add the file as a new source of it, or
// save a new format; `useFormatMatch`, `FormatMatchDialog`). Nothing matches: Save goes at once, as before. That question is part of
// "Formats with several sources" (the feature switch, app/Features.tsx): while it is off, Save saves a new format at once, as before #75.
// Once the learn is saved (a format and its first source, a new source of a saved format, or a new version of one of its sources) the SAME
// screen becomes the editor of that source: its address is the source's own, the example files stay in the worker for the live check, and
// every further save is a new version of the source.
import {
  defaultSourceName,
  withUnwrittenOutputOf,
  tiers,
  type AttachSourceRequest,
  type AttachSourceResponse,
  type CreateFormatRequest,
  type CreateFormatResponse,
  type UpdateConversionRequest,
  type UpdateConversionResponse,
} from '@formatai/shared';
import { missingFields } from './missingFields';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useOnAi } from '../../app/aiReport';
import { LeaveDialog } from '../../app/LeaveGuard';
import { useFeatures } from '../../app/Features';
import { useLearnSession } from '../../app/LearnSession';
import { useMe } from '../../app/Me';
import { copiedListsOf, findingsToConfirm, lineIds } from '../../editor';
import { SentLink } from '../../app/SendPanel';
import { useSignIn } from '../../app/SignIn';
import { Cell } from '../../components/Cell';
import type { AiInfo, SentRecord } from '../../flow/learnFlow';
import type { UseLearnFlow } from '../../flow/useLearnFlow';
import { useI18n } from '../../i18n';
import { useServices } from '../../services';
import { Button, Dialog, InlineMessage } from '../../ui';
import type { LearnOutput } from '../../worker/engineApi';
import { SaveChangesActions, SourceMessages, useSourceSave } from '../Format/sourceSave';
import { Versions } from '../Format/Versions';
import { AiNote } from './AiNote';
import { useCopiedListGate, type SaveChoice } from './CopiedListSave';
import { columnKey, DeepAnalysisPanel, partKey } from './DeepAnalysisPanel';
import { filledNote } from './filledNote';
import { oneTimeQuestionsOf, questionsOf } from './helpers';
import { PartialSignInDialog } from './PartialResult';
import { SaveFailureMessage } from './SaveMessages';
import { UnfinishedRows } from './UnfinishedRows';
import { applyCompletionNotes, defaultFormatName, getResultSession, sourcePath, type SavedSource } from './session';
import { TryAnotherFile } from './TryAnotherFile';
import { useCompletion } from './useCompletion';
import { useFormatMatch, type FormatOffer } from './useFormatMatch';
import { useDownload } from './useDownload';
import { useSave } from './useSave';
import { Workbench, type WorkbenchInfo } from './Workbench';

/** The props are exactly what `useLearnFlow` returns: `state` (status 'done' here), and the flow's actions. */
export type ResultPageProps = UseLearnFlow;

/** What the first save of a learn did: a new format, a new source of a saved one, or a new version of one of its sources. */
type FirstSave =
  | { kind: 'new'; res: CreateFormatResponse }
  | { kind: 'attach'; res: AttachSourceResponse; formatName: string }
  | { kind: 'update'; res: UpdateConversionResponse };

export function ResultPage({ state }: ResultPageProps) {
  if (state.status !== 'done' || !state.result.rules) return null;
  return <ResultScreen result={state.result} ai={state.ai} sent={state.sent} />;
}

/** `sent`: what the learn of this result sent (a learn with the AI step: "See what we send" shows it, with every "Finish with AI" after it). */
function ResultScreen({ result, ai, sent }: { result: LearnOutput; ai: AiInfo | undefined; sent: readonly SentRecord[] }) {
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

  // "Finish with AI" (completion mode): the AI step produces only what is missing and the rules on screen stay as they are; an
  // answer that passes the fixed lock and the verification replaces them (see useCompletion). It never runs unless the user chose it: the
  // panel's button, or Home's "Learn with AI" (acted on below, once per result).
  // learn-v7: the notes of an applied answer go into the session (never into the rules): see `ResultSession.aiNotes`.
  const completion = useCompletion(kept, result.exampleId, (asked, notes) => applyCompletionNotes(kept, asked, notes));
  const completed = completion.completed;
  // "See what we send" (SPEC 15) for every request this result took: its learn's (a whole learn with the AI step), then its "Finish with AI".
  const completionSent = kept.completion ? session.completion.state.sent : undefined;
  const allSent = useMemo(() => (completionSent ? [...sent, ...completionSent] : sent), [sent, completionSent]);
  // A list copied from the example (owner decision 2026-10-06), and an identifier-shaped value (docs/proposals/saved-format-contents.md section
  // 6): never asked on screen - the rules are used as they are - but at Save, before the rules are stored, in one popup (`CopiedListSave`):
  // the completion's answer's lists, then the learn's.
  const copied = useMemo(() => copiedListsOf(completed?.oneTimers, result.path === 'llm' ? result.oneTimers?.questions : undefined), [completed?.oneTimers, result]);
  const gate = useCopiedListGate();

  const saver = useSourceSave({
    conversionId: source?.conversionId ?? '',
    version: source?.version ?? 0,
    onSaved: (res) => {
      // (the learn page starts empty the next time it shows: these files are saved)
      session.markSaved();
      const next = { ...kept.source!, version: res.conversion.version };
      kept.source = next;
      setSource(next);
      setNotice(res);
    },
    copiedLists: copied,
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

  // The ambiguity questions (SPEC 21 v12 items 11, 16): the learn's own, and those of a completion's answer once one has been applied.
  const questions = useMemo(() => questionsOf(completed?.ambiguous, result.ambiguous), [completed?.ambiguous, result.ambiguous]);
  // A one-time edit or a rule? (SPEC 21 v12 item 20): the parts of an AI answer that explain one row only - the completion's, then the learn's
  // (a copied list is not among them: it is asked at Save, see `copied`).
  const oneTimers = useMemo(() => oneTimeQuestionsOf(completed?.oneTimers, result.path === 'llm' ? result.oneTimers?.questions : undefined), [completed?.oneTimers, result]);
  const [confirmWhole, setConfirmWhole] = useState(false);
  // What the AI step reported for the answer on screen (the completion's, once one has been applied). (What is left of the AI formats is
  // kept by the flows themselves - `onAi`, app/aiReport.ts - whether or not an answer was used.)
  const aiInfo = completed ? completed.ai : ai;
  const onAi = useOnAi();

  // SPEC 21 v5 item 1: the free engine's own result, shown before the AI step. Once the AI step has completed it, it is an ordinary result.
  const partial = result.path === 'partial' && !completed ? result.partial : undefined;
  const aiPending = partial?.reason === 'aiNotAllowed';

  // What the AI step would be asked for, from the rules as they are on screen right now: EVERY output column with no rule (also one code found
  // no trace of in the input: that is not certainty) and the layout parts the free result could not build and the rules still lack.
  const liveRules = useSyncExternalStore(kept.store.subscribe, () => kept.store.getState().rules);
  // What the AI step noted about the columns it could not build (its guess, a recorded function request), by header. Memory only; read each render.
  const aiNotes = new Map((kept.aiNotes ?? []).map((n) => [n.header, n] as const));
  const missing = useMemo(() => missingFields(liveRules, partial, result.exampleOutputColumns), [liveRules, partial, result.exampleOutputColumns]);
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

  const save = useSave<FirstSave>();
  // "Is this one of your formats?" (owner decision 2026-10-07): asked at the first Save of a learn, for a signed-in user (the list of their
  // formats is read in the background as soon as the result is shown, so a Save that matches nothing waits for nothing) - only while the
  // feature switch "Formats with several sources" is on: off, nothing is read and Save saves a new format, one click.
  const { formatSources } = useFeatures();
  const formatMatch = useFormatMatch(formatSources && me.user !== null && !source);
  const [matching, setMatching] = useState(false);
  const matchingNow = useRef(false);

  /** After the first save, whatever it was: the screen becomes the editor of the source it saved (`next`). */
  const becomeSource = (info: WorkbenchInfo, next: SavedSource, counts: { sourceCount: number; sourceFormats: number }): void => {
    // What is on screen is what was saved: "Unsaved changes" goes, and leaving no longer asks.
    info.editor.markSaved();
    // ... and the learn page starts empty the next time it shows (owner, 2026-10-07): the files did their job.
    session.markSaved();
    // From here on the screen edits that source: an edit of the output side is an edit of the format (for all its sources), and the next
    // save is a new version.
    info.editor.store.setFormat({ sourceCount: counts.sourceCount });
    // ... and of its source: an edit of the input side changes every format that source feeds (said only when that is more than one).
    info.editor.store.setSource({ formats: counts.sourceFormats });
    saver.setVersion(next.version);
    kept.source = next;
    setSource(next);
    // SPEC 21 v5 item 3: saving with accepted differences is what makes an AI learn that did not verify count.
    if (info.metaStatus === 'differencesAccepted' && aiInfo?.learnId) {
      api.registry
        .learnOutcome(aiInfo.learnId, 'accepted')
        .then((r) => onAi({ quota: r.quota }))
        .catch(() => undefined);
    }
  };

  /** The rules as one of the user's saved formats was learned into: a new source of it, or a new version of its source. */
  const saveInto = (info: WorkbenchInfo, choice: { kind: 'update' | 'attach'; offer: FormatOffer }): void => {
    const file = session.input;
    if (!info.metaStatus || !file) return;
    const { offer } = choice;
    // (a csv's or txt's sheet name, widths, header style and direction are not in the file: the format's are taken, so a new file name is
    // not a change of the format - the file written is the same)
    const rules = withUnwrittenOutputOf(info.rules, offer.format);
    const rename = (): void => {
      setName(offer.formatName);
      kept.name = offer.formatName;
      // What is on screen is what was saved (the next save from this editor is compared with it).
      if (rules !== info.rules) {
        const s = info.editor.store.getState();
        info.editor.store.reset(rules, { exceptions: s.exceptions, oneTime: s.oneTime, edited: [...s.edited] });
      }
    };
    if (choice.kind === 'update' && offer.conversion) {
      const conversion = offer.conversion;
      // The editor's own route (SPEC 8.11 "Saving"): a NEW version of that source's rules, based on the version just read - a conversion
      // changed meanwhile is refused, never overwritten. Earlier versions are kept (and can be restored from the history).
      const body: UpdateConversionRequest = {
        rules,
        status: info.metaStatus,
        acceptedDifferences: info.differences ?? 0,
        exampleExceptions: info.exceptions,
        baseVersion: conversion.version,
      };
      void save.run({
        persist: async () => ({ kind: 'update', res: await api.registry.updateConversion(conversion.id, body) }),
        afterSaved: (out) => {
          if (out.kind !== 'update') return;
          rename();
          becomeSource(info, { formatId: offer.formatId, conversionId: conversion.id, version: out.res.conversion.version }, { sourceCount: offer.sources, sourceFormats: conversion.sourceFormats });
          // (said the way the editor says a save: the version, and what it changed in the format for its other sources)
          setNotice(out.res);
        },
      });
      return;
    }
    // A new source of the format (SPEC 5 A2): the rules are already learned and hold the format lock (checked before it was offered; the
    // server checks it again), so they are saved as they are - the server reuses the source the example input matches, or makes one.
    const learnPath = completed ? 'llm' : result.path === 'llm' ? (ai?.cached ? 'cache' : 'llm') : 'local';
    const inputHeaders = result.exampleInput?.map((c) => c.header);
    const suggestedSourceName = defaultSourceName(file.name);
    const body: AttachSourceRequest = {
      rules,
      status: info.metaStatus,
      acceptedDifferences: info.differences ?? 0,
      exampleExceptions: info.exceptions,
      learnPath,
      masking: session.masking,
      ...(suggestedSourceName !== '' ? { suggestedSourceName } : {}),
      ...(inputHeaders && inputHeaders.length > 0 ? { inputHeaders } : {}),
      ...(learnPath !== 'local' && aiInfo?.promptVersion ? { promptVersion: aiInfo.promptVersion } : {}),
    };
    void save.run({
      persist: async () => ({ kind: 'attach', res: await api.registry.attachSource(offer.formatId, body), formatName: offer.formatName }),
      afterSaved: (out) => {
        if (out.kind !== 'attach') return;
        rename();
        becomeSource(info, { formatId: offer.formatId, conversionId: out.res.conversion.id, version: out.res.conversion.version }, { sourceCount: offer.sources + 1, sourceFormats: out.res.source.formats });
        void me.refreshFormats();
      },
    });
  };

  const doSave = (info: WorkbenchInfo, choice: SaveChoice): void => {
    if (choice.kind !== 'new') {
      // A free result with fields still missing is not added as it is: the Add a source screen learns the file against the format, the free
      // engine first, and offers "Finish with AI" for what is left (owner decision 2026-10-07). The files go with it.
      if (choice.kind === 'attach' && incompleteNow()) {
        navigate(`/formats/${choice.offer.formatId}/add-source`, { state: { fromSession: true } });
        return;
      }
      saveInto(info, choice);
      return;
    }
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
      // (API audit 2026-10-07: the prompt version the server says it learned with - learn-v9 for an admin under LEARN_CHECKS - never a constant.)
      ...(learnPath !== 'local' && aiInfo?.promptVersion ? { promptVersion: aiInfo.promptVersion } : {}),
    };
    void save.run({
      persist: async () => ({ kind: 'new', res: await api.registry.createFormat(body) }),
      afterSaved: (out) => {
        if (out.kind !== 'new') return;
        const res = out.res;
        becomeSource(info, { formatId: res.format.id, conversionId: res.conversion.id, version: res.conversion.version }, { sourceCount: 1, sourceFormats: res.source.formats });
      },
    });
  };

  /** The free result still has fields the AI step was not asked for, and nobody filled them: it is not a finished result yet. */
  const incompleteNow = (): boolean => aiPending && missing.any;

  /**
   * "Save format": ask first whether the learned output is one of the user's saved formats (nothing matches: no question, and the save goes on
   * exactly as before); together with the Save popup's question about lists and identifier values, in ONE dialog.
   */
  const startSave = async (info: WorkbenchInfo): Promise<void> => {
    const findings = findingsToConfirm(info.rules, copied);
    // (no saved format has these headers, or the question is switched off: nothing to read or wait for - the save goes at once, as before)
    if (!formatSources || formatMatch.surelyNone(info.rules)) {
      gate.save(info, findings, doSave);
      return;
    }
    if (matchingNow.current) return;
    matchingNow.current = true;
    setMatching(true);
    let offers: FormatOffer[];
    try {
      offers = await formatMatch.find(info.rules, result.exampleInput?.map((c) => c.header));
    } finally {
      matchingNow.current = false;
      setMatching(false);
    }
    // (rules changed while the formats were read: nothing is saved - Save is there to press again)
    if (kept.store.getState().rules !== info.rules) return;
    // A free result with fields missing is not attached as it is (`doSave`): the format lock of THESE rules says nothing about the rules the
    // Add a source screen will learn, so the file is offered as a source whatever it says.
    const offered = incompleteNow() ? offers.map((o) => (o.kind === 'locked' ? { ...o, kind: 'attach' as const, reasons: [] } : o)) : offers;
    gate.save(info, findings, doSave, offered);
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
    const saving = save.state.status === 'saving' || gate.waiting || matching;
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
            // (one of the user's formats, a list or an identifier-shaped value the rules about to be stored hold is asked about first, in ONE
            // dialog: none, and the save goes at once)
            onClick={() => (me.user ? void startSave(info) : signIn.open('save'))}
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
        {gate.view(info)}
      </>
    );
  };

  // The panel: whenever the free result has fields missing, while the deep analysis works, and after it (what it solved, what still needs input).
  const panelVisible = !source && (aiPending || completion.running || completion.outcome !== null || (me.user !== null && missing.columns.length > 0));


  // "Learn with AI" and the free engine solved everything (the fast path): no AI call was made and nothing is counted - said, so that the
  // click is not left looking like it did nothing. (With fields missing the AI step starts by itself, see `autoStart`.)
  const aiNotNeeded = session.deepAnalysis && me.user !== null && !source && !partial && !completed && result.path === 'local';

  // The AI step could not finish (SPEC 21 v12 item 12): its best answer is on screen and not every row matches - the learning loop stopped (no
  // progress, a cap, nothing more to send) or the answer was kept with differences for another reason. The rows that still differ are shown, per
  // column, with the two ways forward (UnfinishedRows). A completion answer is only ever applied when it matches, so this is the whole learn's.
  const unfinished = !source && !completed && result.path === 'llm' && result.verification?.verified === false;

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
      <SentLink sent={allSent} masking={session.masking} />
      {/* ... and the rows the user called a one-time change (SPEC 21 v12 item 20), until the first save. */}
      {(unfinished || (!source && (info.live?.oneTime?.length ?? 0) > 0)) && (
        <UnfinishedRows
          rules={info.rules}
          live={info.live}
          unfinished={unfinished}
          onFix={(header) => info.openLine(lineIds.col(header))}
          onLeave={(index) => void info.editor.apply({ type: 'setColumnMethod', index, method: { kind: 'empty' } })}
        />
      )}
      {aiInfo && <AiNote ai={aiInfo} verified={(completed ? completed.verification : result.verification)?.verified === true} />}
      {/* What the first save said, until a later save has something to say. (A new version of a saved source is said by the editor's notice.) */}
      {!laterSave && save.state.status === 'saved' && save.state.value.kind !== 'update' && (
        <InlineMessage tone="info" actions={<Link to="/formats">{t('save.viewFormats')}</Link>}>
          <p>
            {save.state.value.kind === 'attach'
              ? t('add.saved', { source: save.state.value.res.source.name, format: save.state.value.formatName })
              : t('save.done', { name })}
          </p>
        </InlineMessage>
      )}
      {!laterSave && save.state.status === 'error' && (
        <SaveFailureMessage
          failure={save.state.error}
          onSignIn={() => signIn.open('save')}
          // (a new source of a saved format the server refused for the format or source lock: said like Add a source says it)
          {...(save.state.error.code === 'formatMismatch' ? { problemsTitle: t('add.saveMismatch.title') } : {})}
        />
      )}
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
        ambiguous={questions}
        oneTimers={oneTimers}
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
        // What code filled in the AI's answer from the example (SPEC 21 v12 item 16): said under the learn path, until the first save (then the screen is the saved source's editor).
        filledNote={source ? undefined : (filledNote(completed ? completed.filled : result.path === 'llm' ? result.filled : undefined, t) ?? undefined)}
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

export default ResultPage;
