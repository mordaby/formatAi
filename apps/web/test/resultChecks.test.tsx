// The result screen's live check, told plainly (SPEC 8.11 "Live check", "Saving"):
//  - where the rules don't reproduce the example, per column: "N rows in your example don't match this rule (rows 12, 57, ...)", or
//    "The rule for X doesn't reproduce your example yet" for a column that mostly fails, each with "Fix the rule";
//  - after an edit: "Applied · now matches X of Y rows" on the changed line, the counter highlighting, "Unsaved changes" next to Save,
//    a question before leaving with them, and "Check all rows" when the check only saw a sample.
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resumeLeaveGuard, suspendLeaveGuard } from '../src/app/unloadPrompt';
import { editorConfig } from '../src/editor';
import { ordersRules } from '../src/editor/testkit';
import { en, he, type Lang } from '../src/i18n';
import { columnMismatches } from '../src/pages/Result/helpers';
import { PreviewGrid } from '../src/pages/Result/PreviewGrid';
import type { CellMismatch, PreviewRow } from '../src/worker/editorApi';
import { conversionSummary, createFormatResponse, formatSummary } from './helpers/registryKit';
import { fakeApi, liveResult, USER } from './helpers/renderApp';
import { HEADERS, line, openLine, openResult, renderWith, setDiffering, strip } from './helpers/resultKit';

const { downloaded } = vi.hoisted(() => ({ downloaded: vi.fn() }));
vi.mock('../src/flow/download', async (orig) => ({ ...(await orig<typeof import('../src/flow/download')>()), downloadBytes: downloaded }));

beforeEach(() => {
  document.cookie = 'lang=; Path=/; Max-Age=0';
  setDiffering();
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  resumeLeaveGuard();
  document.cookie = 'lang=; Path=/; Max-Age=0';
  document.documentElement.lang = '';
  document.documentElement.dir = '';
});

const flag = (): string => screen.getByTestId('unsaved-changes').textContent ?? '';
const noteOf = (row: number): HTMLElement => document.querySelector(`tr.pv__note[data-row="${row}"]`) as HTMLElement;
const checkRegion = (): HTMLElement => screen.getByRole('region', { name: 'Check against your example' });
const lineNotice = (id: string): HTMLElement | null => line(id).querySelector('[data-testid="column-mismatch"]');
const issues = (): HTMLElement => screen.getByTestId('column-issues');

/** Changes the Total calculation to Qty × Qty: the fake worker then reports the rows set with `setDiffering` as different in Total. */
function changeTotal(lang: Lang = 'en'): void {
  openLine('col:Total');
  const term = (lang === 'he' ? he : en)['editor.col.calcTerm'].replace('{n}', '\\d');
  const terms = screen.getAllByRole('combobox', { name: new RegExp(`^${term}$`) }) as HTMLSelectElement[];
  fireEvent.change(terms[1]!, { target: { value: 'col:qty' } });
}

/** A few rows differ in a column that otherwise matches (Total: 28 of 30, 93%). */
async function withOutliers(rows = [3, 4], setup: Parameters<typeof openResult>[0] = {}) {
  setDiffering(rows);
  const ctx = await openResult(setup);
  changeTotal(setup.lang);
  const [matched, total] = [(setup.rows ?? 30) - rows.length, setup.rows ?? 30];
  await waitFor(() => expect(strip()).toBe(setup.lang === 'he' ? `תואם ל-${matched} מתוך ${total} שורות בדוגמה שלכם` : `Matches ${matched} of ${total} rows in your example`));
  return ctx;
}

// ---------------------------------------------------------------------------

describe('where the rules do not reproduce the example', () => {
  it('a column that mostly matches says how many rows do not, and which, on its line and above the preview, with "Fix the rule"', async () => {
    await withOutliers();
    // On the column's line (which is still "edited by you").
    const notice = lineNotice('col:Total')!;
    expect(notice.textContent).toContain("2 rows in your example don't match this rule (rows 3, 4)");
    expect(notice.getAttribute('data-mismatch')).toBe('some');
    expect(line('col:Total').getAttribute('data-status')).toBe('edited');
    // Above the preview, with the column's name.
    const item = within(issues()).getByRole('listitem');
    expect(item.textContent).toContain("Total: 2 rows in your example don't match this rule (rows 3, 4)");
    expect(within(issues()).getAllByRole('listitem')).toHaveLength(1);
    // The cells stay amber in the preview, mismatching rows first.
    expect(document.querySelectorAll('.pv__diff--rule')).toHaveLength(2);
    expect(document.querySelector('tr.pv__note')!.getAttribute('data-row')).toBe('3');
    expect(noteOf(3).textContent).toContain('Row 3 differs in: Total');
    // Columns that match say nothing.
    expect(lineNotice('col:Item')).toBeNull();

    // "Fix the rule" opens that column's editor - from the line, and from the preview.
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.getByText('Edit a rule')).toBeTruthy();
    fireEvent.click(within(lineNotice('col:Total')!).getByRole('button', { name: 'Fix the rule for Total' }));
    expect(screen.getByRole('complementary', { name: 'Total' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    fireEvent.click(within(within(issues()).getByRole('listitem')).getByRole('button', { name: 'Fix the rule for Total' }));
    expect(screen.getByRole('complementary', { name: 'Total' })).toBeTruthy();

    // Fixed (here: undone): the notices go, and everything matches.
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(strip()).toBe('Matches 30 of 30 rows in your example'));
    expect(screen.queryByTestId('column-issues')).toBeNull();
    expect(lineNotice('col:Total')).toBeNull();
  });

  it('says one row in the singular, and lists only the first few rows of a longer list', async () => {
    await withOutliers([3]);
    expect(lineNotice('col:Total')!.textContent).toContain("1 row in your example doesn't match this rule (row 3)");
    cleanup();

    setDiffering([3, 5, 8, 13, 21, 34, 55]);
    await openResult({ rows: 100 });
    changeTotal();
    await waitFor(() => expect(strip()).toBe('Matches 93 of 100 rows in your example'));
    expect(editorConfig.mismatchRowsShown).toBe(5);
    expect(lineNotice('col:Total')!.textContent).toContain("7 rows in your example don't match this rule (rows 3, 5, 8, 13, 21, …)");
  });

  it('a column that mostly fails says the rule does not reproduce the example (no list of rows), with "Fix the rule"', async () => {
    await openResult(); // 5 of 30 rows differ once Total is changed: Total matches 25 of 30 = 83%
    changeTotal();
    await waitFor(() => expect(strip()).toBe('Matches 25 of 30 rows in your example'));

    const notice = lineNotice('col:Total')!;
    expect(notice.getAttribute('data-mismatch')).toBe('failing');
    expect(notice.textContent).toContain("The rule for Total doesn't reproduce your example yet.");
    expect(notice.textContent).not.toContain('rows 3');
    const item = within(issues()).getByRole('listitem');
    expect(item.getAttribute('data-failing')).toBe('true');
    expect(item.textContent).toContain("The rule for Total doesn't reproduce your example yet.");
    // (The rows are still listed in the preview, their cells amber.)
    expect(document.querySelectorAll('tr.pv__note[data-mismatch]')).toHaveLength(5);
    expect(document.querySelectorAll('.pv__diff--rule')).toHaveLength(5);

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    fireEvent.click(within(within(issues()).getByRole('listitem')).getByRole('button', { name: 'Fix the rule for Total' }));
    expect(screen.getByRole('complementary', { name: 'Total' })).toBeTruthy();
  });

  it('90% of a column matching is still "N rows do not match"; below it is "does not reproduce your example yet"', async () => {
    expect(editorConfig.mostlyFailsBelow).toBe(0.9);
    await withOutliers([3, 4, 5]); // Total 27 of 30: exactly 90%
    expect(lineNotice('col:Total')!.getAttribute('data-mismatch')).toBe('some');
    expect(lineNotice('col:Total')!.textContent).toContain("3 rows in your example don't match this rule (rows 3, 4, 5)");
    cleanup();

    setDiffering([3, 4, 5, 6]);
    await openResult();
    changeTotal();
    await waitFor(() => expect(strip()).toBe('Matches 26 of 30 rows in your example')); // 86.7%
    expect(lineNotice('col:Total')!.getAttribute('data-mismatch')).toBe('failing');
  });

  it('does not offer to mark rows as changed by hand any more: nothing of it is on the screen', async () => {
    await withOutliers();
    expect(screen.queryByRole('button', { name: /by hand/i })).toBeNull();
    expect(screen.queryByRole('button', { name: 'What does this mean?' })).toBeNull();
    expect(screen.queryByTestId('exceptions')).toBeNull();
    expect(document.body.textContent).not.toMatch(/by hand|fixed by hand|not counted/i);
    // ...and the counter counts every row.
    expect(strip()).toBe('Matches 28 of 30 rows in your example');
  });

  it('is worded in Hebrew', async () => {
    await withOutliers([3, 4], { lang: 'he' });
    expect(lineNotice('col:Total')!.textContent).toContain('2 שורות בדוגמה שלכם לא תואמות לכלל הזה (שורות 3, 4)');
    expect(within(issues()).getByRole('listitem').textContent).toContain('Total: 2 שורות בדוגמה שלכם לא תואמות לכלל הזה (שורות 3, 4)');
    expect(within(issues()).getByRole('button', { name: 'תיקון הכלל של Total' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /ידנית/ })).toBeNull();
    cleanup();

    setDiffering();
    await openResult({ lang: 'he' });
    changeTotal('he');
    await waitFor(() => expect(strip()).toBe('תואם ל-25 מתוך 30 שורות בדוגמה שלכם'));
    expect(lineNotice('col:Total')!.textContent).toContain('הכלל של Total עדיין לא משחזר את הדוגמה שלכם.');
  });
});

describe('the per-column notices (the pure part, and the grid on its own)', () => {
  const HEAD = HEADERS as readonly string[];
  const mismatch = (exampleRow: number, columnIndex: number): CellMismatch => ({ exampleRow, column: HEAD[columnIndex]!, columnIndex, expected: 'a', actual: 'b' });
  const row = (exampleRow: number, badColumns: number[]): PreviewRow => ({
    exampleRow,
    inputRow: exampleRow,
    ok: badColumns.length === 0,
    source: [],
    expected: HEAD.map((_, c) => `e${exampleRow}.${c}`),
    actual: HEAD.map((_, c) => (badColumns.includes(c) ? 'x' : `e${exampleRow}.${c}`)),
    badColumns,
  });
  /** 20 rows: column 0 matches `matched0` of them, column 1 only 4; the others all. */
  const check = (matched0: number, extra: Partial<Parameters<typeof liveResult>[0]> = {}) =>
    liveResult({
      verified: false,
      matched: 3,
      total: 20,
      differences: 17,
      perColumn: HEAD.map((header, c) => ({ header, inExample: true, matched: c === 0 ? matched0 : c === 1 ? 4 : 20, total: 20 })),
      mismatches: [mismatch(9, 0), mismatch(2, 0), mismatch(4, 1), mismatch(5, 1)],
      preview: [row(2, [0]), row(4, [1]), row(9, [0])],
      partial: false,
      ...extra,
    });

  it('columnMismatches: one entry per column that does not fully match, rows sorted, cut at the config, "failing" under the threshold', () => {
    const rules = ordersRules();
    const all = columnMismatches(check(18), rules);
    expect(all.map((m) => [m.header, m.count, m.rows, m.more, m.failing])).toEqual([
      [HEAD[0], 2, [2, 9], false, false],
      [HEAD[1], 16, [4, 5], true, true],
    ]);
    expect(columnMismatches(check(20), rules).map((m) => m.header)).toEqual([HEAD[1]]);
    // A column whose cells are listed by name only (the check could not tell its position).
    const byName = check(18, { mismatches: [{ ...mismatch(7, 0), columnIndex: -1 }] });
    expect(columnMismatches(byName, rules)[0]!.rows).toEqual([7]);
    // Nothing to say without a check, for a column the rules do not have, or for one with nothing counted.
    expect(columnMismatches(null, rules)).toEqual([]);
    const extra = check(18, { perColumn: [...check(18).perColumn, { header: 'Not in the rules', inExample: true, matched: 0, total: 20 }] });
    expect(columnMismatches(extra, rules).map((m) => m.header)).not.toContain('Not in the rules');
    const nothing = check(18, { perColumn: check(18).perColumn.map((c) => ({ ...c, matched: 0, total: 0 })) });
    expect(columnMismatches(nothing, rules)).toEqual([]);
    // More rows than listed: the first few, then "more".
    const many = check(1, { mismatches: Array.from({ length: 19 }, (_, i) => mismatch(30 - i, 0)) });
    const m0 = columnMismatches(many, rules)[0]!;
    expect(m0.rows).toEqual([12, 13, 14, 15, 16]);
    expect(m0.count).toBe(19);
    expect(m0.more).toBe(true);
  });

  function grid(matched0: number, lang: Lang = 'en') {
    const onFixRule = vi.fn();
    renderWith(<PreviewGrid live={check(matched0)} rules={ordersRules()} flags={[]} limit={null} uiDir={lang === 'he' ? 'rtl' : 'ltr'} onFixRule={onFixRule} onSignIn={vi.fn()} />, lang);
    return { onFixRule };
  }

  it('lists a notice per column above the table, each with its own "Fix the rule"; the rows stay in the table without an offer', () => {
    const { onFixRule } = grid(18);
    const list = within(issues()).getAllByRole('listitem');
    expect(list).toHaveLength(2);
    expect(list[0]!.textContent).toContain(`${HEAD[0]}: 2 rows in your example don't match this rule (rows 2, 9)`);
    expect(list[1]!.textContent).toContain(`The rule for ${HEAD[1]} doesn't reproduce your example yet.`);
    fireEvent.click(within(list[1]!).getByRole('button', { name: `Fix the rule for ${HEAD[1]}` }));
    expect(onFixRule).toHaveBeenCalledWith(HEAD[1]);
    fireEvent.click(within(list[0]!).getByRole('button', { name: `Fix the rule for ${HEAD[0]}` }));
    expect(onFixRule).toHaveBeenLastCalledWith(HEAD[0]);
    // Every mismatching row is still in the table, its cells amber; no button but the two above (and the "Show what your example has"
    // toggle: the example's last column has no rule yet).
    expect(document.querySelectorAll('tr.pv__note[data-mismatch]')).toHaveLength(3);
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual([expect.stringContaining('Fix the rule'), expect.stringContaining('Fix the rule'), 'Show what your example has']);
  });

  it('a column at 90% is not "failing"; one just under is', () => {
    grid(18); // 90%
    expect(within(issues()).getAllByRole('listitem')[0]!.getAttribute('data-failing')).toBeNull();
    cleanup();
    grid(17); // 85%
    expect(within(issues()).getAllByRole('listitem')[0]!.getAttribute('data-failing')).toBe('true');
  });

  it('says it in Hebrew', () => {
    grid(18, 'he');
    const list = within(issues()).getAllByRole('listitem');
    expect(list[0]!.textContent).toContain(`${HEAD[0]}: 2 שורות בדוגמה שלכם לא תואמות לכלל הזה (שורות 2, 9)`);
    expect(list[1]!.textContent).toContain(`הכלל של ${HEAD[1]} עדיין לא משחזר את הדוגמה שלכם.`);
    expect(screen.getByRole('button', { name: `תיקון הכלל של ${HEAD[1]}` })).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------

describe('after an edit', () => {
  it('the changed line says "Applied · now matches X of Y rows" (with the pencil), the counter highlights, and both settle', async () => {
    await openResult();
    expect(checkRegion().hasAttribute('data-changed')).toBe(false);
    changeTotal();
    await waitFor(() => expect(strip()).toBe('Matches 25 of 30 rows in your example'));

    const total = line('col:Total');
    const applied = await within(total).findByTestId('applied');
    expect(applied.textContent).toBe('Applied · now matches 25 of 30 rows');
    // The pencil: edited by you.
    expect(total.getAttribute('data-status')).toBe('edited');
    expect(within(total).getByRole('img', { name: 'Edited by you' })).toBeTruthy();
    // Only the line that was edited says it.
    expect(screen.getAllByTestId('applied')).toHaveLength(1);
    // The counter is highlighted for a moment because its number changed.
    await waitFor(() => expect(checkRegion().hasAttribute('data-changed')).toBe(true));
    await waitFor(() => expect(checkRegion().hasAttribute('data-changed')).toBe(false), { timeout: 3000 });
    // The confirmation fades after a few seconds, then is gone.
    await waitFor(() => expect(within(line('col:Total')).getByTestId('applied').getAttribute('data-fading')).toBe('true'), { timeout: 6000 });
    await waitFor(() => expect(within(line('col:Total')).queryByTestId('applied')).toBeNull(), { timeout: 3000 });
    // (The counter still says the same, and the pencil stays.)
    expect(strip()).toBe('Matches 25 of 30 rows in your example');
    expect(line('col:Total').getAttribute('data-status')).toBe('edited');
  }, 20_000);

  it('a rename says it too, and a change that does not change the counter still confirms', async () => {
    await openResult();
    openLine('col:Total');
    fireEvent.change(screen.getByLabelText('Column name'), { target: { value: 'Grand total' } });
    const applied = await within(await waitFor(() => line('col:Grand total'))).findByTestId('applied');
    expect(applied.textContent).toBe('Applied · now matches 30 of 30 rows');
    expect(checkRegion().hasAttribute('data-changed')).toBe(false); // 30 of 30 before and after
  });

  it('with no example to compare with it says so', async () => {
    await openResult({ noExample: true });
    openLine('col:Total');
    fireEvent.change(screen.getByLabelText('Column name'), { target: { value: 'Grand total' } });
    const applied = await within(await waitFor(() => line('col:Grand total'))).findByTestId('applied');
    expect(applied.textContent).toBe('Applied · no example to compare with');
  });

  it('is worded in Hebrew', async () => {
    await openResult({ lang: 'he' });
    changeTotal('he');
    await waitFor(() => expect(strip()).toBe('תואם ל-25 מתוך 30 שורות בדוגמה שלכם'));
    expect((await within(line('col:Total')).findByTestId('applied')).textContent).toBe('הוחל · עכשיו תואם ל-25 מתוך 30 שורות');
    expect(flag()).toBe('שינויים שלא נשמרו');
  });
});

describe('unsaved changes', () => {
  const SUMMARY = { rowsIn: 30, rowsOut: 30, rowsFiltered: 0, duplicatesRemoved: [], duplicatesFlagged: 0, blockedRows: [] };
  const converted = { ok: true, bytes: new ArrayBuffer(8), flags: [], summary: SUMMARY, preview: { name: 'Out', direction: 'ltr', language: 'en', columns: [], rows: [], merges: [] }, totalRows: 30 };
  const created = createFormatResponse({ format: formatSummary({ id: 'F1', name: 'Orders report' }), conversion: conversionSummary({ id: 'C1', formatId: 'F1' }) });

  const rename = async (to = 'Grand total'): Promise<void> => {
    openLine('col:Total');
    fireEvent.change(screen.getByLabelText('Column name'), { target: { value: to } });
    await waitFor(() => line(`col:${to}`));
  };

  it('appears next to Save after an edit and goes when the edit is undone; the button keeps its name and stays the one primary', async () => {
    await openResult();
    expect(flag()).toBe('');
    await rename();
    await waitFor(() => expect(flag()).toBe('Unsaved changes'));
    expect(document.querySelectorAll('.btn--primary')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Save format and download' }).classList.contains('btn--primary')).toBe(true);
    // Next to the button: in the same header, before it.
    const save = screen.getByRole('button', { name: 'Save format and download' });
    expect(screen.getByTestId('unsaved-changes').parentElement).toBe(save.closest('.result-head__actions'));
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(flag()).toBe(''));
  });

  it('clears once the format is saved', async () => {
    const createFormat = vi.fn(async () => created);
    const { convert } = await openResult({ api: fakeApi({ user: USER, registry: { createFormat } }), convert: converted });
    await rename();
    await waitFor(() => expect(flag()).toBe('Unsaved changes'));
    await waitFor(() => expect((screen.getByRole('button', { name: 'Save format and download' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'Save format and download' }));
    await waitFor(() => expect(createFormat).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/^Saved\. "Orders report" is in My formats/)).toBeTruthy();
    expect(flag()).toBe('');
    expect(convert).toHaveBeenCalled();
    // Nothing is asked when the tab closes any more.
    expect(closeTab()).toBe(false);
  });

  it('closing the tab asks the browser to confirm while there is something unsaved (not for the sign-in trip, which keeps it)', async () => {
    await openResult();
    expect(closeTab()).toBe(false);
    await rename();
    await waitFor(() => expect(flag()).toBe('Unsaved changes'));
    expect(closeTab()).toBe(true);
    suspendLeaveGuard();
    expect(closeTab()).toBe(false);
    resumeLeaveGuard();
    expect(closeTab()).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(flag()).toBe(''));
    expect(closeTab()).toBe(false);
  });
});

/** The browser's "Leave site?" question: true when the page asked for it. */
function closeTab(): boolean {
  const event = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}

describe('leaving the screen with unsaved changes', () => {
  const rename = async (): Promise<void> => {
    openLine('col:Total');
    fireEvent.change(screen.getByLabelText('Column name'), { target: { value: 'Grand total' } });
    await waitFor(() => expect(flag()).toBe('Unsaved changes'));
  };

  it('a link to another screen asks first: "Keep editing" stays, "Leave without saving" goes', async () => {
    await openResult({ dataRouter: true });
    await rename();
    fireEvent.click(screen.getByRole('link', { name: 'Privacy' }));
    const dialog = await screen.findByRole('dialog', { name: 'Leave without saving?' });
    expect(dialog.textContent).toContain("Your changes aren't saved yet");
    fireEvent.click(within(dialog).getByRole('button', { name: 'Keep editing' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByTestId('rules-map')).toBeTruthy();
    expect(line('col:Grand total')).toBeTruthy();

    fireEvent.click(screen.getByRole('link', { name: 'Privacy' }));
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'Leave without saving?' })).getByRole('button', { name: 'Leave without saving' }));
    await waitFor(() => expect(screen.queryByTestId('rules-map')).toBeNull());
  });

  it('Escape is "Keep editing"', async () => {
    await openResult({ dataRouter: true });
    await rename();
    fireEvent.click(screen.getByRole('link', { name: 'Privacy' }));
    await screen.findByRole('dialog', { name: 'Leave without saving?' });
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByTestId('rules-map')).toBeTruthy();
  });

  it('with nothing unsaved it goes straight away', async () => {
    await openResult({ dataRouter: true });
    fireEvent.click(screen.getByRole('link', { name: 'Privacy' }));
    await waitFor(() => expect(screen.queryByTestId('rules-map')).toBeNull());
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('"Start over" throws the edits away, so it asks first too', async () => {
    await openResult({ dataRouter: true });
    await rename();
    fireEvent.click(screen.getByRole('button', { name: 'Start over' }));
    const dialog = await screen.findByRole('dialog', { name: 'Leave without saving?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Keep editing' }));
    expect(screen.getByTestId('rules-map')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Start over' }));
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'Leave without saving?' })).getByRole('button', { name: 'Leave without saving' }));
    expect(await screen.findByRole('button', { name: /Learn the format/ })).toBeTruthy();
    expect(screen.queryByTestId('rules-map')).toBeNull();
  });

  it('is asked in Hebrew too', async () => {
    await openResult({ lang: 'he', dataRouter: true });
    openLine('col:Total');
    fireEvent.change(screen.getByLabelText(he['editor.col.header']), { target: { value: 'Grand total' } });
    await waitFor(() => expect(flag()).toBe('שינויים שלא נשמרו'));
    fireEvent.click(screen.getByRole('link', { name: 'פרטיות' }));
    const dialog = await screen.findByRole('dialog', { name: 'לצאת בלי לשמור?' });
    expect(within(dialog).getByRole('button', { name: 'להמשיך לערוך' })).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'לצאת בלי לשמור' })).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------

describe('a check on a sample of a big example', () => {
  it('says so clearly, offers "Check all rows", and the answer replaces it', async () => {
    const { fullCheck } = await openResult({ partial: true, rows: 9000 });
    await waitFor(() => expect(strip()).toBe('Checked on a 2,000-row sample: 9,000 of 9,000 rows match'));
    const button = within(checkRegion()).getByRole('button', { name: 'Check all rows' });
    expect(button.classList.contains('btn--primary')).toBe(false); // the header's Save stays the one primary
    expect(document.querySelectorAll('.btn--primary')).toHaveLength(1);
    fireEvent.click(button);
    await waitFor(() => expect(fullCheck).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(strip()).toBe('Matches 9,000 of 9,000 rows in your example'));
    expect(within(checkRegion()).queryByRole('button', { name: 'Check all rows' })).toBeNull();
  });

  it('is worded in Hebrew', async () => {
    await openResult({ lang: 'he', partial: true, rows: 9000 });
    await waitFor(() => expect(strip()).toBe('נבדק על מדגם של 2,000 שורות: 9,000 מתוך 9,000 שורות תואמות'));
    expect(within(screen.getByRole('region', { name: 'בדיקה מול הדוגמה שלכם' })).getByRole('button', { name: 'בדיקת כל השורות' })).toBeTruthy();
  });
});

describe('every new string exists in both languages', () => {
  it('has them', () => {
    const keys = Object.keys(en).filter((k) => /^(leave|applied|rule|column.mismatch|check.(sample|checkAll))[.]/.test(k) || k === 'result.unsaved');
    expect(keys.length).toBeGreaterThanOrEqual(17);
    for (const key of keys) {
      expect((he as Record<string, string>)[key], `he ${key}`).toBeTruthy();
      // The same {placeholders} in both.
      const holes = (s: string): string[] => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).sort();
      expect(holes((he as Record<string, string>)[key]!), key).toEqual(holes((en as Record<string, string>)[key]!));
    }
  });
});

