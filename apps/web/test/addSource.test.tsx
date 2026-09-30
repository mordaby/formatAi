// Adding a source to a format (SPEC 5 A2, 8.12): the output must match the format - same headers in order, same file type - or the
// screen says which columns differ; then the learn runs in attach mode (the format is the `target`), the result opens in the
// same editor, and saving adds a conversion (a refusal by the format lock is shown with its problems). In flow A, an example
// output that matches a saved format is offered as "add it as a new source". Which source the file is (SPEC 8.15) is chosen on the form:
// detected by the server, one the company already has, or a new one. A fake API and a fake worker.
import { promptVersion } from '@formatai/shared';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/api';
import { createMemoryPendingStore, setPendingStore } from '../src/app/pendingLearn';
import { compareOutput } from '../src/pages/Result/matchFormat';
import type { LearnHost } from '../src/worker/engineApi';
import { conversionSummary, formatSummary, getFormatResponse, sourceDetail, sourceSummary } from './helpers/registryKit';
import { csv, fakeApi, fakeEngine, learnResult, RULES, renderApp, USER } from './helpers/renderApp';

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

const ROUTE = '/formats/F1/add-source';
const HEADERS = ['Item Code', 'Description', 'Unit Price', 'Category'];

const format = getFormatResponse({
  id: 'F1',
  name: 'Supplier price list',
  sources: [conversionSummary({ id: 'C1', sourceName: 'Supplier A' })],
  detail: { outputHeaders: HEADERS, outputColumns: 4, fileType: 'xlsx', output: { file: { type: 'xlsx' }, columns: HEADERS.map((header) => ({ header })), titleRows: [], summaryRows: [], sheetName: 'S', direction: 'ltr', language: 'en' } },
});

/** What the worker "reads" from each file, by name. */
const HEADERS_OF: Record<string, string[]> = {
  'supplier-b.csv': ['Code', 'Name', 'Price'],
  'load.xlsx': HEADERS,
  'load.csv': HEADERS,
  'short.xlsx': ['Item Code', 'Description', 'Unit Price'],
  'renamed.xlsx': ['Item Code', 'Product', 'Unit Price', 'Category'],
  'wide.xlsx': [...HEADERS, 'Extra'],
};

const converted = (): unknown => ({
  ok: true,
  bytes: new ArrayBuffer(8),
  flags: [],
  summary: { rowsIn: 3, rowsOut: 3, rowsFiltered: 0, duplicatesRemoved: [], duplicatesFlagged: 0, blockedRows: [] },
  preview: { name: 'Out', direction: 'ltr', language: 'en', columns: [], rows: [], merges: [] },
  totalRows: 3,
});

function setup(over: { registry?: Record<string, unknown>; learn?: Parameters<typeof fakeEngine>[0]; engine?: Record<string, unknown> } = {}) {
  const api = fakeApi({
    user: USER,
    registry: { getFormat: vi.fn(async () => format), attachSource: vi.fn(async () => ({ conversion: conversionSummary({ id: 'C2', sourceName: 'Supplier B' }), source: { id: 'S2', name: 'Supplier B' } })), ...over.registry },
    learn: vi.fn(async () => ({ rules: RULES, verified: true, problems: [], learnId: 'L1', cached: false, counted: true, failedAttempts: 0, quota: { remaining: 2, period: 'month' as const } })),
  });
  const { engine, learn } = fakeEngine(
    over.learn ??
      (async (host: LearnHost) => {
        await host.callLearn({ masking: true } as never);
        return learnResult({ path: 'llm' });
      }),
    undefined,
    {
      readHeaders: vi.fn(async ({ file }: { file: { name: string } }) => ({ ok: true, headers: HEADERS_OF[file.name] ?? [], sheetName: 'S', direction: 'ltr', rows: 3 })),
      convert: vi.fn(async () => converted()),
      ...over.engine,
    },
  );
  renderApp({ api, engine, route: ROUTE });
  return { api, engine, learn };
}

const drop = async (label: 'Example input' | 'Example output', file: File): Promise<void> => {
  fireEvent.change(await screen.findByLabelText(label), { target: { files: [file] } });
};
const xlsx = (name: string): File => new File(['x'], name, { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
const learnButton = (): HTMLButtonElement => screen.getByRole('button', { name: /Learn this source/ }) as HTMLButtonElement;
const typeName = (value: string): void => {
  fireEvent.change(screen.getByLabelText('Source name'), { target: { value } });
};

describe('compareOutput (pure)', () => {
  const format = { headers: HEADERS, fileType: 'xlsx' as const };
  it('a match has no differences', () => {
    expect(compareOutput(format, { headers: HEADERS, fileType: 'xlsx' })).toEqual([]);
    // Spaces around a header do not count.
    expect(compareOutput(format, { headers: [' Item Code', 'Description ', 'Unit Price', 'Category'], fileType: 'xlsx' })).toEqual([]);
  });
  it('names the file type, the count, and each column that differs, by number', () => {
    expect(compareOutput(format, { headers: ['Item Code', 'Product', 'Unit Price'], fileType: 'csv' })).toEqual([
      { kind: 'fileType', expected: 'xlsx', actual: 'csv' },
      { kind: 'count', expected: 4, actual: 3 },
      { kind: 'column', n: 2, expected: 'Description', actual: 'Product' },
      { kind: 'missing', n: 4, expected: 'Category' },
    ]);
    expect(compareOutput(format, { headers: [...HEADERS, 'Extra'], fileType: 'xlsx' })).toEqual([
      { kind: 'count', expected: 4, actual: 5 },
      { kind: 'extra', n: 5, actual: 'Extra' },
    ]);
  });
  it('order matters: swapped columns differ', () => {
    expect(compareOutput(format, { headers: ['Description', 'Item Code', 'Unit Price', 'Category'], fileType: 'xlsx' })).toHaveLength(2);
  });
  it('a file with no header row (SPEC 8.13) is compared by its number of columns only', () => {
    expect(compareOutput({ ...format, headerless: true }, { headers: ['1', '2', '3', '4'], fileType: 'xlsx' })).toEqual([]);
    expect(compareOutput({ ...format, headerless: true }, { headers: ['1', '2'], fileType: 'xlsx' })).toEqual([{ kind: 'count', expected: 4, actual: 2 }]);
  });
});

describe('the Add a source screen', () => {
  it('shows the format\'s columns in order, and needs both files', async () => {
    setup();
    expect(await screen.findByRole('heading', { name: 'Add a source to "Supplier price list"' })).toBeTruthy();
    const chips = within(screen.getByTestId('add-format-columns')).getAllByRole('listitem').map((li) => li.textContent);
    expect(chips).toEqual(HEADERS);
    expect(learnButton().disabled).toBe(true);
    // (the default is "detect automatically": the name is optional there)
    expect(screen.getByText('Add the input and the output to continue.')).toBeTruthy();
  });

  it('an output with other headers is refused, and says which columns differ', async () => {
    setup();
    await screen.findByTestId('add-format-columns');
    typeName('Supplier B');
    await drop('Example input', csv('supplier-b.csv'));
    await drop('Example output', xlsx('renamed.xlsx'));
    const list = await screen.findByTestId('output-mismatch');
    expect(within(list).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['Column 2: the format has "Description", this output has "Product".']);
    expect(screen.getByText("This output doesn't match the format")).toBeTruthy();
    expect(screen.getByText(/Change the output file so its columns are the format's, in the same order/)).toBeTruthy();
    expect(learnButton().disabled).toBe(true);
  });

  it('says the file type and the missing or extra columns too', async () => {
    setup();
    await screen.findByTestId('add-format-columns');
    typeName('Supplier B');
    await drop('Example input', csv('supplier-b.csv'));
    await drop('Example output', csv('load.csv'));
    const list = await screen.findByTestId('output-mismatch');
    expect(within(list).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['The format is an Excel file (.xlsx), and this output is a CSV file.']);

    await drop('Example output', xlsx('short.xlsx'));
    await waitFor(() => expect(screen.getByTestId('output-mismatch').textContent).toContain('The format has 4 columns and this output has 3.'));
    expect(screen.getByTestId('output-mismatch').textContent).toContain('Column 4: the format has "Category", this output has nothing.');

    await drop('Example output', xlsx('wide.xlsx'));
    await waitFor(() => expect(screen.getByTestId('output-mismatch').textContent).toContain('Column 5: this output has "Extra", which is not in the format.'));
  });

  it('says it in Hebrew', async () => {
    renderApp({ api: fakeApi({ user: USER, registry: { getFormat: vi.fn(async () => format) } }), route: ROUTE, lang: 'he', engine: fakeEngine(undefined, undefined, { readHeaders: vi.fn(async () => ({ ok: true, headers: ['Item Code', 'Product', 'Unit Price', 'Category'], sheetName: 'S', direction: 'ltr', rows: 3 })) }).engine });
    await screen.findByTestId('add-format-columns');
    fireEvent.change(await screen.findByLabelText('דוגמת פלט'), { target: { files: [xlsx('renamed.xlsx')] } });
    const list = await screen.findByTestId('output-mismatch');
    expect(list.textContent).toContain('עמודה 2: בפורמט יש "Description", בפלט הזה יש "Product".');
  });

  it('a name another source already has is refused in words', async () => {
    setup();
    await screen.findByTestId('add-format-columns');
    typeName('supplier a ');
    expect(screen.getByText('You already have a source with that name. Choose a different name.')).toBeTruthy();
    await drop('Example input', csv('supplier-b.csv'));
    await drop('Example output', xlsx('load.xlsx'));
    await waitFor(() => expect(screen.queryByText('Reading the output…')).toBeNull());
    expect(learnButton().disabled).toBe(true);
  });

  it('learns in attach mode: the format is the target, the AI step is allowed, and the result opens in the editor', async () => {
    const { engine, learn } = setup();
    await screen.findByTestId('add-format-columns');
    typeName('Supplier B');
    await drop('Example input', csv('supplier-b.csv'));
    await drop('Example output', xlsx('load.xlsx'));
    await waitFor(() => expect(learnButton().disabled).toBe(false));
    expect(screen.queryByTestId('output-mismatch')).toBeNull();

    await act(async () => {
      fireEvent.click(learnButton());
    });
    await screen.findByTestId('rules-map');
    const args = learn.mock.calls[0]![0] as { target: { output: { columns: { header: string }[] } }; ai: string; tier: string; masking: boolean };
    expect(args.ai).toBe('allowed');
    expect(args.tier).toBe('registered');
    expect(args.masking).toBe(true);
    expect(args.target.output.columns.map((c) => c.header)).toEqual(HEADERS);
    // The result is the new source, named by the user, under the format lock.
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Supplier B');
    expect(screen.getByText('A source of "Supplier price list". We do not keep your files.')).toBeTruthy();
    await waitFor(() => expect(engine.staticChecks).toHaveBeenCalled());
    const asked = (engine.staticChecks as ReturnType<typeof vi.fn>).mock.calls as unknown as [unknown, { format?: { output: unknown } }][];
    expect(asked.some(([, options]) => options.format?.output !== undefined)).toBe(true);
    expect(screen.getByRole('button', { name: 'Add source and download' })).toBeTruthy();
  });

  it('saving POSTs a new conversion of the format with the source\'s name, then downloads the full file', async () => {
    const { api } = setup();
    await screen.findByTestId('add-format-columns');
    typeName('Supplier B');
    await drop('Example input', csv('supplier-b.csv'));
    await drop('Example output', xlsx('load.xlsx'));
    await waitFor(() => expect(learnButton().disabled).toBe(false));
    await act(async () => {
      fireEvent.click(learnButton());
    });
    await screen.findByTestId('rules-map');
    await waitFor(() => expect((screen.getByRole('button', { name: 'Add source and download' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'Add source and download' }));

    const attachSource = api.registry.attachSource;
    await waitFor(() => expect(attachSource).toHaveBeenCalledTimes(1));
    const [formatId, body] = attachSource.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(formatId).toBe('F1');
    expect(body).toMatchObject({ sourceName: 'Supplier B', status: 'verified', acceptedDifferences: 0, exampleExceptions: [], learnPath: 'llm', masking: true, promptVersion });
    expect(body.rules).toEqual(RULES);
    await waitFor(() => expect(downloaded).toHaveBeenCalledTimes(1));
    expect(downloaded.mock.calls[0]![0]).toBe('supplier-b (converted).xlsx');
    expect(await screen.findByText('Added "Supplier B" to "Supplier price list". Your file is downloading.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Open My formats' })).toBeTruthy();
  });

  it('a source that breaks the format lock is refused with the columns that differ', async () => {
    const attachSource = vi.fn(async () =>
      Promise.reject(new ApiError('formatMismatch', 422, { problems: [{ kind: 'formatMismatch', path: 'output.columns[1].header', message: 'output.columns[1].header: expected "Description", got "Product"' }] })),
    );
    setup({ registry: { attachSource } });
    await screen.findByTestId('add-format-columns');
    typeName('Supplier B');
    await drop('Example input', csv('supplier-b.csv'));
    await drop('Example output', xlsx('load.xlsx'));
    await waitFor(() => expect(learnButton().disabled).toBe(false));
    await act(async () => {
      fireEvent.click(learnButton());
    });
    await screen.findByTestId('rules-map');
    await waitFor(() => expect((screen.getByRole('button', { name: 'Add source and download' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'Add source and download' }));
    expect(await screen.findByText("This file's output doesn't match the format. See which columns differ and fix them, or save it as a new format.")).toBeTruthy();
    expect(screen.getByText('This source does not reproduce the format')).toBeTruthy();
    expect(screen.getByText('output.columns[1].header: expected "Description", got "Product"')).toBeTruthy();
    expect(downloaded).not.toHaveBeenCalled();
  });

  it('the plan\'s sources-per-format limit is told with Upgrade', async () => {
    const attachSource = vi.fn(async () => Promise.reject(new ApiError('limitHit', 403, { limit: 'sourcesPerFormat' })));
    setup({ registry: { attachSource } });
    await screen.findByTestId('add-format-columns');
    typeName('Supplier D');
    await drop('Example input', csv('supplier-b.csv'));
    await drop('Example output', xlsx('load.xlsx'));
    await waitFor(() => expect(learnButton().disabled).toBe(false));
    await act(async () => {
      fireEvent.click(learnButton());
    });
    await screen.findByTestId('rules-map');
    await waitFor(() => expect((screen.getByRole('button', { name: 'Add source and download' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'Add source and download' }));
    expect(await screen.findByText('This format already has as many sources as your plan allows.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Upgrade' })).toBeTruthy();
  });

  it('a format that is not there says so', async () => {
    renderApp({ api: fakeApi({ user: USER, registry: { getFormat: vi.fn(async () => Promise.reject(new ApiError('notFound', 404))) } }), route: ROUTE });
    expect(await screen.findByText("We couldn't find this format. It may have been deleted.")).toBeTruthy();
  });

  it('a visitor is asked to sign in', async () => {
    renderApp({ api: fakeApi(), route: ROUTE });
    expect(await screen.findByText('Sign in to see your saved formats.')).toBeTruthy();
  });
});

describe('which source is this file? (SPEC 8.15)', () => {
  const CHOOSER = 'Which source is this file?';
  const INPUT_COLUMNS = [
    { header: 'Code', type: 'text' },
    { header: 'Name', type: 'text' },
    { header: 'Price', type: 'decimal' },
  ];
  /** A learn that reached the AI step and kept the example input's columns (what `inputHeaders` is made from). */
  const learnWithInput = async (host: LearnHost) => {
    await host.callLearn({ masking: true } as never);
    return learnResult({ path: 'llm', exampleInput: INPUT_COLUMNS });
  };
  const MASTER = sourceSummary({ id: 'S9', name: 'Master prices', conversions: [{ conversionId: 'C7', formatId: 'F7', formatName: 'Other format', status: 'verified' }] });
  const SUPPLIER_A = sourceSummary({ id: 'S1', name: 'Supplier A', conversions: [{ conversionId: 'C1', formatId: 'F1', formatName: 'Supplier price list', status: 'verified' }] });
  const chooser = (): HTMLSelectElement => screen.getByLabelText(CHOOSER) as HTMLSelectElement;
  const choose = (value: string): void => {
    fireEvent.change(chooser(), { target: { value } });
  };

  /** Drops both files, learns, and saves the result; resolves once attachSource has been asked. */
  async function learnAndSave(): Promise<void> {
    await drop('Example input', csv('supplier-b.csv'));
    await drop('Example output', xlsx('load.xlsx'));
    await waitFor(() => expect(learnButton().disabled).toBe(false));
    await act(async () => {
      fireEvent.click(learnButton());
    });
    await screen.findByTestId('rules-map');
    await waitFor(() => expect((screen.getByRole('button', { name: 'Add source and download' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'Add source and download' }));
  }
  const body = (api: ReturnType<typeof fakeApi>): Record<string, unknown> => (api.registry.attachSource.mock.calls[0] as unknown as [string, Record<string, unknown>])[1];

  it('offers "detect automatically" first, then the company\'s sources by name, then "a new source"', async () => {
    setup({ registry: { listSources: vi.fn(async () => [SUPPLIER_A, MASTER]) } });
    await screen.findByTestId('add-format-columns');
    expect(chooser().value).toBe('auto');
    const labels = [...chooser().options].map((o) => o.textContent);
    expect(labels).toEqual(['Detect automatically: reuse a matching source, or create a new one', '⁨Supplier A⁩ (already feeds this format)', 'Master prices', 'A new source…']);
    // A source that already feeds this format can't be attached to it again.
    expect([...chooser().options].map((o) => o.disabled)).toEqual([false, true, false, false]);
    // The default: the name is optional (only used when a new source is created).
    expect(screen.getByLabelText('Source name')).toBeTruthy();
    expect(screen.getByText('Only used if a new source is created. Leave it empty and we will name it for you.')).toBeTruthy();
  });

  it('the default sends the legacy sourceName and the example input\'s headers (structure only), and nothing that forces a source', async () => {
    const { api } = setup({ learn: learnWithInput });
    await screen.findByTestId('add-format-columns');
    typeName('Supplier B');
    await learnAndSave();
    await waitFor(() => expect(api.registry.attachSource).toHaveBeenCalledTimes(1));
    expect(body(api)).toMatchObject({ sourceName: 'Supplier B', inputHeaders: ['Code', 'Name', 'Price'] });
    expect(body(api)).not.toHaveProperty('sourceId');
    expect(body(api)).not.toHaveProperty('newSource');
    // (never a value: the body carries the rules and the headers, not a row of the example)
    expect(JSON.stringify(body(api))).not.toContain('supplier-b.csv');
  });

  it('left without a name, "detect" sends no name at all (the server names it) - and the result is headed by the file\'s name', async () => {
    const { api } = setup({ learn: learnWithInput });
    await screen.findByTestId('add-format-columns');
    await drop('Example input', csv('supplier-b.csv'));
    await drop('Example output', xlsx('load.xlsx'));
    await waitFor(() => expect(learnButton().disabled).toBe(false));
    await act(async () => {
      fireEvent.click(learnButton());
    });
    await screen.findByTestId('rules-map');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('supplier-b');
    await waitFor(() => expect((screen.getByRole('button', { name: 'Add source and download' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'Add source and download' }));
    await waitFor(() => expect(api.registry.attachSource).toHaveBeenCalledTimes(1));
    expect(body(api)).not.toHaveProperty('sourceName');
    expect(body(api)).toMatchObject({ inputHeaders: ['Code', 'Name', 'Price'] });
    // The saved message names the source the server made.
    expect(await screen.findByText('Added "Supplier B" to "Supplier price list". Your file is downloading.')).toBeTruthy();
  });

  it('picking one of the company\'s sources sends its id (no name, no headers-matching needed) and hides the name field', async () => {
    const getSource = vi.fn(async () => sourceDetail({ id: 'S9', name: 'Master prices' }));
    const { api, engine } = setup({ learn: learnWithInput, registry: { listSources: vi.fn(async () => [SUPPLIER_A, MASTER]), getSource } });
    await screen.findByTestId('add-format-columns');
    choose('source:S9');
    expect(screen.queryByLabelText('Source name')).toBeNull();
    await waitFor(() => expect(getSource).toHaveBeenCalledWith('S9'));
    await learnAndSave();
    await waitFor(() => expect(api.registry.attachSource).toHaveBeenCalledTimes(1));
    expect(body(api)).toMatchObject({ sourceId: 'S9', inputHeaders: ['Code', 'Name', 'Price'] });
    expect(body(api)).not.toHaveProperty('sourceName');
    expect(body(api)).not.toHaveProperty('newSource');
    // The result is headed by that source's name.
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Master prices');
    // The browser's own source-lock check ran against that source's structure (SPEC 8.15), with the format lock as before.
    const asked = (engine.staticChecks as ReturnType<typeof vi.fn>).mock.calls as unknown as [unknown, { format?: unknown; source?: { inputSignature: { columns: { header: string }[] } } }][];
    const withSource = asked.filter(([, options]) => options.source !== undefined);
    expect(withSource.length).toBeGreaterThan(0);
    expect(withSource[0]![1].source!.inputSignature.columns.map((c) => c.header)).toEqual(['Code', 'Name', 'Price']);
    expect(withSource[0]![1].format).toBeDefined();
  });

  it('"detect automatically" and "a new source" never run the browser\'s source-lock check', async () => {
    const getSource = vi.fn();
    const { engine } = setup({ learn: learnWithInput, registry: { listSources: vi.fn(async () => [MASTER]), getSource } });
    await screen.findByTestId('add-format-columns');
    typeName('Supplier B');
    await learnAndSave();
    await waitFor(() => expect(engine.staticChecks).toHaveBeenCalled());
    const asked = (engine.staticChecks as ReturnType<typeof vi.fn>).mock.calls as unknown as [unknown, { source?: unknown }][];
    expect(asked.every(([, options]) => options.source === undefined)).toBe(true);
    expect(getSource).not.toHaveBeenCalled();
  });

  it('"a new source" needs a name and sends it as newSource', async () => {
    const { api } = setup({ learn: learnWithInput, registry: { listSources: vi.fn(async () => [MASTER]) } });
    await screen.findByTestId('add-format-columns');
    choose('new');
    await drop('Example input', csv('supplier-b.csv'));
    await drop('Example output', xlsx('load.xlsx'));
    await waitFor(() => expect(screen.queryByText('Reading the output…')).toBeNull());
    // (no name yet: not ready, and the hint says why)
    expect(learnButton().disabled).toBe(true);
    expect(screen.getByText('Add the input, the output and a name to continue.')).toBeTruthy();
    expect(screen.getByText('For example the supplier or client this file comes from.')).toBeTruthy();
    typeName('Supplier B');
    await waitFor(() => expect(learnButton().disabled).toBe(false));
    await act(async () => {
      fireEvent.click(learnButton());
    });
    await screen.findByTestId('rules-map');
    await waitFor(() => expect((screen.getByRole('button', { name: 'Add source and download' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'Add source and download' }));
    await waitFor(() => expect(api.registry.attachSource).toHaveBeenCalledTimes(1));
    expect(body(api)).toMatchObject({ newSource: { name: 'Supplier B' }, inputHeaders: ['Code', 'Name', 'Price'] });
    expect(body(api)).not.toHaveProperty('sourceId');
    expect(body(api)).not.toHaveProperty('sourceName');
  });

  it('a new name is compared with ALL the company\'s sources, ignoring case and spaces (not only this format\'s)', async () => {
    setup({ registry: { listSources: vi.fn(async () => [SUPPLIER_A, MASTER]) } });
    await screen.findByTestId('add-format-columns');
    typeName('  master PRICES ');
    expect(screen.getByText('You already have a source with that name. Choose a different name.')).toBeTruthy();
    await drop('Example input', csv('supplier-b.csv'));
    await drop('Example output', xlsx('load.xlsx'));
    await waitFor(() => expect(screen.queryByText('Reading the output…')).toBeNull());
    expect(learnButton().disabled).toBe(true);
    typeName('Master prices 2');
    expect(screen.queryByText('You already have a source with that name. Choose a different name.')).toBeNull();
    await waitFor(() => expect(learnButton().disabled).toBe(false));
  });

  it('the list of sources failing to load does not stop the screen: detect and "a new source" are still there', async () => {
    setup({ registry: { listSources: vi.fn(async () => Promise.reject(new ApiError('server', 500))) } });
    await screen.findByTestId('add-format-columns');
    expect([...chooser().options].map((o) => o.value)).toEqual(['auto', 'new']);
  });

  it('says "Reused your source X" when the server matched an existing source', async () => {
    const attachSource = vi.fn(async () => ({
      conversion: conversionSummary({ id: 'C2', sourceName: 'Master prices' }),
      source: { id: 'S9', name: 'Master prices' },
      sourceReused: { id: 'S9', name: 'Master prices' },
    }));
    setup({ learn: learnWithInput, registry: { attachSource } });
    await screen.findByTestId('add-format-columns');
    await learnAndSave();
    expect((await screen.findByTestId('source-reused')).textContent).toContain('Reused your source');
    expect(screen.getByTestId('source-reused').textContent).toContain('Master prices');
    // (and the message for the save itself is still there: the source is the server's word)
    expect(screen.getByText('Added "Master prices" to "Supplier price list". Your file is downloading.')).toBeTruthy();
  });

  it('a source that was created says nothing about reuse', async () => {
    setup({ learn: learnWithInput });
    await screen.findByTestId('add-format-columns');
    typeName('Supplier B');
    await learnAndSave();
    await screen.findByText('Added "Supplier B" to "Supplier price list". Your file is downloading.');
    expect(screen.queryByTestId('source-reused')).toBeNull();
  });

  it('a file that does not fit the chosen source is refused with the columns that differ', async () => {
    const attachSource = vi.fn(async () =>
      Promise.reject(new ApiError('sourceMismatch', 422, { problems: [{ kind: 'sourceMismatch', path: 'input.columns[2].type', message: 'column "Price": type must equal the source\'s "decimal", got "text"' }] })),
    );
    setup({ learn: learnWithInput, registry: { attachSource, listSources: vi.fn(async () => [MASTER]), getSource: vi.fn(async () => sourceDetail({ id: 'S9', name: 'Master prices' })) } });
    await screen.findByTestId('add-format-columns');
    choose('source:S9');
    await learnAndSave();
    expect(await screen.findByText("This file's columns don't match the source it belongs to. See which columns differ and fix them, or save it as a new source.")).toBeTruthy();
    expect(screen.getByText("This file doesn't fit the source you chose")).toBeTruthy();
    expect(screen.getByText('column "Price": type must equal the source\'s "decimal", got "text"')).toBeTruthy();
    expect(downloaded).not.toHaveBeenCalled();
  });

  it('a name the server finds taken (someone made it meanwhile) is told in words', async () => {
    const attachSource = vi.fn(async () => Promise.reject(new ApiError('nameTaken', 409)));
    setup({ learn: learnWithInput, registry: { attachSource } });
    await screen.findByTestId('add-format-columns');
    choose('new');
    typeName('Supplier B');
    await learnAndSave();
    expect(await screen.findByText('You already have a source with that name. Choose a different name.')).toBeTruthy();
  });

  it('says the chooser in Hebrew', async () => {
    renderApp({ api: fakeApi({ user: USER, registry: { getFormat: vi.fn(async () => format), listSources: vi.fn(async () => [SUPPLIER_A, MASTER]) } }), route: ROUTE, lang: 'he' });
    const select = (await screen.findByLabelText('לאיזה מקור שייך הקובץ הזה?')) as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual(['זיהוי אוטומטי: שימוש במקור קיים שמתאים, או יצירת מקור חדש', '⁨Supplier A⁩ (כבר מזין את הפורמט הזה)', 'Master prices', 'מקור חדש…']);
    expect(screen.getByText('משמש רק אם נוצר מקור חדש. השאירו ריק ונבחר שם בשבילכם.')).toBeTruthy();
  });
});

describe('flow A: "This looks like your format X"', () => {
  const NAMES = formatSummary({ id: 'F7', name: 'Names list', outputHeaders: ['Name'], fileType: 'xlsx', outputColumns: 1 });

  async function learnLocally(api: ReturnType<typeof fakeApi>) {
    const { engine } = fakeEngine(async () => learnResult({ path: 'local' }));
    renderApp({ engine, api });
    fireEvent.change(screen.getByLabelText('Example input'), { target: { files: [csv('orders.csv')] } });
    fireEvent.change(screen.getByLabelText('Example output'), { target: { files: [csv('Orders report.csv')] } });
    await waitFor(() => expect(screen.getAllByText(/1,204/)).toHaveLength(2));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Learn the format/ }));
    });
    await screen.findByTestId('rules-map');
  }

  it('offers to add the file as a new source when the example output matches a saved format, and carries the files over', async () => {
    const api = fakeApi({ user: USER, registry: { listFormats: vi.fn(async () => [NAMES]), getFormat: vi.fn(async () => getFormatResponse({ id: 'F7', name: 'Names list', sources: [], detail: { outputHeaders: ['Name'], fileType: 'xlsx' } })) } });
    await learnLocally(api);
    expect(await screen.findByText('This looks like your format "Names list"')).toBeTruthy();
    expect(screen.getByText('Add this file as a new source for it?')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Add as a new source' }));
    expect(await screen.findByRole('heading', { name: 'Add a source to "Names list"' })).toBeTruthy();
    expect(screen.getByText('We filled in the files from the format you just learned.')).toBeTruthy();
    expect(screen.getByText('orders.csv')).toBeTruthy();
    expect(screen.getByText('Orders report.csv')).toBeTruthy();
  });

  it('"No, save it as a new format" dismisses the offer', async () => {
    const api = fakeApi({ user: USER, registry: { listFormats: vi.fn(async () => [NAMES]) } });
    await learnLocally(api);
    fireEvent.click(await screen.findByRole('button', { name: 'No, save it as a new format' }));
    expect(screen.queryByText('This looks like your format "Names list"')).toBeNull();
    expect(screen.getByRole('button', { name: 'Save format and download' })).toBeTruthy();
  });

  it('does not offer a format whose headers or file type differ', async () => {
    const other = formatSummary({ id: 'F8', name: 'Other', outputHeaders: ['Name', 'Extra'], outputColumns: 2 });
    const csvFormat = formatSummary({ id: 'F9', name: 'A csv', outputHeaders: ['Name'], fileType: 'csv', outputColumns: 1 });
    const api = fakeApi({ user: USER, registry: { listFormats: vi.fn(async () => [other, csvFormat]) } });
    await learnLocally(api);
    await waitFor(() => expect(api.registry.listFormats).toHaveBeenCalled());
    await act(async () => {});
    expect(screen.queryByText(/This looks like your format/)).toBeNull();
  });

  it('does not offer anything to a visitor (there are no saved formats to look at)', async () => {
    const api = fakeApi({ registry: { listFormats: vi.fn(async () => [NAMES]) } });
    await learnLocally(api);
    await act(async () => {});
    expect(screen.queryByText(/This looks like your format/)).toBeNull();
  });
});
