import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderApp } from './helpers/renderApp';

function clearCookie(): void {
  document.cookie = 'lang=; Path=/; Max-Age=0';
}

beforeEach(() => {
  clearCookie();
  document.documentElement.className = '';
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  clearCookie();
});

describe('app shell', () => {
  it('has the wordmark, the language toggle, sign in, and the footer links', () => {
    renderApp();
    const header = screen.getAllByRole('banner')[0]!; // the page header (the testing library also counts <header> elements inside sections)
    expect(within(header).getByRole('link', { name: 'formatAI' }).getAttribute('href')).toBe('/');
    expect(within(header).getByRole('button', { name: 'עבור לעברית' })).toBeTruthy();
    expect(within(header).getByRole('button', { name: 'Sign in' })).toBeTruthy();

    const footer = screen.getByRole('contentinfo');
    expect(within(footer).getByRole('link', { name: 'Business' }).getAttribute('href')).toBe('/business');
    expect(within(footer).getByRole('link', { name: 'Privacy' }).getAttribute('href')).toBe('/privacy');
    expect(within(footer).getByRole('link', { name: 'Terms' }).getAttribute('href')).toBe('/terms');
  });

  it('flips direction and language with the toggle: the shell and <html> follow (SPEC 16.2)', () => {
    renderApp({ lang: 'en' });
    const app = screen.getByTestId('app');
    expect(app.getAttribute('dir')).toBe('ltr');
    expect(document.documentElement.dir).toBe('ltr');
    expect(document.documentElement.lang).toBe('en');

    fireEvent.click(screen.getByRole('button', { name: 'עבור לעברית' }));
    expect(app.getAttribute('dir')).toBe('rtl');
    expect(document.documentElement.dir).toBe('rtl');
    expect(document.documentElement.lang).toBe('he');
    // The header reads in Hebrew now, and the toggle offers English.
    expect(screen.getByRole('button', { name: 'התחברות' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Switch to English' })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('הראו לנו דוגמה אחת');

    fireEvent.click(screen.getByRole('button', { name: 'Switch to English' }));
    expect(app.getAttribute('dir')).toBe('ltr');
    expect(document.documentElement.dir).toBe('ltr');
  });

  it('starts in Hebrew, right-to-left, when that is the language', () => {
    renderApp({ lang: 'he' });
    expect(screen.getByTestId('app').getAttribute('dir')).toBe('rtl');
    expect(screen.getByRole('link', { name: 'לעסקים' })).toBeTruthy();
  });

  it('opens the sign-in wall from the header, with the SPEC 5 E copy and both providers "coming soon"', () => {
    renderApp();
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    const dialog = screen.getByRole('dialog', { name: 'Sign in' });
    expect(within(dialog).getByText("Sign in to save this format and reuse it on next month's file.")).toBeTruthy();
    const google = within(dialog).getByRole('button', { name: /Continue with Google/ }) as HTMLButtonElement;
    const microsoft = within(dialog).getByRole('button', { name: /Continue with Microsoft/ }) as HTMLButtonElement;
    expect(google.disabled).toBe(true);
    expect(microsoft.disabled).toBe(true);
    expect(google.textContent).toContain('Coming soon');
    // Google first.
    expect(google.compareDocumentPosition(microsoft) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('routes the placeholder pages, and sends unknown addresses and a bare /result home', () => {
    const { unmount } = renderApp({ route: '/privacy' });
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Privacy');
    unmount();
    renderApp({ route: '/result' });
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Show us one example');
  });
});

describe('reduced motion', () => {
  function stubMatchMedia(matches: boolean): void {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query.includes('prefers-reduced-motion') ? matches : false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
      onchange: null,
    }));
  }

  it('puts the reduce-motion class on the app and on <html> when the user asks for less motion', async () => {
    stubMatchMedia(true);
    renderApp();
    await act(async () => {});
    expect(screen.getByTestId('app').classList.contains('reduce-motion')).toBe(true);
    expect(document.documentElement.classList.contains('reduce-motion')).toBe(true);
  });

  it('leaves it off otherwise', async () => {
    stubMatchMedia(false);
    renderApp();
    await act(async () => {});
    expect(screen.getByTestId('app').classList.contains('reduce-motion')).toBe(false);
    expect(document.documentElement.classList.contains('reduce-motion')).toBe(false);
  });
});
