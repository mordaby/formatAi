// "Try it on another file" on the Result screen (SPEC 5 A step 7, 21 v11): the rules as they are on screen - unsaved edits included -
// run on one more file in the worker, for everyone, with nothing sent over the network and nothing saved. The same report and row
// review as the Convert screen, the missing-columns error, and a download (signed in; a visitor is asked to sign in).
import type { Flag } from '@formatai/engine';
import { tiers } from '@formatai/shared';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resumeLeaveGuard } from '../src/app/unloadPrompt';
import { webConfig } from '../src/config';
import type { ConvertRunOutput } from '../src/worker/convertApi';
import { csv, fakeApi, USER, type FakeApi } from './helpers/renderApp';
import { line, openLine, openResult } from './helpers/resultKit';

const { downloaded } = vi.hoisted(() => ({ downloaded: vi.fn() }));
vi.mock('../src/flow/download', async (orig) => ({ ...(await orig<typeof import('../src/flow/download')>()), downloadBytes: downloaded }));

beforeEach(() => {
  document.cookie = 'lang=; Path=/; Max-Age=0';
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  resumeLeaveGuard();
});

const summary = { rowsIn: 12, rowsOut: 11, rowsFiltered: 1, duplicatesRemoved: [], duplicatesFlagged: 0, blockedRows: [] };
const preview = {
  name: 'Orders',
  direction: 'ltr' as const,
  language: 'en' as const,
  columns: [{ header: 'Item' }, { header: 'Qty' }],
  rows: [
    { kind: 'header' as const, cells: [{ v: 'Item' }, { v: 'Qty' }] },
    { kind: 'data' as const, cells: [{ v: '000001' }, { v: 5 }] },
  ],
  merges: [],
};
const written = (flags: Flag[] = []): ConvertRunOutput => ({ ok: true, written: true, bytes: new ArrayBuffer(8), fileType: 'xlsx', flags, summary, preview, totalRows: 11 });
const flag = (rowNumber: number): Flag => ({ rowNumber, column: 'qty', rule: 'type', value: 'abc', messageKey: 'flag.parseFailed.integer' });

const panel = () => within(screen.getByTestId('try-file'));
const button = (name: string): HTMLButtonElement => screen.getByRole('button', { name }) as HTMLButtonElement;

/** Drops `another.csv` on the panel's zone. */
async function drop(name = 'another.csv') {
  const input = screen.getByLabelText('File to try');
  await act(async () => {
    fireEvent.change(input, { target: { files: [csv(name, 'Item,Qty\n1,5\n')] } });
  });
}

/** An unsaved edit: the Total column is renamed on the rules map. */
const renameTotal = async (to = 'Grand total'): Promise<void> => {
  openLine('col:Total');
  fireEvent.change(screen.getByLabelText('Column name'), { target: { value: to } });
  await waitFor(() => line(`col:${to}`));
};

/** How many times every call of the fake API has been made: nothing may be added by a run on another file. */
function callCounts(api: FakeApi): number[] {
  const mocks = [api.session, api.learn, api.repair, ...Object.values(api.auth), ...Object.values(api.registry)] as unknown as { mock?: { calls: unknown[] } }[];
  return mocks.map((m) => m.mock?.calls.length ?? 0);
}

describe('the panel', () => {
  it('is on the Result screen for a visitor, quiet (no second primary button), and says nothing is saved or sent', async () => {
    await openResult({ convertWithDecisions: vi.fn() });
    expect(screen.getByRole('heading', { name: 'Try it on another file' })).toBeTruthy();
    expect(panel().getByText('Runs the rules above, with your edits, on one more file. It stays on your computer and nothing is saved.')).toBeTruthy();
    expect(document.querySelectorAll('.btn--primary')).toHaveLength(1);
    expect((screen.getByLabelText('File to try') as HTMLInputElement).multiple).toBe(false);
  });

  it('is on the Result screen for a signed-in user too (to check before saving)', async () => {
    await openResult({ api: fakeApi({ user: USER }), convertWithDecisions: vi.fn() });
    expect(screen.getByRole('heading', { name: 'Try it on another file' })).toBeTruthy();
  });

  it('is in Hebrew too', async () => {
    await openResult({ lang: 'he', convertWithDecisions: vi.fn() });
    expect(screen.getByRole('heading', { name: 'לנסות על קובץ נוסף' })).toBeTruthy();
    expect(screen.getByLabelText('קובץ לניסיון')).toBeTruthy();
  });
});

describe('running the current rules on one more file', () => {
  it('runs the rules as they are on screen - an unsaved edit included - in the worker, and nothing goes over the network', async () => {
    const fetchSpy = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', fetchSpy);
    const convertWithDecisions = vi.fn(async (_args: unknown): Promise<ConvertRunOutput> => written());
    const api = fakeApi();
    await openResult({ api, convertWithDecisions });
    await renameTotal();
    const before = callCounts(api);

    await drop();
    await panel().findByTestId('run-summary');

    expect(convertWithDecisions).toHaveBeenCalledTimes(1);
    const args = convertWithDecisions.mock.calls[0]![0] as { mode: string; rules: { output: { columns: { header: string }[] } }; file: { name: string; bytes: ArrayBuffer } };
    expect(args.mode).toBe('review');
    // The rules are the ones on screen: the renamed column is in them.
    expect(args.rules.output.columns.map((c) => c.header)).toContain('Grand total');
    expect(args.file.name).toBe('another.csv');
    expect(new TextDecoder().decode(args.file.bytes)).toBe('Item,Qty\n1,5\n');
    // No API call of any kind, and no request at all.
    expect(callCounts(api)).toEqual(before);
    expect(fetchSpy).not.toHaveBeenCalled();
    // Nothing was saved: still the unsaved learn.
    expect(screen.getByRole('button', { name: 'Save format and download' })).toBeTruthy();
  });

  it('shows what the Convert screen shows: rows in and out, no flags, the first rows of the file', async () => {
    await openResult({ convertWithDecisions: vi.fn(async () => written()) });
    await drop();
    const summaryList = await panel().findByTestId('run-summary');
    expect(within(summaryList).getByText('Rows in').nextSibling?.textContent).toBe('12');
    expect(within(summaryList).getByText('Rows out').nextSibling?.textContent).toBe('11');
    expect(within(summaryList).getByText('Left out by a filter').nextSibling?.textContent).toBe('1');
    expect(panel().getByText('Nothing is flagged.')).toBeTruthy();
    expect(panel().getByTestId('run-preview').textContent).toContain('000001');
    expect(panel().getByTestId('try-output-name').textContent).toBe('another (converted).xlsx');
  });

  it('asks the worker for the free tier\'s rows on screen for a visitor, and the Convert screen\'s for a signed-in user', async () => {
    const visitor = vi.fn(async (_args: unknown): Promise<ConvertRunOutput> => written());
    await openResult({ convertWithDecisions: visitor });
    await drop();
    await panel().findByTestId('run-summary');
    expect((visitor.mock.calls[0]![0] as { previewRows: number }).previewRows).toBe(tiers.anonymous.previewRows);
    cleanup();

    const signedIn = vi.fn(async (_args: unknown): Promise<ConvertRunOutput> => written());
    await openResult({ api: fakeApi({ user: USER }), convertWithDecisions: signedIn });
    await drop();
    await panel().findByTestId('run-summary');
    expect((signedIn.mock.calls[0]![0] as { previewRows: number }).previewRows).toBe(webConfig.convertPreviewRows);
  });

  it('runs it again with the rules as they are now (after an edit), on the same file', async () => {
    const convertWithDecisions = vi.fn(async (_args: unknown): Promise<ConvertRunOutput> => written());
    await openResult({ convertWithDecisions });
    await drop();
    await panel().findByTestId('run-summary');
    await renameTotal('Sum');
    fireEvent.click(button('Run again with the current rules'));
    await waitFor(() => expect(convertWithDecisions).toHaveBeenCalledTimes(2));
    const second = convertWithDecisions.mock.calls[1]![0] as { rules: { output: { columns: { header: string }[] } }; file: { name: string } };
    expect(second.rules.output.columns.map((c) => c.header)).toContain('Sum');
    expect(second.file.name).toBe('another.csv');
  });
});

describe('the download', () => {
  it('a signed-in user downloads the file that was made', async () => {
    await openResult({ api: fakeApi({ user: USER }), convertWithDecisions: vi.fn(async () => written()) });
    await drop();
    await panel().findByTestId('run-summary');
    expect(panel().queryByText(/Sign in to download the file/)).toBeNull();
    fireEvent.click(panel().getByRole('button', { name: 'Download the file' }));
    expect(downloaded).toHaveBeenCalledWith('another (converted).xlsx', expect.any(ArrayBuffer), expect.stringContaining('spreadsheetml'));
  });

  it('a visitor sees the result, and is asked to sign in to download it (SPEC 11): nothing is downloaded', async () => {
    await openResult({ convertWithDecisions: vi.fn(async () => written()) });
    await drop();
    await panel().findByTestId('run-summary');
    expect(panel().getByText(`Sign in to download the file. Here you see its first ${tiers.anonymous.previewRows} rows.`)).toBeTruthy();
    fireEvent.click(panel().getByRole('button', { name: 'Download the file' }));
    expect(await screen.findByRole('dialog', { name: 'Sign in' })).toBeTruthy();
    expect(downloaded).not.toHaveBeenCalled();
  });
});

describe('flagged rows are reviewed before the file is written', () => {
  const run = (args: { mode: string }): ConvertRunOutput =>
    args.mode === 'review'
      ? { ok: true, written: false, fileType: 'xlsx', flags: [flag(3), flag(7)], summary, rowInputs: { 3: [{ columnId: 'qty', header: 'Qty', value: 'abc' }], 7: [{ columnId: 'qty', header: 'Qty', value: 'abc' }] } }
      : written();

  it('lists the rows, takes a choice per row, and writes the file with those decisions only when asked', async () => {
    const convertWithDecisions = vi.fn(async (args: { mode: string }) => run(args));
    await openResult({ convertWithDecisions });
    await drop();
    const review = await screen.findByTestId('review');
    expect(within(review).getByTestId('review-count').textContent).toBe('2 rows are flagged.');
    expect(within(review).getAllByTestId('review-row')).toHaveLength(2);
    // Flagged columns are named as the user knows them (the file's column).
    expect(within(review).getAllByText('Qty').length).toBeGreaterThan(0);
    // The rules are on this screen already: no "Change the rule" button, and the hint says where to edit them.
    expect(within(review).queryByRole('button', { name: 'Change the rule' })).toBeNull();
    expect(within(review).getByText('To change a rule, edit it above and run the file again.')).toBeTruthy();
    // Nothing is written yet.
    expect(convertWithDecisions).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('try-done')).toBeNull();

    fireEvent.click(within(within(review).getAllByTestId('review-row')[0]!).getByRole('button', { name: 'Skip this row' }));
    fireEvent.click(within(review).getByRole('button', { name: 'Create the file' }));
    await panel().findByTestId('try-done');

    expect(convertWithDecisions).toHaveBeenCalledTimes(2);
    expect(convertWithDecisions.mock.calls[1]![0]).toMatchObject({ mode: 'write', rowDecisions: { 3: { action: 'skip' } } });
  });
});

describe('what cannot run', () => {
  it('missing required columns: the exact headers, in the rules\' own words, and a way to choose another file', async () => {
    const convertWithDecisions = vi.fn(async (_args: unknown): Promise<ConvertRunOutput> => ({ ok: false, error: { code: 'missingRequiredColumns', missing: ['Qty', 'Unit price'] } }));
    await openResult({ convertWithDecisions });
    await drop();
    const missing = await panel().findByTestId('missing-columns');
    expect(missing.textContent).toContain('The rules need 2 columns this file does not have:');
    expect([...within(missing).getByTestId('missing-list').querySelectorAll('li')].map((li) => li.textContent)).toEqual(['Qty', 'Unit price']);
    expect(missing.textContent).toContain('change the rules above');
    fireEvent.click(within(missing).getByRole('button', { name: 'Choose another file' }));
    await waitFor(() => expect(screen.queryByTestId('missing-columns')).toBeNull());
    expect(screen.getByLabelText('File to try')).toBeTruthy();
  });

  it('rules with a problem say so, and run again once fixed', async () => {
    const convertWithDecisions = vi.fn(async (_args: unknown): Promise<ConvertRunOutput> => ({ ok: false, error: { code: 'invalidRules' } }));
    await openResult({ convertWithDecisions });
    await drop();
    expect(await panel().findByText("The rules above have a problem, so they can't run yet. Fix what the check says and run again.")).toBeTruthy();
    convertWithDecisions.mockImplementation(async () => written());
    fireEvent.click(button('Run again with the current rules'));
    await panel().findByTestId('run-summary');
  });

  it('a file with no table, or one that cannot be read, is explained', async () => {
    const convertWithDecisions = vi.fn(async (_args: unknown): Promise<ConvertRunOutput> => ({ ok: false, error: { code: 'noTable' } }));
    await openResult({ convertWithDecisions });
    await drop();
    expect(await panel().findByText(/We couldn't find a table in this file/)).toBeTruthy();
  });
});
