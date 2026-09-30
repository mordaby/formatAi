import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LanguageToggle } from '../src/components/LanguageToggle';
import {
  browserLanguages,
  codeText,
  detectLang,
  directionOf,
  en,
  he,
  I18nProvider,
  initialLang,
  interpolate,
  readLangCookie,
  translate,
  useI18n,
  writeLangCookie,
} from '../src/i18n';

function clearCookie(): void {
  document.cookie = 'lang=; Path=/; Max-Age=0';
}

function stubBrowserLanguages(languages: string[]): void {
  vi.stubGlobal('navigator', { language: languages[0], languages });
}

beforeEach(() => {
  clearCookie();
  document.documentElement.lang = '';
  document.documentElement.dir = '';
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  clearCookie();
});

describe('language detection (SPEC 16.2)', () => {
  it('follows the browser language when there is no cookie', () => {
    expect(detectLang({ languages: ['he-IL'] })).toBe('he');
    expect(detectLang({ languages: ['he'] })).toBe('he');
    expect(detectLang({ languages: ['iw'] })).toBe('he'); // legacy code for Hebrew
    expect(detectLang({ languages: ['en-US'] })).toBe('en');
  });

  it('takes the first supported language in the browser preference list', () => {
    expect(detectLang({ languages: ['fr-FR', 'he', 'en'] })).toBe('he');
    expect(detectLang({ languages: ['fr-FR', 'en', 'he'] })).toBe('en');
  });

  it('falls back to English for an unsupported or missing language', () => {
    expect(detectLang({ languages: ['fr-FR', 'de'] })).toBe('en');
    expect(detectLang({ languages: [] })).toBe('en');
    expect(detectLang({})).toBe('en');
  });

  it('lets a saved cookie win over the browser language, and ignores a junk cookie', () => {
    expect(detectLang({ cookie: 'en', languages: ['he-IL'] })).toBe('en');
    expect(detectLang({ cookie: 'he', languages: ['en-US'] })).toBe('he');
    expect(detectLang({ cookie: 'klingon', languages: ['he-IL'] })).toBe('he');
  });

  it('reads navigator.languages, then navigator.language', () => {
    expect(browserLanguages({ language: 'he-IL', languages: ['he-IL', 'en'] })).toEqual(['he-IL', 'en']);
    expect(browserLanguages({ language: 'he-IL', languages: [] })).toEqual(['he-IL']);
  });

  it('initialLang combines the real cookie and navigator', () => {
    stubBrowserLanguages(['he-IL']);
    expect(initialLang()).toBe('he');
    writeLangCookie('en');
    expect(initialLang()).toBe('en');
  });
});

describe('cookie', () => {
  it('round-trips the language', () => {
    expect(readLangCookie()).toBeUndefined();
    writeLangCookie('he');
    expect(readLangCookie()).toBe('he');
    writeLangCookie('en');
    expect(readLangCookie()).toBe('en');
  });
});

describe('direction', () => {
  it('Hebrew is right-to-left, English left-to-right', () => {
    expect(directionOf('he')).toBe('rtl');
    expect(directionOf('en')).toBe('ltr');
  });
});

describe('dictionaries', () => {
  const placeholders = (s: string): string[] => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).sort();

  it('has the same keys in Hebrew and English, no empty strings, and the same placeholders', () => {
    expect(Object.keys(he).sort()).toEqual(Object.keys(en).sort());
    for (const key of Object.keys(en) as (keyof typeof en)[]) {
      expect(en[key].trim(), `en ${key}`).not.toBe('');
      expect(he[key].trim(), `he ${key}`).not.toBe('');
      expect(placeholders(he[key]), `placeholders of ${key}`).toEqual(placeholders(en[key]));
    }
  });

  it('interpolates {name} placeholders and leaves unknown ones alone', () => {
    expect(interpolate('Row {n} of {total}', { n: 3, total: 10 })).toBe('Row 3 of 10');
    expect(interpolate('Row {n} of {total}', { n: 3 })).toBe('Row 3 of {total}');
    expect(translate('en', 'error.fileTooLarge', { mb: '12.0', maxMb: 10 })).toContain('12.0 MB');
    expect(translate('he', 'error.fileTooLarge', { mb: '12.0', maxMb: 10 })).toContain('12.0');
  });

  it('resolves the shared code messages in both languages', () => {
    expect(codeText('en', { kind: 'unsupported', code: 'externalData' })).toMatch(/input file/);
    expect(codeText('he', { kind: 'unsupported', code: 'externalData' })).toMatch(/קובץ הקלט/);
    expect(codeText('en', { kind: 'preflight', code: 'pivotDetected' })).toMatch(/column headers/);
    expect(codeText('en', { kind: 'flag', code: 'flag.duplicateOf', params: { duplicateOf: 7 } })).toBe('Duplicate of row 7.');
    // A flag key the dictionary doesn't know shows as itself instead of crashing.
    expect(codeText('en', { kind: 'flag', code: 'flag.somethingNew' })).toBe('flag.somethingNew');
    // limitHit uses the text of the specific limit, when the server names one.
    expect(codeText('en', { kind: 'apiError', code: 'limitHit', limit: 'learnsPerDay' })).toMatch(/today/);
    expect(codeText('en', { kind: 'apiError', code: 'limitHit' })).toMatch(/limit/);
    expect(codeText('he', { kind: 'apiError', code: 'rateLimited' })).toMatch(/יותר מדי/);
  });
});

describe('<I18nProvider> and the toggle', () => {
  function Probe() {
    const { lang, dir, t } = useI18n();
    return (
      <p data-testid="probe">
        {lang}/{dir}/{t('app.name')}
      </p>
    );
  }

  it('starts from the browser language and sets <html lang dir>', () => {
    stubBrowserLanguages(['he-IL']);
    render(
      <I18nProvider>
        <Probe />
      </I18nProvider>,
    );
    expect(screen.getByTestId('probe').textContent).toBe('he/rtl/formatAI');
    expect(document.documentElement.lang).toBe('he');
    expect(document.documentElement.dir).toBe('rtl');
  });

  it('starts from the cookie when there is one', () => {
    stubBrowserLanguages(['he-IL']);
    writeLangCookie('en');
    render(
      <I18nProvider>
        <Probe />
      </I18nProvider>,
    );
    expect(screen.getByTestId('probe').textContent).toBe('en/ltr/formatAI');
    expect(document.documentElement.dir).toBe('ltr');
  });

  it('the toggle switches language and direction, and saves the choice in the cookie', () => {
    stubBrowserLanguages(['en-US']);
    render(
      <I18nProvider>
        <Probe />
        <LanguageToggle />
      </I18nProvider>,
    );
    expect(document.documentElement.dir).toBe('ltr');
    // In English the button offers Hebrew, labelled in Hebrew.
    const toHebrew = screen.getByRole('button', { name: 'עבור לעברית' });
    expect(toHebrew.textContent).toBe('עברית');

    fireEvent.click(toHebrew);
    expect(screen.getByTestId('probe').textContent).toBe('he/rtl/formatAI');
    expect(document.documentElement.lang).toBe('he');
    expect(document.documentElement.dir).toBe('rtl');
    expect(readLangCookie()).toBe('he');

    fireEvent.click(screen.getByRole('button', { name: 'Switch to English' }));
    expect(document.documentElement.dir).toBe('ltr');
    expect(readLangCookie()).toBe('en');
  });

  it('useI18n outside the provider is a clear error', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<Probe />)).toThrow(/I18nProvider/);
    spy.mockRestore();
  });

  it('does not touch the cookie until the user chooses', () => {
    stubBrowserLanguages(['he-IL']);
    act(() => {
      render(
        <I18nProvider>
          <Probe />
        </I18nProvider>,
      );
    });
    expect(readLangCookie()).toBeUndefined();
  });
});
