import { describe, expect, it } from 'vitest';
import { HEBREW_END, HEBREW_MID, splitWords } from '../../../src/learn/mask/words';

describe('splitWords', () => {
  it('splits on spaces and punctuation, keeping separators, and rejoins losslessly', () => {
    const s = 'זקמ עגש, 40217763-A!';
    const tokens = splitWords(s);
    expect(tokens.map((t) => t.text).join('')).toBe(s);
    expect(tokens.filter((t) => t.isWord).map((t) => t.text)).toEqual([
      'זקמ',
      'עגש',
      '40217763',
      'A',
    ]);
  });

  it('treats geresh/quote marks as separators', () => {
    const tokens = splitWords('מס\' פוליסה');
    expect(tokens.map((t) => t.text).join('')).toBe('מס\' פוליסה');
    expect(tokens.filter((t) => t.isWord).map((t) => t.text)).toEqual(['מס', 'פוליסה']);
  });

  it('handles the empty string', () => {
    expect(splitWords('')).toEqual([]);
  });

  it('handles a string that is all separators', () => {
    const tokens = splitWords('   -- ');
    expect(tokens.every((t) => !t.isWord)).toBe(true);
    expect(tokens.map((t) => t.text).join('')).toBe('   -- ');
  });
});

describe('Hebrew alphabets', () => {
  it('HEBREW_MID has the 22 base-form letters, no final forms', () => {
    expect(HEBREW_MID).toHaveLength(22);
    for (const finalForm of ['ך', 'ם', 'ן', 'ף', 'ץ']) {
      expect(HEBREW_MID.includes(finalForm)).toBe(false);
    }
  });

  it('HEBREW_END has 22 letters, with the 5 final forms in place of their base', () => {
    expect(HEBREW_END).toHaveLength(22);
    for (const finalForm of ['ך', 'ם', 'ן', 'ף', 'ץ']) {
      expect(HEBREW_END.includes(finalForm)).toBe(true);
    }
    for (const base of ['כ', 'מ', 'נ', 'פ', 'צ']) {
      expect(HEBREW_END.includes(base)).toBe(false);
    }
  });
});
