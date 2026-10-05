// The public pages and forms (v13 M4): For business, the paid waitlist, feedback, the privacy policy and the terms, in both languages.
import { limits, tiers } from '@formatai/shared';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/api';
import { webConfig } from '../src/config';
import { legalDocs, type LegalBlock } from '../src/i18n/legal';
import { fakeApi, renderApp, USER } from './helpers/renderApp';

beforeEach(() => {
  document.cookie = 'lang=; Path=/; Max-Age=0';
  document.documentElement.className = '';
  try {
    localStorage.clear();
  } catch {
    // (no storage in this environment)
  }
});

afterEach(() => {
  cleanup();
  delete (window as { turnstile?: unknown }).turnstile;
  vi.unstubAllGlobals();
});

const type = (el: HTMLElement, value: string): void => {
  fireEvent.change(el, { target: { value } });
};

describe('the legal texts', () => {
  const shape = (blocks: readonly LegalBlock[]): string[] => blocks.map((b) => ('ul' in b ? `ul${b.ul.length}` : 'promise' in b ? 'promise' : 'p'));
  const tokens = (text: string): string[] => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).sort();
  const strings = (blocks: readonly LegalBlock[]): string[] => blocks.flatMap((b) => ('ul' in b ? [...b.ul] : 'promise' in b ? [b.promise] : [b.p]));

  it.each(Object.keys(legalDocs) as Array<keyof typeof legalDocs>)('%s: Hebrew and English have the same sections, in the same shape, with the same tokens', (id) => {
    const { en, he } = legalDocs[id];
    expect(he.sections.map((s) => s.id)).toEqual(en.sections.map((s) => s.id));
    en.sections.forEach((section, i) => {
      const other = he.sections[i]!;
      expect(shape(other.blocks)).toEqual(shape(section.blocks));
      expect(tokens(strings(other.blocks).join(' '))).toEqual(tokens(strings(section.blocks).join(' ')));
    });
    expect(tokens(he.intro)).toEqual(tokens(en.intro));
  });
});

describe.each([
  ['en', 'ltr'],
  ['he', 'rtl'],
] as const)('the pages in %s', (lang, dir) => {
  it('privacy: the promise, what AI learning sends, what is stored, cookies, Turnstile, the providers, retention and contact', () => {
    renderApp({ lang, route: '/privacy' });
    const h1 = screen.getByRole('heading', { level: 1 });
    expect(h1.textContent).toBe(lang === 'he' ? 'מדיניות פרטיות' : 'Privacy policy');
    expect(screen.getByTestId('app').getAttribute('dir')).toBe(dir);
    expect(document.title).toBe(lang === 'he' ? 'מדיניות פרטיות | formatAI' : 'Privacy policy | formatAI');

    const text = document.body.textContent ?? '';
    if (lang === 'en') {
      // the precise promise
      expect(text).toContain('Your full files never leave your computer. Saved formats contain the column names and the rules you approved, including any fixed values those rules use');
      expect(text).toContain('Never rows from your files.');
      expect(text).toContain('Anthropic and OpenAI');
      expect(text).toContain('look-alike values');
      expect(text).toContain('"no value" placeholders');
    } else {
      expect(text).toContain('הקבצים המלאים שלכם לעולם לא יוצאים מהמחשב שלכם');
      expect(text).toContain('לעולם לא שורות מהקבצים שלכם');
      expect(text).toContain('Anthropic ו-OpenAI');
      expect(text).toContain('ערכים מדומים');
    }
    // the numbers come from config, and are filled in
    expect(text).toContain(`${limits.learn.loop.maxRowsTotal}`);
    expect(text).toContain(`${limits.cache.ttlDays}`);
    expect(text).not.toMatch(/\{\w+\}/);
    // opt-in, cookies, Turnstile, retention, contact
    for (const id of ['summary', 'local', 'ai', 'stored', 'cookies', 'turnstile', 'processors', 'retention', 'rights', 'contact']) {
      expect(document.getElementById(`legal-${id}`)).toBeTruthy();
    }
    expect(screen.getAllByRole('link', { name: webConfig.legal.contactEmail })[0]!.getAttribute('href')).toBe(`mailto:${webConfig.legal.contactEmail}`);
    // the contents list jumps to each section
    const toc = screen.getByRole('navigation', { name: lang === 'he' ? 'בדף הזה' : 'On this page' });
    expect(within(toc).getAllByRole('link').length).toBe(legalDocs.privacy[lang].sections.length);
  });

  it('terms: the basics, and Israeli law with a court to confirm', () => {
    renderApp({ lang, route: '/terms' });
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(lang === 'he' ? 'תנאי שימוש' : 'Terms of use');
    const text = document.body.textContent ?? '';
    for (const id of ['service', 'responsibility', 'accounts', 'use', 'paid', 'termination', 'liability', 'changes', 'law', 'contact']) {
      expect(document.getElementById(`legal-${id}`)).toBeTruthy();
    }
    expect(text).toContain(lang === 'he' ? 'דיני מדינת ישראל' : 'laws of the State of Israel');
    // the owner's placeholders are visible until they are filled in
    expect(text).toContain(webConfig.legal.jurisdiction[lang]);
    expect(text).toContain(webConfig.legal.operator[lang]);
    expect(text).not.toMatch(/\{\w+\}/);
  });

  it('business: the problem, the idea, how it works, what is different, the plans, the AI step and the form', () => {
    renderApp({ lang, route: '/business' });
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(lang === 'he' ? 'formatAI לעסקים' : 'formatAI for business');
    const headings = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
    expect(headings).toEqual(
      lang === 'he'
        ? ['הבעיה', 'הרעיון', 'איך זה עובד', 'במה זה שונה', 'על שלב ה-AI', 'תוכניות', 'דברו איתנו']
        : ['The problem', 'The idea', 'How it works', 'How it is different', 'About the AI step', 'Plans', 'Talk to us'],
    );
    expect(screen.getAllByRole('listitem').length).toBeGreaterThan(8);
    expect(screen.getByRole('link', { name: lang === 'he' ? 'דברו איתנו' : 'Talk to us' }).getAttribute('href')).toBe('#contact');
    expect(document.title).toBe(lang === 'he' ? 'לעסקים | formatAI' : 'For business | formatAI');
  });
});

describe('the plans on the business page', () => {
  it('is a table whose numbers are the tier config', () => {
    renderApp({ route: '/business' });
    const table = screen.getByRole('table');
    const nf = new Intl.NumberFormat('en');
    expect(within(table).getAllByRole('columnheader').map((c) => c.textContent)).toEqual([
      'What it includes',
      'FreeNot signed in. Try it on one small file.',
      'Signed inFree. Your own recurring formats.',
      'Paid' + "A company's work.",
    ]);
    const row = (name: string): string[] => within(within(table).getByRole('rowheader', { name }).closest('tr') as HTMLElement).getAllByRole('cell').map((c) => c.textContent ?? '');
    expect(row('Rows per file')).toEqual([tiers.anonymous, tiers.registered, tiers.paid].map((t) => nf.format(t.maxRowsPerFile)));
    expect(row('Files per run')).toEqual([tiers.anonymous, tiers.registered, tiers.paid].map((t) => nf.format(t.filesPerRun)));
    expect(row('Saved formats')).toEqual(['Not included', nf.format(tiers.registered.savedFormats as number), `${tiers.paid.newSavedFormatsPerMonth} new a month`]);
    expect(row('AI formats')).toEqual(['Not included', `${tiers.registered.aiLearns.count} a month`, `${tiers.paid.aiLearns.count} a month`]);
    expect(row('Download')).toEqual([`First ${tiers.anonymous.previewRows} rows on screen`, 'The full file', 'The full file']);
  });

  it('is also there plan by plan for a phone, with the same numbers', () => {
    renderApp({ route: '/business', lang: 'he' });
    const plans = screen.getAllByRole('region');
    expect(plans.length).toBeGreaterThanOrEqual(3);
    const registered = plans.find((p) => p.textContent?.includes('מחוברים'))!;
    expect(registered.textContent).toContain(new Intl.NumberFormat('he').format(tiers.registered.maxRowsPerFile));
  });
});

describe('the lead form on the business page', () => {
  const fill = (): void => {
    type(screen.getByLabelText(/^Name/), 'Dana Levi');
    type(screen.getByLabelText(/^Email/), 'dana@example.com');
    type(screen.getByLabelText(/^Company/), 'Acme Ltd');
    type(screen.getByLabelText(/^What do you need/), 'Thirty supplier files a month.');
  };

  it('marks what is required, and says so in the label of what is not', () => {
    renderApp({ route: '/business' });
    expect(screen.getByLabelText(/^Name/).getAttribute('aria-required')).toBe('true');
    expect(screen.getByLabelText(/^Email/).getAttribute('aria-required')).toBe('true');
    expect(screen.getByLabelText(/^Company/).getAttribute('aria-required')).toBeNull();
    expect(screen.getByText('Company').closest('label')!.textContent).toBe('Company (optional)');
  });

  it('says what is wrong, ties the message to the field, and moves the focus to it - nothing is sent', () => {
    const api = fakeApi();
    renderApp({ route: '/business', api });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    const name = screen.getByLabelText(/^Name/);
    expect(name.getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByText('Fill in this field.')).toBeTruthy();
    expect(name.getAttribute('aria-describedby')).toBe(screen.getByText('Fill in this field.').id);
    expect(document.activeElement).toBe(name);

    type(name, 'Dana');
    expect(name.getAttribute('aria-invalid')).toBeNull();
    type(screen.getByLabelText(/^Email/), 'not an email');
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(screen.getByText('Enter an email address like name@example.com.')).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByLabelText(/^Email/));
    expect(api.contact.lead).not.toHaveBeenCalled();
  });

  it('refuses a message over its cap, in words', () => {
    renderApp({ route: '/business' });
    type(screen.getByLabelText(/^Name/), 'Dana');
    type(screen.getByLabelText(/^Email/), 'dana@example.com');
    type(screen.getByLabelText(/^What do you need/), 'm'.repeat(limits.contact.leadMessageMaxChars + 1));
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(screen.getByText(`Use at most ${new Intl.NumberFormat().format(limits.contact.leadMessageMaxChars)} characters.`)).toBeTruthy();
  });

  it('sends the typed fields and the page path (nothing else), then shows the thank-you, which takes the focus', async () => {
    const api = fakeApi();
    renderApp({ route: '/business', api });
    fill();
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    const thanks = await screen.findByText('We got your message and will write to you soon.');
    expect(api.contact.lead).toHaveBeenCalledTimes(1);
    expect(api.contact.lead).toHaveBeenCalledWith({ name: 'Dana Levi', email: 'dana@example.com', company: 'Acme Ltd', message: 'Thirty supplier files a month.', page: '/business' });
    expect(screen.getByRole('status', { name: '' })).toBeTruthy();
    // (the focus moves in an effect, which may run a moment after the text is on screen)
    await waitFor(() => expect(document.activeElement).toBe(thanks.closest('[role="status"]')));

    // "send another" brings the empty form back
    fireEvent.click(screen.getByRole('button', { name: 'Send another message' }));
    expect((screen.getByLabelText(/^Name/) as HTMLInputElement).value).toBe('');
  });

  it('leaves out a blank company and message', async () => {
    const api = fakeApi();
    renderApp({ route: '/business', api });
    type(screen.getByLabelText(/^Name/), 'Dana');
    type(screen.getByLabelText(/^Email/), 'dana@example.com');
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await screen.findByText('We got your message and will write to you soon.');
    expect(api.contact.lead).toHaveBeenCalledWith({ name: 'Dana', email: 'dana@example.com', page: '/business' });
  });

  it('is in Hebrew too, with the thank-you', async () => {
    const api = fakeApi();
    renderApp({ route: '/business', api, lang: 'he' });
    type(screen.getByLabelText(/^שם/), 'דנה לוי');
    type(screen.getByLabelText(/^אימייל/), 'dana@example.com');
    fireEvent.click(screen.getByRole('button', { name: 'שליחה' }));
    expect(await screen.findByText('קיבלנו את ההודעה ונכתוב לכם בקרוב.')).toBeTruthy();
    expect(api.contact.lead).toHaveBeenCalledWith({ name: 'דנה לוי', email: 'dana@example.com', page: '/business' });
  });

  it.each([
    ['rateLimited', 'Too many requests. Wait a minute and try again.'],
    ['turnstileFailed', "We couldn't confirm you're not a robot. Refresh the page and try again."],
    ['network', "We couldn't reach the server. Check your connection and try again."],
  ] as const)('shows what the server said when it says %s, and keeps what was typed', async (code, text) => {
    const api = fakeApi({ contact: { lead: vi.fn(async () => Promise.reject(new ApiError(code, code === 'network' ? 0 : 429))) } });
    renderApp({ route: '/business', api });
    fill();
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText(text)).toBeTruthy();
    expect((screen.getByLabelText(/^Name/) as HTMLInputElement).value).toBe('Dana Levi');
    // and it can be sent again
    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(false);
  });

  describe('Turnstile', () => {
    function stubTurnstile(token = 'tok-1') {
      const widget = {
        render: vi.fn((_c: HTMLElement, o: { callback(t: string): void }) => {
          queueMicrotask(() => o.callback(token));
          return 'w1';
        }),
        reset: vi.fn(),
        remove: vi.fn(),
      };
      (window as { turnstile?: unknown }).turnstile = widget;
      return widget;
    }
    const withKey = (user?: typeof USER) =>
      fakeApi({ ...(user ? { user } : {}), session: vi.fn(async () => ({ anonId: true, tier: 'free' as const, limits: tiers.anonymous, turnstileSiteKey: 'SITE' })) });

    it('a visitor: the form has its own widget, and the token goes with the request', async () => {
      const widget = stubTurnstile();
      const api = withKey();
      renderApp({ route: '/business', api });
      await waitFor(() => expect(widget.render).toHaveBeenCalled());
      expect(widget.render.mock.calls[0]![1]).toMatchObject({ sitekey: 'SITE', appearance: 'interaction-only' });
      fill();
      fireEvent.click(screen.getByRole('button', { name: 'Send' }));
      await screen.findByText('We got your message and will write to you soon.');
      expect(api.contact.lead).toHaveBeenCalledWith(expect.objectContaining({ turnstileToken: 'tok-1', page: '/business' }));
    });

    it('a signed-in user is asked for nothing: no widget, no script, no token', async () => {
      const widget = stubTurnstile();
      const api = withKey(USER);
      renderApp({ route: '/business', api });
      await screen.findByRole('button', { name: /Account menu/ });
      await act(async () => {});
      fill();
      fireEvent.click(screen.getByRole('button', { name: 'Send' }));
      await screen.findByText('We got your message and will write to you soon.');
      expect(widget.render).not.toHaveBeenCalled();
      expect(api.contact.lead).toHaveBeenCalledWith(expect.not.objectContaining({ turnstileToken: expect.anything() }));
    });

    it('no site key (development): no widget and no token', async () => {
      const widget = stubTurnstile();
      const api = fakeApi();
      renderApp({ route: '/business', api });
      await act(async () => {});
      fill();
      fireEvent.click(screen.getByRole('button', { name: 'Send' }));
      await screen.findByText('We got your message and will write to you soon.');
      expect(widget.render).not.toHaveBeenCalled();
    });
  });
});

describe('the paid waitlist (the Upgrade button)', () => {
  it('on the business page: a button opens the form, and the entry says it came from nowhere in particular', async () => {
    const api = fakeApi();
    renderApp({ route: '/business', api });
    fireEvent.click(screen.getByRole('button', { name: 'Join the paid waitlist' }));
    const panel = screen.getByRole('region', { name: 'Join the paid waitlist' });
    expect(within(panel).getByText(/Paid plans are set up by our team for now/)).toBeTruthy();
    type(within(panel).getByLabelText(/^Email/), 'dana@example.com');
    type(within(panel).getByLabelText(/^What would you like from a paid plan/), 'Fifty files a month.');
    fireEvent.click(within(panel).getByRole('button', { name: 'Join the waitlist' }));
    expect(await within(panel).findByText('You are on the list. We will write to dana@example.com when paid plans open.')).toBeTruthy();
    expect(api.contact.waitlist).toHaveBeenCalledWith({ email: 'dana@example.com', message: 'Fifty files a month.', trigger: 'other', page: '/business' });
  });

  it('a signed-in user has the email filled in, and the message is optional', async () => {
    const api = fakeApi({ user: USER });
    renderApp({ route: '/business', api });
    await screen.findByRole('button', { name: /Account menu/ });
    fireEvent.click(screen.getByRole('button', { name: 'Join the paid waitlist' }));
    const panel = screen.getByRole('region', { name: 'Join the paid waitlist' });
    await waitFor(() => expect((within(panel).getByLabelText(/^Email/) as HTMLInputElement).value).toBe('dana@example.com'));
    fireEvent.click(within(panel).getByRole('button', { name: 'Join the waitlist' }));
    await within(panel).findByText(/You are on the list/);
    expect(api.contact.waitlist).toHaveBeenCalledWith({ email: 'dana@example.com', trigger: 'other', page: '/business' });
  });

  it('keeps the mail link for whoever would rather write, and closes with Escape', () => {
    renderApp({ route: '/business' });
    fireEvent.click(screen.getByRole('button', { name: 'Join the paid waitlist' }));
    expect(screen.getByRole('link', { name: 'Contact us' }).getAttribute('href')).toBe(webConfig.contactHref);
    fireEvent.keyDown(screen.getByRole('region', { name: 'Join the paid waitlist' }), { key: 'Escape' });
    expect(screen.queryByRole('region', { name: 'Join the paid waitlist' })).toBeNull();
  });

  it('refuses a missing email', () => {
    const api = fakeApi();
    renderApp({ route: '/business', api });
    fireEvent.click(screen.getByRole('button', { name: 'Join the paid waitlist' }));
    fireEvent.click(screen.getByRole('button', { name: 'Join the waitlist' }));
    expect(screen.getByText('Fill in this field.')).toBeTruthy();
    expect(api.contact.waitlist).not.toHaveBeenCalled();
  });
});

describe('feedback', () => {
  const open = (): HTMLElement => {
    fireEvent.click(within(screen.getByRole('contentinfo')).getByRole('button', { name: 'Feedback' }));
    return screen.getByRole('dialog', { name: 'Send feedback' });
  };

  it('opens from the footer as a dialog, asks for a message, and says which page goes with it', () => {
    renderApp({ route: '/formats' });
    const dialog = open();
    expect(within(dialog).getByLabelText(/^Your message/).getAttribute('aria-required')).toBe('true');
    expect(within(dialog).getByText('Email').closest('label')!.textContent).toBe('Email (optional)');
    expect(dialog.textContent).toContain('/formats');
    expect(dialog.textContent).toContain('Nothing from your files or your rules is sent.');
  });

  it('sends the message, the email when given and the page path - and nothing else - then thanks', async () => {
    const api = fakeApi();
    renderApp({ route: '/result', api });
    // (a bare /result goes home when no learn is kept: the path of the page the form is on is what is sent)
    await screen.findByRole('heading', { level: 1 });
    const dialog = open();
    type(within(dialog).getByLabelText(/^Your message/), 'The preview is great.');
    type(within(dialog).getByLabelText(/^Email/), 'me@example.com');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send feedback' }));
    expect(await within(dialog).findByText('Thank you. Your feedback was sent.')).toBeTruthy();
    expect(api.contact.feedback).toHaveBeenCalledTimes(1);
    const body = api.contact.feedback.mock.calls[0]![0] as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['email', 'message', 'page']);
    expect(body).toMatchObject({ message: 'The preview is great.', email: 'me@example.com' });
    // closing returns the focus to where it came from
    fireEvent.click(within(dialog).getAllByRole('button', { name: 'Close' }).find((b) => b.classList.contains('btn--primary'))!);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('refuses an empty message and does not send', () => {
    const api = fakeApi();
    renderApp({ api });
    const dialog = open();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send feedback' }));
    expect(within(dialog).getByText('Fill in this field.')).toBeTruthy();
    expect(api.contact.feedback).not.toHaveBeenCalled();
  });

  it('Escape closes it and the focus goes back to the footer button', () => {
    renderApp();
    const button = within(screen.getByRole('contentinfo')).getByRole('button', { name: 'Feedback' });
    button.focus();
    open();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  it('is in Hebrew too', async () => {
    const api = fakeApi();
    renderApp({ lang: 'he', api });
    fireEvent.click(within(screen.getByRole('contentinfo')).getByRole('button', { name: 'משוב' }));
    const dialog = screen.getByRole('dialog', { name: 'שליחת משוב' });
    type(within(dialog).getByLabelText(/^ההודעה שלכם/), 'תודה על הכלי');
    fireEvent.click(within(dialog).getByRole('button', { name: 'שליחת המשוב' }));
    expect(await within(dialog).findByText('תודה. המשוב נשלח.')).toBeTruthy();
    expect(api.contact.feedback).toHaveBeenCalledWith({ message: 'תודה על הכלי', page: '/' });
  });

  it('a signed-in user opens it from the account menu, with their email filled in; the focus returns to the menu button', async () => {
    const api = fakeApi({ user: USER });
    renderApp({ api });
    const menu = await screen.findByRole('button', { name: /Account menu/ });
    fireEvent.click(menu);
    fireEvent.click(within(screen.getByRole('group', { name: 'Account' })).getByRole('button', { name: 'Feedback' }));
    const dialog = screen.getByRole('dialog', { name: 'Send feedback' });
    await waitFor(() => expect((within(dialog).getByLabelText(/^Email/) as HTMLInputElement).value).toBe('dana@example.com'));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(document.activeElement).toBe(menu);
  });

  it('a visitor has a Turnstile widget in it; a signed-in user does not', async () => {
    const widget = { render: vi.fn((_c: HTMLElement, o: { callback(t: string): void }) => (queueMicrotask(() => o.callback('fb-token')), 'w')), reset: vi.fn(), remove: vi.fn() };
    (window as { turnstile?: unknown }).turnstile = widget;
    const api = fakeApi({ session: vi.fn(async () => ({ anonId: true, tier: 'free' as const, limits: tiers.anonymous, turnstileSiteKey: 'SITE' })) });
    renderApp({ api });
    await act(async () => {});
    const dialog = open();
    await waitFor(() => expect(widget.render).toHaveBeenCalled());
    type(within(dialog).getByLabelText(/^Your message/), 'Hello');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send feedback' }));
    await within(dialog).findByText('Thank you. Your feedback was sent.');
    expect(api.contact.feedback).toHaveBeenCalledWith({ message: 'Hello', page: '/', turnstileToken: 'fb-token' });
  });
});

describe('the footer', () => {
  it('has Business, Privacy, Terms, Accessibility and Feedback', () => {
    renderApp();
    const footer = screen.getByRole('contentinfo');
    const nav = within(footer).getByRole('navigation', { name: 'About formatAI' });
    expect(within(nav).getAllByRole('link').map((a) => [a.textContent, a.getAttribute('href')])).toEqual([
      ['Business', '/business'],
      ['Privacy', '/privacy'],
      ['Terms', '/terms'],
      ['Accessibility', '/accessibility'],
    ]);
    expect(within(nav).getByRole('button', { name: 'Feedback' })).toBeTruthy();
  });

  it('in Hebrew', () => {
    renderApp({ lang: 'he' });
    const nav = within(screen.getByRole('contentinfo')).getByRole('navigation');
    expect(within(nav).getAllByRole('link').map((a) => a.textContent)).toEqual(['לעסקים', 'פרטיות', 'תנאי שימוש', 'נגישות']);
    expect(within(nav).getByRole('button', { name: 'משוב' })).toBeTruthy();
  });
});
