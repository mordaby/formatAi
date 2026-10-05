// What an input column reads as another value (`readAs`, SPEC 8.4a) in the rules map (SPEC 8.11, 21 v12 item 16): one line per text in the Rows section,
// "In Amount, 'N/A' is read as empty", whose editor shows the sentence and removes it - one undoable edit of the input side, like the other input rules.
import type { LearnResult } from '@formatai/shared';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryPendingStore, setPendingStore } from '../src/app/pendingLearn';
import { INPUT_COLUMNS, rules as fixtureRules } from '../src/rulesText/fixtures';
import { csv, fakeApi, fakeEngine, learnResult, liveResult, renderApp, USER } from './helpers/renderApp';

vi.mock('../src/app/redirect', () => ({ redirectTo: vi.fn() }));

beforeEach(() => {
  document.cookie = 'lang=; Path=/; Max-Age=0';
  setPendingStore(createMemoryPendingStore());
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  setPendingStore(undefined);
});

const withReadAs = (): LearnResult =>
  fixtureRules({ input: { columns: INPUT_COLUMNS.map((c) => (c.id === 'c_amount' ? { ...c, readAs: { 'N/A': '', '-': '0' } } : c)) } });

async function open(lang: 'en' | 'he' = 'en') {
  const en = lang === 'en';
  const liveCheck = vi.fn(async (_id: string, _rules: LearnResult) => liveResult());
  const fake = fakeEngine(undefined, undefined, { liveCheck, fullCheck: liveCheck });
  fake.learn.mockImplementation(async () => learnResult({ path: 'llm', rules: withReadAs() }));
  renderApp({ engine: fake.engine, api: fakeApi({ user: USER }), lang });
  fireEvent.change(screen.getByLabelText(en ? 'Example input' : 'דוגמת קלט'), { target: { files: [csv('in.csv')] } });
  fireEvent.change(screen.getByLabelText(en ? 'Example output' : 'דוגמת פלט'), { target: { files: [csv('out.csv')] } });
  await waitFor(() => expect(screen.getAllByText(/1,204/)).toHaveLength(2));
  await waitFor(() => expect((screen.getByRole('button', { name: en ? /Learn the format/ : /ללמוד את הפורמט/ }) as HTMLButtonElement).disabled).toBe(false));
  await act(async () => void fireEvent.click(screen.getByRole('button', { name: en ? /Learn the format/ : /ללמוד את הפורמט/ })));
  await screen.findByTestId('rules-map');
  return { liveCheck };
}

const rowLines = (): string[] => [...document.querySelectorAll('[data-section="rows"] [data-line-id]')].map((e) => e.getAttribute('data-line-id') ?? '');
const line = (id: string): HTMLElement => document.querySelector(`[data-line-id="${id}"]`) as HTMLElement;

describe('readAs in the rules map', () => {
  it('says each text in the Rows section, and opens an editor that removes it - one undoable edit', async () => {
    const { liveCheck } = await open();
    expect(rowLines()).toEqual(['readAs:c_amount:N/A', 'readAs:c_amount:-']);
    expect(line('readAs:c_amount:N/A').textContent).toContain("In Amount, 'N/A' is read as empty");
    expect(line('readAs:c_amount:-').textContent).toContain("In Amount, '-' is read as '0'");

    fireEvent.click(within(line('readAs:c_amount:N/A')).getAllByRole('button').find((b) => b.classList.contains('map-line__main'))!);
    expect(await screen.findByText('Reading a text as another value')).toBeTruthy();
    expect(screen.getByText(/every format that reads it gets this rule/)).toBeTruthy();
    await act(async () => void fireEvent.click(screen.getByRole('button', { name: 'Remove this rule' })));

    expect(rowLines()).toEqual(['readAs:c_amount:-']);
    await waitFor(() => {
      expect(liveCheck.mock.calls.at(-1)![1].input.columns.find((c) => c.id === 'c_amount')!.readAs).toEqual({ '-': '0' });
    });
    await act(async () => void fireEvent.click(screen.getByRole('button', { name: 'Undo' })));
    await waitFor(() => expect(rowLines()).toEqual(['readAs:c_amount:N/A', 'readAs:c_amount:-']));
  });

  it('has its Hebrew copy', async () => {
    await open('he');
    expect(line('readAs:c_amount:N/A').textContent).toContain("בעמודה Amount, 'N/A' נקרא כריק");
    expect(line('readAs:c_amount:-').textContent).toContain("בעמודה Amount, '-' נקרא כ-'0'");
    fireEvent.click(within(line('readAs:c_amount:-')).getAllByRole('button').find((b) => b.classList.contains('map-line__main'))!);
    await act(async () => void fireEvent.click(await screen.findByRole('button', { name: 'הסרת הכלל הזה' })));
    expect(rowLines()).toEqual(['readAs:c_amount:N/A']);
  });
});
