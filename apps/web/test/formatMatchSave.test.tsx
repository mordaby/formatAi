// "Update your format X, or save as a new format?" at Save (owner decisions 2026-10-07): the same OUTPUT learned again from the same kind of
// input file (other values) must not make a second format by accident. The first Save of a learn compares the learned output with the user's
// saved formats and, when this input already feeds one, asks once, in the Save popup - with no "source" in it, whatever the feature switch
// says. Another input for a format is asked at Learn (alreadyLearned.test.tsx), never at Save. Nothing matches: no question, one click. With a
// list or an identifier-shaped value to ask about, still ONE dialog: the format question first, the "keep these" lines below. A fake API (the
// user's formats and sources) and a fake worker that runs the engine's own comparison.
import { formatOf } from '@formatai/engine';
import type { FormatSummary, GetFormatResponse, LearnResult, MeUser, Rules, SignatureEntry } from '@formatai/shared';
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
  /** Who is signed in (default: a registered user, `USER`). */
  user?: MeUser;
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
  const api = fakeApi({ user: setup.user ?? USER, registry, features: { formatSources: setup.formatSources ?? true } });
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

describe('the same output from the same input, other values: "Update your format X, or save as a new format?"', () => {
  it('asks once, naming the format and never a source - and "Update X" saves a new version of that input\'s rules (the title text may differ)', async () => {
    const { registry, router } = await openResult({ rules: learned({ title: 'Report for April' }), formats: [MONTHLY()] });
    await press('Save format');
    const box = await screen.findByRole('dialog', { name: 'Save this format?' });
    expect(question()).toBe('Update your format Monthly accounts, or save as a new format?');
    expect(answers()).toEqual(['Update Monthly accounts', 'Save as a new format', 'Cancel']);
    expect(box.textContent).not.toMatch(/source|CRM A/i);
    // (one input: nobody else's file changes)
    expect(box.textContent).not.toMatch(/other input/);
    expect(registry.createFormat).not.toHaveBeenCalled();

    await answer('Update Monthly accounts');
    await waitFor(() => expect(registry.updateConversion).toHaveBeenCalledTimes(1));
    const [id, body] = registry.updateConversion.mock.calls[0] as unknown as [string, { rules: Rules; status: string; baseVersion: number }];
    expect(id).toBe('F1-C1');
    expect(body).toMatchObject({ status: 'verified', baseVersion: 4 });
    expect(body.rules.output.titleRows).toEqual([{ text: 'Report for April' }]);
    expect(registry.createFormat).not.toHaveBeenCalled();
    expect(registry.attachSource).not.toHaveBeenCalled();
    // The screen is now that input's editor: its address, the version saved.
    expect(await screen.findByText('Saved as version 5.')).toBeTruthy();
    await waitFor(() => expect(router.state.location.pathname).toBe('/formats/F1/sources/F1-C1'));
  });

  it('a format with other inputs: says the update changes the format for them too', async () => {
    const two = saved('F1', 'Monthly accounts', learned(), { sources: [{ id: 'F1-C1', sourceId: 'S1', sourceName: 'CRM A', version: 4 }, { id: 'F1-C2', sourceId: 'S7', sourceName: 'CRM B', version: 1 }] });
    await openResult({ rules: learned({ title: 'Report for April' }), formats: [two] });
    await press('Save format');
    expect(within(await screen.findByRole('dialog')).getByText('Updating changes the format for its other input file too.')).toBeTruthy();
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

  it('the format lock\'s problems become reasons, one per kind (what decides the "other input files" note)', () => {
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
});

describe('the same output from another input: nothing is asked at Save (it is asked at Learn, before the learn)', () => {
  it('a learn of its own saves a new format at once - never "Add as a source"', async () => {
    const { registry } = await openResult({ rules: learned({ inputHeaders: ['Acct no', 'Firm'] }), formats: [MONTHLY()] });
    await press('Save format');
    await waitFor(() => expect(registry.createFormat).toHaveBeenCalledTimes(1));
    expect(dialog()).toBeNull();
    expect(registry.attachSource).not.toHaveBeenCalled();
  });
});

describe('several saved formats this input feeds, with this output', () => {
  it('lists them most recently used first, the first one chosen; the answers follow the one chosen', async () => {
    const old = saved('F1', 'Monthly accounts', learned(), { updatedAt: '2026-08-01T10:00:00.000Z' });
    const recent = saved('F2', 'Accounts for the board', learned(), { updatedAt: '2026-08-02T10:00:00.000Z', lastRunAt: '2026-10-01T10:00:00.000Z', sources: [{ id: 'F2-C1', sourceId: 'S1', sourceName: 'CRM A', version: 2 }] });
    const both: SignatureEntry = { ...CRM_A, conversions: [...CRM_A.conversions, { conversionId: 'F2-C1', formatId: 'F2', formatName: 'Accounts for the board', status: 'verified' }] };
    const { registry } = await openResult({ formats: [old, recent], signatures: [both] });
    await press('Save format');
    const box = await screen.findByRole('dialog', { name: 'Save this format?' });
    const group = within(box).getByRole('group', { name: 'This output matches 2 of your formats. Which one do you want to update?' });
    const radios = within(group).getAllByRole('radio') as HTMLInputElement[];
    expect([...group.querySelectorAll('[data-format]')].map((o) => [o.getAttribute('data-format'), o.textContent])).toEqual([
      ['F2', 'Accounts for the board'],
      ['F1', 'Monthly accounts'],
    ]);
    expect(radios[0]!.checked).toBe(true);
    expect(answers()).toEqual(['Update Accounts for the board', 'Save as a new format', 'Cancel']);
    await act(async () => void fireEvent.click(radios[1]!));
    expect(answers()).toEqual(['Update Monthly accounts', 'Save as a new format', 'Cancel']);
    await answer('Update Monthly accounts');
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
    expect(question()).toBe('Update your format Monthly accounts, or save as a new format?');
    const keep = within(box).getByTestId('format-match-keep');
    expect(keep.querySelector('p')!.textContent).toBe('Target customer keeps an ID number in its rules.');
    const group = within(keep).getByRole('group', { name: 'Keep it in the saved format?' });
    expect(within(group).getAllByRole('radio').map((r) => (r as HTMLInputElement).checked)).toEqual([false, false]);
    // Nothing chosen for the user: the save waits for the answer.
    expect(button('Update Monthly accounts').disabled).toBe(true);
    expect(button('Save as a new format').disabled).toBe(true);
    expect(within(box).getByText('Answer the question above to save.')).toBeTruthy();
    expect(box.textContent).not.toContain(ID);

    await act(async () => void fireEvent.click(within(group).getByLabelText('Save without it')));
    await answer('Update Monthly accounts');
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
  it('says the question and the answers in Hebrew', async () => {
    await openResult({ formats: [MONTHLY()], lang: 'he' });
    await press('שמירת הפורמט');
    const box = await screen.findByRole('dialog', { name: 'לשמור את הפורמט?' });
    expect(question()).toBe('לעדכן את הפורמט שלכם Monthly accounts, או לשמור כפורמט חדש?');
    expect(answers()).toEqual(['עדכון Monthly accounts', 'שמירה כפורמט חדש', 'ביטול']);
    expect(box.querySelector('bdi')?.textContent).toBe('Monthly accounts');
  });

  it('the note for the format\'s other input files', async () => {
    const two = saved('F1', 'Monthly accounts', learned(), { sources: [{ id: 'F1-C1', sourceId: 'S1', sourceName: 'CRM A', version: 4 }, { id: 'F1-C2', sourceId: 'S7', sourceName: 'CRM B', version: 1 }] });
    await openResult({ rules: learned({ title: 'Report for April' }), formats: [two], lang: 'he' });
    await press('שמירת הפורמט');
    expect(within(await screen.findByRole('dialog')).getByText('העדכון משנה את הפורמט גם עבור קובץ הקלט האחר שלו.')).toBeTruthy();
  });
});

describe('"Formats with several sources" switched off (the MVP): the update question is asked all the same', () => {
  it('the same input, other values: "Update your format X?" - and an update', async () => {
    const { registry } = await openResult({ formats: [MONTHLY()], formatSources: false });
    await press('Save format');
    await screen.findByRole('dialog', { name: 'Save this format?' });
    expect(question()).toBe('Update your format Monthly accounts, or save as a new format?');
    await answer('Update Monthly accounts');
    await waitFor(() => expect(registry.updateConversion).toHaveBeenCalledTimes(1));
    expect(registry.attachSource).not.toHaveBeenCalled();
  });

  it('another input: no question at Save, a new format at once', async () => {
    const { registry } = await openResult({ rules: learned({ inputHeaders: ['Acct no', 'Firm'] }), formats: [MONTHLY()], formatSources: false, lang: 'he' });
    await press('שמירת הפורמט');
    await waitFor(() => expect(registry.createFormat).toHaveBeenCalledTimes(1));
    expect(dialog()).toBeNull();
  });

  it('a list to ask about is still asked, in the Save popup as before (with no format question)', async () => {
    const { registry } = await openResult({ rules: learned({ target: true, inputHeaders: ['Acct no', 'Firm'] }), formats: [saved('F1', 'Monthly accounts', learned({ target: true }))], formatSources: false });
    await press('Save format');
    const box = await screen.findByRole('dialog', { name: 'Save this format?' });
    expect(within(box).queryByTestId('format-match-question')).toBeNull();
    expect(within(box).getByTestId('copied-list-dialog')).toBeTruthy();
    await answer('Keep it');
    await waitFor(() => expect(registry.createFormat).toHaveBeenCalledTimes(1));
    expect(registry.attachSource).not.toHaveBeenCalled();
  });
});
