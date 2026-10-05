// The day/month order as the ambiguity question (SPEC 8.11, 21 v12 item 16; docs/proposals/learning-loop.md 7.1 item 5, 7.2): after an AI learn, a text
// date column that no value of the example settles (every date reads both ways) is read the way the AI answer wrote it, and the result screen asks
// ONCE, in the same quiet question as any ambiguous column: "Order Date: day/month or month/day?", each answer with a date that shows it. Two
// readings - the format used, and the other order - applied in place wherever the rules read the column. No kind of check can say "this date reads
// both ways", so the question has no check: it is open while the rules read the format used, and "Not sure yet" says only what is kept for now.
// The questions are made by the engine's `dayMonthQuestions` exactly as the worker makes them; the live check and the API are fakes.
import { dayMonthQuestions } from '@formatai/engine';
import type { Expr, LearnResult } from '@formatai/shared';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryPendingStore, setPendingStore } from '../src/app/pendingLearn';
import type { LearnOutput } from '../src/worker/engineApi';
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

const N = 24;
const AMBIGUITY = { kind: 'dayMonthOrder' as const, column: 'Order Date', format: 'DD/MM/YYYY', other: 'MM/DD/YYYY' };

/** What an AI answer could look like: the Order Date text column read with `format`, shown as a date (`inputFormats`) or as its month (`toDate`). */
function answer(route: 'inputFormats' | 'toDate', lang: 'en' | 'he' = 'en'): LearnResult {
  const he = lang === 'he';
  const [date, id, month] = he ? ['תאריך הזמנה', 'מספר', 'חודש'] : ['Order Date', 'Id', 'Month'];
  const toDate: Expr = { op: 'datePart', arg: { op: 'toDate', arg: { col: 'orderdate' }, format: 'DD/MM/YYYY' }, part: 'month' };
  return {
    schemaVersion: 1,
    input: {
      sheet: { pick: 'first' },
      headerRow: 'auto',
      columns: [
        { id: 'id', header: id, type: 'text' },
        route === 'inputFormats' ? { id: 'orderdate', header: date, type: 'date', inputFormats: ['DD/MM/YYYY'] } : { id: 'orderdate', header: date, type: 'text' },
      ],
    },
    transform: route === 'toDate' ? { computed: [{ id: 'month', type: 'integer', expr: toDate }], valueMaps: [], sort: [] } : { computed: [], valueMaps: [], sort: [] },
    output: {
      sheetName: 'Out',
      direction: he ? 'rtl' : 'ltr',
      language: lang,
      titleRows: [],
      columns: [
        { header: id, from: 'id' },
        route === 'inputFormats' ? { header: date, from: 'orderdate' } : { header: month, from: 'month' },
      ],
    },
    validations: [],
    unsupported: [],
    assumptions: [],
  };
}

/** What the worker returns for an AI learn: the answer, its ambiguity, and the question made from it. */
function aiResult(route: 'inputFormats' | 'toDate', lang: 'en' | 'he' = 'en'): LearnOutput {
  const rules = answer(route, lang);
  const ambiguities = [{ ...AMBIGUITY, column: rules.input.columns[1]!.header }];
  return learnResult({
    path: 'llm',
    rules,
    ambiguities,
    ambiguous: dayMonthQuestions(rules, ambiguities),
    exampleId: 'ex1',
    loop: { rounds: 0, rowsSent: 0, end: 'verified' },
    verification: { verified: true, matched: N, total: N, mismatches: [], layoutProblems: [], layoutIssues: [], repairProblems: [] },
  });
}

const okLive = async (_id: string, r: LearnResult) =>
  liveResult({ matched: N, total: N, perColumn: r.output.columns.map((c) => ({ header: c.header, inExample: true, matched: N, total: N })), checkedInputRows: N, totalInputRows: N });

async function openWith(first: LearnOutput, lang: 'en' | 'he' = 'en') {
  const en = lang === 'en';
  const liveCheck = vi.fn(okLive);
  const fake = fakeEngine(undefined, undefined, { liveCheck, fullCheck: liveCheck });
  fake.learn.mockImplementation(async () => first);
  const api = fakeApi({ user: USER });
  renderApp({ engine: fake.engine, api, lang });
  fireEvent.change(screen.getByLabelText(en ? 'Example input' : 'דוגמת קלט'), { target: { files: [csv('orders.csv')] } });
  fireEvent.change(screen.getByLabelText(en ? 'Example output' : 'דוגמת פלט'), { target: { files: [csv('dates.csv')] } });
  await waitFor(() => expect(screen.getAllByText(/1,204/)).toHaveLength(2));
  await waitFor(() => expect((screen.getByRole('button', { name: en ? /Learn the format/ : /ללמוד את הפורמט/ }) as HTMLButtonElement).disabled).toBe(false));
  await act(async () => void fireEvent.click(screen.getByRole('button', { name: en ? /Learn the format/ : /ללמוד את הפורמט/ })));
  await screen.findByTestId('rules-map');
  await waitFor(() => expect(liveCheck).toHaveBeenCalled());
  return { ...fake, api, liveCheck };
}

/** The rules the live check last ran: what is on screen. */
const lastRules = (liveCheck: ReturnType<typeof vi.fn>): LearnResult => liveCheck.mock.calls.at(-1)![1] as LearnResult;
const toDateFormats = (r: LearnResult): string[] => JSON.stringify(r.transform.computed).match(/"format":"[^"]+"/g)?.map((x) => x.slice(10, -1)) ?? [];

const question = (): HTMLElement | null => screen.queryByTestId('reading-question');
const checkLines = (): string[] => [...document.querySelectorAll('[data-section="checks"] [data-line-id]')].map((e) => e.textContent ?? '');
const undoButton = (): HTMLButtonElement => screen.getByRole('button', { name: 'Undo' }) as HTMLButtonElement;

describe('the day/month question', () => {
  it('is asked on the output column that reads the date, in the ambiguity question\'s own shape, with each order shown by a date - no check, no AI call', async () => {
    const { api, learn } = await openWith(aiResult('inputFormats'));
    const q = await screen.findByTestId('reading-question');
    expect(document.querySelector('[data-line-id="col:Order Date"]')!.contains(q)).toBe(true);
    expect(q.textContent).toContain('Order Date: day/month or month/day?');
    expect(within(q).getAllByRole('button').map((b) => b.textContent)).toEqual(['day/month (31/01)', 'month/day (01/31)', 'Not sure yet']);
    // The format the AI used stays until the user answers; nothing was added to the rules, and nothing is amber.
    expect(checkLines()).toEqual([]);
    expect(document.querySelector('[data-line-id="col:Order Date"]')!.getAttribute('data-status')).toBe('matches');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(api.learn).not.toHaveBeenCalled();
    expect(learn).toHaveBeenCalledTimes(1);
  });

  it('answering the other order writes that format where the rules read the column (the column\'s input formats) - one undoable step; undo asks again', async () => {
    const { liveCheck } = await openWith(aiResult('inputFormats'));
    expect(lastRules(liveCheck).input.columns[1]!.inputFormats).toEqual(['DD/MM/YYYY']);
    await act(async () => void fireEvent.click(within(await screen.findByTestId('reading-question')).getByRole('button', { name: 'month/day (01/31)' })));
    expect(question()).toBeNull();
    await waitFor(() => expect(lastRules(liveCheck).input.columns[1]!.inputFormats).toEqual(['MM/DD/YYYY']));
    expect(undoButton().disabled).toBe(false);
    await act(async () => void fireEvent.click(undoButton()));
    expect(await screen.findByTestId('reading-question')).toBeTruthy();
    await waitFor(() => expect(lastRules(liveCheck).input.columns[1]!.inputFormats).toEqual(['DD/MM/YYYY']));
  });

  it('answering the order the rules already use keeps them as they are, adds no step to undo, and closes the question', async () => {
    const { liveCheck } = await openWith(aiResult('inputFormats'));
    const before = liveCheck.mock.calls.length;
    await act(async () => void fireEvent.click(within(await screen.findByTestId('reading-question')).getByRole('button', { name: 'day/month (31/01)' })));
    await waitFor(() => expect(question()).toBeNull());
    expect(lastRules(liveCheck).input.columns[1]!.inputFormats).toEqual(['DD/MM/YYYY']);
    expect(liveCheck.mock.calls.length).toBe(before);
    expect(undoButton().disabled).toBe(true);
  });

  it('a toDate in a computed column: the answer writes the other format into it', async () => {
    const { liveCheck } = await openWith(aiResult('toDate'));
    const q = await screen.findByTestId('reading-question');
    expect(document.querySelector('[data-line-id="col:Month"]')!.contains(q)).toBe(true);
    expect(toDateFormats(lastRules(liveCheck))).toEqual(['DD/MM/YYYY']);
    await act(async () => void fireEvent.click(within(q).getByRole('button', { name: 'month/day (01/31)' })));
    await waitFor(() => expect(toDateFormats(lastRules(liveCheck))).toEqual(['MM/DD/YYYY']));
    expect(question()).toBeNull();
    // the column still reads the same input column, through the same computed column
    expect(lastRules(liveCheck).output.columns[1]!.from).toBe('month');
  });

  it('"Not sure yet" keeps the format used, says only that (no check, so no row is flagged), and can be opened again', async () => {
    const { api, liveCheck } = await openWith(aiResult('inputFormats'));
    const q = await screen.findByTestId('reading-question');
    await act(async () => void fireEvent.click(within(q).getByRole('button', { name: 'Not sure yet' })));
    expect((await screen.findByTestId('reading-unsure')).textContent).toBe('Not sure yet. For now: day/month (31/01).');
    expect(checkLines()).toEqual([]);
    expect(lastRules(liveCheck).input.columns[1]!.inputFormats).toEqual(['DD/MM/YYYY']);
    expect(api.learn).not.toHaveBeenCalled();
    await act(async () => void fireEvent.click(within(question()!).getByRole('button', { name: 'Choose' })));
    expect(screen.queryByTestId('reading-unsure')).toBeNull();
    expect(question()!.textContent).toContain('Order Date: day/month or month/day?');
  });

  it('has its Hebrew copy', async () => {
    await openWith(aiResult('inputFormats', 'he'), 'he');
    const q = await screen.findByTestId('reading-question');
    expect(q.textContent).toContain('תאריך הזמנה: יום/חודש או חודש/יום?');
    expect(within(q).getAllByRole('button').map((b) => b.textContent)).toEqual(['יום/חודש (31/01)', 'חודש/יום (01/31)', 'עוד לא בטוחים']);
    await act(async () => void fireEvent.click(within(q).getByRole('button', { name: 'עוד לא בטוחים' })));
    expect((await screen.findByTestId('reading-unsure')).textContent).toBe('עוד לא בטוחים. בינתיים: יום/חודש (31/01).');
  });

  it('is not asked when the answer has no such ambiguity', async () => {
    await openWith(learnResult({ path: 'llm', rules: answer('inputFormats'), exampleId: 'ex1' }));
    expect(question()).toBeNull();
  });
});
