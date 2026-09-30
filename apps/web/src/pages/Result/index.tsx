// The Result screen (SPEC 16.1 screen 4, 8.11) for a fresh learn: the working part (`Workbench`) plus what is specific to a learn -
// the local result before the AI step (SPEC 21 v5), the AI quota, "this looks like your format X" (SPEC 5 A2), and saving.
import { limits, promptVersion, tiers, type CreateFormatRequest, type CreateFormatResponse } from '@formatai/shared';
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { aiLeftLabel } from '../../app/aiQuota';
import { LeaveDialog } from '../../app/LeaveGuard';
import { useLearnSession } from '../../app/LearnSession';
import { useMe } from '../../app/Me';
import { useSignIn } from '../../app/SignIn';
import type { AiInfo } from '../../flow/learnFlow';
import type { UseLearnFlow } from '../../flow/useLearnFlow';
import { useI18n } from '../../i18n';
import { useServices } from '../../services';
import { Button, InlineMessage } from '../../ui';
import type { LearnOutput } from '../../worker/engineApi';
import { PartialBanner, PartialSignInDialog } from './PartialResult';
import { SaveFailureMessage } from './SaveMessages';
import { defaultFormatName, getResultSession } from './session';
import { useFormatMatch } from './useFormatMatch';
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
  const tierLimits = tiers[me.tier];

  // The edits (and the name) live in the session, not in this component: they survive leaving the screen and the sign-in wall.
  const saved = getResultSession(result, defaultFormatName(session.output?.name, t('result.untitled')));
  const [name, setName] = useState(saved.name);
  const rules = result.rules!;

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
  const match = useFormatMatch(me.user !== null && !aiPending, rules);

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
      afterSaved: () => {
        // What is on screen is what was saved: "Unsaved changes" goes, and leaving no longer asks.
        info.editor.markSaved();
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
    if (save.state.status === 'saved') {
      return (
        <Button variant="primary" onClick={() => navigate('/formats')}>
          {t('save.viewFormats')}
        </Button>
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

  const banners = () => (
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
      {save.state.status === 'saved' && (
        <InlineMessage tone="info" actions={<Link to="/formats">{t('save.viewFormats')}</Link>}>
          {t('save.done', { name })}
        </InlineMessage>
      )}
      {save.state.status === 'error' && <SaveFailureMessage failure={save.state.error} onSignIn={() => signIn.open('save')} />}
    </>
  );

  return (
    <>
      <Workbench
        stepper
        store={saved.store}
        trackUnsaved={save.state.status !== 'saved'}
        exampleId={result.exampleId}
        exampleInput={result.exampleInput}
        inputFile={session.input}
        tier={me.tier}
        partial={partial}
        verification={result.verification}
        name={name}
        onRename={(next) => {
          setName(next);
          saved.name = next;
        }}
        learnedNote={t(partial ? (aiPending ? 'partial.note' : 'flow.path.local') : result.path === 'local' ? 'flow.path.local' : 'flow.path.llm')}
        previewLimit={tierLimits.previewRows}
        onSignIn={() => signIn.open('save')}
        actions={actions}
        banners={banners}
        footer={
          <div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                // Starting over throws the edits away: ask first when there are unsaved ones.
                if (saved.store.getState().dirty && save.state.status !== 'saved') setConfirmStartOver(true);
                else {
                  session.startOver();
                  navigate('/');
                }
              }}
            >
              {t('result.startOver')}
            </Button>
          </div>
        }
      />
      <LeaveDialog
        open={confirmStartOver}
        onStay={() => setConfirmStartOver(false)}
        onLeave={() => {
          setConfirmStartOver(false);
          // (The screen goes home by itself once there is no result: see ResultRoute.)
          session.startOver();
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
