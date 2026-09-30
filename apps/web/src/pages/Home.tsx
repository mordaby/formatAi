import { useLayoutEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useLearnSession } from '../app/LearnSession';
import { useSignIn } from '../app/SignIn';
import { TurnstileSlot } from '../app/Turnstile';
import type { LearnFlowStatus } from '../flow/learnFlow';
import { Stepper, type StepNumber } from '../ui';
import { HomeForm } from './HomeForm';
import { HomeHowItWorks } from './HomeHowItWorks';
import { LearningError } from './LearningError';
import { LearningPreflight } from './LearningPreflight';
import { LearningProgress } from './LearningProgress';
import { isRunning, useProgressVisible, useStepHistory } from './learningSteps';

/** Where the learn flow is on the Upload - Learn - Use line. */
function stepFor(status: LearnFlowStatus): StepNumber {
  switch (status) {
    case 'idle':
    case 'blocked':
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
  const navigate = useNavigate();
  const { flow } = session;
  const { state } = flow;

  const steps = useStepHistory(state);
  const progressVisible = useProgressVisible(state);

  // Go to the result only when the learn finishes while we are here (not when someone comes
  // back to Home with the browser's Back button and the old result is still in memory).
  const previous = useRef<LearnFlowStatus>(state.status);
  useLayoutEffect(() => {
    if (previous.current !== 'done' && state.status === 'done') navigate('/result');
    previous.current = state.status;
  }, [state.status, navigate]);

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
  } else if (state.status === 'error') {
    view = <LearningError key="error" error={state.error} onRetry={session.begin} onChangeFiles={flow.reset} onSignIn={() => signIn.open('keepGoing')} />;
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
  } else {
    view = <HomeForm key="form" busy={isRunning(state)} />;
  }

  return (
    <main id="main" className="page home" tabIndex={-1}>
      <section className="tool">
        <Stepper current={stepFor(state.status)} />
        {view}
        <TurnstileSlot key="turnstile" />
      </section>
      {state.status === 'idle' || state.status === 'done' ? <HomeHowItWorks /> : null}
    </main>
  );
}
