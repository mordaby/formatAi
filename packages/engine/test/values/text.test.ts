import { describe, expect, it } from 'vitest';
import { columnLetter, hebrewRatio, isHebrewText, keepCharsOfClass, normalizeText, padLeft, titleCaseText } from '../../src/values/text';

describe('normalizeText', () => {
  it('trims and collapses internal whitespace, including NBSP', () => {
    expect(normalizeText('  hello   world  ')).toBe('hello world');
    expect(normalizeText('a  b')).toBe('a b');
    expect(normalizeText('\tfoo\nbar\t')).toBe('foo bar');
  });

  it('unifies double-quote-like marks (gershayim, curly quotes, two apostrophes) to "', () => {
    expect(normalizeText('הוא אמר ״שלום״')).toBe('הוא אמר "שלום"');
    expect(normalizeText('curly “quotes”')).toBe('curly "quotes"');
    expect(normalizeText('low-9 „quote„')).toBe('low-9 "quote"');
    expect(normalizeText("O''Brien")).toBe('O"Brien');
  });

  it('unifies single-quote-like marks (geresh, curly quotes, backtick) to \'', () => {
    expect(normalizeText('א׳')).toBe("א'"); // א׳ -> א'
    expect(normalizeText('curly ‘word’')).toBe("curly 'word'");
    expect(normalizeText('back`tick')).toBe("back'tick");
  });

  it('NFC-normalizes composed characters', () => {
    const decomposed = 'é'; // e + combining acute accent
    expect(normalizeText(decomposed)).toBe('é'); // é (composed)
  });
});

describe('isHebrewText / hebrewRatio', () => {
  it('detects mostly-Hebrew text', () => {
    expect(isHebrewText('שלום עולם test')).toBe(true);
    expect(isHebrewText('hello world')).toBe(false);
  });

  it('has no letters -> not Hebrew', () => {
    expect(isHebrewText('123 456')).toBe(false);
  });

  it('computes the Hebrew ratio across several strings', () => {
    expect(hebrewRatio(['שלום', 'hello'])).toBeCloseTo(4 / 9, 10);
    expect(hebrewRatio(['abc', 'def'])).toBe(0);
    expect(hebrewRatio([])).toBe(0);
  });
});

describe('padLeft', () => {
  it('pads with the default zero character', () => {
    expect(padLeft('7', 3)).toBe('007');
  });

  it('pads with a custom character', () => {
    expect(padLeft('7', 4, 'x')).toBe('xxx7');
  });

  it('never truncates a string already at or beyond the target length', () => {
    expect(padLeft('12345', 3)).toBe('12345');
    expect(padLeft('123', 3)).toBe('123');
  });
});

describe('columnLetter', () => {
  it('converts 0-based column indices to Excel letters', () => {
    expect(columnLetter(0)).toBe('A');
    expect(columnLetter(25)).toBe('Z');
    expect(columnLetter(26)).toBe('AA');
    expect(columnLetter(27)).toBe('AB');
    expect(columnLetter(701)).toBe('ZZ');
    expect(columnLetter(702)).toBe('AAA');
  });
});

describe('keepCharsOfClass', () => {
  it('keeps only the characters of the class, in order', () => {
    expect(keepCharsOfClass('Ref#A-77/2024', 'digits')).toBe('772024');
    expect(keepCharsOfClass('Ref#A-77/2024', 'letters')).toBe('RefA');
    expect(keepCharsOfClass('Ref#A-77/2024', 'lettersAndDigits')).toBe('RefA772024');
  });

  it('counts Hebrew letters as letters; niqqud, punctuation and spaces are not', () => {
    expect(keepCharsOfClass("מס' 4521-ב", 'letters')).toBe('מסב');
    expect(keepCharsOfClass("מס' 4521-ב", 'lettersAndDigits')).toBe('מס4521ב');
    expect(keepCharsOfClass('בע"מ', 'letters')).toBe('בעמ');
  });

  it('is Unicode-aware for other scripts and digits, and never splits a surrogate pair', () => {
    expect(keepCharsOfClass('Ünïcödé-1', 'letters')).toBe('Ünïcödé');
    expect(keepCharsOfClass('١٢٣ abc', 'digits')).toBe('١٢٣');
    expect(keepCharsOfClass('a\u{1F600}b', 'letters')).toBe('ab');
  });
});

describe('titleCaseText', () => {
  it('upper-cases the first letter of each word and lower-cases the rest', () => {
    expect(titleCaseText('dana COHEN')).toBe('Dana Cohen');
    expect(titleCaseText('ALL CAPS HERE')).toBe('All Caps Here');
  });

  it('starts a word after whitespace or a hyphen only', () => {
    expect(titleCaseText('anne-marie o\'brien')).toBe('Anne-Marie O\'brien');
    expect(titleCaseText('a_b c.d')).toBe('A_b C.d');
  });

  it('skips leading punctuation, keeps a leading digit as is, leaves Hebrew alone', () => {
    expect(titleCaseText('"quoted" (x)')).toBe('"Quoted" (X)');
    expect(titleCaseText('2ND FLOOR')).toBe('2nd Floor');
    expect(titleCaseText('דנה כהן')).toBe('דנה כהן');
    expect(titleCaseText('')).toBe('');
  });
});
