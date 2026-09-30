// The Result screen (SPEC 16.1 screen 4, 8.11) for a fresh learn: the working part (`Workbench`) plus what is specific to a learn -
// the local result before the AI step (SPEC 21 v5), the AI quota, "this looks like your format X" (SPEC 5 A2), and saving.
// Once the learn is saved (a format and its first source) the SAME screen becomes the editor of that source: its address is the
// source's own, the example files stay in the worker for the live check, and every further save is a new version of the source.
import { limits, promptVersion, tiers, type CreateFormatRequest, type CreateFormatResponse, type UpdateConversionResponse } from '@formatai/shared';
import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { aiLeftLabel } from '../../app/aiQuota';
import { LeaveDialog } from '../../app/LeaveGuard';
import { useLearnSession } from '../../app/LearnSession';
import { useMe } from '../../app/Me';
import { useSignIn } from '../../app/SignIn';
import { Cell } from '../../components/Cell';
import type { EditableRules } from '../../editor';
import type { AiInfo } from '../../flow/learnFlow';
import type { UseLearnFlow } from '../../flow/useLearnFlow';
import { useI18n } from '../../i18n';
import { useServices } from '../../services';
import { Button, InlineMessage } from '../../ui';
import type { LearnOutput } from '../../worker/engineApi';
import { SaveChangesActions, SourceMessages, useSourceSave } from '../Format/sourceSave';
import { Versions } from '../Format/Versions';
import { PartialBanner, PartialSignInDialog } from './PartialResult';
import { SaveFailureMessage } from './SaveMessages';
import { defaultFormatName, getResultSession, sourcePath, type SavedSource } from './session';
import { useFormatMatch } from './useFormatMatch';
import { convertAndDownload, useSave } from './useSave';
import { Workbench, type WorkbenchInfo } from './Workbench';

/** The props are exactly what `useLearnFlow` returns: `state` (status 'done' here), and the flow's actions. */
export type ResultPageProps = UseLearnFlow;

export function ResultPage({ state }: ResultPageProps) {
  if (state.status !== 'done' || !state.result.rules) return null;
  return <ResultScreen result={state.result} ai={state.ai} />;
}

function ResultScreen({ result, ai }: { result: LearnOutput; ai: AiInfo | undefined }) {
  const { t } = useI18n();
  const { api, engine } = useServices();
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

  // "Download" after saving: the example input, converted with the rules as they are on screen.
  const [download, setDownload] = useState<'idle' | 'busy' | 'failed'>('idle');
  const downloadFile = (file: File, current: EditableRules): void => {
    setDownload('busy');
    convertAndDownload(engine, file, current).then(
      () => setDownload('idle'),
      () => setDownload('failed'),
    );
  };

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

  // SPEC 21 v5 item 1: the local result, shown before the AI step.
  const partial = result.path === 'partial' ? result.partial : undefined;
  const aiPending = partial?.reason === 'aiNotAllowed';
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
  const match = useFormatMatch(me.user !== null && !aiPending && !source, rules);

  const doSave = (info: WorkbenchInfo): void => {
    const file = session.input;
    if (!info.metaStatus || !file) return;
    const learnPath = result.path === 'llm' ? (ai?.cached ? 'cache' : 'llm') : 'local';
    const body: CreateFormatRequest = {
      name,
      rules: info.rules,
      status: info.metaStatus,
      acceptedDifferences: info.differences ?? 0,
      exampleExceptions: info.exceptions,
      learnPath,
      masking: session.masking,
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
        const next: SavedSource = { formatId: res.format.id, conversionId: res.conversion.id, sourceName: res.conversion.sourceName, version: res.conversion.version };
        saver.setVersion(next.version);
        kept.source = next;
        setSource(next);
        if (info.metaStatus === 'differencesAccepted' && ai?.learnId) {
          api.registry
            .learnOutcome(ai.learnId, 'accepted')
            .then((r) => me.setQuota(r.quota))
            .catch(() => undefined);
        }
      },
      download: { file, rules: info.rules },
    });
  };

  // A save after the first one (or an attempt at it) has been made: the first save's message has done its job.
  const laterSave = source !== undefined && (notice !== null || saver.save.state.status !== 'idle');

  // The source as the server has it now (a save that lost to another edit, or an earlier version restored): the editor starts over from it.
  const reload = async (from: SavedSource): Promise<void> => {
    try {
      const [conversion, format] = await Promise.all([api.registry.getConversion(from.conversionId), api.registry.getFormat(from.formatId)]);
      kept.store.reset(conversion.rules, { format: { sourceCount: format.conversions.length }, exceptions: conversion.exampleExceptions });
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

  const actions = (info: WorkbenchInfo) => {
    if (aiPending) {
      return (
        <>
          {me.user ? (
            <Button variant="primary" onClick={session.finishWithAi}>
              {t('partial.finish')}
            </Button>
          ) : (
            <Button variant="primary" onClick={() => setPopupOpen(true)}>
              {t('partial.banner.signIn')}
            </Button>
          )}
          <p className="muted">{t('partial.saveHint')}</p>
        </>
      );
    }
    if (source) {
      const file = session.input;
      return (
        <SaveChangesActions
          info={info}
          saver={saver}
          extra={
            file ? (
              <Button variant="secondary" loading={download === 'busy'} disabled={info.status.kind === 'blocked'} onClick={() => downloadFile(file, info.rules)}>
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
    return (
      <>
        <Button
          variant="primary"
          loading={saving}
          // A visitor is asked to sign in (SPEC 5 E); a signed-in user needs rules that can be saved right now.
          disabled={me.user ? info.metaStatus === null : info.status.kind === 'blocked'}
          onClick={() => (me.user ? doSave(info) : signIn.open('save'))}
        >
          {label}
        </Button>
        {!me.user && tierLimits.previewRows !== null ? <p className="muted">{t('result.freeHint', { n: tierLimits.previewRows })}</p> : null}
      </>
    );
  };

  const banners = (info: WorkbenchInfo) => (
    <>
      {partial && <PartialBanner partial={partial} totalColumns={rules.output.columns.length} readiness={result.readiness} />}
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
      {ai && <AiNote ai={ai} verified={result.verification?.verified === true} />}
      {/* What the first save said, until a later save has something to say. */}
      {!laterSave && save.state.status === 'saved' && (
        <InlineMessage tone="info" actions={<Link to="/formats">{t('save.viewFormats')}</Link>}>
          {t('save.done', { name })}
        </InlineMessage>
      )}
      {!laterSave && save.state.status === 'error' && <SaveFailureMessage failure={save.state.error} onSignIn={() => signIn.open('save')} />}
      {source && (
        <SourceMessages info={info} saver={saver} notice={notice} formatId={source.formatId} onReload={() => void reload(source)} onSignIn={() => signIn.open('save')} />
      )}
      {download === 'failed' && <InlineMessage tone="warn">{t('result.downloadFailed')}</InlineMessage>}
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
        verification={result.verification}
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
            ? t('result.savedNote', { source: source.sourceName })
            : t(partial ? (aiPending ? 'partial.note' : 'flow.path.local') : result.path === 'local' ? 'flow.path.local' : 'flow.path.llm')
        }
        previewLimit={tierLimits.previewRows}
        onSignIn={() => signIn.open('save')}
        actions={actions}
        banners={banners}
        footer={
          <>
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
