// When the AI step could not finish (SPEC 8.11, 21 v12 item 12; docs/proposals/learning-loop.md 3.5, 7.3): the learning loop stopped without every
// row matching, or an answer was kept with differences. The best answer is on screen, and a short panel names the rows that still come out
// different - grouped per column, up to 5 row numbers and "and N more" - with the real values of the first few, shown locally. Per column two
// ways forward: "Fix the rule" (the editor opens on that column) or "Leave it empty for now" (the column becomes "needs your input").
// There is NO "keep these rows as they are" (the owner's open question). The engine is a fake; nothing is sent.
import type { LearnResult, Rules } from '@formatai/shared';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryPendingStore, setPendingStore } from '../src/app/pendingLearn';
import { ordersRules } from '../src/editor/testkit';
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

const ROWS = 200;
const HEADERS = ordersRules().output.columns.map((c) => c.header);
const TOTAL = HEADERS.indexOf('Total');
const SUPPLIER = HEADERS.indexOf('Supplier');
/** The rows of the example the Total rule gets wrong (7: five are named, then "and 2 more"), and the ones Supplier gets wrong (1). */
const TOTAL_ROWS = [38, 89, 132, 140, 151, 160, 170];
const SUPPLIER_ROWS = [12];

/** The worker's live check on the rules it is given: the columns that have a rule differ in those rows, a column left empty is not compared. */
function liveOf(rules: LearnResult | Rules) {
  const bad = (index: number, rows: number[]): number[] => (rules.output.columns[index]?.from === null ? [] : rows);
  const badTotal = bad(TOTAL, TOTAL_ROWS);
  const badSupplier = bad(SUPPLIER, SUPPLIER_ROWS);
  const mismatches = [
    ...badSupplier.map((exampleRow) => ({ exampleRow, column: 'Supplier', columnIndex: SUPPLIER, expected: 'Acme', actual: 'Zenith' })),
    ...badTotal.map((exampleRow) => ({ exampleRow, column: 'Total', columnIndex: TOTAL, expected: 100 + exampleRow, actual: null })),
  ];
  const differing = new Set([...badTotal, ...badSupplier]);
  return liveResult({
    verified: differing.size === 0,
    matched: ROWS - differing.size,
    total: ROWS,
    differences: differing.size,
    perColumn: HEADERS.map((header, c) => ({
      header,
      inExample: true,
      matched: ROWS - (c === TOTAL ? badTotal.length : c === SUPPLIER ? badSupplier.length : 0),
      total: ROWS,
    })),
    mismatches,
    mismatchCount: mismatches.length,
    preview: [],
    checkedInputRows: ROWS,
    totalInputRows: ROWS,
  });
}

const llmResult = (over: Record<string, unknown> = {}): LearnOutput =>
  learnResult({
    path: 'llm',
    rules: ordersRules(),
    exampleId: 'ex1',
    loop: { rounds: 3, rowsSent: 24, end: 'roundCap' },
    verification: { verified: false, matched: ROWS - 8, total: ROWS, mismatches: [], layoutProblems: [], layoutIssues: [], repairProblems: [] },
    ...over,
  });

async function openWith(result: LearnOutput, lang: 'en' | 'he' = 'en') {
  const liveCheck = vi.fn(async (_id: string, r: LearnResult | Rules) => liveOf(r));
  const { engine, learn } = fakeEngine(async () => result, undefined, { liveCheck, fullCheck: liveCheck });
  const api = fakeApi({ user: USER });
  renderApp({ engine, api, lang });
  const en = lang === 'en';
  fireEvent.change(screen.getByLabelText(en ? 'Example input' : 'דוגמת קלט'), { target: { files: [csv('orders.csv')] } });
  fireEvent.change(screen.getByLabelText(en ? 'Example output' : 'דוגמת פלט'), { target: { files: [csv('Orders report.csv')] } });
  await waitFor(() => expect(screen.getAllByText(/1,204/)).toHaveLength(2));
  const learnButton = screen.getByRole('button', { name: en ? /Learn the format/ : /ללמוד את הפורמט/ }) as HTMLButtonElement;
  await waitFor(() => expect(learnButton.disabled).toBe(false));
  await act(async () => void fireEvent.click(learnButton));
  await screen.findByTestId('rules-map');
  await waitFor(() => expect(liveCheck).toHaveBeenCalled());
  return { learn, api, liveCheck };
}

const panel = (): HTMLElement | null => screen.queryByTestId('unfinished-rows');
const group = (header: string): HTMLElement => {
  const el = screen.getAllByTestId('unfinished-group').find((g) => g.getAttribute('data-column') === header);
  if (!el) throw new Error(`no group for ${header}`);
  return el;
};
const line = (id: string): HTMLElement => document.querySelector(`[data-line-id="${id}"]`) as HTMLElement;

describe('rows that still do not follow the rules', () => {
  it('names them per column, up to 5 row numbers and "and N more", with the real values of the first rows - and nothing is sent', async () => {
    const { api, learn } = await openWith(llmResult());
    const p = await screen.findByTestId('unfinished-rows');
    expect(p.textContent).toContain("Some rows don't follow the rules yet");
    expect(screen.getAllByTestId('unfinished-group')).toHaveLength(2);
    // Per column, in column order: Supplier (1 row), then Total (7 rows: five named).
    expect(group('Supplier').textContent).toContain("1 row doesn't follow the rule we found for Supplier: row 12");
    expect(group('Total').textContent).toContain("7 rows don't follow the rule we found for Total: rows 38, 89, 132, 140, 151 and 2 more");
    // The real values of the first rows, from the checked example, on this computer.
    const rows = within(group('Total')).getAllByRole('listitem');
    expect(rows.map((r) => r.textContent)).toEqual([
      'Row 38: your example has 138.00; this rule gives nothing',
      'Row 89: your example has 189.00; this rule gives nothing',
      'Row 132: your example has 232.00; this rule gives nothing',
    ]);
    expect(within(group('Supplier')).getAllByRole('listitem')[0]!.textContent).toBe('Row 12: your example has Acme; this rule gives Zenith');
    // Two choices per group, and no "keep these rows as they are".
    for (const header of ['Supplier', 'Total']) {
      expect(within(group(header)).getByRole('button', { name: `Fix the rule for ${header}` })).toBeTruthy();
      expect(within(group(header)).getByRole('button', { name: `Leave ${header} empty for now` }).textContent).toBe('Leave it empty for now');
    }
    expect(within(p).queryByText(/keep (these|them)/i)).toBeNull();
    expect(learn).toHaveBeenCalledTimes(1);
    expect(api.learn).not.toHaveBeenCalled();
    expect(api.repair).not.toHaveBeenCalled();
  });

  it('"Fix the rule" opens the rules editor on that column', async () => {
    await openWith(llmResult());
    await screen.findByTestId('unfinished-rows');
    expect(line('col:Total').getAttribute('data-selected')).toBeNull();
    await act(async () => void fireEvent.click(within(group('Total')).getByRole('button', { name: 'Fix the rule for Total' })));
    await waitFor(() => expect(line('col:Total').getAttribute('data-selected')).toBe('true'));
    expect(document.querySelector('.workbench__panel[data-open] .sheet')).not.toBeNull();
    // The panel still names the rows: they are not gone until the rule is fixed.
    expect(group('Total')).toBeTruthy();
  });

  it('"Leave it empty for now" makes the column "needs your input" - and only that group goes', async () => {
    await openWith(llmResult());
    await screen.findByTestId('unfinished-rows');
    await act(async () => void fireEvent.click(within(group('Total')).getByRole('button', { name: 'Leave Total empty for now' })));
    await waitFor(() => expect(line('col:Total').getAttribute('data-status')).toBe('needsInput'));
    expect(screen.getAllByTestId('unfinished-group').map((g) => g.getAttribute('data-column'))).toEqual(['Supplier']);
    // (the badge counts it as a column that needs the user, not as a difference)
    await waitFor(() => expect(screen.getByTestId('status-badge').textContent).toMatch(/needs? your input/));
    // The last group: the whole panel goes.
    await act(async () => void fireEvent.click(within(group('Supplier')).getByRole('button', { name: 'Leave Supplier empty for now' })));
    await waitFor(() => expect(panel()).toBeNull());
  });

  it('is shown when an answer was kept with differences for any other reason too (the loop ended "verified" but a column still differs)', async () => {
    await openWith(llmResult({ loop: { rounds: 0, rowsSent: 0, end: 'verified' } }));
    expect(await screen.findByTestId('unfinished-rows')).toBeTruthy();
  });

  it('is not shown for a result that matches, for the free engine\'s result, or once the answer is fixed', async () => {
    await openWith(learnResult({ path: 'local', exampleId: 'ex1', rules: ordersRules() }));
    await waitFor(() => expect(screen.getByTestId('status-badge')).toBeTruthy());
    expect(panel()).toBeNull();
    cleanup();
    await openWith(llmResult({ verification: { verified: true, matched: ROWS, total: ROWS, mismatches: [], layoutProblems: [], layoutIssues: [], repairProblems: [] } }));
    await waitFor(() => expect(screen.getByTestId('status-badge')).toBeTruthy());
    expect(panel()).toBeNull();
  });

  it('has its Hebrew copy', async () => {
    await openWith(llmResult(), 'he');
    const p = await screen.findByTestId('unfinished-rows');
    expect(p.textContent).toContain('חלק מהשורות עדיין לא תואמות לכללים');
    expect(group('Total').textContent).toContain('7 שורות לא תואמות לכלל שמצאנו עבור Total: שורות 38, 89, 132, 140, 151 ועוד 2');
    expect(group('Supplier').textContent).toContain('שורה אחת לא תואמת לכלל שמצאנו עבור Supplier: שורה 12');
    expect(within(group('Supplier')).getAllByRole('listitem')[0]!.textContent).toBe('שורה 12: בדוגמה שלכם Acme; הכלל הזה נותן Zenith');
    expect(within(group('Total')).getByRole('button', { name: 'תיקון הכלל של Total' })).toBeTruthy();
    expect(within(group('Total')).getByRole('button', { name: 'להשאיר את Total ריק בינתיים' }).textContent).toBe('להשאיר ריק בינתיים');
  });
});
