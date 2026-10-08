// The several-files half of the Run screen (SPEC 5 D, 8.15, 11, 21 v11): the files per run come from the tier, one file at a time in
// the worker, each file matched to a SOURCE on its own (auto-pick only), a status per file, results grouped by format (a source
// that feeds several formats converts the file into all of them), a zip and a summary sheet, and counts-only reports to the API.
// The last tests run the real worker methods and open the zip and the sheet. (One dropped file is the Convert flow: see runScreen.test.)
import { readWorkbook, readZip, type Flag } from '@formatai/engine';
import { tiers } from '@formatai/shared';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ConvertPage from '../src/pages/Convert';
import type { BatchArgs, ConvertRunOutput, MatchFileOutput } from '../src/worker/convertApi';
import { createEngineClient, type EngineClient } from '../src/worker/engineClient';
import { engineMethods } from '../src/worker/engineMethods';
import { loopbackWorker } from './helpers/loopback';
import { csvFile, entry, fakeConvertApi, match, PAID, realColumnGaps, renderConvert, RULES, SUPPLIER_A_CLEAN_CSV, SUPPLIER_A_CSV, sourceEntry } from './helpers/convertKit';

const { signInOpen, downloaded } = vi.hoisted(() => ({ signInOpen: vi.fn(), downloaded: vi.fn() }));
vi.mock('../src/app/SignIn', () => ({ useSignIn: () => ({ open: signInOpen, close: vi.fn() }) }));
vi.mock('../src/flow/download', async (orig) => ({ ...(await orig<typeof import('../src/flow/download')>()), downloadBytes: downloaded }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const flag = (rowNumber: number): Flag => ({ rowNumber, column: 'c_qty', rule: 'type', value: 'abc', messageKey: 'flag.parseFailed.integer' });

/**
 * Drops files on the Run screen's zone. One file would be the Convert flow, so a batch of exactly one file is made the way a user
 * can: two files dropped, the second taken out again.
 */
async function addFiles(files: File[]) {
  const input = (await screen.findByLabelText('Files to convert')) as HTMLInputElement;
  const only = files.length === 1;
  await act(async () => {
    fireEvent.change(input, { target: { files: only ? [...files, csvFile('filler.csv', 'x')] : files } });
  });
  if (only) fireEvent.click(await screen.findByRole('button', { name: 'Remove filler.csv' }));
}

/** The batch's one question (SPEC 5 D): some file can be made into several formats, so the user ticks them - here "All" - and converts. */
async function answerAll() {
  fireEvent.click(await screen.findByRole('checkbox', { name: 'All formats' }));
  fireEvent.click(screen.getByRole('button', { name: 'Convert' }));
}

describe('what the several-files half takes', () => {
  it('paid: the drop zone takes up to the files per run of the tier, and says when more were dropped', async () => {
    renderConvert(<ConvertPage />, { api: fakeConvertApi({ user: PAID }), engine: {} as EngineClient });
    const limit = tiers.paid.filesPerRun;
    await addFiles(Array.from({ length: limit + 3 }, (_, i) => csvFile(`f${i}.csv`, SUPPLIER_A_CLEAN_CSV)));
    expect(await screen.findByText(`${limit} files`)).toBeTruthy();
    expect(screen.getAllByTestId('batch-file')).toHaveLength(limit);
    expect(screen.getByText(`Your plan takes up to ${limit} files in one run. The first ${limit} were added.`)).toBeTruthy();
    expect(screen.getByRole('button', { name: `Convert ${limit} files` })).toBeTruthy();
  });

  it('turns away files it cannot read and files already added', async () => {
    renderConvert(<ConvertPage />, { api: fakeConvertApi({ user: PAID }), engine: {} as EngineClient });
    const a = csvFile('a.csv', SUPPLIER_A_CLEAN_CSV);
    await addFiles([a, new File(['x'], 'notes.pdf')]);
    expect(screen.getAllByTestId('batch-file')).toHaveLength(1);
    expect(screen.getByText(/1 files were not added/)).toBeTruthy();
    await addFiles([a]);
    expect(screen.getAllByTestId('batch-file')).toHaveLength(1);
  });
});

describe('a batch, file by file', () => {
  const entries = [
    entry({ conversionId: 'c1', formatId: 'F1', formatName: 'Load file', sourceName: 'Supplier A' }),
    entry({ conversionId: 'c2', formatId: 'F2', formatName: 'ERP load', sourceName: 'Supplier B' }),
  ];

  function setup() {
    let inFlight = 0;
    let maxInFlight = 0;
    const order: string[] = [];
    const track = async <T,>(fn: () => T): Promise<T> => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
      return fn();
    };
    const matchFile = vi.fn(async (args: { file: { name: string } }): Promise<MatchFileOutput> =>
      track(() => {
        const name = args.file.name;
        order.push(name);
        const auto = (id: string, extra = {}, headers = ['Item Code', 'Qty', 'Price']): MatchFileOutput => ({ ok: true, headers, ranked: [], pick: { kind: 'auto', match: match({ id, name: id === 'c1' ? 'Supplier A' : 'Supplier B', ...extra }) } });
        if (name === 'a.csv' || name === 'b.csv') return auto('c1');
        if (name === 'e.csv') return auto('c2');
        if (name === 'd.csv') return auto('c1', { score: 0.9, missingRequired: ['Qty'] }, ['Item Code', 'Price']);
        if (name === 'bad.csv') return { ok: false, reason: 'unreadable' };
        return { ok: true, headers: [], ranked: [], pick: { kind: 'choose', options: [match({ id: 'c1', score: 0.6 }), match({ id: 'c2', score: 0.5 })] } };
      }),
    );
    const convertWithDecisions = vi.fn(async (args: { file: { name: string } }): Promise<ConvertRunOutput> =>
      track(() => {
        const withFlags = args.file.name === 'b.csv';
        const flags = withFlags ? [flag(3), flag(5)] : [];
        return {
          ok: true,
          written: true,
          bytes: new ArrayBuffer(8),
          fileType: 'csv',
          flags,
          summary: { rowsIn: 10, rowsOut: 9, rowsFiltered: 0, duplicatesRemoved: [], duplicatesFlagged: 0, blockedRows: [] },
          preview: { name: 'Load', direction: 'ltr', language: 'en', columns: [], rows: [], merges: [] },
          totalRows: 0,
        };
      }),
    );
    const batch = vi.fn(async (_args: BatchArgs) => ({ zip: new ArrayBuffer(6), summary: new ArrayBuffer(4) }));
    const engine = { matchFile, columnGaps: vi.fn(realColumnGaps), convertWithDecisions, batch, terminate: vi.fn() } as unknown as EngineClient;
    return { engine, matchFile, convertWithDecisions, batch, order, max: () => maxInFlight };
  }

  it('matches each file on its own, gives each a status, groups by format, and packs a zip and a summary', async () => {
    const api = fakeConvertApi({ user: PAID, entries });
    const { engine, order, max, batch, convertWithDecisions } = setup();
    renderConvert(<ConvertPage />, { api, engine });
    await addFiles([csvFile('a.csv', 'x'), csvFile('b.csv', 'x'), csvFile('e.csv', 'x'), csvFile('c.csv', 'x'), csvFile('d.csv', 'x'), csvFile('bad.csv', 'x')]);
    fireEvent.click(await screen.findByRole('button', { name: 'Convert 6 files' }));

    const results = await screen.findByTestId('batch-results');
    // One at a time, in the order the files were added.
    expect(order).toEqual(['a.csv', 'b.csv', 'e.csv', 'c.csv', 'd.csv', 'bad.csv']);
    expect(max()).toBe(1);
    // Only files that matched clearly were converted (c.csv was ambiguous, bad.csv is unreadable) and had every column their format needs (d.csv lacks one).
    expect(convertWithDecisions.mock.calls.map((c) => (c[0] as { file: { name: string } }).file.name)).toEqual(['a.csv', 'b.csv', 'e.csv']);

    expect(screen.getByTestId('batch-counts').textContent).toBe('2 converted · 1 with flags · 2 did not match · 1 need attention');

    // Grouped by format, each file with its status; the ones that didn't match say why.
    const groups = within(results).getAllByTestId(/group-/);
    expect(groups.map((g) => g.querySelector('h3')?.textContent)).toEqual(['Load file · 2 files', 'ERP load · 1 file', 'Needs attention · 1 file', "Didn't match · 2 files"]);
    const row = (name: string) => within(results).getAllByTestId('batch-file').find((r) => r.textContent?.includes(name))!;
    expect(row('a.csv').getAttribute('data-status')).toBe('converted');
    expect(row('a.csv').textContent).toContain('Converted');
    expect(row('b.csv').getAttribute('data-status')).toBe('convertedFlags');
    expect(row('b.csv').textContent).toContain('Converted with flags');
    expect(row('b.csv').textContent).toContain('2 flagged rows');
    expect(row('c.csv').textContent).toContain("Didn't match");
    expect(row('c.csv').textContent).toContain('More than one source fits');
    // d.csv lacks "Qty", which this format requires: the format needs attention, and says which column (SPEC 21 v11 items 4-7).
    expect(row('d.csv').getAttribute('data-status')).toBe('needsAttention');
    expect(row('d.csv').textContent).toContain('Needs attention');
    expect(row('d.csv').textContent?.replace(/[⁦-⁩]/g, '')).toContain("Load file uses 'Qty', which is not in this file.");
    expect(row('bad.csv').textContent).toContain("couldn't be read");

    // The worker packs only what was converted, in a folder per format, plus the summary tables.
    expect(batch).toHaveBeenCalledTimes(1);
    const args = batch.mock.calls[0]![0];
    expect(args.outputs.map((o) => [o.folder, o.fileName])).toEqual([['Load file', 'a (converted).csv'], ['Load file', 'b (converted).csv'], ['ERP load', 'e (converted).csv']]);
    expect(args.summary.files.rows.map((r) => [r[0], r[1], r[2], r[3], r[4], r[5], r[6]])).toEqual([
      ['a.csv', 'Load file', 'Supplier A', 'Converted', 10, 9, 0],
      ['b.csv', 'Load file', 'Supplier A', 'Converted with flags', 10, 9, 2],
      ['e.csv', 'ERP load', 'Supplier B', 'Converted', 10, 9, 0],
      ['c.csv', '', '', "Didn't match", null, null, 0],
      ['d.csv', 'Load file', 'Supplier A', 'Needs attention', null, null, 0],
      ['bad.csv', '', '', "Didn't match", null, null, 0],
    ]);
    expect(args.summary.flags.rows).toEqual([
      ['b.csv', 3, 'Qty', 'abc', "This isn't a whole number. We kept it as it is."],
      ['b.csv', 5, 'Qty', 'abc', "This isn't a whole number. We kept it as it is."],
    ]);
    expect(args.summary.files.rows[4]![7]).toBe("Load file uses 'Qty', which is not in this file. It cannot be made without 'Qty'.");

    // The downloads.
    fireEvent.click(screen.getByRole('button', { name: 'Download all (zip)' }));
    expect(downloaded).toHaveBeenLastCalledWith('formatAI batch.zip', expect.any(ArrayBuffer), 'application/zip');
    fireEvent.click(screen.getByRole('button', { name: 'Download the summary sheet' }));
    expect(downloaded).toHaveBeenLastCalledWith('formatAI batch summary.xlsx', expect.any(ArrayBuffer), expect.stringContaining('spreadsheetml'));
  });

  it('POST /runs per converted file carries counts only: no values, headers or file names', async () => {
    const api = fakeConvertApi({ user: PAID, entries });
    const { engine } = setup();
    renderConvert(<ConvertPage />, { api, engine });
    await addFiles([csvFile('a.csv', 'x'), csvFile('b.csv', 'x'), csvFile('e.csv', 'x'), csvFile('c.csv', 'x')]);
    fireEvent.click(await screen.findByRole('button', { name: 'Convert 4 files' }));
    await screen.findByTestId('batch-results');

    expect(api.recordRun.mock.calls).toEqual([
      ['c1', { rows: 10, flagged: 0 }],
      ['c1', { rows: 10, flagged: 2 }],
      ['c2', { rows: 10, flagged: 0 }],
    ]);
    // Nothing else the API was sent could carry data: a file name, a header, a cell value.
    const sent = JSON.stringify([api.recordRun.mock.calls, api.addAlias.mock.calls]);
    for (const secret of ['a.csv', 'b.csv', 'Item Code', 'Qty', 'abc', 'Supplier']) expect(sent).not.toContain(secret);
  });

  it('Stop keeps what was converted so far and drops the files it never reached', async () => {
    const api = fakeConvertApi({ user: PAID, entries });
    const { engine, convertWithDecisions } = setup();
    let stopNow: (() => void) | undefined;
    // Every file is read first; the second CONVERSION hangs until Stop.
    const converts = convertWithDecisions.getMockImplementation()!;
    convertWithDecisions.mockImplementationOnce(converts).mockImplementationOnce(
      () =>
        new Promise<ConvertRunOutput>((_resolve, reject) => {
          stopNow = () => reject(Object.assign(new Error('Cancelled'), { name: 'CancelledError' }));
        }),
    );
    renderConvert(<ConvertPage />, { api, engine });
    await addFiles([csvFile('a.csv', 'x'), csvFile('b.csv', 'x'), csvFile('e.csv', 'x')]);
    fireEvent.click(await screen.findByRole('button', { name: 'Convert 3 files' }));
    await waitFor(() => expect(stopNow).toBeDefined());
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    stopNow!();
    const results = await screen.findByTestId('batch-results');
    expect(results.textContent).toContain('Stopped.');
    expect(within(results).getAllByTestId('batch-file')).toHaveLength(1);
    expect(screen.getByTestId('batch-counts').textContent).toBe('1 converted · 0 with flags · 0 did not match');
  });
});

describe('a source that feeds several formats (SPEC 8.15)', () => {
  // One source, two formats: every file of this source is converted into BOTH, one item per (file, format).
  const feeds = sourceEntry({
    sourceId: 's1',
    name: 'Supplier A',
    conversions: [
      { conversionId: 'c1', formatId: 'F1', formatName: 'Load file' },
      { conversionId: 'c2', formatId: 'F2', formatName: 'ERP load' },
    ],
  });
  const other = entry({ conversionId: 'c3', sourceId: 's3', sourceName: 'Supplier C', formatId: 'F3', formatName: 'Ledger' });

  function setup(opts: { failC2?: boolean } = {}) {
    const matchFile = vi.fn(async (args: { file: { name: string } }): Promise<MatchFileOutput> => {
      const s = args.file.name === 'x.csv' ? 's3' : 's1';
      return { ok: true, headers: [], ranked: [], pick: { kind: 'auto', match: match({ id: s, name: s === 's3' ? 'Supplier C' : 'Supplier A' }) } };
    });
    const convertWithDecisions = vi.fn(async (args: { file: { name: string }; rules: { name?: string } }): Promise<ConvertRunOutput> => {
      if (opts.failC2 && args.rules.name === 'rules-c2') return { ok: false, error: { code: 'invalidRules' } };
      // b.csv has a flag in each format; the other files are clean.
      const flags = args.file.name === 'b.csv' ? [flag(3)] : [];
      return {
        ok: true,
        written: true,
        bytes: new ArrayBuffer(8),
        fileType: 'csv',
        flags,
        summary: { rowsIn: 10, rowsOut: 9, rowsFiltered: 0, duplicatesRemoved: [], duplicatesFlagged: 0, blockedRows: [] },
        preview: { name: 'Load', direction: 'ltr', language: 'en', columns: [], rows: [], merges: [] },
        totalRows: 0,
      };
    });
    const batch = vi.fn(async (_args: BatchArgs) => ({ zip: new ArrayBuffer(6), summary: new ArrayBuffer(4) }));
    const engine = { matchFile, columnGaps: vi.fn(realColumnGaps), convertWithDecisions, batch, terminate: vi.fn() } as unknown as EngineClient;
    const rulesById = { c1: { ...RULES, name: 'rules-c1' }, c2: { ...RULES, name: 'rules-c2' }, c3: { ...RULES, name: 'rules-c3' } };
    return { engine, matchFile, convertWithDecisions, batch, rulesById };
  }

  it('one file whose source feeds 2 formats gives 2 outputs, grouped by format, with a row per (file, format) in the summary', async () => {
    const { engine, matchFile, convertWithDecisions, batch, rulesById } = setup();
    const api = fakeConvertApi({ user: PAID, entries: [feeds, other], rulesById });
    renderConvert(<ConvertPage />, { api, engine });
    await addFiles([csvFile('a.csv', 'x'), csvFile('b.csv', 'x'), csvFile('x.csv', 'x')]);
    // (working, but never advertised: the page's text does not mention sources that feed several formats)
    expect(document.body.textContent).not.toMatch(/feeds several formats|all of them/);
    fireEvent.click(await screen.findByRole('button', { name: 'Convert 3 files' }));
    await answerAll();
    const results = await screen.findByTestId('batch-results');

    // The matcher was offered SOURCES (one signature per source), once per file.
    expect(matchFile.mock.calls[0]![0]).toMatchObject({ signatures: [{ id: 's1', name: 'Supplier A' }, { id: 's3', name: 'Supplier C' }] });
    expect(matchFile).toHaveBeenCalledTimes(3);
    // a and b go into both formats, x into one: 5 conversions in all.
    expect(convertWithDecisions).toHaveBeenCalledTimes(5);
    // 5 results in all: 3 clean and 2 with flags (each file counts once per format).
    expect(screen.getByTestId('batch-counts').textContent).toBe('3 converted · 2 with flags · 0 did not match');

    // Results stay grouped by format: each file appears under each format its source feeds.
    const groups = within(results).getAllByTestId(/group-/);
    expect(groups.map((g) => g.querySelector('h3')?.textContent)).toEqual(['Load file · 2 files', 'ERP load · 2 files', 'Ledger · 1 file']);
    const namesIn = (i: number) => within(groups[i]!).getAllByTestId('batch-file').map((r) => r.querySelector('.bfile__name')?.textContent);
    expect(namesIn(0)).toEqual(['a.csv', 'b.csv']);
    expect(namesIn(1)).toEqual(['a.csv', 'b.csv']);
    expect(namesIn(2)).toEqual(['x.csv']);

    // The rules of each conversion were fetched ONCE for the whole batch (a cache), not once per file.
    expect(api.conversion.mock.calls.map((c) => c[0]).sort()).toEqual(['c1', 'c2', 'c3']);

    // The zip: a folder per format; the summary: a row per (file, format).
    const args = batch.mock.calls[0]![0];
    expect(args.outputs.map((o) => [o.folder, o.fileName])).toEqual([
      ['Load file', 'a (converted).csv'],
      ['ERP load', 'a (converted).csv'],
      ['Load file', 'b (converted).csv'],
      ['ERP load', 'b (converted).csv'],
      ['Ledger', 'x (converted).csv'],
    ]);
    expect(args.summary.files.rows.map((r) => [r[0], r[1], r[2], r[3], r[6]])).toEqual([
      ['a.csv', 'Load file', 'Supplier A', 'Converted', 0],
      ['a.csv', 'ERP load', 'Supplier A', 'Converted', 0],
      ['b.csv', 'Load file', 'Supplier A', 'Converted with flags', 1],
      ['b.csv', 'ERP load', 'Supplier A', 'Converted with flags', 1],
      ['x.csv', 'Ledger', 'Supplier C', 'Converted', 0],
    ]);
    // A file made into several formats says which format each flag belongs to (the sheet keeps its five columns).
    expect(args.summary.flags.rows.map((r) => [r[0], r[1]])).toEqual([['b.csv (Load file)', 3], ['b.csv (ERP load)', 3]]);

    // POST /runs: once per converted (file, conversion), counts only.
    expect(api.recordRun.mock.calls).toEqual([
      ['c1', { rows: 10, flagged: 0 }],
      ['c2', { rows: 10, flagged: 0 }],
      ['c1', { rows: 10, flagged: 1 }],
      ['c2', { rows: 10, flagged: 1 }],
      ['c3', { rows: 10, flagged: 0 }],
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'Download all (zip)' }));
    expect(downloaded).toHaveBeenLastCalledWith('formatAI batch.zip', expect.any(ArrayBuffer), 'application/zip');
  });

  it('a format whose rules cannot run does not stop the file\'s other formats: it is listed as not converted, with the format named', async () => {
    const { engine, batch, rulesById } = setup({ failC2: true });
    const api = fakeConvertApi({ user: PAID, entries: [feeds], rulesById });
    renderConvert(<ConvertPage />, { api, engine });
    await addFiles([csvFile('a.csv', 'x')]);
    fireEvent.click(await screen.findByRole('button', { name: 'Convert 1 file' }));
    await answerAll();
    const results = await screen.findByTestId('batch-results');
    expect(screen.getByTestId('batch-counts').textContent).toBe('1 converted · 0 with flags · 1 did not match');
    const groups = within(results).getAllByTestId(/group-/);
    expect(groups.map((g) => g.querySelector('h3')?.textContent)).toEqual(['Load file · 1 file', "Didn't match · 1 file"]);
    // (The names inside sentences are wrapped in direction isolates; the words are what is checked here.)
    const failed = (within(groups[1]!).getByTestId('batch-file').textContent ?? '').replace(/[⁦-⁩]/g, '');
    expect(failed).toContain("The rules of Supplier A can't run on it.");
    expect(failed).toContain('For the format ERP load.');
    // Only what was converted is packed, and only it is reported.
    expect(batch.mock.calls[0]![0].outputs.map((o) => o.folder)).toEqual(['Load file']);
    expect(api.recordRun.mock.calls).toEqual([['c1', { rows: 10, flagged: 0 }]]);
    // The summary keeps a row for the format that failed, with why.
    expect(batch.mock.calls[0]![0].summary.files.rows.map((r) => [r[1], r[3]])).toEqual([['Load file', 'Converted'], ['ERP load', "Didn't match"]]);
  });

  it('a file that lacks a column every format of its source requires is converted into none of them: each says so under "Needs attention"', async () => {
    const { engine, matchFile, convertWithDecisions, rulesById } = setup();
    matchFile.mockImplementationOnce(async () => ({ ok: true, headers: ['Item Code', 'Price'], ranked: [], pick: { kind: 'auto', match: match({ id: 's1', score: 0.9, missingRequired: ['Qty'] }) } }) as MatchFileOutput);
    const api = fakeConvertApi({ user: PAID, entries: [feeds], rulesById });
    renderConvert(<ConvertPage />, { api, engine });
    await addFiles([csvFile('d.csv', 'x')]);
    fireEvent.click(await screen.findByRole('button', { name: 'Convert 1 file' }));
    await answerAll();
    await screen.findByTestId('batch-results');
    // One item per (file, format), each saying which column is missing; nothing was run or reported.
    const rows = screen.getAllByTestId('batch-file').map((r) => (r.textContent ?? '').replace(/[⁦-⁩]/g, ''));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain("Load file uses 'Qty', which is not in this file.");
    expect(rows[1]).toContain("ERP load uses 'Qty', which is not in this file.");
    expect(screen.getByTestId('batch-counts').textContent).toBe('0 converted · 0 with flags · 0 did not match · 2 need attention');
    expect(convertWithDecisions).not.toHaveBeenCalled();
    expect(api.recordRun).not.toHaveBeenCalled();
  });

  it('the progress counts FILES, not the (file, format) items a finished file becomes', async () => {
    const { engine, rulesById } = setup();
    const api = fakeConvertApi({ user: PAID, entries: [feeds], rulesById });
    renderConvert(<ConvertPage />, { api, engine });
    await addFiles([csvFile('a.csv', 'x'), csvFile('b.csv', 'x')]);
    expect(screen.getByTestId('batch-count').textContent).toBe('2 files');
    fireEvent.click(await screen.findByRole('button', { name: 'Convert 2 files' }));
    await answerAll();
    await screen.findByTestId('batch-results');
    // 4 items, 2 files.
    expect(within(screen.getByTestId('batch-results')).getAllByTestId('batch-file')).toHaveLength(4);
  });

  // SPEC 5 D (owner, 2026-10-08): two senders can use the same column names for different things, so a format made is one the user ticked.
  const formatBox = (name: string): HTMLInputElement => screen.getByRole('checkbox', { name: new RegExp(`^${name} ·`) }) as HTMLInputElement;

  it('reads every file first, then asks ONCE which formats to make: each with its file count, none ticked, Convert off until one is', async () => {
    const { engine, matchFile, convertWithDecisions, rulesById } = setup();
    const api = fakeConvertApi({ user: PAID, entries: [feeds, other], rulesById });
    renderConvert(<ConvertPage />, { api, engine });
    await addFiles([csvFile('a.csv', 'x'), csvFile('b.csv', 'x'), csvFile('x.csv', 'x')]);
    fireEvent.click(await screen.findByRole('button', { name: 'Convert 3 files' }));

    const step = await screen.findByTestId('batch-choose-formats');
    expect(step.textContent).toContain('Choose the formats to make');
    expect(matchFile).toHaveBeenCalledTimes(3);
    expect(convertWithDecisions).not.toHaveBeenCalled();
    expect(within(step).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['Load file · 2 files', 'ERP load · 2 files', 'Ledger · 1 file']);
    expect(['Load file', 'ERP load', 'Ledger'].map((n) => formatBox(n).checked)).toEqual([false, false, false]);
    expect((screen.getByRole('checkbox', { name: 'All formats' }) as HTMLInputElement).checked).toBe(false);
    expect((screen.getByRole('button', { name: 'Convert' }) as HTMLButtonElement).disabled).toBe(true);
    expect(step.textContent).toContain('Choose at least one format.');
    fireEvent.click(formatBox('Ledger'));
    expect((screen.getByRole('button', { name: 'Convert' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('makes only the ticked formats; a file none of whose formats was chosen is "Not made", in the list and the summary', async () => {
    const { engine, convertWithDecisions, batch, rulesById } = setup();
    const api = fakeConvertApi({ user: PAID, entries: [feeds, other], rulesById });
    renderConvert(<ConvertPage />, { api, engine });
    await addFiles([csvFile('a.csv', 'x'), csvFile('b.csv', 'x'), csvFile('x.csv', 'x')]);
    fireEvent.click(await screen.findByRole('button', { name: 'Convert 3 files' }));
    await screen.findByTestId('batch-choose-formats');
    fireEvent.click(formatBox('ERP load'));
    fireEvent.click(screen.getByRole('button', { name: 'Convert' }));

    await screen.findByTestId('batch-results');
    const ran = convertWithDecisions.mock.calls.map((c) => [(c[0] as { file: { name: string } }).file.name, (c[0] as { rules: { name?: string } }).rules.name]);
    expect(ran).toEqual([
      ['a.csv', 'rules-c2'],
      ['b.csv', 'rules-c2'],
    ]);
    expect(screen.getByTestId('batch-counts').textContent).toBe('1 converted · 1 with flags · 0 did not match · 1 not made');
    const notMade = screen.getByTestId('group-notchosen');
    expect(notMade.textContent).toContain('x.csv');
    expect(notMade.textContent).toContain('It fits none of the formats you chose.');
    const files = batch.mock.calls[0]![0].summary.files.rows;
    expect(files.find((r) => r[0] === 'x.csv')?.slice(0, 4)).toEqual(['x.csv', '', 'Supplier C', 'Not made']);
    expect(batch.mock.calls[0]![0].outputs.map((o) => o.folder)).toEqual(['ERP load', 'ERP load']);
  });

  it('"Back" converts nothing and keeps the files in the list', async () => {
    const { engine, convertWithDecisions, rulesById } = setup();
    const api = fakeConvertApi({ user: PAID, entries: [feeds], rulesById });
    renderConvert(<ConvertPage />, { api, engine });
    await addFiles([csvFile('a.csv', 'x'), csvFile('b.csv', 'x')]);
    fireEvent.click(await screen.findByRole('button', { name: 'Convert 2 files' }));
    await screen.findByTestId('batch-choose-formats');
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(await screen.findByRole('button', { name: 'Convert 2 files' })).toBeTruthy();
    expect(screen.getAllByTestId('batch-file')).toHaveLength(2);
    expect(convertWithDecisions).not.toHaveBeenCalled();
    expect(api.recordRun).not.toHaveBeenCalled();
  });

  it('Stop while the files are read converts nothing: the list is back as it was', async () => {
    const { engine, matchFile, convertWithDecisions, rulesById } = setup();
    const api = fakeConvertApi({ user: PAID, entries: [feeds], rulesById });
    let stopNow: (() => void) | undefined;
    const reads = matchFile.getMockImplementation()!;
    matchFile.mockImplementationOnce(reads).mockImplementationOnce(
      () =>
        new Promise<MatchFileOutput>((_resolve, reject) => {
          stopNow = () => reject(Object.assign(new Error('Cancelled'), { name: 'CancelledError' }));
        }),
    );
    renderConvert(<ConvertPage />, { api, engine });
    await addFiles([csvFile('a.csv', 'x'), csvFile('b.csv', 'x')]);
    fireEvent.click(await screen.findByRole('button', { name: 'Convert 2 files' }));
    await waitFor(() => expect(stopNow).toBeDefined());
    expect(screen.getByTestId('batch-progress').textContent).toBe('Reading file 2 of 2');
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    stopNow!();
    expect(await screen.findByRole('button', { name: 'Convert 2 files' })).toBeTruthy();
    expect(screen.getAllByTestId('batch-file')).toHaveLength(2);
    expect(convertWithDecisions).not.toHaveBeenCalled();
  });
});

describe('formats that need attention, file by file (SPEC 21 v11 items 4-7)', () => {
  /** A format that also reads "Supplier SKU" (optional: it had empty cells in the example) and needs only "Item Code". */
  const REPORT_RULES = {
    ...RULES,
    name: 'rules-report',
    input: {
      ...RULES.input,
      columns: [
        { id: 'c_code', header: 'Item Code', type: 'idLike' as const, required: true },
        { id: 'c_sku', header: 'Supplier SKU', type: 'text' as const },
        { id: 'c_notes', header: 'Notes', type: 'text' as const },
      ],
    },
    output: { ...RULES.output, columns: [{ header: 'Code', from: 'c_code' }, { header: 'SKU', from: 'c_sku' }] },
    validations: [],
  };
  const feeds = sourceEntry({
    sourceId: 's1',
    name: 'Supplier A',
    conversions: [
      { conversionId: 'c1', formatId: 'F1', formatName: 'Load file' },
      { conversionId: 'c2', formatId: 'F2', formatName: 'Management report' },
    ],
  });
  const rulesById = { c1: { ...RULES, name: 'rules-c1' }, c2: REPORT_RULES };
  const plain = (el: Element | null | undefined): string => (el?.textContent ?? '').replace(/[⁦-⁩]/g, '');

  function setup(unlikeFor?: (file: string, rules: string) => boolean) {
    // a.csv has no "Supplier SKU" (and no "Notes"); b.csv has the lot.
    const headersOf = (name: string): string[] => (name === 'b.csv' ? ['Item Code', 'Qty', 'Price', 'Supplier SKU', 'Notes'] : ['Item Code', 'Qty', 'Price']);
    const matchFile = vi.fn(async (args: { file: { name: string } }): Promise<MatchFileOutput> => ({ ok: true, headers: headersOf(args.file.name), ranked: [], pick: { kind: 'auto', match: match({ id: 's1' }) } }));
    const convertWithDecisions = vi.fn(async (args: { file: { name: string }; rules: { name?: string } }): Promise<ConvertRunOutput> => ({
      ok: true,
      written: true,
      bytes: new ArrayBuffer(8),
      fileType: 'csv',
      flags: [],
      summary: { rowsIn: 10, rowsOut: 10, rowsFiltered: 0, duplicatesRemoved: [], duplicatesFlagged: 0, blockedRows: [] },
      preview: { name: 'Load', direction: 'ltr', language: 'en', columns: [], rows: [], merges: [] },
      totalRows: 0,
      ...(unlikeFor?.(args.file.name, args.rules.name ?? '') ? { unlike: [{ id: 'c_qty', header: 'Qty', type: 'integer' as const, rows: 10 }] } : {}),
    }));
    const batch = vi.fn(async (_args: BatchArgs) => ({ zip: new ArrayBuffer(6), summary: new ArrayBuffer(4) }));
    const engine = { matchFile, columnGaps: vi.fn(realColumnGaps), convertWithDecisions, batch, terminate: vi.fn() } as unknown as EngineClient;
    return { engine, convertWithDecisions, batch };
  }

  it('per file and per format: the format that needs a missing column is "needs attention" in the file\'s result and the summary, and the others are converted', async () => {
    const { engine, convertWithDecisions, batch } = setup();
    const api = fakeConvertApi({ user: PAID, entries: [feeds], rulesById });
    renderConvert(<ConvertPage />, { api, engine });
    await addFiles([csvFile('a.csv', 'x'), csvFile('b.csv', 'x')]);
    fireEvent.click(await screen.findByRole('button', { name: 'Convert 2 files' }));
    await answerAll();
    const results = await screen.findByTestId('batch-results');

    // a.csv: the load file is made, the report is not (it uses "Supplier SKU"). b.csv: both.
    expect(convertWithDecisions.mock.calls.map((c) => [(c[0] as { file: { name: string } }).file.name, (c[0] as { rules: { name?: string } }).rules.name])).toEqual([
      ['a.csv', 'rules-c1'],
      ['b.csv', 'rules-c1'],
      ['b.csv', 'rules-report'],
    ]);
    expect(screen.getByTestId('batch-counts').textContent).toBe('3 converted · 0 with flags · 0 did not match · 1 need attention');
    const groups = within(results).getAllByTestId(/group-/);
    expect(groups.map((g) => g.querySelector('h3')?.textContent)).toEqual(['Load file · 2 files', 'Management report · 1 file', 'Needs attention · 1 file']);
    const row = within(groups[2]!).getByTestId('batch-file');
    expect(row.getAttribute('data-status')).toBe('needsAttention');
    expect(plain(row)).toContain('a.csv');
    expect(plain(row)).toContain('Needs attention');
    expect(plain(row)).toContain("Management report uses 'Supplier SKU', which is not in this file.");

    // Only what was converted is packed and reported; the summary has a line for the format that was not made, with the columns.
    const args = batch.mock.calls[0]![0];
    expect(args.outputs.map((o) => [o.folder, o.fileName])).toEqual([['Load file', 'a (converted).csv'], ['Load file', 'b (converted).csv'], ['Management report', 'b (converted).csv']]);
    expect(args.summary.files.rows.map((r) => [r[0], r[1], r[3]])).toEqual([
      ['a.csv', 'Load file', 'Converted'],
      ['a.csv', 'Management report', 'Needs attention'],
      ['b.csv', 'Load file', 'Converted'],
      ['b.csv', 'Management report', 'Converted'],
    ]);
    expect(args.summary.files.rows[1]![7]).toBe("Management report uses 'Supplier SKU', which is not in this file.");
    expect(api.recordRun.mock.calls.map((c) => c[0])).toEqual(['c1', 'c1', 'c2']);
  });

  it('a declared column nothing uses may be missing from the file: the format is converted (a.csv has no "Notes")', async () => {
    const { engine } = setup();
    const api = fakeConvertApi({ user: PAID, entries: [feeds], rulesById });
    renderConvert(<ConvertPage />, { api, engine });
    await addFiles([csvFile('a.csv', 'x'), csvFile('b.csv', 'x')]);
    fireEvent.click(await screen.findByRole('button', { name: 'Convert 2 files' }));
    await answerAll();
    const results = await screen.findByTestId('batch-results');
    // Nothing about "Notes" anywhere.
    expect(plain(results)).not.toContain('Notes');
  });

  it('"same name, different meaning": a format whose used column did not parse is withheld from the zip with the others converted', async () => {
    const { engine, batch } = setup((file, rules) => file === 'a.csv' && rules === 'rules-c1');
    const api = fakeConvertApi({ user: PAID, entries: [feeds], rulesById });
    renderConvert(<ConvertPage />, { api, engine });
    await addFiles([csvFile('a.csv', 'x'), csvFile('b.csv', 'x')]);
    fireEvent.click(await screen.findByRole('button', { name: 'Convert 2 files' }));
    await answerAll();
    const results = await screen.findByTestId('batch-results');
    expect(screen.getByTestId('batch-counts').textContent).toBe('2 converted · 0 with flags · 0 did not match · 2 need attention');
    const attention = within(results).getByTestId('group-attention');
    expect(plain(attention)).toContain("The values in 'Qty' don't look like before (expected a whole number).");
    expect(plain(attention)).toContain("Management report uses 'Supplier SKU', which is not in this file.");
    // The withheld file is not in the zip, and nothing is reported for it.
    expect(batch.mock.calls[0]![0].outputs.map((o) => [o.folder, o.fileName])).toEqual([['Load file', 'b (converted).csv'], ['Management report', 'b (converted).csv']]);
    expect(api.recordRun.mock.calls.map((c) => c[0])).toEqual(['c1', 'c2']);
  });
});

describe('the real worker: one source, two formats', () => {
  it('converts a real file into both formats: a folder per format in the zip, a row per (file, format) in the workbook', async () => {
    const RULES_ERP = { ...RULES, name: 'ERP rules', output: { ...RULES.output, columns: [{ header: 'Item', from: 'c_code' }, { header: 'Amount', from: 'c_qty' }] } };
    const feeds = sourceEntry({
      sourceId: 's1',
      name: 'Supplier A',
      conversions: [
        { conversionId: 'c1', formatId: 'F1', formatName: 'Load file' },
        { conversionId: 'c2', formatId: 'F2', formatName: 'ERP load' },
      ],
    });
    const api = fakeConvertApi({ user: PAID, entries: [feeds], rulesById: { c1: RULES, c2: RULES_ERP } });
    const engine = createEngineClient({ createWorker: () => loopbackWorker(engineMethods) });
    renderConvert(<ConvertPage />, { api, engine });
    await addFiles([csvFile('jan.csv', SUPPLIER_A_CLEAN_CSV)]);
    fireEvent.click(await screen.findByRole('button', { name: 'Convert 1 file' }));
    await answerAll();
    await screen.findByRole('button', { name: 'Download all (zip)' }, { timeout: 15000 });
    expect(screen.getByTestId('batch-counts').textContent).toBe('2 converted · 0 with flags · 0 did not match');

    fireEvent.click(screen.getByRole('button', { name: 'Download all (zip)' }));
    const zip = downloaded.mock.calls.at(-1)![1] as ArrayBuffer;
    const inZip = await readZip(zip);
    expect(inZip.map((e) => e.path)).toEqual(['Load file/jan (converted).csv', 'ERP load/jan (converted).csv', 'formatAI batch summary.xlsx']);
    const text = (e: { bytes: Uint8Array | ArrayBuffer }) => new TextDecoder().decode(e.bytes instanceof Uint8Array ? e.bytes : new Uint8Array(e.bytes));
    expect(text(inZip[0]!)).toContain('Unit price');
    expect(text(inZip[1]!)).toContain('Item');
    expect(text(inZip[1]!)).not.toContain('Unit price');

    const sheet = await readWorkbook(inZip[2]!.bytes as Uint8Array, 'summary.xlsx');
    const files = sheet.sheets[0]!.rows.map((r) => r.map((c) => c?.v ?? null));
    expect(files).toEqual([
      ['File', 'Format', 'Source', 'Status', 'Rows in', 'Rows out', 'Flagged rows', 'Note'],
      ['jan.csv', 'Load file', 'Supplier A', 'Converted', 3, 3, 0, ''],
      ['jan.csv', 'ERP load', 'Supplier A', 'Converted', 3, 3, 0, ''],
    ]);
    expect(api.recordRun.mock.calls).toEqual([['c1', { rows: 3, flagged: 0 }], ['c2', { rows: 3, flagged: 0 }]]);
  }, 30000);
});

describe('the real worker: the zip and the summary sheet', () => {
  it('converts real files one at a time and hands back a zip (a folder per format) and a workbook of files and flags', async () => {
    const api = fakeConvertApi({ user: PAID, entries: [entry({ conversionId: 'c1' })] });
    const engine = createEngineClient({ createWorker: () => loopbackWorker(engineMethods) });
    renderConvert(<ConvertPage />, { api, engine });
    await addFiles([csvFile('jan.csv', SUPPLIER_A_CLEAN_CSV), csvFile('feb.csv', SUPPLIER_A_CSV), csvFile('other.csv', 'Foo,Bar\n1,2\n3,4\n')]);
    fireEvent.click(await screen.findByRole('button', { name: 'Convert 3 files' }));
    await screen.findByRole('button', { name: 'Download all (zip)' }, { timeout: 15000 });
    expect(screen.getByTestId('batch-counts').textContent).toBe('1 converted · 1 with flags · 1 did not match');

    fireEvent.click(screen.getByRole('button', { name: 'Download all (zip)' }));
    const zip = downloaded.mock.calls.at(-1)![1] as ArrayBuffer;
    const entriesInZip = await readZip(zip);
    expect(entriesInZip.map((e) => e.path)).toEqual(['Load file/jan (converted).csv', 'Load file/feb (converted).csv', 'formatAI batch summary.xlsx']);
    const text = (e: { bytes: Uint8Array | ArrayBuffer }) => new TextDecoder().decode(e.bytes instanceof Uint8Array ? e.bytes : new Uint8Array(e.bytes));
    expect(text(entriesInZip[0]!)).toContain('00002');
    expect(text(entriesInZip[1]!)).toContain('abc');

    const sheet = await readWorkbook(entriesInZip[2]!.bytes as Uint8Array, 'summary.xlsx');
    expect(sheet.sheets.map((s) => s.name)).toEqual(['Files', 'Flags']);
    const table = (i: number) => sheet.sheets[i]!.rows.map((r) => r.map((c) => c?.v ?? null));
    expect(table(0)).toEqual([
      ['File', 'Format', 'Source', 'Status', 'Rows in', 'Rows out', 'Flagged rows', 'Note'],
      ['jan.csv', 'Load file', 'Supplier A', 'Converted', 3, 3, 0, ''],
      ['feb.csv', 'Load file', 'Supplier A', 'Converted with flags', 3, 3, 1, ''],
      ['other.csv', '', '', "Didn't match", null, null, 0, "It doesn't look like any of your sources."],
    ]);
    const flags = table(1);
    expect(flags[0]).toEqual(['File', 'Row', 'Column', 'Value', 'Message']);
    expect(flags.slice(1).map((r) => [r[0], r[1], r[2]])).toEqual(expect.arrayContaining([['feb.csv', 3, 'Qty'], ['feb.csv', 3, 'Item Code']]));
    // The API heard only counts.
    expect(api.recordRun.mock.calls).toEqual([['c1', { rows: 3, flagged: 0 }], ['c1', { rows: 3, flagged: 1 }]]);
  }, 30000);
});
