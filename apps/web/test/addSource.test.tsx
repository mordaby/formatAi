// Adding a source to a format (SPEC 5 A2, 8.12): the output must match the format - same headers in order, same file type - or the
// screen says which columns differ; then the learn runs in attach mode (the format is the `target`), the result opens in the
// same editor, and saving adds a conversion (a refusal by the format lock is shown with its problems). In flow A, an example
// output that matches a saved format is offered as "add it as a new source". Which Source object the file belongs to (SPEC 8.15) is automatic
// and silent: there is no chooser and no note. A fake API and a fake worker.
import { promptVersion } from '@formatai/shared';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/api';
import { createMemoryPendingStore, setPendingStore } from '../src/app/pendingLearn';
import { compareOutput } from '../src/pages/Result/matchFormat';
import type { LearnHost } from '../src/worker/engineApi';
import { conversionSummary, formatSummary, getFormatResponse, sourceSummary } from './helpers/registryKit';
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

function setup(over: { registry?: Record<string, unknown>; learn?: Parameters<typeof fakeEngine>[0]; engine?: Record<string, unknown>; apiLearn?: () => Promise<never> } = {}) {
  const api = fakeApi({
    user: USER,
    registry: { getFormat: vi.fn(async () => format), attachSource: vi.fn(async () => ({ conversion: conversionSummary({ id: 'C2', sourceId: 'S2', sourceName: 'Supplier B' }), source: { id: 'S2', name: 'Supplier B', formats: 1 } })), ...over.registry },
    learn: over.apiLearn ?? vi.fn(async () => ({ rules: RULES, verified: true, problems: [], learnId: 'L1', cached: false, counted: true, failedAttempts: 0, quota: { remaining: 2, period: 'month' as const, limit: null }, promptVersion: 'learn-v9' as const })),
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
    // (the name is optional)
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
    expect(screen.getByRole('button', { name: 'Add source' })).toBeTruthy();
  });

  it('saving POSTs a new conversion of the format with the source\'s name, and does not download the file', async () => {
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
    await waitFor(() => expect((screen.getByRole('button', { name: 'Add source' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'Add source' }));

    const attachSource = api.registry.attachSource;
    await waitFor(() => expect(attachSource).toHaveBeenCalledTimes(1));
    const [formatId, body] = attachSource.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(formatId).toBe('F1');
    expect(body).toMatchObject({ sourceName: 'Supplier B', status: 'verified', acceptedDifferences: 0, exampleExceptions: [], learnPath: 'llm', masking: true, promptVersion: 'learn-v9' });
    expect(promptVersion).not.toBe('learn-v9'); // API audit 2026-10-07: the version the server learned with, never the browser's constant
    expect(body.rules).toEqual(RULES);
    expect(await screen.findByText('Added "Supplier B" to "Supplier price list".')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Open My formats' })).toBeTruthy();
    expect(downloaded).not.toHaveBeenCalled();
  });

  it('"Download the file" converts the example input with the rules on screen and downloads it, before or after saving', async () => {
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
    await waitFor(() => expect((screen.getByRole('button', { name: 'Add source' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'Download the file' }));
    await waitFor(() => expect(downloaded).toHaveBeenCalledTimes(1));
    expect(downloaded.mock.calls[0]![0]).toBe('supplier-b (converted).xlsx');
    expect(api.registry.attachSource).not.toHaveBeenCalled();
    // After saving it is still there.
    fireEvent.click(screen.getByRole('button', { name: 'Add source' }));
    await screen.findByText('Added "Supplier B" to "Supplier price list".');
    expect(downloaded).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Download the file' }));
    await waitFor(() => expect(downloaded).toHaveBeenCalledTimes(2));
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
    await waitFor(() => expect((screen.getByRole('button', { name: 'Add source' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'Add source' }));
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
    await waitFor(() => expect((screen.getByRole('button', { name: 'Add source' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'Add source' }));
    expect(await screen.findByText('This format already has as many sources as your plan allows.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Upgrade' })).toBeTruthy();
  });

  it('the AI step refused for the quota (429 limitHit aiLearns): the out-of-AI-formats dialog over the form, the files kept - not an error screen', async () => {
    const apiLearn = vi.fn(async () => Promise.reject(new ApiError('limitHit', 429, { limit: 'aiLearns', period: 'month' })));
    setup({ apiLearn });
    await screen.findByTestId('add-format-columns');
    await drop('Example input', csv('supplier-b.csv'));
    await drop('Example output', xlsx('load.xlsx'));
    await waitFor(() => expect(learnButton().disabled).toBe(false));
    await act(async () => {
      fireEvent.click(learnButton());
    });
    const dialog = await screen.findByRole('dialog', { name: "You've used your AI formats for this month" });
    expect(within(dialog).getByText(/^Your plan includes 3 AI formats a month\. They come back on /)).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Join the paid waitlist' })).toBeTruthy();
    // (the free learn of Home has no place here: the source is learned against the format)
    expect(within(dialog).queryByRole('button', { name: 'Learn without AI' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Change files' })).toBeNull();
    expect(learnButton()).toBeTruthy();
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

describe('which source is this file? Automatic and silent (SPEC 8.15: no source UI in the MVP)', () => {
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

  /** Drops both files, learns, and saves the result; resolves once attachSource has been asked. */
  async function learnAndSave(inputName = 'supplier-b.csv'): Promise<void> {
    await drop('Example input', csv(inputName));
    await drop('Example output', xlsx('load.xlsx'));
    await waitFor(() => expect(learnButton().disabled).toBe(false));
    await act(async () => {
      fireEvent.click(learnButton());
    });
    await screen.findByTestId('rules-map');
    await waitFor(() => expect((screen.getByRole('button', { name: 'Add source' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'Add source' }));
  }
  const body = (api: ReturnType<typeof fakeApi>): Record<string, unknown> => (api.registry.attachSource.mock.calls[0] as unknown as [string, Record<string, unknown>])[1];

  it('has no chooser: no "which source is this file?", no list of the company\'s sources, no "a new source" - only the optional name', async () => {
    setup({ registry: { listSources: vi.fn(async () => [SUPPLIER_A, MASTER]) } });
    await screen.findByTestId('add-format-columns');
    expect(screen.queryByLabelText('Which source is this file?')).toBeNull();
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.queryByText(/Detect automatically/)).toBeNull();
    expect(screen.queryByText('Master prices')).toBeNull();
    expect(screen.queryByText('A new source…')).toBeNull();
    // The name field it had stays, and is optional.
    expect(screen.getByLabelText('Source name')).toBeTruthy();
    expect(screen.getByText('Optional. For example the supplier or client this file comes from. Leave it empty and we will name it for you.')).toBeTruthy();
  });

  it('sends the typed name as `sourceName` and the example input\'s headers (structure only), and nothing that forces a source', async () => {
    const { api } = setup({ learn: learnWithInput });
    await screen.findByTestId('add-format-columns');
    typeName('Supplier B');
    await learnAndSave();
    await waitFor(() => expect(api.registry.attachSource).toHaveBeenCalledTimes(1));
    expect(body(api)).toMatchObject({ sourceName: 'Supplier B', inputHeaders: ['Code', 'Name', 'Price'] });
    expect(body(api)).not.toHaveProperty('sourceId');
    expect(body(api)).not.toHaveProperty('newSource');
    // A name the user typed is theirs: no default is sent next to it.
    expect(body(api)).not.toHaveProperty('suggestedSourceName');
    // (never a value: the body carries the rules and the headers, not a row of the example)
    expect(JSON.stringify(body(api))).not.toContain('supplier-b.csv');
  });

  it('left without a name, sends the example input file\'s name as the default (`suggestedSourceName`) and no `sourceName` - and the result is headed by the file\'s name', async () => {
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
    await waitFor(() => expect((screen.getByRole('button', { name: 'Add source' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'Add source' }));
    await waitFor(() => expect(api.registry.attachSource).toHaveBeenCalledTimes(1));
    expect(body(api)).not.toHaveProperty('sourceName');
    expect(body(api)).toMatchObject({ suggestedSourceName: 'supplier-b', inputHeaders: ['Code', 'Name', 'Price'] });
    // The saved message names the source the server made.
    expect(await screen.findByText('Added "Supplier B" to "Supplier price list".')).toBeTruthy();
  });

  it('the default has the date and counters of the file taken out, and is not sent when nothing is left of the name', async () => {
    const { api } = setup({ learn: learnWithInput });
    await screen.findByTestId('add-format-columns');
    await learnAndSave('Supplier B 2026-09 (1).csv');
    await waitFor(() => expect(api.registry.attachSource).toHaveBeenCalledTimes(1));
    expect(body(api)).toMatchObject({ suggestedSourceName: 'Supplier B' });
    cleanup();

    const again = setup({ learn: learnWithInput });
    await screen.findByTestId('add-format-columns');
    await learnAndSave('2026-09-15.csv');
    await waitFor(() => expect(again.api.registry.attachSource).toHaveBeenCalledTimes(1));
    const sent = (again.api.registry.attachSource.mock.calls[0] as unknown as [string, Record<string, unknown>])[1];
    expect(sent).not.toHaveProperty('suggestedSourceName');
    expect(sent).not.toHaveProperty('sourceName');
  });

  it('never runs a source check of its own in the browser: which source this becomes is the server\'s decision', async () => {
    const { engine } = setup({ learn: learnWithInput, registry: { listSources: vi.fn(async () => [MASTER]) } });
    await screen.findByTestId('add-format-columns');
    typeName('Supplier B');
    await learnAndSave();
    await waitFor(() => expect(engine.staticChecks).toHaveBeenCalled());
    const asked = (engine.staticChecks as ReturnType<typeof vi.fn>).mock.calls as unknown as [unknown, { source?: unknown }][];
    expect(asked.every(([, options]) => options.source === undefined)).toBe(true);
  });

  it('says nothing when the server recognized one of the company\'s sources and reused it (no "Reused your source ...")', async () => {
    const attachSource = vi.fn(async () => ({
      conversion: conversionSummary({ id: 'C2', sourceId: 'S9', sourceName: 'Master prices' }),
      source: { id: 'S9', name: 'Master prices', formats: 2 },
      sourceReused: { id: 'S9', name: 'Master prices' },
    }));
    setup({ learn: learnWithInput, registry: { attachSource } });
    await screen.findByTestId('add-format-columns');
    await learnAndSave();
    // the message for the save itself is all there is: the source is the server's word
    expect(await screen.findByText('Added "Master prices" to "Supplier price list".')).toBeTruthy();
    expect(screen.queryByTestId('source-reused')).toBeNull();
    expect(document.body.textContent).not.toMatch(/reused|recogni[sz]ed|saved as source/i);
  });

  it('says nothing more when the server created a source, either', async () => {
    setup({ learn: learnWithInput });
    await screen.findByTestId('add-format-columns');
    typeName('Supplier B');
    await learnAndSave();
    await screen.findByText('Added "Supplier B" to "Supplier price list".');
    expect(screen.queryByTestId('source-reused')).toBeNull();
    expect(document.body.textContent).not.toMatch(/reused|recogni[sz]ed|saved as source/i);
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

  it('the list of the company\'s sources failing to load does not stop the screen', async () => {
    setup({ registry: { listSources: vi.fn(async () => Promise.reject(new ApiError('server', 500))) } });
    await screen.findByTestId('add-format-columns');
    expect(screen.getByLabelText('Source name')).toBeTruthy();
    expect(screen.queryByText("We couldn't load your sources.")).toBeNull();
  });

  it('a refusal of the source check is still told with the columns that differ', async () => {
    const attachSource = vi.fn(async () =>
      Promise.reject(new ApiError('sourceMismatch', 422, { problems: [{ kind: 'sourceMismatch', path: 'input.columns[2].type', message: 'column "Price": type must equal the source\'s "decimal", got "text"' }] })),
    );
    setup({ learn: learnWithInput, registry: { attachSource } });
    await screen.findByTestId('add-format-columns');
    await learnAndSave();
    expect(await screen.findByText("This file's columns don't match the source it belongs to. See which columns differ and fix them, or save it as a new source.")).toBeTruthy();
    expect(screen.getByText('column "Price": type must equal the source\'s "decimal", got "text"')).toBeTruthy();
    expect(downloaded).not.toHaveBeenCalled();
  });

  it('a name the server finds taken (someone made it meanwhile) is told in words', async () => {
    const attachSource = vi.fn(async () => Promise.reject(new ApiError('nameTaken', 409)));
    setup({ learn: learnWithInput, registry: { attachSource } });
    await screen.findByTestId('add-format-columns');
    typeName('Supplier B');
    await learnAndSave();
    expect(await screen.findByText('You already have a source with that name. Choose a different name.')).toBeTruthy();
  });

  it('says the name field in Hebrew, with no chooser', async () => {
    renderApp({ api: fakeApi({ user: USER, registry: { getFormat: vi.fn(async () => format), listSources: vi.fn(async () => [SUPPLIER_A, MASTER]) } }), route: ROUTE, lang: 'he' });
    expect(await screen.findByLabelText('שם המקור')).toBeTruthy();
    expect(screen.getByText('לא חובה. למשל הספק או הלקוח שממנו הקובץ מגיע. השאירו ריק ונבחר שם בשבילכם.')).toBeTruthy();
    expect(screen.queryByLabelText('לאיזה מקור שייך הקובץ הזה?')).toBeNull();
    expect(screen.queryByRole('combobox')).toBeNull();
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
    expect(screen.getByRole('button', { name: 'Save format' })).toBeTruthy();
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
