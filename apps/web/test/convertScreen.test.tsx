// The Convert screen (SPEC 5 C, 21 v5 item 5), with a fake worker and a fake API: matching (auto, or choose among the top
// three), missing and renamed columns, the review of flagged rows BEFORE the file is written and the decisions it sends,
// the run summary, and what is (and is not) sent to the API.
import type { Flag, RunSummary } from '@formatai/engine';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConvertRunOutput, MatchFileArgs, MatchFileOutput } from '../src/worker/convertApi';
import type { EngineClient } from '../src/worker/engineClient';
import ConvertPage from '../src/pages/Convert';
import { convertSession } from '../src/pages/Convert/session';
import { csvFile, entry, fakeConvertApi, match, renderConvert, RULES, SUPPLIER_A_CSV } from './helpers/convertKit';

const { signInOpen, downloaded } = vi.hoisted(() => ({ signInOpen: vi.fn(), downloaded: vi.fn() }));
vi.mock('../src/app/SignIn', () => ({ useSignIn: () => ({ open: signInOpen, close: vi.fn() }) }));
vi.mock('../src/flow/download', async (orig) => ({ ...(await orig<typeof import('../src/flow/download')>()), downloadBytes: downloaded }));

beforeEach(() => {
  convertSession.clear();
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const summary = (over: Partial<RunSummary> = {}): RunSummary => ({ rowsIn: 3, rowsOut: 3, rowsFiltered: 0, duplicatesRemoved: [], duplicatesFlagged: 0, blockedRows: [], ...over });
const flag = (rowNumber: number, column: string, over: Partial<Flag> = {}): Flag => ({ rowNumber, column, rule: 'type', value: 'abc', messageKey: 'flag.parseFailed.integer', ...over });

const preview = {
  name: 'Load',
  direction: 'ltr' as const,
  language: 'en' as const,
  columns: [{ header: 'Code' }, { header: 'Quantity' }],
  rows: [
    { kind: 'header' as const, cells: [{ v: 'Code' }, { v: 'Quantity' }] },
    { kind: 'data' as const, cells: [{ v: '00001' }, { v: 5 }] },
  ],
  merges: [],
};

function written(over: { flags?: Flag[]; summary?: RunSummary } = {}): ConvertRunOutput {
  return { ok: true, written: true, bytes: new ArrayBuffer(8), fileType: 'csv', flags: over.flags ?? [], summary: over.summary ?? summary(), preview, totalRows: 4 };
}

function review(flags: Flag[], rowInputs: Record<number, { columnId: string; header: string; value: string | null }[]> = {}, s: RunSummary = summary()): ConvertRunOutput {
  return { ok: true, written: false, fileType: 'csv', flags, summary: s, rowInputs };
}

interface EngineOpts {
  match?: MatchFileOutput;
  run?: (args: { mode: string; rowDecisions?: unknown }) => ConvertRunOutput;
}
function fakeEngine(opts: EngineOpts = {}) {
  const matchFile = vi.fn(async (_args: MatchFileArgs) => opts.match ?? ({ ok: true, headers: [], ranked: [], pick: { kind: 'auto', match: match({ id: 'c1' }) } } as MatchFileOutput));
  const convertWithDecisions = vi.fn(async (args: { mode: string; rowDecisions?: unknown }) => (opts.run ? opts.run(args) : written()));
  const engine = { matchFile, convertWithDecisions, batch: vi.fn(), terminate: vi.fn() } as unknown as EngineClient;
  return { engine, matchFile, convertWithDecisions };
}

async function drop(name = 'jan.csv', body = SUPPLIER_A_CSV, label = 'File to convert') {
  const input = await screen.findByLabelText(label);
  await act(async () => {
    fireEvent.change(input, { target: { files: [csvFile(name, body)] } });
  });
}

describe('signed out', () => {
  it('meets the sign-in wall, not the tool, and no formats are loaded', async () => {
    const api = fakeConvertApi({ user: null });
    renderConvert(<ConvertPage />, { api, engine: fakeEngine().engine });
    expect(await screen.findByText('Sign in to convert a file')).toBeTruthy();
    expect(screen.queryByLabelText('File to convert')).toBeNull();
    expect(api.signatures).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(signInOpen).toHaveBeenCalled();
  });
});

describe('matching', () => {
  it('a clear match is used without asking, and only counts go to the API', async () => {
    const api = fakeConvertApi();
    const { engine, matchFile, convertWithDecisions } = fakeEngine({ run: () => written({ summary: summary({ rowsIn: 3, rowsOut: 3 }) }) });
    renderConvert(<ConvertPage />, { api, engine });
    await drop();

    expect(await screen.findByText('Your file is ready')).toBeTruthy();
    // The worker got the signatures (headers, aliases, required: never data) of every saved source.
    const sent = matchFile.mock.calls[0]![0];
    expect(sent.signatures.map((s) => [s.id, s.name])).toEqual([['c1', 'Supplier A']]);
    expect(api.conversion).toHaveBeenCalledWith('c1', expect.anything());
    expect(convertWithDecisions).toHaveBeenCalledTimes(1);
    expect(convertWithDecisions.mock.calls[0]![0]).toMatchObject({ mode: 'review' });
    // POST /runs: exactly two numbers.
    expect(api.recordRun).toHaveBeenCalledTimes(1);
    expect(api.recordRun).toHaveBeenCalledWith('c1', { rows: 3, flagged: 0 });

    const stats = within(screen.getByTestId('run-summary'));
    expect(stats.getByText('Rows in').nextSibling?.textContent).toBe('3');
    expect(stats.getByText('Rows out').nextSibling?.textContent).toBe('3');
    expect(screen.getByTestId('output-name').textContent).toBe('jan (converted).csv');
    fireEvent.click(screen.getByRole('button', { name: 'Download the file' }));
    expect(downloaded).toHaveBeenCalledWith(expect.stringContaining('jan (converted).csv'), expect.any(ArrayBuffer), 'text/csv');
  });

  it('several sources fit and none clearly wins: the top 3 are offered, with scores in plain words, and the pick is used', async () => {
    const entries = [
      entry({ conversionId: 'c1', sourceName: 'Supplier A' }),
      entry({ conversionId: 'c2', sourceName: 'Supplier B', formatId: 'F2', formatName: 'ERP load' }),
      entry({ conversionId: 'c3', sourceName: 'Supplier C' }),
    ];
    const api = fakeConvertApi({ entries });
    const { engine, convertWithDecisions } = fakeEngine({
      match: {
        ok: true,
        headers: ['x'],
        ranked: [],
        pick: {
          kind: 'choose',
          options: [
            match({ id: 'c1', name: 'Supplier A', score: 0.82 }),
            match({ id: 'c2', name: 'Supplier B', score: 0.55, missingRequired: ['Qty'] }),
            match({ id: 'c3', name: 'Supplier C', score: 0.2 }),
          ],
        },
      },
    });
    renderConvert(<ConvertPage />, { api, engine });
    await drop();

    expect(await screen.findByText('Which source is this file?')).toBeTruthy();
    const options = screen.getAllByTestId('source-option');
    expect(options).toHaveLength(3);
    expect(options[0]!.textContent).toContain('Load file');
    expect(options[0]!.textContent).toContain('Supplier A');
    expect(options[0]!.textContent).toContain('Most columns match');
    expect(options[0]!.textContent).toContain('82% match');
    expect(options[1]!.textContent).toContain('ERP load');
    expect(options[1]!.textContent).toContain('Some columns match');
    expect(options[1]!.textContent).toContain('Qty');
    expect(options[2]!.textContent).toContain('Few columns match');
    // Nothing runs until the user chooses.
    expect(convertWithDecisions).not.toHaveBeenCalled();
    expect(api.conversion).not.toHaveBeenCalled();

    fireEvent.click(within(options[1]!).getByRole('button', { name: /Use this source/ }));
    await screen.findByText('Your file is ready');
    expect(api.conversion).toHaveBeenCalledWith('c2', expect.anything());
    expect(api.recordRun).toHaveBeenCalledWith('c2', expect.any(Object));
  });

  it('nothing is close enough: says so and never runs on a guess', async () => {
    const api = fakeConvertApi();
    const { engine, convertWithDecisions } = fakeEngine({ match: { ok: true, headers: [], ranked: [], pick: { kind: 'choose', options: [] } } });
    renderConvert(<ConvertPage />, { api, engine });
    await drop();
    expect(await screen.findByText("This file doesn't look like any of your sources")).toBeTruthy();
    expect(convertWithDecisions).not.toHaveBeenCalled();
  });

  it('?format= only offers the sources of that format', async () => {
    const entries = [entry({ conversionId: 'c1' }), entry({ conversionId: 'c2', formatId: 'F2', formatName: 'ERP load', sourceName: 'Supplier B' })];
    const { engine, matchFile } = fakeEngine();
    renderConvert(<ConvertPage />, { api: fakeConvertApi({ entries }), engine, route: '/convert?format=F2' });
    expect((await screen.findByTestId('only-format')).textContent).toContain('Only the sources of');
    await drop();
    await screen.findByText('Your file is ready');
    const sent = matchFile.mock.calls[0]![0];
    expect(sent.signatures.map((s) => s.id)).toEqual(['c2']);
  });

  it('no saved formats yet: points to teaching one', async () => {
    renderConvert(<ConvertPage />, { api: fakeConvertApi({ entries: [] }), engine: fakeEngine().engine });
    expect(await screen.findByText('No formats to convert with yet')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Teach a format' })).toBeTruthy();
  });
});

describe('missing and renamed columns', () => {
  it('missing required columns with nothing to map stop the run and name the exact headers', async () => {
    const api = fakeConvertApi();
    const { engine, convertWithDecisions } = fakeEngine({
      match: { ok: true, headers: ['Item Code'], ranked: [], pick: { kind: 'auto', match: match({ id: 'c1', score: 0.9, missingRequired: ['Qty', 'Item Code'], extra: [] }) } },
    });
    renderConvert(<ConvertPage />, { api, engine });
    await drop();
    const box = await screen.findByTestId('missing-columns');
    expect(box.textContent).toContain('This file is missing columns');
    expect(box.textContent).toContain('needs 2 columns this file does not have');
    expect(within(screen.getByTestId('missing-list')).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['Qty', 'Item Code']);
    expect(box.textContent).toContain('drop the file again');
    expect(convertWithDecisions).not.toHaveBeenCalled();
    expect(api.recordRun).not.toHaveBeenCalled();
  });

  const renamed = (): MatchFileOutput => ({
    ok: true,
    headers: ['Item Code', 'Quantity', 'Weird'],
    ranked: [],
    pick: {
      kind: 'auto',
      match: match({ id: 'c1', score: 0.9, missingRequired: ['Qty'], extra: ['Weird', 'Quantity'], renamedCandidates: [{ required: 'Qty', candidates: ['Quantity'] }] }),
    },
  });

  it('a renamed column is mapped by the user (suggestion first), used for this run, and saved as an alias', async () => {
    const api = fakeConvertApi();
    const { engine, convertWithDecisions } = fakeEngine({ match: renamed() });
    renderConvert(<ConvertPage />, { api, engine });
    await drop();
    expect(await screen.findByText('Is a column named differently?')).toBeTruthy();
    const select = screen.getByLabelText(/The column .*Qty.* is/) as HTMLSelectElement;
    // The suggestion is filled in; the other unknown header is still there to choose.
    expect(select.value).toBe('Quantity');
    expect(Array.from(select.options).map((o) => o.textContent)).toEqual(['Choose a column of the file', 'Quantity', 'Weird', "It isn't in this file"]);
    expect(convertWithDecisions).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await screen.findByText('Your file is ready');
    expect(api.addAlias).toHaveBeenCalledWith('c1', { header: 'Qty', alias: 'Quantity' });
    // The signatures are read again, so the next file with this name matches with no questions.
    await waitFor(() => expect(api.signatures).toHaveBeenCalledTimes(2));
    // This run reads the column through the alias; the saved rules were not edited in place.
    const rules = (convertWithDecisions.mock.calls[0]![0] as unknown as { rules: typeof RULES }).rules;
    expect(rules.input.columns.find((c) => c.id === 'c_qty')?.aliases).toEqual(['Quantity']);
    expect(RULES.input.columns.find((c) => c.id === 'c_qty')?.aliases).toBeUndefined();
  });

  it('without "remember this" nothing is saved', async () => {
    const api = fakeConvertApi();
    renderConvert(<ConvertPage />, { api, engine: fakeEngine({ match: renamed() }).engine });
    await drop();
    await screen.findByText('Is a column named differently?');
    fireEvent.click(screen.getByRole('checkbox', { name: /Remember this/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await screen.findByText('Your file is ready');
    expect(api.addAlias).not.toHaveBeenCalled();
    expect(api.signatures).toHaveBeenCalledTimes(1);
  });

  it('"it isn\'t in this file" ends with the exact missing header', async () => {
    const api = fakeConvertApi();
    const { engine, convertWithDecisions } = fakeEngine({ match: renamed() });
    renderConvert(<ConvertPage />, { api, engine });
    await drop();
    await screen.findByText('Is a column named differently?');
    fireEvent.change(screen.getByLabelText(/The column .*Qty.* is/), { target: { value: '__none__' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    const list = await screen.findByTestId('missing-list');
    expect(list.textContent).toBe('Qty');
    expect(convertWithDecisions).not.toHaveBeenCalled();
    expect(api.addAlias).not.toHaveBeenCalled();
  });

  it('a rename that could not be saved still converts the file, and says so', async () => {
    const api = fakeConvertApi();
    api.addAlias.mockRejectedValueOnce(new Error('conflict'));
    renderConvert(<ConvertPage />, { api, engine: fakeEngine({ match: renamed() }).engine });
    await drop();
    await screen.findByText('Is a column named differently?');
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await screen.findByText('Your file is ready');
    expect(screen.getByText(/couldn't save this rename/)).toBeTruthy();
  });
});

describe('the review before the file is written', () => {
  const flags = [flag(3, 'c_qty'), flag(3, 'c_code', { rule: 'lengthEquals', value: '123', messageKey: 'flag.validation.lengthEquals', params: { length: 5 }, suggestion: '00123' }), flag(6, 'c_qty', { value: 'n/a' }), flag(9, 'c_price', { value: 'oops', messageKey: 'flag.parseFailed.number' })];
  const inputs = {
    3: [{ columnId: 'c_code', header: 'Item Code', value: '123' }, { columnId: 'c_qty', header: 'Qty', value: 'abc' }, { columnId: 'c_price', header: 'Price', value: '3' }],
    6: [{ columnId: 'c_code', header: 'Item Code', value: '00006' }, { columnId: 'c_qty', header: 'Qty', value: 'n/a' }, { columnId: 'c_price', header: 'Price', value: '1' }],
    9: [{ columnId: 'c_code', header: 'Item Code', value: '00009' }, { columnId: 'c_qty', header: 'Qty', value: '2' }, { columnId: 'c_price', header: 'Price', value: 'oops' }],
  };

  function setup(extra: { blocked?: boolean } = {}) {
    const s = extra.blocked ? summary({ blockedRows: [{ rowNumber: 12, rule: 'range', column: 'c_price' }] }) : summary();
    const api = fakeConvertApi();
    const engine = fakeEngine({
      run: (args) =>
        args.mode === 'review'
          ? review(flags, extra.blocked ? { ...inputs, 12: [{ columnId: 'c_price', header: 'Price', value: '-4' }] } : inputs, s)
          : written({
              flags: flags.map((f) => ({ ...f, ...(f.rowNumber === 9 ? { accepted: true } : {}) })),
              summary: summary({ rowsIn: 10, rowsOut: 8, skippedByUser: [{ rowNumber: 3 }], editedByUser: [{ rowNumber: 6, columns: ['c_qty'] }], acceptedByUser: [{ rowNumber: 9, flags: 1 }] }),
            }),
    });
    return { api, ...engine };
  }

  const rowCard = (n: number) => document.querySelector(`[data-testid="review-row"][data-row="${n}"]`) as HTMLElement;

  it('shows flagged rows BEFORE any file is written: row, column, value, the message and the suggestion', async () => {
    const { api, engine, convertWithDecisions } = setup();
    renderConvert(<ConvertPage />, { api, engine });
    await drop();
    expect(await screen.findByText('Some rows need a look before the file is made')).toBeTruthy();
    // Only the review run happened: nothing has been written and nothing reported.
    expect(convertWithDecisions).toHaveBeenCalledTimes(1);
    expect(api.recordRun).not.toHaveBeenCalled();
    expect(screen.getByTestId('review-count').textContent).toBe('3 rows are flagged.');
    const r3 = rowCard(3);
    expect(r3.textContent).toContain('Row 3');
    expect(r3.textContent).toContain('Qty');
    expect(r3.textContent).toContain('abc');
    expect(r3.textContent).toContain("This isn't a whole number");
    expect(r3.textContent).toContain('This value should be 5 characters long.');
    expect(r3.textContent).toContain('Suggestion:');
    expect(r3.textContent).toContain('00123');
    expect(screen.queryByText('Your file is ready')).toBeNull();
  });

  it('each row action becomes a row decision for "Create the file", and the summary shows what the user decided', async () => {
    const { api, engine, convertWithDecisions } = setup();
    renderConvert(<ConvertPage />, { api, engine });
    await drop();
    await screen.findByText('Some rows need a look before the file is made');

    fireEvent.click(within(rowCard(3)).getByRole('button', { name: 'Skip this row' }));
    expect(rowCard(3).textContent).toContain('Will be skipped');
    fireEvent.click(within(rowCard(9)).getByRole('button', { name: 'Keep as is' }));
    expect(rowCard(9).textContent).toContain('Will be kept as is');

    // Fix this row only: an inline edit of the flagged input value.
    fireEvent.click(within(rowCard(6)).getByRole('button', { name: 'Fix this row only' }));
    const field = within(rowCard(6)).getByLabelText('Qty') as HTMLInputElement;
    expect(field.value).toBe('n/a');
    // Only the flagged input column is offered, not the whole row.
    expect(within(rowCard(6)).queryByLabelText('Item Code')).toBeNull();
    fireEvent.change(field, { target: { value: '12' } });
    fireEvent.click(within(rowCard(6)).getByRole('button', { name: 'Use this value' }));
    expect(rowCard(6).textContent).toContain('Will be fixed in this file only');
    expect(screen.getByTestId('review-tally').textContent).toBe('1 kept · 1 skipped · 1 fixed · 0 not decided');

    fireEvent.click(screen.getByRole('button', { name: 'Create the file' }));
    await screen.findByText('Your file is ready');
    expect(convertWithDecisions).toHaveBeenCalledTimes(2);
    expect(convertWithDecisions.mock.calls[1]![0]).toMatchObject({
      mode: 'write',
      rowDecisions: { 3: { action: 'skip' }, 9: { action: 'keep' }, 6: { action: 'override', values: { c_qty: '12' } } },
    });

    // The run summary: rows in and out, and what the user skipped, fixed and kept.
    const stats = screen.getByTestId('run-summary');
    const stat = (id: string) => stats.querySelector(`[data-stat="${id}"] dd`)?.textContent;
    expect([stat('rowsIn'), stat('rowsOut'), stat('skipped'), stat('edited'), stat('accepted')]).toEqual(['10', '8', '1', '1', '1']);
    // Counts only: 10 rows, and the flagged rows the user has NOT accepted (rows 3 and 6).
    expect(api.recordRun).toHaveBeenCalledTimes(1);
    expect(api.recordRun).toHaveBeenCalledWith('c1', { rows: 10, flagged: 2 });
    // The flags stay in the list; the one the user kept is marked.
    expect(within(screen.getByTestId('run-flags')).getByText('Kept by you')).toBeTruthy();
  });

  it('"Keep all as is" and "Skip all flagged rows" decide every row at once, and can be cleared', async () => {
    const { api, engine, convertWithDecisions } = setup();
    renderConvert(<ConvertPage />, { api, engine });
    await drop();
    await screen.findByText('Some rows need a look before the file is made');

    fireEvent.click(screen.getByRole('button', { name: 'Keep all as is' }));
    expect(screen.getByTestId('review-tally').textContent).toBe('3 kept · 0 skipped · 0 fixed · 0 not decided');
    fireEvent.click(screen.getByRole('button', { name: 'Skip all flagged rows' }));
    expect(screen.getByTestId('review-tally').textContent).toBe('0 kept · 3 skipped · 0 fixed · 0 not decided');
    fireEvent.click(screen.getByRole('button', { name: 'Clear my choices' }));
    expect(screen.getByTestId('review-tally').textContent).toBe('0 kept · 0 skipped · 0 fixed · 3 not decided');

    fireEvent.click(screen.getByRole('button', { name: 'Keep all as is' }));
    fireEvent.click(screen.getByRole('button', { name: 'Create the file' }));
    await screen.findByText('Your file is ready');
    expect(convertWithDecisions.mock.calls[1]![0]).toMatchObject({ rowDecisions: { 3: { action: 'keep' }, 6: { action: 'keep' }, 9: { action: 'keep' } } });
  });

  it('a row with no decision is left out of the decisions (written highlighted, as the engine does)', async () => {
    const { api, engine, convertWithDecisions } = setup();
    renderConvert(<ConvertPage />, { api, engine });
    await drop();
    await screen.findByText('Some rows need a look before the file is made');
    fireEvent.click(within(rowCard(3)).getByRole('button', { name: 'Skip this row' }));
    fireEvent.click(screen.getByRole('button', { name: 'Create the file' }));
    await screen.findByText('Your file is ready');
    expect((convertWithDecisions.mock.calls[1]![0] as unknown as { rowDecisions: object }).rowDecisions).toEqual({ 3: { action: 'skip' } });
  });

  it('the suggestion is one click away in "Fix this row only"', async () => {
    const { api, engine, convertWithDecisions } = setup();
    renderConvert(<ConvertPage />, { api, engine });
    await drop();
    await screen.findByText('Some rows need a look before the file is made');
    fireEvent.click(within(rowCard(3)).getByRole('button', { name: 'Fix this row only' }));
    fireEvent.click(within(rowCard(3)).getByRole('button', { name: /Use .*00123/ }));
    fireEvent.click(within(rowCard(3)).getByRole('button', { name: 'Use this value' }));
    fireEvent.click(screen.getByRole('button', { name: 'Create the file' }));
    await screen.findByText('Your file is ready');
    const decisions = (convertWithDecisions.mock.calls[1]![0] as unknown as { rowDecisions: Record<number, { values: Record<string, string> }> }).rowDecisions;
    expect(decisions[3]!.values.c_code).toBe('00123');
    // The other flagged column of the row keeps the value it had.
    expect(decisions[3]!.values.c_qty).toBe('abc');
  });

  it('a row a check would leave out is listed too, and can be kept', async () => {
    const { api, engine, convertWithDecisions } = setup({ blocked: true });
    renderConvert(<ConvertPage />, { api, engine });
    await drop();
    await screen.findByText('Some rows need a look before the file is made');
    expect(screen.getByTestId('review-count').textContent).toBe('4 rows are flagged.');
    expect(rowCard(12).textContent).toContain('left out because it fails the check on');
    fireEvent.click(within(rowCard(12)).getByRole('button', { name: 'Keep as is' }));
    fireEvent.click(screen.getByRole('button', { name: 'Create the file' }));
    await screen.findByText('Your file is ready');
    expect((convertWithDecisions.mock.calls[1]![0] as unknown as { rowDecisions: object }).rowDecisions).toEqual({ 12: { action: 'keep' } });
  });

  it('"Change the rule" holds the file and opens the source\'s rules editor, with the way back', async () => {
    const { api, engine } = setup();
    renderConvert(<ConvertPage />, { api, engine });
    await drop();
    await screen.findByText('Some rows need a look before the file is made');
    fireEvent.click(within(rowCard(3)).getByRole('button', { name: 'Change the rule' }));
    await waitFor(() => expect(screen.getByTestId('location').textContent).toContain('/formats/F1/sources/c1?'));
    expect(screen.getByTestId('location').textContent).toContain(`returnTo=${encodeURIComponent('/convert?resume=1')}`);
    expect(convertSession.peek()).toMatchObject({ conversionId: 'c1', formatId: 'F1' });
  });

  it('coming back (?resume=1) converts the held file again with the rules as they are now', async () => {
    const held = csvFile('jan.csv', SUPPLIER_A_CSV);
    convertSession.save({ file: held, conversionId: 'c1', formatId: 'F1' });
    const api = fakeConvertApi();
    const { engine, matchFile, convertWithDecisions } = fakeEngine();
    renderConvert(<ConvertPage />, { api, engine, route: '/convert?resume=1' });
    expect(await screen.findByText('Your file is ready')).toBeTruthy();
    // No matching again: the source is the one the user was on, and its rules are fetched fresh.
    expect(matchFile).not.toHaveBeenCalled();
    expect(api.conversion).toHaveBeenCalledWith('c1', expect.anything());
    expect(convertWithDecisions.mock.calls[0]![0]).toMatchObject({ mode: 'review' });
    expect(convertSession.peek()).toBeNull();
  });
});

describe('errors', () => {
  it('a file the worker cannot open says what to do', async () => {
    const { engine } = fakeEngine({ match: { ok: false, reason: 'unreadable' } });
    renderConvert(<ConvertPage />, { api: fakeConvertApi(), engine });
    await drop();
    expect(await screen.findByText(/We couldn't read this file/)).toBeTruthy();
  });

  it('rules that cannot run are not a crash', async () => {
    const { engine } = fakeEngine({ run: () => ({ ok: false, error: { code: 'invalidRules' } }) });
    renderConvert(<ConvertPage />, { api: fakeConvertApi(), engine });
    await drop();
    expect(await screen.findByText(/rules of this source can't run/)).toBeTruthy();
  });
});

describe('Hebrew', () => {
  it('the same screen is available in Hebrew, and the file names stay isolated', async () => {
    const { engine } = fakeEngine();
    renderConvert(<ConvertPage />, { api: fakeConvertApi(), engine, lang: 'he' });
    expect(await screen.findByText('המרת קובץ')).toBeTruthy();
    await drop('ינואר.csv', SUPPLIER_A_CSV, 'קובץ להמרה');
    expect(await screen.findByText('הקובץ שלכם מוכן')).toBeTruthy();
  });
});

