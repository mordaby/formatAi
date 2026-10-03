// The preview of a column with NO rule yet (nothing fills it: `from: null`, unsupported, or one the rules don't have): its cells are EMPTY
// and its header says "No rule yet" - the example's values there would look like the rule's output. The example's values show only as a
// clearly labelled, muted target ("Your example: ..."), and only when asked for ("Show what your example has").
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ordersRules } from '../src/editor/testkit';
import { columnsWithoutRule } from '../src/pages/Result/helpers';
import { PreviewGrid } from '../src/pages/Result/PreviewGrid';
import type { Lang } from '../src/i18n';
import type { PreviewRow } from '../src/worker/editorApi';
import { liveResult } from './helpers/renderApp';
import { badge, HEADERS, openResult, renderWith, setDiffering } from './helpers/resultKit';

beforeEach(() => {
  document.cookie = 'lang=; Path=/; Max-Age=0';
  setDiffering();
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  document.cookie = 'lang=; Path=/; Max-Age=0';
  document.documentElement.lang = '';
  document.documentElement.dir = '';
});

const HEAD = HEADERS as readonly string[];
const REMARKS = HEAD.indexOf('Remarks'); // the orders rules' column with no rule (from: null)
const value = (row: number, c: number): string => `v${row}.${c}`;

const row = (exampleRow: number, badColumns: number[] = []): PreviewRow => ({
  exampleRow,
  inputRow: exampleRow,
  ok: badColumns.length === 0,
  source: [],
  expected: HEAD.map((_, c) => value(exampleRow, c)),
  actual: HEAD.map((_, c) => (badColumns.includes(c) ? 'x' : value(exampleRow, c))),
  badColumns,
});

/** What the live check says when the no-rule columns are left out of the comparison: every other column matches. */
const check = (preview: PreviewRow[], mismatches: Parameters<typeof liveResult>[0] = {}) =>
  liveResult({
    verified: true,
    matched: preview.length,
    total: preview.length,
    differences: 0,
    perColumn: HEAD.map((header) => ({ header, inExample: true, matched: preview.length, total: preview.length })),
    preview,
    ...mismatches,
  });

function grid(opts: { rules?: ReturnType<typeof ordersRules>; live?: ReturnType<typeof check>; lang?: Lang } = {}) {
  const lang = opts.lang ?? 'en';
  return renderWith(
    <PreviewGrid live={opts.live ?? check([row(2), row(3), row(4)])} rules={opts.rules ?? ordersRules()} flags={[]} limit={null} uiDir={lang === 'he' ? 'rtl' : 'ltr'} onFixRule={vi.fn()} onSignIn={vi.fn()} />,
    lang,
  );
}

const table = (): HTMLElement => screen.getByTestId('preview-table');
const headers = (): HTMLElement[] => [...table().querySelectorAll('thead th')].slice(1) as HTMLElement[]; // without the row-number column
const bodyCells = (column: number): HTMLElement[] =>
  [...table().querySelectorAll('tbody tr.pv__row')].map((tr) => tr.querySelectorAll('td')[column] as HTMLElement);
const toggle = (name: string | RegExp) => screen.queryByRole('button', { name });

describe('a column with no rule', () => {
  it('its header says "No rule yet"; the columns with a rule say nothing', () => {
    grid();
    expect(screen.getAllByTestId('no-rule-marker')).toHaveLength(1);
    const th = headers()[REMARKS]!;
    expect(th.textContent).toContain('Remarks');
    expect(within(th).getByTestId('no-rule-marker').textContent).toBe('No rule yet');
    expect(th.getAttribute('data-no-rule')).toBe('true');
    headers().forEach((h, c) => c !== REMARKS && expect(h.querySelector('[data-testid="no-rule-marker"]')).toBeNull());
  });

  it('its cells are empty - the example\'s values are nowhere in the table', () => {
    grid();
    const cells = bodyCells(REMARKS);
    expect(cells).toHaveLength(3);
    for (const td of cells) {
      expect(td.textContent).toBe('');
      expect(td.getAttribute('data-no-rule')).toBe('true');
    }
    expect(table().textContent).not.toContain(value(2, REMARKS));
    expect(table().textContent).not.toContain(value(3, REMARKS));
    // The other columns still show what the rules make.
    expect(bodyCells(0).map((td) => td.textContent)).toEqual([value(2, 0), value(3, 0), value(4, 0)]);
    expect(bodyCells(REMARKS - 1).map((td) => td.textContent)).toEqual([value(2, REMARKS - 1), value(3, REMARKS - 1), value(4, REMARKS - 1)]);
  });

  it('the example\'s values show only as a labelled, muted target, and only when asked for', () => {
    grid();
    expect(screen.queryByTestId('preview-target')).toBeNull();
    const show = toggle('Show what your example has')!;
    expect(show.getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(show);
    const targets = screen.getAllByTestId('preview-target');
    expect(targets).toHaveLength(3);
    // Each one says whose it is, and is inside the no-rule column's cell.
    targets.forEach((t, i) => {
      expect(t.textContent).toBe(`Your example: ${value(i + 2, REMARKS)}`);
      expect(t.closest('td')!.getAttribute('data-no-rule')).toBe('true');
      expect(t.querySelector('.pv__target-label')!.textContent).toBe('Your example:');
      expect(t.querySelector('bdi')!.textContent).toBe(value(i + 2, REMARKS));
    });
    // Nothing else changed: no other cell carries a target.
    expect(table().querySelectorAll('.pv__target')).toHaveLength(3);

    const hide = toggle('Hide what your example has')!;
    expect(hide.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(hide);
    expect(screen.queryByTestId('preview-target')).toBeNull();
    expect(bodyCells(REMARKS).every((td) => td.textContent === '')).toBe(true);
  });

  it('a mismatching row keeps its "Your example" row (the example\'s own values) and an empty "This rule" row for the column', () => {
    grid({ live: check([row(3, [0]), row(2)], { verified: false, matched: 1, total: 2, differences: 1 }) });
    const exampleRow = table().querySelector('tr.pv__row--example')!;
    const ruleRow = table().querySelector('tr.pv__row--rule')!;
    expect(exampleRow.querySelectorAll('td')[REMARKS]!.textContent).toBe(value(3, REMARKS));
    expect(ruleRow.querySelectorAll('td')[REMARKS]!.textContent).toBe('');
    // ...and what the rule made in the other columns still shows there.
    expect(ruleRow.querySelectorAll('td')[0]!.textContent).toBe('x');
  });

  it('without a column that has no rule there is no marker and no toggle', () => {
    const rules = ordersRules();
    rules.output.columns = rules.output.columns.map((c) => (c.header === 'Remarks' ? { header: 'Remarks', from: 'supplier' } : c));
    rules.unsupported = [];
    grid({ rules });
    expect(screen.queryByTestId('no-rule-marker')).toBeNull();
    expect(toggle(/what your example has/)).toBeNull();
    expect(bodyCells(REMARKS).map((td) => td.textContent)).toEqual([value(2, REMARKS), value(3, REMARKS), value(4, REMARKS)]);
  });

  it('a column the rules list as unsupported counts too (even with a `from`), and so does one the rules do not have at all', () => {
    const rules = ordersRules();
    rules.output.columns = rules.output.columns.map((c) => (c.header === 'Remarks' ? { header: 'Remarks', from: 'supplier' } : c));
    rules.unsupported = [{ outputColumn: 'Supplier', reasonCode: 'ambiguous' }];
    expect([...columnsWithoutRule(rules)]).toEqual(['Supplier']);
    grid({ rules });
    expect(headers().filter((h) => h.dataset.noRule === 'true').map((h) => h.textContent)).toEqual([expect.stringContaining('Supplier')]);
    expect(bodyCells(1).every((td) => td.textContent === '')).toBe(true);
    cleanup();

    const short = ordersRules();
    short.output.columns = short.output.columns.slice(0, HEAD.length - 1);
    short.unsupported = [];
    grid({ rules: short });
    expect(headers()[HEAD.length - 1]!.dataset.noRule).toBe('true');
    expect(bodyCells(HEAD.length - 1).every((td) => td.textContent === '')).toBe(true);
  });

  it('says it in Hebrew', () => {
    grid({ lang: 'he' });
    expect(within(headers()[REMARKS]!).getByTestId('no-rule-marker').textContent).toBe('אין עדיין כלל');
    expect(bodyCells(REMARKS).every((td) => td.textContent === '')).toBe(true);
    fireEvent.click(toggle('הצגת מה שיש בדוגמה שלכם')!);
    expect(screen.getAllByTestId('preview-target')[0]!.textContent).toBe(`הדוגמה שלכם: ${value(2, REMARKS)}`);
    expect(toggle('הסתרת מה שיש בדוגמה שלכם')).not.toBeNull();
  });
});

describe('the Result screen', () => {
  it('previews the column the rules cannot fill as empty, with the marker; the live counter and the badge are as before', async () => {
    await openResult();
    const preview = await screen.findByTestId('preview-table');
    expect(within(preview).getAllByTestId('no-rule-marker')).toHaveLength(1);
    const rows = [...preview.querySelectorAll('tbody tr.pv__row')];
    expect(rows.length).toBeGreaterThan(0);
    for (const tr of rows) expect(tr.querySelectorAll('td')[REMARKS]!.textContent).toBe('');
    expect(preview.textContent).not.toMatch(new RegExp(`v\\d+\\.${REMARKS}\\b`));
    expect(badge()).toBe('1 column needs your input');
    expect(screen.getByTestId('live-check-text').textContent).toBe('Matches 30 of 30 rows in your example');
  });

  it('in Hebrew', async () => {
    await openResult({ lang: 'he' });
    const preview = await screen.findByTestId('preview-table');
    expect(within(preview).getByTestId('no-rule-marker').textContent).toBe('אין עדיין כלל');
    expect(screen.getByRole('button', { name: 'הצגת מה שיש בדוגמה שלכם' })).toBeTruthy();
  });
});
