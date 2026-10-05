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

  it('says, while the AI step works, which columns code found no trace of in the input (informational: the AI step tries them)', () => {
    show({ status: 'learning', attempt: 'learn', unexplained: ['Assigned Warehouse', 'Label'], sent: [] }, ['reading', 'checking', 'learning']);
    const note = screen.getByTestId('unexplained-note');
    expect(note.textContent).toContain("We couldn't find these columns' values in your input file. The AI step will try them; if they come from another source they'll stay empty.");
    expect(within(note).getByText('Assigned Warehouse')).toBeTruthy();
    expect(within(note).getByText('Label')).toBeTruthy();
    // No buttons to confirm anything: the only action is still Cancel.
    expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull();
    cleanup();
    show({ status: 'learning', attempt: 'learn', sent: [] }, ['reading', 'checking', 'learning']);
    expect(screen.queryByTestId('unexplained-note')).toBeNull();
    cleanup();
    show({ status: 'learning', attempt: 'learn', unexplained: ['Label'], sent: [] }, ['reading', 'checking', 'learning'], 'he');
    expect(screen.getByTestId('unexplained-note').textContent).toContain('לא מצאנו את הערכים של העמודות האלה בקובץ הקלט שלכם. שלב ה-AI ינסה אותן; אם הן מגיעות ממקור אחר, הן יישארו ריקות.');
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

  it('says which round of the learning loop it is and how many rows it sends, in English and Hebrew', () => {
    const steps: StepKey[] = ['reading', 'checking', 'learning', 'verifying', 'learningRepair'];
    show({ status: 'learning', attempt: 'repair', round: { n: 2, of: 3, rows: 5 }, sent: [] }, steps);
    expect(screen.getByText('Fixing what did not match')).toBeTruthy();
    expect(screen.getByTestId('loop-round').textContent).toBe('Checking every row of your example: sending 5 rows the rules got wrong (round 2 of 3).');
    cleanup();
    show({ status: 'learning', attempt: 'repair', round: { n: 1, of: 3, rows: 1 }, sent: [] }, steps);
    expect(screen.getByTestId('loop-round').textContent).toBe('Checking every row of your example: sending 1 row the rules got wrong (round 1 of 3).');
    cleanup();
    show({ status: 'learning', attempt: 'repair', round: { n: 3, of: 3, rows: 0 }, sent: [] }, steps);
    expect(screen.getByTestId('loop-round').textContent).toBe('Checking every row of your example: sending what still did not match (round 3 of 3).');
    cleanup();
    show({ status: 'learning', attempt: 'repair', round: { n: 2, of: 3, rows: 5 }, sent: [] }, steps, 'he');
    expect(screen.getByTestId('loop-round').textContent).toBe('בודקים כל שורה בדוגמה שלכם: שולחים 5 שורות שהכללים טעו בהן (סבב 2 מתוך 3).');
    cleanup();
    show({ status: 'learning', attempt: 'learn', sent: [] }, ['reading', 'checking', 'learning']);
    expect(screen.queryByTestId('loop-round')).toBeNull();
  });

  it('says, while the AI checks an idea on the rows before it answers, which round of checks it is (AI code checks), in English and Hebrew', () => {
    const steps: StepKey[] = ['reading', 'checking', 'learning'];
    show({ status: 'learning', attempt: 'learn', checkRound: { n: 1, of: 3 }, sent: [] }, steps);
    const line = screen.getByTestId('check-round');
    expect(line.textContent).toBe('The AI is checking an idea on your rows (round 1 of 3).');
    // Under the step that learns, inside the live region the progress already uses.
    expect(line.closest('[data-state="active"]')!.textContent).toContain('Learning the format');
    expect(line.closest('[aria-live="polite"]')).toBeTruthy();
    cleanup();
    show({ status: 'learning', attempt: 'learn', checkRound: { n: 2, of: 3 }, unexplained: ['Label'], sent: [] }, steps, 'he');
    expect(screen.getByTestId('check-round').textContent).toBe('ה-AI בודק רעיון מול השורות שלכם (סבב 2 מתוך 3).');
    expect(screen.getByTestId('unexplained-note')).toBeTruthy();
    cleanup();
    // No checks: no line (and never under the loop's step).
    show({ status: 'learning', attempt: 'learn', sent: [] }, steps);
    expect(screen.queryByTestId('check-round')).toBeNull();
    cleanup();
    show({ status: 'learning', attempt: 'repair', round: { n: 1, of: 3, rows: 1 }, sent: [] }, [...steps, 'verifying', 'learningRepair']);
    expect(screen.queryByTestId('check-round')).toBeNull();
  });

  it('"See what we send" lists each step of AI code checks: the round, the rows its answers show, and the checks with their answers', () => {
    const payload = { masking: true, samples: [{ in: ['s'], out: ['t'] }] };
    const shown = { in: ['x'], out: ['y'] };
    const round1 = { checks: [{ check: 'values', column: 'Size' }], answers: [{ rows: 10, distinct: 2, empty: 0, top: [{ value: 'Bxqz', rows: 6 }] }] };
    const round2 = { checks: [{ check: 'rows', where: 'qty > 9', limit: 2 }], answers: [{ matched: 6, rows: [shown, payload.samples[0]] }] };
    const sent = [
      { kind: 'learn', bytes: 2048, payload },
      { kind: 'step', bytes: 2300, payload, rounds: [round1], round: { n: 1, of: 3 } },
      { kind: 'step', bytes: 2500, payload, rounds: [round1, round2], round: { n: 2, of: 3 } },
    ] as never;
    show({ status: 'learning', attempt: 'learn', checkRound: { n: 2, of: 3 }, sent }, ['reading', 'checking', 'learning']);
    fireEvent.click(screen.getByRole('button', { name: 'See what we send' }));
    const records = screen.getAllByTestId('send-record');
    expect(records.map((r) => r.querySelector('.send-record__head')!.textContent)).toEqual([
      'Learn request · 2.0 KB',
      "Answers to the AI's checks, round 1 of 3 · 2.2 KB",
      "Answers to the AI's checks, round 2 of 3 · 2.4 KB",
    ]);
    // Counts only: no rows line. The second round shows one row the payload does not carry already.
    expect(records[1]!.querySelectorAll('p.muted')).toHaveLength(0);
    expect(records[2]!.textContent).toContain('Its answers show 1 row of your example (every row the checks showed so far).');
    // The exact JSON: the payload and every round so far, the checks with their answers (never the learn's token).
    const json = within(records[2]!).getByRole('region', { name: 'Data sent (JSON)' }).textContent!;
    expect(json).toContain('"rounds"');
    expect(json).toContain('"check": "rows"');
    expect(json).toContain('"Bxqz"');
    expect(json).not.toContain('token');
    cleanup();
    show({ status: 'learning', attempt: 'learn', sent }, ['reading', 'checking', 'learning'], 'he');
    fireEvent.click(screen.getByRole('button', { name: 'מה אנחנו שולחים' }));
    expect(screen.getAllByTestId('send-record')[2]!.textContent).toContain('תשובות לבדיקות של ה-AI, סבב 2 מתוך 3');
  });

  it('"See what we send" lists every round, with the rows it carries, and says before anything is sent that rounds may follow', () => {
    const payload = { masking: true, samples: [] };
    const rows = [{ in: ['x'], out: ['y'] }, { in: ['z'], out: ['w'] }];
    const sent = [
      { kind: 'learn', bytes: 2048, payload },
      { kind: 'repair', bytes: 2100, payload, previousRules: {}, problems: [], round: { n: 1, of: 3 }, rows: rows.slice(0, 1) },
      { kind: 'repair', bytes: 2150, payload, previousRules: {}, problems: [], round: { n: 2, of: 3 }, rows },
    ] as never;
    show({ status: 'verifying', sent }, ['reading', 'checking', 'learning', 'verifying']);
    fireEvent.click(screen.getByRole('button', { name: 'See what we send' }));
    const records = screen.getAllByTestId('send-record');
    expect(records.map((r) => r.querySelector('.send-record__head')!.textContent)).toEqual(['Learn request · 2.0 KB', 'Fix request, round 1 of 3 · 2.1 KB', 'Fix request, round 2 of 3 · 2.1 KB']);
    expect(records[1]!.textContent).toContain('It carries 1 row of your example the rules got wrong (every row sent so far).');
    expect(records[2]!.textContent).toContain('It carries 2 rows of your example the rules got wrong (every row sent so far).');
    expect(records[2]!.textContent).toContain('"rows"');
    cleanup();
    show(checking(0.5), ['reading', 'checking']);
    fireEvent.click(screen.getByRole('button', { name: 'See what we send' }));
    expect(screen.getByText('If the rules then get rows of your example wrong: up to 3 more requests, each with some of those rows (at most 40 rows in all), sent like the sample rows.')).toBeTruthy();
    expect(screen.getByText('If the AI asks to check an idea first, your computer answers with counts and ranges from your example, and at most a few more rows, sent like the sample rows (within the same 40 rows).')).toBeTruthy();
  });
});

describe('step tracking', () => {
  it('maps flow states to steps', () => {
    expect(stepKeyOf({ status: 'idle', sent: [] })).toBeUndefined();
    expect(stepKeyOf({ status: 'reading', sent: [] })).toBe('reading');
    expect(stepKeyOf({ status: 'learning', attempt: 'repair', sent: [] })).toBe('learningRepair');
    expect(isRunning({ status: 'warn', reason: 'tryAnyway', issues: [], sent: [] })).toBe(false);
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
    rerender(<Probe state={{ status: 'warn', reason: 'tryAnyway', issues: [], sent: [] }} />);
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
