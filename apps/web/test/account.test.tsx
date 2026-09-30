// The account side of the app (SPEC 12, 5 E): who is signed in (`useMe`), the header's Sign in / account menu, the sign-in wall
// (only the providers the server offers, Google first), what happens on the way to the provider and back, and the language saved
// in the profile. A fake API and a fake worker: nothing real is spawned or sent.
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryPendingStore, setPendingStore } from '../src/app/pendingLearn';
import { csv, fakeApi, renderApp, USER } from './helpers/renderApp';

const { redirectTo } = vi.hoisted(() => ({ redirectTo: vi.fn() }));
vi.mock('../src/app/redirect', () => ({ redirectTo }));

const clearCookie = (): void => {
  document.cookie = 'lang=; Path=/; Max-Age=0';
};

beforeEach(() => {
  clearCookie();
  setPendingStore(createMemoryPendingStore());
});
afterEach(() => {
  cleanup();
  clearCookie();
  vi.clearAllMocks();
  setPendingStore(undefined);
});

const header = (): HTMLElement => screen.getAllByRole('banner')[0]!;

describe('the header', () => {
  it('offers "Sign in" to a visitor', async () => {
    renderApp({ api: fakeApi() });
    expect(within(header()).getByRole('button', { name: 'Sign in' })).toBeTruthy();
    // ... and keeps offering it once /api/me has said nobody is signed in.
    await waitFor(() => expect(within(header()).getByRole('button', { name: 'Sign in' })).toBeTruthy());
    expect(within(header()).queryByRole('link', { name: 'My formats' })).toBeNull();
  });

  it('shows the signed-in user: an account menu with the name, and a My formats link', async () => {
    renderApp({ api: fakeApi({ user: USER }) });
    const menu = await within(header()).findByRole('button', { name: 'Account menu for Dana Levi' });
    expect(within(header()).queryByRole('button', { name: 'Sign in' })).toBeNull();
    expect(within(header()).getByRole('link', { name: 'My formats' }).getAttribute('href')).toBe('/formats');
    expect(menu.textContent).toContain('Dana Levi');
  });

  it('the account menu says the plan, how many AI formats are left (from the API), and offers linking the other provider and signing out', async () => {
    const api = fakeApi({ user: USER, auth: { quota: vi.fn(async () => ({ remaining: 2, period: 'month' as const })) } });
    renderApp({ api });
    fireEvent.click(await within(header()).findByRole('button', { name: 'Account menu for Dana Levi' }));
    const panel = await screen.findByRole('group', { name: 'Account' });
    expect(panel.textContent).toContain('dana@example.com');
    expect(panel.textContent).toContain('Free plan');
    await waitFor(() => expect(panel.textContent).toContain('AI formats left this month: 2'));
    expect(within(panel).getByRole('link', { name: 'My formats' })).toBeTruthy();
    // Signed in with Google: Microsoft can be linked, Google cannot.
    expect(within(panel).getByRole('button', { name: 'Link Microsoft' })).toBeTruthy();
    expect(within(panel).queryByRole('button', { name: 'Link Google' })).toBeNull();
    expect(within(panel).getByRole('button', { name: 'Sign out' })).toBeTruthy();
  });

  it('says "no limit" for an unlimited quota, and per day / in total for the other periods', async () => {
    const quota = vi.fn();
    quota.mockResolvedValueOnce({ remaining: null, period: 'unlimited' });
    renderApp({ api: fakeApi({ user: USER, auth: { quota } }) });
    fireEvent.click(await within(header()).findByRole('button', { name: 'Account menu for Dana Levi' }));
    await waitFor(() => expect(screen.getByRole('group', { name: 'Account' }).textContent).toContain('AI formats: no limit'));
  });

  it('linking the other provider asks the API for its address and goes there', async () => {
    const linkStart = vi.fn(async () => 'https://login.example/link?x=1');
    renderApp({ api: fakeApi({ user: USER, auth: { linkStart } }) });
    fireEvent.click(await within(header()).findByRole('button', { name: 'Account menu for Dana Levi' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Link Microsoft' }));
    await waitFor(() => expect(redirectTo).toHaveBeenCalledWith('https://login.example/link?x=1'));
    expect(linkStart).toHaveBeenCalledWith('microsoft', '/');
  });

  it('signing out ends the session and the header goes back to "Sign in"', async () => {
    const api = fakeApi({ user: USER });
    renderApp({ api });
    fireEvent.click(await within(header()).findByRole('button', { name: 'Account menu for Dana Levi' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(within(header()).getByRole('button', { name: 'Sign in' })).toBeTruthy());
    expect(api.auth.logout).toHaveBeenCalledTimes(1);
  });

  it('a sign-out that fails says so and keeps the user signed in', async () => {
    const api = fakeApi({ user: USER, auth: { logout: vi.fn(async () => Promise.reject(new Error('offline'))) } });
    renderApp({ api });
    fireEvent.click(await within(header()).findByRole('button', { name: 'Account menu for Dana Levi' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Sign out' }));
    expect(await screen.findByText("We couldn't sign you out. Try again.")).toBeTruthy();
    expect(within(header()).queryByRole('button', { name: 'Sign in' })).toBeNull();
  });
});

describe('the sign-in wall', () => {
  it('offers Google first, then Microsoft, when the server has both', async () => {
    renderApp({ api: fakeApi() });
    fireEvent.click(within(header()).getByRole('button', { name: 'Sign in' }));
    const dialog = await screen.findByRole('dialog', { name: 'Sign in' });
    const google = await within(dialog).findByRole('button', { name: 'Continue with Google' });
    const microsoft = within(dialog).getByRole('button', { name: 'Continue with Microsoft' });
    expect(google.compareDocumentPosition(microsoft) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('lists ONLY the providers the server offers', async () => {
    const api = fakeApi({ auth: { providers: vi.fn(async () => ['google' as const]) } });
    renderApp({ api });
    fireEvent.click(within(header()).getByRole('button', { name: 'Sign in' }));
    const dialog = await screen.findByRole('dialog', { name: 'Sign in' });
    await within(dialog).findByRole('button', { name: 'Continue with Google' });
    expect(within(dialog).queryByRole('button', { name: 'Continue with Microsoft' })).toBeNull();
  });

  it('a server with Microsoft only offers just that', async () => {
    const api = fakeApi({ auth: { providers: vi.fn(async () => ['microsoft' as const]) } });
    renderApp({ api });
    fireEvent.click(within(header()).getByRole('button', { name: 'Sign in' }));
    const dialog = await screen.findByRole('dialog', { name: 'Sign in' });
    await within(dialog).findByRole('button', { name: 'Continue with Microsoft' });
    expect(within(dialog).queryByRole('button', { name: 'Continue with Google' })).toBeNull();
  });

  it('says so, plainly, when no provider is set up', async () => {
    const api = fakeApi({ auth: { providers: vi.fn(async () => []) } });
    renderApp({ api });
    fireEvent.click(within(header()).getByRole('button', { name: 'Sign in' }));
    const dialog = await screen.findByRole('dialog', { name: 'Sign in' });
    expect(await within(dialog).findByText(/Signing in isn't set up on this server yet/)).toBeTruthy();
    expect(within(dialog).queryAllByRole('button', { name: /Continue with/ })).toHaveLength(0);
  });

  it('a click sends the browser to /api/auth/<provider>/start with the current page as returnTo', async () => {
    renderApp({ api: fakeApi(), route: '/privacy' });
    fireEvent.click(within(header()).getByRole('button', { name: 'Sign in' }));
    const dialog = await screen.findByRole('dialog', { name: 'Sign in' });
    await act(async () => {
      fireEvent.click(await within(dialog).findByRole('button', { name: 'Continue with Google' }));
    });
    await waitFor(() => expect(redirectTo).toHaveBeenCalledWith('/api/auth/google/start?returnTo=%2Fprivacy'));
  });

  it('keeps what has been learned so far (files, masking) in the browser before it leaves - and only there', async () => {
    const store = createMemoryPendingStore();
    setPendingStore(store);
    const api = fakeApi();
    renderApp({ api });
    fireEvent.change(screen.getByLabelText('Example input'), { target: { files: [csv('orders.csv', 'a,b\n1,2\n')] } });
    fireEvent.change(screen.getByLabelText('Example output'), { target: { files: [csv('report.csv', 'x\n1\n')] } });
    await screen.findAllByText(/1,204/);

    fireEvent.click(within(header()).getByRole('button', { name: 'Sign in' }));
    const dialog = await screen.findByRole('dialog', { name: 'Sign in' });
    await act(async () => {
      fireEvent.click(await within(dialog).findByRole('button', { name: 'Continue with Google' }));
    });
    await waitFor(() => expect(redirectTo).toHaveBeenCalled());

    const kept = await store.load();
    expect(kept).not.toBeNull();
    expect(kept!.input!.name).toBe('orders.csv');
    expect(new TextDecoder().decode(kept!.input!.bytes)).toBe('a,b\n1,2\n');
    expect(kept!.output!.name).toBe('report.csv');
    expect(kept!.masking).toBe(true);
    // Nothing of it went to the API: it has no method that takes a file.
    for (const call of [api.learn, api.repair]) expect(call).not.toHaveBeenCalled();
  });

  it('still goes to the provider when the browser will not keep anything', async () => {
    setPendingStore({ save: async () => Promise.reject(new Error('quota')), load: async () => null, clear: async () => undefined });
    renderApp({ api: fakeApi() });
    fireEvent.click(within(header()).getByRole('button', { name: 'Sign in' }));
    const dialog = await screen.findByRole('dialog', { name: 'Sign in' });
    await act(async () => {
      fireEvent.click(await within(dialog).findByRole('button', { name: 'Continue with Google' }));
    });
    await waitFor(() => expect(redirectTo).toHaveBeenCalledWith('/api/auth/google/start?returnTo=%2F'));
  });

  it('does not open for someone who is already signed in', async () => {
    renderApp({ api: fakeApi({ user: USER }) });
    await within(header()).findByRole('button', { name: 'Account menu for Dana Levi' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('coming back from the provider', () => {
  it.each([
    ['denied', 'You chose not to sign in, so nothing changed.'],
    ['expired', 'The sign-in took too long or was already used. Try again.'],
    ['failed', "We couldn't complete the sign-in. Try again in a moment."],
    ['identityInUse', "That account already belongs to another user here, so it can't be linked to yours."],
    ['providerLinked', 'That provider is already linked to your account.'],
    ['sessionMismatch', 'You were signed in to a different account when you started linking. Sign in again and try once more.'],
  ])('?authError=%s is said in plain words, once, and can be dismissed', async (code, text) => {
    renderApp({ api: fakeApi(), route: `/?authError=${code}` });
    expect(await screen.findByText(text)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText(text)).toBeNull();
  });

  it('an unknown ?authError value reads as a plain failure', async () => {
    renderApp({ api: fakeApi(), route: '/?authError=<script>' });
    expect(await screen.findByText("We couldn't complete the sign-in. Try again in a moment.")).toBeTruthy();
  });

  it('?linked=microsoft says the provider is linked', async () => {
    renderApp({ api: fakeApi({ user: USER }), route: '/?linked=microsoft' });
    expect(await screen.findByText('Microsoft is now linked to your account.')).toBeTruthy();
  });

  it('says it in Hebrew too', async () => {
    renderApp({ api: fakeApi(), route: '/?authError=denied', lang: 'he' });
    expect(await screen.findByText('בחרתם לא להתחבר, ולכן דבר לא השתנה.')).toBeTruthy();
  });
});

describe('the language in the profile', () => {
  it('a signed-in user with no saved language gets the current one saved', async () => {
    const api = fakeApi({ user: USER });
    renderApp({ api, lang: 'en' });
    await waitFor(() => expect(api.auth.setLanguage).toHaveBeenCalledWith('en'));
  });

  it('every change of the toggle is saved', async () => {
    const api = fakeApi({ user: { ...USER, uiLanguage: 'en' } });
    renderApp({ api, lang: 'en' });
    await within(header()).findByRole('button', { name: 'Account menu for Dana Levi' });
    expect(api.auth.setLanguage).not.toHaveBeenCalled();
    fireEvent.click(within(header()).getByRole('button', { name: 'עבור לעברית' }));
    await waitFor(() => expect(api.auth.setLanguage).toHaveBeenCalledWith('he'));
  });

  it('on a device with no saved choice the profile decides', async () => {
    const api = fakeApi({ user: { ...USER, uiLanguage: 'he' } });
    renderApp({ api, lang: 'en' });
    await waitFor(() => expect(screen.getByTestId('app').getAttribute('dir')).toBe('rtl'));
    expect(api.auth.setLanguage).not.toHaveBeenCalled();
  });

  it('a visitor never triggers a save', async () => {
    const api = fakeApi();
    renderApp({ api });
    fireEvent.click(within(header()).getByRole('button', { name: 'עבור לעברית' }));
    await act(async () => {});
    expect(api.auth.setLanguage).not.toHaveBeenCalled();
  });
});
