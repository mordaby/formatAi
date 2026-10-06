// "Do this every time?" on the Run screen's row review (SPEC 5 C, 8.4a, 21 v12): after the user types a fix for one cell, one quiet choice
// turns it into a rule of the format - `readAs` on that input column, saved as a NEW VERSION of the conversion through the editor's own
// route, for the source and every format it feeds - and the current run goes on with the rule. Run through the REAL engine (the worker
// methods in-process), with a fake API that remembers what was saved, so "the run continues with the new rule" is seen in what the engine
// flags, not only in what the screen sends.
import type { Flag } from '@formatai/engine';
import type { Rules, UpdateConversionRequest } from '@formatai/shared';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../src/i18n';
import ConvertPage from '../src/pages/Convert';
import { ReviewRows } from '../src/pages/Convert/ReviewRows';
import { convertSession } from '../src/pages/Convert/session';
import { createEngineClient } from '../src/worker/engineClient';
import { engineMethods } from '../src/worker/engineMethods';
import { csvFile, fakeConvertApi, renderConvert, RULES, sourceEntry, type FakeConvertApi } from './helpers/convertKit';
import { loopbackWorker } from './helpers/loopback';

vi.mock('../src/app/SignIn', () => ({ useSignIn: () => ({ open: vi.fn(), close: vi.fn() }) }));
vi.mock('../src/flow/download', async (orig) => ({ ...(await orig<typeof import('../src/flow/download')>()), downloadBytes: vi.fn() }));

beforeEach(() => convertSession.clear());
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/** Row 3 and 4 have "N/A" for the quantity, row 5 has it for the price; everything else is clean. */
const CSV = 'Item Code,Qty,Price,Extra\n00001,5,10.5,x\n00002,N/A,3,y\n00003,N/A,4,z\n00004,7,N/A,w\n';

const plain = (el: Element | null): string => (el?.textContent ?? '').replace(/[⁦-⁩]/g, '').replace(/\s+/g, ' ').trim();
const rowCard = (n: number) => document.querySelector(`[data-testid="review-row"][data-row="${n}"]`) as HTMLElement;

function realEngine() {
  const engine = createEngineClient({ createWorker: () => loopbackWorker(engineMethods) });
  const calls: { mode: string; rules: Rules; rowDecisions?: unknown }[] = [];
  const original = engine.convertWithDecisions.bind(engine);
  engine.convertWithDecisions = ((args: Parameters<typeof original>[0], opts: Parameters<typeof original>[1]) => {
    calls.push(args as unknown as (typeof calls)[number]);
    return original(args, opts);
  }) as typeof engine.convertWithDecisions;
  return { engine, calls };
}

/** A fake API where a save is REMEMBERED: the next read of any conversion of the source returns what the server would (the source change reaches them all). */
function apiWithServer(opts: { formats?: { id: string; formatId: string; formatName: string }[]; status?: 'verified' | 'needsReview'; rules?: Rules } = {}): { api: FakeConvertApi; stored: Map<string, Rules>; saves: { id: string; body: UpdateConversionRequest }[] } {
  const formats = opts.formats ?? [{ id: 'c1', formatId: 'F1', formatName: 'Load file' }];
  const source = sourceEntry({ sourceId: 's1', conversions: formats.map((f) => ({ conversionId: f.id, formatId: f.formatId, formatName: f.formatName })) });
  const api = fakeConvertApi({ entries: [source] });
  const stored = new Map<string, Rules>(formats.map((f) => [f.id, structuredClone(opts.rules ?? RULES)]));
  const versions = new Map<string, number>(formats.map((f) => [f.id, 1]));
  const saves: { id: string; body: UpdateConversionRequest }[] = [];
  const read = api.conversion.getMockImplementation()!;
  api.conversion.mockImplementation(async (id: string, signal?: AbortSignal) => ({ ...(await read(id, signal)), rules: structuredClone(stored.get(id)!), version: versions.get(id)!, status: opts.status ?? 'verified' }));
  api.saveRules.mockImplementation(async (id, body) => {
    saves.push({ id, body });
    if (body.baseVersion !== versions.get(id)) throw new Error('versionConflict');
    // The server writes the editing conversion's columns to the source, and so to every conversion of it.
    for (const f of formats) {
      stored.set(f.id, f.id === id ? structuredClone(body.rules as Rules) : { ...structuredClone(stored.get(f.id)!), input: structuredClone((body.rules as Rules).input) });
      versions.set(f.id, versions.get(f.id)! + 1);
    }
    return {
      conversion: { ...(await read(id)), version: versions.get(id)! },
      formatChanged: false,
      affectedSources: 0,
      needsReview: [],
      sourceChanged: true,
      affectedConversions: formats.length - 1,
    };
  });
  return { api, stored, saves };
}

async function drop(name = 'jan.csv', body = CSV) {
  const input = await screen.findByLabelText('Files to convert');
  await act(async () => {
    fireEvent.change(input, { target: { files: [csvFile(name, body)] } });
  });
}

/** Opens "Fix this row only" on a row, types a value into a field, and applies it (optionally saying "Do this every time?"). */
function fix(row: number, field: string, value: string, opts: { every?: boolean } = {}) {
  fireEvent.click(within(rowCard(row)).getByRole('button', { name: 'Fix this row only' }));
  fireEvent.change(within(rowCard(row)).getByLabelText(field), { target: { value } });
  if (opts.every) fireEvent.click(within(rowCard(row)).getByRole('checkbox', { name: /Do this every time/ }));
  fireEvent.click(within(rowCard(row)).getByRole('button', { name: 'Use this value' }));
}

const REVIEW = 'Some rows need a look before the file is made';

describe('the offer', () => {
  it('shows after a typed fix of a text cell - and says in plain words what yes means, and how many rows have it', async () => {
    const { engine } = realEngine();
    renderConvert(<ConvertPage />, { api: apiWithServer().api, engine });
    await drop();
    await screen.findByText(REVIEW);
    expect(screen.getByTestId('review-count').textContent).toBe('3 rows are flagged.');

    fireEvent.click(within(rowCard(3)).getByRole('button', { name: 'Fix this row only' }));
    // Nothing is typed yet: nothing to offer.
    expect(within(rowCard(3)).queryByTestId('keep-offer')).toBeNull();
    fireEvent.change(within(rowCard(3)).getByLabelText('Qty'), { target: { value: '' } });
    const offer = within(rowCard(3)).getByTestId('keep-offer');
    expect(within(offer).getByRole('checkbox', { name: /Do this every time\?/ })).toBeTruthy();
    expect((within(offer).getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
    expect(plain(within(offer).getByTestId('keep-line'))).toBe("Every 'N/A' in Qty will be read as empty. It covers all 2 rows in this list that have it.");

    // The hint above the fields tells the truth about the tick: the rule stays as it is - until yes, which saves it when the file is created.
    expect(rowCard(3).textContent).toContain('The rule stays as it is. Only this file changes.');
    fireEvent.click(within(offer).getByRole('checkbox'));
    expect(rowCard(3).textContent).toContain('Only this file changes now. The rule is saved when you create the file.');
    expect(rowCard(3).textContent).not.toContain('The rule stays as it is');
    fireEvent.click(within(offer).getByRole('checkbox'));
    expect(rowCard(3).textContent).toContain('The rule stays as it is. Only this file changes.');

    // A typed value says what it is read as; the same text with nothing changed offers nothing.
    fireEvent.change(within(rowCard(3)).getByLabelText('Qty'), { target: { value: '0' } });
    expect(plain(within(offer).getByTestId('keep-line'))).toContain("Every 'N/A' in Qty will be read as '0'.");
    fireEvent.change(within(rowCard(3)).getByLabelText('Qty'), { target: { value: 'N/A' } });
    expect(within(rowCard(3)).queryByTestId('keep-offer')).toBeNull();
  });

  it('one row only has the text: no count is claimed', async () => {
    const { engine } = realEngine();
    renderConvert(<ConvertPage />, { api: apiWithServer().api, engine });
    await drop();
    await screen.findByText(REVIEW);
    fireEvent.click(within(rowCard(5)).getByRole('button', { name: 'Fix this row only' }));
    fireEvent.change(within(rowCard(5)).getByLabelText('Price'), { target: { value: '' } });
    expect(plain(within(rowCard(5)).getByTestId('keep-line'))).toBe("Every 'N/A' in Price will be read as empty.");
  });

  it('is not offered for skip or keep, nor for a fix of a number, a date or an empty cell', async () => {
    const { engine } = realEngine();
    const { api } = apiWithServer();
    renderConvert(<ConvertPage />, { api, engine });
    await drop();
    await screen.findByText(REVIEW);
    fireEvent.click(within(rowCard(3)).getByRole('button', { name: 'Skip this row' }));
    fireEvent.click(within(rowCard(4)).getByRole('button', { name: 'Keep as is' }));
    expect(screen.queryByTestId('keep-offer')).toBeNull();
    expect(screen.queryByText(/saved as a rule when you create the file/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Create the file' }));
    await screen.findByText('Your file is ready');
    // Nothing was kept, so nothing was saved: not even a read of the rules again.
    expect(api.saveRules).not.toHaveBeenCalled();
    expect(screen.queryByTestId('kept-rules')).toBeNull();
  });

  it('is not offered for a cell that is not text in the file (an xlsx number), nor when the typed value is the cell\'s own', () => {
    const rows = [{ rowNumber: 3, flags: [{ rowNumber: 3, column: 'c_qty', rule: 'type', value: 7, messageKey: 'flag.validation.range' } as Flag], blocked: null }];
    const rowInputs = { 3: [{ columnId: 'c_qty', header: 'Qty', value: 7 }] };
    render(
      <I18nProvider initial="en">
        <ReviewRows target={{ rules: RULES }} step={null} rows={rows} rowInputs={rowInputs} choices={{}} onChoice={() => undefined} onKeepAll={() => undefined} onSkipAll={() => undefined} onClear={() => undefined} keepRule={{ formats: 1 }} onCreate={() => undefined} />
      </I18nProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Fix this row only' }));
    fireEvent.change(screen.getByLabelText('Qty'), { target: { value: '8' } });
    expect(screen.queryByTestId('keep-offer')).toBeNull();
  });

  it('is not offered where rules are not saved: no keepRule (Result\'s "Try it on another file")', () => {
    const rows = [{ rowNumber: 3, flags: [{ rowNumber: 3, column: 'c_qty', rule: 'type', value: 'N/A', messageKey: 'flag.parseFailed.integer' } as Flag], blocked: null }];
    const rowInputs = { 3: [{ columnId: 'c_qty', header: 'Qty', value: 'N/A', isText: true as const }] };
    render(
      <I18nProvider initial="en">
        <ReviewRows target={{ rules: RULES }} step={null} rows={rows} rowInputs={rowInputs} choices={{}} onChoice={() => undefined} onKeepAll={() => undefined} onSkipAll={() => undefined} onClear={() => undefined} onCreate={() => undefined} />
      </I18nProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Fix this row only' }));
    fireEvent.change(screen.getByLabelText('Qty'), { target: { value: '' } });
    expect(screen.queryByTestId('keep-offer')).toBeNull();
  });

  it('is not offered for a conversion that needs review (saving would have to pick its status)', async () => {
    const { engine } = realEngine();
    renderConvert(<ConvertPage />, { api: apiWithServer({ status: 'needsReview' }).api, engine });
    await drop();
    await screen.findByText(REVIEW);
    fireEvent.click(within(rowCard(3)).getByRole('button', { name: 'Fix this row only' }));
    fireEvent.change(within(rowCard(3)).getByLabelText('Qty'), { target: { value: '' } });
    expect(within(rowCard(3)).queryByTestId('keep-offer')).toBeNull();
  });
});

describe('saying yes', () => {
  it('saves a NEW VERSION with the mapping, covers every row with the same text, and the run goes on with the rule', async () => {
    const { engine, calls } = realEngine();
    const { api, stored, saves } = apiWithServer();
    renderConvert(<ConvertPage />, { api, engine });
    await drop();
    await screen.findByText(REVIEW);

    fix(3, 'Qty', '', { every: true });
    expect(rowCard(3).textContent).toContain('Will be fixed, and saved as a rule when you create the file');
    expect(rowCard(3).textContent).not.toContain('in this file only');
    // Nothing is saved until the file is created: the user can still undo it.
    expect(api.saveRules).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Create the file' }));
    expect(await screen.findByText('Your file is ready')).toBeTruthy();

    // One save, through the editor's route: the rules as the server had them plus the mapping, with the version it read as the base.
    expect(saves).toHaveLength(1);
    expect(saves[0]!.id).toBe('c1');
    const saved = saves[0]!.body;
    expect(saved).toMatchObject({ status: 'verified', acceptedDifferences: 0, baseVersion: 1 });
    expect((saved.rules as Rules).input.columns.map((c) => [c.id, c.readAs])).toEqual([['c_code', undefined], ['c_qty', { 'N/A': '' }], ['c_price', undefined]]);
    // Nothing else of the rules changed.
    expect({ ...(saved.rules as Rules), input: RULES.input }).toEqual(RULES);
    expect(stored.get('c1')!.input.columns[1]!.readAs).toEqual({ 'N/A': '' });

    // The run went on with the rule: row 3's fix is no longer a per-run decision, and row 4 (the same text, never touched) is covered too.
    const write = calls.find((c) => c.mode === 'write')!;
    expect(write.rules.input.columns[1]!.readAs).toEqual({ 'N/A': '' });
    expect(write.rowDecisions).toEqual({});
    expect(plain(screen.getByTestId('run-flags'))).not.toContain('Row 3');
    expect(plain(screen.getByTestId('run-flags'))).not.toContain('Row 4');
    expect(plain(screen.getByTestId('run-flags'))).toContain('Row 5');
    expect(api.recordRun).toHaveBeenCalledWith('c1', { rows: 4, flagged: 1 });

    // And it says so: the rule, the version (undone by restoring the one before it), nothing about other formats (there are none).
    const note = screen.getByTestId('kept-rules');
    expect(plain(note)).toContain('Saved as a rule');
    expect(plain(within(note).getByTestId('kept-fix'))).toBe("Every 'N/A' in Qty is now read as empty.");
    expect(plain(note)).toContain('Saved as version 2 of Load file. To undo it, restore the previous version in the editor.');
    expect(plain(note)).not.toContain('other format');
  });

  it('a typed value is the value it is read as ("0"), and the saved mapping carries exactly that', async () => {
    const { engine } = realEngine();
    const { api, saves } = apiWithServer();
    renderConvert(<ConvertPage />, { api, engine });
    await drop();
    await screen.findByText(REVIEW);
    fix(3, 'Qty', '0', { every: true });
    fireEvent.click(screen.getByRole('button', { name: 'Create the file' }));
    await screen.findByText('Your file is ready');
    expect((saves[0]!.body.rules as Rules).input.columns[1]!.readAs).toEqual({ 'N/A': '0' });
    expect(plain(screen.getByTestId('kept-rules'))).toContain("Every 'N/A' in Qty is now read as '0'.");
  });

  it('without the tick the fix is for this file only: nothing is saved, and the row decision stays', async () => {
    const { engine, calls } = realEngine();
    const { api } = apiWithServer();
    renderConvert(<ConvertPage />, { api, engine });
    await drop();
    await screen.findByText(REVIEW);
    fix(3, 'Qty', '');
    expect(rowCard(3).textContent).not.toContain('saved as a rule when you create the file');
    fireEvent.click(screen.getByRole('button', { name: 'Create the file' }));
    await screen.findByText('Your file is ready');
    expect(api.saveRules).not.toHaveBeenCalled();
    expect(calls.find((c) => c.mode === 'write')!.rowDecisions).toEqual({ 3: { action: 'override', values: { c_qty: null } } });
  });

  it('undoing the fix takes the rule back too: nothing is saved', async () => {
    const { engine } = realEngine();
    const { api } = apiWithServer();
    renderConvert(<ConvertPage />, { api, engine });
    await drop();
    await screen.findByText(REVIEW);
    fix(3, 'Qty', '', { every: true });
    fireEvent.click(within(rowCard(3)).getByRole('button', { name: 'Undo' }));
    expect(rowCard(3).textContent).not.toContain('saved as a rule when you create the file');
    fireEvent.click(screen.getByRole('button', { name: 'Create the file' }));
    await screen.findByText('Your file is ready');
    expect(api.saveRules).not.toHaveBeenCalled();
  });

  it('two columns kept at once are one save, one version', async () => {
    const { engine } = realEngine();
    const { api, saves } = apiWithServer();
    renderConvert(<ConvertPage />, { api, engine });
    await drop();
    await screen.findByText(REVIEW);
    fix(3, 'Qty', '', { every: true });
    fix(5, 'Price', '', { every: true });
    fireEvent.click(screen.getByRole('button', { name: 'Create the file' }));
    await screen.findByText('Your file is ready');
    expect(saves).toHaveLength(1);
    expect((saves[0]!.body.rules as Rules).input.columns.map((c) => c.readAs)).toEqual([undefined, { 'N/A': '' }, { 'N/A': '' }]);
    expect(plain(screen.getByTestId('run-flags'))).not.toContain('Row');
  });

  it('two rows that keep the same text as different values cannot both be saved: the second is not offered a tick', async () => {
    const { engine } = realEngine();
    const { api } = apiWithServer();
    renderConvert(<ConvertPage />, { api, engine });
    await drop();
    await screen.findByText(REVIEW);
    fix(3, 'Qty', '', { every: true });
    fireEvent.click(within(rowCard(4)).getByRole('button', { name: 'Fix this row only' }));
    fireEvent.change(within(rowCard(4)).getByLabelText('Qty'), { target: { value: '9' } });
    const offer = within(rowCard(4)).getByTestId('keep-offer');
    expect((within(offer).getByRole('checkbox') as HTMLInputElement).disabled).toBe(true);
    expect(plain(within(offer).getByTestId('keep-line'))).toBe("Another row in this list already reads 'N/A' in Qty another way. A text is read one way only.");
    // typed the same way as the first one, it is the same fact and can be ticked
    fireEvent.change(within(rowCard(4)).getByLabelText('Qty'), { target: { value: '' } });
    expect((within(offer).getByRole('checkbox') as HTMLInputElement).disabled).toBe(false);
  });

  it('a save that fails does not stop the file: the fix is used for this file, and the user is told it was not saved', async () => {
    const { engine, calls } = realEngine();
    const { api } = apiWithServer();
    api.saveRules.mockRejectedValue(new Error('network'));
    renderConvert(<ConvertPage />, { api, engine });
    await drop();
    await screen.findByText(REVIEW);
    fix(3, 'Qty', '', { every: true });
    fireEvent.click(screen.getByRole('button', { name: 'Create the file' }));
    expect(await screen.findByText('Your file is ready')).toBeTruthy();
    expect(plain(screen.getByTestId('kept-rules'))).toContain("We couldn't save this as a rule, but your fix was used in this file.");
    expect(plain(screen.getByTestId('kept-rules'))).not.toContain('Saved as version');
    const write = calls.find((c) => c.mode === 'write')!;
    expect(write.rules.input.columns[1]!.readAs).toBeUndefined();
    expect(write.rowDecisions).toEqual({ 3: { action: 'override', values: { c_qty: null } } });
  });

  it('a conversion someone else changed meanwhile is a refusal, never an overwrite (the version read is the base)', async () => {
    const { engine } = realEngine();
    const { api } = apiWithServer();
    const read = api.conversion.getMockImplementation()!;
    let reads = 0;
    api.conversion.mockImplementation(async (id: string, signal?: AbortSignal) => ({ ...(await read(id, signal)), version: ++reads === 1 ? 1 : 5 }));
    api.saveRules.mockImplementation(async (_id, body) => {
      if (body.baseVersion !== 5) throw new Error('unexpected base');
      throw Object.assign(new Error('versionConflict'), { code: 'versionConflict' });
    });
    renderConvert(<ConvertPage />, { api, engine });
    await drop();
    await screen.findByText(REVIEW);
    fix(3, 'Qty', '', { every: true });
    fireEvent.click(screen.getByRole('button', { name: 'Create the file' }));
    await screen.findByText('Your file is ready');
    expect(api.saveRules).toHaveBeenCalledTimes(1);
    expect(plain(screen.getByTestId('kept-rules'))).toContain('Not saved as a rule');
  });
});

describe('a list copied from the example in the stored rules (owner decision 2026-10-06: asked at Save only)', () => {
  // Supplier by Item Code: a lookup table of the example's codes, kept at the Save that asked about it.
  const withList: Rules = {
    ...RULES,
    transform: {
      ...RULES.transform,
      computed: [{ id: 'c_supplier', type: 'text', expr: { op: 'lookup', table: 'suppliers', key: { col: 'c_code' }, return: 'supplier', onMissing: 'flag' } }],
      tables: [{ name: 'suppliers', columns: ['code', 'supplier'], rows: ['00001', '00002', '00003', '00004'].map((code, i) => [code, `Supplier ${i + 1}`]) }],
    },
    output: { ...RULES.output, columns: [...RULES.output.columns, { header: 'Supplier', from: 'c_supplier' }] },
  };

  it('"Do this every time?" saves the new version at once, the list as it is: nothing new is stored, so nothing is asked', async () => {
    const { engine } = realEngine();
    const { api, saves } = apiWithServer({ rules: withList });
    renderConvert(<ConvertPage />, { api, engine });
    await drop();
    await screen.findByText(REVIEW);
    fix(3, 'Qty', '', { every: true });
    fireEvent.click(screen.getByRole('button', { name: 'Create the file' }));
    expect(await screen.findByText('Your file is ready')).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(saves).toHaveLength(1);
    const saved = saves[0]!.body.rules as Rules;
    expect(saved.transform.tables).toEqual(withList.transform.tables);
    expect(saved.output.columns.at(-1)).toEqual({ header: 'Supplier', from: 'c_supplier' });
    expect(saved.input.columns[1]!.readAs).toEqual({ 'N/A': '' });
  });
});

describe('a source that feeds several formats', () => {
  const TWO = [
    { id: 'c1', formatId: 'F1', formatName: 'Load file' },
    { id: 'c2', formatId: 'F2', formatName: 'Ledger' },
  ];

  it('says so in the line, as the editor does: "This changes the source for N formats."', async () => {
    const { engine } = realEngine();
    renderConvert(<ConvertPage />, { api: apiWithServer({ formats: TWO }).api, engine });
    await drop();
    fireEvent.click(await screen.findByRole('button', { name: 'Continue' }));
    await screen.findByText(REVIEW);
    fireEvent.click(within(rowCard(3)).getByRole('button', { name: 'Fix this row only' }));
    fireEvent.change(within(rowCard(3)).getByLabelText('Qty'), { target: { value: '' } });
    expect(plain(within(rowCard(3)).getByTestId('keep-line'))).toBe("Every 'N/A' in Qty will be read as empty. It covers all 2 rows in this list that have it. This changes the source for 2 formats.");
  });

  it('the other formats get the rule: the one still to run reads the source as saved (its rules are read again), and the user is told how many it reached', async () => {
    const { engine, calls } = realEngine();
    const { api, saves } = apiWithServer({ formats: TWO });
    renderConvert(<ConvertPage />, { api, engine });
    await drop();
    fireEvent.click(await screen.findByRole('button', { name: 'Continue' }));
    await screen.findByText(REVIEW);
    expect(screen.getByTestId('review-step').textContent).toBe('Format 1 of 2: ⁨Load file⁩');
    fix(3, 'Qty', '', { every: true });
    fireEvent.click(screen.getByRole('button', { name: 'Create the file' }));

    // Format 2: the Qty rows are no longer flagged - its own rules came from the server again, with the source's change in them.
    await waitFor(() => expect(screen.getByTestId('review-step').textContent).toBe('Format 2 of 2: ⁨Ledger⁩'));
    expect(screen.getByTestId('review-count').textContent).toBe('1 row is flagged.');
    expect(rowCard(5)).toBeTruthy();
    expect(rowCard(3)).toBeNull();
    const reviews = calls.filter((c) => c.mode === 'review');
    expect(reviews[0]!.rules.input.columns[1]!.readAs).toBeUndefined();
    expect(reviews[1]!.rules.input.columns[1]!.readAs).toEqual({ 'N/A': '' });
    // One save, on the conversion under review.
    expect(saves.map((s) => s.id)).toEqual(['c1']);

    fireEvent.click(within(rowCard(5)).getByRole('button', { name: 'Keep as is' }));
    fireEvent.click(screen.getByRole('button', { name: 'Create the file' }));
    expect(await screen.findByTestId('run-results')).toBeTruthy();
    expect(plain(screen.getByTestId('kept-rules'))).toContain('Saved as version 2 of Load file.');
    expect(plain(screen.getByTestId('kept-rules'))).toContain('The source changed, and the change reached 1 other format it feeds.');
  });
});

describe('Hebrew', () => {
  it('the offer, the line, the note and the failure are in Hebrew, in the register of the screen', async () => {
    const { engine } = realEngine();
    const { api } = apiWithServer({ formats: [{ id: 'c1', formatId: 'F1', formatName: 'קובץ טעינה' }, { id: 'c2', formatId: 'F2', formatName: 'ספר' }] });
    renderConvert(<ConvertPage />, { api, engine, lang: 'he' });
    const input = await screen.findByLabelText('קבצים להמרה');
    await act(async () => {
      fireEvent.change(input, { target: { files: [csvFile('jan.csv', CSV)] } });
    });
    fireEvent.click(await screen.findByRole('button', { name: 'המשך' }));
    await screen.findByText('כמה שורות דורשות מבט לפני שהקובץ נוצר');
    fireEvent.click(within(rowCard(3)).getByRole('button', { name: 'לתקן רק את השורה הזו' }));
    fireEvent.change(within(rowCard(3)).getByLabelText('Qty'), { target: { value: '' } });
    const offer = within(rowCard(3)).getByTestId('keep-offer');
    expect(within(offer).getByRole('checkbox', { name: /לעשות את זה בכל פעם\?/ })).toBeTruthy();
    expect(plain(within(offer).getByTestId('keep-line'))).toBe("כל 'N/A' בעמודה Qty ייקרא כריק. זה חל על כל 2 השורות ברשימה הזו שיש בהן את הטקסט הזה. השינוי הזה משנה את המקור עבור 2 פורמטים.");
    fireEvent.click(within(offer).getByRole('checkbox'));
    fireEvent.click(within(rowCard(3)).getByRole('button', { name: 'להשתמש בערך הזה' }));
    expect(rowCard(3).textContent).toContain('תתוקן, ותישמר ככלל כשתיצרו את הקובץ');
    fireEvent.click(screen.getByRole('button', { name: 'ליצור את הקובץ' }));
    await waitFor(() => expect(screen.getByTestId('review-step').textContent).toContain('2'));
    fireEvent.click(within(rowCard(5)).getByRole('button', { name: 'להשאיר כמו שהיא' }));
    fireEvent.click(screen.getByRole('button', { name: 'ליצור את הקובץ' }));
    await screen.findByTestId('run-results');
    const note = plain(screen.getByTestId('kept-rules'));
    expect(note).toContain('נשמר ככלל');
    expect(note).toContain("כל 'N/A' בעמודה Qty נקרא מעכשיו כריק.");
    expect(note).toContain('נשמר כגרסה 2 של קובץ טעינה. כדי לבטל, שחזרו את הגרסה הקודמת בעורך.');
    expect(note).toContain('המקור השתנה, והשינוי הגיע לפורמט אחד נוסף שהוא מזין.');
  });

  it('a save that failed says so in Hebrew', async () => {
    const { engine } = realEngine();
    const { api } = apiWithServer();
    api.saveRules.mockRejectedValue(new Error('network'));
    renderConvert(<ConvertPage />, { api, engine, lang: 'he' });
    const input = await screen.findByLabelText('קבצים להמרה');
    await act(async () => {
      fireEvent.change(input, { target: { files: [csvFile('jan.csv', CSV)] } });
    });
    await screen.findByText('כמה שורות דורשות מבט לפני שהקובץ נוצר');
    fireEvent.click(within(rowCard(3)).getByRole('button', { name: 'לתקן רק את השורה הזו' }));
    fireEvent.change(within(rowCard(3)).getByLabelText('Qty'), { target: { value: '' } });
    fireEvent.click(within(rowCard(3)).getByRole('checkbox', { name: /לעשות את זה בכל פעם/ }));
    fireEvent.click(within(rowCard(3)).getByRole('button', { name: 'להשתמש בערך הזה' }));
    fireEvent.click(screen.getByRole('button', { name: 'ליצור את הקובץ' }));
    await screen.findByTestId('kept-rules');
    const note = plain(screen.getByTestId('kept-rules'));
    expect(note).toContain('לא נשמר ככלל');
    expect(note).toContain('לא הצלחנו לשמור את זה ככלל, אבל התיקון שלכם שימש בקובץ הזה. בפעם הבאה הערך יסומן שוב.');
  });
});


// What a saved format may keep (docs/proposals/saved-format-contents.md section 5): a "Do this every time?" fix is a value the format would save.
// One that holds an identifier-shaped value is asked about in the same Save popup before anything is saved; any other saves at the one click.
describe('a fix that keeps an identifier-shaped value', () => {
  const ID = '039337423';
  const dialog = (): HTMLElement | null => screen.queryByRole('dialog');

  it('asks first, in the Save popup: the column and the kind, never the value - "Keep it" saves it as a rule', async () => {
    const { engine } = realEngine();
    const { api, saves } = apiWithServer();
    renderConvert(<ConvertPage />, { api, engine });
    await drop();
    await screen.findByText(REVIEW);
    fix(3, 'Qty', ID, { every: true });
    fireEvent.click(screen.getByRole('button', { name: 'Create the file' }));
    const box = await screen.findByRole('dialog', { name: 'Save this format?' });
    expect(plain(within(box).getByTestId('copied-list-dialog'))).toBe('Qty keeps an ID number in its fixes. Keep it in the saved format?');
    expect(within(box).getAllByRole('button').map((b) => b.getAttribute('aria-label') ?? b.textContent)).toEqual(['Close', 'Keep it', 'Save without it', 'Cancel']);
    expect(box.textContent).not.toContain(ID);
    // Nothing is saved or made yet.
    expect(api.saveRules).not.toHaveBeenCalled();
    fireEvent.click(within(box).getByRole('button', { name: 'Keep it' }));
    expect(await screen.findByText('Your file is ready')).toBeTruthy();
    expect(saves).toHaveLength(1);
    expect((saves[0]!.body.rules as Rules).input.columns[1]!.readAs).toEqual({ 'N/A': ID });
  });

  it('"Save without it": that fix is not saved - it still fixes this file, as a one-off', async () => {
    const { engine, calls } = realEngine();
    const { api } = apiWithServer();
    renderConvert(<ConvertPage />, { api, engine });
    await drop();
    await screen.findByText(REVIEW);
    fix(3, 'Qty', ID, { every: true });
    fireEvent.click(screen.getByRole('button', { name: 'Create the file' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Save without it' }));
    expect(await screen.findByText('Your file is ready')).toBeTruthy();
    expect(api.saveRules).not.toHaveBeenCalled();
    const write = calls.find((c) => c.mode === 'write')!;
    expect(write.rules.input.columns[1]!.readAs).toBeUndefined();
    expect(write.rowDecisions).toEqual({ 3: { action: 'override', values: { c_qty: ID } } });
    expect(screen.queryByTestId('kept-rules')).toBeNull();
  });

  it('"Cancel": nothing is saved and nothing is made - the review is still there', async () => {
    const { engine, calls } = realEngine();
    const { api } = apiWithServer();
    renderConvert(<ConvertPage />, { api, engine });
    await drop();
    await screen.findByText(REVIEW);
    fix(3, 'Qty', ID, { every: true });
    fireEvent.click(screen.getByRole('button', { name: 'Create the file' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(dialog()).toBeNull());
    expect(screen.getByText(REVIEW)).toBeTruthy();
    expect(api.saveRules).not.toHaveBeenCalled();
    expect(calls.some((c) => c.mode === 'write')).toBe(false);
  });

  it('two fixes, an ID and a plain one: one line for the ID; "Save without it" saves the plain one alone', async () => {
    const { engine } = realEngine();
    const { api, saves } = apiWithServer();
    renderConvert(<ConvertPage />, { api, engine });
    await drop();
    await screen.findByText(REVIEW);
    fix(3, 'Qty', ID, { every: true });
    fix(5, 'Price', '', { every: true });
    fireEvent.click(screen.getByRole('button', { name: 'Create the file' }));
    const box = await screen.findByRole('dialog');
    expect(plain(within(box).getByTestId('copied-list-dialog'))).toBe('Qty keeps an ID number in its fixes. Keep it in the saved format?');
    fireEvent.click(within(box).getByRole('button', { name: 'Save without it' }));
    await screen.findByText('Your file is ready');
    expect(saves).toHaveLength(1);
    expect((saves[0]!.body.rules as Rules).input.columns.map((c) => c.readAs)).toEqual([undefined, undefined, { 'N/A': '' }]);
    expect(api.saveRules).toHaveBeenCalledTimes(1);
  });

  it('a fix with no identifier shape saves at the one click: no popup', async () => {
    const { engine } = realEngine();
    const { api, saves } = apiWithServer();
    renderConvert(<ConvertPage />, { api, engine });
    await drop();
    await screen.findByText(REVIEW);
    fix(3, 'Qty', '61000100', { every: true });
    fireEvent.click(screen.getByRole('button', { name: 'Create the file' }));
    expect(await screen.findByText('Your file is ready')).toBeTruthy();
    expect(dialog()).toBeNull();
    expect((saves[0]!.body.rules as Rules).input.columns[1]!.readAs).toEqual({ 'N/A': '61000100' });
  });

  it('in Hebrew: the line, the question and the answers', async () => {
    const { engine } = realEngine();
    const { api, saves } = apiWithServer();
    renderConvert(<ConvertPage />, { api, engine, lang: 'he' });
    const input = await screen.findByLabelText('קבצים להמרה');
    await act(async () => {
      fireEvent.change(input, { target: { files: [csvFile('jan.csv', CSV)] } });
    });
    await screen.findByText('כמה שורות דורשות מבט לפני שהקובץ נוצר');
    fireEvent.click(within(rowCard(3)).getByRole('button', { name: 'לתקן רק את השורה הזו' }));
    fireEvent.change(within(rowCard(3)).getByLabelText('Qty'), { target: { value: '050-1234567' } });
    fireEvent.click(within(within(rowCard(3)).getByTestId('keep-offer')).getByRole('checkbox'));
    fireEvent.click(within(rowCard(3)).getByRole('button', { name: 'להשתמש בערך הזה' }));
    fireEvent.click(screen.getByRole('button', { name: 'ליצור את הקובץ' }));
    const box = await screen.findByRole('dialog', { name: 'לשמור את הפורמט?' });
    expect(plain(within(box).getByTestId('copied-list-dialog'))).toBe('התיקונים של העמודה Qty שומרים מספר טלפון. להשאיר את הערך הזה בפורמט השמור?');
    expect(within(box).getAllByRole('button').map((b) => b.getAttribute('aria-label') ?? b.textContent)).toEqual(['סגירה', 'להשאיר אותו', 'לשמור בלעדיו', 'ביטול']);
    fireEvent.click(within(box).getByRole('button', { name: 'לשמור בלעדיו' }));
    await waitFor(() => expect(dialog()).toBeNull());
    expect(await screen.findByText('הקובץ שלכם מוכן')).toBeTruthy();
    expect(saves).toHaveLength(0);
  });
});
