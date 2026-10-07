import { useLayoutEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { isAiQuotaHit } from '../app/AiLimit';
import { useLearnSession } from '../app/LearnSession';
import { useMe } from '../app/Me';
import { useSignIn } from '../app/SignIn';
import type { LearnFlowStatus } from '../flow/learnFlow';
import { Stepper, type StepNumber } from '../ui';
import { HomeActions } from './HomeActions';
import { HomeForm } from './HomeForm';
import { HomeHowItWorks } from './HomeHowItWorks';
import { LearningError } from './LearningError';
import { LearningNotReady } from './LearningNotReady';
import { LearningPreflight } from './LearningPreflight';
import { LearningProgress } from './LearningProgress';
import { isRunning, useProgressVisible, useStepHistory } from './learningSteps';

/** Where the learn flow is on the Upload - Learn - Use line. */
function stepFor(status: LearnFlowStatus): StepNumber {
  switch (status) {
    case 'idle':
    case 'blocked':
    case 'notReady':
    case 'done':
      return 1;
    default:
      return 2;
  }
}

/**
 * Home is the tool (SPEC 16.1). The same place carries the whole journey up to the result:
 * the form, the pre-flight screen (warn / block), the learning progress, and the error screens
 * are views of one learn flow. When the flow finishes, the Result screen takes over at /result.
 */
export default function Home() {
  const session = useLearnSession();
  const signIn = useSignIn();
  const me = useMe();
  const navigate = useNavigate();
  const location = useLocation();
  // "Teach a new format" from My formats comes here with the two zones already open.
  const [teaching, setTeaching] = useState((location.state as { teach?: boolean } | null)?.teach === true);
  const { flow } = session;
  const { state } = flow;

  const steps = useStepHistory(state);
  const progressVisible = useProgressVisible(state);

  // After a save the learn page starts empty, before it is painted (owner, 2026-10-07): the saved files did their job. Left without
  // saving, the files stay for another try. (Once, when the page shows.)
  const clearIfSaved = useRef(session.clearIfSaved);
  clearIfSaved.current = session.clearIfSaved;
  useLayoutEffect(() => clearIfSaved.current(), []);

  // Go to the result only when the learn finishes while we are here (not when someone comes
  // back to Home with the browser's Back button and the old result is still in memory).
  const previous = useRef<LearnFlowStatus>(state.status);
  useLayoutEffect(() => {
    if (previous.current !== 'done' && state.status === 'done') navigate('/result');
    previous.current = state.status;
  }, [state.status, navigate]);

  // SPEC 16.1 screen 5: a signed-in user who has formats starts from "Run a format"; teaching a new one is the other button.
  const offerConvert = me.user !== null && (me.formatCount ?? 0) > 0 && state.status === 'idle' && !teaching && session.input === null && session.output === null;

  let view;
  if (state.status === 'warn' || state.status === 'blocked') {
    view = (
      <LearningPreflight
        key={state.status}
        state={state}
        onConfirm={flow.confirm}
        onCancel={flow.cancel}
        onSignIn={() => signIn.open('keepGoing')}
      />
    );
  } else if (state.status === 'notReady') {
    view = <LearningNotReady key="notReady" result={state.result} onChangeFiles={flow.cancel} />;
  } else if (state.status === 'error' && !isAiQuotaHit(state.error)) {
    // (a learn refused for the AI quota is no error screen: the form comes back with the out-of-AI-formats dialog, see AiLimitProvider)
    view = <LearningError key="error" error={state.error} onRetry={session.begin} onChangeFiles={flow.cancel} onSignIn={() => signIn.open('keepGoing')} />;
  } else if (progressVisible && (isRunning(state) || state.status === 'done')) {
    view = (
      <LearningProgress
        key="progress"
        state={state}
        steps={steps}
        inputName={session.input?.name}
        outputName={session.output?.name}
        masking={session.masking}
        onCancel={flow.cancel}
      />
    );
  } else if (offerConvert) {
    view = <HomeActions key="actions" onTeach={() => setTeaching(true)} />;
  } else {
    view = <HomeForm key="form" busy={isRunning(state)} />;
  }

  return (
    <main id="main" className="page home" tabIndex={-1}>
      <section className="tool">
        {offerConvert ? null : <Stepper current={stepFor(state.status)} />}
        {view}
      </section>
      {state.status === 'idle' || state.status === 'done' ? <HomeHowItWorks /> : null}
    </main>
  );
}
