import type { Flag } from '@formatai/engine';
import { assumptionMessages, tiers, unsupportedMessages, type LearnResult, type PayloadCell, type Rules } from '@formatai/shared';
import { act, cleanup, createEvent, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ordersRules } from '../src/editor/testkit';
import { en, he, I18nProvider, type Lang, type MessageKey } from '../src/i18n';
import { FormatChange } from '../src/pages/Result/EditorPanel';
import { getResultSession } from '../src/pages/Result/session';
import type { LiveCheckResult, PreviewRow } from '../src/worker/editorApi';
import type { LearnOutput } from '../src/worker/engineApi';
import { csv, fakeApi, fakeEngine, learnResult, liveResult, renderApp } from './helpers/renderApp';

beforeEach(() => {
  document.cookie = 'lang=; Path=/; Max-Age=0';
});
afterEach(() => {
  cleanup();
  document.cookie = 'lang=; Path=/; Max-Age=0';
  document.documentElement.lang = '';
  document.documentElement.dir = '';
});

// ---------------------------------------------------------------------------
// A fake worker for the rules editor: it "runs" the rules by looking at the one thing the tests change (the Total
// column's calculation) and answers the way the real live check would: rows that differ come first, exceptions are
// left out of every count.
// ---------------------------------------------------------------------------

const ROWS = 30;
const original = ordersRules();
const originalCalc = JSON.stringify(original.transform.computed);
const HEADERS = original.output.columns.map((c) => c.header);
const TOTAL = HEADERS.indexOf('Total');
const DIFFERING_ROWS = [3, 4, 5, 6, 7];

function makeLive(rules: LearnResult | Rules, exceptions: number[] = [], opts: { rows?: number; partial?: boolean } = {}): LiveCheckResult {
  const rows = opts.rows ?? ROWS;
  const changed = JSON.stringify(rules.transform.computed) !== originalCalc;
  const bad = changed ? DIFFERING_ROWS.filter((r) => !exceptions.includes(r)) : [];
  const width = HEADERS.length;
  const row = (exampleRow: number, ok: boolean): PreviewRow => {
    const expected: PayloadCell[] = HEADERS.map((_, c) => (c === TOTAL ? 100 + exampleRow : `v${exampleRow}.${c}`));
    const actual = [...expected];
    if (!ok) actual[TOTAL] = 1;
    return { exampleRow, inputRow: exampleRow, ok, source: [], expected, actual, badColumns: ok ? [] : [TOTAL] };
  };
  const good = Array.from({ length: rows }, (_, i) => i + 2).filter((r) => !bad.includes(r) && !exceptions.includes(r));
  const total = rows - exceptions.length;
  return liveResult({
    verified: bad.length === 0 && !opts.partial,
    matched: total - bad.length,
    total,
    differences: bad.length,
    perColumn: HEADERS.map((header, c) => ({ header, inExample: c < width, matched: c === TOTAL ? total - bad.length : total, total })),
    mismatches: bad.map((exampleRow) => ({ exampleRow, column: 'Total', columnIndex: TOTAL, expected: 100 + exampleRow, actual: 1 })),
    mismatchCount: bad.length,
    preview: [...bad.map((r) => row(r, false)), ...good.map((r) => row(r, true))].slice(0, 50),
    partial: opts.partial ?? false,
    checkedInputRows: opts.partial ? 2000 : rows,
    totalInputRows: rows,
  });
}

interface Setup {
  rules?: LearnResult | Rules;
  lang?: 'en' | 'he';
  rows?: number;
  partial?: boolean;
  convert?: unknown;
  staticProblems?: unknown[];
  /** The worker has no example in memory (or the learn kept none). */
  noExample?: boolean;
}

async function openResult(setup: Setup = {}) {
  const rules = setup.rules ?? ordersRules();
  const liveCheck = vi.fn(async (_id: string, r: LearnResult | Rules, o?: { exceptions?: number[] }) => makeLive(r, o?.exceptions ?? [], { rows: setup.rows ?? ROWS, partial: setup.partial ?? false }));
  const fullCheck = vi.fn(async (_id: string, r: LearnResult | Rules, o?: { exceptions?: number[] }) => makeLive(r, o?.exceptions ?? [], { rows: setup.rows ?? ROWS }));
  const staticChecks = vi.fn(async () => setup.staticProblems ?? []);
  const convert = vi.fn(async () => setup.convert ?? undefined);
  const { engine } = fakeEngine(
    async () =>
      learnResult({ rules, exampleId: setup.noExample ? undefined : 'ex1', verification: { verified: true, matched: 3, total: 3, mismatches: [], layoutProblems: [], layoutIssues: [], repairProblems: [] } }) as LearnOutput,
    undefined,
    { liveCheck, fullCheck, staticChecks, convert },
  );
  const api = fakeApi();
  renderApp({ engine, api, lang: setup.lang ?? 'en' });

  const en = (setup.lang ?? 'en') === 'en';
  fireEvent.change(screen.getByLabelText(en ? 'Example input' : 'דוגמת קלט'), { target: { files: [csv('orders.csv')] } });
  fireEvent.change(screen.getByLabelText(en ? 'Example output' : 'דוגמת פלט'), { target: { files: [csv('Orders report.csv')] } });
  await waitFor(() => expect(screen.getAllByText(/1,204/)).toHaveLength(2));
  const learn = screen.getByRole('button', { name: en ? /Learn the format/ : /ללמוד את הפורמט/ }) as HTMLButtonElement;
  await act(async () => {
    fireEvent.click(learn);
  });
  await screen.findByTestId('rules-map');
  await waitFor(() => expect(setup.noExample ? staticChecks : liveCheck).toHaveBeenCalled());
  return { liveCheck, fullCheck, staticChecks, convert, api };
}

const line = (id: string): HTMLElement => {
  const el = document.querySelector(`[data-line-id="${id}"]`);
  if (!el) throw new Error(`no line ${id}: ${[...document.querySelectorAll('[data-line-id]')].map((e) => e.getAttribute('data-line-id')).join(', ')}`);
  return el as HTMLElement;
};
const openLine = (id: string): void => {
  fireEvent.click(within(line(id)).getAllByRole('button').find((b) => b.classList.contains('map-line__main'))!);
};
const strip = (): string => screen.getByTestId('live-check-text').textContent ?? '';
function renderWith(ui: ReactElement, lang: Lang = 'en') {
  return render(
    <I18nProvider initial={lang}>
      <MemoryRouter>{ui}</MemoryRouter>
    </I18nProvider>,
  );
}

const badge = (): string => screen.getByTestId('status-badge').textContent ?? '';
const columnOrder = (): string[] => [...document.querySelectorAll('[data-section="columns"] [data-line-id]')].map((e) => e.getAttribute('data-line-id')!);

// ---------------------------------------------------------------------------

describe('the rules map', () => {
  it('shows Rows, Columns, Layout and Checks, one line per output column in order, each with its status', async () => {
    await openResult();
    const headings = [...document.querySelectorAll('.map-section__title')].map((h) => h.textContent);
    expect(headings).toEqual(['Rows', 'Columns', 'Layout', 'Checks']);
    expect(columnOrder()).toEqual(HEADERS.map((h) => `col:${h}`));

    // A plain copy matches the example (teal check, named for assistive tech).
    expect(line('col:Item').getAttribute('data-status')).toBe('matches');
    expect(within(line('col:Item')).getByRole('img', { name: 'Matches your example' })).toBeTruthy();
    // A guessed rounding is "please check", with Keep and Change.
    const total = line('col:Total');
    expect(total.getAttribute('data-status')).toBe('check');
    expect(total.textContent).toContain(assumptionMessages.roundingGuessed.en);
    expect(within(total).getByRole('button', { name: 'Keep' })).toBeTruthy();
    expect(within(total).getByRole('button', { name: 'Change' })).toBeTruthy();
    // A column nothing fills needs your input, with the plain reason.
    const remarks = line('col:Remarks');
    expect(remarks.getAttribute('data-status')).toBe('needsInput');
    expect(remarks.textContent).toContain(unsupportedMessages.externalData.en);
    expect(within(remarks).getByRole('button', { name: 'Fill in' })).toBeTruthy();
    // The rows, layout and checks have their lines too.
    expect(line('filter:0').textContent).toContain('Keep rows where');
    expect(line('title:0')).toBeTruthy();
    expect(line('summary:end:0')).toBeTruthy();
    expect(line('check:0')).toBeTruthy();
  });

  it('the badge says how many columns need your input, and the header has the one primary button', async () => {
    await openResult();
    expect(badge()).toBe('1 column needs your input');
    const save = screen.getByRole('button', { name: 'Save format and download' });
    expect(save.classList.contains('btn--primary')).toBe(true);
    expect(document.querySelectorAll('.btn--primary')).toHaveLength(1);
    expect(screen.getByText('Solved on your computer')).toBeTruthy();
  });

  it('"Keep" dismisses the guess: the line goes back to matching', async () => {
    await openResult();
    fireEvent.click(within(line('col:Total')).getByRole('button', { name: 'Keep' }));
    await waitFor(() => expect(line('col:Total').getAttribute('data-status')).toBe('matches'));
    expect(within(line('col:Total')).queryByRole('button', { name: 'Keep' })).toBeNull();
  });

  it('per-column counts sit on the lines', async () => {
    await openResult();
    expect(within(line('col:Item')).getByText('30/30')).toBeTruthy();
  });

  it('fills in line by line at first (the one orchestrated moment), and only then', async () => {
    await openResult();
    expect(line('col:Item').classList.contains('map-line--intro')).toBe(true);
    expect(line('col:Remarks').style.getPropertyValue('--i')).not.toBe('');
    await waitFor(() => expect(line('col:Item').classList.contains('map-line--intro')).toBe(false), { timeout: 3000 });
  });

  it('adds a column (which then needs your input) and removes it again', async () => {
    await openResult();
    fireEvent.click(screen.getByRole('button', { name: 'Add a column' }));
    await waitFor(() => expect(line('col:New column')).toBeTruthy());
    expect(line('col:New column').getAttribute('data-status')).toBe('needsInput');
    expect(badge()).toBe('2 columns need your input');
    // The editor for it is open.
    expect(screen.getByRole('heading', { name: 'New column' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Remove this column' }));
    await waitFor(() => expect(document.querySelector('[data-line-id="col:New column"]')).toBeNull());
    expect(badge()).toBe('1 column needs your input');
  });

  it('reorders columns with the keyboard and by dragging', async () => {
    await openResult();
    const grip = (h: string): HTMLElement => within(line(`col:${h}`)).getByRole('button', { name: `Move ${h}` });
    fireEvent.keyDown(grip('Item'), { key: 'ArrowDown' });
    await waitFor(() => expect(columnOrder().slice(0, 2)).toEqual(['col:Supplier', 'col:Item']));

    // Drag Qty above Supplier.
    const target = line('col:Supplier');
    target.getBoundingClientRect = () => ({ top: 100, height: 40, bottom: 140, left: 0, right: 0, width: 0, x: 0, y: 100, toJSON: () => ({}) });
    const data = { setData: vi.fn(), effectAllowed: '', setDragImage: vi.fn() };
    // (happy-dom's drag events carry no pointer position, so it is given to them.)
    const drag = (type: 'dragOver' | 'drop'): void => {
      const event = createEvent[type](target, { dataTransfer: data });
      Object.defineProperty(event, 'clientY', { value: 105 });
      fireEvent(target, event);
    };
    fireEvent.dragStart(grip('Qty'), { dataTransfer: data });
    drag('dragOver');
    drag('drop');
    await waitFor(() => expect(columnOrder().slice(0, 3)).toEqual(['col:Qty', 'col:Supplier', 'col:Item']));
    // ...and the change is one undo step.
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(columnOrder().slice(0, 3)).toEqual(['col:Supplier', 'col:Item', 'col:Qty']));
  });
});

describe('the editor panel', () => {
  it('opens the right editor for the line that is clicked', async () => {
    await openResult();
    // No line chosen yet: the hint is there.
    expect(screen.getByText('Edit a rule')).toBeTruthy();

    openLine('col:Total');
    const panel = screen.getByRole('complementary', { name: 'Total' });
    expect(within(panel).getByText('How is it made?')).toBeTruthy();
    expect((within(panel).getByRole('radio', { name: 'Calculate' }) as HTMLInputElement).checked).toBe(true);
    expect(within(panel).getAllByRole('combobox').length).toBeGreaterThan(1);

    openLine('filter:0');
    expect(screen.getByRole('complementary', { name: 'Filter 1' })).toBeTruthy();
    expect(screen.getByText('Keep rows where')).toBeTruthy();
    expect((screen.getByLabelText('Condition') as HTMLSelectElement).value).toBe('ne');

    openLine('col:Supplier');
    expect((screen.getByRole('radio', { name: 'Translate values' }) as HTMLInputElement).checked).toBe(true);

    openLine('sort');
    expect(screen.getByRole('complementary', { name: 'Sort' })).toBeTruthy();
    openLine('title:0');
    expect(screen.getByRole('complementary', { name: 'Title row 1' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Insert month' })).toBeTruthy();
    openLine('summary:end:0');
    expect(screen.getByRole('complementary', { name: 'Summary row 1' })).toBeTruthy();
    openLine('check:0');
    expect(screen.getByRole('complementary', { name: 'Check 1' })).toBeTruthy();
    openLine('col:Item');
    expect((screen.getByRole('radio', { name: 'Copy a column' }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.getByText('Edit a rule')).toBeTruthy();
  });

  it('shows what the example has for a column that needs your input', async () => {
    await openResult();
    openLine('col:Remarks');
    const panel = screen.getByRole('complementary', { name: 'Remarks' });
    expect(within(panel).getByText('Your example shows:')).toBeTruthy();
    // The preview rows' example values for that column (position 6), deduplicated.
    expect(within(panel).getByText('v2.5')).toBeTruthy();
    expect(within(panel).getByText(unsupportedMessages.externalData.en)).toBeTruthy();
  });

  it('changing a calculation term calls the editor and re-runs the live check (debounced)', async () => {
    const { liveCheck } = await openResult();
    const calls = liveCheck.mock.calls.length;
    expect(strip()).toBe('Matches 30 of 30 rows in your example');

    openLine('col:Total');
    const terms = screen.getAllByRole('combobox', { name: /^Item \d$/ }) as HTMLSelectElement[];
    expect(terms.map((t) => t.value)).toEqual(['col:qty', 'col:price']);
    fireEvent.change(terms[1]!, { target: { value: 'col:qty' } }); // Qty × Qty

    // The rules changed: the line is "edited by you", and the check runs again with the new calculation.
    await waitFor(() => expect(liveCheck.mock.calls.length).toBeGreaterThan(calls));
    const lastRules = liveCheck.mock.calls.at(-1)![1] as Rules;
    expect(lastRules.transform.computed[0]!.expr).toMatchObject({ op: 'round', arg: { op: 'mul', args: [{ col: 'qty' }, { col: 'qty' }] } });
    await waitFor(() => expect(strip()).toBe('Matches 25 of 30 rows in your example'));
    expect(line('col:Total').getAttribute('data-status')).toBe('edited');
    expect(badge()).toBe('1 column needs your input'); // still: Remarks
    // The per-column count on the line and the amber cells in the grid.
    expect(within(line('col:Total')).getByText('25/30').getAttribute('data-differs')).toBe('true');
    expect(document.querySelectorAll('.pv__diff--rule')).toHaveLength(DIFFERING_ROWS.length);
  });

  it('a change that is not allowed says why, in plain words, and changes nothing', async () => {
    await openResult();
    openLine('col:Total');
    const before = screen.getByRole('radio', { name: 'Calculate' });
    // A text column is offered "read as a number"; Join text wants two columns: choosing it with one source left is fine.
    fireEvent.change(screen.getByLabelText('Column name'), { target: { value: 'Supplier' } });
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('There is already a column with this name.');
    expect(line('col:Total')).toBeTruthy();
    expect((before as HTMLInputElement).checked).toBe(true);
  });

  it('renaming a column follows the line', async () => {
    await openResult();
    openLine('col:Total');
    fireEvent.change(screen.getByLabelText('Column name'), { target: { value: 'Grand total' } });
    await waitFor(() => expect(line('col:Grand total').getAttribute('data-status')).toBe('edited'));
    expect(screen.getByRole('complementary', { name: 'Grand total' })).toBeTruthy();
    // The summary row that named it follows the rename.
    expect(line('summary:end:0').textContent).toContain('Grand total');
  });

  it('Advanced shows the rules as text (formulas as text), checks them when applied, and says what is wrong', async () => {
    await openResult();
    fireEvent.click(screen.getAllByRole('button', { name: 'Advanced' })[0]!);
    const box = (await screen.findByLabelText('Rules (JSON)')) as HTMLTextAreaElement;
    const text = box.value;
    expect(text).toContain('round(qty * price, 2)');
    fireEvent.change(box, { target: { value: '{ not json' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect((await screen.findByRole('alert')).textContent).toContain('This is not valid JSON.');
    // A valid change is applied.
    fireEvent.change(box, { target: { value: text.replace('"sheetName": "Orders"', '"sheetName": "Orders 2"') } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(screen.getByText('Applied.')).toBeTruthy());
    expect(screen.queryByRole('alert')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    await waitFor(() => expect(screen.getByText('Edit a rule')).toBeTruthy());
    expect(line('file').textContent).toContain('Orders 2');
  });
});

describe('the format-change note (SPEC 8.12)', () => {
  it('is worded for several sources and for one', () => {
    const many = renderWith(<FormatChange sourceCount={3} />);
    expect(many.container.textContent).toContain('This changes the format for all 3 sources.');
    many.unmount();
    expect(renderWith(<FormatChange sourceCount={1} />).container.textContent).toContain('This changes the format for its source.');
  });
});

describe('one-off exceptions', () => {
  async function withDifferences() {
    const ctx = await openResult();
    openLine('col:Total');
    const terms = screen.getAllByRole('combobox', { name: /^Item \d$/ }) as HTMLSelectElement[];
    fireEvent.change(terms[1]!, { target: { value: 'col:qty' } });
    await waitFor(() => expect(strip()).toBe('Matches 25 of 30 rows in your example'));
    return ctx;
  }

  it('shows mismatching rows first, each as "your example" and "this rule", with the differing cell in amber', async () => {
    await withDifferences();
    const first = document.querySelector('tr.pv__note') as HTMLElement;
    expect(first.getAttribute('data-row')).toBe('3');
    expect(first.textContent).toContain('Row 3 differs in:');
    expect(within(first).getByRole('button', { name: 'This row was fixed by hand' })).toBeTruthy();
    const rows = [...document.querySelectorAll('.pv tbody tr')];
    // note, example, rule, then the next mismatch...
    expect(rows[1]!.textContent).toContain('Your example');
    expect(rows[2]!.textContent).toContain('This rule');
    expect(rows[2]!.querySelectorAll('.pv__diff').length).toBe(1);
  });

  it('marking a row excludes it from the count; "Count it again" (or undo) brings it back', async () => {
    await withDifferences();
    fireEvent.click(within(document.querySelector('tr.pv__note[data-row="3"]') as HTMLElement).getByRole('button', { name: 'This row was fixed by hand' }));
    await waitFor(() => expect(strip()).toBe('Matches 25 of 29 rows in your example'));
    expect(badge()).toBe('1 column needs your input');
    const list = screen.getByTestId('exceptions');
    expect(list.textContent).toContain('1 row is counted as fixed by hand');
    expect(list.textContent).toContain('Row 3');
    expect(document.querySelector('tr.pv__note[data-row="3"]')).toBeNull();

    fireEvent.click(within(list).getByRole('button', { name: 'Count it again' }));
    await waitFor(() => expect(strip()).toBe('Matches 25 of 30 rows in your example'));
    expect(screen.queryByTestId('exceptions')).toBeNull();

    // Mark two, then undo one step.
    fireEvent.click(within(document.querySelector('tr.pv__note[data-row="3"]') as HTMLElement).getByRole('button', { name: 'This row was fixed by hand' }));
    await waitFor(() => screen.getByTestId('exceptions'));
    fireEvent.click(within(document.querySelector('tr.pv__note[data-row="4"]') as HTMLElement).getByRole('button', { name: 'This row was fixed by hand' }));
    await waitFor(() => expect(screen.getByTestId('exceptions').textContent).toContain('2 rows are counted as fixed by hand'));
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(screen.getByTestId('exceptions').textContent).toContain('1 row is counted as fixed by hand'));
  });

  it('the live check is told about the exceptions (and only the check: the rules are untouched)', async () => {
    const { liveCheck } = await withDifferences();
    fireEvent.click(within(document.querySelector('tr.pv__note[data-row="5"]') as HTMLElement).getByRole('button', { name: 'This row was fixed by hand' }));
    await waitFor(() => expect(liveCheck.mock.calls.at(-1)![2]).toMatchObject({ exceptions: [5] }));
  });
});

describe('the live check strip', () => {
  it('says how many rows match, and only says "sample" with an Apply button when the check saw a subset', async () => {
    const { fullCheck } = await openResult({ partial: true, rows: 9000 });
    await waitFor(() => expect(strip()).toBe('Checking a 2,000-row sample. Apply to check all rows.'));
    fireEvent.click(within(screen.getByRole('region', { name: 'Check against your example' })).getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(fullCheck).toHaveBeenCalled());
    await waitFor(() => expect(strip()).toBe('Matches 9,000 of 9,000 rows in your example'));
  });

  it('without an example only the static checks run, and it says so', async () => {
    const { liveCheck, staticChecks } = await openResult({ noExample: true });
    await waitFor(() => expect(strip()).toContain("Your example isn't in memory any more"));
    expect(liveCheck).not.toHaveBeenCalled();
    expect(staticChecks).toHaveBeenCalled();
    expect(badge()).toBe('1 column needs your input');
    expect(screen.queryByText('Sign in to see and download all 30 rows')).toBeNull();
  });

  it('shows static-check problems in words and blocks saving', async () => {
    await openResult({ staticProblems: [{ layer: 'references', kind: 'reference', path: 'transform.sort[0].column', message: 'unknown column id "ghost"' }] });
    await waitFor(() => expect(badge()).toBe('1 problem to fix'));
    expect(screen.getByText('Fix these before you save:')).toBeTruthy();
    expect(screen.getByText('Sort uses a column ("ghost") that does not exist.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Save format and download' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('the free tier', () => {
  it('shows 20 rows, and "Sign in to see and download all N rows" opens the sign-in wall', async () => {
    await openResult({ rows: 45 });
    await waitFor(() => expect(document.querySelectorAll('.pv tbody tr.pv__row')).toHaveLength(tiers.anonymous.previewRows!));
    const more = screen.getByRole('button', { name: 'Sign in to see and download all 45 rows' });
    fireEvent.click(more);
    const dialog = await screen.findByRole('dialog', { name: 'Sign in' });
    expect(dialog.textContent).toContain("Sign in to save this format and reuse it on next month's file.");
    expect(await within(dialog).findByText('Continue with Google')).toBeTruthy();
    expect(within(dialog).getByText('Continue with Microsoft')).toBeTruthy();
  });

  it('"Save format and download" opens the sign-in wall and keeps the learned rules (and edits) meanwhile', async () => {
    await openResult();
    openLine('col:Total');
    fireEvent.change(screen.getByLabelText('Column name'), { target: { value: 'Grand total' } });
    await waitFor(() => line('col:Grand total'));
    fireEvent.click(screen.getByRole('button', { name: 'Save format and download' }));
    const dialog = await screen.findByRole('dialog', { name: 'Sign in' });
    expect(dialog.textContent).toContain('What you have learned survives signing in');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(line('col:Grand total')).toBeTruthy();
    expect(screen.getByText(`Free: ${tiers.anonymous.previewRows} rows on screen. Sign in to save and download.`)).toBeTruthy();
  });

  it('keeps the edits in the session, so leaving the screen and coming back finds them', () => {
    const result = learnResult({ rules: ordersRules() }) as LearnOutput;
    const a = getResultSession(result, 'Orders');
    a.store.apply({ type: 'setColumnHeader', index: 0, header: 'SKU' });
    const b = getResultSession(result, 'Other name');
    expect(b).toBe(a);
    expect(b.store.getState().rules.output.columns[0]!.header).toBe('SKU');
    expect(b.name).toBe('Orders');
  });

  it('the format name starts as the example output file name, and can be renamed in place', async () => {
    await openResult();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Orders report');
    fireEvent.click(screen.getByRole('button', { name: 'Rename Orders report' }));
    const input = screen.getByLabelText('Format name') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'Monthly orders' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Monthly orders');
  });
});

describe('flagged cells and suggestions (SPEC 8.9)', () => {
  const flags: Flag[] = [
    { rowNumber: 4, column: 'qty', rule: 'type', value: '7O', messageKey: 'flag.parseFailed.integer' },
    { rowNumber: 5, column: 'shipped', rule: 'type', value: '31/02/2024', messageKey: 'flag.parseFailed.date', suggestion: '02/03/2024' },
  ];
  const convert = {
    ok: true,
    bytes: new ArrayBuffer(0),
    flags,
    summary: { rowsIn: 30, rowsOut: 29, rowsFiltered: 1, duplicatesRemoved: [], duplicatesFlagged: 0, blockedRows: [] },
    preview: { name: 'x', direction: 'ltr', language: 'en', columns: [], rows: [], merges: [] },
    totalRows: 29,
  };

  it('shows a flag in the grid (amber, with the message) and in the list, and accepts or rejects a suggestion', async () => {
    await openResult({ convert });
    await waitFor(() => expect(screen.getByTestId('flags').textContent).toContain('Rows to check (2)'), { timeout: 3000 });
    expect(screen.getByTestId('run-summary').textContent).toContain('Your input has 30 rows. The result has 29.');
    expect(screen.getByTestId('run-summary').textContent).toContain('1 were left out by your filters.');
    const flagged = document.querySelector('td[data-flag="true"]') as HTMLElement;
    expect(flagged.className).toContain('pv__flag');
    expect(flagged.getAttribute('title')).toBe("This isn't a whole number. We kept it as it is.");

    const item = screen.getByTestId('flags').querySelectorAll('li.flag')[1] as HTMLElement;
    expect(item.textContent).toContain("This isn't a date we can read.");
    expect(item.textContent).toContain('Suggested:');
    fireEvent.click(within(item).getByRole('button', { name: 'Accept' }));
    expect(item.getAttribute('data-decision')).toBe('accepted');
    expect(within(item).getByText('Accepted')).toBeTruthy();
    fireEvent.click(within(item).getByRole('button', { name: 'Undo' }));
    fireEvent.click(within(item).getByRole('button', { name: 'Reject' }));
    expect(item.getAttribute('data-decision')).toBe('rejected');
    // A flag with nothing mechanical to suggest has no buttons.
    const plain = screen.getByTestId('flags').querySelectorAll('li.flag')[0] as HTMLElement;
    expect(within(plain).queryByRole('button')).toBeNull();
  });
});

describe('direction (SPEC 16.2)', () => {
  const hebrewSheet = (): Rules => {
    const r = ordersRules();
    return { ...r, output: { ...r.output, direction: 'rtl', language: 'he' } };
  };

  it('a Hebrew sheet previews right-to-left inside the English UI, with every value in <bdi>', async () => {
    await openResult({ rules: hebrewSheet() });
    await waitFor(() => screen.getByTestId('preview-table'));
    expect(screen.getByTestId('app').getAttribute('dir')).toBe('ltr');
    const sheet = screen.getByTestId('preview-table').closest('[data-sheet-direction]') as HTMLElement;
    expect(sheet.getAttribute('data-sheet-direction')).toBe('rtl');
    expect(sheet.getAttribute('dir')).toBe('rtl');
    const cells = [...screen.getByTestId('preview-table').querySelectorAll('tbody td')].filter((td) => td.textContent !== '');
    expect(cells.length).toBeGreaterThan(0);
    for (const td of cells) expect(td.querySelector('bdi'), td.outerHTML).not.toBeNull();
  });

  it('the Hebrew UI mirrors the screen, says everything in Hebrew, and an English sheet stays left-to-right', async () => {
    await openResult({ lang: 'he' });
    expect(screen.getByTestId('app').getAttribute('dir')).toBe('rtl');
    expect(document.documentElement.dir).toBe('rtl');
    expect(screen.getByRole('button', { name: 'שמירת הפורמט והורדה' })).toBeTruthy();
    expect(badge()).toBe('עמודה אחת דורשת מידע מכם');
    expect([...document.querySelectorAll('.map-section__title')].map((h) => h.textContent)).toEqual(['שורות', 'עמודות', 'פריסה', 'בדיקות']);
    expect(strip()).toBe('תואם ל-30 מתוך 30 שורות בדוגמה שלכם');
    // The sentence's names keep their own direction, and the sheet (English) keeps its own.
    expect(line('col:Total').querySelector('bdi')).not.toBeNull();
    const sheet = screen.getByTestId('preview-table').closest('[data-sheet-direction]') as HTMLElement;
    expect(sheet.getAttribute('data-sheet-direction')).toBe('ltr');
    openLine('col:Total');
    expect(screen.getByText('איך היא נבנית?')).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'חישוב' })).toBeTruthy();
  });
});

describe('every string the screen builds from a code exists in both languages', () => {
  const families: Record<string, string[]> = {
    'editor.check.rule.': ['required', 'range', 'lengthEquals', 'oneOf', 'unique', 'dateRange', 'israeliIdChecksum'],
    'editor.file.encoding.': ['utf8bom', 'utf8', 'windows1255'],
    'editor.file.quote.': ['minimal', 'all', 'none'],
    'editor.file.type.': ['xlsx', 'csv', 'txt'],
    'editor.file.delimiter.': ['tab', 'comma', 'semicolon', 'pipe'],
    'editor.filter.op.': ['eq', 'ne', 'oneOf', 'notOneOf', 'isEmpty', 'notEmpty', 'gt', 'gte', 'lt', 'lte'],
    'editor.summary.agg.': ['sum', 'count', 'min', 'max', 'average', 'first', 'last'],
    'editor.type.': ['text', 'integer', 'decimal', 'currency', 'percent', 'date', 'boolean', 'idLike'],
    'map.empty.': ['rows', 'columns', 'layout', 'checks', 'functions'],
    'check.layout.': ['runFailed', 'unalignedRows', 'rowCount', 'fileSettings', 'titleRow', 'headerRow', 'blankRow', 'summaryRow'],
    'problem.': ['unknownColumn', 'noSuchItem', 'emptyHeader', 'duplicateHeader', 'typeMismatch', 'tooManyTerms', 'tooFewTerms', 'badOperators', 'badValue', 'duplicateKey', 'noGroup', 'formula', 'json', 'schema', 'reference', 'rule'],
  };
  it('has them', () => {
    for (const [prefix, codes] of Object.entries(families)) {
      for (const code of codes) {
        const key = `${prefix}${code}` as MessageKey;
        expect(en[key], `en ${key}`).toBeTruthy();
        expect(he[key], `he ${key}`).toBeTruthy();
      }
    }
  });
});
