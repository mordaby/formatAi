// What the user already has, checked at Learn (owner decisions 2026-10-07, SPEC 5 A step 2): a signed-in user with saved formats starts a
// learn on Home; before anything is learned, the worker looks for a saved format with this output.
//   - From this input, and its saved rules make the example: "You already have this format" / "Your format X already makes this output from
//     this file." with [Convert files with it] [Learn again anyway] [Choose other files] - and no learn request is sent.
//   - From this input, other values: the learn goes on, the result says so, and Save asks "Update your format X, or save as a new format?".
//   - Not from this input: "This output matches your format" - "Is this file another input for it?" [Yes, learn it for X] [No, make a new
//     format] [Choose other files]; yes is the learn for that format, saved into it with no further question.
// A fake worker that answers as the engine does (`knownMatches`, the real one); a fake API.
import { formatOf, knownMatches, type ExampleShape, type KnownPair } from '@formatai/engine';
import type { FormatSummary, GetFormatResponse, LearnResult, MeUser, SignatureEntry } from '@formatai/shared';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryPendingStore, setPendingStore } from '../src/app/pendingLearn';
import { resumeLeaveGuard } from '../src/app/unloadPrompt';
import type { LearnArgs, LearnHost, LearnOutput } from '../src/worker/engineApi';
import { entry, fakeConvertApi } from './helpers/convertKit';
import { conversionDetail, conversionSummary, createFormatResponse, formatSummary } from './helpers/registryKit';
import { csv, fakeApi, fakeEngine, learnResult, liveResult, renderApp, tracked, USER } from './helpers/renderApp';

vi.mock('../src/app/redirect', () => ({ redirectTo: vi.fn() }));
// The Run screen's own API (GET /api/signatures and the rest): a fake, so "Convert files with it" can be followed there.
const convert = vi.hoisted(() => ({ api: null as unknown }));
vi.mock('../src/api/convert', async (original) => ({ ...(await original<typeof import('../src/api/convert')>()), useConvertApi: () => convert.api }));

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

const ROWS = 12;

/** The rules of the example: Account and Company copied. */
function rules(): LearnResult {
  return {
    schemaVersion: 1,
    input: {
      sheet: { pick: 'first' },
      headerRow: 'auto',
      columns: [
        { id: 'account', header: 'Account', type: 'text' },
        { id: 'company', header: 'Company', type: 'text' },
      ],
    },
    transform: { computed: [], valueMaps: [], sort: [] },
    output: { file: { type: 'xlsx' }, sheetName: 'Accounts', direction: 'ltr', language: 'en', titleRows: [], columns: [{ header: 'Account', from: 'account' }, { header: 'Company', from: 'company' }] },
    validations: [],
    unsupported: [],
    assumptions: [],
  };
}

/** The example as the worker reads it (headers and file kind only). */
const SHAPE: ExampleShape = { outputHeaders: ['Account', 'Company'], fileType: 'xlsx', headerRow: true, titleRows: [], summaryRows: 0, groupBy: null, inputHeaders: ['Account', 'Company'] };

/** A saved format with this output: its conversion `${id}-C1` from source S1 (CRM A), and `more` conversions from other sources. */
function saved(id: string, name: string, updatedAt = '2026-09-01T10:00:00.000Z', more = 0) {
  const f = formatOf(rules());
  const summary: FormatSummary = formatSummary({ id, name, fileType: 'xlsx', outputHeaders: ['Account', 'Company'], outputColumns: 2, updatedAt, sources: 1 + more });
  const conversions = [
    conversionSummary({ id: `${id}-C1`, formatId: id, sourceId: 'S1', sourceName: 'CRM A', version: 4 }),
    ...Array.from({ length: more }, (_, i) => conversionSummary({ id: `${id}-C${i + 2}`, formatId: id, sourceId: `S${i + 20}`, sourceName: `Other ${i + 2}`, version: 1 })),
  ];
  const detail: GetFormatResponse = { format: { ...summary, output: f.output, layout: f.layout, outputValidations: f.outputValidations }, conversions };
  return { summary, detail };
}

/** CRM A: the example input's own headers - the example is one of its files. */
const CRM_A: SignatureEntry = {
  sourceId: 'S1',
  name: 'CRM A',
  columns: [
    { header: 'Account', aliases: [], type: 'text', required: true },
    { header: 'Company', aliases: [], type: 'text', required: true },
  ],
  conversions: [
    { conversionId: 'F1-C1', formatId: 'F1', formatName: 'Monthly accounts', status: 'verified' },
    { conversionId: 'F2-C1', formatId: 'F2', formatName: 'Board report', status: 'verified' },
  ],
};
/** Another source: none of the example input's headers. */
const OTHER: SignatureEntry = { ...CRM_A, columns: [{ header: 'Acct no', aliases: [], type: 'text', required: true }, { header: 'Firm', aliases: [], type: 'text', required: true }] };

const RESULT = (): LearnOutput =>
  learnResult({ path: 'local', rules: rules(), exampleId: 'ex1', verification: { verified: true, matched: ROWS, total: ROWS, mismatches: [], layoutProblems: [], layoutIssues: [], repairProblems: [] } });

/**
 * The worker's learn as the engine does it: with `checkKnown`, the candidates from the host, the pairs and the formats with this output that
 * do not take this input (`knownMatches`, the real one), each pair's saved rules from the host - a pair in `makes` makes the example
 * ("known"), the others differ (`knownDiffers`); no pair but formats with this output: "matchesFormat". `result` answers the learn itself.
 */
function worker(makes: ReadonlySet<string>, result: (args: LearnArgs) => LearnOutput = RESULT) {
  return async (host: LearnHost, args: LearnArgs): Promise<LearnOutput> => {
    if (args.checkKnown && host.knownCandidates && host.knownRules) {
      const { pairs, sameOutput } = knownMatches(SHAPE, await host.knownCandidates(SHAPE));
      let differs: KnownPair | undefined;
      for (const pair of pairs) {
        const saved = await host.knownRules(pair.conversionId);
        if (saved && makes.has(pair.conversionId)) return learnResult({ path: 'known', rules: null, known: pair, verification: null });
        differs ??= pair;
      }
      if (differs) return { ...result(args), knownDiffers: differs };
      if (pairs.length === 0 && sameOutput.length > 0) return learnResult({ path: 'matchesFormat', rules: null, sameOutput, verification: null });
    }
    return result(args);
  };
}

interface Setup {
  /** What the learn itself answers (default: the full local result). */
  result?: (args: LearnArgs) => LearnOutput;
  formats?: ReturnType<typeof saved>[];
  signatures?: SignatureEntry[];
  makes?: string[];
  user?: MeUser | null;
  lang?: 'en' | 'he';
  formatSources?: boolean;
}

async function open(setup: Setup = {}) {
  const formats = setup.formats ?? [saved('F1', 'Monthly accounts')];
  const signatures = setup.signatures ?? [CRM_A];
  const registry = {
    listFormats: vi.fn(async () => formats.map((f) => f.summary)),
    getFormat: vi.fn(async (id: string) => formats.find((f) => f.summary.id === id)!.detail),
    signatures: vi.fn(async () => signatures),
    getConversion: vi.fn(async (id: string) => conversionDetail({ id, version: 4, sourceName: 'CRM A' }, rules() as never)),
    createFormat: vi.fn(async () => createFormatResponse({ format: formatSummary({ id: 'F9', name: 'accounts' }), conversion: conversionSummary({ id: 'C9', formatId: 'F9', version: 1 }) })),
    updateConversion: vi.fn(),
    attachSource: vi.fn(async (formatId: string) => ({ conversion: conversionSummary({ id: 'C2', formatId, sourceId: 'S2', sourceName: 'accounts', version: 1 }), source: { id: 'S2', name: 'accounts', formats: 1 } })),
  };
  const user = setup.user === undefined ? USER : setup.user;
  const api = fakeApi({ ...(user ? { user } : {}), registry, features: { formatSources: setup.formatSources ?? true } });
  const liveCheck = vi.fn(async () => liveResult({ verified: true, matched: ROWS, total: ROWS, perColumn: [{ header: 'Account', inExample: true, matched: ROWS, total: ROWS }, { header: 'Company', inExample: true, matched: ROWS, total: ROWS }] }));
  const matchFile = vi.fn(async () => ({ ok: false, reason: 'noMatch' }));
  const fake = fakeEngine(worker(new Set(setup.makes ?? ['F1-C1']), setup.result), undefined, { liveCheck, fullCheck: liveCheck, matchFile });
  convert.api = fakeConvertApi({ user, entries: [entry({ conversionId: 'F1-C1', sourceId: 'S1', sourceName: 'CRM A', formatId: 'F1', formatName: 'Monthly accounts' })] });
  const view = renderApp({ engine: fake.engine, api, lang: setup.lang ?? 'en', dataRouter: true });
  const en = (setup.lang ?? 'en') === 'en';
  if (user) {
    // (a user with saved formats starts from "Run a format": teaching is the other button)
    const teach = await screen.findByRole('button', { name: en ? 'Teach a new format' : /פורמט חדש/ }).catch(() => null);
    if (teach) fireEvent.click(teach);
  }
  fireEvent.change(await screen.findByLabelText(en ? 'Example input' : 'דוגמת קלט'), { target: { files: [csv('accounts.csv')] } });
  fireEvent.change(screen.getByLabelText(en ? 'Example output' : 'דוגמת פלט'), { target: { files: [csv('Monthly accounts.csv')] } });
  await waitFor(() => expect(screen.getAllByText(/1,204/)).toHaveLength(2));
  return { ...fake, api, registry, matchFile, router: view.router! };
}

const learnButton = (name: RegExp): HTMLButtonElement => screen.getByRole('button', { name }) as HTMLButtonElement;
async function press(name: RegExp): Promise<void> {
  await waitFor(() => expect(learnButton(name).disabled).toBe(false));
  await act(async () => void fireEvent.click(learnButton(name)));
}

describe('the saved rules make this example: "You already have this format"', () => {
  it('one clear message, no learn request, nothing saved - from "Learn the format"', async () => {
    const { api, registry, learn, router } = await open();
    await press(/Learn the format/);
    const known = await screen.findByTestId('learning-known');
    expect(within(known).getByRole('heading', { name: 'You already have this format' })).toBeTruthy();
    expect(known.textContent).toContain('Your format Monthly accounts already makes this output from this file.');
    expect(known.querySelector('strong bdi')?.textContent).toBe('Monthly accounts');
    expect(within(known).getAllByRole('button').map((b) => b.textContent)).toEqual(['Convert files with it', 'Learn again anyway', 'Choose other files']);
    // Neutral: a format, never a source.
    expect(known.textContent).not.toMatch(/source|CRM A/i);
    expect(learn).toHaveBeenCalledTimes(1);
    expect((learn.mock.calls[0]![0] as LearnArgs).checkKnown).toBe(true);
    expect(registry.getConversion).toHaveBeenCalledWith('F1-C1', expect.anything());
    expect(api.learn).not.toHaveBeenCalled();
    expect(registry.createFormat).not.toHaveBeenCalled();
    expect(router.state.location.pathname).toBe('/');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('from "Learn with AI" too: no AI format is spent', async () => {
    const { api } = await open();
    await press(/Learn with AI/);
    expect(await screen.findByTestId('learning-known')).toBeTruthy();
    expect(api.learn).not.toHaveBeenCalled();
    expect(api.registry.learnOutcome).not.toHaveBeenCalled();
  });

  it('"Convert files with it" opens that format\'s Run screen with the example input already dropped', async () => {
    const { router, matchFile } = await open();
    await press(/Learn the format/);
    await screen.findByTestId('learning-known');
    await act(async () => void fireEvent.click(screen.getByRole('button', { name: 'Convert files with it' })));
    await waitFor(() => expect(router.state.location.pathname).toBe('/convert'));
    expect(router.state.location.search).toBe('?format=F1');
    await waitFor(() => expect(matchFile).toHaveBeenCalled());
    expect((matchFile.mock.calls[0] as unknown as [{ file: { name: string } }])[0].file.name).toBe('accounts.csv');
  });

  it('"Learn again anyway" learns as asked, without the check, and the result opens', async () => {
    const { learn, router } = await open();
    await press(/Learn the format/);
    await screen.findByTestId('learning-known');
    await act(async () => void fireEvent.click(screen.getByRole('button', { name: 'Learn again anyway' })));
    await screen.findByTestId('rules-map');
    expect(learn).toHaveBeenCalledTimes(2);
    expect((learn.mock.calls[1]![0] as LearnArgs).checkKnown).toBeUndefined();
    expect(router.state.location.pathname).toBe('/result');
    expect(screen.queryByTestId('known-differs')).toBeNull();
  });

  it('says it in Hebrew', async () => {
    await open({ lang: 'he' });
    await press(/ללמוד את הפורמט/);
    const known = await screen.findByTestId('learning-known');
    expect(within(known).getByRole('heading', { name: 'כבר יש לכם את הפורמט הזה' })).toBeTruthy();
    expect(known.textContent).toContain('הפורמט שלכם Monthly accounts כבר מפיק את הפלט הזה מהקובץ הזה.');
    expect(within(known).getAllByRole('button').map((b) => b.textContent)).toEqual(['להמיר קבצים בעזרתו', 'ללמוד מחדש בכל זאת', 'בחירת קבצים אחרים']);
  });

  it('"Choose other files": back to an empty form, the first drop zone focused, nothing learned', async () => {
    const { learn } = await open();
    await press(/Learn the format/);
    await screen.findByTestId('learning-known');
    await act(async () => void fireEvent.click(screen.getByRole('button', { name: 'Choose other files' })));
    const input = await screen.findByLabelText('Example input');
    expect(screen.queryByTestId('learning-known')).toBeNull();
    expect(screen.queryAllByText(/1,204/)).toHaveLength(0);
    await waitFor(() => expect(document.activeElement).toBe(input));
    expect(learn).toHaveBeenCalledTimes(1);
  });

  it('works the same with "Formats with several sources" switched off (it never needs it)', async () => {
    const { api } = await open({ formatSources: false });
    await press(/Learn the format/);
    expect(await screen.findByTestId('learning-known')).toBeTruthy();
    expect(api.learn).not.toHaveBeenCalled();
  });
});

describe('the logic changed: the learn goes on', () => {
  it('the result says so in one line, and Save asks "Update your format X?"', async () => {
    const { registry } = await open({ makes: [] });
    await press(/Learn the format/);
    await screen.findByTestId('rules-map');
    expect(screen.getByTestId('known-differs').textContent).toBe('Your format Monthly accounts gives different values for this example, so the rules were learned again.');
    expect(screen.queryByTestId('learning-known')).toBeNull();
    await waitFor(() => expect((screen.getByRole('button', { name: 'Save format' }) as HTMLButtonElement).disabled).toBe(false));
    await act(async () => void fireEvent.click(screen.getByRole('button', { name: 'Save format' })));
    const box = await screen.findByRole('dialog', { name: 'Save this format?' });
    expect(within(box).getByTestId('format-match-question').textContent).toBe('Update your format Monthly accounts, or save as a new format?');
    expect(within(box).getByRole('button', { name: 'Update Monthly accounts' })).toBeTruthy();
    expect(registry.createFormat).not.toHaveBeenCalled();
  });

  it('says it in Hebrew', async () => {
    await open({ makes: [], lang: 'he' });
    await press(/ללמוד את הפורמט/);
    await screen.findByTestId('rules-map');
    expect(screen.getByTestId('known-differs').textContent).toBe('הפורמט שלכם Monthly accounts נותן ערכים אחרים בדוגמה הזו, ולכן הכללים נלמדו מחדש.');
  });
});

describe('no "already" when the output is not that format\'s', () => {
  it('no saved format with this output: no format or source is read in full', async () => {
    const other = saved('F1', 'Monthly accounts');
    other.summary = { ...other.summary, outputHeaders: ['Account', 'Client'] };
    const { registry } = await open({ formats: [other] });
    await press(/Learn the format/);
    await screen.findByTestId('rules-map');
    expect(registry.getFormat).not.toHaveBeenCalled();
    expect(registry.signatures).not.toHaveBeenCalled();
  });
});

describe('several formats with this output', () => {
  it('each in turn, most recently used first: the first whose rules make the example is named', async () => {
    const formats = [saved('F1', 'Monthly accounts', '2026-09-01T10:00:00.000Z'), saved('F2', 'Board report', '2026-10-01T10:00:00.000Z')];
    const { registry } = await open({ formats, makes: ['F1-C1'] });
    await press(/Learn the format/);
    const known = await screen.findByTestId('learning-known');
    expect(known.textContent).toContain('Your format Monthly accounts already makes this output from this file.');
    expect(registry.getConversion.mock.calls.map((c) => c[0])).toEqual(['F2-C1', 'F1-C1']);
  });
});

describe('a visitor, and a user with no saved formats', () => {
  it('a visitor: no check, no extra work', async () => {
    const { learn, registry } = await open({ user: null });
    await press(/Learn the format/);
    await screen.findByTestId('rules-map');
    expect((learn.mock.calls[0]![0] as LearnArgs).checkKnown).toBeUndefined();
    expect(registry.listFormats).not.toHaveBeenCalled();
    expect(registry.getConversion).not.toHaveBeenCalled();
  });

  it('signed in with no saved format: no check either', async () => {
    const { learn, registry } = await open({ formats: [] });
    await press(/Learn the format/);
    await screen.findByTestId('rules-map');
    expect((learn.mock.calls[0]![0] as LearnArgs).checkKnown).toBeUndefined();
    expect(registry.getFormat).not.toHaveBeenCalled();
  });
});

describe('this output, another input file: "This output matches your format" - asked before anything is learned', () => {
  /** The partial result an attach learn may give: Account built, Company left for the AI step. */
  const partialResult = (): LearnOutput => {
    const r = rules();
    r.output.columns[1]!.from = null;
    return learnResult({
      path: 'partial',
      rules: r,
      exampleId: 'ex1',
      verification: { verified: false, matched: 0, total: ROWS, mismatches: [], layoutProblems: [], layoutIssues: [], repairProblems: [] },
      partial: { reason: 'aiNotAllowed', solved: ['Account'], needsAi: ['Company'], external: [], solvedColumns: [0], needsAiParts: [] },
    });
  };

  it('one question, no "source", three answers - and no learn request, nothing saved', async () => {
    const { api, registry, learn, router } = await open({ signatures: [OTHER] });
    await press(/Learn with AI/);
    const box = await screen.findByTestId('learning-match');
    expect(within(box).getByRole('heading', { name: 'This output matches your format' })).toBeTruthy();
    expect(within(box).getByTestId('learning-match-question').textContent).toBe('This output matches your format Monthly accounts. Is this file another input for it?');
    expect(within(box).getAllByRole('button').map((b) => b.textContent)).toEqual(['Yes, learn it for Monthly accounts', 'No, make a new format', 'Choose other files']);
    expect(box.textContent).not.toMatch(/source/i);
    expect(learn).toHaveBeenCalledTimes(1);
    expect(registry.getConversion).not.toHaveBeenCalled();
    expect(api.learn).not.toHaveBeenCalled();
    expect(router.state.location.pathname).toBe('/');
  });

  it('Yes: the learn for that format (its output side the target, the free engine first) - and Save adds the file to it with no question', async () => {
    const { registry, learn, router } = await open({ signatures: [OTHER] });
    await press(/Learn the format/);
    await screen.findByTestId('learning-match');
    await act(async () => void fireEvent.click(screen.getByRole('button', { name: 'Yes, learn it for Monthly accounts' })));
    await screen.findByTestId('rules-map');
    expect(learn).toHaveBeenCalledTimes(2);
    const args = learn.mock.calls[1]![0] as LearnArgs;
    expect(args.target).toEqual(formatOf(rules()));
    expect(args.ai).toBe('notAllowed');
    expect(args.checkKnown).toBeUndefined();
    expect(screen.getByTestId('attach-for').textContent).toBe('Learned for your format Monthly accounts: Save adds this file as another input for it.');

    await waitFor(() => expect((screen.getByRole('button', { name: 'Save format' }) as HTMLButtonElement).disabled).toBe(false));
    await act(async () => void fireEvent.click(screen.getByRole('button', { name: 'Save format' })));
    await waitFor(() => expect(registry.attachSource).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('dialog')).toBeNull();
    const [formatId, body] = registry.attachSource.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(formatId).toBe('F1');
    expect(body).toMatchObject({ status: 'verified', learnPath: 'local', suggestedSourceName: 'accounts' });
    expect(registry.createFormat).not.toHaveBeenCalled();
    expect(await screen.findByText('Saved as another input for "Monthly accounts".')).toBeTruthy();
    await waitFor(() => expect(router.state.location.pathname).toBe('/formats/F1/sources/C2'));
  });

  it('Yes, with fields left: "Finish with AI" is the whole learn against that format, on the click', async () => {
    const { learn } = await open({ signatures: [OTHER], result: (args) => (args.target && args.ai !== 'allowed' ? partialResult() : RESULT()) });
    await press(/Learn the format/);
    await screen.findByTestId('learning-match');
    await act(async () => void fireEvent.click(screen.getByRole('button', { name: 'Yes, learn it for Monthly accounts' })));
    await screen.findByTestId('rules-map');
    expect(learn).toHaveBeenCalledTimes(2);
    await act(async () => void fireEvent.click(await screen.findByRole('button', { name: /Finish with AI/ })));
    await waitFor(() => expect(learn).toHaveBeenCalledTimes(3));
    const args = learn.mock.calls[2]![0] as LearnArgs;
    expect(args.ai).toBe('allowed');
    expect(args.target).toEqual(formatOf(rules()));
    expect(args.complete).toBeUndefined();
  });

  it('No: a learn of its own (no target, no check), and Save makes a new format', async () => {
    const { registry, learn } = await open({ signatures: [OTHER] });
    await press(/Learn the format/);
    await screen.findByTestId('learning-match');
    await act(async () => void fireEvent.click(screen.getByRole('button', { name: 'No, make a new format' })));
    await screen.findByTestId('rules-map');
    const args = learn.mock.calls[1]![0] as LearnArgs;
    expect(args.target).toBeUndefined();
    expect(args.checkKnown).toBeUndefined();
    expect(screen.queryByTestId('attach-for')).toBeNull();
    await waitFor(() => expect((screen.getByRole('button', { name: 'Save format' }) as HTMLButtonElement).disabled).toBe(false));
    await act(async () => void fireEvent.click(screen.getByRole('button', { name: 'Save format' })));
    await waitFor(() => expect(registry.createFormat).toHaveBeenCalledTimes(1));
    expect(registry.attachSource).not.toHaveBeenCalled();
  });

  it('Choose other files: back to an empty form, the first drop zone focused', async () => {
    const { learn } = await open({ signatures: [OTHER] });
    await press(/Learn the format/);
    await screen.findByTestId('learning-match');
    await act(async () => void fireEvent.click(screen.getByRole('button', { name: 'Choose other files' })));
    const input = await screen.findByLabelText('Example input');
    expect(screen.queryByTestId('learning-match')).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(input));
    expect(learn).toHaveBeenCalledTimes(1);
  });

  it('several formats: a radio list, most recently used first and chosen; the answers follow the one chosen', async () => {
    const formats = [saved('F1', 'Monthly accounts', '2026-09-01T10:00:00.000Z'), saved('F2', 'Board report', '2026-10-01T10:00:00.000Z')];
    const { learn } = await open({ formats, signatures: [OTHER] });
    await press(/Learn the format/);
    const box = await screen.findByTestId('learning-match');
    const group = within(box).getByRole('group', { name: 'This output matches 2 of your formats. Is this file another input for one of them?' });
    const radios = within(group).getAllByRole('radio') as HTMLInputElement[];
    expect([...group.querySelectorAll('[data-format]')].map((o) => o.textContent)).toEqual(['Board report', 'Monthly accounts']);
    expect(radios[0]!.checked).toBe(true);
    expect(within(box).getByRole('button', { name: 'Yes, learn it for Board report' })).toBeTruthy();
    await act(async () => void fireEvent.click(radios[1]!));
    await act(async () => void fireEvent.click(within(box).getByRole('button', { name: 'Yes, learn it for Monthly accounts' })));
    await screen.findByTestId('rules-map');
    expect((learn.mock.calls[1]![0] as LearnArgs).target).toBeDefined();
    expect(screen.getByTestId('attach-for').textContent).toContain('Monthly accounts');
  });

  it("at the plan's limit (registered, 3 input files): no Yes - the limit with the upgrade, a new format or other files", async () => {
    const { learn } = await open({ formats: [saved('F1', 'Monthly accounts', undefined, 2)], signatures: [OTHER] });
    await press(/Learn the format/);
    const box = await screen.findByTestId('learning-match');
    expect(within(box).getByTestId('learning-match-limit').textContent).toContain("Monthly accounts already takes 3 different input files (your plan's limit).");
    expect(within(box).getAllByRole('button').map((b) => b.textContent)).toEqual(['Upgrade', 'Make a new format', 'Choose other files']);
    await act(async () => void fireEvent.click(within(box).getByRole('button', { name: 'Make a new format' })));
    await screen.findByTestId('rules-map');
    expect((learn.mock.calls[1]![0] as LearnArgs).target).toBeUndefined();
  });

  it('a paid plan has no limit: 3 input files and still Yes', async () => {
    await open({ formats: [saved('F1', 'Monthly accounts', undefined, 2)], signatures: [OTHER], user: { ...USER, tier: 'paid' } });
    await press(/Learn the format/);
    const box = await screen.findByTestId('learning-match');
    expect(within(box).queryByTestId('learning-match-limit')).toBeNull();
    expect(within(box).getByRole('button', { name: 'Yes, learn it for Monthly accounts' })).toBeTruthy();
  });

  it('several formats, one at its limit: it says so in the list, and its answers follow', async () => {
    const formats = [saved('F1', 'Monthly accounts', '2026-10-02T10:00:00.000Z', 2), saved('F2', 'Board report', '2026-09-01T10:00:00.000Z')];
    await open({ formats, signatures: [OTHER] });
    await press(/Learn the format/);
    const box = await screen.findByTestId('learning-match');
    expect(box.querySelector('[data-format="F1"]')!.textContent).toBe("Monthly accountsAlready takes 3 different input files (your plan's limit)");
    expect(within(box).queryByRole('button', { name: /Yes, learn it/ })).toBeNull();
    await act(async () => void fireEvent.click((within(box).getAllByRole('radio') as HTMLInputElement[])[1]!));
    expect(within(box).queryByTestId('learning-match-limit')).toBeNull();
    expect(within(box).getByRole('button', { name: 'Yes, learn it for Board report' })).toBeTruthy();
  });

  it('works the same with "Formats with several sources" switched off: the question, Yes, and the save into the format', async () => {
    const { registry } = await open({ signatures: [OTHER], formatSources: false });
    await press(/Learn the format/);
    await screen.findByTestId('learning-match');
    await act(async () => void fireEvent.click(screen.getByRole('button', { name: 'Yes, learn it for Monthly accounts' })));
    await screen.findByTestId('rules-map');
    await waitFor(() => expect((screen.getByRole('button', { name: 'Save format' }) as HTMLButtonElement).disabled).toBe(false));
    await act(async () => void fireEvent.click(screen.getByRole('button', { name: 'Save format' })));
    await waitFor(() => expect(registry.attachSource).toHaveBeenCalledTimes(1));
  });

  it('says it in Hebrew', async () => {
    await open({ signatures: [OTHER], lang: 'he' });
    await press(/ללמוד את הפורמט/);
    const box = await screen.findByTestId('learning-match');
    expect(within(box).getByRole('heading', { name: 'הפלט הזה תואם לפורמט שלכם' })).toBeTruthy();
    expect(within(box).getByTestId('learning-match-question').textContent).toBe('הפלט הזה תואם לפורמט שלכם Monthly accounts. האם הקובץ הזה הוא קלט נוסף שלו?');
    expect(within(box).getAllByRole('button').map((b) => b.textContent)).toEqual(['כן, ללמוד אותו עבור Monthly accounts', 'לא, ליצור פורמט חדש', 'בחירת קבצים אחרים']);
    await act(async () => void fireEvent.click(within(box).getByRole('button', { name: 'בחירת קבצים אחרים' })));
    const input = await screen.findByLabelText('דוגמת קלט');
    await waitFor(() => expect(document.activeElement).toBe(input));
  });

  it('the limit in Hebrew', async () => {
    await open({ formats: [saved('F1', 'Monthly accounts', undefined, 2)], signatures: [OTHER], lang: 'he' });
    await press(/ללמוד את הפורמט/);
    const box = await screen.findByTestId('learning-match');
    expect(within(box).getByTestId('learning-match-limit').textContent).toContain('הפורמט Monthly accounts כבר מקבל 3 קובצי קלט שונים (המגבלה של התוכנית שלכם).');
    expect(within(box).getAllByRole('button').map((b) => b.textContent)).toEqual(['שדרוג', 'ליצור פורמט חדש', 'בחירת קבצים אחרים']);
  });
});

// The usage events of the two questions (SPEC 14.1; owner decision 2026-10-08): what the user answered - the button, as a code - and the learn
// that follows an answer, reported like any other. Counts and codes only.
describe('usage events: the answers to "You already have this format" and "This output matches your format"', () => {
  const known = (api: Parameters<typeof tracked>[0]) => tracked(api).filter(([type]) => type === 'known_format').map(([, props]) => props);
  const learned = (api: Parameters<typeof tracked>[0]) => tracked(api).filter(([type]) => type === 'learn_completed').map(([, props]) => props);

  it('the two files dropped are reported as an input and an output, by type and size - not by name', async () => {
    const { api } = await open();
    const uploads = tracked(api).filter(([type]) => type === 'file_uploaded');
    expect(uploads).toEqual([
      ['file_uploaded', { role: 'input', fileType: 'csv', rows: 1204, cols: 8 }],
      ['file_uploaded', { role: 'output', fileType: 'csv', rows: 1204, cols: 8 }],
    ]);
    expect(JSON.stringify(tracked(api))).not.toMatch(/accounts|Monthly/);
  });

  it.each([
    ['Convert files with it', 'convert'],
    ['Learn again anyway', 'learnAnyway'],
    ['Choose other files', 'chooseOther'],
  ])('"You already have this format": %s says %s, once - and nothing was learned before it', async (button, answer) => {
    const { api } = await open();
    await press(/Learn the format/);
    await screen.findByTestId('learning-known');
    expect(known(api)).toEqual([]);
    expect(learned(api)).toEqual([]);
    await act(async () => void fireEvent.click(screen.getByRole('button', { name: button })));
    expect(known(api)).toEqual([{ kind: 'same', answer }]);
  });

  it('"Learn again anyway" then reports the learn it started, as an ordinary free learn', async () => {
    const { api } = await open();
    await press(/Learn the format/);
    await screen.findByTestId('learning-known');
    await act(async () => void fireEvent.click(screen.getByRole('button', { name: 'Learn again anyway' })));
    await screen.findByTestId('rules-map');
    expect(learned(api)).toEqual([{ path: 'local', status: 'verified', masking: true, aiClicked: false }]);
  });

  it.each([
    ['Yes, learn it for Monthly accounts', 'yes'],
    ['No, make a new format', 'no'],
    ['Choose other files', 'chooseOther'],
  ])('"This output matches your format": %s says %s, once', async (button, answer) => {
    const { api } = await open({ signatures: [OTHER] });
    await press(/Learn the format/);
    await screen.findByTestId('learning-match');
    expect(known(api)).toEqual([]);
    await act(async () => void fireEvent.click(screen.getByRole('button', { name: button })));
    expect(known(api)).toEqual([{ kind: 'anotherInput', answer }]);
  });
});
