// The admin view (SPEC 14.2, M4): /admin renders for an admin only, the nav entry is drawn for an admin only, the overview shows the server's
// numbers ("n/a" where they are not known), function requests offer the GitHub issue once and can be marked, the users list sets a plan and a
// limit, leads and feedback read as text - and all of it in Hebrew. A fake API; the server is what really enforces access (apps/api/test/admin).
import type { AdminAuditEntry, AdminContact, AdminFunctionRequest, AdminOverview, AdminUserRow, MeUser } from '@formatai/shared';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/api';
import type { AdminApi } from '../src/api/admin';
import { createMemoryPendingStore, setPendingStore } from '../src/app/pendingLearn';
import { fakeApi, renderApp, USER } from './helpers/renderApp';

beforeEach(() => {
  document.cookie = 'lang=; Path=/; Max-Age=0';
  setPendingStore(createMemoryPendingStore());
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  setPendingStore(undefined);
});

const ADMIN_USER: MeUser = { ...USER, id: 'admin1', name: 'The Boss', email: 'boss@example.com', isAdmin: true };

function overview(over: Partial<AdminOverview> = {}): AdminOverview {
  return {
    days: 30,
    from: '2026-09-06',
    to: '2026-10-05',
    users: { total: 12, registered: 10, paid: 2, newInPeriod: 4, activeInPeriod: 7 },
    learns: { ai: 9, aiVerified: 6, aiFailed: 2, aiErrored: 1, cache: 3, local: null },
    conversions: { formats: 8, formatsNew: 2, ranInPeriod: 5, runsAllTime: 41 },
    llm: {
      calls: 14,
      costUsd: 0.0425,
      unpriced: 2,
      fallbackCalls: 3,
      byDay: [
        { day: '2026-10-03', aiCalls: 4, costUsd: 0.01 },
        { day: '2026-10-04', aiCalls: 6, costUsd: 0.0325 },
        { day: '2026-10-05', aiCalls: 2, costUsd: null },
      ],
      byModel: [
        { model: 'claude-haiku-4-5', calls: 10, inputTokens: 12000, outputTokens: 3000, costUsd: 0.0425, unpriced: 0 },
        { model: 'mystery-model', calls: 2, inputTokens: 900, outputTokens: 100, costUsd: null, unpriced: 2 },
      ],
    },
    problems: [
      { kind: 'formula', count: 7 },
      { kind: 'diff', count: 2 },
    ],
    functionRequests: { groups: 3, requests: 24, atThreshold: 1, issueOpened: 1, newInPeriod: 2 },
    events: [{ type: 'signed_up', count: 4 }],
    ...over,
  };
}

function request(over: Partial<AdminFunctionRequest> = {}): AdminFunctionRequest {
  return {
    id: 'fr1',
    name: 'lookupStorageSite',
    purpose: 'Finds the storage site of an item from an external reference table.',
    signature: 'lookupStorageSite(item: text): text',
    args: [{ name: 'item', type: 'text' }],
    returns: 'text',
    topic: 'lookups',
    count: 9,
    distinctOwners: 6,
    firstSeen: '2026-10-01T00:00:00.000Z',
    lastSeen: '2026-10-04T00:00:00.000Z',
    status: 'new',
    atThreshold: true,
    issueUrl: 'https://github.com/mordaby/formatAi/issues/new?title=Function%20request&body=Name',
    ...over,
  };
}

function userRow(over: Partial<AdminUserRow> = {}): AdminUserRow {
  return {
    id: 'u1',
    name: 'Dana Levi',
    emails: ['dana@example.com'],
    providers: ['google'],
    tier: 'registered',
    createdAt: '2026-10-01T08:00:00.000Z',
    lastSeenAt: '2026-10-04T08:00:00.000Z',
    aiLearns: { used: 2, limit: 3, period: 'month' },
    formats: 2,
    limitOverrides: {},
    ...over,
  };
}

function adminApi(over: Partial<AdminApi> = {}): { [K in keyof AdminApi]: ReturnType<typeof vi.fn> } & AdminApi {
  return {
    overview: vi.fn(async () => overview()),
    functionRequests: vi.fn(async () => ({ requests: [], threshold: 5 })),
    setFunctionRequestStatus: vi.fn(async (id: string, status: 'new' | 'issueOpened') => request({ id, status, issueUrl: undefined })),
    users: vi.fn(async () => ({ users: [userRow()], total: 1, page: 1, pageSize: 25 })),
    updateUser: vi.fn(async (_id: string, body) => userRow({ ...(body.tier ? { tier: body.tier } : {}) })),
    contacts: vi.fn(async () => []),
    audit: vi.fn(async () => []),
    ...over,
  } as never;
}

const adminApp = (admin: AdminApi, route = '/admin', lang: 'en' | 'he' = 'en', user: MeUser | null = ADMIN_USER) =>
  renderApp({ lang, route, api: fakeApi({ user, admin }) });

describe('the nav entry', () => {
  it('is drawn for an admin, in the header and in the account menu', async () => {
    adminApp(adminApi(), '/');
    const link = await screen.findByRole('link', { name: 'Admin' });
    expect(link.getAttribute('href')).toBe('/admin');
    fireEvent.click(screen.getByRole('button', { name: /Account menu/ }));
    expect(screen.getAllByRole('link', { name: 'Admin' })).toHaveLength(2);
  });

  it('is never drawn for a user who is not an admin, nor for a visitor', async () => {
    const view = adminApp(adminApi(), '/', 'en', USER);
    await screen.findByRole('link', { name: 'My formats' });
    expect(screen.queryByRole('link', { name: 'Admin' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Account menu/ }));
    expect(screen.queryByRole('link', { name: 'Admin' })).toBeNull();
    view.unmount();

    adminApp(adminApi(), '/', 'en', null);
    await screen.findByRole('button', { name: 'Sign in' });
    expect(screen.queryByRole('link', { name: 'Admin' })).toBeNull();
  });
});

describe('/admin access', () => {
  it('renders for an admin', async () => {
    const admin = adminApi();
    adminApp(admin);
    expect(await screen.findByRole('heading', { name: 'Admin', level: 1 })).toBeTruthy();
    expect(screen.getByRole('navigation', { name: 'Admin sections' })).toBeTruthy();
    await waitFor(() => expect(admin.overview).toHaveBeenCalledWith(30, expect.anything()));
  });

  it('sends a signed-in user who is not an admin home, asking the server for nothing', async () => {
    const admin = adminApi();
    adminApp(admin, '/admin', 'en', USER);
    expect(await screen.findByText('Show us one example')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Admin' })).toBeNull();
    expect(admin.overview).not.toHaveBeenCalled();
  });

  it('sends a visitor home too', async () => {
    const admin = adminApi();
    adminApp(admin, '/admin', 'en', null);
    expect(await screen.findByText('Show us one example')).toBeTruthy();
    expect(admin.overview).not.toHaveBeenCalled();
  });

  it('says so when the server refuses (a stale session): an error with a way to try again, never the numbers', async () => {
    const overviewCall = vi.fn().mockRejectedValueOnce(new ApiError('forbidden', 403)).mockResolvedValue(overview());
    adminApp(adminApi({ overview: overviewCall }));
    expect(await screen.findByText("We couldn't load this. Try again.")).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByText('Users with an account');
  });
});

/** The row of a stat table by its label (a column header may say the same words). */
function rowByLabel(label: string): HTMLElement {
  const th = [...document.querySelectorAll('tbody th[scope="row"]')].find((el) => el.textContent === label);
  if (!th) throw new Error(`no row labelled "${label}"`);
  return th.closest('tr')!;
}

describe('the overview', () => {
  it("shows the server's numbers, and n/a where they are not known", async () => {
    adminApp(adminApi());
    await screen.findByText('Users with an account');
    const row = rowByLabel;

    expect(within(row('Users with an account')).getByText('12')).toBeTruthy();
    expect(within(row('New sign-ups')).getByText('4')).toBeTruthy();
    expect(within(row('Learned with the AI step')).getByText('9')).toBeTruthy();
    expect(within(row('passed the server checks')).getByText('6')).toBeTruthy();
    expect(within(row('answered, but did not pass the checks')).getByText('2')).toBeTruthy();
    expect(within(row('Answered from the saved structure (no AI call)')).getByText('3')).toBeTruthy();
    // learns done on the computer are not known to the server: n/a, never 0
    expect(within(row("Solved on the person's own computer")).getByText('n/a')).toBeTruthy();
    expect(within(row('Runs, all time')).getByText('41')).toBeTruthy();
    expect(within(row('AI calls')).getByText('14')).toBeTruthy();
    expect(within(row('Estimated cost')).getByText('$0.0425')).toBeTruthy();
    expect(within(row('Calls made by the fallback provider')).getByText('3')).toBeTruthy();
    expect(screen.getByText(/2 calls have no price estimate/)).toBeTruthy();

    // per model: an unpriced model is n/a
    const models = screen.getByText('mystery-model').closest('tr')!;
    expect(within(models).getByText('n/a')).toBeTruthy();
    expect(within(screen.getByText('claude-haiku-4-5').closest('tr')!).getByText('$0.0425')).toBeTruthy();

    // problems and function requests
    expect(within(screen.getByText('formula').closest('tr')!).getByText('7')).toBeTruthy();
    expect(within(row('GitHub issue opened')).getByText('1')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'See the requests' }).getAttribute('href')).toBe('/admin?tab=requests');
    expect(within(row('signed_up')).getByText('4')).toBeTruthy();
  });

  it('draws one small chart of the estimated cost per day, named and with the same numbers in a table', async () => {
    adminApp(adminApi());
    const chart = await screen.findByRole('img', { name: /Estimated AI cost per day, 2026-09-06 to 2026-10-05\. Highest day: \$0\.0325/ });
    expect(chart.querySelectorAll('.chart__bar')).toHaveLength(2); // the day with no priced call has no bar
    expect(chart.querySelector('[data-day="2026-10-04"] title')!.textContent).toBe('2026-10-04: 6 calls, $0.0325');
    expect(chart.querySelector('[data-day="2026-10-05"] title')!.textContent).toBe('2026-10-05: 2 calls, n/a');
    expect(screen.getAllByRole('img')).toHaveLength(1);
    // the table view
    const details = screen.getByText('Show the numbers by day').closest('details')!;
    expect(within(details).getByText('2026-10-04')).toBeTruthy();
  });

  it('says there is no chart when no call is priced', async () => {
    adminApp(adminApi({ overview: vi.fn(async () => overview({ llm: { calls: 0, costUsd: null, unpriced: 0, fallbackCalls: 0, byDay: [{ day: '2026-10-05', aiCalls: 0, costUsd: null }], byModel: [] } })) }));
    expect(await screen.findByText('No priced AI calls in this period.')).toBeTruthy();
    expect(screen.queryByRole('img')).toBeNull();
    expect(within(rowByLabel('Estimated cost')).getByText('n/a')).toBeTruthy();
  });

  it('shows the local learns when the server knows them, and switches the time range', async () => {
    const overviewCall = vi.fn(async (days: number) => overview({ days, learns: { ai: 1, aiVerified: 1, aiFailed: 0, aiErrored: 0, cache: 0, local: 17 } }));
    adminApp(adminApi({ overview: overviewCall }));
    await screen.findByText('17');
    expect(screen.getByRole('button', { name: 'Last 30 days' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Last 7 days' }));
    await waitFor(() => expect(overviewCall).toHaveBeenCalledWith(7, expect.anything()));
    expect(screen.getByRole('button', { name: 'Last 7 days' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'Last 90 days' })).toBeTruthy();
  });
});

describe('function requests', () => {
  const open = async (admin: AdminApi): Promise<void> => {
    adminApp(admin, '/admin?tab=requests');
    await screen.findByTestId('fr-table');
  };
  const rowOf = (name: string): HTMLElement => screen.getAllByTestId('fr-row').find((r) => r.getAttribute('data-name') === name)!;

  it('lists each group with its signature, purpose, topic, counts and dates', async () => {
    await open(adminApi({ functionRequests: vi.fn(async () => ({ requests: [request()], threshold: 5 })) }));
    const row = rowOf('lookupStorageSite');
    expect(within(row).getByText('lookupStorageSite(item: text): text')).toBeTruthy();
    expect(within(row).getByText('Finds the storage site of an item from an external reference table.')).toBeTruthy();
    expect(within(row).getByText('lookups')).toBeTruthy();
    expect(within(row).getByText('9')).toBeTruthy();
    expect(within(row).getByText('6')).toBeTruthy();
    expect(within(row).getByText('2026-10-01')).toBeTruthy();
    expect(within(row).getByText('2026-10-04')).toBeTruthy();
    expect(screen.getByText(/When 5 different people have asked/)).toBeTruthy();
  });

  it('offers "Open GitHub issue" at the threshold as a link that opens in a new tab, and nothing below it', async () => {
    await open(
      adminApi({
        functionRequests: vi.fn(async () => ({
          requests: [request(), request({ id: 'fr2', name: 'quarterOfDate', signature: 'quarterOfDate(when: date): integer', distinctOwners: 2, atThreshold: false, issueUrl: undefined })],
          threshold: 5,
        })),
      }),
    );
    const link = within(rowOf('lookupStorageSite')).getByRole('link', { name: 'Open GitHub issue' });
    expect(link.getAttribute('href')).toBe('https://github.com/mordaby/formatAi/issues/new?title=Function%20request&body=Name');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toContain('noopener');

    const low = rowOf('quarterOfDate');
    expect(within(low).queryByRole('link', { name: 'Open GitHub issue' })).toBeNull();
    expect(within(low).getByText('3 more people needed')).toBeTruthy();
  });

  it('marks a group as "issue opened" so it is not offered twice, and can offer it again', async () => {
    const setStatus = vi.fn(async (id: string, status: 'new' | 'issueOpened') => request({ id, status, issueUrl: status === 'new' ? 'https://github.com/mordaby/formatAi/issues/new?title=x&body=y' : undefined }));
    await open(adminApi({ functionRequests: vi.fn(async () => ({ requests: [request()], threshold: 5 })), setFunctionRequestStatus: setStatus }));

    fireEvent.click(within(rowOf('lookupStorageSite')).getByRole('button', { name: 'Mark as opened' }));
    await waitFor(() => expect(within(rowOf('lookupStorageSite')).queryByRole('link', { name: 'Open GitHub issue' })).toBeNull());
    expect(setStatus).toHaveBeenCalledWith('fr1', 'issueOpened');
    expect(within(rowOf('lookupStorageSite')).getByText('Issue opened')).toBeTruthy();

    fireEvent.click(within(rowOf('lookupStorageSite')).getByRole('button', { name: 'Offer again' }));
    await waitFor(() => expect(within(rowOf('lookupStorageSite')).getByRole('link', { name: 'Open GitHub issue' })).toBeTruthy());
    expect(setStatus).toHaveBeenLastCalledWith('fr1', 'new');
  });

  it('says so when saving the mark fails, and keeps the offer', async () => {
    const setStatus = vi.fn().mockRejectedValue(new ApiError('server', 500));
    await open(adminApi({ functionRequests: vi.fn(async () => ({ requests: [request()], threshold: 5 })), setFunctionRequestStatus: setStatus }));
    fireEvent.click(within(rowOf('lookupStorageSite')).getByRole('button', { name: 'Mark as opened' }));
    expect(await screen.findByText("We couldn't save that. Try again.")).toBeTruthy();
    expect(within(rowOf('lookupStorageSite')).getByRole('link', { name: 'Open GitHub issue' })).toBeTruthy();
  });

  it('says so when there are none', async () => {
    adminApp(adminApi(), '/admin?tab=requests');
    expect(await screen.findByTestId('fr-empty')).toBeTruthy();
  });
});

describe('users', () => {
  const open = async (admin: AdminApi): Promise<void> => {
    adminApp(admin, '/admin?tab=users');
    await screen.findByTestId('users-table');
  };

  it('lists users with plan, joined date, AI learns used against the limit, and formats', async () => {
    await open(
      adminApi({
        users: vi.fn(async () => ({
          users: [userRow(), userRow({ id: 'u2', name: 'Noa Peretz', emails: ['noa@corp.example'], tier: 'paid', aiLearns: { used: 40, limit: 400, period: 'month' }, limitOverrides: { aiLearns: 400 }, formats: 7 })],
          total: 2,
          page: 1,
          pageSize: 25,
        })),
      }),
    );
    const [dana, noa] = screen.getAllByTestId('user-row');
    expect(within(dana!).getByText('Dana Levi')).toBeTruthy();
    expect(within(dana!).getByText('dana@example.com')).toBeTruthy();
    expect(within(dana!).getByText('Free plan')).toBeTruthy();
    expect(within(dana!).getByText('2026-10-01')).toBeTruthy();
    expect(within(dana!).getByText('2 of 3 this month')).toBeTruthy();
    expect(within(noa!).getByText('Paid plan')).toBeTruthy();
    expect(within(noa!).getByText('40 of 400 this month')).toBeTruthy();
    expect(within(noa!).getByText('(custom limit)')).toBeTruthy();
    expect(screen.getByTestId('users-count').textContent).toBe('2 users');
  });

  it('searches by email or name', async () => {
    const users = vi.fn(async () => ({ users: [userRow()], total: 1, page: 1, pageSize: 25 }));
    await open(adminApi({ users }));
    fireEvent.change(screen.getByLabelText('Search by email or name'), { target: { value: '  dana@ ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    await waitFor(() => expect(users).toHaveBeenLastCalledWith({ q: 'dana@', page: 1 }, expect.anything()));
  });

  it('pages a long list', async () => {
    const users = vi.fn(async ({ page }: { page: number }) => ({ users: [userRow({ name: `Page ${page} user` })], total: 60, page, pageSize: 25 }));
    await open(adminApi({ users }));
    expect(screen.getByText('Page 1 of 3')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Previous' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText('Page 2 user')).toBeTruthy();
    expect(users).toHaveBeenLastCalledWith({ q: '', page: 2 }, expect.anything());
  });

  it("sets the plan, sending only what changed, and shows the server's answer", async () => {
    const updateUser = vi.fn(async (_id: string, _body: unknown) => userRow({ tier: 'paid', aiLearns: { used: 2, limit: 150, period: 'month' } }));
    await open(adminApi({ updateUser }));
    fireEvent.click(screen.getByRole('button', { name: 'Edit: Dana Levi' }));
    const editor = screen.getByTestId('user-editor');
    fireEvent.change(within(editor).getByLabelText('Plan'), { target: { value: 'paid' } });
    fireEvent.click(within(editor).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByTestId('user-editor')).toBeNull());
    expect(updateUser).toHaveBeenCalledWith('u1', { tier: 'paid' });
    const row = screen.getByTestId('user-row');
    expect(within(row).getByText('Paid plan')).toBeTruthy();
    expect(within(row).getByText('2 of 150 this month')).toBeTruthy();
  });

  it('sets and clears the AI-learn limit, and refuses a value that is not a whole number', async () => {
    const updateUser = vi.fn(async (_id: string, body: { limitOverrides?: Record<string, number> | null }) =>
      userRow({ limitOverrides: body.limitOverrides ?? {}, aiLearns: { used: 2, limit: body.limitOverrides?.aiLearns ?? 3, period: 'month' } }),
    );
    await open(adminApi({ updateUser }));

    fireEvent.click(screen.getByRole('button', { name: 'Edit: Dana Levi' }));
    const input = within(screen.getByTestId('user-editor')).getByLabelText('AI learns per period');
    expect(screen.getByText("Leave empty for the plan's own number (3).")).toBeTruthy();
    fireEvent.change(input, { target: { value: '1.5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Enter a whole number, or leave it empty.')).toBeTruthy();
    expect(updateUser).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: '12' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByTestId('user-editor')).toBeNull());
    expect(updateUser).toHaveBeenLastCalledWith('u1', { limitOverrides: { aiLearns: 12 } });
    expect(screen.getByText('(custom limit)')).toBeTruthy();

    // an empty field takes the override away
    fireEvent.click(screen.getByRole('button', { name: 'Edit: Dana Levi' }));
    fireEvent.change(within(screen.getByTestId('user-editor')).getByLabelText('AI learns per period'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByTestId('user-editor')).toBeNull());
    expect(updateUser).toHaveBeenLastCalledWith('u1', { limitOverrides: null });
  });

  it('sends nothing when nothing changed, and says so when saving fails', async () => {
    const updateUser = vi.fn().mockRejectedValue(new ApiError('server', 500));
    await open(adminApi({ updateUser }));
    fireEvent.click(screen.getByRole('button', { name: 'Edit: Dana Levi' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByTestId('user-editor')).toBeNull());
    expect(updateUser).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Edit: Dana Levi' }));
    fireEvent.change(within(screen.getByTestId('user-editor')).getByLabelText('Plan'), { target: { value: 'paid' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText("We couldn't save that. Try again.")).toBeTruthy();
    expect(screen.getByTestId('user-editor')).toBeTruthy(); // still open: nothing is lost
  });

  it('has no way to delete a user, and none to make one anonymous', async () => {
    await open(adminApi());
    fireEvent.click(screen.getByRole('button', { name: 'Edit: Dana Levi' }));
    expect(screen.queryByRole('button', { name: /delete|remove/i })).toBeNull();
    const plan = within(screen.getByTestId('user-editor')).getByLabelText('Plan') as HTMLSelectElement;
    expect([...plan.options].map((o) => o.value)).toEqual(['registered', 'paid']);
  });

  it('shows the audit log under the list, and reads it again after a change', async () => {
    const entry = (over: Partial<AdminAuditEntry> = {}): AdminAuditEntry => ({
      id: 'a1',
      ts: '2026-10-05T12:30:00.000Z',
      adminId: 'admin1',
      adminEmail: 'boss@example.com',
      action: 'user.tier',
      targetKind: 'user',
      targetId: 'u1',
      targetLabel: 'dana@example.com',
      before: 'registered',
      after: 'paid',
      ...over,
    });
    const audit = vi.fn().mockResolvedValueOnce([entry({ id: 'a0', action: 'user.limitOverrides', before: null, after: { aiLearns: 10 } })]).mockResolvedValue([entry(), entry({ id: 'a0', action: 'user.limitOverrides', before: null, after: { aiLearns: 10 } })]);
    await open(adminApi({ audit }));
    const list = await screen.findByTestId('audit-list');
    expect(list.textContent).toContain('boss@example.com changed the limits of dana@example.com: plan default → AI learns 10');
    expect(list.textContent).toContain('2026-10-05 12:30 UTC');

    fireEvent.click(screen.getByRole('button', { name: 'Edit: Dana Levi' }));
    fireEvent.change(within(screen.getByTestId('user-editor')).getByLabelText('Plan'), { target: { value: 'paid' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.getByTestId('audit-list').textContent).toContain('boss@example.com changed the plan of dana@example.com: Free plan → Paid plan'));
  });
});

describe('leads and feedback', () => {
  const lead: AdminContact = { id: 'l1', source: 'lead', createdAt: '2026-10-04T00:00:00.000Z', kind: 'business', name: 'Sam', email: 'sam@big.example', company: 'Big Co', role: 'CFO', message: 'We get <b>40</b> supplier files a month.', page: '/business' };
  const feedback: AdminContact = { id: 'f1', source: 'feedback', createdAt: '2026-10-03T00:00:00.000Z', kind: 'feedback', message: 'Nice.', rating: 4 };

  it('lists them read-only, the message as plain text', async () => {
    adminApp(adminApi({ contacts: vi.fn(async () => [lead, feedback]) }), '/admin?tab=inbox');
    await screen.findByTestId('inbox-table');
    const [first, second] = screen.getAllByTestId('inbox-row');
    expect(within(first!).getByText('We get <b>40</b> supplier files a month.')).toBeTruthy(); // shown as typed, never as markup
    expect(first!.querySelector('b')).toBeNull();
    expect(within(first!).getByText('Lead')).toBeTruthy();
    expect(within(first!).getByText('Sam')).toBeTruthy();
    expect(within(first!).getByText('sam@big.example')).toBeTruthy();
    expect(within(first!).getByText('/business')).toBeTruthy();
    expect(within(second!).getByText('Feedback')).toBeTruthy();
    expect(within(second!).getByText(/Rating 4/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /delete|edit|reply/i })).toBeNull();
  });

  it('says so when there is nothing yet', async () => {
    adminApp(adminApi(), '/admin?tab=inbox');
    expect(await screen.findByText('Nothing yet.')).toBeTruthy();
  });
});

describe('Hebrew', () => {
  it('has the nav entry, the page and every tab in Hebrew, right to left', async () => {
    adminApp(adminApi(), '/', 'he');
    const link = await screen.findByRole('link', { name: 'ניהול' });
    expect(link.getAttribute('href')).toBe('/admin');
    expect(document.documentElement.dir).toBe('rtl');
    fireEvent.click(link);

    expect(await screen.findByRole('heading', { name: 'ניהול', level: 1 })).toBeTruthy();
    const tabs = screen.getByRole('navigation', { name: 'חלקי הניהול' });
    expect(within(tabs).getAllByRole('button').map((b) => b.textContent)).toEqual(['סקירה', 'בקשות לפונקציות', 'משתמשים', 'פניות ומשוב']);
    expect(await screen.findByText('משתמשים עם חשבון')).toBeTruthy();
    // "not known" is said in words, not as 0
    expect(within(screen.getByText('נפתרו במחשב של המשתמש').closest('tr')!).getByText('לא ידוע')).toBeTruthy();
    expect(screen.getByRole('button', { name: '30 הימים האחרונים' })).toBeTruthy();

    fireEvent.click(within(tabs).getByRole('button', { name: 'משתמשים' }));
    expect(await screen.findByLabelText('חיפוש לפי אימייל או שם')).toBeTruthy();
    expect(await screen.findByText('תוכנית חינמית')).toBeTruthy();
    expect(screen.getByText('2 מתוך 3 החודש')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'עריכה: Dana Levi' }));
    expect(screen.getByRole('button', { name: 'שמירה' })).toBeTruthy();

    fireEvent.click(within(tabs).getByRole('button', { name: 'בקשות לפונקציות' }));
    expect(await screen.findByText('עדיין אין בקשות לפונקציות.')).toBeTruthy();
  });

  it('says the function-request actions in Hebrew', async () => {
    adminApp(adminApi({ functionRequests: vi.fn(async () => ({ requests: [request()], threshold: 5 })) }), '/admin?tab=requests', 'he');
    const row = (await screen.findAllByTestId('fr-row'))[0]!;
    expect(within(row).getByRole('link', { name: 'פתיחת issue ב-GitHub' })).toBeTruthy();
    expect(within(row).getByRole('button', { name: 'סימון כנפתח' })).toBeTruthy();
  });
});
