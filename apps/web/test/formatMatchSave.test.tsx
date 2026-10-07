// "Is this one of your formats?" at Save (owner decision 2026-10-07): learning the same OUTPUT again must not make a second format. The
// first Save of a learn compares the learned output with the user's saved formats - by the output only - and, when one matches, asks once, in
// the Save popup: update the rules of the source the file comes from, add the file as a new source of the format (when the format lock
// allows it), or save a new format. Nothing matches: no question, one click. With a list or an identifier-shaped value to ask about, still
// ONE dialog: the format question first, the "keep these" lines below. A fake API (the user's formats and sources) and a fake worker that runs
// the engine's own comparison.
import { formatOf } from '@formatai/engine';
import type { FormatSummary, GetFormatResponse, LearnResult, Rules, SignatureEntry } from '@formatai/shared';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryPendingStore, setPendingStore } from '../src/app/pendingLearn';
import { resumeLeaveGuard } from '../src/app/unloadPrompt';
import { candidateSummaries, lockReasons } from '../src/pages/Result/useFormatMatch';
import type { LearnOutput } from '../src/worker/engineApi';
import { conversionSummary, createFormatResponse, formatSummary } from './helpers/registryKit';
import { csv, fakeApi, fakeEngine, learnResult, liveResult, renderApp, USER } from './helpers/renderApp';

vi.mock('../src/app/redirect', () => ({ redirectTo: vi.fn() }));

beforeEach(() => {
  document.cookie = 'lang=; Path=/; Max-Age=0';
  setPendingStore(createMemoryPendingStore());
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  setPendingStore(undefined);
  resumeLeaveGuard();
});

const ID = '039337423';
const ROWS = 12;

/** A learned (or saved) rules file: Account and Company, read from `inputHeaders`; with `target`, a column whose label is an ID number. */
function learned(opts: { inputHeaders?: [string, string]; outputHeaders?: string[]; title?: string; target?: boolean } = {}): LearnResult {
  const [account, company] = opts.inputHeaders ?? ['Account', 'Company'];
  const headers = opts.outputHeaders ?? ['Account', 'Company'];
  return {
    schemaVersion: 1,
    input: {
      sheet: { pick: 'first' },
      headerRow: 'auto',
      columns: [
        { id: 'account', header: account, type: 'text' },
        { id: 'company', header: company, type: 'text' },
      ],
    },
    transform: {
      computed: opts.target ? [{ id: 'target', type: 'text', expr: { op: 'if', cond: { op: 'eq', args: [{ col: 'company' }, { const: 'Acme' }] }, then: { const: ID }, else: { const: '' } } }] : [],
      valueMaps: [],
      sort: [],
    },
    output: {
      file: { type: 'xlsx' },
      sheetName: 'Accounts',
      direction: 'ltr',
      language: 'en',
      titleRows: [{ text: opts.title ?? 'Report for March' }],
      columns: [{ header: headers[0]!, from: 'account' }, { header: headers[1]!, from: 'company' }, ...(opts.target ? [{ header: 'Target customer', from: 'target' }] : [])],
    },
    validations: [],
    unsupported: [],
    assumptions: [],
  };
}

/** A saved format as the API gives it: its summary in the list, and its detail with its sources. */
function saved(id: string, name: string, rules: LearnResult, opts: { sources?: { id: string; sourceId: string; sourceName: string; version: number }[]; updatedAt?: string; lastRunAt?: string } = {}) {
  const f = formatOf(rules);
  const summary: FormatSummary = formatSummary({
    id,
    name,
    fileType: 'xlsx',
    outputHeaders: f.output.columns.map((c) => c.header),
    outputColumns: f.output.columns.length,
    updatedAt: opts.updatedAt ?? '2026-09-01T10:00:00.000Z',
    ...(opts.lastRunAt ? { lastRunAt: opts.lastRunAt } : {}),
  });
  const conversions = (opts.sources ?? [{ id: `${id}-C1`, sourceId: 'S1', sourceName: 'CRM A', version: 4 }]).map((s) => conversionSummary({ id: s.id, formatId: id, sourceId: s.sourceId, sourceName: s.sourceName, version: s.version }));
  const detail: GetFormatResponse = { format: { ...summary, sources: conversions.length, output: f.output, layout: f.layout, outputValidations: f.outputValidations }, conversions };
  return { summary, detail };
}

/** CRM A: the source of the saved format's first conversion (Account, Company). */
const CRM_A: SignatureEntry = {
  sourceId: 'S1',
  name: 'CRM A',
  columns: [
    { header: 'Account', aliases: [], type: 'text', required: true },
    { header: 'Company', aliases: [], type: 'text', required: true },
  ],
  conversions: [{ conversionId: 'F1-C1', formatId: 'F1', formatName: 'Monthly accounts', status: 'verified' }],
};

function live(rules: LearnResult | Rules) {
  const headers = rules.output.columns.filter((c) => c.from !== null).map((c) => c.header);
  return liveResult({ verified: true, matched: ROWS, total: ROWS, differences: 0, perColumn: headers.map((header) => ({ header, inExample: true, matched: ROWS, total: ROWS })), checkedInputRows: ROWS, totalInputRows: ROWS });
}

interface Setup {
  rules?: LearnResult;
  formats?: ReturnType<typeof saved>[];
  signatures?: SignatureEntry[];
  lang?: 'en' | 'he';
  /** The free engine's own result with fields missing (`path: 'partial'`). */
  partial?: boolean;
  /** The feature switch "Formats with several sources" (default on here: this file is about what it shows). */
  formatSources?: boolean;
}

/** Learns (a fake worker) and opens the Result screen of a signed-in user who has `formats`. */
async function openResult(setup: Setup = {}) {
  const rules = setup.rules ?? learned();
  const formats = setup.formats ?? [];
  const result: LearnOutput = learnResult({
    path: setup.partial ? 'partial' : 'local',
    rules,
    exampleId: 'ex1',
    verification: { verified: true, matched: ROWS, total: ROWS, mismatches: [], layoutProblems: [], layoutIssues: [], repairProblems: [] },
    ...(setup.partial ? { partial: { reason: 'aiNotAllowed', solved: ['Account'], needsAi: ['Company'], external: [], solvedColumns: [0], needsAiParts: [] } } : {}),
  });
  const liveCheck = vi.fn(async (_id: string, r: LearnResult | Rules) => live(r));
  const fake = fakeEngine(async () => result, undefined, { liveCheck, fullCheck: liveCheck });
  const registry = {
    listFormats: vi.fn(async () => formats.map((f) => f.summary)),
    getFormat: vi.fn(async (id: string) => formats.find((f) => f.summary.id === id)!.detail),
    signatures: vi.fn(async () => setup.signatures ?? [CRM_A]),
    createFormat: vi.fn(async () => createFormatResponse({ format: formatSummary({ id: 'F9', name: 'accounts' }), conversion: conversionSummary({ id: 'C9', formatId: 'F9', version: 1 }) })),
    updateConversion: vi.fn(async (id: string, body: { baseVersion?: number }) => ({ conversion: conversionSummary({ id, formatId: 'F1', version: (body.baseVersion ?? 0) + 1 }), formatChanged: true, affectedSources: 0, needsReview: [] })),
    attachSource: vi.fn(async (formatId: string) => ({ conversion: conversionSummary({ id: 'C2', formatId, sourceId: 'S2', sourceName: 'accounts', version: 1 }), source: { id: 'S2', name: 'accounts', formats: 1 } })),
  };
  const api = fakeApi({ user: USER, registry, features: { formatSources: setup.formatSources ?? true } });
  const view = renderApp({ engine: fake.engine, api, lang: setup.lang ?? 'en', dataRouter: true });
  const en = (setup.lang ?? 'en') === 'en';
  fireEvent.change(screen.getByLabelText(en ? 'Example input' : 'דוגמת קלט'), { target: { files: [csv('accounts.csv')] } });
  fireEvent.change(screen.getByLabelText(en ? 'Example output' : 'דוגמת פלט'), { target: { files: [csv('Monthly accounts.csv')] } });
  await waitFor(() => expect(screen.getAllByText(/1,204/)).toHaveLength(2));
  const learnButton = screen.getByRole('button', { name: en ? /Learn the format/ : /ללמוד את הפורמט/ }) as HTMLButtonElement;
  await waitFor(() => expect(learnButton.disabled).toBe(false));
  await act(async () => void fireEvent.click(learnButton));
  await screen.findByTestId('rules-map');
  await waitFor(() => expect(liveCheck).toHaveBeenCalled());
  if (setup.formatSources !== false) await waitFor(() => expect(registry.listFormats).toHaveBeenCalled());
  return { ...fake, api, registry, router: view.router! };
}

const button = (name: string): HTMLButtonElement => screen.getByRole('button', { name }) as HTMLButtonElement;
async function press(name: string): Promise<void> {
  await waitFor(() => expect(button(name).disabled).toBe(false));
  await act(async () => void fireEvent.click(button(name)));
}
const dialog = (): HTMLElement | null => screen.queryByRole('dialog');
const answer = async (name: string): Promise<void> => {
  await act(async () => void fireEvent.click(within(dialog()!).getByRole('button', { name })));
};
const answers = (): string[] => within(dialog()!).getAllByRole('button').map((b) => b.textContent ?? '').slice(1);
const question = (): string => within(dialog()!).getByTestId('format-match-question').textContent ?? '';
const bodyOf = (mock: ReturnType<typeof vi.fn>): { rules: Rules; [k: string]: unknown } => (mock.mock.calls[0] as unknown[]).at(-1) as { rules: Rules };

const MONTHLY = () => saved('F1', 'Monthly accounts', learned());

describe('no saved format with this output: Save works as before', () => {
  it('another output: no question, one click, and no format is read in full', async () => {
    const other = saved('F1', 'Monthly accounts', learned({ outputHeaders: ['Account', 'Client'] }));
    const { registry } = await openResult({ formats: [other] });
    await press('Save format');
    await waitFor(() => expect(registry.createFormat).toHaveBeenCalledTimes(1));
    expect(dialog()).toBeNull();
    expect(registry.getFormat).not.toHaveBeenCalled();
    expect(registry.signatures).not.toHaveBeenCalled();
    expect(await screen.findByText('Saved. "Monthly accounts" is in My formats.')).toBeTruthy();
  });

  it('a renamed output column is not the same format (nor another file type, nor a column more)', () => {
    const rules = learned();
    const list = [
      saved('F1', 'Renamed', learned({ outputHeaders: ['Account', 'Client'] })).summary,
      { ...saved('F2', 'A csv', learned()).summary, fileType: 'csv' },
      saved('F3', 'Wider', learned({ target: true })).summary,
      saved('F4', 'Spaced', learned({ outputHeaders: [' Account ', 'Company'] })).summary,
    ];
    expect(candidateSummaries(list, rules).map((f) => f.id)).toEqual(['F4']);
  });

  it('a visitor is asked to sign in, and nothing is read', async () => {
    const listFormats = vi.fn(async () => [MONTHLY().summary]);
    const fake = fakeEngine(async () => learnResult({ rules: learned(), exampleId: 'ex1' }));
    renderApp({ engine: fake.engine, api: fakeApi({ registry: { listFormats }, features: { formatSources: true } }), dataRouter: true });
    fireEvent.change(screen.getByLabelText('Example input'), { target: { files: [csv('accounts.csv')] } });
    fireEvent.change(screen.getByLabelText('Example output'), { target: { files: [csv('Monthly accounts.csv')] } });
    await waitFor(() => expect(screen.getAllByText(/1,204/)).toHaveLength(2));
    await act(async () => void fireEvent.click(screen.getByRole('button', { name: /Learn the format/ })));
    await screen.findByTestId('rules-map');
    await press('Save format');
    expect(await screen.findByRole('dialog', { name: 'Sign in' })).toBeTruthy();
    expect(listFormats).not.toHaveBeenCalled();
  });
});

describe('the same output from the same source: update its rules', () => {
  it('asks once - the format and the source by name - and "Update its rules" saves a new version of that source (the title text may differ)', async () => {
    const { registry, router } = await openResult({ rules: learned({ title: 'Report for April' }), formats: [MONTHLY()] });
    await press('Save format');
    const box = await screen.findByRole('dialog', { name: 'Save this format?' });
    expect(question()).toBe('This is your format Monthly accounts, from CRM A. Update its rules, or save as a new format?');
    expect(answers()).toEqual(['Update its rules', 'Save as a new format', 'Cancel']);
    // (one source: nobody else's format changes)
    expect(box.textContent).not.toMatch(/other source/);
    expect(registry.createFormat).not.toHaveBeenCalled();

    await answer('Update its rules');
    await waitFor(() => expect(registry.updateConversion).toHaveBeenCalledTimes(1));
    const [id, body] = registry.updateConversion.mock.calls[0] as unknown as [string, { rules: Rules; status: string; baseVersion: number }];
    expect(id).toBe('F1-C1');
    expect(body).toMatchObject({ status: 'verified', baseVersion: 4 });
    expect(body.rules.output.titleRows).toEqual([{ text: 'Report for April' }]);
    expect(registry.createFormat).not.toHaveBeenCalled();
    expect(registry.attachSource).not.toHaveBeenCalled();
    // The screen is now that source's editor: its address, its name, the version saved.
    expect(await screen.findByText('Saved as version 5.')).toBeTruthy();
    await waitFor(() => expect(router.state.location.pathname).toBe('/formats/F1/sources/F1-C1'));
    expect(screen.getByText('A source of "Monthly accounts". We do not keep your files.')).toBeTruthy();
  });

  it('a format with other sources: says the update changes the format for them too', async () => {
    const two = saved('F1', 'Monthly accounts', learned(), { sources: [{ id: 'F1-C1', sourceId: 'S1', sourceName: 'CRM A', version: 4 }, { id: 'F1-C2', sourceId: 'S7', sourceName: 'CRM B', version: 1 }] });
    await openResult({ rules: learned({ title: 'Report for April' }), formats: [two] });
    await press('Save format');
    expect(within(await screen.findByRole('dialog')).getByText('Updating changes the format for its other source too.')).toBeTruthy();
  });

  it('"Save as a new format" saves a new format, and "Cancel" saves nothing', async () => {
    const { registry } = await openResult({ formats: [MONTHLY()] });
    await press('Save format');
    await answer('Cancel');
    expect(dialog()).toBeNull();
    expect(registry.createFormat).not.toHaveBeenCalled();
    expect(registry.updateConversion).not.toHaveBeenCalled();
    await press('Save format');
    await answer('Save as a new format');
    await waitFor(() => expect(registry.createFormat).toHaveBeenCalledTimes(1));
    expect(registry.updateConversion).not.toHaveBeenCalled();
  });
});

describe('the same output from another input: add it as a new source', () => {
  const OTHER_INPUT = () => learned({ inputHeaders: ['Acct no', 'Firm'] });

  it('"Add as a source" adds the learned rules to the format as they are (the format lock holds)', async () => {
    const { registry, router } = await openResult({ rules: OTHER_INPUT(), formats: [MONTHLY()] });
    await press('Save format');
    await screen.findByRole('dialog', { name: 'Save this format?' });
    expect(question()).toBe('This looks like your format Monthly accounts. Add this file as a new source of it?');
    expect(answers()).toEqual(['Add as a source', 'Save as a new format', 'Cancel']);
    await answer('Add as a source');
    await waitFor(() => expect(registry.attachSource).toHaveBeenCalledTimes(1));
    const [formatId, body] = registry.attachSource.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(formatId).toBe('F1');
    expect(body).toMatchObject({ status: 'verified', learnPath: 'local', suggestedSourceName: 'accounts', rules: OTHER_INPUT() });
    expect(body).not.toHaveProperty('name');
    expect(await screen.findByText('Added "accounts" to "Monthly accounts".')).toBeTruthy();
    await waitFor(() => expect(router.state.location.pathname).toBe('/formats/F1/sources/C2'));
    expect(registry.createFormat).not.toHaveBeenCalled();
  });

  it('rules that break the format lock are not added: it says why, and offers only a new format (the title text still matches the format)', async () => {
    const { registry } = await openResult({ rules: learned({ inputHeaders: ['Acct no', 'Firm'], title: 'Report for April' }), formats: [MONTHLY()] });
    await press('Save format');
    await screen.findByRole('dialog', { name: 'Save this format?' });
    expect(question()).toBe("This looks like your format Monthly accounts, but this file can't be added as a source of it: the title rows differ.");
    expect(answers()).toEqual(['Save as a new format', 'Cancel']);
    await answer('Save as a new format');
    await waitFor(() => expect(registry.createFormat).toHaveBeenCalledTimes(1));
    expect(registry.attachSource).not.toHaveBeenCalled();
  });

  it('a csv output named after another file is still added: its "sheet" is not in the file, and the format\'s is saved', async () => {
    const csvOf = (sheetName: string, inputHeaders?: [string, string]): LearnResult => {
      const r = learned(inputHeaders ? { inputHeaders } : {});
      return { ...r, output: { ...r.output, file: { type: 'csv' }, sheetName } };
    };
    const monthly = saved('F1', 'Monthly accounts', csvOf('accounts 2026-09'));
    const { registry } = await openResult({ rules: csvOf('accounts 2026-10', ['Acct no', 'Firm']), formats: [{ ...monthly, summary: { ...monthly.summary, fileType: 'csv' } }] });
    await press('Save format');
    await screen.findByRole('dialog', { name: 'Save this format?' });
    expect(question()).toBe('This looks like your format Monthly accounts. Add this file as a new source of it?');
    await answer('Add as a source');
    await waitFor(() => expect(registry.attachSource).toHaveBeenCalledTimes(1));
    expect(bodyOf(registry.attachSource).rules.output.sheetName).toBe('accounts 2026-09');
  });

  it('the reasons are said in words, one per kind', () => {
    expect(
      lockReasons(
        [
          { kind: 'formatMismatch', path: 'output.columns[1].format', message: '' },
          { kind: 'formatMismatch', path: 'output.columns[0].width', message: '' },
          { kind: 'formatMismatch', path: 'output.columns[1].width', message: '' },
          { kind: 'formatMismatch', path: 'layout.sort[0]', message: '' },
          { kind: 'formatMismatch', path: 'validations', message: '' },
        ],
        ['Account', 'Company'],
      ),
    ).toEqual([{ kind: 'numberFormat', column: 'Company' }, { kind: 'width' }, { kind: 'sort' }, { kind: 'checks' }]);
  });

  it('a free result with fields missing is not added as it is: "Add as a source" opens Add a source with the same files', async () => {
    const rules = OTHER_INPUT();
    rules.output.columns[1]!.from = null;
    const { registry, router } = await openResult({ rules, formats: [MONTHLY()], partial: true });
    await press('Save format');
    await screen.findByRole('dialog', { name: 'Save this format?' });
    await answer('Add as a source');
    await waitFor(() => expect(router.state.location.pathname).toBe('/formats/F1/add-source'));
    expect(registry.attachSource).not.toHaveBeenCalled();
    expect(router.state.location.state).toEqual({ fromSession: true });
  });
});

describe('several saved formats with this output', () => {
  it('lists them most recently used first, the first one chosen; the answers follow the one chosen', async () => {
    const old = saved('F1', 'Monthly accounts', learned(), { updatedAt: '2026-08-01T10:00:00.000Z' });
    const recent = saved('F2', 'Accounts for the board', learned(), { updatedAt: '2026-08-02T10:00:00.000Z', lastRunAt: '2026-10-01T10:00:00.000Z', sources: [{ id: 'F2-C1', sourceId: 'S5', sourceName: 'ERP', version: 2 }] });
    const { registry } = await openResult({ formats: [old, recent] });
    await press('Save format');
    const box = await screen.findByRole('dialog', { name: 'Save this format?' });
    const group = within(box).getByRole('group', { name: 'This output looks like 2 of your formats. Which one is it?' });
    const radios = within(group).getAllByRole('radio') as HTMLInputElement[];
    expect([...group.querySelectorAll('[data-format]')].map((o) => [o.getAttribute('data-format'), o.textContent])).toEqual([
      ['F2', 'Accounts for the boardAdd this file as a new source of it'],
      ['F1', 'Monthly accountsFrom your source CRM A: update its rules'],
    ]);
    expect(radios[0]!.checked).toBe(true);
    expect(answers()).toEqual(['Add as a source', 'Save as a new format', 'Cancel']);
    await act(async () => void fireEvent.click(radios[1]!));
    expect(answers()).toEqual(['Update its rules', 'Save as a new format', 'Cancel']);
    await answer('Update its rules');
    await waitFor(() => expect(registry.updateConversion).toHaveBeenCalledTimes(1));
    expect(registry.updateConversion.mock.calls[0]![0]).toBe('F1-C1');
  });
});

describe('with a list or an identifier-shaped value too: still one dialog', () => {
  it('the format question first, the "keep" question below; the save waits for the keep answer, then goes where it was told', async () => {
    const withId = () => learned({ target: true });
    const { registry } = await openResult({ rules: withId(), formats: [saved('F1', 'Monthly accounts', withId())] });
    await press('Save format');
    const box = await screen.findByRole('dialog', { name: 'Save this format?' });
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(question()).toBe('This is your format Monthly accounts, from CRM A. Update its rules, or save as a new format?');
    const keep = within(box).getByTestId('format-match-keep');
    expect(keep.querySelector('p')!.textContent).toBe('Target customer keeps an ID number in its rules.');
    const group = within(keep).getByRole('group', { name: 'Keep it in the saved format?' });
    expect(within(group).getAllByRole('radio').map((r) => (r as HTMLInputElement).checked)).toEqual([false, false]);
    // Nothing chosen for the user: the save waits for the answer.
    expect(button('Update its rules').disabled).toBe(true);
    expect(button('Save as a new format').disabled).toBe(true);
    expect(within(box).getByText('Answer the question above to save.')).toBeTruthy();
    expect(box.textContent).not.toContain(ID);

    await act(async () => void fireEvent.click(within(group).getByLabelText('Save without it')));
    await answer('Update its rules');
    await waitFor(() => expect(registry.updateConversion).toHaveBeenCalledTimes(1));
    const sent = bodyOf(registry.updateConversion);
    expect(JSON.stringify(sent.rules)).not.toContain(ID);
    expect(sent.rules.output.columns.find((c) => c.header === 'Target customer')?.from).toBeNull();
    expect(dialog()).toBeNull();
  });

  it('"Keep it" with "Save as a new format" saves the value as it is', async () => {
    const withId = () => learned({ target: true });
    const { registry } = await openResult({ rules: withId(), formats: [saved('F1', 'Monthly accounts', withId())] });
    await press('Save format');
    await screen.findByRole('dialog');
    await act(async () => void fireEvent.click(screen.getByLabelText('Keep it')));
    await answer('Save as a new format');
    await waitFor(() => expect(registry.createFormat).toHaveBeenCalledTimes(1));
    expect(JSON.stringify(bodyOf(registry.createFormat).rules)).toContain(ID);
  });
});

describe('in Hebrew', () => {
  it('says the question, the reasons and the answers in Hebrew', async () => {
    await openResult({ rules: learned({ inputHeaders: ['Acct no', 'Firm'] }), formats: [MONTHLY()], lang: 'he' });
    await press('שמירת הפורמט');
    const box = await screen.findByRole('dialog', { name: 'לשמור את הפורמט?' });
    expect(question()).toBe('זה נראה כמו הפורמט שלכם Monthly accounts. להוסיף את הקובץ הזה כמקור חדש שלו?');
    expect(answers()).toEqual(['הוספה כמקור', 'שמירה כפורמט חדש', 'ביטול']);
    expect(box.querySelector('bdi')?.textContent).toBe('Monthly accounts');
  });

  it('a lock that stops the source, and an update, in Hebrew', async () => {
    await openResult({ rules: learned({ inputHeaders: ['Acct no', 'Firm'], title: 'Report for April' }), formats: [MONTHLY()], lang: 'he' });
    await press('שמירת הפורמט');
    await screen.findByRole('dialog');
    expect(question()).toBe('זה נראה כמו הפורמט שלכם Monthly accounts, אבל אי אפשר להוסיף את הקובץ הזה כמקור שלו: שורות הכותרת שונות.');
    expect(answers()).toEqual(['שמירה כפורמט חדש', 'ביטול']);
    cleanup();
    await openResult({ formats: [MONTHLY()], lang: 'he' });
    await press('שמירת הפורמט');
    await screen.findByRole('dialog');
    expect(question()).toBe('זה הפורמט שלכם Monthly accounts, מהמקור CRM A. לעדכן את הכללים שלו, או לשמור כפורמט חדש?');
    expect(answers()).toEqual(['עדכון הכללים שלו', 'שמירה כפורמט חדש', 'ביטול']);
  });
});

describe('"Formats with several sources" switched off (the MVP): Save never asks', () => {
  it('the same output as a saved format: no question, one click, a new format - and no format or source is read', async () => {
    const { registry } = await openResult({ formats: [MONTHLY()], formatSources: false });
    await press('Save format');
    await waitFor(() => expect(registry.createFormat).toHaveBeenCalledTimes(1));
    expect(dialog()).toBeNull();
    expect(registry.getFormat).not.toHaveBeenCalled();
    expect(registry.signatures).not.toHaveBeenCalled();
    expect(registry.updateConversion).not.toHaveBeenCalled();
    expect(registry.attachSource).not.toHaveBeenCalled();
    expect(await screen.findByText('Saved. "Monthly accounts" is in My formats.')).toBeTruthy();
  });

  it('from another input too (never "Add as a source"), and in Hebrew', async () => {
    const { registry } = await openResult({ rules: learned({ inputHeaders: ['Acct no', 'Firm'] }), formats: [MONTHLY()], formatSources: false, lang: 'he' });
    await press('שמירת הפורמט');
    await waitFor(() => expect(registry.createFormat).toHaveBeenCalledTimes(1));
    expect(dialog()).toBeNull();
    expect(registry.attachSource).not.toHaveBeenCalled();
  });

  it('a list to ask about is still asked, in the Save popup as before (with no format question)', async () => {
    const { registry } = await openResult({ rules: learned({ target: true }), formats: [saved('F1', 'Monthly accounts', learned({ target: true }))], formatSources: false });
    await press('Save format');
    const box = await screen.findByRole('dialog', { name: 'Save this format?' });
    expect(within(box).queryByTestId('format-match-question')).toBeNull();
    expect(within(box).getByTestId('copied-list-dialog')).toBeTruthy();
    await answer('Keep it');
    await waitFor(() => expect(registry.createFormat).toHaveBeenCalledTimes(1));
    expect(registry.attachSource).not.toHaveBeenCalled();
  });
});
