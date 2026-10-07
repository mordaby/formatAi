// The AI quota and saving (SPEC 11, 21 v5 items 2-3, 5 A step 8): what the limits say and offer, the learn outcome the browser
// reports after its own full verification (verified / failed / accepted), "Save format" - what is POSTed, that saving does not
// download the file, and how each refusal is told - and "Download the file" beside it: the FULL file made in the worker, for a signed-in
// user; a visitor is asked to sign in.
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
  quota: { remaining: 2, period: 'month', limit: null },
  // (API audit 2026-10-07: the version the server learned with - not the browser's constant - is what a save stores)
  promptVersion: 'learn-v9',
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
  it('a used-up quota (a 429 at learn time) opens the out-of-AI-formats dialog over the form, the files kept, and offers the paid waitlist (paid plans are set up by the team)', async () => {
    const api = fakeApi({ user: USER, learn: vi.fn(async () => Promise.reject(new ApiError('limitHit', 429, { limit: 'aiLearns', period: 'month' }))) });
    await learnWithAi({ api });
    const dialog = await screen.findByRole('dialog', { name: "You've used your AI formats for this month" });
    expect(within(dialog).getByText(/^Your plan includes 3 AI formats a month\. They come back on /)).toBeTruthy();
    expect(within(dialog).getByText('You can still learn formats without AI, and every format you saved keeps working.')).toBeTruthy();
    // (no error screen behind it: the form, with both files)
    expect(screen.queryByRole('button', { name: 'Change files' })).toBeNull();
    expect(screen.getAllByText(/1,204/)).toHaveLength(2);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Join the paid waitlist' }));
    expect(await within(dialog).findByText(/Paid plans are set up by our team for now/)).toBeTruthy();
    expect(within(dialog).getByRole('link', { name: 'Contact us' }).getAttribute('href')).toMatch(/^mailto:/);
  });

  it.each([
    ['lifetime', "You've used your AI formats"],
    ['day', "You've used your AI formats for today"],
  ] as const)('a %s quota says its own period', async (period, title) => {
    const api = fakeApi({ user: USER, learn: vi.fn(async () => Promise.reject(new ApiError('limitHit', 429, { limit: 'aiLearns', period }))) });
    await learnWithAi({ api });
    expect(await screen.findByRole('dialog', { name: title })).toBeTruthy();
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
    const api = fakeApi({ user: USER, learn: vi.fn(async () => llmResponse({ quota: { remaining: 1, period: 'month', limit: null } })) });
    await learnWithAi({ api, result: { verification: VERIFIED } });
    await screen.findByTestId('rules-map');
    expect(await screen.findByTestId('ai-note')).toBeTruthy();
    await waitFor(() => expect(within(screen.getByTestId('ai-note')).getByText(/AI formats left this month/)).toBeTruthy());
  });
});

describe('the outcome the browser reports (SPEC 21 v5 item 3)', () => {
  it('a learn that verified against the example is reported "verified", and the quota shown follows the answer', async () => {
    const learnOutcome = vi.fn(async () => ({ counted: true, quota: { remaining: 1, period: 'month' as const, limit: null }, failedAttempts: 0, exhausted: false }));
    const api = fakeApi({ user: USER, learn: vi.fn(async () => llmResponse()), registry: { learnOutcome } });
    await learnWithAi({ api, result: { verification: VERIFIED } });
    await screen.findByTestId('rules-map');
    await waitFor(() => expect(learnOutcome).toHaveBeenCalledWith('L1', 'verified'));
    await waitFor(() => expect(screen.getByTestId('ai-note').textContent).toContain('AI formats left this month: 1'));
  });

  it('a learn that did not match is reported "failed", and says which try it was', async () => {
    const learnOutcome = vi.fn(async () => ({ counted: false, quota: { remaining: 3, period: 'month' as const, limit: null }, failedAttempts: 1, exhausted: false }));
    const api = fakeApi({ user: USER, learn: vi.fn(async () => llmResponse({ counted: false, failedAttempts: 0 })), registry: { learnOutcome } });
    await learnWithAi({ api, result: { verification: NOT_VERIFIED } });
    await screen.findByTestId('rules-map');
    await waitFor(() => expect(learnOutcome).toHaveBeenCalledWith('L1', 'failed'));
    await waitFor(() => expect(screen.getByTestId('ai-note').textContent).toContain(`try 1 of ${limits.learn.maxFailedAiAttempts}`));
  });

  it('the third failed try says it stopped, and that it counted', async () => {
    const learnOutcome = vi.fn(async () => ({ counted: true, quota: { remaining: 2, period: 'month' as const, limit: null }, failedAttempts: 3, exhausted: true }));
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

describe('Save format (signed in)', () => {
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

  it('POSTs the name, the rules, the status and how it was learned - and does not make or download the file', async () => {
    const createFormat = vi.fn(async () => created);
    const api = fakeApi({ user: USER, registry: { createFormat } });
    const { convert } = await openLocal(api);
    fireEvent.click(screen.getByRole('button', { name: 'Save format' }));

    await waitFor(() => expect(createFormat).toHaveBeenCalledTimes(1));
    const body = (createFormat.mock.calls[0] as unknown as [Record<string, unknown>])[0];
    expect(body).toMatchObject({ name: 'Orders report', status: 'verified', acceptedDifferences: 0, exampleExceptions: [], learnPath: 'local', masking: true });
    expect(body.rules).toEqual(RULES);
    // Learned on this computer: there is no model or prompt to name.
    expect(body).not.toHaveProperty('promptVersion');
    expect(body).not.toHaveProperty('model');

    // The user already has the output: the format is saved, the file is not made (the whole example input is never converted) or downloaded.
    expect(await screen.findByText('Saved. "Orders report" is in My formats.')).toBeTruthy();
    expect(convert.mock.calls.filter((c) => (c as unknown as [{ previewRows: number }])[0].previewRows === 0)).toHaveLength(0);
    expect(downloaded).not.toHaveBeenCalled();
    // Saved: the header now saves changes (nothing to save yet) and downloads; the way to My formats is in the message. No second first save.
    expect(screen.queryByRole('button', { name: 'Save format' })).toBeNull();
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
      fireEvent.click(screen.getByRole('button', { name: 'Save format' }));
      await waitFor(() => expect(createFormat).toHaveBeenCalledTimes(1));
      const body = (createFormat.mock.calls[0] as unknown as [Record<string, unknown>])[0];
      // The example's headers - all of them, not only the ones the rules use - and nothing read from a cell.
      expect(body.inputHeaders).toEqual(['Order ID', 'Amount', 'Notes']);
      expect(body).not.toHaveProperty('sourceId');
      expect(body).not.toHaveProperty('newSource');
      expect(body).not.toHaveProperty('sourceName');
      // A new source is named after the example input file ("orders.csv"): a default the server makes unique, never a name the user chose.
      expect(body.suggestedSourceName).toBe('orders');
      // A source that was created is not mentioned: there is no source UI in the MVP (SPEC 8.15).
      expect(await screen.findByText('Saved. "Orders report" is in My formats.')).toBeTruthy();
      expect(screen.queryByTestId('source-reused')).toBeNull();
      expect(document.body.textContent).not.toMatch(/saved as (the )?source|recogni[sz]ed|reused/i);
    });

    it('says nothing about the source when the server recognized one of the company\'s and reused it - the save reads as any other', async () => {
      const reused = createFormatResponse({
        format: formatSummary({ id: 'F1', name: 'Orders report' }),
        conversion: conversionSummary({ id: 'C1', formatId: 'F1', sourceId: 'S4', sourceName: 'Acme prices' }),
        source: { id: 'S4', name: 'Acme prices', formats: 2 },
        sourceReused: { id: 'S4', name: 'Acme prices' },
      });
      const createFormat = vi.fn(async () => reused);
      await openLocal(fakeApi({ user: USER, registry: { createFormat } }), {}, { exampleInput: INPUT });
      fireEvent.click(screen.getByRole('button', { name: 'Save format' }));
      // the message for the save itself is all there is; the source's name (the server's word) is nowhere on the screen
      expect(await screen.findByText('Saved. "Orders report" is in My formats.')).toBeTruthy();
      expect(screen.queryByTestId('source-reused')).toBeNull();
      expect(document.body.textContent).not.toContain('Acme prices');
      expect(document.body.textContent).not.toMatch(/saved as (the )?source|recogni[sz]ed|reused/i);
    });

    it('leaves inputHeaders out when the learn kept no example input', async () => {
      const createFormat = vi.fn(async () => created);
      await openLocal(fakeApi({ user: USER, registry: { createFormat } }));
      fireEvent.click(screen.getByRole('button', { name: 'Save format' }));
      await waitFor(() => expect(createFormat).toHaveBeenCalledTimes(1));
      expect((createFormat.mock.calls[0] as unknown as [Record<string, unknown>])[0]).not.toHaveProperty('inputHeaders');
    });

    it('says nothing about the source in Hebrew either', async () => {
      const reused = createFormatResponse({ conversion: conversionSummary({ id: 'C1', formatId: 'F1', sourceId: 'S4', sourceName: 'Acme prices' }), source: { id: 'S4', name: 'Acme prices', formats: 1 }, sourceReused: { id: 'S4', name: 'Acme prices' } });
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
      await waitFor(() => expect((screen.getByRole('button', { name: 'שמירת הפורמט' }) as HTMLButtonElement).disabled).toBe(false));
      // (the file is its own button, in the same register)
      expect(screen.getByRole('button', { name: 'הורדת הקובץ' })).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: 'שמירת הפורמט' }));
      await screen.findByText(/^נשמר\. "/);
      expect(screen.queryByTestId('source-reused')).toBeNull();
      expect(document.body.textContent).not.toContain('Acme prices');
      expect(document.body.textContent).not.toContain('השתמשנו במקור');
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
    fireEvent.click(screen.getByRole('button', { name: 'Save format' }));
    await waitFor(() => expect(createFormat).toHaveBeenCalled());
    expect((createFormat.mock.calls[0] as unknown as [{ name: string }])[0].name).toBe('Monthly orders');
  });

  it('"Save with N differences": status differencesAccepted with the count, and the AI learn is reported "accepted"', async () => {
    const createFormat = vi.fn(async () => created);
    const learnOutcome = vi.fn(async () => ({ counted: true, quota: { remaining: 2, period: 'month' as const, limit: null }, failedAttempts: 0, exhausted: false }));
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
    const save = await screen.findByRole('button', { name: 'Save with 3 differences' });
    // (the failed report came first)
    await waitFor(() => expect(learnOutcome).toHaveBeenCalledWith('L1', 'failed'));
    fireEvent.click(save);
    await waitFor(() => expect(createFormat).toHaveBeenCalled());
    expect((createFormat.mock.calls[0] as unknown as [Record<string, unknown>])[0]).toMatchObject({ status: 'differencesAccepted', acceptedDifferences: 3, learnPath: 'llm', promptVersion: 'learn-v9' });
    expect(promptVersion).not.toBe('learn-v9'); // the server's, not the browser's constant
    await waitFor(() => expect(learnOutcome).toHaveBeenCalledWith('L1', 'accepted'));
  });

  it('a visitor is asked to sign in instead, and nothing is saved', async () => {
    const api = fakeApi();
    await openLocal(api);
    fireEvent.click(screen.getByRole('button', { name: 'Save format' }));
    expect(await screen.findByRole('dialog', { name: 'Sign in' })).toBeTruthy();
    expect(api.registry.createFormat).not.toHaveBeenCalled();
    expect(downloaded).not.toHaveBeenCalled();
  });

  it('a visitor who asks for the file is asked to sign in (the download reason), and nothing is converted or downloaded', async () => {
    const api = fakeApi();
    const { convert } = await openLocal(api);
    fireEvent.click(screen.getByRole('button', { name: 'Download the file' }));
    const dialog = await screen.findByRole('dialog', { name: 'Sign in' });
    expect(dialog.textContent).toContain('Sign in free to download the full file.');
    expect(convert.mock.calls.filter((c) => (c as unknown as [{ previewRows: number }])[0].previewRows === 0)).toHaveLength(0);
    expect(downloaded).not.toHaveBeenCalled();
    expect(api.registry.createFormat).not.toHaveBeenCalled();
  });

  it.each([
    ['savedFormats', 403, "You've saved as many formats as your plan allows. Delete one to make room."],
    ['rulesPerFormat', 403, 'This format has more rules than your plan allows. Simplify it, or upgrade.'],
    ['newFormatsPerMonth', 429, "You've created all the new formats your plan allows this month."],
  ] as const)('the %s limit is said in words, with Upgrade', async (limit, status, text) => {
    const createFormat = vi.fn(async () => Promise.reject(new ApiError('limitHit', status, { limit })));
    await openLocal(fakeApi({ user: USER, registry: { createFormat } }));
    fireEvent.click(screen.getByRole('button', { name: 'Save format' }));
    expect(await screen.findByText(text)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Upgrade' })).toBeTruthy();
    // (the header has the link too: the message adds a second one to free a slot)
    if (limit === 'savedFormats') expect(screen.getAllByRole('link', { name: 'My formats' }).length).toBeGreaterThan(1);
    expect(downloaded).not.toHaveBeenCalled();
    // The rules stay: the user can try again after making room.
    expect(screen.getByRole('button', { name: 'Save format' })).toBeTruthy();
  });

  it('rules the server refuses are listed, with what is wrong', async () => {
    const createFormat = vi.fn(async () => Promise.reject(new ApiError('invalidRules', 422, { problems: [{ kind: 'reference', message: 'unknown column id "ghost"' }] })));
    await openLocal(fakeApi({ user: USER, registry: { createFormat } }));
    fireEvent.click(screen.getByRole('button', { name: 'Save format' }));
    expect(await screen.findByText("These rules can't be saved yet. Fix the marked problems and try again.")).toBeTruthy();
    expect(screen.getByText('unknown column id "ghost"')).toBeTruthy();
  });

  it('a session that ended while saving asks to sign in', async () => {
    const createFormat = vi.fn(async () => Promise.reject(new ApiError('signInRequired', 401)));
    await openLocal(fakeApi({ user: USER, registry: { createFormat } }));
    fireEvent.click(screen.getByRole('button', { name: 'Save format' }));
    expect(await screen.findByText("Sign in to save this format and reuse it on next month's file.")).toBeTruthy();
  });

  it('"Download the file" converts the example input with the rules on screen and downloads it - without saving the format', async () => {
    const createFormat = vi.fn(async () => created);
    const api = fakeApi({ user: USER, registry: { createFormat } });
    const { convert } = await openLocal(api);
    fireEvent.click(screen.getByRole('button', { name: 'Download the file' }));
    await waitFor(() => expect(downloaded).toHaveBeenCalledTimes(1));
    // The whole example input is converted (no preview cut-off) and the result is saved through the browser.
    const full = convert.mock.calls.filter((c) => (c as unknown as [{ previewRows: number }])[0].previewRows === 0);
    expect(full).toHaveLength(1);
    expect((full[0] as unknown as [{ rules: unknown }])[0].rules).toEqual(RULES);
    expect(downloaded.mock.calls[0]![0]).toBe('orders (converted).xlsx');
    // Nothing is saved, and the format can still be (the primary button is still there).
    expect(createFormat).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Save format' })).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('a file that cannot be made says so, and the format can still be saved', async () => {
    const createFormat = vi.fn(async () => created);
    const convert = vi.fn(async (args: { previewRows: number }) => (args.previewRows === 0 ? { ok: false, error: { code: 'noTable' } } : converted()));
    await openLocal(fakeApi({ user: USER, registry: { createFormat } }), { convert });
    fireEvent.click(screen.getByRole('button', { name: 'Download the file' }));
    expect(await screen.findByText("We couldn't prepare the file. Try again.")).toBeTruthy();
    expect(downloaded).not.toHaveBeenCalled();
    expect(createFormat).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Save format' }));
    expect(await screen.findByText('Saved. "Orders report" is in My formats.')).toBeTruthy();
    expect(createFormat).toHaveBeenCalledTimes(1);
  });

  it('cannot be double-clicked into two formats', async () => {
    let release: () => void = () => undefined;
    const createFormat = vi.fn(() => new Promise<typeof created>((resolve) => (release = () => resolve(created))));
    await openLocal(fakeApi({ user: USER, registry: { createFormat } }));
    const button = screen.getByRole('button', { name: 'Save format' });
    fireEvent.click(button);
    fireEvent.click(button);
    await act(async () => release());
    expect(await screen.findByText('Saved. "Orders report" is in My formats.')).toBeTruthy();
    expect(createFormat).toHaveBeenCalledTimes(1);
  });
});
