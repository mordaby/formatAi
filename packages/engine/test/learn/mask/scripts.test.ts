// Letters of every script are masked (column classification, owner 2026-10-06; stress finding O1): Arabic and Cyrillic get a fake of the
// same script that keeps the word's length and case, like Hebrew and Latin; any other letter is never sent real - a same-script letter when
// there is an alphabet for it (Greek, the Arabic-Indic digits), else a Latin letter of its case (an accented Latin letter a plain one).
import { describe, expect, it } from 'vitest';
import { createMasker } from '../../../src/learn/mask';
import { ARABIC, CYRILLIC_LOWER, CYRILLIC_UPPER, classifyChar } from '../../../src/learn/mask/words';

const masker = (seed = 'scripts') => createMasker(new TextEncoder().encode(seed));
const words = (s: string): string[] => s.match(/[\p{L}\p{Nd}]+/gu) ?? [];

/** Every word of `real` became a different word of the same length; separators kept. */
function expectMasked(real: string, fake: string): void {
  expect(fake.replace(/[\p{L}\p{Nd}]/gu, 'x')).toBe(real.replace(/[\p{L}\p{Nd}]/gu, 'x'));
  const fakeWords = words(fake);
  words(real).forEach((w, k) => {
    expect(fakeWords[k]).not.toBe(w);
    expect(Array.from(fakeWords[k]!)).toHaveLength(Array.from(w).length);
  });
  for (const w of words(real)) expect(fake).not.toContain(w);
}

describe('Arabic and Cyrillic are masked with a fake of their own script', () => {
  it.each(['محمد خليل', 'أحمد سعيد'])('%s', (real) => {
    const fake = masker().maskText(real);
    expectMasked(real, fake);
    for (const ch of words(fake).join('')) expect(ARABIC.includes(ch)).toBe(true);
  });

  it.each(['Сергей Иванов', 'Ольга Петрова', 'ЁЛКА ёлка'])('%s, keeping the case of each letter', (real) => {
    const fake = masker().maskText(real);
    expectMasked(real, fake);
    const r = Array.from(words(real).join(''));
    Array.from(words(fake).join('')).forEach((ch, k) => {
      const upper = r[k] !== r[k]!.toLowerCase();
      expect((upper ? CYRILLIC_UPPER : CYRILLIC_LOWER).includes(ch)).toBe(true);
    });
  });

  it('the same real word gets the same fake everywhere (in another cell, in an ID column)', () => {
    const m = masker('same');
    const a = m.maskText('محمد خليل');
    const b = m.maskText('خليل');
    expect(b).toBe(a.split(' ')[1]);
    expect(m.maskCell('Ольга', 'identifier')).toBe(m.maskText('Ольга'));
    expect(m.fakeToReal.get(b)).toBe('خليل');
  });
});

describe('any other letter is never sent real', () => {
  it('accented Latin letters become plain Latin letters of their case', () => {
    for (const real of ['José Muñoz', 'Zoë Brontë', 'François Dubois', 'Øystein Åberg', 'Straße']) {
      const fake = masker().maskText(real);
      expectMasked(real, fake);
      expect(fake).toMatch(/^[A-Za-z ]+$/);
      expect(fake[0]).toMatch(/[A-Z]/);
    }
  });

  it('Greek gets Greek letters; CJK, Thai and Devanagari letters get Latin ones; Arabic-Indic digits stay Arabic-Indic', () => {
    const m = masker();
    expect(m.maskText('Αθηνά')).toMatch(/^[Α-Ωα-ω]{5}$/);
    expect(m.maskText('王小明')).toMatch(/^[a-z]{3}$/);
    expect(m.maskText('สมชาย')).toMatch(/^[a-z]+$/);
    const digits = m.maskText('١٢٣٤٥٦');
    expect(digits).toMatch(/^[٠-٩]{6}$/);
    expect(digits).not.toBe('١٢٣٤٥٦');
  });

  it('classifyChar: a script with no alphabet falls back to Latin by case; a non-letter is kept', () => {
    expect(classifyChar('ж')).toBe('cyrillicLower');
    expect(classifyChar('Ж')).toBe('cyrillicUpper');
    expect(classifyChar('ع')).toBe('arabic');
    expect(classifyChar('é')).toBe('latinLower');
    expect(classifyChar('Ω')).toBe('greekUpper');
    expect(classifyChar('王')).toBe('otherLower');
    expect(classifyChar('Ա')).toBe('otherUpper'); // Armenian
    expect(classifyChar('۳')).toBe('persianDigit');
    expect(classifyChar('-')).toBe('other');
  });

  it('Hebrew, Latin and digit fakes are what they were (the same alphabets, the same bytes); only the accented letter changed', () => {
    const m = masker('stable');
    // The values the masker gave before this change, for the same key ("José" was "Pcié": the "é" went out real).
    expect([m.maskText('דנה כהן'), m.maskText('Dana Cohen'), m.maskText('12345'), m.maskText('José')]).toEqual(['הלץ אטת', 'Vity Dampq', '27222', 'Pciu']);
  });
});
