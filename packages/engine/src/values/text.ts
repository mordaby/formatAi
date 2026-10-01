// Pure text primitives: normalization, Hebrew detection, padding, column letters.
// No DOM, no Node-only APIs, no locale/clock dependence.

/**
 * Normalizes text for header matching, stopAt matching and dedupe comparison:
 * NFC-normalizes, trims, collapses internal whitespace (including NBSP) to a
 * single space, and unifies quote/geresh variants.
 */
export function normalizeText(s: string): string {
  let out = s.normalize('NFC');

  // Two raw apostrophes stand in for a double quote (common typing habit).
  // This must run before the single-quote unification below, otherwise each
  // apostrophe would be converted on its own instead of as a pair.
  out = out.replace(/''/g, '"');

  // Double-quote-like marks: gershayim (״), curly double quotes, low-9 quote.
  out = out.replace(/[״“”„]/g, '"');

  // Single-quote-like marks: geresh (׳), curly single quotes, backtick.
  out = out.replace(/[׳‘’`]/g, "'");

  // Collapse any run of whitespace (regular space, tab, newline, NBSP, etc.) to one space.
  out = out.replace(/[\s ]+/g, ' ');

  return out.trim();
}

const HEBREW_LETTER_RE = /[א-ת]/;
const LETTER_RE = /\p{L}/u;

/**
 * True when the majority of letter characters in `s` are Hebrew letters.
 * Non-letter characters (digits, punctuation, spaces) are ignored.
 */
export function isHebrewText(s: string): boolean {
  let hebrew = 0;
  let letters = 0;
  for (const ch of s) {
    if (LETTER_RE.test(ch)) {
      letters++;
      if (HEBREW_LETTER_RE.test(ch)) hebrew++;
    }
  }
  if (letters === 0) return false;
  // DECISION: "mostly Hebrew" = a strict majority of letter characters are Hebrew.
  return hebrew / letters > 0.5;
}

/** Fraction of letter characters (across all strings) that are Hebrew letters, 0 when there are none. */
export function hebrewRatio(strings: string[]): number {
  let hebrew = 0;
  let letters = 0;
  for (const s of strings) {
    for (const ch of s) {
      if (LETTER_RE.test(ch)) {
        letters++;
        if (HEBREW_LETTER_RE.test(ch)) hebrew++;
      }
    }
  }
  return letters === 0 ? 0 : hebrew / letters;
}

/** Left-pads `s` with `char` (default '0') until it reaches `length`. Never truncates. */
export function padLeft(s: string, length: number, char = '0'): string {
  if (s.length >= length || char.length === 0) return s;
  const padLen = length - s.length;
  const rep = char.repeat(Math.ceil(padLen / char.length)).slice(0, padLen);
  return rep + s;
}

const DIGIT_RE = /\p{Nd}/u;

function isLetterChar(ch: string): boolean {
  return LETTER_RE.test(ch);
}
function isDigitChar(ch: string): boolean {
  return DIGIT_RE.test(ch);
}

/**
 * Keeps only the characters of a named class, in order (`keepChars`, SPEC 8.3): `digits` = Unicode
 * decimal digits, `letters` = Unicode letters (Hebrew letters included; niqqud, punctuation and
 * spaces are not letters), `lettersAndDigits` = both. A closed set of classes, never a pattern.
 */
export function keepCharsOfClass(s: string, cls: 'digits' | 'letters' | 'lettersAndDigits'): string {
  let out = '';
  for (const ch of s) {
    const keep = cls === 'digits' ? isDigitChar(ch) : cls === 'letters' ? isLetterChar(ch) : isLetterChar(ch) || isDigitChar(ch);
    if (keep) out += ch;
  }
  return out;
}

/**
 * Title case (`titleCase`, SPEC 8.3): a word starts at the beginning and after any whitespace or
 * hyphen; its first letter becomes upper case and every other letter lower case. Leading
 * punctuation does not count ("(israel)" -> "(Israel)"), a word that starts with a digit is left
 * as it is apart from lower-casing ("3RD" -> "3rd"), and the letter after an apostrophe is lower
 * ("o'neil" -> "O'neil"). Scripts without case (Hebrew) are unchanged.
 */
export function titleCaseText(s: string): string {
  let out = '';
  let inWord = false; // inside a word whose first letter/digit has been seen
  for (const ch of s) {
    if (ch === '-' || /\s/u.test(ch)) {
      out += ch;
      inWord = false;
    } else if (inWord) {
      out += ch.toLowerCase();
    } else if (isLetterChar(ch)) {
      out += ch.toUpperCase();
      inWord = true;
    } else {
      out += ch;
      if (isDigitChar(ch)) inWord = true;
    }
  }
  return out;
}

/** 0-based column index to Excel column letters: 0 -> A, 25 -> Z, 26 -> AA. */
export function columnLetter(index0: number): string {
  let n = index0 + 1; // switch to 1-based for the bijective base-26 conversion
  let result = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    result = String.fromCharCode(65 + rem) + result;
    n = Math.floor((n - 1) / 26);
  }
  return result;
}
