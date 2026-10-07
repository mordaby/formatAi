import type { Flag } from '@formatai/engine';
import { assumptionMessages, tiers, unsupportedMessages, type Rules } from '@formatai/shared';
import { cleanup, createEvent, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ordersRules } from '../src/editor/testkit';
import { en, he, type MessageKey } from '../src/i18n';
import { FormatChange } from '../src/pages/Result/EditorPanel';
import { getResultSession } from '../src/pages/Result/session';
import type { LearnOutput } from '../src/worker/engineApi';
import { learnResult } from './helpers/renderApp';
import { badge, columnOrder, DIFFERING_ROWS, HEADERS, line, openLine, openResult, renderWith, strip } from './helpers/resultKit';

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
    const save = screen.getByRole('button', { name: 'Save format' });
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

describe('the live check strip', () => {
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
    expect((screen.getByRole('button', { name: 'Save format' }) as HTMLButtonElement).disabled).toBe(true);
    // (no file is made from rules that cannot run, either)
    expect((screen.getByRole('button', { name: 'Download the file' }) as HTMLButtonElement).disabled).toBe(true);
  });

  // The audit's C9: the problems were English-only in the Hebrew UI (the whole list marked lang="en"), and an alert said again after every edit.
  it('says the problems in Hebrew in the Hebrew UI: only the checker\'s own words a sentence quotes stay English, and are marked so', async () => {
    await openResult({
      lang: 'he',
      staticProblems: [
        { layer: 'references', kind: 'reference', path: 'transform.sort[0].column', message: 'unknown column id "ghost"' },
        { layer: 'types', kind: 'type', path: 'output.columns[3]', message: 'expected decimal, got text' },
        { layer: 'formatLock', kind: 'header', path: 'output.columns[0].header', message: 'must equal the format\'s header "Item", got "Vendor"' },
      ],
    });
    const list = await screen.findByTestId('check-problems');
    const items = within(list).getAllByRole('listitem');
    expect(items.map((li) => li.textContent)).toEqual([
      'מיון: יש בו שימוש בעמודה ("ghost") שלא קיימת.',
      'העמודה "Total": סוגי הערכים מתערבבים - צריך מספר אבל מתקבל טקסט.',
      'העמודה "Item": כבר לא תואם לפורמט שהמקור הזה שייך אליו (must equal the format\'s header "Item", got "Vendor").',
    ]);
    expect(items.some((li) => li.getAttribute('lang') === 'en')).toBe(false);
    const english = items[2]!.querySelector('[lang="en"]')!;
    expect(english.textContent).toBe('must equal the format\'s header "Item", got "Vendor"');
    expect(english.getAttribute('dir')).toBe('ltr');
    expect(items[0]!.querySelector('[lang="en"]')).toBeNull();
  });

  it('the problems are said by a polite live region that is always there - not an alert - and an edit that leaves them as they were says nothing again', async () => {
    const { staticChecks } = await openResult({ staticProblems: [{ layer: 'references', kind: 'reference', path: 'transform.sort[0].column', message: 'unknown column id "ghost"' }] });
    const live = screen.getByTestId('check-problems-live');
    expect(live.getAttribute('aria-live')).toBe('polite');
    await waitFor(() => expect(live.textContent).toBe('Fix these before you save: Sort uses a column ("ghost") that does not exist.'));
    const list = screen.getByTestId('check-problems');
    expect(list.closest('[role="alert"]')).toBeNull();
    expect(list.querySelector('[role="alert"]')).toBeNull();
    const said: MutationRecord[] = [];
    const watch = new MutationObserver((records) => said.push(...records));
    watch.observe(live, { childList: true, characterData: true, subtree: true });
    const checks = staticChecks.mock.calls.length;
    fireEvent.click(document.querySelector('[data-line-id="col:Supplier"] .map-line__main') as HTMLElement);
    fireEvent.change(screen.getByLabelText('Column name'), { target: { value: 'Vendor' } });
    await waitFor(() => expect(staticChecks.mock.calls.length).toBeGreaterThan(checks));
    await waitFor(() => expect(document.querySelector('[data-line-id="col:Vendor"]')).toBeTruthy());
    await new Promise((r) => setTimeout(r, 50));
    watch.disconnect();
    expect(said).toEqual([]);
    // (the list stayed on screen while the edit was checked: the same element)
    expect(screen.getByTestId('check-problems')).toBe(list);
  });
});

describe('the free tier', () => {
  it('shows 20 rows, and "Sign in to see and download all N rows" opens the sign-in wall', async () => {
    await openResult({ rows: 45 });
    await waitFor(() => expect(document.querySelectorAll('.pv tbody tr.pv__row')).toHaveLength(tiers.anonymous.previewRows!));
    const more = screen.getByRole('button', { name: 'Sign in to see and download all 45 rows' });
    fireEvent.click(more);
    const dialog = await screen.findByRole('dialog', { name: 'Sign in' });
    expect(dialog.textContent).toContain('Sign in free to download the full file.');
    expect(await within(dialog).findByText('Continue with Google')).toBeTruthy();
    expect(within(dialog).getByText('Continue with Microsoft')).toBeTruthy();
  });

  it('"Save format" opens the sign-in wall and keeps the learned rules (and edits) meanwhile', async () => {
    await openResult();
    openLine('col:Total');
    fireEvent.change(screen.getByLabelText('Column name'), { target: { value: 'Grand total' } });
    await waitFor(() => line('col:Grand total'));
    fireEvent.click(screen.getByRole('button', { name: 'Save format' }));
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
    expect(screen.getByRole('button', { name: 'שמירת הפורמט' })).toBeTruthy();
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
    'editor.check.rule.': ['required', 'range', 'lengthEquals', 'oneOf', 'unique', 'dateRange', 'israeliIdChecksum', 'cutoffRange'],
    'editor.check.cutoff.': ['high', 'low', 'lowEdge', 'highEdge'],
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
