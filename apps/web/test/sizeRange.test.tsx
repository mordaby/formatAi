// "Same name, different size" on the Run screen (SPEC 5 C, 5 D, 8.15, owner decision 2026-10-08), end to end through the real worker methods: a format
// that kept a size range for a number column it uses is put under "Needs attention" - unchecked, with the usual buttons - when the dropped file's
// numbers are far from it, whatever else is true of the file; a fitting format stays pre-checked. "Run anyway" widens the saved range, but only once
// that format's file is actually written. A batch treats it like the other reasons. Old rules (no range) cost nothing and change nothing.
import { readZip } from '@formatai/engine';
import type { Rules, SizeRange } from '@formatai/shared';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ConvertPage from '../src/pages/Convert';
import { convertSession } from '../src/pages/Convert/session';
import { createEngineClient } from '../src/worker/engineClient';
import { engineMethods } from '../src/worker/engineMethods';
import { loopbackWorker } from './helpers/loopback';
import { csvFile, fakeConvertApi, PAID, renderConvert, RULES, sourceEntry } from './helpers/convertKit';

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

const HEAD = 'Item Code,Qty,Price,Extra\n';
/** Quantities in the single digits (decade 0). */
const SMALL = `${HEAD}00001,5,10.5,x\n00002,6,3,y\n00003,7,4,z\n`;
/** Quantities in the thousands (decade 3). */
const BIG = `${HEAD}00001,1200,10.5,x\n00002,3400,3,y\n00003,5600,4,z\n`;
/** Small again, but one code is too short: the review of flagged rows comes before the file is written. */
const SMALL_FLAGGED = `${HEAD}00001,5,10.5,x\n00002,6,3,y\n123,7,4,z\n00004,8,4,w\n`;

/** The load file's rules with a size range on Qty (or none: the way everything stored before this was). */
const rulesWith = (name: string, range?: SizeRange): Rules => ({
  ...RULES,
  name,
  input: { ...RULES.input, columns: RULES.input.columns.map((c) => (c.id === 'c_qty' && range ? { ...c, range } : c)) },
});

const ONE = sourceEntry({ sourceId: 's1', name: 'Supplier A', conversions: [{ conversionId: 'c1', formatId: 'F1', formatName: 'Load file' }] });
/** One source, two formats: "Load file" was learned on thousands to tens of thousands, "ERP load" on single digits to tens. */
const TWO = sourceEntry({
  sourceId: 's1',
  name: 'Supplier A',
  conversions: [
    { conversionId: 'c1', formatId: 'F1', formatName: 'Load file' },
    { conversionId: 'c2', formatId: 'F2', formatName: 'ERP load' },
  ],
});
const twoRules = { c1: rulesWith('rules-c1', { lo: 3, hi: 4 }), c2: rulesWith('rules-c2', { lo: 0, hi: 1 }) };

const SENTENCE = "'Qty' in this file is mostly in the single digits; this format was learned on thousands to tens of thousands.";
const plain = (el: Element | null | undefined): string => (el?.textContent ?? '').replace(/[⁦-⁩]/g, '');
const box = (name: string): HTMLInputElement => screen.getByRole('checkbox', { name }) as HTMLInputElement;
const attentionRows = () => within(screen.getByTestId('needs-attention')).getAllByTestId('attention-format');
const buttonNames = (row: HTMLElement) => within(row).queryAllByRole('button').map((b) => plain(b));

/** The real engine, in this thread (every worker method is the real one); `sizeGaps` is spied on. */
function realEngine() {
  const engine = createEngineClient({ createWorker: () => loopbackWorker(engineMethods) });
  const sizeGaps = vi.spyOn(engine, 'sizeGaps');
  const convertWithDecisions = vi.spyOn(engine, 'convertWithDecisions');
  return { engine, sizeGaps, convertWithDecisions };
}

async function drop(name: string, body: string, label = 'Files to convert') {
  const input = await screen.findByLabelText(label);
  await act(async () => {
    fireEvent.change(input, { target: { files: [csvFile(name, body)] } });
  });
}

describe('the Run screen', () => {
  it('puts a format whose numbers are far from what it was learned on under "Needs attention", unchecked, and keeps the fitting one pre-checked', async () => {
    const api = fakeConvertApi({ entries: [TWO], rulesById: twoRules });
    const { engine, sizeGaps, convertWithDecisions } = realEngine();
    renderConvert(<ConvertPage />, { api, engine });
    await drop('jan.csv', SMALL);

    expect(await screen.findByText('Some formats need a look first')).toBeTruthy();
    expect(box('ERP load').checked).toBe(true); // learned on single digits to tens: this file fits
    expect(screen.queryByRole('checkbox', { name: 'Load file' })).toBeNull(); // not a choice that is pre-checked, nor a checkbox at all
    const [row] = attentionRows();
    expect(plain(within(row!).getAllByTestId('attention-text')[0])).toBe(SENTENCE);
    expect(buttonNames(row!)).toEqual(['Open in editor', 'Run anyway', 'Skip this time']);
    // It only LOOKS different: the text never says which size is right.
    expect(plain(row)).not.toMatch(/wrong|correct|error|mistake/i);
    // The check read the file once for both formats, and nothing has been run yet.
    expect(sizeGaps).toHaveBeenCalledTimes(1);
    expect(sizeGaps.mock.calls[0]![0].rules).toHaveLength(2);
    expect(convertWithDecisions).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByTestId('run-results')).toBeTruthy();
    // Only the fitting format was made; the other waits on the results with its reason.
    expect(api.recordRun.mock.calls.map((c) => c[0])).toEqual(['c2']);
    expect(plain(attentionRows()[0])).toContain(SENTENCE);
    expect(api.widenRanges).not.toHaveBeenCalled();
  }, 30000);

  it('a file in the thousands is the other way round: "ERP load" (single digits to tens) is the one that needs attention', async () => {
    const api = fakeConvertApi({ entries: [TWO], rulesById: twoRules });
    const { engine } = realEngine();
    renderConvert(<ConvertPage />, { api, engine });
    await drop('jan.csv', BIG);
    expect(await screen.findByText('Some formats need a look first')).toBeTruthy();
    expect(box('Load file').checked).toBe(true);
    expect(plain(attentionRows()[0])).toContain("'Qty' in this file is mostly in the thousands; this format was learned on single digits to tens.");
  }, 30000);

  it('the single-format case that runs at once today shows the attention screen instead, and nothing is made until the user decides', async () => {
    const api = fakeConvertApi({ entries: [ONE], rulesById: { c1: rulesWith('rules-c1', { lo: 3, hi: 4 }) } });
    const { engine, convertWithDecisions } = realEngine();
    renderConvert(<ConvertPage />, { api, engine });
    await drop('jan.csv', SMALL);

    expect(await screen.findByText('This file needs a look first')).toBeTruthy();
    expect(plain(attentionRows()[0])).toContain(SENTENCE);
    expect(buttonNames(attentionRows()[0]!)).toEqual(['Open in editor', 'Run anyway', 'Skip this time']);
    expect(screen.getByRole('button', { name: 'Continue' }).hasAttribute('disabled')).toBe(true);
    expect(convertWithDecisions).not.toHaveBeenCalled();
    expect(api.recordRun).not.toHaveBeenCalled();
    expect(api.widenRanges).not.toHaveBeenCalled();
  }, 30000);

  it('"Run anyway" makes the format, and once its file is written the saved range widens to include this file\'s - two integers, no value', async () => {
    const api = fakeConvertApi({ entries: [ONE], rulesById: { c1: rulesWith('rules-c1', { lo: 3, hi: 4 }) } });
    const { engine } = realEngine();
    renderConvert(<ConvertPage />, { api, engine });
    await drop('jan.csv', SMALL);
    await screen.findByText('This file needs a look first');
    fireEvent.click(within(attentionRows()[0]!).getByRole('button', { name: 'Run anyway' }));
    expect(plain(attentionRows()[0])).toContain('Will be made as it is');
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    expect(await screen.findByText('Your file is ready')).toBeTruthy();
    await waitFor(() => expect(api.widenRanges).toHaveBeenCalledTimes(1));
    // Qty 5, 6, 7: the 10th and 90th percentile are 5 and 7, both single digits.
    expect(api.widenRanges).toHaveBeenCalledWith('c1', { c_qty: { lo: 0, hi: 0 } });
  }, 30000);

  it('the range widens only after the file is WRITTEN: through the review of flagged rows it waits for "Create the file"', async () => {
    const api = fakeConvertApi({ entries: [ONE], rulesById: { c1: rulesWith('rules-c1', { lo: 3, hi: 4 }) } });
    const { engine } = realEngine();
    renderConvert(<ConvertPage />, { api, engine });
    await drop('jan.csv', SMALL_FLAGGED);
    await screen.findByText('This file needs a look first');
    fireEvent.click(within(attentionRows()[0]!).getByRole('button', { name: 'Run anyway' }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    expect(await screen.findByText('Some rows need a look before the file is made')).toBeTruthy();
    expect(api.widenRanges).not.toHaveBeenCalled();
    fireEvent.click(within(document.querySelector('[data-testid="review-row"][data-row="4"]') as HTMLElement).getByRole('button', { name: 'Keep as is' }));
    fireEvent.click(screen.getByRole('button', { name: 'Create the file' }));
    expect(await screen.findByText('Your file is ready')).toBeTruthy();
    await waitFor(() => expect(api.widenRanges).toHaveBeenCalledWith('c1', { c_qty: { lo: 0, hi: 0 } })); // 5, 6, 7, 8: all single digits
  }, 30000);

  it('never widens on another path: skipping the format, or making only the formats that fit', async () => {
    const api = fakeConvertApi({ entries: [TWO], rulesById: twoRules });
    const { engine } = realEngine();
    renderConvert(<ConvertPage />, { api, engine });
    await drop('jan.csv', SMALL);
    await screen.findByText('Some formats need a look first');
    fireEvent.click(within(attentionRows()[0]!).getByRole('button', { name: 'Skip this time' }));
    expect(plain(attentionRows()[0])).toContain('Skipped this time');
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await screen.findByTestId('run-results');
    expect(api.recordRun.mock.calls.map((c) => c[0])).toEqual(['c2']);
    expect(api.widenRanges).not.toHaveBeenCalled();
  }, 30000);

  it('"Run anyway" on the results screen for a format that was left makes it and widens its range too', async () => {
    const api = fakeConvertApi({ entries: [TWO], rulesById: twoRules });
    const { engine } = realEngine();
    renderConvert(<ConvertPage />, { api, engine });
    await drop('jan.csv', SMALL);
    fireEvent.click(await screen.findByRole('button', { name: 'Continue' }));
    await screen.findByTestId('run-results');
    expect(api.widenRanges).not.toHaveBeenCalled();
    fireEvent.click(within(attentionRows()[0]!).getByRole('button', { name: 'Run anyway' }));
    expect(await screen.findByText('Your 2 files are ready')).toBeTruthy();
    await waitFor(() => expect(api.widenRanges).toHaveBeenCalledWith('c1', { c_qty: { lo: 0, hi: 0 } }));
    expect(api.widenRanges).toHaveBeenCalledTimes(1);
  }, 30000);

  it('a widening that cannot be saved does not stop the file', async () => {
    const api = fakeConvertApi({ entries: [ONE], rulesById: { c1: rulesWith('rules-c1', { lo: 3, hi: 4 }) } });
    api.widenRanges.mockRejectedValue(new Error('offline'));
    const { engine } = realEngine();
    renderConvert(<ConvertPage />, { api, engine });
    await drop('jan.csv', SMALL);
    await screen.findByText('This file needs a look first');
    fireEvent.click(within(attentionRows()[0]!).getByRole('button', { name: 'Run anyway' }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByText('Your file is ready')).toBeTruthy();
    await waitFor(() => expect(api.widenRanges).toHaveBeenCalled());
  }, 30000);

  it('old rules without a range: the file is not read for it, nothing is asked, the format runs at once as before', async () => {
    const api = fakeConvertApi({ entries: [TWO], rulesById: { c1: rulesWith('rules-c1'), c2: rulesWith('rules-c2') } });
    const { engine, sizeGaps } = realEngine();
    renderConvert(<ConvertPage />, { api, engine });
    await drop('jan.csv', SMALL);
    expect(await screen.findByText('This file feeds 2 formats')).toBeTruthy();
    expect(box('Load file').checked).toBe(true);
    expect(box('ERP load').checked).toBe(true);
    expect(screen.queryByTestId('needs-attention')).toBeNull();
    expect(sizeGaps).not.toHaveBeenCalled();
  }, 30000);

  it('a file whose numbers fit (here 300 and 500,000 against thousands to tens of thousands) is not asked about', async () => {
    const api = fakeConvertApi({ entries: [ONE], rulesById: { c1: rulesWith('rules-c1', { lo: 3, hi: 4 }) } });
    const { engine, sizeGaps } = realEngine();
    renderConvert(<ConvertPage />, { api, engine });
    await drop('jan.csv', `${HEAD}00001,300,10.5,x\n00002,300,3,y\n00003,300,4,z\n`);
    expect(await screen.findByText('Your file is ready')).toBeTruthy();
    expect(sizeGaps).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('needs-attention')).toBeNull();
    cleanup();

    const again = fakeConvertApi({ entries: [ONE], rulesById: { c1: rulesWith('rules-c1', { lo: 3, hi: 4 }) } });
    const second = realEngine();
    renderConvert(<ConvertPage />, { api: again, engine: second.engine });
    await drop('feb.csv', `${HEAD}00001,500000,10.5,x\n00002,500000,3,y\n00003,500000,4,z\n`);
    expect(await screen.findByText('Your file is ready')).toBeTruthy();
    expect(again.widenRanges).not.toHaveBeenCalled();
  }, 30000);

  it('a size check that cannot run claims nothing: the format is made as it always was', async () => {
    const api = fakeConvertApi({ entries: [ONE], rulesById: { c1: rulesWith('rules-c1', { lo: 3, hi: 4 }) } });
    const { engine, sizeGaps } = realEngine();
    sizeGaps.mockRejectedValue(new Error('worker went away'));
    renderConvert(<ConvertPage />, { api, engine });
    await drop('jan.csv', SMALL);
    expect(await screen.findByText('Your file is ready')).toBeTruthy();
  }, 30000);

  it('says it in Hebrew, with the sizes in words and the column name isolated', async () => {
    const api = fakeConvertApi({ entries: [ONE], rulesById: { c1: rulesWith('rules-c1', { lo: 3, hi: 4 }) } });
    const { engine } = realEngine();
    renderConvert(<ConvertPage />, { api, engine, lang: 'he' });
    await drop('ינואר.csv', SMALL, 'קבצים להמרה');
    expect(await screen.findByText('הקובץ הזה דורש מבט קודם')).toBeTruthy();
    expect(plain(attentionRows()[0])).toContain("בעמודה 'Qty' בקובץ הזה הערכים הם בעיקר בספרות בודדות; הפורמט הזה נלמד על אלפים עד עשרות אלפים.");
    expect(buttonNames(attentionRows()[0]!)).toEqual(['פתיחה בעורך', 'להריץ בכל זאת', 'לדלג הפעם']);
  }, 30000);
});

describe('a batch', () => {
  const rulesById = twoRules;

  it('does not convert a file into a format whose size it is far from: that item is "Needs attention" with the same reason, the others are made, and nothing is widened', async () => {
    const api = fakeConvertApi({ user: PAID, entries: [TWO], rulesById });
    const { engine } = realEngine();
    renderConvert(<ConvertPage />, { api, engine });
    const input = (await screen.findByLabelText('Files to convert')) as HTMLInputElement;
    await act(async () => {
      fireEvent.change(input, { target: { files: [csvFile('small.csv', SMALL), csvFile('big.csv', BIG)] } });
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Convert 2 files' }));
    await screen.findByRole('button', { name: 'Download all (zip)' }, { timeout: 20000 });

    // small.csv -> "ERP load" only; big.csv -> "Load file" only. Each file's other format needs attention and is withheld.
    expect(screen.getByTestId('batch-counts').textContent).toBe('2 converted · 0 with flags · 0 did not match · 2 need attention');
    const attention = screen.getAllByTestId('batch-file').filter((r) => r.getAttribute('data-status') === 'needsAttention');
    expect(attention.map((r) => plain(r))).toEqual([
      expect.stringContaining(SENTENCE),
      expect.stringContaining("'Qty' in this file is mostly in the thousands; this format was learned on single digits to tens."),
    ]);
    expect(api.recordRun.mock.calls.map((c) => c[0]).sort()).toEqual(['c1', 'c2']);
    expect(api.widenRanges).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Download all (zip)' }));
    const zip = await readZip(downloaded.mock.calls.at(-1)![1] as ArrayBuffer);
    expect(zip.map((e) => e.path).sort()).toEqual(['ERP load/small (converted).csv', 'Load file/big (converted).csv', 'formatAI batch summary.xlsx']);
  }, 60000);
});
