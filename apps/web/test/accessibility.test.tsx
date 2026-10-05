// The accessibility panel, the page titles and the accessibility statement (IS 5568 / WCAG 2.1 AA; v13 M4).
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tabStops } from '../src/app/a11y/AccessibilityWidget';
import { A11Y_CLASS, A11Y_STORAGE_KEY, applyStoredPrefs, DEFAULT_PREFS, parsePrefs, readPrefs, writePrefs } from '../src/app/a11y/prefs';
import { webConfig } from '../src/config';
import { renderApp } from './helpers/renderApp';

const html = document.documentElement;
const stored = (): unknown => {
  const raw = localStorage.getItem(A11Y_STORAGE_KEY);
  return raw === null ? null : JSON.parse(raw);
};
const classes = (): string[] => [...html.classList].filter((c) => c.startsWith('a11y-')).sort();

beforeEach(() => {
  document.cookie = 'lang=; Path=/; Max-Age=0';
  html.className = '';
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  html.className = '';
  localStorage.clear();
});

const openButton = (name = 'Accessibility options'): HTMLElement => screen.getByRole('button', { name });
function openPanel(name?: string): HTMLElement {
  fireEvent.click(openButton(name));
  return screen.getByRole('dialog', { name: name ? undefined : 'Accessibility' });
}

describe('the floating button', () => {
  it.each([['/'], ['/business'], ['/privacy'], ['/accessibility'], ['/formats']])('is on every page (%s): last in the page, named, closed', (route) => {
    renderApp({ route });
    const button = openButton();
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(button.getAttribute('aria-haspopup')).toBe('dialog');
    expect(button.getAttribute('aria-controls')).toBeNull();
    // after the footer in the page, so it is reached last by keyboard and sits at the end of the reading order
    expect(screen.getByRole('contentinfo').compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('is named in Hebrew, inside the right-to-left page (it sits at the end of the line: styles/a11y.css uses logical properties only)', () => {
    renderApp({ lang: 'he' });
    const button = openButton('אפשרויות נגישות');
    expect(button.closest('[dir]')!.getAttribute('dir')).toBe('rtl');
  });
});

describe('the panel', () => {
  it('opens as a dialog that takes the focus, with every setting and the link to the statement', () => {
    renderApp();
    const panel = openPanel();
    expect(openButton().getAttribute('aria-expanded')).toBe('true');
    expect(openButton().getAttribute('aria-controls')).toBe(panel.id);
    expect(panel.getAttribute('aria-modal')).toBe('true');
    expect(document.activeElement).toBe(panel);
    expect(within(panel).getAllByRole('radio').map((r) => (r as HTMLInputElement).labels?.[0]?.textContent)).toEqual(['Normal', 'Large', 'Larger']);
    expect(within(panel).getAllByRole('switch').map((s) => (s as HTMLInputElement).labels?.[0]?.textContent)).toEqual([
      'High contrast',
      'Underline links',
      'Readable font',
      'Stop animations',
      'Strong focus highlight',
      'Line and letter spacing',
    ]);
    expect(within(panel).getByRole('button', { name: 'Reset settings' })).toBeTruthy();
    expect(within(panel).getByRole('link', { name: 'Accessibility statement' }).getAttribute('href')).toBe('/accessibility');
  });

  it('closes with Escape and gives the focus back to the button', () => {
    renderApp();
    openPanel();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(openButton());
    expect(openButton().getAttribute('aria-expanded')).toBe('false');
  });

  it('closes with its close button (focus back to the button) and with a click outside', () => {
    renderApp({ route: '/business' });
    const panel = openPanel();
    fireEvent.click(within(panel).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(openButton());

    openPanel();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('the button opens and closes it', () => {
    renderApp();
    openPanel();
    fireEvent.click(openButton());
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('keeps the focus inside: Tab from the last stop wraps to the first, Shift+Tab from the first wraps to the last', () => {
    renderApp();
    const panel = openPanel();
    const link = within(panel).getByRole('link', { name: 'Accessibility statement' });
    // the close button comes first in the panel
    const first = within(panel).getByRole('button', { name: 'Close' });

    link.focus();
    fireEvent.keyDown(link, { key: 'Tab' });
    expect(document.activeElement).toBe(first);

    fireEvent.keyDown(first, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(link);

    // from the panel itself, Shift+Tab goes to the last stop; and a focus that got outside is brought back in
    panel.focus();
    fireEvent.keyDown(panel, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(link);
    (document.activeElement as HTMLElement).blur();
    fireEvent.keyDown(document.body, { key: 'Tab' });
    expect(panel.contains(document.activeElement)).toBe(true);
  });

  it('a group of radio buttons is one tab stop: the checked one, or the first when none is', () => {
    const box = document.createElement('div');
    box.innerHTML = '<button id="b"></button><input type="radio" name="g" id="r1"><input type="radio" name="g" id="r2" checked><input type="radio" name="g" id="r3"><a href="/x" id="l">x</a>';
    expect(tabStops(box).map((el) => el.id)).toEqual(['b', 'r2', 'l']);
    box.querySelector<HTMLInputElement>('#r2')!.checked = false;
    expect(tabStops(box).map((el) => el.id)).toEqual(['b', 'r1', 'l']);
  });

  it('the statement link goes to the statement and closes the panel', async () => {
    renderApp();
    fireEvent.click(within(openPanel()).getByRole('link', { name: 'Accessibility statement' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Accessibility statement' })).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('the settings', () => {
  const toggles = [
    ['High contrast', A11Y_CLASS.contrast, 'contrast'],
    ['Underline links', A11Y_CLASS.links, 'links'],
    ['Readable font', A11Y_CLASS.font, 'font'],
    ['Stop animations', A11Y_CLASS.motion, 'motion'],
    ['Strong focus highlight', A11Y_CLASS.focus, 'focus'],
    ['Line and letter spacing', A11Y_CLASS.spacing, 'spacing'],
  ] as const;

  it.each(toggles)('%s: puts %s on <html>, keeps it, and takes it off again', (label, cls, key) => {
    renderApp();
    const panel = openPanel();
    const sw = within(panel).getByRole('switch', { name: label }) as HTMLInputElement;
    expect(sw.checked).toBe(false);
    fireEvent.click(sw);
    expect(html.classList.contains(cls)).toBe(true);
    expect(sw.checked).toBe(true);
    expect(stored()).toMatchObject({ [key]: true });
    fireEvent.click(sw);
    expect(html.classList.contains(cls)).toBe(false);
    expect(stored()).toBeNull(); // nothing is kept for the defaults
  });

  it('text size: three sizes, one class at a time', () => {
    renderApp();
    const panel = openPanel();
    const radio = (name: string) => within(panel).getByRole('radio', { name }) as HTMLInputElement;
    expect(radio('Normal').checked).toBe(true);
    fireEvent.click(radio('Large'));
    expect(classes()).toEqual([A11Y_CLASS.text1]);
    expect(stored()).toMatchObject({ textSize: 1 });
    fireEvent.click(radio('Larger'));
    expect(classes()).toEqual([A11Y_CLASS.text2]);
    expect(radio('Larger').checked).toBe(true);
    fireEvent.click(radio('Normal'));
    expect(classes()).toEqual([]);
  });

  it('stopping animations puts reduce-motion on the page and on <html> (the same rules the system setting uses)', () => {
    renderApp();
    expect(html.classList.contains('reduce-motion')).toBe(false);
    fireEvent.click(within(openPanel()).getByRole('switch', { name: 'Stop animations' }));
    expect(html.classList.contains('reduce-motion')).toBe(true);
    expect(screen.getByTestId('app').classList.contains('reduce-motion')).toBe(true);
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('switch', { name: 'Stop animations' }));
    expect(html.classList.contains('reduce-motion')).toBe(false);
  });

  it('the system setting still stops animations when the panel does not', () => {
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('prefers-reduced-motion'), media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false, onchange: null }));
    renderApp();
    expect(html.classList.contains('reduce-motion')).toBe(true);
    expect(classes()).toEqual([]);
  });

  it('several at once, kept for the next visit: a new page view starts with them on, and the panel shows them', () => {
    const first = renderApp();
    const panel = openPanel();
    fireEvent.click(within(panel).getByRole('switch', { name: 'High contrast' }));
    fireEvent.click(within(panel).getByRole('switch', { name: 'Readable font' }));
    fireEvent.click(within(panel).getByRole('radio', { name: 'Larger' }));
    expect(stored()).toEqual({ textSize: 2, contrast: true, links: false, font: true, motion: false, focus: false, spacing: false });
    first.unmount();
    html.className = ''; // a fresh page view: nothing on <html> yet

    applyStoredPrefs(); // main.tsx, before the first paint
    expect(classes()).toEqual([A11Y_CLASS.contrast, A11Y_CLASS.font, A11Y_CLASS.text2].sort());

    html.className = '';
    renderApp();
    expect(classes()).toEqual([A11Y_CLASS.contrast, A11Y_CLASS.font, A11Y_CLASS.text2].sort());
    const again = openPanel();
    expect((within(again).getByRole('switch', { name: 'High contrast' }) as HTMLInputElement).checked).toBe(true);
    expect((within(again).getByRole('radio', { name: 'Larger' }) as HTMLInputElement).checked).toBe(true);
  });

  it('reset takes every class off, forgets the choices and shows the defaults', () => {
    renderApp();
    const panel = openPanel();
    for (const [label] of toggles) fireEvent.click(within(panel).getByRole('switch', { name: label }));
    fireEvent.click(within(panel).getByRole('radio', { name: 'Large' }));
    expect(classes().length).toBe(toggles.length + 1);

    fireEvent.click(within(panel).getByRole('button', { name: 'Reset settings' }));
    expect(classes()).toEqual([]);
    expect(stored()).toBeNull();
    for (const [label] of toggles) expect((within(panel).getByRole('switch', { name: label }) as HTMLInputElement).checked).toBe(false);
    expect((within(panel).getByRole('radio', { name: 'Normal' }) as HTMLInputElement).checked).toBe(true);
  });

  it('works in Hebrew: the same classes, the labels in Hebrew', () => {
    renderApp({ lang: 'he' });
    const panel = openPanel('אפשרויות נגישות');
    expect(within(panel).getByRole('heading', { name: 'נגישות' })).toBeTruthy();
    fireEvent.click(within(panel).getByRole('switch', { name: 'ניגודיות גבוהה' }));
    fireEvent.click(within(panel).getByRole('radio', { name: 'גדול מאוד' }));
    expect(classes()).toEqual([A11Y_CLASS.contrast, A11Y_CLASS.text2].sort());
    expect(within(panel).getByRole('link', { name: 'הצהרת נגישות' }).getAttribute('href')).toBe('/accessibility');
  });

  it('another tab changing the choices is followed', async () => {
    renderApp();
    localStorage.setItem(A11Y_STORAGE_KEY, JSON.stringify({ ...DEFAULT_PREFS, links: true }));
    fireEvent(window, new StorageEvent('storage', { key: A11Y_STORAGE_KEY }));
    await waitFor(() => expect(classes()).toEqual([A11Y_CLASS.links]));
  });
});

describe('storage that is junk, missing or throws', () => {
  it('a stored value that is not a known one falls back to the default for that setting', () => {
    expect(parsePrefs({ textSize: 9, contrast: 'yes', links: 1, font: true })).toEqual({ ...DEFAULT_PREFS, font: true });
    expect(parsePrefs(null)).toEqual(DEFAULT_PREFS);
    expect(parsePrefs('text')).toEqual(DEFAULT_PREFS);
    localStorage.setItem(A11Y_STORAGE_KEY, 'not json {');
    expect(readPrefs()).toEqual(DEFAULT_PREFS);
    localStorage.setItem(A11Y_STORAGE_KEY, JSON.stringify({ textSize: 1, spacing: true, injected: '<script>' }));
    expect(readPrefs()).toEqual({ ...DEFAULT_PREFS, textSize: 1, spacing: true });
  });

  it('a page whose storage throws still works: the choice holds for this page view', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    renderApp();
    const panel = openPanel();
    fireEvent.click(within(panel).getByRole('switch', { name: 'Underline links' }));
    expect(classes()).toEqual([A11Y_CLASS.links]);
    fireEvent.click(within(panel).getByRole('button', { name: 'Reset settings' }));
    expect(classes()).toEqual([]);
    expect(() => writePrefs({ ...DEFAULT_PREFS, links: true })).not.toThrow();
    expect(() => readPrefs()).not.toThrow();
  });

  it('a page with no storage at all works too', () => {
    vi.stubGlobal('localStorage', undefined);
    renderApp();
    fireEvent.click(within(openPanel()).getByRole('switch', { name: 'High contrast' }));
    expect(classes()).toEqual([A11Y_CLASS.contrast]);
  });
});

describe('page titles and where the focus goes', () => {
  it('every screen has its own title, in the language of the page', () => {
    const { unmount } = renderApp({ route: '/' });
    expect(document.title).toBe('formatAI');
    unmount();
    for (const [route, title] of [
      ['/business', 'For business | formatAI'],
      ['/privacy', 'Privacy policy | formatAI'],
      ['/terms', 'Terms of use | formatAI'],
      ['/accessibility', 'Accessibility statement | formatAI'],
      ['/formats', 'My formats | formatAI'],
    ] as const) {
      const view = renderApp({ route });
      expect(document.title).toBe(title);
      view.unmount();
    }
    renderApp({ route: '/accessibility', lang: 'he' });
    expect(document.title).toBe('הצהרת נגישות | formatAI');
  });

  it('the title follows a change of language', () => {
    renderApp({ route: '/privacy' });
    fireEvent.click(screen.getByRole('button', { name: 'עבור לעברית' }));
    expect(document.title).toBe('מדיניות פרטיות | formatAI');
  });

  it('going to another page moves the focus to its <main> (not on the first load, and not for a #hash)', async () => {
    renderApp({ route: '/' });
    expect(document.activeElement).toBe(document.body);
    fireEvent.click(within(screen.getByRole('contentinfo')).getByRole('link', { name: 'Privacy' }));
    await screen.findByRole('heading', { level: 1, name: 'Privacy policy' });
    await waitFor(() => expect(document.activeElement).toBe(document.getElementById('main')));
    expect(document.title).toBe('Privacy policy | formatAI');
  });

  it('has the skip link first, pointing at the one <main id="main"> every screen renders', () => {
    renderApp({ route: '/business' });
    const links = screen.getAllByRole('link');
    expect(links[0]!.textContent).toBe('Skip to content');
    expect(links[0]!.getAttribute('href')).toBe('#main');
    expect(document.querySelectorAll('main#main').length).toBe(1);
    expect(document.getElementById('main')!.getAttribute('tabindex')).toBe('-1');
  });
});

describe('the accessibility statement (/accessibility)', () => {
  it('English: the standard, what was done, what is still hard, the coordinator, the date', () => {
    renderApp({ route: '/accessibility' });
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Accessibility statement');
    const text = document.body.textContent ?? '';
    // the standard it aims for - and the honest status
    expect(text).toContain('Israeli Standard 5568 (IS 5568)');
    expect(text).toContain('WCAG) 2.1, level AA');
    expect(text).toContain('We have not yet had the site audited by an outside body');
    // what was done
    expect(text).toContain('skip link');
    expect(text).toContain('Hebrew and English');
    expect(text).toContain('An accessibility button on every page');
    // known limitations
    const limits = document.getElementById('legal-limits')!;
    expect(limits.textContent).toContain('previews of spreadsheets');
    expect(limits.textContent).toContain('Testing with screen readers');
    // the coordinator, for the owner to fill in
    const contact = document.getElementById('legal-contact')!;
    expect(contact.textContent).toContain(webConfig.legal.accessibility.coordinator.en);
    expect(contact.textContent).toContain(webConfig.legal.accessibility.email);
    expect(contact.textContent).toContain(webConfig.legal.accessibility.phone.en);
    // the date
    expect(text).toContain('Last updated: 5 October 2026');
    expect(document.getElementById('legal-date')!.textContent).toContain('last updated on 5 October 2026');
    expect(text).not.toMatch(/\{\w+\}/);
  });

  it('Hebrew: the same, right-to-left', () => {
    renderApp({ route: '/accessibility', lang: 'he' });
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('הצהרת נגישות');
    expect(screen.getByTestId('app').getAttribute('dir')).toBe('rtl');
    const text = document.body.textContent ?? '';
    expect(text).toContain('ת״י 5568');
    expect(text).toContain('WCAG');
    expect(text).toContain('רמה AA');
    expect(document.getElementById('legal-limits')!.textContent).toContain('התצוגות המקדימות של גיליונות');
    expect(document.getElementById('legal-contact')!.textContent).toContain(webConfig.legal.accessibility.coordinator.he);
    expect(document.getElementById('legal-date')!.textContent).toContain('2026');
    expect(text).not.toMatch(/\{\w+\}/);
  });

  it('is linked from the footer and from the panel; the contents list jumps to its sections', () => {
    renderApp({ route: '/accessibility' });
    expect(within(screen.getByRole('contentinfo')).getByRole('link', { name: 'Accessibility' }).getAttribute('href')).toBe('/accessibility');
    const toc = screen.getByRole('navigation', { name: 'On this page' });
    expect(within(toc).getAllByRole('link').map((a) => a.getAttribute('href'))).toEqual(['#legal-standard', '#legal-done', '#legal-limits', '#legal-contact', '#legal-date']);
    for (const a of within(toc).getAllByRole('link')) expect(document.querySelector(a.getAttribute('href')!)).toBeTruthy();
  });
});
