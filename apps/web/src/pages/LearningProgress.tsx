import { useState } from 'react';
import { SendPanel } from '../app/SendPanel';
import { Cell } from '../components/Cell';
import type { LearnFlowState } from '../flow/learnFlow';
import { useI18n } from '../i18n';
import { Button, Icon, Progress, Spinner } from '../ui';
import { checkRoundText, roundText, STEP_LABELS, type StepKey } from './learningSteps';

export interface LearningProgressProps {
  state: LearnFlowState;
  /** The steps visited so far (see `useStepHistory`), the last one being current. */
  steps: readonly StepKey[];
  inputName?: string | undefined;
  outputName?: string | undefined;
  masking: boolean;
  onCancel(): void;
}

/**
 * SPEC 16.1 screen 3. Real progress from the worker: each step that actually happens appears as it
 * starts and gets a check when it ends. Steps that do not happen (the fast path never "learns")
 * never appear.
 */
export function LearningProgress({ state, steps, inputName, outputName, masking, onCancel }: LearningProgressProps) {
  const { t, code } = useI18n();
  const [sendOpen, setSendOpen] = useState(false);
  const finished = state.status === 'done';

  return (
    <div className="view learning">
      <header className="tool__head">
        <h1>{t('learning.title')}</h1>
        {inputName && outputName && (
          <p className="learning__files">
            <Cell value={inputName} />
            <Icon name="arrow" size={16} />
            <Cell value={outputName} />
          </p>
        )}
      </header>

      <ol className="steps" aria-live="polite">
        {steps.map((key, i) => {
          const active = !finished && i === steps.length - 1;
          return (
            <li className="steps__item" key={`${i}-${key}`} data-state={active ? 'active' : 'done'}>
              <span className="steps__mark">{active ? <Spinner size={18} /> : <Icon name="check" size={16} />}</span>
              <div className="steps__body">
                <span className="steps__label">
                  {t(STEP_LABELS[key])}
                  {!active && <span className="visually-hidden"> · {t('learning.done')}</span>}
                </span>
                {active && key === 'checking' && state.status === 'checking' && <Progress value={state.fraction} label={t('flow.checking')} />}
                {active && key === 'learningRepair' && state.status === 'learning' && state.round ? (
                  <span className="steps__note" data-testid="loop-round">{roundText(t, state.round)}</span>
                ) : null}
                {/* AI code checks (SPEC 21 v14): before it answers, the AI step asked code to check an idea on every row. */}
                {active && key === 'learning' && state.status === 'learning' && state.checkRound ? (
                  <span className="steps__note" data-testid="check-round">{checkRoundText(t, state.checkRound)}</span>
                ) : null}
                {active && (key === 'learning' || key === 'learningRepair') && <span className="steps__note">{t('learning.wait')}</span>}
                {/* SPEC 6.4 (informational, never a stop): columns code found no trace of in the input go to the AI step like the rest. */}
                {active && key === 'learning' && state.status === 'learning' && state.unexplained && state.unexplained.length > 0 && (
                  <div className="chips-block" data-testid="unexplained-note">
                    <p className="steps__note">{code({ kind: 'preflight', code: 'unknownOutputColumns' })}</p>
                    <p className="chips-block__lead">{t('learning.unexplained.lead')}</p>
                    <ul className="chips">
                      {state.unexplained.map((column, i) => (
                        <li key={`${i}-${column}`}>
                          <Cell value={column} />
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ol>

      <div className="learning__actions">
        <Button variant="secondary" onClick={onCancel}>
          {t('flow.cancel')}
        </Button>
        <Button variant="link" aria-expanded={sendOpen} onClick={() => setSendOpen((o) => !o)}>
          {t('sendPanel.title')}
        </Button>
      </div>
      {sendOpen && <SendPanel sent={state.sent} masking={masking} onClose={() => setSendOpen(false)} />}
    </div>
  );
}
