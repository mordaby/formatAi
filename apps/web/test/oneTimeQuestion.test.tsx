// A one-time edit or a rule? (SPEC 8.11, 21 v12 item 20; owner decision 2026-10-05). After an AI learn, a part of a rule that explains exactly
// one row of the example - here `if(Order ID = "ORD-03053", 0, ...)` for the hand-edited row 54 of discount-hand-edited - is asked about on
// its column's line, with the row's own values (nothing sent). "A one-time change" takes the part out (one undoable edit): the column's rule
// applies to every row, and row 54 is listed as a row that doesn't follow the rule, not counted as a difference. "A rule" keeps it. "Not
// sure" keeps it with a check that flags a later row it applies to. The live check is a fake that answers like the worker does.
// The second kind (owner amendment, 2026-10-06): a list copied from the example - "Account Manager: is this the rule?" - with its two answers.
import type { OneTimeQuestion } from '@formatai/engine';
import type { Expr, LearnResult, Rules, Validation } from '@formatai/shared';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryPendingStore, setPendingStore } from '../src/app/pendingLearn';
import type { OneTimeCell } from '../src/editor';
import type { LiveCheckOptions } from '../src/worker/engineClient';
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

const ROWS = 150;
const tenth: Expr = { op: 'round', arg: { op: 'mul', args: [{ col: 'amount' }, { const: 0.1 }] }, digits: 2 };
const byId: Expr = { op: 'eq', args: [{ col: 'orderId' }, { const: 'ORD-03053' }] };
const check: Validation = { column: 'discount', rule: 'sameAs', expr: tenth, severity: 'flag', oneTime: true };

const answer: LearnResult = {
  schemaVersion: 1,
  input: {
    sheet: { pick: 'first' },
    headerRow: 'auto',
    columns: [
      { id: 'orderId', header: 'Order ID', type: 'text' },
      { id: 'amount', header: 'Amount', type: 'decimal' },
    ],
  },
  transform: { computed: [{ id: 'discount', type: 'decimal', expr: { op: 'if', cond: byId, then: { const: 0 }, else: tenth } }], valueMaps: [], sort: [] },
  output: {
    sheetName: 'Orders with discount',
    direction: 'ltr',
    language: 'en',
    titleRows: [],
    columns: [
      { header: 'Order ID', from: 'orderId' },
      { header: 'Amount', from: 'amount', format: '#,##0.00' },
      { header: 'Discount', from: 'discount', format: '#,##0.00' },
    ],
  },
  validations: [],
  unsupported: [],
  assumptions: [],
};

/** What the engine's `oneTimeQuestions` gives for this answer on discount-hand-edited (row 54: Amount 2,526.05, Discount 0). */
const question: OneTimeQuestion = {
  out: 2,
  header: 'Discount',
  part: { kind: 'branch', computed: 'discount', when: byId, then: { const: 0 } },
  row: 54,
  inputRow: 54,
  by: 'id',
  byColumn: 'Order ID',
  key: 'ORD-03053',
  value: 0,
  rest: 252.61,
  check,
};

const aiResult = (): LearnOutput =>
  learnResult({
    path: 'llm',
    rules: answer,
    exampleId: 'ex1',
    loop: { rounds: 0, rowsSent: 0, end: 'verified' },
    verification: { verified: true, matched: ROWS, total: ROWS, mismatches: [], layoutProblems: [], layoutIssues: [], repairProblems: [] },
    oneTimers: { questions: [question], handedOff: [] },
  });

const HEADERS = answer.output.columns.map((c) => c.header);
const ROW54 = { exampleRow: 54, column: 'Discount', columnIndex: 2, expected: 0, actual: 252.61 };

/** The worker's check: the rules reproduce row 54 while the part is in them; without it row 54 differs - unless it is a one-time cell. */
function liveOf(rules: LearnResult | Rules, options?: LiveCheckOptions) {
  const hasPart = JSON.stringify(rules.transform.computed).includes('ORD-03053');
  const excused = (options?.oneTime ?? []).some((c) => c.exampleRow === 54 && c.column === 'Discount');
  const wrong = !hasPart && !excused;
  return liveResult({
    verified: !wrong,
    matched: ROWS - (wrong ? 1 : 0),
    total: ROWS,
    differences: wrong ? 1 : 0,
    perColumn: HEADERS.map((header) => ({ header, inExample: true, matched: ROWS - (wrong && header === 'Discount' ? 1 : 0), total: ROWS })),
    mismatches: wrong ? [ROW54] : [],
    mismatchCount: wrong ? 1 : 0,
    ...(!hasPart && excused ? { oneTime: [ROW54] } : {}),
    checkedInputRows: ROWS,
    totalInputRows: ROWS,
  });
}

async function openWith(result: LearnOutput, lang: 'en' | 'he' = 'en') {
  const liveCheck = vi.fn(async (_id: string, r: LearnResult | Rules, options?: LiveCheckOptions) => liveOf(r, options));
  const fake = fakeEngine(async () => result, undefined, { liveCheck, fullCheck: liveCheck });
  const api = fakeApi({ user: USER });
  renderApp({ engine: fake.engine, api, lang });
  const en = lang === 'en';
  fireEvent.change(screen.getByLabelText(en ? 'Example input' : 'דוגמת קלט'), { target: { files: [csv('orders.csv')] } });
  fireEvent.change(screen.getByLabelText(en ? 'Example output' : 'דוגמת פלט'), { target: { files: [csv('discount.csv')] } });
  await waitFor(() => expect(screen.getAllByText(/1,204/)).toHaveLength(2));
  const learnButton = screen.getByRole('button', { name: en ? /Learn the format/ : /ללמוד את הפורמט/ }) as HTMLButtonElement;
  await waitFor(() => expect(learnButton.disabled).toBe(false));
  await act(async () => void fireEvent.click(learnButton));
  await screen.findByTestId('rules-map');
  await waitFor(() => expect(liveCheck).toHaveBeenCalled());
  return { ...fake, api, liveCheck };
}

type LiveMock = ReturnType<typeof vi.fn>;
const lastCall = (liveCheck: LiveMock): { rules: LearnResult; oneTime: OneTimeCell[] } => {
  const call = liveCheck.mock.calls.at(-1)!;
  return { rules: call[1] as LearnResult, oneTime: (call[2] as LiveCheckOptions | undefined)?.oneTime ?? [] };
};
const discountExpr = (r: LearnResult): Expr | undefined => r.transform.computed.find((c) => c.id === 'discount')?.expr;
const checkLines = (): string[] => [...document.querySelectorAll('[data-section="checks"] [data-line-id]')].map((e) => e.textContent ?? '');
const badge = (): string => screen.getByTestId('status-badge').textContent ?? '';

describe('a one-time edit or a rule?', () => {
  it('is asked on the column\'s line, in the map\'s words, with the row\'s own values - and nothing is sent', async () => {
    const { api, learn } = await openWith(aiResult());
    const q = await screen.findByTestId('one-time-question');
    expect(document.querySelector('[data-line-id="col:Discount"]')!.contains(q)).toBe(true);
    expect(q.querySelector('.map-line__ask-question')!.textContent).toBe(
      'Row 54: Discount is 0.00 instead of Amount × 0.1, rounded to 2 decimals. A one-time change, or a rule we missed?',
    );
    expect(within(q).getByTestId('one-time-values').textContent).toBe(
      'This part of the rule applies to this row only: it picks the row by its Order ID (ORD-03053). Your example has 0.00 in this row; the rest of the rule gives 252.61. Shown here, on your computer only; nothing is sent.',
    );
    expect(within(q).getByRole('group', { name: 'Row 54 of Discount: one-time change or rule' })).toBeTruthy();
    expect(within(q).getAllByRole('button').map((b) => b.textContent)).toEqual(['A one-time change', 'A rule', 'Not sure']);
    expect(learn).toHaveBeenCalledTimes(1);
    expect(api.learn).not.toHaveBeenCalled();
    expect(api.repair).not.toHaveBeenCalled();
  });

  it('"A one-time change" takes the part out and lists row 54 as not following the rule, not as a difference - one undoable edit', async () => {
    const { liveCheck } = await openWith(aiResult());
    const q = await screen.findByTestId('one-time-question');
    await act(async () => void fireEvent.click(within(q).getByRole('button', { name: 'A one-time change' })));
    await waitFor(() => expect(screen.queryByTestId('one-time-question')).toBeNull());
    // The column's remaining rule applies to every row; the row is a one-time cell of the check, nothing in the rules says so.
    await waitFor(() => expect(lastCall(liveCheck).oneTime).toEqual([{ exampleRow: 54, column: 'Discount' }]));
    expect(discountExpr(lastCall(liveCheck).rules)).toEqual(tenth);
    expect(JSON.stringify(lastCall(liveCheck).rules)).not.toContain('ORD-03053');
    const panel = await screen.findByTestId('unfinished-rows');
    expect(panel.textContent).toContain("Rows that don't follow the rule");
    expect(within(panel).getByTestId('one-time-rows').textContent).toBe('Row 54 (Discount): your example has 0.00; the rule gives 252.61');
    expect(within(panel).queryByRole('button')).toBeNull();
    await waitFor(() => expect(badge()).toBe('Verified'));
    // Undo: the part is back, the row counts again, and the question is asked again.
    await act(async () => void fireEvent.click(screen.getByRole('button', { name: 'Undo' })));
    expect(await screen.findByTestId('one-time-question')).toBeTruthy();
    await waitFor(() => expect(lastCall(liveCheck).oneTime).toEqual([]));
    expect(discountExpr(lastCall(liveCheck).rules)).toEqual(answer.transform.computed[0]!.expr);
    await waitFor(() => expect(screen.queryByTestId('unfinished-rows')).toBeNull());
  });

  it('without the one-time answer the same rules would show row 54 as a difference (the fake worker is honest)', async () => {
    const { liveCheck } = await openWith(aiResult());
    expect(liveOf({ ...answer, transform: { ...answer.transform, computed: [{ id: 'discount', type: 'decimal', expr: tenth }] } }).differences).toBe(1);
    expect(lastCall(liveCheck).oneTime).toEqual([]);
  });

  it('"A rule" keeps the part as it is: the question goes, nothing changes (no undo step)', async () => {
    const { liveCheck } = await openWith(aiResult());
    const q = await screen.findByTestId('one-time-question');
    const calls = liveCheck.mock.calls.length;
    await act(async () => void fireEvent.click(within(q).getByRole('button', { name: 'A rule' })));
    await waitFor(() => expect(screen.queryByTestId('one-time-question')).toBeNull());
    expect(discountExpr(lastCall(liveCheck).rules)).toEqual(answer.transform.computed[0]!.expr);
    expect(liveCheck.mock.calls.length).toBe(calls);
    expect((screen.getByRole('button', { name: 'Undo' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('"Not sure" keeps the part with a check that flags a later row it applies to; the question folds and can be opened again', async () => {
    const { liveCheck } = await openWith(aiResult());
    const q = await screen.findByTestId('one-time-question');
    await act(async () => void fireEvent.click(within(q).getByRole('button', { name: 'Not sure' })));
    const unsure = await screen.findByTestId('one-time-unsure');
    expect(unsure.textContent).toBe('Row 54 of Discount: not sure yet. For now the rule keeps this part, and we flag a row of a later file where it applies.');
    await waitFor(() => expect(lastCall(liveCheck).rules.validations).toEqual([check]));
    expect(discountExpr(lastCall(liveCheck).rules)).toEqual(answer.transform.computed[0]!.expr);
    expect(checkLines().some((l) => l.includes('the rule for Discount has a part your example had on one row only; without it,') && l.includes('A row where that part applies: flag'))).toBe(true);
    // Opened again, then "a rule": the check goes too.
    await act(async () => void fireEvent.click(screen.getByRole('button', { name: 'Choose' })));
    const again = await screen.findByTestId('one-time-question');
    expect(again.getAttribute('data-state')).toBe('open');
    await act(async () => void fireEvent.click(within(again).getByRole('button', { name: 'A rule' })));
    await waitFor(() => expect(screen.queryByTestId('one-time-question')).toBeNull());
    await waitFor(() => expect(lastCall(liveCheck).rules.validations).toEqual([]));
    // Undo puts the check back: "not sure" again.
    await act(async () => void fireEvent.click(screen.getByRole('button', { name: 'Undo' })));
    expect(await screen.findByTestId('one-time-unsure')).toBeTruthy();
  });

  it('deleting the check "Not sure" put in (in the Checks section) asks the question again: the check is that answer\'s marker', async () => {
    const { liveCheck } = await openWith(aiResult());
    await screen.findByTestId('one-time-question');
    await act(async () => void fireEvent.click(screen.getByRole('button', { name: /^Not sure$/ })));
    await screen.findByTestId('one-time-unsure');
    const line = [...document.querySelectorAll('[data-section="checks"] [data-line-id]')].find((e) => /one row only/.test(e.textContent ?? '')) as HTMLElement;
    fireEvent.click(within(line).getAllByRole('button').find((b) => b.classList.contains('map-line__main'))!);
    // (the editor says the rule without the part as a formula, as it says an alternative's)
    expect((await screen.findByText(/you weren't sure whether it is a rule/)).textContent).toContain('(round(amount * 0.1, 2)) is flagged');
    fireEvent.click(await screen.findByRole('button', { name: 'Remove this check' }));
    await waitFor(() => expect(lastCall(liveCheck).rules.validations).toEqual([]));
    expect((await screen.findByTestId('one-time-question')).getAttribute('data-state')).toBe('open');
  });

  it('has its Hebrew copy', async () => {
    await openWith(aiResult(), 'he');
    const q = await screen.findByTestId('one-time-question');
    expect(q.querySelector('.map-line__ask-question')!.textContent).toMatch(/^שורה 54: Discount הוא 0\.00 במקום .*\. שינוי חד-פעמי, או כלל שפספסנו\?$/);
    expect(within(q).getByTestId('one-time-values').textContent).toContain('הוא בוחר אותה לפי Order ID שלה (ORD-03053)');
    expect(within(q).getAllByRole('button').map((b) => b.textContent)).toEqual(['שינוי חד-פעמי', 'כלל', 'לא בטוחים']);
    await act(async () => void fireEvent.click(within(q).getByRole('button', { name: 'שינוי חד-פעמי' })));
    const panel = await screen.findByTestId('unfinished-rows');
    expect(panel.textContent).toContain('שורות שלא לפי הכלל');
    expect(within(panel).getByTestId('one-time-rows').textContent).toBe('שורה 54 (Discount): בדוגמה שלכם 0.00; הכלל נותן 252.61');
  });
});

// ---------------------------------------------------------------------------
// A list copied from the example (owner amendment, 2026-10-06): Account Manager looked up by Account, a table code filled from the 40 rows
// of external-agent-column. The same place, look and buttons' role; asked neutrally, with no value of the list.
// ---------------------------------------------------------------------------

const MANAGER_ROWS = 40;
const lookupManager: Expr = { op: 'lookup', table: 'accountManagers', key: { col: 'account' }, return: 'manager', onMissing: 'flag' };
const listed: LearnResult = {
  schemaVersion: 1,
  input: {
    sheet: { pick: 'first' },
    headerRow: 'auto',
    columns: [
      { id: 'account', header: 'Account', type: 'idLike' },
      { id: 'company', header: 'Company', type: 'text' },
    ],
  },
  transform: {
    computed: [{ id: 'accountManager', type: 'text', expr: lookupManager }],
    valueMaps: [],
    sort: [],
    tables: [{ name: 'accountManagers', columns: ['account', 'manager'], rows: Array.from({ length: MANAGER_ROWS }, (_, i) => [`ACC-${1001 + i}`, `Manager ${i % 8}`]) }],
  },
  output: {
    sheetName: 'Accounts with manager',
    direction: 'ltr',
    language: 'en',
    titleRows: [],
    columns: [
      { header: 'Account', from: 'account' },
      { header: 'Company', from: 'company' },
      { header: 'Account Manager', from: 'accountManager' },
    ],
  },
  validations: [],
  unsupported: [],
  assumptions: [],
};

const listQuestion: OneTimeQuestion = {
  kind: 'copiedList',
  out: 2,
  header: 'Account Manager',
  keyColumn: 'Account',
  entries: MANAGER_ROWS,
  list: { kind: 'lookup', computed: 'accountManager', table: 'accountManagers' },
};

const listResult = (): LearnOutput =>
  learnResult({
    path: 'llm',
    rules: listed,
    exampleId: 'ex1',
    loop: { rounds: 0, rowsSent: 0, end: 'verified' },
    verification: { verified: true, matched: MANAGER_ROWS, total: MANAGER_ROWS, mismatches: [], layoutProblems: [], layoutIssues: [], repairProblems: [] },
    oneTimers: { questions: [listQuestion], handedOff: [] },
  });

/** The worker's check for these rules: every column that has a rule matches (a copied list reproduces its example by construction). */
function listLive(rules: LearnResult | Rules) {
  const headers = rules.output.columns.filter((c) => c.from !== null).map((c) => c.header);
  return liveResult({
    verified: true,
    matched: MANAGER_ROWS,
    total: MANAGER_ROWS,
    differences: 0,
    perColumn: headers.map((header) => ({ header, inExample: true, matched: MANAGER_ROWS, total: MANAGER_ROWS })),
    checkedInputRows: MANAGER_ROWS,
    totalInputRows: MANAGER_ROWS,
  });
}

async function openList(lang: 'en' | 'he' = 'en') {
  const liveCheck = vi.fn(async (_id: string, r: LearnResult | Rules) => listLive(r));
  const fake = fakeEngine(async () => listResult(), undefined, { liveCheck, fullCheck: liveCheck });
  const api = fakeApi({ user: USER });
  renderApp({ engine: fake.engine, api, lang });
  const en = lang === 'en';
  fireEvent.change(screen.getByLabelText(en ? 'Example input' : 'דוגמת קלט'), { target: { files: [csv('accounts.csv')] } });
  fireEvent.change(screen.getByLabelText(en ? 'Example output' : 'דוגמת פלט'), { target: { files: [csv('managers.csv')] } });
  await waitFor(() => expect(screen.getAllByText(/1,204/)).toHaveLength(2));
  const learnButton = screen.getByRole('button', { name: en ? /Learn the format/ : /ללמוד את הפורמט/ }) as HTMLButtonElement;
  await waitFor(() => expect(learnButton.disabled).toBe(false));
  await act(async () => void fireEvent.click(learnButton));
  await screen.findByTestId('rules-map');
  await waitFor(() => expect(liveCheck).toHaveBeenCalled());
  return { ...fake, api, liveCheck };
}

const managerColumn = (r: LearnResult) => r.output.columns.find((c) => c.header === 'Account Manager');

describe('a list copied from the example: is this the rule?', () => {
  it('is asked on the column\'s line, neutrally: what was learned, the key column and the entry count - no value, nothing sent', async () => {
    const { api, learn } = await openList();
    const q = await screen.findByTestId('one-time-question');
    expect(document.querySelector('[data-line-id="col:Account Manager"]')!.contains(q)).toBe(true);
    expect(q.getAttribute('data-kind')).toBe('copiedList');
    expect(q.querySelector('.map-line__ask-question')!.textContent).toBe('Account Manager: is this the rule?');
    expect(within(q).getByTestId('one-time-values').textContent).toBe('We learned Account Manager as a list taken from your example: one value for each Account (40 entries).');
    expect(within(q).getByRole('group', { name: 'Account Manager: the rule or a one-time edit' })).toBeTruthy();
    expect(within(q).getAllByRole('button').map((b) => b.textContent)).toEqual(["Yes, that's the rule", 'No, it was a one-time edit']);
    expect(q.textContent).not.toContain('Manager 0');
    expect(learn).toHaveBeenCalledTimes(1);
    expect(api.learn).not.toHaveBeenCalled();
    expect(api.repair).not.toHaveBeenCalled();
  });

  it('"No, it was a one-time edit": the column needs your input - left empty, its list gone - in one undoable edit', async () => {
    const { liveCheck } = await openList();
    const q = await screen.findByTestId('one-time-question');
    await act(async () => void fireEvent.click(within(q).getByRole('button', { name: 'No, it was a one-time edit' })));
    await waitFor(() => expect(screen.queryByTestId('one-time-question')).toBeNull());
    await waitFor(() => expect(managerColumn(lastCall(liveCheck).rules)?.from).toBeNull());
    const { rules, oneTime } = lastCall(liveCheck);
    expect(rules.unsupported).toEqual([{ outputColumn: 'Account Manager', reasonCode: 'overfit' }]);
    expect([rules.transform.computed, rules.transform.tables]).toEqual([[], []]);
    expect(oneTime).toEqual([]);
    await waitFor(() => expect(badge()).toBe('1 column needs your input'));
    // Undo: the list is back, and so is the question.
    await act(async () => void fireEvent.click(screen.getByRole('button', { name: 'Undo' })));
    expect(await screen.findByTestId('one-time-question')).toBeTruthy();
    await waitFor(() => expect(managerColumn(lastCall(liveCheck).rules)?.from).toBe('accountManager'));
    expect(lastCall(liveCheck).rules.transform.tables).toEqual(listed.transform.tables);
  });

  it('"Yes, that\'s the rule" keeps the list as it is: the question goes, nothing changes (no undo step)', async () => {
    const { liveCheck } = await openList();
    const q = await screen.findByTestId('one-time-question');
    const calls = liveCheck.mock.calls.length;
    await act(async () => void fireEvent.click(within(q).getByRole('button', { name: "Yes, that's the rule" })));
    await waitFor(() => expect(screen.queryByTestId('one-time-question')).toBeNull());
    expect(lastCall(liveCheck).rules).toEqual(listed);
    expect(liveCheck.mock.calls.length).toBe(calls);
    expect((screen.getByRole('button', { name: 'Undo' }) as HTMLButtonElement).disabled).toBe(true);
    expect(badge()).toBe('Verified');
  });

  it('has its Hebrew copy', async () => {
    const { liveCheck } = await openList('he');
    const q = await screen.findByTestId('one-time-question');
    expect(q.querySelector('.map-line__ask-question')!.textContent).toBe('Account Manager: זה הכלל?');
    expect(within(q).getByTestId('one-time-values').textContent).toBe('למדנו את Account Manager כרשימה שנלקחה מהדוגמה שלכם: ערך אחד לכל Account (40 ערכים).');
    expect(within(q).getByRole('group', { name: 'Account Manager: כלל או שינוי חד-פעמי' })).toBeTruthy();
    expect(within(q).getAllByRole('button').map((b) => b.textContent)).toEqual(['כן, זה הכלל', 'לא, זה היה שינוי חד-פעמי']);
    await act(async () => void fireEvent.click(within(q).getByRole('button', { name: 'לא, זה היה שינוי חד-פעמי' })));
    await waitFor(() => expect(managerColumn(lastCall(liveCheck).rules)?.from).toBeNull());
    expect(screen.queryByTestId('one-time-question')).toBeNull();
  });
});
