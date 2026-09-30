// The AI quota and saving (SPEC 11, 21 v5 items 2-3, 5 A step 8): what the limits say and offer, the learn outcome the browser
// reports after its own full verification (verified / failed / accepted), and "Save format and download" - what is POSTed, that
// the FULL file is then made in the worker and downloaded, and how each refusal is told.
import { limits, promptVersion, type LearnResponse } from '@formatai/shared';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/api';
import { createMemoryPendingStore, setPendingStore } from '../src/app/pendingLearn';
import type { LearnHost, LearnOutput } from '../src/worker/engineApi';
import { conversionSummary, createFormatResponse, formatSummary } from './helpers/registryKit';
import { csv, fakeApi, fakeEngine, learnResult, liveResult, RULES, renderApp, USER, type FakeApi } from './helpers/renderApp';

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

const SUMMARY = { rowsIn: 3, rowsOut: 3, rowsFiltered: 0, duplicatesRemoved: [], duplicatesFlagged: 0, blockedRows: [] };
const converted = (): unknown => ({ ok: true, bytes: new ArrayBuffer(8), flags: [], summary: SUMMARY, preview: { name: 'Out', direction: 'ltr', language: 'en', columns: [], rows: [], merges: [] }, totalRows: 3 });

const VERIFIED = { verified: true, matched: 3, total: 3, mismatches: [], layoutProblems: [], layoutIssues: [], repairProblems: [] };
const NOT_VERIFIED = { ...VERIFIED, verified: false, matched: 1 };

const llmResponse = (over: Partial<LearnResponse> = {}): LearnResponse => ({
  rules: RULES,
  verified: true,
  problems: [],
  learnId: 'L1',
  cached: false,
  counted: true,
  failedAttempts: 0,
  quota: { remaining: 2, period: 'month' },
  ...over,
});

/** A signed-in learn that goes through the API, like the real worker's `callLearn`, then ends the way `result` says. */
async function learnWithAi(opts: { api: FakeApi; result?: Partial<LearnOutput> | Record<string, unknown>; extra?: Parameters<typeof fakeEngine>[2] }) {
  const { engine, learn } = fakeEngine(async (host: LearnHost) => {
    await host.callLearn({ masking: true } as never);
    return learnResult({ path: 'llm', ...(opts.result ?? {}) });
  }, undefined, { convert: vi.fn(async () => converted()), ...opts.extra });
  renderApp({ engine, api: opts.api });
  fireEvent.change(screen.getByLabelText('Example input'), { target: { files: [csv('orders.csv')] } });
  fireEvent.change(screen.getByLabelText('Example output'), { target: { files: [csv('Orders report.csv')] } });
  await waitFor(() => expect(screen.getAllByText(/1,204/)).toHaveLength(2));
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /Learn the format/ }));
  });
  return { engine, learn };
}

describe('the AI quota', () => {
  it('a used-up quota says for how long, keeps the local work going, and offers "Upgrade" (paid plans are set up by the team)', async () => {
    const api = fakeApi({ user: USER, learn: vi.fn(async () => Promise.reject(new ApiError('limitHit', 429, { limit: 'aiLearns', period: 'month' }))) });
    await learnWithAi({ api });
    expect(await screen.findByText("You've used all your AI learns for this month. They come back next month.")).toBeTruthy();
    expect(screen.getByText('Formats your computer can work out on its own, and every format you saved, keep working.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Upgrade' }));
    expect(await screen.findByText(/Paid plans are set up by our team for now/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Contact us' }).getAttribute('href')).toMatch(/^mailto:/);
  });

  it.each([
    ['lifetime', "You've used all your AI learns."],
    ['day', "You've used all your AI learns for today. They come back tomorrow."],
  ] as const)('a %s quota says its own period', async (period, text) => {
    const api = fakeApi({ user: USER, learn: vi.fn(async () => Promise.reject(new ApiError('limitHit', 429, { limit: 'aiLearns', period }))) });
    await learnWithAi({ api });
    expect(await screen.findByText(text)).toBeTruthy();
  });

  it('the 3-failure stop says the tries were used, what counted, and what to change', async () => {
    const api = fakeApi({ user: USER, learn: vi.fn(async () => Promise.reject(new ApiError('aiAttemptsExhausted', 409, { counted: true }))) });
    await learnWithAi({ api });
    expect(await screen.findByText(`We stopped after ${limits.learn.maxFailedAiAttempts} tries`)).toBeTruthy();
    expect(screen.getByText(/This counted as one AI learn/)).toBeTruthy();
    expect(screen.getByText('Change something in the example files, then start again.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Change files' })).toBeTruthy();
  });

  it('a stop that did not count says so', async () => {
    const api = fakeApi({ user: USER, learn: vi.fn(async () => Promise.reject(new ApiError('aiAttemptsExhausted', 409, { counted: false }))) });
    await learnWithAi({ api });
    expect(await screen.findByText(/We already tried this pair of files several times/)).toBeTruthy();
    expect(screen.queryByText(/This counted as one AI learn/)).toBeNull();
  });

  it('an AI step refused because the session ended asks to sign in again', async () => {
    const api = fakeApi({ user: USER, learn: vi.fn(async () => Promise.reject(new ApiError('signInForAi', 403))) });
    await learnWithAi({ api });
    expect(await screen.findByText('Sign in free to finish this with the AI step.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeTruthy();
  });

  it('shows what is left after an AI learn, from the answer', async () => {
    const api = fakeApi({ user: USER, learn: vi.fn(async () => llmResponse({ quota: { remaining: 1, period: 'month' } })) });
    await learnWithAi({ api, result: { verification: VERIFIED } });
    await screen.findByTestId('rules-map');
    expect(await screen.findByTestId('ai-note')).toBeTruthy();
    await waitFor(() => expect(within(screen.getByTestId('ai-note')).getByText(/AI formats left this month/)).toBeTruthy());
  });
});

describe('the outcome the browser reports (SPEC 21 v5 item 3)', () => {
  it('a learn that verified against the example is reported "verified", and the quota shown follows the answer', async () => {
    const learnOutcome = vi.fn(async () => ({ counted: true, quota: { remaining: 1, period: 'month' as const }, failedAttempts: 0, exhausted: false }));
    const api = fakeApi({ user: USER, learn: vi.fn(async () => llmResponse()), registry: { learnOutcome } });
    await learnWithAi({ api, result: { verification: VERIFIED } });
    await screen.findByTestId('rules-map');
    await waitFor(() => expect(learnOutcome).toHaveBeenCalledWith('L1', 'verified'));
    await waitFor(() => expect(screen.getByTestId('ai-note').textContent).toContain('AI formats left this month: 1'));
  });

  it('a learn that did not match is reported "failed", and says which try it was', async () => {
    const learnOutcome = vi.fn(async () => ({ counted: false, quota: { remaining: 3, period: 'month' as const }, failedAttempts: 1, exhausted: false }));
    const api = fakeApi({ user: USER, learn: vi.fn(async () => llmResponse({ counted: false, failedAttempts: 0 })), registry: { learnOutcome } });
    await learnWithAi({ api, result: { verification: NOT_VERIFIED } });
    await screen.findByTestId('rules-map');
    await waitFor(() => expect(learnOutcome).toHaveBeenCalledWith('L1', 'failed'));
    await waitFor(() => expect(screen.getByTestId('ai-note').textContent).toContain(`try 1 of ${limits.learn.maxFailedAiAttempts}`));
  });

  it('the third failed try says it stopped, and that it counted', async () => {
    const learnOutcome = vi.fn(async () => ({ counted: true, quota: { remaining: 2, period: 'month' as const }, failedAttempts: 3, exhausted: true }));
    const api = fakeApi({ user: USER, learn: vi.fn(async () => llmResponse({ counted: false, failedAttempts: 2 })), registry: { learnOutcome } });
    await learnWithAi({ api, result: { verification: NOT_VERIFIED } });
    await screen.findByTestId('rules-map');
    await waitFor(() => expect(screen.getByTestId('ai-note').textContent).toContain(`We stopped after ${limits.learn.maxFailedAiAttempts} tries`));
    expect(screen.getByTestId('ai-note').textContent).toContain('This counted as one AI learn');
  });

  it('a local learn reports nothing (it never reached the AI)', async () => {
    const api = fakeApi({ user: USER });
    const { engine } = fakeEngine(async () => learnResult({ path: 'local' }));
    renderApp({ engine, api });
    fireEvent.change(screen.getByLabelText('Example input'), { target: { files: [csv('orders.csv')] } });
    fireEvent.change(screen.getByLabelText('Example output'), { target: { files: [csv('Orders report.csv')] } });
    await waitFor(() => expect(screen.getAllByText(/1,204/)).toHaveLength(2));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Learn the format/ }));
    });
    await screen.findByTestId('rules-map');
    expect(api.registry.learnOutcome).not.toHaveBeenCalled();
  });
});

describe('Save format and download (signed in)', () => {
  async function openLocal(api: FakeApi, extra: Parameters<typeof fakeEngine>[2] = {}, result: Record<string, unknown> = {}) {
    const convert = vi.fn(async () => converted());
    const { engine } = fakeEngine(async () => learnResult({ path: 'local', ...result }), undefined, { convert, ...extra });
    renderApp({ engine, api });
    fireEvent.change(screen.getByLabelText('Example input'), { target: { files: [csv('orders.csv')] } });
    fireEvent.change(screen.getByLabelText('Example output'), { target: { files: [csv('Orders report.csv')] } });
    await waitFor(() => expect(screen.getAllByText(/1,204/)).toHaveLength(2));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Learn the format/ }));
    });
    await screen.findByTestId('rules-map');
    await waitFor(() => expect((screen.getByRole('button', { name: /Save/ }) as HTMLButtonElement).disabled).toBe(false));
    return { convert };
  }

  const created = createFormatResponse({ format: formatSummary({ id: 'F1', name: 'Orders report' }), conversion: conversionSummary({ id: 'C1', formatId: 'F1' }) });

  it('POSTs the name, the rules, the status and how it was learned; then makes the FULL file in the worker and downloads it', async () => {
    const createFormat = vi.fn(async () => created);
    const api = fakeApi({ user: USER, registry: { createFormat } });
    const { convert } = await openLocal(api);
    fireEvent.click(screen.getByRole('button', { name: 'Save format and download' }));

    await waitFor(() => expect(createFormat).toHaveBeenCalledTimes(1));
    const body = (createFormat.mock.calls[0] as unknown as [Record<string, unknown>])[0];
    expect(body).toMatchObject({ name: 'Orders report', status: 'verified', acceptedDifferences: 0, exampleExceptions: [], learnPath: 'local', masking: true });
    expect(body.rules).toEqual(RULES);
    // Learned on this computer: there is no model or prompt to name.
    expect(body).not.toHaveProperty('promptVersion');
    expect(body).not.toHaveProperty('model');

    // The whole example input is converted (no preview cut-off) and the result is saved through the browser.
    await waitFor(() => expect(downloaded).toHaveBeenCalledTimes(1));
    const lastRun = convert.mock.calls.filter((c) => (c as unknown as [{ previewRows: number }])[0].previewRows === 0);
    expect(lastRun).toHaveLength(1);
    expect(downloaded.mock.calls[0]![0]).toBe('orders (converted).xlsx');
    expect(await screen.findByText('Saved. "Orders report" is in My formats, and your file is downloading.')).toBeTruthy();
    // Saved: the header now saves changes (nothing to save yet) and downloads; the way to My formats is in the message. No second first save.
    expect(screen.queryByRole('button', { name: 'Save format and download' })).toBeNull();
    expect((screen.getByRole('button', { name: 'Save changes' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole('button', { name: 'Download' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open My formats' })).toBeTruthy();
  });

  describe('the source the format is saved with (SPEC 8.15)', () => {
    const INPUT = [
      { header: 'Order ID', type: 'text' },
      { header: 'Amount', type: 'decimal' },
      { header: 'Notes', type: 'text' },
    ];

    it('sends the example input\'s headers (structure only) so the server can reuse a source it matches, and forces no source', async () => {
      const createFormat = vi.fn(async () => created);
      await openLocal(fakeApi({ user: USER, registry: { createFormat } }), {}, { exampleInput: INPUT });
      fireEvent.click(screen.getByRole('button', { name: 'Save format and download' }));
      await waitFor(() => expect(createFormat).toHaveBeenCalledTimes(1));
      const body = (createFormat.mock.calls[0] as unknown as [Record<string, unknown>])[0];
      // The example's headers - all of them, not only the ones the rules use - and nothing read from a cell.
      expect(body.inputHeaders).toEqual(['Order ID', 'Amount', 'Notes']);
      expect(body).not.toHaveProperty('sourceId');
      expect(body).not.toHaveProperty('newSource');
      expect(body).not.toHaveProperty('sourceName');
      // A source that was created says nothing about reuse.
      expect(await screen.findByText('Saved. "Orders report" is in My formats, and your file is downloading.')).toBeTruthy();
      expect(screen.queryByTestId('source-reused')).toBeNull();
    });

    it('says "Reused your source X" when the server reused one of the company\'s', async () => {
      const reused = createFormatResponse({
        format: formatSummary({ id: 'F1', name: 'Orders report' }),
        conversion: conversionSummary({ id: 'C1', formatId: 'F1', sourceName: 'Acme prices' }),
        source: { id: 'S4', name: 'Acme prices' },
        sourceReused: { id: 'S4', name: 'Acme prices' },
      });
      const createFormat = vi.fn(async () => reused);
      await openLocal(fakeApi({ user: USER, registry: { createFormat } }), {}, { exampleInput: INPUT });
      fireEvent.click(screen.getByRole('button', { name: 'Save format and download' }));
      const line = await screen.findByTestId('source-reused');
      expect(line.textContent).toContain('Reused your source');
      expect(line.textContent).toContain('Acme prices');
      // (next to the message for the save itself; and the screen is now the editor of that source, named as the server named it)
      expect(screen.getByText('Saved. "Orders report" is in My formats, and your file is downloading.')).toBeTruthy();
      expect(screen.getByText('Saved as the source "Acme prices". We do not keep your files.')).toBeTruthy();
    });

    it('leaves inputHeaders out when the learn kept no example input', async () => {
      const createFormat = vi.fn(async () => created);
      await openLocal(fakeApi({ user: USER, registry: { createFormat } }));
      fireEvent.click(screen.getByRole('button', { name: 'Save format and download' }));
      await waitFor(() => expect(createFormat).toHaveBeenCalledTimes(1));
      expect((createFormat.mock.calls[0] as unknown as [Record<string, unknown>])[0]).not.toHaveProperty('inputHeaders');
    });

    it('says it in Hebrew', async () => {
      const reused = createFormatResponse({ conversion: conversionSummary({ id: 'C1', formatId: 'F1', sourceName: 'Acme prices' }), source: { id: 'S4', name: 'Acme prices' }, sourceReused: { id: 'S4', name: 'Acme prices' } });
      const createFormat = vi.fn(async () => reused);
      const convert = vi.fn(async () => converted());
      const { engine } = fakeEngine(async () => learnResult({ path: 'local', exampleInput: INPUT }), undefined, { convert });
      renderApp({ engine, api: fakeApi({ user: USER, registry: { createFormat } }), lang: 'he' });
      fireEvent.change(screen.getByLabelText('דוגמת קלט'), { target: { files: [csv('orders.csv')] } });
      fireEvent.change(screen.getByLabelText('דוגמת פלט'), { target: { files: [csv('Orders report.csv')] } });
      await waitFor(() => expect(screen.getAllByText(/1,204/)).toHaveLength(2));
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /ללמוד את הפורמט/ }));
      });
      await screen.findByTestId('rules-map');
      await waitFor(() => expect((screen.getByRole('button', { name: 'שמירת הפורמט והורדה' }) as HTMLButtonElement).disabled).toBe(false));
      fireEvent.click(screen.getByRole('button', { name: 'שמירת הפורמט והורדה' }));
      const line = await screen.findByTestId('source-reused');
      expect(line.textContent).toContain('השתמשנו במקור הקיים שלכם:');
      expect(line.textContent).toContain('Acme prices');
    });
  });

  it('uses the name the user gave', async () => {
    const createFormat = vi.fn(async () => created);
    const api = fakeApi({ user: USER, registry: { createFormat } });
    await openLocal(api);
    fireEvent.click(screen.getByRole('button', { name: /Rename Orders report/ }));
    const field = screen.getByLabelText('Format name');
    fireEvent.change(field, { target: { value: 'Monthly orders' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    fireEvent.click(screen.getByRole('button', { name: 'Save format and download' }));
    await waitFor(() => expect(createFormat).toHaveBeenCalled());
    expect((createFormat.mock.calls[0] as unknown as [{ name: string }])[0].name).toBe('Monthly orders');
  });

  it('"Save with N differences": status differencesAccepted with the count, and the AI learn is reported "accepted"', async () => {
    const createFormat = vi.fn(async () => created);
    const learnOutcome = vi.fn(async () => ({ counted: true, quota: { remaining: 2, period: 'month' as const }, failedAttempts: 0, exhausted: false }));
    const api = fakeApi({ user: USER, registry: { createFormat, learnOutcome }, learn: vi.fn(async () => llmResponse({ counted: false, failedAttempts: 0 })) });
    const differing = liveResult({ verified: false, matched: 1, total: 4, differences: 3 });
    const { engine } = fakeEngine(
      async (host: LearnHost) => {
        await host.callLearn({ masking: true } as never);
        return learnResult({ path: 'llm', verification: NOT_VERIFIED });
      },
      undefined,
      { liveCheck: vi.fn(async () => differing), fullCheck: vi.fn(async () => differing), convert: vi.fn(async () => converted()) },
    );
    renderApp({ engine, api });
    fireEvent.change(screen.getByLabelText('Example input'), { target: { files: [csv('orders.csv')] } });
    fireEvent.change(screen.getByLabelText('Example output'), { target: { files: [csv('Orders report.csv')] } });
    await waitFor(() => expect(screen.getAllByText(/1,204/)).toHaveLength(2));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Learn the format/ }));
    });
    await screen.findByTestId('rules-map');
    const save = await screen.findByRole('button', { name: 'Save with 3 differences and download' });
    // (the failed report came first)
    await waitFor(() => expect(learnOutcome).toHaveBeenCalledWith('L1', 'failed'));
    fireEvent.click(save);
    await waitFor(() => expect(createFormat).toHaveBeenCalled());
    expect((createFormat.mock.calls[0] as unknown as [Record<string, unknown>])[0]).toMatchObject({ status: 'differencesAccepted', acceptedDifferences: 3, learnPath: 'llm', promptVersion });
    await waitFor(() => expect(learnOutcome).toHaveBeenCalledWith('L1', 'accepted'));
  });

  it('a visitor is asked to sign in instead, and nothing is saved', async () => {
    const api = fakeApi();
    await openLocal(api);
    fireEvent.click(screen.getByRole('button', { name: 'Save format and download' }));
    expect(await screen.findByRole('dialog', { name: 'Sign in' })).toBeTruthy();
    expect(api.registry.createFormat).not.toHaveBeenCalled();
    expect(downloaded).not.toHaveBeenCalled();
  });

  it.each([
    ['savedFormats', 403, "You've saved as many formats as your plan allows. Delete one to make room."],
    ['rulesPerFormat', 403, 'This format has more rules than your plan allows. Simplify it, or upgrade.'],
    ['newFormatsPerMonth', 429, "You've created all the new formats your plan allows this month."],
  ] as const)('the %s limit is said in words, with Upgrade', async (limit, status, text) => {
    const createFormat = vi.fn(async () => Promise.reject(new ApiError('limitHit', status, { limit })));
    await openLocal(fakeApi({ user: USER, registry: { createFormat } }));
    fireEvent.click(screen.getByRole('button', { name: 'Save format and download' }));
    expect(await screen.findByText(text)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Upgrade' })).toBeTruthy();
    // (the header has the link too: the message adds a second one to free a slot)
    if (limit === 'savedFormats') expect(screen.getAllByRole('link', { name: 'My formats' }).length).toBeGreaterThan(1);
    expect(downloaded).not.toHaveBeenCalled();
    // The rules stay: the user can try again after making room.
    expect(screen.getByRole('button', { name: 'Save format and download' })).toBeTruthy();
  });

  it('rules the server refuses are listed, with what is wrong', async () => {
    const createFormat = vi.fn(async () => Promise.reject(new ApiError('invalidRules', 422, { problems: [{ kind: 'reference', message: 'unknown column id "ghost"' }] })));
    await openLocal(fakeApi({ user: USER, registry: { createFormat } }));
    fireEvent.click(screen.getByRole('button', { name: 'Save format and download' }));
    expect(await screen.findByText("These rules can't be saved yet. Fix the marked problems and try again.")).toBeTruthy();
    expect(screen.getByText('unknown column id "ghost"')).toBeTruthy();
  });

  it('a session that ended while saving asks to sign in', async () => {
    const createFormat = vi.fn(async () => Promise.reject(new ApiError('signInRequired', 401)));
    await openLocal(fakeApi({ user: USER, registry: { createFormat } }));
    fireEvent.click(screen.getByRole('button', { name: 'Save format and download' }));
    expect(await screen.findByText("Sign in to save this format and reuse it on next month's file.")).toBeTruthy();
  });

  it('a file that cannot be made after saving says the format is saved anyway', async () => {
    const createFormat = vi.fn(async () => created);
    const convert = vi.fn(async (args: { previewRows: number }) => (args.previewRows === 0 ? { ok: false, error: { code: 'noTable' } } : converted()));
    await openLocal(fakeApi({ user: USER, registry: { createFormat } }), { convert });
    fireEvent.click(screen.getByRole('button', { name: 'Save format and download' }));
    expect(await screen.findByText(/The format was saved, but we couldn't prepare the file/)).toBeTruthy();
    expect(createFormat).toHaveBeenCalledTimes(1);
    expect(downloaded).not.toHaveBeenCalled();
  });

  it('cannot be double-clicked into two formats', async () => {
    let release: () => void = () => undefined;
    const createFormat = vi.fn(() => new Promise<typeof created>((resolve) => (release = () => resolve(created))));
    await openLocal(fakeApi({ user: USER, registry: { createFormat } }));
    const button = screen.getByRole('button', { name: 'Save format and download' });
    fireEvent.click(button);
    fireEvent.click(button);
    await act(async () => release());
    await waitFor(() => expect(downloaded).toHaveBeenCalledTimes(1));
    expect(createFormat).toHaveBeenCalledTimes(1);
  });
});
