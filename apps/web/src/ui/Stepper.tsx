import { Fragment } from 'react';
import { useI18n, type MessageKey } from '../i18n';
import { Icon } from './Icon';

export type StepNumber = 1 | 2 | 3;

const STEPS: readonly { n: StepNumber; label: MessageKey }[] = [
  { n: 1, label: 'steps.upload' },
  { n: 2, label: 'steps.learn' },
  { n: 3, label: 'steps.use' },
];

export interface StepperProps {
  /** The step the user is on; earlier steps show as done. */
  current: StepNumber;
}

/** The journey, always visible: 1 Upload, 2 Learn, 3 Use. Not navigation: it only says where you are. */
export function Stepper({ current }: StepperProps) {
  const { t } = useI18n();
  return (
    <ol className="stepper" aria-label={t('steps.label')}>
      {STEPS.map((step, i) => {
        const state = step.n < current ? 'done' : step.n === current ? 'current' : 'todo';
        return (
          <Fragment key={step.n}>
            {i > 0 && <li className="stepper__line" data-done={step.n <= current ? 'true' : undefined} aria-hidden="true" role="presentation" />}
            <li className="stepper__item" data-state={state} aria-current={state === 'current' ? 'step' : undefined}>
              <span className="stepper__dot">{state === 'done' ? <Icon name="check" size={14} /> : step.n}</span>
              <span>{t(step.label)}</span>
            </li>
          </Fragment>
        );
      })}
    </ol>
  );
}
