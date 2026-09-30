import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { I18nProvider, type Lang } from '../src/i18n';
import { HomeMasking } from '../src/pages/HomeMasking';

afterEach(cleanup);

// SPEC 7.2 UI copy, verbatim. The product promise lives in these sentences, so the test pins them.
const COPY = {
  en: {
    on: 'Masking on: names, ID numbers and other text in the sample rows are replaced with look-alike values before anything leaves your computer. Numbers, dates and column names are sent as they are.',
    off: 'Masking off: up to 12 sample rows are sent as they are. Learning is more accurate when a column is built from part of a text value, like the first digits of a policy number.',
    always: 'Your full files never leave your computer.',
    label: 'Masking',
  },
  he: {
    on: 'הסתרת נתונים פועלת: שמות, מספרי זהות וטקסט בשורות הדוגמה מוחלפים בערכים מדומים לפני שהם יוצאים מהמחשב שלך. מספרים, תאריכים ושמות העמודות נשלחים כפי שהם.',
    off: 'הסתרת נתונים כבויה: עד 12 שורות דוגמה נשלחות כפי שהן. הלמידה מדויקת יותר כשעמודה נבנית מחלק של ערך טקסט, למשל הספרות הראשונות של מספר פוליסה.',
    always: 'הקבצים המלאים לעולם לא יוצאים מהמחשב שלך.',
    label: 'הסתרת נתונים',
  },
} as const;

function Harness({ lang }: { lang: Lang }) {
  const [masking, setMasking] = useState(true);
  return (
    <I18nProvider initial={lang}>
      <HomeMasking masking={masking} onChange={setMasking} />
    </I18nProvider>
  );
}

describe.each(['en', 'he'] as const)('masking switch (%s)', (lang) => {
  const copy = COPY[lang];

  it('is on by default, with the "on" sentence next to it', () => {
    render(<Harness lang={lang} />);
    const toggle = screen.getByRole('switch', { name: copy.label }) as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    expect(screen.getByText(copy.on, { exact: false })).toBeTruthy();
  });

  it('switches to the "off" sentence when turned off, and back', () => {
    render(<Harness lang={lang} />);
    const toggle = screen.getByRole('switch', { name: copy.label }) as HTMLInputElement;
    fireEvent.click(toggle);
    expect(toggle.checked).toBe(false);
    expect(screen.getByText(copy.off, { exact: false })).toBeTruthy();
    expect(screen.queryByText(copy.on, { exact: false })).toBeNull();
    fireEvent.click(toggle);
    expect(screen.getByText(copy.on, { exact: false })).toBeTruthy();
  });

  it('describes the switch by its explanation, for screen readers', () => {
    render(<Harness lang={lang} />);
    const toggle = screen.getByRole('switch', { name: copy.label });
    const describedBy = toggle.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy!)?.textContent).toContain(copy.on);
  });

  it('opens the difference panel with the on, off and always copy, and closes it again', () => {
    render(<Harness lang={lang} />);
    const link = screen.getByRole('button', { name: lang === 'en' ? "What's the difference?" : 'מה ההבדל?' });
    expect(link.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(link);
    expect(link.getAttribute('aria-expanded')).toBe('true');

    const panel = screen.getByRole('region');
    expect(panel.textContent).toContain(copy.on);
    expect(panel.textContent).toContain(copy.off);
    expect(panel.textContent).toContain(copy.always);

    fireEvent.click(screen.getByRole('button', { name: lang === 'en' ? 'Close' : 'סגירה' }));
    expect(screen.queryByRole('region')).toBeNull();
    expect(link.getAttribute('aria-expanded')).toBe('false');
  });
});
