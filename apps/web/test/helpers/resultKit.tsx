// A fake worker for the Result screen's tests: it "runs" the rules by looking at the one thing the tests change (the Total
// column's calculation) and answers the way the real live check would: rows that differ come first, and rows marked "changed by hand"
// are left out of every count. `openResult` goes through Home and the learn to the Result screen.
import { type LearnResult, type PayloadCell, type Rules } from '@formatai/shared';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { expect, vi } from 'vitest';
import { ordersRules } from '../../src/editor/testkit';
import { I18nProvider, type Lang } from '../../src/i18n';
import type { LiveCheckResult, PreviewRow } from '../../src/worker/editorApi';
import type { LearnOutput } from '../../src/worker/engineApi';
import { csv, fakeApi, fakeEngine, learnResult, liveResult, renderApp } from './renderApp';

export const ROWS = 30;
const original = ordersRules();
const originalCalc = JSON.stringify(original.transform.computed);
export const HEADERS = original.output.columns.map((c) => c.header);
export const TOTAL = HEADERS.indexOf('Total');
/** Rows that differ once the Total calculation is changed: 5 of 30 (Total then matches in 25 of 30 = 83%: the rule is what is wrong). */
export const DIFFERING_ROWS = [3, 4, 5, 6, 7];
let differing: number[] = DIFFERING_ROWS;
/** Which example rows differ after the Total calculation is changed (the default is DIFFERING_ROWS); reset it with no argument. */
export function setDiffering(rows: number[] = DIFFERING_ROWS): void {
  differing = rows;
}

export function makeLive(rules: LearnResult | Rules, exceptions: number[] = [], opts: { rows?: number; partial?: boolean } = {}): LiveCheckResult {
  const rows = opts.rows ?? ROWS;
  const changed = JSON.stringify(rules.transform.computed) !== originalCalc;
  const bad = changed ? differing.filter((r) => !exceptions.includes(r)) : [];
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

export interface Setup {
  rules?: LearnResult | Rules;
  lang?: 'en' | 'he';
  rows?: number;
  partial?: boolean;
  convert?: unknown;
  staticProblems?: unknown[];
  /** The worker has no example in memory (or the learn kept none). */
  noExample?: boolean;
  /** The signed-in (or not) API the app talks to. */
  api?: ReturnType<typeof fakeApi>;
  /** A data router, like the real app (needed for the question before leaving the screen). */
  dataRouter?: boolean;
}

export async function openResult(setup: Setup = {}) {
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
  const api = setup.api ?? fakeApi();
  renderApp({ engine, api, lang: setup.lang ?? 'en', ...(setup.dataRouter ? { dataRouter: true } : {}) });

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

export const line = (id: string): HTMLElement => {
  const el = document.querySelector(`[data-line-id="${id}"]`);
  if (!el) throw new Error(`no line ${id}: ${[...document.querySelectorAll('[data-line-id]')].map((e) => e.getAttribute('data-line-id')).join(', ')}`);
  return el as HTMLElement;
};
export const openLine = (id: string): void => {
  fireEvent.click(within(line(id)).getAllByRole('button').find((b) => b.classList.contains('map-line__main'))!);
};
export const strip = (): string => screen.getByTestId('live-check-text').textContent ?? '';
export function renderWith(ui: ReactElement, lang: Lang = 'en') {
  return render(
    <I18nProvider initial={lang}>
      <MemoryRouter>{ui}</MemoryRouter>
    </I18nProvider>,
  );
}

export const badge = (): string => screen.getByTestId('status-badge').textContent ?? '';
export const columnOrder = (): string[] => [...document.querySelectorAll('[data-section="columns"] [data-line-id]')].map((e) => e.getAttribute('data-line-id')!);
