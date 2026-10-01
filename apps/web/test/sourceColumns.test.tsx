// Columns of the example input that no rule uses yet (SPEC 8.11): every "source column" dropdown of the rules editor offers them, and
// choosing one declares it in the same undoable edit. A saved source has no example files, so its dropdowns offer "Another column from
// your input file..." (type its header). "Add a column" is on the map in every result state, and a result whose only open columns need
// your input says so instead of "N differences". A fake worker and API.
import type { LearnResult, Rules } from '@formatai/shared';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryPendingStore, setPendingStore } from '../src/app/pendingLearn';
import type { ExampleInputColumn } from '../src/editor';
import { ordersRules } from '../src/editor/testkit';
import type { LiveCheckResult } from '../src/worker/editorApi';
import type { LearnOutput } from '../src/worker/engineApi';
import { conversionDetail, conversionSummary, createFormatResponse, formatSummary, getFormatResponse } from './helpers/registryKit';
import { csv, fakeApi, fakeEngine, learnResult, liveResult, renderApp, USER } from './helpers/renderApp';

const { downloaded } = vi.hoisted(() => ({ downloaded: vi.fn() }));
vi.mock('../src/flow/download', async (orig) => ({ ...(await orig<typeof import('../src/flow/download')>()), downloadBytes: downloaded }));

beforeEach(() => {
  document.cookie = 'lang=; Path=/; Max-Age=0';
  setPendingStore(createMemoryPendingStore());
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  setPendingStore(undefined);
});

/** The orders example's input also has an ID number (Hebrew header) and a customer name that no learned rule uses. */
const EXAMPLE_INPUT: ExampleInputColumn[] = [
  { header: 'Item', type: 'idLike' },
  { header: 'Supplier', type: 'text' },
  { header: 'ת.ז.', type: 'idLike', israeliId: true, leadingZerosLost: true, maxLength: 9 },
  { header: 'Customer name', type: 'text' },
  { header: 'Ship date', type: 'date', serialDates: true, dateFormat: 'excel' },
];

const line = (id: string): HTMLElement => {
  const el = document.querySelector(`[data-line-id="${id}"]`);
  if (!el) throw new Error(`no line ${id}: ${[...document.querySelectorAll('[data-line-id]')].map((e) => e.getAttribute('data-line-id')).join(', ')}`);
  return el as HTMLElement;
};
const openLine = (id: string): void => {
  fireEvent.click(within(line(id)).getAllByRole('button').find((b) => b.classList.contains('map-line__main'))!);
};
const optionLabels = (select: HTMLElement): string[] => within(select).getAllByRole('option').map((o) => o.textContent ?? '');
const chooseHow = (name: string): void => void fireEvent.click(screen.getByRole('radio', { name }));

type LiveFn = (id: string, rules: LearnResult | Rules, options?: { onlyColumns?: number[] }) => Promise<LiveCheckResult>;

interface Opened {
  liveCheck: ReturnType<typeof vi.fn<LiveFn>>;
  /** The rules the newest live check ran on. */
  lastRules(): Rules;
  createFormat: ReturnType<typeof vi.fn>;
}

/** Learns the orders example (the worker is faked) and waits for the rules map. */
async function openResult(result: Record<string, unknown> = {}, opts: { live?: LiveFn; signedIn?: boolean; exampleInput?: ExampleInputColumn[] | undefined } = {}): Promise<Opened> {
  const liveCheck = vi.fn<LiveFn>(opts.live ?? (async () => liveResult({ matched: 30, total: 30 })));
  const createFormat = vi.fn(async () => createFormatResponse({ format: formatSummary({ id: 'F1', name: 'Orders report' }), conversion: conversionSummary({ id: 'C1', formatId: 'F1' }) }));
  const api = fakeApi({ ...(opts.signedIn ? { user: USER } : {}), registry: { createFormat } });
  const { engine } = fakeEngine(
    async () => learnResult({ rules: ordersRules(), exampleInput: 'exampleInput' in opts ? opts.exampleInput : EXAMPLE_INPUT, ...result }) as LearnOutput,
    undefined,
    { liveCheck, fullCheck: liveCheck, convert: vi.fn(async () => ({ ok: true, bytes: new ArrayBuffer(8), flags: [], summary: {}, preview: { name: 'Out', direction: 'ltr', language: 'en', columns: [], rows: [], merges: [] }, totalRows: 3 })) },
  );
  renderApp({ engine, api });
  fireEvent.change(screen.getByLabelText('Example input'), { target: { files: [csv('orders.csv')] } });
  fireEvent.change(screen.getByLabelText('Example output'), { target: { files: [csv('Orders report.csv')] } });
  await waitFor(() => expect(screen.getAllByText(/1,204/)).toHaveLength(2));
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /Learn the format/ }));
  });
  await screen.findByTestId('rules-map');
  await waitFor(() => expect(liveCheck).toHaveBeenCalled());
  return { liveCheck, createFormat, lastRules: () => liveCheck.mock.calls.at(-1)![1] as Rules };
}

const inputColumn = (rules: Rules, header: string) => rules.input.columns.find((c) => c.header === header);

describe('a column of the example input that no rule uses yet', () => {
  it('is offered by the column editor; choosing it declares it, and Join text with a name works', async () => {
    const { lastRules, liveCheck } = await openResult();
    expect(inputColumn(lastRules(), 'ת.ז.')).toBeUndefined();

    openLine('col:Remarks');
    chooseHow('Join text');
    const second = (await screen.findAllByRole('combobox', { name: /^Column 2$/ }))[0]!;
    // Every declared column, then the ones only the example has - labelled by their header, exactly as in the file.
    expect(optionLabels(second)).toEqual(expect.arrayContaining(['Item', 'Supplier', 'Qty', 'ת.ז.', 'Customer name', 'Ship date']));
    expect(optionLabels(second).filter((l) => l === 'Item')).toHaveLength(1);

    const calls = liveCheck.mock.calls.length;
    fireEvent.change(second, { target: { value: 'c3' } });
    await waitFor(() => expect(inputColumn(lastRules(), 'ת.ז.')).toBeDefined());
    expect(inputColumn(lastRules(), 'ת.ז.')).toEqual({ id: 'c3', header: 'ת.ז.', type: 'idLike', padLeft: 9 });
    const rules = lastRules();
    const made = rules.transform.computed.find((c) => c.id === rules.output.columns.find((c2) => c2.header === 'Remarks')!.from)!;
    expect(made.expr).toEqual({ op: 'concat', args: [{ col: 'sku' }, { const: ' ' }, { col: 'c3' }] });
    expect(liveCheck.mock.calls.length).toBeGreaterThan(calls);

    // The counter still speaks for the whole thing, and now the column is a normal one in every dropdown.
    openLine('col:Item');
    const source = screen.getByRole('combobox', { name: 'Column' });
    expect(optionLabels(source)).toContain('ת.ז.');

    // One undo takes back the choice AND the declaration (the join is back to the two columns it started with).
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(inputColumn(lastRules(), 'ת.ז.')).toBeUndefined());
    const back = lastRules();
    const backId = back.output.columns.find((c) => c.header === 'Remarks')!.from;
    expect(back.transform.computed.find((c) => c.id === backId)!.expr).toEqual({ op: 'concat', args: [{ col: 'sku' }, { const: ' ' }, { col: 'supplier' }] });
  });

  it('joins with a separator and fixed text before and after', async () => {
    const { lastRules } = await openResult();
    openLine('col:Remarks');
    chooseHow('Join text');
    const second = (await screen.findAllByRole('combobox', { name: /^Column 2$/ }))[0]!;
    fireEvent.change(second, { target: { value: 'c3' } });
    await waitFor(() => expect(inputColumn(lastRules(), 'ת.ז.')).toBeDefined());
    fireEvent.change(screen.getByLabelText('Put this between them'), { target: { value: ' / ' } });
    fireEvent.change(screen.getByLabelText('Fixed text before them (optional)'), { target: { value: 'ID: ' } });
    fireEvent.change(screen.getByLabelText('Fixed text after them (optional)'), { target: { value: '.' } });
    await waitFor(() => {
      const rules = lastRules();
      const id = rules.output.columns.find((c) => c.header === 'Remarks')!.from;
      expect(rules.transform.computed.find((c) => c.id === id)!.expr).toEqual({
        op: 'concat',
        args: [{ const: 'ID: ' }, { col: 'sku' }, { const: ' / ' }, { col: 'c3' }, { const: '.' }],
      });
    });
    // The editor reads it back the way it was built.
    expect((screen.getByLabelText('Fixed text before them (optional)') as HTMLInputElement).value).toBe('ID: ');
  });

  it('is offered by the filter, sort, check and calculation dropdowns too, and choosing it there declares it', async () => {
    const { lastRules } = await openResult();

    openLine('filter:0');
    const filterColumn = screen.getByRole('combobox', { name: 'Column' });
    expect(optionLabels(filterColumn)).toContain('ת.ז.');
    fireEvent.change(filterColumn, { target: { value: 'c3' } });
    await waitFor(() => expect(inputColumn(lastRules(), 'ת.ז.')).toBeDefined());
    expect(lastRules().input.rowFilters![0]).toMatchObject({ column: 'c3' });
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(inputColumn(lastRules(), 'ת.ז.')).toBeUndefined());

    openLine('sort');
    const sortBy = screen.getByRole('combobox', { name: 'Sort by (1)' });
    expect(optionLabels(sortBy)).toContain('Customer name');
    fireEvent.change(sortBy, { target: { value: 'customerName' } });
    await waitFor(() => expect(inputColumn(lastRules(), 'Customer name')).toBeDefined());
    expect(lastRules().transform.sort[0]).toMatchObject({ column: 'customerName' });

    openLine('check:0');
    expect(optionLabels(screen.getByRole('combobox', { name: 'Column' }))).toContain('ת.ז.');

    openLine('col:Total');
    const term = screen.getAllByRole('combobox', { name: /^Item \d$/ })[0]!;
    // A text column may be read as a number; the ID is offered like any other.
    expect(optionLabels(term).some((l) => l.startsWith('ת.ז.'))).toBe(true);
  });

  it('is not offered when the learn gave no example input columns and the example is known (nothing to offer, no typing)', async () => {
    await openResult({}, { exampleInput: [] });
    openLine('col:Item');
    const source = screen.getByRole('combobox', { name: 'Column' });
    expect(optionLabels(source)).not.toContain('ת.ז.');
    expect(optionLabels(source)).not.toContain('Another column from your input file…');
  });
});

describe('"Add a column"', () => {
  const PARTIAL = {
    path: 'partial',
    partial: { reason: 'aiNotAllowed', solved: ['Item', 'Supplier', 'Qty'], needsAi: ['Total', 'Shipped'], external: ['Remarks'], solvedColumns: [0, 1, 2], needsAiParts: ['sort'] },
    readiness: { ready: true },
  };
  // An AI result that reported Remarks as unsupported externalData (the AI step's own word): it "needs your input".
  const EXTERNAL_ONLY = { path: 'llm' };

  it.each([
    ['a verified result', {}, undefined],
    ['a result with differences', {}, async () => liveResult({ verified: false, matched: 25, total: 30, differences: 5 })],
    ['the local result that still needs the AI step', PARTIAL, undefined],
    ['an AI result with columns that need your input', EXTERNAL_ONLY, undefined],
  ] as const)('is on the map for %s', async (_name, result, live) => {
    await openResult(result as Record<string, unknown>, live ? { live } : {});
    expect(within(document.querySelector('[data-section="columns"]') as HTMLElement).getByRole('button', { name: 'Add a column' })).toBeTruthy();
  });

  // Heavy UI flow (real editor + live check): give it room when the whole repo's tests share the CPU.
  it('makes a new column that can use any input column, including one no rule uses yet (ID + name)', { timeout: 30_000 }, async () => {
    const { lastRules } = await openResult(PARTIAL);
    fireEvent.click(await screen.findByRole('button', { name: 'Not now' }).catch(() => document.body));
    fireEvent.click(screen.getByRole('button', { name: 'Add a column' }));
    const panel = await screen.findByRole('complementary', { name: 'New column' });
    chooseHow('Join text');
    const [first, second] = [within(panel).getByRole('combobox', { name: 'Column 1' }), within(panel).getByRole('combobox', { name: 'Column 2' })];
    fireEvent.change(first, { target: { value: 'c3' } });
    await waitFor(() => expect(inputColumn(lastRules(), 'ת.ז.')).toBeDefined());
    fireEvent.change(within(panel).getByRole('combobox', { name: 'Column 2' }), { target: { value: 'customerName' } });
    await waitFor(() => expect(inputColumn(lastRules(), 'Customer name')).toBeDefined());
    void second;
    const rules = lastRules();
    const made = rules.output.columns.find((c) => c.header === 'New column')!;
    expect(rules.transform.computed.find((c) => c.id === made.from)!.expr).toEqual({ op: 'concat', args: [{ col: 'c3' }, { const: ' ' }, { col: 'customerName' }] });
  });
});

describe('a result whose only open columns need your input', () => {
  // An AI result that reported Remarks as unsupported externalData (ordersRules has that entry): the column "needs your input".
  const EXTERNAL_ONLY = { path: 'llm' };
  /** The column nothing fills would differ on every row: comparing it is what made the old status "30 differences". */
  const live: LiveFn = async (_id, _rules, options) =>
    options?.onlyColumns ? liveResult({ verified: true, matched: 30, total: 30 }) : liveResult({ verified: false, matched: 0, total: 30, differences: 30 });

  it('compares only the columns something fills, says "1 column needs your input", and saves as confirmed - not "30 differences"', async () => {
    const { liveCheck, createFormat } = await openResult(EXTERNAL_ONLY, { live, signedIn: true });
    // Positions of every column but Remarks (the last one).
    expect(liveCheck.mock.calls.at(-1)![2]!.onlyColumns).toEqual([0, 1, 2, 3, 4]);
    expect(screen.getByTestId('status-badge').textContent).toBe('1 column needs your input');
    expect(screen.queryByText(/differences/)).toBeNull();
    const save = await screen.findByRole('button', { name: 'Save format and download' });
    expect((save as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(save);
    await waitFor(() => expect(createFormat).toHaveBeenCalledTimes(1));
    expect(createFormat.mock.calls[0]![0]).toMatchObject({ status: 'userConfirmed', acceptedDifferences: 0 });
  });

  it('once the column is filled in, everything is compared again and a real difference is a difference', async () => {
    const seen: (number[] | undefined)[] = [];
    const { lastRules } = await openResult(EXTERNAL_ONLY, {
      live: async (id, rules, options) => {
        seen.push(options?.onlyColumns);
        return live(id, rules, options);
      },
    });
    openLine('col:Remarks');
    chooseHow('Fixed value');
    fireEvent.change(await screen.findByLabelText('Value'), { target: { value: 'x' } });
    await waitFor(() => expect(lastRules().output.columns.find((c) => c.header === 'Remarks')!.from).not.toBeNull());
    await waitFor(() => expect(seen.at(-1)).toBeUndefined());
    // The live fake says every row differs when all columns are compared.
    await waitFor(() => expect(screen.getByTestId('status-badge').textContent).toBe('30 differences'));
  });
});

describe('a saved source (no example files)', () => {
  const ROUTE = '/formats/F1/sources/C1';
  const cleanRules = (): Rules => {
    const rules = ordersRules();
    rules.output.columns = rules.output.columns.filter((c) => c.header !== 'Remarks');
    rules.unsupported = [];
    return rules;
  };
  const three = getFormatResponse({ id: 'F1', name: 'Orders report', sources: [conversionSummary({ id: 'C1', sourceName: 'Supplier A' })] });

  async function openEditor(loadExample?: () => unknown) {
    const staticChecks = vi.fn(async (_rules: LearnResult | Rules, _options?: unknown) => [] as never[]);
    const { engine } = fakeEngine(undefined, undefined, { staticChecks, ...(loadExample ? { loadExample: vi.fn(loadExample) } : {}) });
    const api = fakeApi({
      user: USER,
      registry: {
        getConversion: vi.fn(async () => conversionDetail({ id: 'C1', version: 4, sourceName: 'Supplier A' }, cleanRules())),
        getFormat: vi.fn(async () => three),
        versions: vi.fn(async () => []),
      },
    });
    renderApp({ api, engine, route: ROUTE });
    await screen.findByTestId('rules-map');
    await waitFor(() => expect(staticChecks).toHaveBeenCalled());
    return { engine, staticChecks, lastRules: () => staticChecks.mock.calls.at(-1)![0] as Rules };
  }

  it('has "Add a column" on its map', async () => {
    await openEditor();
    expect(within(document.querySelector('[data-section="columns"]') as HTMLElement).getByRole('button', { name: 'Add a column' })).toBeTruthy();
  });

  it('offers "Another column from your input file..." in the source dropdown: type its header and what it holds, and it is declared', async () => {
    const { lastRules } = await openEditor();
    openLine('col:Item');
    const source = screen.getByRole('combobox', { name: 'Column' });
    expect(optionLabels(source).at(-1)).toBe('Another column from your input file…');

    fireEvent.change(source, { target: { value: '#other' } });
    const form = await screen.findByTestId('typed-source');
    // Nothing is declared until it is used.
    expect(inputColumn(lastRules(), 'ת.ז.')).toBeUndefined();
    fireEvent.change(within(form).getByLabelText('The header of the column in your input file'), { target: { value: 'ת.ז.' } });
    fireEvent.change(within(form).getByLabelText('What is in this column?'), { target: { value: 'idLike' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Use this column' }));

    await waitFor(() => expect(inputColumn(lastRules(), 'ת.ז.')).toBeDefined());
    expect(inputColumn(lastRules(), 'ת.ז.')).toEqual({ id: 'c1', header: 'ת.ז.', type: 'idLike' });
    // The column keeps its padding to 6 digits, now read from the typed-in column.
    const rules = lastRules();
    const made = rules.transform.computed.find((c) => c.id === rules.output.columns.find((c2) => c2.header === 'Item')!.from)!;
    expect(made.expr).toEqual({ op: 'padLeft', arg: { col: 'c1' }, length: 6, char: '0' });
    expect(screen.queryByTestId('typed-source')).toBeNull();
    // It is a normal column of the dropdown from now on, in every dropdown.
    openLine('sort');
    expect(optionLabels(screen.getByRole('combobox', { name: 'Sort by (1)' }))).toContain('ת.ז.');

    // Saved with the rest of the edit; one undo takes back the use and the declaration.
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(inputColumn(lastRules(), 'ת.ז.')).toBeUndefined());
  });

  it('typing a header the rules already declare uses that column, and Cancel closes the form', async () => {
    const { lastRules } = await openEditor();
    openLine('col:Qty');
    fireEvent.change(screen.getByRole('combobox', { name: 'Column' }), { target: { value: '#other' } });
    let form = await screen.findByTestId('typed-source');
    fireEvent.click(within(form).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByTestId('typed-source')).toBeNull();

    fireEvent.change(screen.getByRole('combobox', { name: 'Column' }), { target: { value: '#other' } });
    form = await screen.findByTestId('typed-source');
    fireEvent.change(within(form).getByLabelText('The header of the column in your input file'), { target: { value: ' unit price ' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Use this column' }));
    await waitFor(() => expect(lastRules().output.columns.find((c) => c.header === 'Qty')).toMatchObject({ from: 'price' }));
    expect(lastRules().input.columns).toHaveLength(cleanRules().input.columns.length);
  });

  it('once the example files are dropped, its columns are offered instead, and typing is not', async () => {
    const loadExample = () => ({ ok: true, exampleId: 'ex-loaded', exampleInput: EXAMPLE_INPUT, inputRows: 3, outputRows: 3 });
    await openEditor(loadExample);
    fireEvent.change(screen.getByLabelText('Example input'), { target: { files: [csv('orders.csv')] } });
    fireEvent.change(screen.getByLabelText('Example output'), { target: { files: [csv('Orders report.csv')] } });
    await waitFor(() => expect(screen.getAllByText(/1,204/)).toHaveLength(2));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Check against these files' }));
    });
    await waitFor(() => expect(screen.queryByTestId('example-drop')).toBeNull());
    openLine('col:Item');
    const source = screen.getByRole('combobox', { name: 'Column' });
    expect(optionLabels(source)).toContain('ת.ז.');
    expect(optionLabels(source)).not.toContain('Another column from your input file…');
  });
});
