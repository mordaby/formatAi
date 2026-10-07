// The learn page after a save (owner, 2026-10-07): once the learned format is saved, the next time the learn page shows it starts empty, with
// no extra click; left without saving, the two files stay for another try. And a "Clear" link next to the chosen files: one click, no
// question - unless a learned result that is not saved would be lost, then it asks once. English and Hebrew.
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resumeLeaveGuard } from '../src/app/unloadPrompt';
import { conversionSummary, createFormatResponse, formatSummary } from './helpers/registryKit';
import { csv, fakeApi, renderApp, USER } from './helpers/renderApp';
import { openResult } from './helpers/resultKit';

beforeEach(() => {
  document.cookie = 'lang=; Path=/; Max-Age=0';
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  resumeLeaveGuard();
  document.cookie = 'lang=; Path=/; Max-Age=0';
});

const COPY = {
  en: {
    input: 'Example input',
    output: 'Example output',
    save: 'Save format',
    saveChanges: 'Save changes',
    clear: 'Clear the chosen files',
    confirmTitle: 'Clear the files?',
    keep: 'Keep them',
    yes: 'Clear',
  },
  he: {
    input: 'דוגמת קלט',
    output: 'דוגמת פלט',
    save: 'שמירת הפורמט',
    saveChanges: 'שמירת השינויים',
    clear: 'ניקוי הקבצים שנבחרו',
    confirmTitle: 'לנקות את הקבצים?',
    keep: 'להשאיר אותם',
    yes: 'ניקוי',
  },
} as const;

const created = createFormatResponse({ format: formatSummary({ id: 'F1', name: 'Orders report' }), conversion: conversionSummary({ id: 'C1', formatId: 'F1', sourceName: 'Source 1', version: 1 }) });
const SUMMARY = { rowsIn: 3, rowsOut: 3, rowsFiltered: 0, duplicatesRemoved: [], duplicatesFlagged: 0, blockedRows: [] };
const converted = { ok: true, bytes: new ArrayBuffer(8), flags: [], summary: SUMMARY, preview: { name: 'Out', direction: 'ltr', language: 'en', columns: [], rows: [], merges: [] }, totalRows: 3 };

/** The chosen files' names, as the drop zones show them (none: the form is empty, or Home offers its two actions instead). */
const fileNames = (): string[] => [...document.querySelectorAll('.dz__name')].map((e) => e.textContent ?? '');
/** Back to the learn page by the logo, as a user would. */
const home = (): void => {
  fireEvent.click(screen.getByRole('link', { name: 'formatAI' }));
};

describe.each(['en', 'he'] as const)('the learn page and its files (%s)', (lang) => {
  const c = COPY[lang];

  it('after a save, the learn page starts empty - no click to clear it', async () => {
    const createFormat = vi.fn(async () => created);
    const api = fakeApi({ user: USER, registry: { createFormat } });
    await openResult({ api, lang, convert: converted });
    await waitFor(() => expect((screen.getByRole('button', { name: c.save }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: c.save }));
    await screen.findByRole('button', { name: c.saveChanges });
    expect(createFormat).toHaveBeenCalledTimes(1);
    home();
    await waitFor(() => expect(screen.queryByRole('button', { name: c.saveChanges })).toBeNull());
    expect(fileNames()).toEqual([]);
    expect(document.body.textContent).not.toContain('orders.csv');
  });

  it('left without saving, the files stay (to try again or adjust)', async () => {
    await openResult({ lang });
    home();
    await waitFor(() => expect(fileNames()).toEqual(['orders.csv', 'Orders report.csv']));
  });

  it('"Clear" empties the form in one click, with no question when nothing would be lost', async () => {
    renderApp({ lang });
    expect(screen.queryByRole('button', { name: c.clear })).toBeNull(); // nothing chosen, nothing to clear
    fireEvent.change(screen.getByLabelText(c.input), { target: { files: [csv('orders.csv')] } });
    fireEvent.change(screen.getByLabelText(c.output), { target: { files: [csv('Orders report.csv')] } });
    await waitFor(() => expect(fileNames()).toHaveLength(2));
    fireEvent.click(screen.getByRole('button', { name: c.clear }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(fileNames()).toEqual([]);
    expect(screen.queryByRole('button', { name: c.clear })).toBeNull();
  });

  it('asks once when a learned result that is not saved would be lost: "Keep them" keeps it, "Clear" clears', async () => {
    await openResult({ lang });
    home();
    await waitFor(() => expect(fileNames()).toHaveLength(2));
    fireEvent.click(screen.getByRole('button', { name: c.clear }));
    const dialog = screen.getByRole('dialog', { name: c.confirmTitle });
    fireEvent.click(within(dialog).getByRole('button', { name: c.keep }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(fileNames()).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: c.clear }));
    fireEvent.click(within(screen.getByRole('dialog', { name: c.confirmTitle })).getByRole('button', { name: c.yes }));
    await waitFor(() => expect(fileNames()).toEqual([]));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
