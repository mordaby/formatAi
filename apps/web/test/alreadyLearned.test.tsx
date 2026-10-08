// "You already have this format" (owner decision 2026-10-07, SPEC 5 A step 2a): a signed-in user with saved formats starts a learn on Home;
// before anything is learned, the worker checks whether the saved rules of a format with this output, from this file, already make the
// example. Then one clear message, not an error - "You already have this format" / "Your format X already makes this output from this file."
// with [Convert files with it] [Learn again anyway] - and no learn request is sent. Rules that make other values: the learn goes on, the result
// says so, and Save offers "Update its rules". A fake worker that answers as the engine does (`knownPairs`, the real one); a fake API.
import { formatOf, knownPairs, type ExampleShape, type KnownPair } from '@formatai/engine';
import type { FormatSummary, GetFormatResponse, LearnResult, MeUser, SignatureEntry } from '@formatai/shared';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryPendingStore, setPendingStore } from '../src/app/pendingLearn';
import { resumeLeaveGuard } from '../src/app/unloadPrompt';
import type { LearnArgs, LearnHost, LearnOutput } from '../src/worker/engineApi';
import { entry, fakeConvertApi } from './helpers/convertKit';
import { conversionDetail, conversionSummary, createFormatResponse, formatSummary } from './helpers/registryKit';
import { csv, fakeApi, fakeEngine, learnResult, liveResult, renderApp, USER } from './helpers/renderApp';

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
const SHAPE: ExampleShape = { outputHeaders: ['Account', 'Company'], fileType: 'xlsx', headerRow: true, inputHeaders: ['Account', 'Company'] };

/** A saved format with this output, its one conversion `${id}-C1` from source S1 (CRM A). */
function saved(id: string, name: string, updatedAt = '2026-09-01T10:00:00.000Z') {
  const f = formatOf(rules());
  const summary: FormatSummary = formatSummary({ id, name, fileType: 'xlsx', outputHeaders: ['Account', 'Company'], outputColumns: 2, updatedAt });
  const conversions = [conversionSummary({ id: `${id}-C1`, formatId: id, sourceId: 'S1', sourceName: 'CRM A', version: 4 })];
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
 * The worker's learn as the engine does it: with `checkKnown`, the candidates from the host, the pairs (`knownPairs`, the real one), each
 * pair's saved rules from the host - a pair in `makes` makes the example ("known"), the others differ (`knownDiffers`).
 */
function worker(makes: ReadonlySet<string>) {
  return async (host: LearnHost, args: LearnArgs): Promise<LearnOutput> => {
    if (args.checkKnown && host.knownCandidates && host.knownRules) {
      let differs: KnownPair | undefined;
      for (const pair of knownPairs(SHAPE, await host.knownCandidates(SHAPE))) {
        const saved = await host.knownRules(pair.conversionId);
        if (saved && makes.has(pair.conversionId)) return learnResult({ path: 'known', rules: null, known: pair, verification: null });
        differs ??= pair;
      }
      return { ...RESULT(), ...(differs ? { knownDiffers: differs } : {}) };
    }
    return RESULT();
  };
}

interface Setup {
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
  };
  const user = setup.user === undefined ? USER : setup.user;
  const api = fakeApi({ ...(user ? { user } : {}), registry, features: { formatSources: setup.formatSources ?? true } });
  const liveCheck = vi.fn(async () => liveResult({ verified: true, matched: ROWS, total: ROWS, perColumn: [{ header: 'Account', inExample: true, matched: ROWS, total: ROWS }, { header: 'Company', inExample: true, matched: ROWS, total: ROWS }] }));
  const matchFile = vi.fn(async () => ({ ok: false, reason: 'noMatch' }));
  const fake = fakeEngine(worker(new Set(setup.makes ?? ['F1-C1'])), undefined, { liveCheck, fullCheck: liveCheck, matchFile });
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
    expect(within(known).getAllByRole('button').map((b) => b.textContent)).toEqual(['Convert files with it', 'Learn again anyway']);
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
    expect(within(known).getAllByRole('button').map((b) => b.textContent)).toEqual(['להמיר קבצים בעזרתו', 'ללמוד מחדש בכל זאת']);
  });

  it('works the same with "Formats with several sources" switched off (it never needs it)', async () => {
    const { api } = await open({ formatSources: false });
    await press(/Learn the format/);
    expect(await screen.findByTestId('learning-known')).toBeTruthy();
    expect(api.learn).not.toHaveBeenCalled();
  });
});

describe('the logic changed: the learn goes on', () => {
  it('the result says so in one line, and Save offers "Update its rules"', async () => {
    const { registry } = await open({ makes: [] });
    await press(/Learn the format/);
    await screen.findByTestId('rules-map');
    expect(screen.getByTestId('known-differs').textContent).toBe('Your format Monthly accounts gives different values for this example, so the rules were learned again.');
    expect(screen.queryByTestId('learning-known')).toBeNull();
    await waitFor(() => expect((screen.getByRole('button', { name: 'Save format' }) as HTMLButtonElement).disabled).toBe(false));
    await act(async () => void fireEvent.click(screen.getByRole('button', { name: 'Save format' })));
    const box = await screen.findByRole('dialog', { name: 'Save this format?' });
    expect(within(box).getByRole('button', { name: 'Update its rules' })).toBeTruthy();
    expect(registry.createFormat).not.toHaveBeenCalled();
  });

  it('says it in Hebrew', async () => {
    await open({ makes: [], lang: 'he' });
    await press(/ללמוד את הפורמט/);
    await screen.findByTestId('rules-map');
    expect(screen.getByTestId('known-differs').textContent).toBe('הפורמט שלכם Monthly accounts נותן ערכים אחרים בדוגמה הזו, ולכן הכללים נלמדו מחדש.');
  });
});

describe('no "already" when the file or the output is not that format\'s', () => {
  it('another source: the learn as usual, no saved rules read, nothing said', async () => {
    const { registry } = await open({ signatures: [OTHER] });
    await press(/Learn the format/);
    await screen.findByTestId('rules-map');
    expect(registry.getConversion).not.toHaveBeenCalled();
    expect(screen.queryByTestId('known-differs')).toBeNull();
  });

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
