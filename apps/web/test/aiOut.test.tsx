// Out of AI formats (owner 2026-10-07, SPEC 11): a signed-in user with none left can still click "Learn with AI" - it opens ONE dialog
// (what the plan includes, the date they come back, that the free engine and the saved formats keep working; "Join the paid waitlist",
// "Learn without AI", "Close") - and the quiet hint under the buttons becomes a visible notice with the date and the waitlist. The Result
// screen's "Finish with AI" panel says it the same way, a 429 `limitHit aiLearns` at learn time (a race) opens the same dialog, and the
// account menu adds the date to "0 left". Nothing changes for whoever still has some left, or for a visitor. The renew date is the one
// the server counts by: the next UTC month (or day). A fake API and a fake worker: nothing real is called.
import { tiers, type Rules } from '@formatai/shared';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/api';
import { aiLeftLabel, aiRenewsAt, aiRenewText } from '../src/app/aiQuota';
import { createMemoryPendingStore, setPendingStore } from '../src/app/pendingLearn';
import { ordersRules } from '../src/editor/testkit';
import { translate } from '../src/i18n';
import type { LearnHost, LearnOutput } from '../src/worker/engineApi';
import { csv, fakeApi, fakeEngine, learnResult, renderApp, USER, type FakeApi } from './helpers/renderApp';

vi.mock('../src/app/redirect', () => ({ redirectTo: vi.fn() }));

// "Today" for every test here: the month's AI formats come back on 1 November (00:00 UTC, how the server counts months).
const NOW = new Date('2026-10-07T12:00:00Z');
const REG_AI = tiers.registered.aiLearns.count;

beforeEach(() => {
  document.cookie = 'lang=; Path=/; Max-Age=0';
  setPendingStore(createMemoryPendingStore());
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
  setPendingStore(undefined);
});

const SUMMARY = { rowsIn: 3, rowsOut: 3, rowsFiltered: 0, duplicatesRemoved: [], duplicatesFlagged: 0, blockedRows: [] };
const converted = (): unknown => ({ ok: true, bytes: new ArrayBuffer(8), flags: [], summary: SUMMARY, preview: { name: 'Out', direction: 'ltr', language: 'en', columns: [], rows: [], merges: [] }, totalRows: 3 });

/** The orders report as the free engine leaves it: `missing` have no rule (Total, Shipped and Remarks by default). */
function partialRules(missing: readonly string[] = ['Total', 'Shipped', 'Remarks']): Rules {
  const rules = ordersRules();
  rules.output.columns = rules.output.columns.map((c) => (missing.includes(c.header) ? { header: c.header, from: null } : c));
  rules.unsupported = [];
  rules.output.summaryRows = [];
  rules.transform.computed = [];
  rules.validations = [];
  rules.assumptions = [];
  return rules;
}

const partialOutput = (over: Record<string, unknown> = {}): LearnOutput =>
  learnResult({
    path: 'partial',
    rules: partialRules(),
    partial: { reason: 'aiNotAllowed' as const, solved: ['Item', 'Supplier', 'Qty'], needsAi: ['Total', 'Shipped', 'Remarks'], external: [], solvedColumns: [0, 1, 2], needsAiParts: [] },
    readiness: { ready: true },
    verification: { verified: false, matched: 30, total: 30, mismatches: [], layoutProblems: [], layoutIssues: [], repairProblems: [] },
    ...over,
  });

/** Every column has a rule, yet the free engine could not confirm the whole format: nothing is listed, and "Finish with AI" is still offered. */
function coveredOutput(): LearnOutput {
  const rules = partialRules([]);
  rules.output.columns = rules.output.columns.map((c) => (c.from === null ? { ...c, from: 'sku' } : c));
  return partialOutput({ rules, partial: { reason: 'aiNotAllowed' as const, solved: [], needsAi: [], external: [], solvedColumns: [0, 1, 2, 3, 4, 5], needsAiParts: [] } });
}

/** A fake engine: the first learn is `first`; a later one is `next` (given the flow's host, so it can call the API like the real worker). */
function engineWith(first: () => LearnOutput | Promise<LearnOutput> = () => partialOutput(), next: (host: LearnHost) => Promise<LearnOutput> = async () => learnResult({ path: 'llm' })) {
  const fake = fakeEngine(undefined, undefined, { convert: vi.fn(async () => converted()) });
  fake.learn.mockImplementation(async (_args: unknown, host: LearnHost) => (fake.learn.mock.calls.length > 1 ? next(host) : first()));
  return fake;
}

const noneLeft = (period: 'month' | 'day' | 'lifetime' = 'month') => ({ quota: vi.fn(async () => ({ remaining: 0, period })) });
const quotaRefused = (period: 'month' | 'day' | 'lifetime' = 'month') => vi.fn(async () => Promise.reject(new ApiError('limitHit', 429, { limit: 'aiLearns', period })));

async function dropFiles(lang: 'en' | 'he' = 'en') {
  const en = lang === 'en';
  fireEvent.change(screen.getByLabelText(en ? 'Example input' : 'דוגמת קלט'), { target: { files: [csv('orders.csv')] } });
  fireEvent.change(screen.getByLabelText(en ? 'Example output' : 'דוגמת פלט'), { target: { files: [csv('Orders report.csv')] } });
  await waitFor(() => expect(screen.getAllByText(/1,204/)).toHaveLength(2));
}
const learnAiButton = (name = 'Learn with AI') => screen.getByRole('button', { name }) as HTMLButtonElement;
const notice = () => screen.getByTestId('ai-out-notice');
const dialogNamed = (name: string) => screen.findByRole('dialog', { name });
const OUT_TITLE = "You've used your AI formats for this month";
/** Text with its non-breaking spaces (the date's) as plain ones. */
const flat = (el: Element): string => (el.textContent ?? '').replace(/\s+/g, ' ');
/** The dialog's own "Close" (the one in its header is the icon button with the same name). */
const closeIn = (dialog: HTMLElement) => within(dialog).getAllByRole('button', { name: 'Close' }).at(-1)!;

/** Signed in with none left, both files dropped, "Learn with AI" clickable. */
async function homeWithNoneLeft(over: { api?: FakeApi; engine?: ReturnType<typeof engineWith>; lang?: 'en' | 'he' } = {}) {
  const api = over.api ?? fakeApi({ user: USER, auth: noneLeft() });
  const fake = over.engine ?? engineWith();
  renderApp({ engine: fake.engine, api, ...(over.lang ? { lang: over.lang } : {}) });
  await dropFiles(over.lang);
  const name = over.lang === 'he' ? 'ללמוד עם AI' : 'Learn with AI';
  await waitFor(() => expect(learnAiButton(name).disabled).toBe(false));
  await waitFor(() => expect(notice()).toBeTruthy());
  return { api, ...fake };
}

describe('when the AI formats come back: the next period as the server counts it (UTC)', () => {
  it('a month: 00:00 UTC on the 1st of the next month, across a year too; a day: the next 00:00 UTC; never for lifetime or unlimited', () => {
    expect(aiRenewsAt('month', NOW)!.toISOString()).toBe('2026-11-01T00:00:00.000Z');
    expect(aiRenewsAt('month', new Date('2026-12-31T23:59:59Z'))!.toISOString()).toBe('2027-01-01T00:00:00.000Z');
    expect(aiRenewsAt('month', new Date('2026-11-01T00:00:00Z'))!.toISOString()).toBe('2026-12-01T00:00:00.000Z');
    expect(aiRenewsAt('day', NOW)!.toISOString()).toBe('2026-10-08T00:00:00.000Z');
    expect(aiRenewsAt('day', new Date('2026-10-31T23:30:00Z'))!.toISOString()).toBe('2026-11-01T00:00:00.000Z');
    expect(aiRenewsAt('lifetime', NOW)).toBeNull();
    expect(aiRenewsAt('unlimited', NOW)).toBeNull();
  });

  it('is exactly where the server key changes: the month (yyyy-mm, UTC) of the instant before is this one, of the instant itself the next', () => {
    for (const at of ['2026-01-31T23:00:00Z', '2026-02-15T00:00:00Z', '2026-10-07T12:00:00Z', '2026-12-01T00:00:00Z']) {
      const now = new Date(at);
      const renew = aiRenewsAt('month', now)!;
      expect(new Date(renew.getTime() - 1).toISOString().slice(0, 7)).toBe(now.toISOString().slice(0, 7));
      expect(renew.toISOString().slice(0, 7)).not.toBe(now.toISOString().slice(0, 7));
    }
  });

  it('says a month by its date (in UTC, in each language) and a day by the local time it comes back', () => {
    // (with a non-breaking space: the date never splits across two lines)
    expect(aiRenewText('en', 'month', NOW)).toBe('1 November');
    expect(aiRenewText('he', 'month', NOW)).toBe('1 בנובמבר');
    expect(aiRenewText('en', 'day', NOW)).toBe(new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' }).format(new Date('2026-10-08T00:00:00Z')));
    expect(aiRenewText('en', 'lifetime', NOW)).toBeNull();
  });

  it('"AI formats left" adds the date only when none are left', () => {
    const i18n = { lang: 'en' as const, t: (key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]) => translate('en', key, params) };
    expect(aiLeftLabel(i18n, { remaining: 2, period: 'month' }, NOW)).toBe('AI formats left this month: 2');
    expect(aiLeftLabel(i18n, { remaining: 0, period: 'month' }, NOW)).toBe('AI formats left this month: 0 · back on 1 November');
    expect(aiLeftLabel(i18n, { remaining: 0, period: 'lifetime' }, NOW)).toBe('AI formats left: 0');
    expect(aiLeftLabel(i18n, { remaining: null, period: 'unlimited' }, NOW)).toBe('AI formats: no limit');
  });
});

describe('Home, none left: "Learn with AI" opens one dialog', () => {
  it('the button is clickable and opens the dialog with the plan, the date they come back, and three ways on - nothing is learned', async () => {
    const { learn, api } = await homeWithNoneLeft();
    await act(async () => void fireEvent.click(learnAiButton()));
    const dialog = await dialogNamed(OUT_TITLE);
    expect(within(dialog).getByText(`Your plan includes ${REG_AI} AI formats a month. They come back on 1 November.`)).toBeTruthy();
    expect(within(dialog).getByText('You can still learn formats without AI, and every format you saved keeps working.')).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Join the paid waitlist' }).className).toContain('btn--primary');
    expect(within(dialog).getByRole('button', { name: 'Learn without AI' })).toBeTruthy();
    expect(closeIn(dialog).textContent).toBe('Close');
    expect(learn).not.toHaveBeenCalled();
    expect(api.learn).not.toHaveBeenCalled();
  });

  it('"Join the paid waitlist" opens the waitlist in the same dialog (the email filled in, the trigger the AI quota)', async () => {
    const { api } = await homeWithNoneLeft();
    await act(async () => void fireEvent.click(learnAiButton()));
    const dialog = await dialogNamed(OUT_TITLE);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Join the paid waitlist' }));
    const waitlist = await dialogNamed('Join the paid waitlist');
    expect(within(waitlist).getByText(/Paid plans are set up by our team for now/)).toBeTruthy();
    const email = within(waitlist).getByLabelText(/^Email/) as HTMLInputElement;
    await waitFor(() => expect(email.value).toBe('dana@example.com'));
    expect(document.activeElement).toBe(email);
    fireEvent.click(within(waitlist).getByRole('button', { name: 'Join the waitlist' }));
    expect(await within(waitlist).findByText(/You are on the list/)).toBeTruthy();
    expect(api.contact.waitlist).toHaveBeenCalledWith(expect.objectContaining({ email: 'dana@example.com', trigger: 'aiLearns' }));
  });

  it('"Learn without AI" runs the normal free learn of the two files, and no AI step follows it', async () => {
    const { learn, api } = await homeWithNoneLeft();
    await act(async () => void fireEvent.click(learnAiButton()));
    const dialog = await dialogNamed(OUT_TITLE);
    await act(async () => void fireEvent.click(within(dialog).getByRole('button', { name: 'Learn without AI' })));
    await screen.findByTestId('rules-map');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(learn).toHaveBeenCalledTimes(1);
    expect(learn.mock.calls[0]![0]).toMatchObject({ ai: 'notAllowed', tier: 'registered' });
    await new Promise((r) => setTimeout(r, 60));
    expect(learn).toHaveBeenCalledTimes(1);
    expect(api.learn).not.toHaveBeenCalled();
  });

  it('"Close" (and Escape) close it, nothing is learned, and the focus goes back to the button', async () => {
    const { learn } = await homeWithNoneLeft();
    learnAiButton().focus();
    await act(async () => void fireEvent.click(learnAiButton()));
    let dialog = await dialogNamed(OUT_TITLE);
    fireEvent.click(closeIn(dialog));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(learnAiButton());
    await act(async () => void fireEvent.click(learnAiButton()));
    dialog = await dialogNamed(OUT_TITLE);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(learn).not.toHaveBeenCalled();
  });

  it('is still off while a file is missing', async () => {
    renderApp({ engine: engineWith().engine, api: fakeApi({ user: USER, auth: noneLeft() }) });
    await waitFor(() => expect(notice()).toBeTruthy());
    expect(learnAiButton().disabled).toBe(true);
  });
});

describe('Home, none left: the hint is a visible notice', () => {
  it('"No AI formats left this month · back on 1 November" (amber), what the button is described by, with "Join the paid waitlist"', async () => {
    const { api } = await homeWithNoneLeft();
    const box = notice();
    expect(box.querySelector('.msg--warn')).toBeTruthy();
    const line = within(box).getByText('No AI formats left this month · back on 1 November');
    expect(learnAiButton().getAttribute('aria-describedby')).toBe(line.id);
    fireEvent.click(within(box).getByRole('button', { name: 'Join the paid waitlist' }));
    const panel = screen.getByRole('region', { name: 'Join the paid waitlist' });
    expect(within(panel).getByText(/Paid plans are set up by our team for now/)).toBeTruthy();
    await waitFor(() => expect((within(panel).getByLabelText(/^Email/) as HTMLInputElement).value).toBe('dana@example.com'));
    fireEvent.click(within(panel).getByRole('button', { name: 'Join the waitlist' }));
    await within(panel).findByText(/You are on the list/);
    expect(api.contact.waitlist).toHaveBeenCalledWith(expect.objectContaining({ trigger: 'aiLearns' }));
  });

  it('follows the period: a day says the time they come back, lifetime says only that none are left', async () => {
    await homeWithNoneLeft({ api: fakeApi({ user: USER, auth: noneLeft('day') }) });
    const time = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' }).format(new Date('2026-10-08T00:00:00Z'));
    expect(within(notice()).getByText(`No AI formats left today · back at ${time}`)).toBeTruthy();
    await act(async () => void fireEvent.click(learnAiButton()));
    const dialog = await dialogNamed("You've used your AI formats for today");
    expect(within(dialog).getByText(`Your plan includes ${REG_AI} AI formats a day. They come back at ${time}.`)).toBeTruthy();
    cleanup();
    await homeWithNoneLeft({ api: fakeApi({ user: USER, auth: noneLeft('lifetime') }) });
    expect(within(notice()).getByText('No AI formats left')).toBeTruthy();
    await act(async () => void fireEvent.click(learnAiButton()));
    const life = await dialogNamed("You've used your AI formats");
    expect(within(life).getByText(`Your plan includes ${REG_AI} AI formats.`)).toBeTruthy();
  });

  it('a paid plan is not offered the waitlist it is already past', async () => {
    await homeWithNoneLeft({ api: fakeApi({ user: { ...USER, tier: 'paid' }, auth: noneLeft() }) });
    expect(within(notice()).queryByRole('button', { name: 'Join the paid waitlist' })).toBeNull();
    await act(async () => void fireEvent.click(learnAiButton()));
    const dialog = await dialogNamed(OUT_TITLE);
    expect(within(dialog).getByText(`Your plan includes ${tiers.paid.aiLearns.count} AI formats a month. They come back on 1 November.`)).toBeTruthy();
    expect(within(dialog).queryByRole('button', { name: 'Join the paid waitlist' })).toBeNull();
    expect(within(dialog).getByRole('button', { name: 'Learn without AI' }).className).toContain('btn--primary');
  });
});

describe('unchanged for whoever still has some, and for a visitor', () => {
  it('some left: the quiet hint as before, no notice, and "Learn with AI" learns at once (no dialog)', async () => {
    const fake = engineWith();
    renderApp({ engine: fake.engine, api: fakeApi({ user: USER }) });
    await dropFiles();
    await waitFor(() => expect(screen.getByTestId('learn-ai-hint').textContent).toBe('Uses 1 AI format (3 left this month), and only if it succeeds.'));
    expect(screen.getByTestId('learn-ai-hint').className).toBe('learn-row__hint');
    expect(screen.queryByTestId('ai-out-notice')).toBeNull();
    await act(async () => void fireEvent.click(learnAiButton()));
    await screen.findByTestId('rules-map');
    expect(screen.queryByRole('dialog', { name: OUT_TITLE })).toBeNull();
    expect(fake.learn.mock.calls[0]![0]).toMatchObject({ ai: 'notAllowed', tier: 'registered' });
  });

  it('a visitor: "Learn with AI" asks to sign in, as before - no out-of-AI-formats dialog or notice', async () => {
    const fake = engineWith();
    renderApp({ engine: fake.engine, api: fakeApi() });
    await dropFiles();
    expect(screen.getByTestId('learn-ai-hint').textContent).toBe(`Sign in free to learn with AI (${REG_AI} AI formats a month included).`);
    await waitFor(() => expect(learnAiButton().disabled).toBe(false));
    fireEvent.click(learnAiButton());
    const wall = await dialogNamed('Sign in');
    expect(within(wall).getByText('Sign in free to finish this with the AI step.')).toBeTruthy();
    expect(screen.queryByRole('dialog', { name: OUT_TITLE })).toBeNull();
    expect(screen.queryByTestId('ai-out-notice')).toBeNull();
    expect(fake.learn).not.toHaveBeenCalled();
  });
});

describe('the Result screen: "Finish with AI" with none left', () => {
  it('the panel says it with the same notice (the date, the waitlist) where the run would be offered', async () => {
    const { learn } = await homeWithNoneLeft();
    await act(async () => void fireEvent.click(screen.getByRole('button', { name: /Learn the format/ })));
    await screen.findByTestId('rules-map');
    const panel = screen.getByTestId('deep-panel');
    const box = within(panel).getByTestId('ai-out-notice');
    expect(within(box).getByText('No AI formats left this month · back on 1 November')).toBeTruthy();
    expect(within(box).getByRole('button', { name: 'Join the paid waitlist' })).toBeTruthy();
    expect(within(panel).queryByRole('button', { name: 'Finish with AI' })).toBeNull();
    expect(learn).toHaveBeenCalledTimes(1);
  });

  it('where "Finish with AI" is still shown (nothing listed), it opens the dialog - without "Learn without AI", the free result being on screen', async () => {
    const { learn } = await homeWithNoneLeft({ engine: engineWith(coveredOutput) });
    await act(async () => void fireEvent.click(screen.getByRole('button', { name: /Learn the format/ })));
    await screen.findByTestId('rules-map');
    const run = screen.getByRole('button', { name: 'Finish with AI' }) as HTMLButtonElement;
    expect(run.disabled).toBe(false);
    fireEvent.click(run);
    const dialog = await dialogNamed(OUT_TITLE);
    expect(within(dialog).getByText(`Your plan includes ${REG_AI} AI formats a month. They come back on 1 November.`)).toBeTruthy();
    expect(within(dialog).queryByRole('button', { name: 'Learn without AI' })).toBeNull();
    expect(within(dialog).getByRole('button', { name: 'Join the paid waitlist' })).toBeTruthy();
    fireEvent.click(closeIn(dialog));
    expect(learn).toHaveBeenCalledTimes(1);
  });
});

describe('a 429 limitHit aiLearns at learn time (the quota was used up elsewhere meanwhile)', () => {
  it('"Finish with AI" refused: the same dialog, the panel shows the notice (not an error), and the known quota is 0 with its date', async () => {
    const api = fakeApi({ user: USER, learn: quotaRefused() });
    const fake = engineWith(undefined, async (host) => {
      await host.callLearn({ masking: true } as never);
      return learnResult({ path: 'llm' });
    });
    renderApp({ engine: fake.engine, api });
    await dropFiles();
    await act(async () => void fireEvent.click(screen.getByRole('button', { name: /Learn the format/ })));
    await screen.findByTestId('rules-map');
    await waitFor(() => expect(screen.getByTestId('deep-uses').textContent).toBe('Uses 1 AI format (3 left this month), and only if it succeeds.'));
    await act(async () => void fireEvent.click(screen.getByRole('button', { name: 'Finish with AI' })));
    const dialog = await dialogNamed(OUT_TITLE);
    expect(api.learn).toHaveBeenCalledTimes(1);
    expect(within(dialog).queryByRole('button', { name: 'Learn without AI' })).toBeNull();
    fireEvent.click(closeIn(dialog));
    const panel = screen.getByTestId('deep-panel');
    expect(flat(within(panel).getByTestId('ai-out-notice'))).toContain('No AI formats left this month · back on 1 November');
    expect(within(panel).queryByTestId('completion-error')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Account menu for Dana Levi' }));
    expect(flat(await screen.findByRole('group', { name: 'Account' }))).toContain('AI formats left this month: 0 · back on 1 November');
  });

  it('a whole learn refused: back to the form with both files and the dialog - "Learn without AI" then runs the free learn', async () => {
    const api = fakeApi({ user: USER, learn: quotaRefused() });
    // (the first learn reaches the API, like a whole "Finish with AI" learn; the next one is the free engine's)
    const fake = fakeEngine(undefined, undefined, { convert: vi.fn(async () => converted()) });
    fake.learn.mockImplementation(async (_args: unknown, host: LearnHost) => {
      if (fake.learn.mock.calls.length === 1) await host.callLearn({ masking: true } as never);
      return learnResult({ path: 'local' });
    });
    renderApp({ engine: fake.engine, api });
    await dropFiles();
    await act(async () => void fireEvent.click(screen.getByRole('button', { name: /Learn the format/ })));
    const dialog = await dialogNamed(OUT_TITLE);
    expect(within(dialog).getByText(`Your plan includes ${REG_AI} AI formats a month. They come back on 1 November.`)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Change files' })).toBeNull();
    expect(screen.getAllByText(/1,204/)).toHaveLength(2);
    await act(async () => void fireEvent.click(within(dialog).getByRole('button', { name: 'Learn without AI' })));
    await screen.findByTestId('rules-map');
    expect(fake.learn).toHaveBeenCalledTimes(2);
    expect(fake.learn.mock.calls[1]![0]).toMatchObject({ ai: 'notAllowed' });
  });
});

describe('the account menu', () => {
  it('"0 left" says when they come back', async () => {
    renderApp({ api: fakeApi({ user: USER, auth: noneLeft() }) });
    fireEvent.click(await screen.findByRole('button', { name: 'Account menu for Dana Levi' }));
    const panel = await screen.findByRole('group', { name: 'Account' });
    await waitFor(() => expect(flat(panel)).toContain('AI formats left this month: 0 · back on 1 November'));
  });
});

describe('in Hebrew', () => {
  it('the notice, the dialog and its buttons, and the account menu', async () => {
    await homeWithNoneLeft({ lang: 'he' });
    expect(within(notice()).getByText('לא נותרו פורמטים עם AI החודש · יתחדשו ב-1 בנובמבר')).toBeTruthy();
    expect(within(notice()).getByRole('button', { name: 'הצטרפות לרשימת ההמתנה לתוכנית בתשלום' })).toBeTruthy();
    await act(async () => void fireEvent.click(learnAiButton('ללמוד עם AI')));
    const dialog = await dialogNamed('ניצלתם את הפורמטים עם AI של החודש');
    expect(within(dialog).getByText(`התוכנית שלכם כוללת ${REG_AI} פורמטים עם AI בחודש. הם יתחדשו ב-1 בנובמבר.`)).toBeTruthy();
    expect(within(dialog).getByText('אפשר עדיין ללמוד פורמטים בלי AI, וכל פורמט ששמרתם ממשיך לעבוד.')).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'הצטרפות לרשימת ההמתנה לתוכנית בתשלום' })).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'ללמוד בלי AI' })).toBeTruthy();
    fireEvent.click(within(dialog).getAllByRole('button', { name: 'סגירה' }).at(-1)!);
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'תפריט החשבון של Dana Levi' }));
    expect(flat(await screen.findByRole('group', { name: 'חשבון' }))).toContain('פורמטים עם AI שנותרו החודש: 0 · יתחדשו ב-1 בנובמבר');
  });
});
