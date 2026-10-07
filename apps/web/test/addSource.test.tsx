// Adding a source to a format (SPEC 5 A2, 8.12): the output must match the format - same headers in order, same file type - or the
// screen says which columns differ; then the learn runs in attach mode (the format is the `target`), the result opens in the
// same editor, and saving adds a conversion (a refusal by the format lock is shown with its problems). The learn is the free engine first,
// and "Finish with AI" is offered only for what it left (owner decision 2026-10-07). The Result screen's Save sends a result with fields left
// here ("Add as a source", formatMatchSave.test.tsx). Which Source object the file belongs to (SPEC 8.15) is automatic and silent: there is
// no chooser and no note. A fake API and a fake worker (most tests' worker ignores `ai`: they test the screen after an AI learn).
import { limits, promptVersion } from '@formatai/shared';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/api';
import { createMemoryPendingStore, setPendingStore } from '../src/app/pendingLearn';
import { compareOutput } from '../src/pages/Result/matchFormat';
import type { LearnHost } from '../src/worker/engineApi';
import { conversionSummary, formatSummary, getFormatResponse, sourceSummary } from './helpers/registryKit';
import { rules as fixtureRules } from '../src/rulesText/fixtures';
import { csv, fakeApi, fakeEngine, learnResult, RULES, renderApp, USER } from './helpers/renderApp';

const { downloaded, openInNewTab } = vi.hoisted(() => ({ downloaded: vi.fn(), openInNewTab: vi.fn() }));
vi.mock('../src/flow/download', async (orig) => ({ ...(await orig<typeof import('../src/flow/download')>()), downloadBytes: downloaded }));
vi.mock('../src/app/redirect', () => ({ redirectTo: vi.fn(), openInNewTab }));

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

function setup(over: { registry?: Record<string, unknown>; learn?: Parameters<typeof fakeEngine>[0]; engine?: Record<string, unknown>; apiLearn?: () => Promise<never>; auth?: Record<string, unknown>; lang?: 'en' | 'he' } = {}) {
  const api = fakeApi({
    features: { formatSources: true },
    user: USER,
    ...(over.auth ? { auth: over.auth } : {}),
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
  renderApp({ api, engine, route: ROUTE, ...(over.lang ? { lang: over.lang } : {}) });
  return { api, engine, learn };
}

/** The free engine's own result for this source: Item Code and Unit Price built, Description and Category left for the AI step. */
function partialAttach(): ReturnType<typeof learnResult> {
  return learnResult({
    path: 'partial',
    rules: fixtureRules({
      output: {
        columns: [
          { header: 'Item Code', from: 'c_name' },
          { header: 'Description', from: null },
          { header: 'Unit Price', from: 'c_name' },
          { header: 'Category', from: null },
        ],
      },
    }),
    partial: { reason: 'aiNotAllowed', solved: ['Item Code', 'Unit Price'], needsAi: ['Description', 'Category'], external: [], solvedColumns: [0, 2], needsAiParts: [] },
  });
}

/** A worker that answers as the engine does: the free engine (here a partial result) unless the AI step is allowed - then the AI step. */
const freeThenAi = async (host: LearnHost, args: { ai?: string }) => {
  if (args.ai !== 'allowed') return partialAttach();
  await host.callLearn({ masking: true } as never);
  return learnResult({ path: 'llm' });
};

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
    renderApp({ api: fakeApi({ features: { formatSources: true }, user: USER, registry: { getFormat: vi.fn(async () => format) } }), route: ROUTE, lang: 'he', engine: fakeEngine(undefined, undefined, { readHeaders: vi.fn(async () => ({ ok: true, headers: ['Item Code', 'Product', 'Unit Price', 'Category'], sheetName: 'S', direction: 'ltr', rows: 3 })) }).engine });
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
    // The free engine first (owner decision 2026-10-07): the AI step is not allowed until the user presses "Finish with AI".
    expect(args.ai).toBe('notAllowed');
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

  it('"See what we send" is there with the result too: the learn request it sent, as JSON (SPEC 15)', async () => {
    setup();
    await screen.findByTestId('add-format-columns');
    await drop('Example input', csv('supplier-b.csv'));
    await drop('Example output', xlsx('load.xlsx'));
    await waitFor(() => expect(learnButton().disabled).toBe(false));
    await act(async () => {
      fireEvent.click(learnButton());
    });
    await screen.findByTestId('rules-map');
    fireEvent.click(screen.getByRole('button', { name: 'See what we send' }));
    const records = await screen.findAllByTestId('send-record');
    expect(records).toHaveLength(1);
    expect(records[0]!.textContent).toContain('"payload"');
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

  it('a format already at the limit (registered, 3 sources) says so before anything is dropped: no form, the limit and Upgrade - in either language', async () => {
    const full = getFormatResponse({ id: 'F1', name: 'Supplier price list', sources: ['A', 'B', 'C'].map((x) => conversionSummary({ id: `C${x}`, sourceName: `Supplier ${x}` })), detail: { ...format.format, sources: 3 } });
    const { learn } = setup({ registry: { getFormat: vi.fn(async () => full) } });
    expect(await screen.findByTestId('source-limit')).toBeTruthy();
    expect(screen.getByTestId('source-limit').textContent).toContain("Supplier price list already has 3 sources (your plan's limit).");
    expect(screen.getByRole('button', { name: 'Upgrade' })).toBeTruthy();
    expect(screen.queryByTestId('add-format-columns')).toBeNull();
    expect(screen.queryByLabelText('Example input')).toBeNull();
    expect(learn).not.toHaveBeenCalled();
    cleanup();

    setup({ registry: { getFormat: vi.fn(async () => full) }, lang: 'he' });
    expect(await screen.findByTestId('source-limit')).toBeTruthy();
    expect(screen.getByTestId('source-limit').textContent).toContain('לפורמט Supplier price list כבר יש 3 מקורות (המגבלה של התוכנית שלכם).');
  });

  it('a paid plan has no limit: a format with 3 sources still opens the form', async () => {
    const PAID = { ...USER, tier: 'paid' as const };
    const full = getFormatResponse({ id: 'F1', name: 'Supplier price list', sources: ['A', 'B', 'C'].map((x) => conversionSummary({ id: `C${x}`, sourceName: `Supplier ${x}` })), detail: { ...format.format, sources: 3 } });
    setup({ registry: { getFormat: vi.fn(async () => full) }, auth: { me: vi.fn(async () => PAID), setLanguage: vi.fn(async () => PAID) } });
    expect(await screen.findByTestId('add-format-columns')).toBeTruthy();
    expect(screen.queryByTestId('source-limit')).toBeNull();
  });

  it('the AI step refused for the quota (429 limitHit aiLearns): the out-of-AI-formats dialog over the form, the files kept - not an error screen', async () => {
    const apiLearn = vi.fn(async () => Promise.reject(new ApiError('limitHit', 429, { limit: 'aiLearns', period: 'month' })));
    setup({ apiLearn, learn: freeThenAi });
    await screen.findByTestId('add-format-columns');
    await drop('Example input', csv('supplier-b.csv'));
    await drop('Example output', xlsx('load.xlsx'));
    await waitFor(() => expect(learnButton().disabled).toBe(false));
    await act(async () => {
      fireEvent.click(learnButton());
    });
    // The free engine first; the AI step only on the click (the account said 3 were left: the server knew better).
    await act(async () => void fireEvent.click(await screen.findByRole('button', { name: 'Finish with AI' })));
    const dialog = await screen.findByRole('dialog', { name: "You've used your AI formats for this month" });
    expect(within(dialog).getByText(/^Your plan includes 3 AI formats a month\. They come back on /)).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Join the paid waitlist' })).toBeTruthy();
    // (the free learn of Home has no place here: the source is learned against the format)
    expect(within(dialog).queryByRole('button', { name: 'Learn without AI' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Change files' })).toBeNull();
    expect(learnButton()).toBeTruthy();
  });

  // The audit's C10: every flow tells the app what is left of the AI formats, and that the session is gone - not only Home's learn.
  it('what is left of the AI formats after the learn is what the account menu says (the learn reported it)', async () => {
    setup(); // (the learn's answer: 2 left; the account menu read 3 before)
    await screen.findByTestId('add-format-columns');
    await drop('Example input', csv('supplier-b.csv'));
    await drop('Example output', xlsx('load.xlsx'));
    await waitFor(() => expect(learnButton().disabled).toBe(false));
    await act(async () => void fireEvent.click(learnButton()));
    await screen.findByTestId('rules-map');
    fireEvent.click(await screen.findByRole('button', { name: 'Account menu for Dana Levi' }));
    const panel = await screen.findByRole('group', { name: 'Account' });
    await waitFor(() => expect(panel.textContent).toContain('AI formats left this month: 2'));
  });

  it('what the AI step reported is said by the same note as on the Result screen: AI formats left, and which try this was', async () => {
    setup({
      apiLearn: async () =>
        ({ rules: RULES, verified: false, problems: [], learnId: 'L1', cached: false, counted: false, failedAttempts: 1, quota: { remaining: 2, period: 'month' as const, limit: null } }) as never,
      // (the browser reports its own verification: it did not match, so this is a failed try, 1 so far)
      registry: { learnOutcome: vi.fn(async () => ({ counted: false, quota: { remaining: 2, period: 'month' as const, limit: null }, failedAttempts: 1, exhausted: false })) },
      learn: async (host: LearnHost) => {
        await host.callLearn({ masking: true } as never);
        return learnResult({ path: 'llm', verification: { verified: false, matched: 2, total: 3, mismatches: [], layoutProblems: [], layoutIssues: [], repairProblems: [] } });
      },
    });
    await screen.findByTestId('add-format-columns');
    await drop('Example input', csv('supplier-b.csv'));
    await drop('Example output', xlsx('load.xlsx'));
    await waitFor(() => expect(learnButton().disabled).toBe(false));
    await act(async () => void fireEvent.click(learnButton()));
    const note = await screen.findByTestId('ai-note');
    expect(note.textContent).toContain('AI formats left this month: 2');
    expect(note.textContent).toContain(`try 1 of ${limits.learn.maxFailedAiAttempts}`);
  });

  it('a learn refused because the session is gone reads who is signed in again (so "Sign in" works)', async () => {
    const { api } = setup({ apiLearn: async () => Promise.reject(new ApiError('signInForAi', 403)) });
    await screen.findByTestId('add-format-columns');
    await drop('Example input', csv('supplier-b.csv'));
    await drop('Example output', xlsx('load.xlsx'));
    await waitFor(() => expect(learnButton().disabled).toBe(false));
    const before = api.auth.me.mock.calls.length;
    await act(async () => void fireEvent.click(learnButton()));
    await waitFor(() => expect(api.auth.me.mock.calls.length).toBeGreaterThan(before));
  });

  it('a format that is not there says so', async () => {
    renderApp({ api: fakeApi({ features: { formatSources: true }, user: USER, registry: { getFormat: vi.fn(async () => Promise.reject(new ApiError('notFound', 404))) } }), route: ROUTE });
    expect(await screen.findByText("We couldn't find this format. It may have been deleted.")).toBeTruthy();
  });

  it('a visitor is asked to sign in', async () => {
    renderApp({ api: fakeApi({ features: { formatSources: true } }), route: ROUTE });
    expect(await screen.findByText('Sign in to see your saved formats.')).toBeTruthy();
  });

  // The audit's C7: the session ran out while the learned source was on screen. Taking the screen away lost the learn (and the AI format spent
  // on it) and every edit; the Sign in button did nothing.
  it('a session that ends while the result is open keeps the screen, the learn and the edits; signing in again (a new tab) carries on, and the save goes', async () => {
    let signedIn = true;
    const me = vi.fn(async () => (signedIn ? USER : null));
    const attachSource = vi
      .fn()
      .mockRejectedValueOnce(new ApiError('signInRequired', 401))
      .mockResolvedValue({ conversion: conversionSummary({ id: 'C2', sourceId: 'S2', sourceName: 'Supplier B' }), source: { id: 'S2', name: 'Supplier B', formats: 1 } });
    const api = fakeApi({
    features: { formatSources: true },
      user: USER,
      auth: { me },
      registry: { getFormat: vi.fn(async () => format), attachSource },
      learn: vi.fn(async () => ({ rules: RULES, verified: true, problems: [], learnId: 'L1', cached: false, counted: true, failedAttempts: 0 })),
    });
    const { engine, learn } = fakeEngine(
      async (host: LearnHost) => {
        await host.callLearn({ masking: true } as never);
        return learnResult({ path: 'llm' });
      },
      undefined,
      { readHeaders: vi.fn(async ({ file }: { file: { name: string } }) => ({ ok: true, headers: HEADERS_OF[file.name] ?? [], sheetName: 'S', direction: 'ltr', rows: 3 })) },
    );
    renderApp({ api, engine, route: ROUTE });
    await screen.findByTestId('add-format-columns');
    await drop('Example input', csv('supplier-b.csv'));
    await drop('Example output', xlsx('load.xlsx'));
    await waitFor(() => expect(learnButton().disabled).toBe(false));
    await act(async () => void fireEvent.click(learnButton()));
    await screen.findByTestId('rules-map');
    const addSource = () => screen.getByRole('button', { name: 'Add source' }) as HTMLButtonElement;
    await waitFor(() => expect(addSource().disabled).toBe(false));

    // The session ends: the save is refused for it, and "who is signed in" says nobody.
    signedIn = false;
    await act(async () => void fireEvent.click(addSource()));
    const wall = await screen.findByRole('dialog', { name: 'Sign in' });
    expect(within(wall).getByText('Your sign-in has ended. Sign in again to save - everything on this page stays as it is.')).toBeTruthy();
    expect(within(wall).getByText('Signing in opens a new tab. When you are done there, come back to this tab: your work is here.')).toBeTruthy();
    // The screen is still there behind it - the learned source, not the "sign in to see your formats" page.
    expect(screen.getByTestId('rules-map')).toBeTruthy();
    expect(screen.queryByText('Sign in to see your saved formats.')).toBeNull();
    expect(screen.getByTestId('session-expired')).toBeTruthy();

    // Signing in opens the provider in a new tab; this page goes nowhere.
    fireEvent.click(within(wall).getByRole('button', { name: 'Continue with Google' }));
    await waitFor(() => expect(openInNewTab).toHaveBeenCalledTimes(1));
    expect(String(openInNewTab.mock.calls[0]![0])).toContain('/api/auth/google/start?returnTo=');
    expect(screen.getByTestId('rules-map')).toBeTruthy();
    // Closed, the wall comes back from the save message's "Sign in" (it used to do nothing).
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Sign in' })).toBeNull());
    fireEvent.click(screen.getAllByRole('button', { name: 'Sign in' }).at(-1)!);
    expect(await screen.findByRole('dialog', { name: 'Sign in' })).toBeTruthy();

    // Back in this tab, signed in: the same screen carries on - nothing was learned again (no second AI format) - and the save goes.
    signedIn = true;
    await act(async () => void window.dispatchEvent(new Event('focus')));
    await waitFor(() => expect(screen.queryByTestId('session-expired')).toBeNull());
    expect(screen.queryByRole('dialog', { name: 'Sign in' })).toBeNull();
    expect(learn).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(addSource().disabled).toBe(false));
    await act(async () => void fireEvent.click(addSource()));
    await waitFor(() => expect(attachSource).toHaveBeenCalledTimes(2));
    expect(await screen.findByText(/Supplier B/)).toBeTruthy();
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
    renderApp({ api: fakeApi({ features: { formatSources: true }, user: USER, registry: { getFormat: vi.fn(async () => format), listSources: vi.fn(async () => [SUPPLIER_A, MASTER]) } }), route: ROUTE, lang: 'he' });
    expect(await screen.findByLabelText('שם המקור')).toBeTruthy();
    expect(screen.getByText('לא חובה. למשל הספק או הלקוח שממנו הקובץ מגיע. השאירו ריק ונבחר שם בשבילכם.')).toBeTruthy();
    expect(screen.queryByLabelText('לאיזה מקור שייך הקובץ הזה?')).toBeNull();
    expect(screen.queryByRole('combobox')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The free engine first; the AI step only on the user's click (owner decision 2026-10-07, point 6). The learn starts with the AI step not
// allowed; the result shows what the free engine solved and what is left, and "Finish with AI" - the Result screen's own panel, its quota
// line and its out-of-AI-formats dialog - is offered only when something is left. The format lock stays.
// ---------------------------------------------------------------------------

describe('Add a source: the free engine first, the AI step only on the click', () => {
  async function learnFree(): Promise<void> {
    await screen.findByTestId('add-format-columns');
    await drop('Example input', csv('supplier-b.csv'));
    await drop('Example output', xlsx('load.xlsx'));
    await waitFor(() => expect(learnButton().disabled).toBe(false));
    await act(async () => void fireEvent.click(learnButton()));
    await screen.findByTestId('rules-map');
  }

  it('a free result with something left: no AI call, the panel says what is left and offers "Finish with AI" with its quota line', async () => {
    const { api, learn, engine } = setup({ learn: freeThenAi });
    await learnFree();
    expect(learn).toHaveBeenCalledTimes(1);
    expect((learn.mock.calls[0]![0] as { ai: string }).ai).toBe('notAllowed');
    expect(api.learn).not.toHaveBeenCalled();
    const panel = screen.getByTestId('deep-panel');
    expect(within(panel).getByRole('heading').textContent).toBe('The free engine solved 2 of 4 fields.');
    expect([...within(panel).getByTestId('deep-fields').querySelectorAll('li')].map((li) => li.getAttribute('data-field'))).toEqual(['col:Description', 'col:Category']);
    expect(within(panel).getByText(/For a source of a format, the deep analysis starts again from your two files/)).toBeTruthy();
    expect(within(panel).getByTestId('deep-uses').textContent).toBe('Uses 1 AI format (3 left this month), and only if it succeeds.');
    // The format lock stays on the free result as on any other.
    await waitFor(() => expect(engine.staticChecks).toHaveBeenCalled());
    const asked = (engine.staticChecks as ReturnType<typeof vi.fn>).mock.calls as unknown as [unknown, { format?: { output: unknown } }][];
    expect(asked.every(([, options]) => options.format?.output !== undefined)).toBe(true);
    // (the panel's run is the one primary action; Save is there too - with the fields left as "needs your input")
    expect(screen.getByRole('button', { name: 'Add source' }).className).not.toContain('primary');
  });

  it('"Finish with AI" runs the whole learn against the format, with the AI step allowed - once, on the click', async () => {
    const { api, learn } = setup({ learn: freeThenAi });
    await learnFree();
    await act(async () => void fireEvent.click(screen.getByRole('button', { name: 'Finish with AI' })));
    await waitFor(() => expect(learn).toHaveBeenCalledTimes(2));
    const args = learn.mock.calls[1]![0] as { ai: string; target: { output: { columns: { header: string }[] } } };
    expect(args.ai).toBe('allowed');
    expect(args.target.output.columns.map((c) => c.header)).toEqual(HEADERS);
    await waitFor(() => expect(api.learn).toHaveBeenCalledTimes(1));
    // The AI step's answer replaces the free result: nothing is left, so the panel is gone; what was sent can be seen.
    await screen.findByTestId('ai-note');
    expect(screen.queryByTestId('deep-panel')).toBeNull();
    expect(screen.getByRole('button', { name: 'See what we send' })).toBeTruthy();
  });

  it('with edits on the free result, "Finish with AI" asks before replacing them', async () => {
    const { learn } = setup({ learn: freeThenAi });
    await learnFree();
    const row = document.querySelector('[data-line-id="col:Item Code"]') as HTMLElement;
    fireEvent.click(within(row).getAllByRole('button').find((b) => b.classList.contains('map-line__main'))!);
    fireEvent.change(screen.getByLabelText('Column name'), { target: { value: 'Item code' } });
    await act(async () => void fireEvent.click(screen.getByRole('button', { name: 'Finish with AI' })));
    const ask = await screen.findByRole('dialog', { name: 'Start the AI step over?' });
    await act(async () => void fireEvent.click(within(ask).getByRole('button', { name: 'Keep my rules' })));
    expect(learn).toHaveBeenCalledTimes(1);
    await act(async () => void fireEvent.click(screen.getByRole('button', { name: 'Finish with AI' })));
    await act(async () => void fireEvent.click(within(await screen.findByRole('dialog', { name: 'Start the AI step over?' })).getByRole('button', { name: 'Replace my rules' })));
    await waitFor(() => expect(learn).toHaveBeenCalledTimes(2));
  });

  it('none left: the panel says so (the amber notice, with the waitlist) instead of offering a run, and the result is delivered as it is', async () => {
    const { api, learn } = setup({ learn: freeThenAi, auth: { quota: vi.fn(async () => ({ remaining: 0, period: 'month' })) } });
    await learnFree();
    const panel = screen.getByTestId('deep-panel');
    await waitFor(() => expect(within(panel).getByText(/No AI formats left this month/)).toBeTruthy());
    expect(within(panel).queryByRole('button', { name: 'Finish with AI' })).toBeNull();
    expect(within(panel).getByRole('button', { name: 'Download with these fields empty' })).toBeTruthy();
    expect(learn).toHaveBeenCalledTimes(1);
    expect(api.learn).not.toHaveBeenCalled();
  });

  it('a free result with nothing left: no panel, no AI button - it is saved at once', async () => {
    const { api } = setup({ learn: async () => learnResult({ path: 'local' }) });
    await learnFree();
    expect(screen.queryByTestId('deep-panel')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Finish with AI' })).toBeNull();
    await waitFor(() => expect((screen.getByRole('button', { name: 'Add source' }) as HTMLButtonElement).disabled).toBe(false));
    await act(async () => void fireEvent.click(screen.getByRole('button', { name: 'Add source' })));
    await waitFor(() => expect(api.registry.attachSource).toHaveBeenCalledTimes(1));
    expect((api.registry.attachSource.mock.calls[0] as unknown as [string, { learnPath: string }])[1].learnPath).toBe('local');
    expect(api.learn).not.toHaveBeenCalled();
  });

  it('says it in Hebrew', async () => {
    setup({ learn: freeThenAi, lang: 'he' });
    await screen.findByTestId('add-format-columns');
    fireEvent.change(await screen.findByLabelText('דוגמת קלט'), { target: { files: [csv('supplier-b.csv')] } });
    fireEvent.change(await screen.findByLabelText('דוגמת פלט'), { target: { files: [xlsx('load.xlsx')] } });
    const learnHe = (): HTMLButtonElement => screen.getByRole('button', { name: /ללמוד את המקור הזה/ }) as HTMLButtonElement;
    await waitFor(() => expect(learnHe().disabled).toBe(false));
    await act(async () => void fireEvent.click(learnHe()));
    const panel = await screen.findByTestId('deep-panel');
    expect(within(panel).getByRole('heading').textContent).toBe('המנוע החינמי פתר 2 מתוך 4 שדות.');
    expect(within(panel).getByRole('button', { name: 'השלמה עם AI' })).toBeTruthy();
    expect(within(panel).getByText(/עבור מקור של פורמט, הניתוח המעמיק מתחיל מחדש/)).toBeTruthy();
  });
});

describe('from the Result screen\'s Save ("Add as a source" of a result with fields left)', () => {
  it('the Result screen shows no "looks like your format" banner: the question is asked at Save', async () => {
    const NAMES = formatSummary({ id: 'F7', name: 'Names list', outputHeaders: ['Name'], fileType: 'xlsx', outputColumns: 1 });
    const api = fakeApi({ features: { formatSources: true }, user: USER, registry: { listFormats: vi.fn(async () => [NAMES]) } });
    const { engine } = fakeEngine(async () => learnResult({ path: 'local' }));
    renderApp({ engine, api });
    fireEvent.change(screen.getByLabelText('Example input'), { target: { files: [csv('orders.csv')] } });
    fireEvent.change(screen.getByLabelText('Example output'), { target: { files: [csv('Orders report.csv')] } });
    await waitFor(() => expect(screen.getAllByText(/1,204/)).toHaveLength(2));
    await act(async () => void fireEvent.click(screen.getByRole('button', { name: /Learn the format/ })));
    await screen.findByTestId('rules-map');
    await waitFor(() => expect(api.registry.listFormats).toHaveBeenCalled());
    expect(screen.queryByText(/looks like your format/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add as a source' })).toBeNull();
  });

  it('opens Add a source with the same files, and the free learn starts by itself', async () => {
    const NAMES = formatSummary({ id: 'F1', name: 'Supplier price list', outputHeaders: HEADERS, fileType: 'xlsx', outputColumns: 4 });
    const api = fakeApi({ features: { formatSources: true }, user: USER, registry: { listFormats: vi.fn(async () => [NAMES]), getFormat: vi.fn(async () => format), signatures: vi.fn(async () => []) } });
    const { engine, learn } = fakeEngine(async () => partialAttach(), undefined, {
      readHeaders: vi.fn(async ({ file }: { file: { name: string } }) => ({ ok: true, headers: file.name === 'load.xlsx' ? HEADERS : ['Code', 'Name', 'Price'], sheetName: 'S', direction: 'ltr', rows: 3 })),
    });
    renderApp({ engine, api });
    fireEvent.change(screen.getByLabelText('Example input'), { target: { files: [csv('supplier-b.csv')] } });
    fireEvent.change(screen.getByLabelText('Example output'), { target: { files: [xlsx('load.xlsx')] } });
    await waitFor(() => expect(screen.getAllByText(/1,204/)).toHaveLength(2));
    await act(async () => void fireEvent.click(screen.getByRole('button', { name: /Learn the format/ })));
    await screen.findByTestId('rules-map');
    await waitFor(() => expect((screen.getByRole('button', { name: 'Save format' }) as HTMLButtonElement).disabled).toBe(false));
    await act(async () => void fireEvent.click(screen.getByRole('button', { name: 'Save format' })));
    const box = await screen.findByRole('dialog', { name: 'Save this format?' });
    expect(within(box).getByTestId('format-match-question').textContent).toBe('This looks like your format Supplier price list. Add this file as a new source of it?');
    await act(async () => void fireEvent.click(within(box).getByRole('button', { name: 'Add as a source' })));
    // Add a source, with the session's files, learning against the format - the free engine, by itself.
    await waitFor(() => expect(learn).toHaveBeenCalledTimes(2));
    const args = learn.mock.calls[1]![0] as { ai: string; target?: unknown };
    expect(args.ai).toBe('notAllowed');
    expect(args.target).toBeDefined();
    await screen.findByTestId('deep-panel');
    expect(api.learn).not.toHaveBeenCalled();
    expect(api.registry.attachSource).not.toHaveBeenCalled();
  });
});

