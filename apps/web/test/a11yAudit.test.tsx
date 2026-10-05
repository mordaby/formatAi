// A structural accessibility pass over the real screens (IS 5568 / WCAG 2.1 AA; v13 M4): every control named, one <main>, a title per page,
// unique ids, headings in order. The screens are rendered the way the other tests render them; the result of each is a list of findings, which
// must be empty - so a later change that adds an unlabelled field fails here.
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { auditDom } from './helpers/auditDom';
import { fakeApi, renderApp, USER } from './helpers/renderApp';
import { openLine, openResult } from './helpers/resultKit';

beforeEach(() => {
  document.cookie = 'lang=; Path=/; Max-Age=0';
});
afterEach(() => {
  cleanup();
  document.cookie = 'lang=; Path=/; Max-Age=0';
  document.documentElement.className = '';
});

describe.each(['en', 'he'] as const)('structural accessibility (%s)', (lang) => {
  it.each([['/'], ['/business'], ['/privacy'], ['/terms'], ['/accessibility']])('%s has no findings', async (route) => {
    renderApp({ lang, route });
    await screen.findByRole('heading', { level: 1 });
    expect(auditDom()).toEqual([]);
  });

  it('the Business page with the waitlist panel open', async () => {
    renderApp({ lang, route: '/business' });
    fireEvent.click(screen.getByRole('button', { name: lang === 'he' ? /רשימת ההמתנה/ : /paid waitlist/ }));
    expect(auditDom()).toEqual([]);
  });

  it('the feedback dialog', async () => {
    renderApp({ lang, route: '/privacy' });
    fireEvent.click(screen.getByRole('button', { name: lang === 'he' ? 'משוב' : 'Feedback' }));
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(auditDom()).toEqual([]);
  });

  it('the accessibility panel', async () => {
    renderApp({ lang, route: '/business' });
    fireEvent.click(screen.getByRole('button', { name: lang === 'he' ? 'אפשרויות נגישות' : 'Accessibility options' }));
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(auditDom()).toEqual([]);
  });

  it('a signed-in header with the account menu open', async () => {
    renderApp({ lang, api: fakeApi({ user: USER }) });
    fireEvent.click(await screen.findByRole('button', { name: /Account menu|תפריט החשבון/ }));
    expect(auditDom()).toEqual([]);
  });
});

describe('the Result screen', () => {
  it('has no findings, with the rules map and with an editor open', async () => {
    await openResult();
    expect(auditDom()).toEqual([]);
    openLine('col:Total');
    expect(auditDom()).toEqual([]);
  });
});
