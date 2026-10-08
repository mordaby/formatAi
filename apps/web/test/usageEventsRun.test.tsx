// The usage events of the Run screen (SPEC 14.1; owner decision 2026-10-08), one emission point at a time: the file that was dropped (`file_uploaded`
// role run, `file_rejected`), how matching went (`file_matched`), which formats were ticked (`formats_chosen`, single file and batch), the
// downloads (`download`) and how a batch ended (`batch_run`). A fake worker, a fake API; the events are read from the fake emitter.
// Counts and codes only - the last tests hold that no file name or header of the files used here is in any event.
import { limits } from '@formatai/shared';
import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ConvertPage from '../src/pages/Convert';
import { convertSession } from '../src/pages/Convert/session';
import type { ConvertRunOutput, MatchFileArgs, MatchFileOutput, BatchArgs } from '../src/worker/convertApi';
import type { EngineClient } from '../src/worker/engineClient';
import { csvFile, entry, fakeConvertApi, match, PAID, realColumnGaps, renderConvert, REGISTERED, sourceEntry, SUPPLIER_A_CLEAN_CSV, SUPPLIER_A_CSV } from './helpers/convertKit';

const { downloaded } = vi.hoisted(() => ({ downloaded: vi.fn() }));
vi.mock('../src/app/SignIn', () => ({ useSignIn: () => ({ open: vi.fn(), close: vi.fn() }) }));
vi.mock('../src/flow/download', async (orig) => ({ ...(await orig<typeof import('../src/flow/download')>()), downloadBytes: downloaded }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  convertSession.clear();
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

type Pick = MatchFileOutput;
function fakeEngine(pick?: (args: MatchFileArgs) => Pick, run: (args: { file: { name: string } }) => ConvertRunOutput = () => written) {
  const matchFile = vi.fn(
    async (args: MatchFileArgs): Promise<MatchFileOutput> =>
      pick ? pick(args) : { ok: true, headers: ['Item Code', 'Qty', 'Price', 'Extra'], rows: 3, ranked: [], pick: { kind: 'auto', match: match({ id: args.signatures[0]?.id ?? 'c1', score: 0.9567 }) } },
  );
  const convertWithDecisions = vi.fn(async (args: { file: { name: string } }): Promise<ConvertRunOutput> => run(args));
  const batch = vi.fn(async (_args: BatchArgs) => ({ zip: new ArrayBuffer(6), summary: new ArrayBuffer(4) }));
  const engine = { matchFile, convertWithDecisions, batch, columnGaps: vi.fn(realColumnGaps), terminate: vi.fn() } as unknown as EngineClient;
  return { engine, matchFile, convertWithDecisions };
}

async function drop(list: File[], label = 'Files to convert') {
  const input = await screen.findByLabelText(label);
  await act(async () => {
    fireEvent.change(input, { target: { files: list } });
  });
}

const only = (events: [string, Record<string, unknown>][], type: string): Record<string, unknown>[] => events.filter(([t]) => t === type).map(([, p]) => p);

describe('one file: what was dropped and how matching went', () => {
  it('a file dropped: file_uploaded (role run) with its type, rows and columns - then file_matched auto with the winner\'s score to two decimals', async () => {
    const view = renderConvert(<ConvertPage />, { api: fakeConvertApi(), engine: fakeEngine().engine });
    await drop([csvFile('Quarterly prices.csv', SUPPLIER_A_CLEAN_CSV)]);
    await screen.findByText('Your file is ready');
    expect(view.events()).toEqual([
      ['file_uploaded', { role: 'run', fileType: 'csv', rows: 3, cols: 4 }],
      ['file_matched', { result: 'auto', score: 0.9567 }],
    ]);
  });

  it('asked to choose: file_matched choose, with the best option\'s score', async () => {
    const { engine } = fakeEngine(() => ({ ok: true, headers: ['A', 'B'], rows: 2, ranked: [], pick: { kind: 'choose', options: [match({ id: 'c1', score: 0.62 }), match({ id: 'c2', score: 0.5 })] } }));
    const view = renderConvert(<ConvertPage />, { api: fakeConvertApi({ entries: [entry({ conversionId: 'c1' }), entry({ conversionId: 'c2', sourceName: 'Supplier B' })] }), engine });
    await drop([csvFile('jan.csv', 'x')]);
    await screen.findByText(/Which of your sources/i);
    expect(only(view.events(), 'file_matched')).toEqual([{ result: 'choose', score: 0.62 }]);
  });

  it('nothing matches: file_matched none, with no score', async () => {
    const { engine } = fakeEngine(() => ({ ok: true, headers: ['A'], rows: 1, ranked: [], pick: { kind: 'choose', options: [] } }));
    const view = renderConvert(<ConvertPage />, { api: fakeConvertApi(), engine });
    await drop([csvFile('jan.csv', 'x')]);
    await vi.waitFor(() => expect(only(view.events(), 'file_matched')).toEqual([{ result: 'none' }]));
  });

  it.each(['unreadable', 'noTable'] as const)('a file the reader cannot use (%s): file_rejected with that reason, and no upload or match', async (reason) => {
    const { engine } = fakeEngine(() => ({ ok: false, reason }));
    const view = renderConvert(<ConvertPage />, { api: fakeConvertApi(), engine });
    await drop([csvFile('broken.csv', 'x')]);
    await vi.waitFor(() => expect(view.events()).toEqual([['file_rejected', { reason }]]));
  });

  it('a file of a type we do not read, or too big, is turned away at the drop zone: file_rejected type / size, never the name', async () => {
    const view = renderConvert(<ConvertPage />, { api: fakeConvertApi(), engine: fakeEngine().engine });
    await drop([new File(['x'], 'Private notes.pdf')]);
    const big = csvFile('huge.csv', 'x');
    Object.defineProperty(big, 'size', { value: 10 ** 10 });
    await drop([big]);
    expect(view.events()).toEqual([
      ['file_rejected', { reason: 'type' }],
      ['file_rejected', { reason: 'size' }],
    ]);
  });
});

describe('the formats step', () => {
  const two = sourceEntry({ sourceId: 's1', conversions: [{ conversionId: 'c1', formatId: 'F1', formatName: 'Load file' }, { conversionId: 'c2', formatId: 'F2', formatName: 'ERP load' }] });

  it('single file: formats_chosen on Continue with how many were offered and ticked - none pre-ticked, so a pick of one of two is chosen 1, all false', async () => {
    const view = renderConvert(<ConvertPage />, { api: fakeConvertApi({ user: REGISTERED, entries: [two] }), engine: fakeEngine().engine });
    await drop([csvFile('jan.csv', SUPPLIER_A_CLEAN_CSV)]);
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Load file' }));
    expect(only(view.events(), 'formats_chosen')).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(only(view.events(), 'formats_chosen')).toEqual([{ offered: 2, chosen: 1, all: false, batch: false }]);
  });

  it('single file: ticking "All" says all', async () => {
    const view = renderConvert(<ConvertPage />, { api: fakeConvertApi({ user: REGISTERED, entries: [two] }), engine: fakeEngine().engine });
    await drop([csvFile('jan.csv', SUPPLIER_A_CLEAN_CSV)]);
    fireEvent.click(await screen.findByRole('checkbox', { name: 'All formats' }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(only(view.events(), 'formats_chosen')).toEqual([{ offered: 2, chosen: 2, all: true, batch: false }]);
  });

  it('a batch: formats_chosen (batch true) when the one question is answered - not when it is left with Back', async () => {
    const feeds = sourceEntry({ sourceId: 's1', conversions: [{ conversionId: 'c1', formatId: 'F1', formatName: 'Load file' }, { conversionId: 'c2', formatId: 'F2', formatName: 'ERP load' }] });
    const other = sourceEntry({ sourceId: 's2', name: 'Supplier C', conversions: [{ conversionId: 'c3', formatId: 'F3', formatName: 'Ledger' }] });
    const matchBy = (args: MatchFileArgs): Pick => ({ ok: true, headers: ['A'], rows: 5, ranked: [], pick: { kind: 'auto', match: match({ id: args.file.name === 'x.csv' ? 's2' : 's1' }) } });
    const view = renderConvert(<ConvertPage />, { api: fakeConvertApi({ user: PAID, entries: [feeds, other] }), engine: fakeEngine(matchBy).engine });
    await drop([csvFile('a.csv', 'x'), csvFile('b.csv', 'x'), csvFile('x.csv', 'x')]);
    fireEvent.click(await screen.findByRole('button', { name: 'Convert 3 files' }));
    await screen.findByTestId('batch-choose-formats');
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(only(view.events(), 'formats_chosen')).toEqual([]);

    fireEvent.click(await screen.findByRole('button', { name: 'Convert 3 files' }));
    await screen.findByTestId('batch-choose-formats');
    fireEvent.click(screen.getByRole('checkbox', { name: /^ERP load ·/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Convert' }));
    await screen.findByTestId('batch-results');
    expect(only(view.events(), 'formats_chosen')).toEqual([{ offered: 3, chosen: 1, all: false, batch: true }]);
  });
});

describe('downloads', () => {
  it('one file made: download single', async () => {
    const view = renderConvert(<ConvertPage />, { api: fakeConvertApi(), engine: fakeEngine().engine });
    await drop([csvFile('jan.csv', SUPPLIER_A_CLEAN_CSV)]);
    fireEvent.click(await screen.findByRole('button', { name: 'Download the file' }));
    expect(only(view.events(), 'download')).toEqual([{ kind: 'single' }]);
    expect(downloaded).toHaveBeenCalledTimes(1);
  });

  it('several formats of one file: a file each is single, the zip is zip', async () => {
    const two = sourceEntry({ sourceId: 's1', conversions: [{ conversionId: 'c1', formatId: 'F1', formatName: 'Load file' }, { conversionId: 'c2', formatId: 'F2', formatName: 'ERP load' }] });
    const view = renderConvert(<ConvertPage />, { api: fakeConvertApi({ user: REGISTERED, entries: [two] }), engine: fakeEngine().engine });
    await drop([csvFile('jan.csv', SUPPLIER_A_CLEAN_CSV)]);
    fireEvent.click(await screen.findByRole('checkbox', { name: 'All formats' }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.click((await screen.findAllByRole('button', { name: /Download the file for/ }))[0]!);
    fireEvent.click(screen.getByRole('button', { name: 'Download all (zip)' }));
    await vi.waitFor(() => expect(only(view.events(), 'download')).toEqual([{ kind: 'single' }, { kind: 'zip' }]));
  });

  it('a batch: the zip, the summary sheet and one file of it', async () => {
    const view = renderConvert(<ConvertPage />, { api: fakeConvertApi({ user: PAID }), engine: fakeEngine().engine });
    await drop([csvFile('a.csv', SUPPLIER_A_CLEAN_CSV), csvFile('b.csv', SUPPLIER_A_CLEAN_CSV)]);
    fireEvent.click(await screen.findByRole('button', { name: 'Convert 2 files' }));
    await screen.findByTestId('batch-results');
    fireEvent.click(screen.getByRole('button', { name: 'Download all (zip)' }));
    fireEvent.click(screen.getByRole('button', { name: 'Download the summary sheet' }));
    fireEvent.click(screen.getByRole('button', { name: 'Download a.csv (Load file)' }));
    expect(only(view.events(), 'download')).toEqual([{ kind: 'zip' }, { kind: 'summary' }, { kind: 'batchFile' }]);
  });
});

describe('a batch', () => {
  const entries = [entry({ conversionId: 'c1', formatId: 'F1', formatName: 'Load file', sourceName: 'Supplier A' }), entry({ conversionId: 'c2', formatId: 'F2', formatName: 'ERP load', sourceName: 'Supplier B' })];

  function mixed() {
    const matchBy = (args: MatchFileArgs): Pick => {
      const name = args.file.name;
      const auto = (id: string, extra = {}, headers = ['Item Code', 'Qty', 'Price']): Pick => ({ ok: true, headers, rows: 7, ranked: [], pick: { kind: 'auto', match: match({ id, ...extra }) } });
      if (name === 'a.csv' || name === 'b.csv') return auto('c1');
      if (name === 'e.csv') return auto('c2');
      if (name === 'd.csv') return auto('c1', { score: 0.9, missingRequired: ['Qty'] }, ['Item Code', 'Price']);
      if (name === 'bad.csv') return { ok: false, reason: 'unreadable' };
      return { ok: true, headers: [], rows: 0, ranked: [], pick: { kind: 'choose', options: [match({ id: 'c1', score: 0.6 })] } };
    };
    return fakeEngine(matchBy);
  }

  it('reports how it ended in FILES: converted, needing attention, not matched, not chosen - once, when the files are done', async () => {
    const view = renderConvert(<ConvertPage />, { api: fakeConvertApi({ user: PAID, entries }), engine: mixed().engine });
    await drop(['a', 'b', 'e', 'c', 'd', 'bad'].map((n) => csvFile(`${n}.csv`, 'x')));
    fireEvent.click(await screen.findByRole('button', { name: 'Convert 6 files' }));
    await screen.findByTestId('batch-results');
    expect(only(view.events(), 'batch_run')).toEqual([{ files: 6, converted: 3, needsAttention: 1, noMatch: 2, notChosen: 0 }]);
  });

  it('counts a file none of whose formats was chosen as not chosen, and a file made into several formats once', async () => {
    const feeds = sourceEntry({ sourceId: 's1', conversions: [{ conversionId: 'c1', formatId: 'F1', formatName: 'Load file' }, { conversionId: 'c2', formatId: 'F2', formatName: 'ERP load' }] });
    const other = sourceEntry({ sourceId: 's2', name: 'Supplier C', conversions: [{ conversionId: 'c3', formatId: 'F3', formatName: 'Ledger' }] });
    const matchBy = (args: MatchFileArgs): Pick => ({ ok: true, headers: ['Item Code', 'Qty', 'Price'], rows: 5, ranked: [], pick: { kind: 'auto', match: match({ id: args.file.name === 'x.csv' ? 's2' : 's1' }) } });
    const view = renderConvert(<ConvertPage />, { api: fakeConvertApi({ user: PAID, entries: [feeds, other] }), engine: fakeEngine(matchBy).engine });
    await drop([csvFile('a.csv', 'x'), csvFile('b.csv', 'x'), csvFile('x.csv', 'x')]);
    fireEvent.click(await screen.findByRole('button', { name: 'Convert 3 files' }));
    await screen.findByTestId('batch-choose-formats');
    fireEvent.click(screen.getByRole('checkbox', { name: 'All formats' }));
    fireEvent.click(screen.getByRole('checkbox', { name: /^Ledger ·/ })); // untick it: x.csv is then not made
    fireEvent.click(screen.getByRole('button', { name: 'Convert' }));
    await screen.findByTestId('batch-results');
    expect(only(view.events(), 'batch_run')).toEqual([{ files: 3, converted: 2, needsAttention: 0, noMatch: 0, notChosen: 1 }]);
  });

  it('each file of the batch is a run file (type, rows, columns), and a file the reader cannot use or the list turns away is a rejection', async () => {
    const view = renderConvert(<ConvertPage />, { api: fakeConvertApi({ user: PAID, entries }), engine: mixed().engine });
    await drop([csvFile('a.csv', 'x'), csvFile('bad.csv', 'x'), new File(['x'], 'notes.pdf')]);
    fireEvent.click(await screen.findByRole('button', { name: 'Convert 2 files' }));
    await screen.findByTestId('batch-results');
    const events = view.events();
    expect(events.filter(([t]) => t === 'file_uploaded')).toEqual([['file_uploaded', { role: 'run', fileType: 'csv', rows: 7, cols: 3 }]]);
    expect(only(events, 'file_rejected')).toEqual([{ reason: 'type' }, { reason: 'unreadable' }]);
  });
});

describe('no name, header or value in any event', () => {
  it('a whole run of a file and of a batch tracks nothing of the files: not their names, not their column names, not a cell', async () => {
    const secrets = ['Quarterly prices', 'Private notes', 'Item Code', 'Qty', 'Extra', 'Supplier A', 'Load file', '00001', 'jan.csv', 'a.csv'];
    const single = renderConvert(<ConvertPage />, { api: fakeConvertApi(), engine: fakeEngine().engine });
    await drop([new File(['x'], 'Private notes.pdf')]);
    await drop([csvFile('Quarterly prices.csv', SUPPLIER_A_CSV)]);
    await screen.findByText('Your file is ready');
    fireEvent.click(screen.getByRole('button', { name: 'Download the file' }));
    const singleText = JSON.stringify(single.events());
    cleanup();

    const batch = renderConvert(<ConvertPage />, { api: fakeConvertApi({ user: PAID }), engine: fakeEngine().engine });
    await drop([csvFile('jan.csv', SUPPLIER_A_CSV), csvFile('a.csv', SUPPLIER_A_CLEAN_CSV)]);
    fireEvent.click(await screen.findByRole('button', { name: 'Convert 2 files' }));
    await screen.findByTestId('batch-results');
    fireEvent.click(screen.getByRole('button', { name: 'Download all (zip)' }));
    const batchText = JSON.stringify(batch.events());

    for (const text of [singleText, batchText]) {
      expect(text.length).toBeGreaterThan(20);
      for (const secret of secrets) expect(text, secret).not.toContain(secret);
    }
  });

  it('every event of the run screen passes the same strict schema the server checks (no prop the schema does not list)', async () => {
    const { parseEvent, CLIENT_EVENT_TYPES } = await import('@formatai/shared');
    const view = renderConvert(<ConvertPage />, { api: fakeConvertApi({ user: PAID }), engine: fakeEngine().engine });
    await drop([csvFile('a.csv', SUPPLIER_A_CLEAN_CSV), csvFile('b.csv', SUPPLIER_A_CLEAN_CSV)]);
    fireEvent.click(await screen.findByRole('button', { name: 'Convert 2 files' }));
    await screen.findByTestId('batch-results');
    fireEvent.click(screen.getByRole('button', { name: 'Download all (zip)' }));
    const events = view.events();
    expect(events.length).toBeGreaterThan(3);
    for (const [type, props] of events) expect(parseEvent({ type, props }, CLIENT_EVENT_TYPES), type).not.toBeNull();
    void limits;
  });
});
