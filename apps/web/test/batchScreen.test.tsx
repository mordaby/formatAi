// The Batch screen (SPEC 5 D, 11): gated by tier (paid only; the files per run come from the tier), one file at a time in the
// worker, each file matched on its own (auto-pick only), a status per file, results grouped by format, a zip and a summary
// sheet, and counts-only reports to the API. The last test runs the real worker methods and opens the zip and the sheet.
import { readWorkbook, readZip, type Flag } from '@formatai/engine';
import { tiers } from '@formatai/shared';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { webConfig } from '../src/config';
import BatchPage from '../src/pages/Batch';
import type { BatchArgs, ConvertRunOutput, MatchFileOutput } from '../src/worker/convertApi';
import { createEngineClient, type EngineClient } from '../src/worker/engineClient';
import { engineMethods } from '../src/worker/engineMethods';
import { loopbackWorker } from './helpers/loopback';
import { csvFile, entry, fakeConvertApi, match, PAID, renderConvert, REGISTERED, SUPPLIER_A_CLEAN_CSV, SUPPLIER_A_CSV } from './helpers/convertKit';

const { signInOpen, downloaded } = vi.hoisted(() => ({ signInOpen: vi.fn(), downloaded: vi.fn() }));
vi.mock('../src/app/SignIn', () => ({ useSignIn: () => ({ open: signInOpen, close: vi.fn() }) }));
vi.mock('../src/flow/download', async (orig) => ({ ...(await orig<typeof import('../src/flow/download')>()), downloadBytes: downloaded }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const flag = (rowNumber: number): Flag => ({ rowNumber, column: 'c_qty', rule: 'type', value: 'abc', messageKey: 'flag.parseFailed.integer' });

async function addFiles(files: File[]) {
  const input = (await screen.findByTestId('batch-input')) as HTMLInputElement;
  await act(async () => {
    fireEvent.change(input, { target: { files } });
  });
}

describe('who can run a batch', () => {
  it('signed out: the sign-in wall, and what Batch does is still shown', async () => {
    renderConvert(<BatchPage />, { api: fakeConvertApi({ user: null }), engine: {} as EngineClient, route: '/batch' });
    expect(await screen.findByText('Sign in to run a batch')).toBeTruthy();
    expect(screen.getByText('Convert many files in one go. Each file is matched to its own source, and you download one zip.')).toBeTruthy();
    expect(screen.queryByTestId('batch-input')).toBeNull();
  });

  it('registered (not paid): what it does, the paid limit, an Upgrade prompt - and no way to run one', async () => {
    const api = fakeConvertApi({ user: REGISTERED });
    renderConvert(<BatchPage />, { api, engine: {} as EngineClient, route: '/batch' });
    expect(await screen.findByText('Batch is part of the paid plan')).toBeTruthy();
    expect(screen.getByText(/Convert up to 50 files in one run/)).toBeTruthy();
    expect(screen.getByText('You get a zip with the converted files, grouped by format, and a summary sheet of every flag.')).toBeTruthy();
    // Upgrade opens the shared panel (no payment code in the MVP): a contact address.
    fireEvent.click(screen.getByRole('button', { name: 'Upgrade' }));
    expect(screen.getByRole('link', { name: /contact/i }).getAttribute('href')).toBe(webConfig.contactHref);
    expect(screen.queryByTestId('batch-input')).toBeNull();
    // A registered user converts one file at a time, so the sources are not even loaded here.
    expect(api.signatures).not.toHaveBeenCalled();
  });

  it('paid: the drop zone takes up to the files per run of the tier, and says when more were dropped', async () => {
    renderConvert(<BatchPage />, { api: fakeConvertApi({ user: PAID }), engine: {} as EngineClient, route: '/batch' });
    const limit = tiers.paid.filesPerRun;
    await addFiles(Array.from({ length: limit + 3 }, (_, i) => csvFile(`f${i}.csv`, SUPPLIER_A_CLEAN_CSV)));
    expect(await screen.findByText(`${limit} files`)).toBeTruthy();
    expect(screen.getAllByTestId('batch-file')).toHaveLength(limit);
    expect(screen.getByText(`Your plan takes up to ${limit} files in one run. The first ${limit} were added.`)).toBeTruthy();
    expect(screen.getByRole('button', { name: `Convert ${limit} files` })).toBeTruthy();
  });

  it('turns away files it cannot read and files already added', async () => {
    renderConvert(<BatchPage />, { api: fakeConvertApi({ user: PAID }), engine: {} as EngineClient, route: '/batch' });
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
        const auto = (id: string, extra = {}): MatchFileOutput => ({ ok: true, headers: [], ranked: [], pick: { kind: 'auto', match: match({ id, name: id === 'c1' ? 'Supplier A' : 'Supplier B', ...extra }) } });
        if (name === 'a.csv' || name === 'b.csv') return auto('c1');
        if (name === 'e.csv') return auto('c2');
        if (name === 'd.csv') return auto('c1', { score: 0.9, missingRequired: ['Qty'] });
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
    const engine = { matchFile, convertWithDecisions, batch, terminate: vi.fn() } as unknown as EngineClient;
    return { engine, matchFile, convertWithDecisions, batch, order, max: () => maxInFlight };
  }

  it('matches each file on its own, gives each a status, groups by format, and packs a zip and a summary', async () => {
    const api = fakeConvertApi({ user: PAID, entries });
    const { engine, order, max, batch, convertWithDecisions } = setup();
    renderConvert(<BatchPage />, { api, engine, route: '/batch' });
    await addFiles([csvFile('a.csv', 'x'), csvFile('b.csv', 'x'), csvFile('e.csv', 'x'), csvFile('c.csv', 'x'), csvFile('d.csv', 'x'), csvFile('bad.csv', 'x')]);
    fireEvent.click(await screen.findByRole('button', { name: 'Convert 6 files' }));

    const results = await screen.findByTestId('batch-results');
    // One at a time, in the order the files were added.
    expect(order).toEqual(['a.csv', 'b.csv', 'e.csv', 'c.csv', 'd.csv', 'bad.csv']);
    expect(max()).toBe(1);
    // Only files that matched clearly were converted (c.csv was ambiguous, d.csv lacks a column, bad.csv is unreadable).
    expect(convertWithDecisions.mock.calls.map((c) => (c[0] as { file: { name: string } }).file.name)).toEqual(['a.csv', 'b.csv', 'e.csv']);

    expect(screen.getByTestId('batch-counts').textContent).toBe('2 converted · 1 with flags · 3 did not match');

    // Grouped by format, each file with its status; the ones that didn't match say why.
    const groups = within(results).getAllByTestId(/group-/);
    expect(groups.map((g) => g.querySelector('h3')?.textContent)).toEqual(['Load file · 2 files', 'ERP load · 1 file', "Didn't match · 3 files"]);
    const row = (name: string) => within(results).getAllByTestId('batch-file').find((r) => r.textContent?.includes(name))!;
    expect(row('a.csv').getAttribute('data-status')).toBe('converted');
    expect(row('a.csv').textContent).toContain('Converted');
    expect(row('b.csv').getAttribute('data-status')).toBe('convertedFlags');
    expect(row('b.csv').textContent).toContain('Converted with flags');
    expect(row('b.csv').textContent).toContain('2 flagged rows');
    expect(row('c.csv').textContent).toContain("Didn't match");
    expect(row('c.csv').textContent).toContain('More than one source fits');
    expect(row('d.csv').textContent).toContain('Missing columns:');
    expect(row('d.csv').textContent).toContain('Qty');
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
      ['d.csv', '', '', "Didn't match", null, null, 0],
      ['bad.csv', '', '', "Didn't match", null, null, 0],
    ]);
    expect(args.summary.flags.rows).toEqual([
      ['b.csv', 3, 'Qty', 'abc', "This isn't a whole number. We kept it as it is."],
      ['b.csv', 5, 'Qty', 'abc', "This isn't a whole number. We kept it as it is."],
    ]);
    expect(args.summary.files.rows[4]![7]).toBe('Missing columns: Qty');

    // The downloads.
    fireEvent.click(screen.getByRole('button', { name: 'Download all (zip)' }));
    expect(downloaded).toHaveBeenLastCalledWith('formatAI batch.zip', expect.any(ArrayBuffer), 'application/zip');
    fireEvent.click(screen.getByRole('button', { name: 'Download the summary sheet' }));
    expect(downloaded).toHaveBeenLastCalledWith('formatAI batch summary.xlsx', expect.any(ArrayBuffer), expect.stringContaining('spreadsheetml'));
  });

  it('POST /runs per converted file carries counts only: no values, headers or file names', async () => {
    const api = fakeConvertApi({ user: PAID, entries });
    const { engine } = setup();
    renderConvert(<BatchPage />, { api, engine, route: '/batch' });
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
    const { engine, matchFile } = setup();
    let stopNow: (() => void) | undefined;
    matchFile.mockImplementationOnce(async () => ({ ok: true, headers: [], ranked: [], pick: { kind: 'auto', match: match({ id: 'c1' }) } }) as MatchFileOutput);
    matchFile.mockImplementationOnce(
      () =>
        new Promise<MatchFileOutput>((_resolve, reject) => {
          stopNow = () => reject(Object.assign(new Error('Cancelled'), { name: 'CancelledError' }));
        }),
    );
    renderConvert(<BatchPage />, { api, engine, route: '/batch' });
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

describe('the real worker: the zip and the summary sheet', () => {
  it('converts real files one at a time and hands back a zip (a folder per format) and a workbook of files and flags', async () => {
    const api = fakeConvertApi({ user: PAID, entries: [entry({ conversionId: 'c1' })] });
    const engine = createEngineClient({ createWorker: () => loopbackWorker(engineMethods) });
    renderConvert(<BatchPage />, { api, engine, route: '/batch' });
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
