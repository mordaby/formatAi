// The Convert screen (SPEC 5 C, 8.15, 21 v5 item 5), with a fake worker and a fake API: matching a file to a SOURCE (auto, or
// choose among the top three), a source that feeds one format (runs at once) or several (which formats, each with its own review,
// then a download each and a zip), missing and renamed columns (detected once per source), the review of flagged rows BEFORE the
// file is written and the decisions it sends, the run summary, and what is (and is not) sent to the API.
import type { Flag, RunSummary } from '@formatai/engine';
import type { Rules } from '@formatai/shared';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BatchArgs, ConvertRunOutput, MatchFileArgs, MatchFileOutput } from '../src/worker/convertApi';
import type { EngineClient } from '../src/worker/engineClient';
import ConvertPage from '../src/pages/Convert';
import { convertSession } from '../src/pages/Convert/session';
import { csvFile, entry, fakeConvertApi, match, renderConvert, RULES, sourceEntry, SUPPLIER_A_CSV } from './helpers/convertKit';

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
  run?: (args: { mode: string; rowDecisions?: unknown; rules: Rules }) => ConvertRunOutput;
}
function fakeEngine(opts: EngineOpts = {}) {
  // Without an answer of its own the fake matcher picks the first source it was offered (a real matcher only ever answers with one of them).
  const matchFile = vi.fn(async (args: MatchFileArgs) => opts.match ?? ({ ok: true, headers: [], ranked: [], pick: { kind: 'auto', match: match({ id: args.signatures[0]?.id ?? 'c1' }) } } as MatchFileOutput));
  const convertWithDecisions = vi.fn(async (args: { mode: string; rowDecisions?: unknown; rules: Rules }) => (opts.run ? opts.run(args) : written()));
  const batch = vi.fn(async (_args: BatchArgs) => ({ zip: new ArrayBuffer(6), summary: new ArrayBuffer(4) }));
  const engine = { matchFile, convertWithDecisions, batch, terminate: vi.fn() } as unknown as EngineClient;
  return { engine, matchFile, convertWithDecisions, batch };
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

  it('never advertises one source feeding several formats: the lead speaks of "its format"', async () => {
    const api = fakeConvertApi();
    renderConvert(<ConvertPage />, { api, engine: fakeEngine().engine });
    expect(await screen.findByText('Drop a file. We find which of your sources it is and make it into its format.')).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/or formats|several formats|feeds/i);
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

// ---------------------------------------------------------------------------------------------------------------------
// Sources that feed formats (SPEC 5 C, 8.15)
// ---------------------------------------------------------------------------------------------------------------------

/** One source ("Supplier A") that feeds three formats; each conversion has its own rules (told apart by `rules.name`). */
const THREE = sourceEntry({
  sourceId: 's1',
  name: 'Supplier A',
  conversions: [
    { conversionId: 'c1', formatId: 'F1', formatName: 'Load file' },
    { conversionId: 'c2', formatId: 'F2', formatName: 'ERP load' },
    { conversionId: 'c3', formatId: 'F3', formatName: 'Ledger' },
  ],
});
const rulesFor = (id: string): Rules => ({ ...RULES, name: 'rules-' + id });
const rulesById = { c1: rulesFor('c1'), c2: rulesFor('c2'), c3: rulesFor('c3') };
const autoSource = (over: Partial<Parameters<typeof match>[0]> = {}): MatchFileOutput => ({ ok: true, headers: [], ranked: [], pick: { kind: 'auto', match: match({ id: 's1', ...over }) } });
const ranOrder = (calls: readonly unknown[][], mode: string): string[] =>
  calls
    .map((c) => c[0] as { mode: string; rules: Rules })
    .filter((a) => a.mode === mode)
    .map((a) => a.rules.name as string);
const rowCard = (n: number) => document.querySelector(`[data-testid="review-row"][data-row="${n}"]`) as HTMLElement;

describe('a source that feeds ONE format runs it at once', () => {
  it("matches SOURCES (the signature id is the source id) and runs that source's single conversion, with no question", async () => {
    // The source's id and its conversion's id differ: c9 is the conversion of source s1.
    const one = sourceEntry({ sourceId: 's1', name: 'Supplier A', conversions: [{ conversionId: 'c9', formatId: 'F1', formatName: 'Load file' }] });
    const api = fakeConvertApi({ entries: [one] });
    const { engine, matchFile, convertWithDecisions } = fakeEngine({ match: autoSource() });
    renderConvert(<ConvertPage />, { api, engine });
    await drop();
    expect(await screen.findByText('Your file is ready')).toBeTruthy();
    expect(matchFile.mock.calls[0]![0].signatures.map((s) => [s.id, s.name])).toEqual([['s1', 'Supplier A']]);
    expect(screen.queryByTestId('choose-formats')).toBeNull();
    expect(api.conversion).toHaveBeenCalledTimes(1);
    expect(api.conversion).toHaveBeenCalledWith('c9', expect.anything());
    expect(convertWithDecisions).toHaveBeenCalledTimes(1);
    expect(api.recordRun).toHaveBeenCalledWith('c9', { rows: 3, flagged: 0 });
    expect(screen.getByText(/Converted with .*Supplier A.* of .*Load file.*\./)).toBeTruthy();
  });

  it('a source with no conversion yet is not offered (nothing to run); a page with only such sources says there is nothing to convert with', async () => {
    const bare = sourceEntry({ sourceId: 's0', name: 'New supplier', conversions: [] });
    const { engine, matchFile } = fakeEngine();
    renderConvert(<ConvertPage />, { api: fakeConvertApi({ entries: [bare, entry({ conversionId: 'c1' })] }), engine });
    await drop();
    await screen.findByText('Your file is ready');
    expect(matchFile.mock.calls[0]![0].signatures.map((s) => s.id)).toEqual(['c1']);

    cleanup();
    renderConvert(<ConvertPage />, { api: fakeConvertApi({ entries: [bare] }), engine });
    expect(await screen.findByText('No formats to convert with yet')).toBeTruthy();
  });

  it('?format= keeps only the conversion that makes that format: a source that feeds several then runs that one at once', async () => {
    const api = fakeConvertApi({ entries: [THREE], rulesById });
    const { engine, matchFile, convertWithDecisions } = fakeEngine({ match: autoSource() });
    renderConvert(<ConvertPage />, { api, engine, route: '/convert?format=F2' });
    expect((await screen.findByTestId('only-format')).textContent).toContain('ERP load');
    await drop();
    await screen.findByText('Your file is ready');
    expect(matchFile.mock.calls[0]![0].signatures.map((s) => s.id)).toEqual(['s1']);
    expect(screen.queryByTestId('choose-formats')).toBeNull();
    expect(api.conversion).toHaveBeenCalledTimes(1);
    expect(api.conversion).toHaveBeenCalledWith('c2', expect.anything());
    expect(ranOrder(convertWithDecisions.mock.calls, 'review')).toEqual(['rules-c2']);
    expect(api.recordRun).toHaveBeenCalledTimes(1);
    expect(api.recordRun).toHaveBeenCalledWith('c2', expect.any(Object));
  });

  it('when several sources fit, each option says which formats the source feeds', async () => {
    const other = entry({ conversionId: 'c7', sourceId: 's7', sourceName: 'Supplier C', formatId: 'F7', formatName: 'Ledger' });
    const api = fakeConvertApi({ entries: [THREE, other], rulesById });
    const { engine, convertWithDecisions } = fakeEngine({
      match: { ok: true, headers: [], ranked: [], pick: { kind: 'choose', options: [match({ id: 's1', name: 'Supplier A', score: 0.7 }), match({ id: 's7', name: 'Supplier C', score: 0.6 })] } },
    });
    renderConvert(<ConvertPage />, { api, engine });
    await drop();
    await screen.findByText('Which source is this file?');
    const options = screen.getAllByTestId('source-option');
    expect(within(options[0]!).getByTestId('source-formats').textContent).toBe('Converted into:Load fileERP loadLedger');
    expect(within(options[1]!).getByTestId('source-formats').textContent).toBe('Converted into:Ledger');
    expect(convertWithDecisions).not.toHaveBeenCalled();

    // A source that feeds several formats goes on to "which formats?", not straight to a run.
    fireEvent.click(within(options[0]!).getByRole('button', { name: /Use this source/ }));
    expect(await screen.findByTestId('choose-formats')).toBeTruthy();
    expect(convertWithDecisions).not.toHaveBeenCalled();
  });
});

describe('a source that feeds SEVERAL formats', () => {
  const box = (name: string): HTMLInputElement => screen.getByRole('checkbox', { name }) as HTMLInputElement;

  it('asks which formats: all pre-checked, an All toggle, and Continue is off with none selected', async () => {
    const api = fakeConvertApi({ entries: [THREE], rulesById });
    const { engine, convertWithDecisions } = fakeEngine({ match: autoSource() });
    renderConvert(<ConvertPage />, { api, engine });
    await drop();

    expect(await screen.findByText('This file feeds 3 formats')).toBeTruthy();
    expect(screen.getByTestId('target-line').textContent).toBe('Matched to ⁨Supplier A⁩.');
    expect(['All formats', 'Load file', 'ERP load', 'Ledger'].map((n) => box(n).checked)).toEqual([true, true, true, true]);
    // Nothing is fetched or run until the user continues.
    expect(api.conversion).not.toHaveBeenCalled();
    expect(convertWithDecisions).not.toHaveBeenCalled();

    // One box off: All is no longer fully checked (it shows "partly").
    fireEvent.click(box('ERP load'));
    expect(box('All formats').checked).toBe(false);
    expect(box('All formats').indeterminate).toBe(true);
    // Checking All again selects everything; unchecking it clears everything, and then Continue is off.
    fireEvent.click(box('All formats'));
    expect(['Load file', 'ERP load', 'Ledger'].map((n) => box(n).checked)).toEqual([true, true, true]);
    fireEvent.click(box('All formats'));
    expect(['Load file', 'ERP load', 'Ledger'].map((n) => box(n).checked)).toEqual([false, false, false]);
    expect((screen.getByRole('button', { name: 'Continue' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('Choose at least one format.')).toBeTruthy();
    fireEvent.click(box('Ledger'));
    expect((screen.getByRole('button', { name: 'Continue' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('runs the chosen formats one after another, each with its OWN review before its file is written', async () => {
    const api = fakeConvertApi({ entries: [THREE], rulesById });
    const flags = [flag(3, 'c_qty')];
    const inputs = { 3: [{ columnId: 'c_qty', header: 'Qty', value: 'abc' }] };
    const { engine, convertWithDecisions } = fakeEngine({
      match: autoSource(),
      run: (args) => (args.mode === 'review' ? review(flags, inputs) : written({ flags, summary: summary({ rowsIn: 3, rowsOut: 2 }) })),
    });
    renderConvert(<ConvertPage />, { api, engine });
    await drop('jan.csv');
    await screen.findByText('This file feeds 3 formats');
    fireEvent.click(box('ERP load'));
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    // Format 1 of 2: its review, and nothing has been written or reported yet.
    await screen.findByText('Some rows need a look before the file is made');
    expect(screen.getByTestId('review-step').textContent).toBe('Format 1 of 2: ⁨Load file⁩');
    expect(screen.getByTestId('target-line').textContent).toContain('Load file');
    expect(ranOrder(convertWithDecisions.mock.calls, 'review')).toEqual(['rules-c1']);
    expect(api.recordRun).not.toHaveBeenCalled();
    fireEvent.click(within(rowCard(3)).getByRole('button', { name: 'Skip this row' }));
    fireEvent.click(screen.getByRole('button', { name: 'Create the file' }));

    // Format 2 of 2 (the unchecked format is skipped): its own review, its own decision.
    await waitFor(() => expect(screen.getByTestId('review-step').textContent).toBe('Format 2 of 2: ⁨Ledger⁩'));
    expect(ranOrder(convertWithDecisions.mock.calls, 'review')).toEqual(['rules-c1', 'rules-c3']);
    expect(screen.getByTestId('review-tally').textContent).toBe('0 kept · 0 skipped · 0 fixed · 1 not decided');
    fireEvent.click(within(rowCard(3)).getByRole('button', { name: 'Keep as is' }));
    fireEvent.click(screen.getByRole('button', { name: 'Create the file' }));

    // Each conversion was written with ITS decisions.
    expect(await screen.findByTestId('run-results')).toBeTruthy();
    const writes = convertWithDecisions.mock.calls.map((c) => c[0] as { mode: string; rules: Rules; rowDecisions?: unknown }).filter((a) => a.mode === 'write');
    expect(writes.map((w) => [w.rules.name, w.rowDecisions])).toEqual([
      ['rules-c1', { 3: { action: 'skip' } }],
      ['rules-c3', { 3: { action: 'keep' } }],
    ]);
    // c2 was never fetched or run; a run is recorded once per conversion that ran, counts only.
    expect(api.conversion.mock.calls.map((c) => c[0])).toEqual(['c1', 'c3']);
    expect(api.recordRun.mock.calls).toEqual([
      ['c1', { rows: 3, flagged: 1 }],
      ['c3', { rows: 3, flagged: 1 }],
    ]);
  });

  it('several results: every format is listed (rows, flags, a download each) and "Download all (zip)" packs a folder per format', async () => {
    const api = fakeConvertApi({ entries: [THREE], rulesById });
    const { engine, batch } = fakeEngine({
      match: autoSource(),
      run: (args) => (args.rules.name === 'rules-c2' ? written({ flags: [flag(3, 'c_qty')], summary: summary({ rowsIn: 10, rowsOut: 8 }) }) : written({ summary: summary({ rowsIn: 10, rowsOut: 10 }) })),
    });
    renderConvert(<ConvertPage />, { api, engine });
    await drop('jan.csv');
    fireEvent.click(await screen.findByRole('button', { name: 'Continue' }));

    // The ones with nothing to review go straight through: no review screen at all.
    expect(await screen.findByText('Your 3 files are ready')).toBeTruthy();
    expect(screen.queryByTestId('review')).toBeNull();
    const rows = screen.getAllByTestId('result-format');
    expect(rows.map((r) => r.querySelector('.bfile__name')?.textContent)).toEqual(['Load file', 'ERP load', 'Ledger']);
    expect(rows[0]!.textContent).toContain('10 rows in · 10 rows out');
    expect(rows[1]!.textContent).toContain('10 rows in · 8 rows out');
    expect(rows[1]!.textContent).toContain('1 flagged row');
    expect(rows[1]!.getAttribute('data-status')).toBe('convertedFlags');
    expect(rows[0]!.textContent).toContain('jan (converted).csv');
    expect(api.recordRun.mock.calls.map((c) => c[0])).toEqual(['c1', 'c2', 'c3']);

    // An individual download.
    fireEvent.click(within(rows[1]!).getByRole('button', { name: /Download the file for .*ERP load/ }));
    expect(downloaded).toHaveBeenLastCalledWith('jan (converted).csv', expect.any(ArrayBuffer), 'text/csv');

    // The zip: the worker's batch method, a folder per format, a summary row per format.
    fireEvent.click(screen.getByRole('button', { name: 'Download all (zip)' }));
    await waitFor(() => expect(downloaded).toHaveBeenLastCalledWith('jan (converted).zip', expect.any(ArrayBuffer), 'application/zip'));
    expect(batch).toHaveBeenCalledTimes(1);
    const args = batch.mock.calls[0]![0];
    expect(args.outputs.map((o) => [o.folder, o.fileName])).toEqual([
      ['Load file', 'jan (converted).csv'],
      ['ERP load', 'jan (converted).csv'],
      ['Ledger', 'jan (converted).csv'],
    ]);
    expect(args.summaryFileName).toBe('formatAI conversion summary.xlsx');
    expect(args.summary.files.rows.map((r) => r.slice(0, 7))).toEqual([
      ['jan.csv', 'Load file', 'Supplier A', 'Converted', 10, 10, 0],
      ['jan.csv', 'ERP load', 'Supplier A', 'Converted with flags', 10, 8, 1],
      ['jan.csv', 'Ledger', 'Supplier A', 'Converted', 10, 10, 0],
    ]);
    expect(args.summary.flags.rows.map((r) => [r[0], r[1], r[2]])).toEqual([['ERP load', 3, 'Qty']]);
  });

  it('a zip that cannot be packed says so, and the single downloads still work', async () => {
    const api = fakeConvertApi({ entries: [THREE], rulesById });
    const { engine, batch } = fakeEngine({ match: autoSource() });
    batch.mockRejectedValueOnce(new Error('boom'));
    renderConvert(<ConvertPage />, { api, engine });
    await drop('jan.csv');
    fireEvent.click(await screen.findByRole('button', { name: 'Continue' }));
    await screen.findByText('Your 3 files are ready');
    fireEvent.click(screen.getByRole('button', { name: 'Download all (zip)' }));
    expect(await screen.findByText("We couldn't pack the zip. Try again.")).toBeTruthy();
    expect(downloaded).not.toHaveBeenCalled();
    fireEvent.click(within(screen.getAllByTestId('result-format')[0]!).getByRole('button', { name: /Download the file for/ }));
    expect(downloaded).toHaveBeenCalledTimes(1);
    // Trying again works.
    fireEvent.click(screen.getByRole('button', { name: 'Download all (zip)' }));
    await waitFor(() => expect(downloaded).toHaveBeenLastCalledWith('jan (converted).zip', expect.any(ArrayBuffer), 'application/zip'));
  });

  it("exactly one chosen format is today's result screen, not the list", async () => {
    const api = fakeConvertApi({ entries: [THREE], rulesById });
    const { engine } = fakeEngine({ match: autoSource() });
    renderConvert(<ConvertPage />, { api, engine });
    await drop();
    await screen.findByText('This file feeds 3 formats');
    fireEvent.click(box('All formats'));
    fireEvent.click(box('Ledger'));
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByText('Your file is ready')).toBeTruthy();
    expect(screen.queryByTestId('run-results')).toBeNull();
    expect(screen.getByRole('button', { name: 'Download the file' })).toBeTruthy();
    expect(api.recordRun.mock.calls).toEqual([['c3', { rows: 3, flagged: 0 }]]);
  });

  it('a format that cannot run does not stop the others: it is listed with why', async () => {
    const api = fakeConvertApi({ entries: [THREE], rulesById });
    const { engine } = fakeEngine({
      match: autoSource(),
      run: (args) => (args.rules.name === 'rules-c2' ? { ok: false, error: { code: 'invalidRules' } } : written()),
    });
    renderConvert(<ConvertPage />, { api, engine });
    await drop();
    fireEvent.click(await screen.findByRole('button', { name: 'Continue' }));
    expect(await screen.findByText('Your 2 files are ready')).toBeTruthy();
    expect(screen.getAllByTestId('result-format')).toHaveLength(2);
    const failed = screen.getByTestId('result-failed');
    expect(failed.textContent).toContain("These formats couldn't be made");
    expect(failed.textContent).toContain('ERP load');
    expect(failed.textContent).toContain("The rules of this source can't run");
    expect(api.recordRun.mock.calls.map((c) => c[0])).toEqual(['c1', 'c3']);
  });

  it('"Change the rule" keeps the rest of the run: coming back runs that format again and goes on with the others', async () => {
    const api = fakeConvertApi({ entries: [THREE], rulesById });
    const flags = [flag(3, 'c_qty')];
    const run = (args: { mode: string; rules: Rules }) => (args.rules.name === 'rules-c1' && args.mode === 'review' ? review(flags, { 3: [{ columnId: 'c_qty', header: 'Qty', value: 'abc' }] }) : written());
    const first = fakeEngine({ match: autoSource(), run });
    renderConvert(<ConvertPage />, { api, engine: first.engine });
    await drop();
    await screen.findByText('This file feeds 3 formats');
    fireEvent.click(box('ERP load'));
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await screen.findByText('Some rows need a look before the file is made');
    fireEvent.click(within(rowCard(3)).getByRole('button', { name: 'Change the rule' }));
    await waitFor(() => expect(screen.getByTestId('location').textContent).toContain('/formats/F1/sources/c1?'));
    // The file, the queue and the renames wait in memory.
    const held = convertSession.peek();
    expect(held).toMatchObject({ conversionId: 'c1', formatId: 'F1' });
    expect(held?.job?.queue.map((c) => c.conversionId)).toEqual(['c1', 'c3']);
    expect(held?.job?.index).toBe(0);
    expect(api.recordRun).not.toHaveBeenCalled();

    // Back from the editor: c1 (edited) runs again with no review this time, then c3 follows.
    cleanup();
    const second = fakeEngine({ match: autoSource(), run: () => written() });
    renderConvert(<ConvertPage />, { api, engine: second.engine, route: '/convert?resume=1' });
    expect(await screen.findByText('Your 2 files are ready')).toBeTruthy();
    expect(second.matchFile).not.toHaveBeenCalled();
    expect(ranOrder(second.convertWithDecisions.mock.calls, 'review')).toEqual(['rules-c1', 'rules-c3']);
    expect(api.recordRun.mock.calls.map((c) => c[0])).toEqual(['c1', 'c3']);
    expect(convertSession.peek()).toBeNull();
  });
});

describe('a structural change is detected ONCE per source', () => {
  const two = sourceEntry({
    sourceId: 's1',
    name: 'Supplier A',
    conversions: [
      { conversionId: 'c1', formatId: 'F1', formatName: 'Load file' },
      { conversionId: 'c2', formatId: 'F2', formatName: 'ERP load' },
    ],
  });
  const twoRules = { c1: rulesFor('c1'), c2: rulesFor('c2') };
  const renamedMatch = (): MatchFileOutput => autoSource({ score: 0.9, missingRequired: ['Qty'], extra: ['Weird', 'Quantity'], renamedCandidates: [{ required: 'Qty', candidates: ['Quantity'] }] });
  const affected = () => within(screen.getByTestId('affected-formats')).getAllByRole('listitem').map((li) => li.textContent);

  it('a renamed column: the step lists EVERY format it affects, and the confirmed mapping is saved once, on the source', async () => {
    const api = fakeConvertApi({ entries: [two], rulesById: twoRules });
    const { engine, matchFile, convertWithDecisions } = fakeEngine({ match: renamedMatch() });
    renderConvert(<ConvertPage />, { api, engine });
    await drop();
    expect(await screen.findByText('Is a column named differently?')).toBeTruthy();
    expect(affected()).toEqual(['Load file', 'ERP load']);
    expect(screen.getByText(/saved on the source, so next time it applies to all 2 of its formats/)).toBeTruthy();
    // Detected at match time, once: no conversion has been fetched or run yet.
    expect(matchFile).toHaveBeenCalledTimes(1);
    expect(api.conversion).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    // The mapping is saved ONCE, on the source (never per conversion) ...
    await screen.findByText('This file feeds 2 formats');
    expect(api.addAlias).toHaveBeenCalledTimes(1);
    expect(api.addAlias).toHaveBeenCalledWith('s1', { header: 'Qty', alias: 'Quantity' });
    // ... and the next file re-reads the signatures (the alias is in them now).
    await waitFor(() => expect(api.signatures).toHaveBeenCalledTimes(2));

    // ... and it is applied in memory to EVERY conversion that runs, without asking again.
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await screen.findByText('Your 2 files are ready');
    const reviews = convertWithDecisions.mock.calls.map((c) => c[0] as unknown as { mode: string; rules: Rules }).filter((a) => a.mode === 'review');
    expect(reviews.map((r) => r.rules.name)).toEqual(['rules-c1', 'rules-c2']);
    for (const r of reviews) expect(r.rules.input.columns.find((c) => c.id === 'c_qty')?.aliases).toEqual(['Quantity']);
    expect(matchFile).toHaveBeenCalledTimes(1);
    expect(api.addAlias).toHaveBeenCalledTimes(1);
  });

  it('a renamed column on a source with ONE format is saved once and that format runs', async () => {
    const api = fakeConvertApi();
    const { engine } = fakeEngine({
      match: { ok: true, headers: [], ranked: [], pick: { kind: 'auto', match: match({ id: 'c1', score: 0.9, missingRequired: ['Qty'], extra: ['Quantity'], renamedCandidates: [{ required: 'Qty', candidates: ['Quantity'] }] }) } },
    });
    renderConvert(<ConvertPage />, { api, engine });
    await drop();
    await screen.findByText('Is a column named differently?');
    expect(affected()).toEqual(['Load file']);
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await screen.findByText('Your file is ready');
    expect(api.addAlias).toHaveBeenCalledTimes(1);
    expect(api.addAlias).toHaveBeenCalledWith('c1', { header: 'Qty', alias: 'Quantity' });
  });

  it('a missing column nothing can stand in for stops the run and names every affected format', async () => {
    const api = fakeConvertApi({ entries: [two], rulesById: twoRules });
    const { engine, convertWithDecisions } = fakeEngine({ match: autoSource({ score: 0.9, missingRequired: ['Qty'], extra: [] }) });
    renderConvert(<ConvertPage />, { api, engine });
    await drop();
    const missing = await screen.findByTestId('missing-columns');
    expect(within(screen.getByTestId('missing-list')).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['Qty']);
    expect(missing.textContent).toContain('Formats this affects:');
    expect(affected()).toEqual(['Load file', 'ERP load']);
    expect(convertWithDecisions).not.toHaveBeenCalled();
    expect(api.conversion).not.toHaveBeenCalled();
    expect(api.addAlias).not.toHaveBeenCalled();
    expect(api.recordRun).not.toHaveBeenCalled();
  });

  it('on ?format= only the formats of the page are listed as affected', async () => {
    const api = fakeConvertApi({ entries: [two], rulesById: twoRules });
    const { engine } = fakeEngine({ match: autoSource({ score: 0.9, missingRequired: ['Qty'], extra: [] }) });
    renderConvert(<ConvertPage />, { api, engine, route: '/convert?format=F2' });
    await screen.findByTestId('only-format');
    await drop();
    await screen.findByTestId('missing-columns');
    expect(affected()).toEqual(['ERP load']);
  });

  it("\"it isn't in this file\" ends with the exact missing header and the affected formats, and saves nothing", async () => {
    const api = fakeConvertApi({ entries: [two], rulesById: twoRules });
    const { engine } = fakeEngine({ match: renamedMatch() });
    renderConvert(<ConvertPage />, { api, engine });
    await drop();
    await screen.findByText('Is a column named differently?');
    fireEvent.change(screen.getByLabelText(/The column .*Qty.* is/), { target: { value: '__none__' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect((await screen.findByTestId('missing-list')).textContent).toBe('Qty');
    expect(affected()).toEqual(['Load file', 'ERP load']);
    expect(api.addAlias).not.toHaveBeenCalled();
    expect(api.conversion).not.toHaveBeenCalled();
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

  it('a source that feeds several formats: the formats step and the results are in Hebrew, with every name isolated', async () => {
    const hebrew = sourceEntry({
      sourceId: 's1',
      name: 'ספק א',
      conversions: [
        { conversionId: 'c1', formatId: 'F1', formatName: 'קובץ טעינה' },
        { conversionId: 'c2', formatId: 'F2', formatName: 'ERP load' },
      ],
    });
    const { engine } = fakeEngine({ match: autoSource() });
    renderConvert(<ConvertPage />, { api: fakeConvertApi({ entries: [hebrew], rulesById }), engine, lang: 'he' });
    await drop('ינואר.csv', SUPPLIER_A_CSV, 'קובץ להמרה');
    expect(await screen.findByText('הקובץ הזה מזין 2 פורמטים')).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: 'כל הפורמטים' })).toBeTruthy();
    // A format name is a <bdi>: a Hebrew name never reorders the words around it, and an English one stays whole.
    expect(screen.getByText('קובץ טעינה').tagName).toBe('BDI');
    expect(screen.getByText('ERP load').tagName).toBe('BDI');
    fireEvent.click(screen.getByRole('button', { name: 'המשך' }));
    expect(await screen.findByText('2 הקבצים שלכם מוכנים')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'הורדת הכול (zip)' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /הורדת הקובץ של .*ERP load/ })).toBeTruthy();
  });
});

