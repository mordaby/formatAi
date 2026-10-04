// The Run screen (SPEC 5 C and D, 11, 21 v11): one screen at /convert for every plan that has saved formats. The plan decides how many
// files fit (`tiers[tier].filesPerRun`); one dropped file is the Convert flow (matching, row review, download), several are the batch
// (a list, a status per file, a zip). `?format=` scopes both, and files over the plan's limit are cut with a message. (/batch, now only
// a way here, is in batchRedirect.test.)
import { tiers } from '@formatai/shared';
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ConvertPage from '../src/pages/Convert';
import { webConfig } from '../src/config';
import type { BatchArgs, ConvertRunOutput, MatchFileArgs, MatchFileOutput } from '../src/worker/convertApi';
import type { EngineClient } from '../src/worker/engineClient';
import { csvFile, entry, fakeConvertApi, match, PAID, renderConvert, REGISTERED, sourceEntry, SUPPLIER_A_CLEAN_CSV } from './helpers/convertKit';

const { signInOpen, downloaded } = vi.hoisted(() => ({ signInOpen: vi.fn(), downloaded: vi.fn() }));
vi.mock('../src/app/SignIn', async (orig) => ({ ...(await orig<typeof import('../src/app/SignIn')>()), useSignIn: () => ({ open: signInOpen, close: vi.fn() }) }));
vi.mock('../src/flow/download', async (orig) => ({ ...(await orig<typeof import('../src/flow/download')>()), downloadBytes: downloaded }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const written: ConvertRunOutput = {
  ok: true,
  written: true,
  bytes: new ArrayBuffer(8),
  fileType: 'csv',
  flags: [],
  summary: { rowsIn: 3, rowsOut: 3, rowsFiltered: 0, duplicatesRemoved: [], duplicatesFlagged: 0, blockedRows: [] },
  preview: { name: 'Load', direction: 'ltr', language: 'en', columns: [{ header: 'Code' }], rows: [{ kind: 'header', cells: [{ v: 'Code' }] }], merges: [] },
  totalRows: 1,
};

/** A fake worker: the matcher picks the first source it was offered, every run writes a file. */
function fakeEngine() {
  const matchFile = vi.fn(async (args: MatchFileArgs): Promise<MatchFileOutput> => ({ ok: true, headers: [], ranked: [], pick: { kind: 'auto', match: match({ id: args.signatures[0]?.id ?? 'c1' }) } }));
  const convertWithDecisions = vi.fn(async (_args: unknown): Promise<ConvertRunOutput> => written);
  const batch = vi.fn(async (_args: BatchArgs) => ({ zip: new ArrayBuffer(6), summary: new ArrayBuffer(4) }));
  const engine = { matchFile, convertWithDecisions, batch, terminate: vi.fn() } as unknown as EngineClient;
  return { engine, matchFile, convertWithDecisions, batch };
}

const files = (n: number): File[] => Array.from({ length: n }, (_, i) => csvFile(`f${i}.csv`, SUPPLIER_A_CLEAN_CSV));

async function drop(list: File[], label = 'Files to convert') {
  const input = await screen.findByLabelText(label);
  await act(async () => {
    fireEvent.change(input, { target: { files: list } });
  });
}

describe('how many files the plan takes', () => {
  it('is 1 for a visitor, 5 for a registered user and 50 for a paid account (config only)', () => {
    expect([tiers.anonymous.filesPerRun, tiers.registered.filesPerRun, tiers.paid.filesPerRun]).toEqual([1, 5, 50]);
  });

  it.each([
    ['registered', REGISTERED, tiers.registered.filesPerRun],
    ['paid', PAID, tiers.paid.filesPerRun],
  ])('%s: the lead and the drop zone say how many, and the zone takes several', async (_tier, user, n) => {
    renderConvert(<ConvertPage />, { api: fakeConvertApi({ user }), engine: fakeEngine().engine });
    expect(await screen.findByText(`Drop a file, or up to ${n} at once. We find which of your sources each one is and make it into its format.`)).toBeTruthy();
    expect(((await screen.findByLabelText('Files to convert')) as HTMLInputElement).multiple).toBe(true);
    expect(screen.getByText(`Up to ${n} files, from any of your sources`)).toBeTruthy();
  });

  it('a plan of one file gets the single-file lead and a zone that takes one file', async () => {
    const saved = tiers.registered.filesPerRun;
    tiers.registered.filesPerRun = 1;
    try {
      renderConvert(<ConvertPage />, { api: fakeConvertApi({ user: REGISTERED }), engine: fakeEngine().engine });
      expect(await screen.findByText('Drop a file. We find which of your sources it is and make it into its format.')).toBeTruthy();
      expect(((await screen.findByLabelText('File to convert')) as HTMLInputElement).multiple).toBe(false);
      expect(screen.queryByText(/Paid plans run/)).toBeNull();
    } finally {
      tiers.registered.filesPerRun = saved;
    }
  });

  it('a registered user is not shown an upgrade wall any more: Batch is not paid-only', async () => {
    renderConvert(<ConvertPage />, { api: fakeConvertApi({ user: REGISTERED }), engine: fakeEngine().engine });
    expect(await screen.findByLabelText('Files to convert')).toBeTruthy();
    expect(screen.queryByText('Batch is part of the paid plan')).toBeNull();
  });

  it.each([
    ['registered', REGISTERED, tiers.registered.filesPerRun],
    ['paid', PAID, tiers.paid.filesPerRun],
  ])('%s: more files than that are cut to the first N, with the over-limit message', async (_tier, user, n) => {
    renderConvert(<ConvertPage />, { api: fakeConvertApi({ user }), engine: fakeEngine().engine });
    await drop(files(n + 2));
    expect(await screen.findAllByTestId('batch-file')).toHaveLength(n);
    // (the first N, in the order they were dropped)
    expect(screen.getAllByTestId('batch-file')[n - 1]!.textContent).toContain(`f${n - 1}.csv`);
    expect(screen.queryByText(`f${n}.csv`)).toBeNull();
    expect(screen.getByText(`Your plan takes up to ${n} files in one run. The first ${n} were added.`)).toBeTruthy();
    expect(screen.getByRole('button', { name: `Convert ${n} files` })).toBeTruthy();
  });

  it('registered: the over-limit message adds one line about what paid plans run, with the existing Upgrade path', async () => {
    renderConvert(<ConvertPage />, { api: fakeConvertApi({ user: REGISTERED }), engine: fakeEngine().engine });
    await drop(files(tiers.registered.filesPerRun + 1));
    expect(await screen.findByText(new RegExp(`Paid plans run up to ${tiers.paid.filesPerRun} files at once`))).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Upgrade' }));
    expect(screen.getByRole('link', { name: /contact/i }).getAttribute('href')).toBe(webConfig.contactHref);
  });

  it('paid: nothing about upgrading, and nothing over-limit while the files fit', async () => {
    renderConvert(<ConvertPage />, { api: fakeConvertApi({ user: PAID }), engine: fakeEngine().engine });
    await drop(files(tiers.registered.filesPerRun + 1));
    expect(await screen.findAllByTestId('batch-file')).toHaveLength(tiers.registered.filesPerRun + 1);
    expect(screen.queryByText(/Your plan takes up to/)).toBeNull();
    expect(screen.queryByText(/Paid plans run/)).toBeNull();
  });
});

describe('one file or several', () => {
  it('one file is the Convert flow: matched at once, no batch list', async () => {
    const { engine, matchFile, convertWithDecisions, batch } = fakeEngine();
    renderConvert(<ConvertPage />, { api: fakeConvertApi(), engine });
    await drop(files(1));
    expect(await screen.findByText('Your file is ready')).toBeTruthy();
    expect(matchFile).toHaveBeenCalledTimes(1);
    expect(convertWithDecisions.mock.calls[0]![0]).toMatchObject({ mode: 'review' });
    expect(screen.queryByTestId('batch-list')).toBeNull();
    expect(batch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Download the file' }));
    expect(downloaded).toHaveBeenCalledWith('f0 (converted).csv', expect.any(ArrayBuffer), 'text/csv');
  });

  it('one file stays the Convert flow even when the plan takes several', async () => {
    const { engine } = fakeEngine();
    renderConvert(<ConvertPage />, { api: fakeConvertApi({ user: PAID }), engine });
    await drop(files(1));
    expect(await screen.findByText('Your file is ready')).toBeTruthy();
    expect(screen.queryByTestId('batch-list')).toBeNull();
  });

  it('several files are the batch: a list first (nothing is matched yet), then one status per file and a zip', async () => {
    const { engine, matchFile, convertWithDecisions, batch } = fakeEngine();
    renderConvert(<ConvertPage />, { api: fakeConvertApi(), engine });
    await drop(files(3));
    expect(await screen.findAllByTestId('batch-file')).toHaveLength(3);
    expect(screen.getByTestId('batch-count').textContent).toBe('3 files');
    expect(matchFile).not.toHaveBeenCalled();
    expect(screen.queryByText('Your file is ready')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Convert 3 files' }));
    const results = await screen.findByTestId('batch-results');
    expect(matchFile).toHaveBeenCalledTimes(3);
    expect(convertWithDecisions).toHaveBeenCalledTimes(3);
    expect(convertWithDecisions.mock.calls.map((c) => (c[0] as { mode: string }).mode)).toEqual(['write', 'write', 'write']);
    expect(screen.getByTestId('batch-counts').textContent).toBe('3 converted · 0 with flags · 0 did not match');
    expect(within(results).getAllByTestId('batch-file')).toHaveLength(3);
    expect(batch).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Download all (zip)' }));
    expect(downloaded).toHaveBeenLastCalledWith('formatAI batch.zip', expect.any(ArrayBuffer), 'application/zip');
  });

  it('the files that were turned away make no batch: they are said, and the zone stays for the next drop', async () => {
    const { engine } = fakeEngine();
    renderConvert(<ConvertPage />, { api: fakeConvertApi(), engine });
    await drop([new File(['x'], 'notes.pdf'), new File(['x'], 'photo.png')]);
    expect(await screen.findByText(/2 files were not added/)).toBeTruthy();
    expect(screen.queryByTestId('batch-list')).toBeNull();
    expect(screen.getByLabelText('Files to convert')).toBeTruthy();
  });

  it('files dropped while the single-file flow shows something put it away and start the batch', async () => {
    const { engine, matchFile } = fakeEngine();
    matchFile.mockImplementationOnce(async () => ({ ok: true, headers: [], ranked: [], pick: { kind: 'choose', options: [match({ id: 'c1', score: 0.6 }), match({ id: 'c2', score: 0.5 })] } }));
    const api = fakeConvertApi({ entries: [entry({ conversionId: 'c1' }), entry({ conversionId: 'c2', sourceName: 'Supplier B' })] });
    renderConvert(<ConvertPage />, { api, engine });
    await drop(files(1));
    expect(await screen.findByText('Which source is this file?')).toBeTruthy();
    await drop(files(2));
    expect(await screen.findAllByTestId('batch-file')).toHaveLength(2);
    expect(screen.queryByText('Which source is this file?')).toBeNull();
  });

  it('taking every file out (or starting another batch) is the single-file zone again', async () => {
    const { engine } = fakeEngine();
    renderConvert(<ConvertPage />, { api: fakeConvertApi(), engine });
    await drop(files(2));
    fireEvent.click(await screen.findByRole('button', { name: 'Remove all' }));
    expect(screen.queryByTestId('batch-list')).toBeNull();
    // one file now is flow C again
    await drop(files(1));
    expect(await screen.findByText('Your file is ready')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Convert another file' }));

    await drop(files(2));
    fireEvent.click(await screen.findByRole('button', { name: 'Convert 2 files' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Start another batch' }));
    expect(screen.queryByTestId('batch-results')).toBeNull();
    expect(screen.getByLabelText('Files to convert')).toBeTruthy();
  });
});

describe('?format= scopes the several-files half too', () => {
  // s1 feeds F1 and F2; s3 feeds only F3.
  const feeds = sourceEntry({
    sourceId: 's1',
    name: 'Supplier A',
    conversions: [
      { conversionId: 'c1', formatId: 'F1', formatName: 'Load file' },
      { conversionId: 'c2', formatId: 'F2', formatName: 'ERP load' },
    ],
  });
  const other = entry({ conversionId: 'c3', sourceId: 's3', sourceName: 'Supplier C', formatId: 'F3', formatName: 'Ledger' });

  it('only the sources of that format are matched against, and only that format is made', async () => {
    const { engine, matchFile, convertWithDecisions } = fakeEngine();
    const api = fakeConvertApi({ entries: [feeds, other] });
    renderConvert(<ConvertPage />, { api, engine, route: '/convert?format=F2' });
    expect(await screen.findByTestId('only-format')).toBeTruthy();
    await drop(files(2));
    fireEvent.click(await screen.findByRole('button', { name: 'Convert 2 files' }));
    const results = await screen.findByTestId('batch-results');

    expect(matchFile.mock.calls[0]![0].signatures.map((s) => s.id)).toEqual(['s1']);
    expect(convertWithDecisions).toHaveBeenCalledTimes(2);
    expect(api.conversion.mock.calls.map((c) => c[0])).toEqual(['c2']);
    expect(within(results).getAllByTestId(/group-/).map((g) => g.querySelector('h3')?.textContent)).toEqual(['ERP load · 2 files']);
    // (and it still says so on the results)
    expect(screen.getByTestId('only-format').textContent).toContain('ERP load');
  });

  it('without it, every format of the source is made', async () => {
    const { engine, convertWithDecisions } = fakeEngine();
    const api = fakeConvertApi({ entries: [feeds, other] });
    renderConvert(<ConvertPage />, { api, engine });
    await drop(files(2));
    fireEvent.click(await screen.findByRole('button', { name: 'Convert 2 files' }));
    await screen.findByTestId('batch-results');
    expect(convertWithDecisions).toHaveBeenCalledTimes(4);
  });
});
