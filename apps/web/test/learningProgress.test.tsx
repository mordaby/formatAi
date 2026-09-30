import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LearnFlowState } from '../src/flow/learnFlow';
import { I18nProvider, type Lang } from '../src/i18n';
import { LearningProgress } from '../src/pages/LearningProgress';
import { isRunning, stepKeyOf, useProgressVisible, useStepHistory, type StepKey } from '../src/pages/learningSteps';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const checking = (fraction: number): LearnFlowState => ({ status: 'checking', stage: 'align', fraction, sent: [] });

function show(state: LearnFlowState, steps: StepKey[], lang: Lang = 'en', onCancel = () => {}) {
  return render(
    <I18nProvider initial={lang}>
      <LearningProgress state={state} steps={steps} inputName="orders.xlsx" outputName="load.csv" masking onCancel={onCancel} />
    </I18nProvider>,
  );
}

describe('LearningProgress', () => {
  it('shows only the steps that have happened, and real progress on the check', () => {
    show(checking(0.42), ['reading', 'checking']);
    const items = screen.getAllByRole('listitem');
    expect(items.map((li) => li.getAttribute('data-state'))).toEqual(['done', 'active']);
    expect(within(items[0]!).getByText('Reading files')).toBeTruthy();
    expect(within(items[1]!).getByText('Checking the files')).toBeTruthy();
    expect(screen.getByRole('progressbar', { name: 'Checking the files' }).getAttribute('aria-valuenow')).toBe('42');
    // Steps that have not happened (and may never, on the fast path) are not on screen.
    expect(screen.queryByText('Learning the format')).toBeNull();
    expect(screen.queryByText('Checking against your example')).toBeNull();
    expect(screen.getByText('orders.xlsx')).toBeTruthy();
    expect(screen.getByText('load.csv')).toBeTruthy();
  });

  it('adds Learning and Checking against your example when the server path is taken', () => {
    show({ status: 'learning', attempt: 'learn', sent: [] }, ['reading', 'checking', 'learning']);
    expect(screen.getAllByRole('listitem').map((li) => li.getAttribute('data-state'))).toEqual(['done', 'done', 'active']);
    expect(screen.getByText('This can take a little while.')).toBeTruthy();
    cleanup();
    show({ status: 'verifying', sent: [] }, ['reading', 'checking', 'learning', 'verifying']);
    expect(screen.getByText('Checking against your example')).toBeTruthy();
  });

  it('marks everything done once finished', () => {
    show({ status: 'done', result: {} as never, sent: [] }, ['reading', 'checking']);
    expect(screen.getAllByRole('listitem').every((li) => li.getAttribute('data-state') === 'done')).toBe(true);
  });

  it('can be cancelled, and reads in Hebrew', () => {
    const onCancel = vi.fn();
    show(checking(0.1), ['reading', 'checking'], 'he', onCancel);
    expect(screen.getByText('בודקים את הקבצים')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'ביטול' }));
    expect(onCancel).toHaveBeenCalled();
  });

  it('opens "See what we send": what will go before a payload exists, the JSON after', () => {
    const { rerender } = show(checking(0.5), ['reading', 'checking']);
    fireEvent.click(screen.getByRole('button', { name: 'See what we send' }));
    expect(screen.getByText('If your computer can solve it alone, nothing is sent at all. When something is sent, the exact data appears here.')).toBeTruthy();
    const sent = [{ kind: 'learn', bytes: 2048, payload: { masking: true, samples: [] } }] as never;
    rerender(
      <I18nProvider initial="en">
        <LearningProgress state={{ status: 'learning', attempt: 'learn', sent }} steps={['reading', 'checking', 'learning']} masking onCancel={() => {}} />
      </I18nProvider>,
    );
    expect(screen.getByText('This is exactly what was sent.')).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Data sent (JSON)' }).textContent).toContain('"masking": true');
  });
});

describe('step tracking', () => {
  it('maps flow states to steps', () => {
    expect(stepKeyOf({ status: 'idle', sent: [] })).toBeUndefined();
    expect(stepKeyOf({ status: 'reading', sent: [] })).toBe('reading');
    expect(stepKeyOf({ status: 'learning', attempt: 'repair', sent: [] })).toBe('learningRepair');
    expect(isRunning({ status: 'warn', reason: 'tryAnyway', issues: [], columns: [], sent: [] })).toBe(false);
    expect(isRunning({ status: 'verifying', sent: [] })).toBe(true);
  });

  function Probe({ state }: { state: LearnFlowState }) {
    return <p data-testid="steps">{useStepHistory(state).join(',')}</p>;
  }

  it('remembers the steps visited (also across a pause for a warning) and starts over with the next run', () => {
    const { rerender } = render(<Probe state={{ status: 'idle', sent: [] }} />);
    const steps = () => screen.getByTestId('steps').textContent;
    expect(steps()).toBe('');
    rerender(<Probe state={{ status: 'reading', sent: [] }} />);
    rerender(<Probe state={checking(0.3)} />);
    rerender(<Probe state={checking(0.6)} />);
    expect(steps()).toBe('reading,checking');
    rerender(<Probe state={{ status: 'warn', reason: 'confirmSkipColumns', issues: [], columns: [], sent: [] }} />);
    rerender(<Probe state={{ status: 'learning', attempt: 'learn', sent: [] }} />);
    expect(steps()).toBe('reading,checking,learning');
    rerender(<Probe state={{ status: 'verifying', sent: [] }} />);
    rerender(<Probe state={{ status: 'learning', attempt: 'repair', sent: [] }} />);
    rerender(<Probe state={{ status: 'verifying', sent: [] }} />);
    expect(steps()).toBe('reading,checking,learning,verifying,learningRepair,verifying');
    rerender(<Probe state={{ status: 'idle', sent: [] }} />);
    expect(steps()).toBe('');
    rerender(<Probe state={{ status: 'reading', sent: [] }} />);
    expect(steps()).toBe('reading');
  });

  it('a fast path never visits Learning', () => {
    const { rerender } = render(<Probe state={{ status: 'reading', sent: [] }} />);
    rerender(<Probe state={checking(1)} />);
    rerender(<Probe state={{ status: 'done', result: {} as never, sent: [] }} />);
    expect(screen.getByTestId('steps').textContent).toBe('reading,checking');
  });

  it('holds the progress screen back for a run that ends in a blink', () => {
    vi.useFakeTimers();
    function Visible({ state }: { state: LearnFlowState }) {
      return <p data-testid="visible">{String(useProgressVisible(state, 250))}</p>;
    }
    const visible = () => screen.getByTestId('visible').textContent;
    const { rerender } = render(<Visible state={{ status: 'idle', sent: [] }} />);
    rerender(<Visible state={{ status: 'reading', sent: [] }} />);
    expect(visible()).toBe('false');
    act(() => void vi.advanceTimersByTime(100));
    expect(visible()).toBe('false');
    act(() => void vi.advanceTimersByTime(200));
    expect(visible()).toBe('true');
    rerender(<Visible state={{ status: 'idle', sent: [] }} />);
    expect(visible()).toBe('false');
  });
});
