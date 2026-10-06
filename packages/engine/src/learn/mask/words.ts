// Shared low-level helpers for the masker (masker.ts) and the rules unmasker
// (unmaskRules.ts): splitting text into word/separator tokens, classifying
// characters by script, the replacement alphabets, and a deterministic
// byte stream derived from the HMAC key (counter-mode expansion, since one
// HMAC block is only 32 bytes but a word can be longer, and a fake Israeli
// ID needs several independent-looking digits from one call).

import { hmacSha256 } from './hmacSha256';

// ---------- Tokenizing (SPEC 7.2: "split on spaces and punctuation, keep separators") ----------

export interface WordToken {
  isWord: boolean;
  text: string;
}

const WORD_CHAR_RE = /[\p{L}\p{Nd}]/u;

/**
 * Splits `s` into a run of word tokens (letters/digits, any script) and
 * separator tokens (everything else: spaces, punctuation, geresh/quote marks).
 * Concatenating `text` back together reproduces `s` exactly.
 */
export function splitWords(s: string): WordToken[] {
  const tokens: WordToken[] = [];
  let current = '';
  let currentIsWord: boolean | null = null;
  for (const ch of s) {
    const isWord = WORD_CHAR_RE.test(ch);
    if (currentIsWord === null || isWord === currentIsWord) {
      current += ch;
    } else {
      tokens.push({ isWord: currentIsWord, text: current });
      current = ch;
    }
    currentIsWord = isWord;
  }
  if (current.length > 0) tokens.push({ isWord: currentIsWord ?? false, text: current });
  return tokens;
}

// ---------- Character classes and replacement alphabets ----------

/**
 * What a character of a word is replaced from: its script's own alphabet, keeping its case - digits, Latin, Hebrew, Arabic, Cyrillic,
 * Greek and the Arabic-Indic digits - or, for a letter or digit of any other script, a Latin letter (of its case) or an ASCII digit.
 * `other`: not a letter or a digit (never inside a word: `splitWords` makes it a separator), kept as it is.
 */
export type CharClass =
  | 'digit'
  | 'latinUpper'
  | 'latinLower'
  | 'hebrew'
  | 'arabic'
  | 'arabicDigit'
  | 'persianDigit'
  | 'cyrillicUpper'
  | 'cyrillicLower'
  | 'greekUpper'
  | 'greekLower'
  | 'otherDigit'
  | 'otherUpper'
  | 'otherLower'
  | 'other';

const LETTER_RE = /\p{L}/u;
const DIGIT_RE = /\p{Nd}/u;
const SCRIPTS: readonly [RegExp, CharClass, CharClass][] = [
  [/\p{Script=Latin}/u, 'latinUpper', 'latinLower'],
  [/\p{Script=Hebrew}/u, 'hebrew', 'hebrew'],
  [/\p{Script=Arabic}/u, 'arabic', 'arabic'],
  [/\p{Script=Cyrillic}/u, 'cyrillicUpper', 'cyrillicLower'],
  [/\p{Script=Greek}/u, 'greekUpper', 'greekLower'],
];

export function classifyChar(ch: string): CharClass {
  if (ch >= '0' && ch <= '9' && ch.length === 1) return 'digit';
  if (DIGIT_RE.test(ch)) {
    const cp = ch.codePointAt(0)!;
    if (cp >= 0x0660 && cp <= 0x0669) return 'arabicDigit';
    if (cp >= 0x06f0 && cp <= 0x06f9) return 'persianDigit';
    return 'otherDigit';
  }
  if (!LETTER_RE.test(ch)) return 'other';
  // (A letter with a lower-case form is upper case; one without case - Hebrew, Arabic, CJK - counts as lower.)
  const upper = ch !== ch.toLowerCase();
  for (const [re, up, low] of SCRIPTS) if (re.test(ch)) return upper ? up : low;
  return upper ? 'otherUpper' : 'otherLower';
}

export const DIGITS = '0123456789';
export const LATIN_UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
export const LATIN_LOWER = 'abcdefghijklmnopqrstuvwxyz';

/** The 22 base-form Hebrew letters, used at every position except the word's last. */
export const HEBREW_MID = 'אבגדהוזחטיכלמנסעפצקרשת';

// DECISION: Hebrew final forms (ך ם ן ף ץ) are only orthographically valid at
// the end of a word, so HEBREW_END substitutes them for their base-form
// counterparts (כ מ נ פ צ) and is used only for a word's last character; every
// other Hebrew position always uses HEBREW_MID. This is a property of the
// *position* being replaced, independent of whether the real character being
// replaced was itself a final form — a fake word should look plausible on its
// own regardless of which real letter it stands in for.
const HEBREW_FINAL_FORM: Readonly<Record<string, string>> = {
  כ: 'ך',
  מ: 'ם',
  נ: 'ן',
  פ: 'ף',
  צ: 'ץ',
};
export const HEBREW_END = Array.from(HEBREW_MID)
  .map((ch) => HEBREW_FINAL_FORM[ch] ?? ch)
  .join('');

/** The 28 Arabic letters (their written forms are contextual, so one alphabet serves every position). */
export const ARABIC = 'ابتثجحخدذرزسشصضطظعغفقكلمنهوي';
/** Cyrillic letters, both cases (without Ё, Ъ, Ы, Ь: they never start a word, and a fake needs none of them). */
export const CYRILLIC_UPPER = 'АБВГДЕЖЗИЙКЛМНОПРСТУФХЦЧШЩЭЮЯ';
export const CYRILLIC_LOWER = 'абвгдежзийклмнопрстуфхцчшщэюя';
export const GREEK_UPPER = 'ΑΒΓΔΕΖΗΘΙΚΛΜΝΞΟΠΡΣΤΥΦΧΨΩ';
export const GREEK_LOWER = 'αβγδεζηθικλμνξοπρστυφχψω';

const ALPHABET: Readonly<Record<Exclude<CharClass, 'hebrew' | 'other'>, string>> = {
  digit: DIGITS,
  latinUpper: LATIN_UPPER,
  latinLower: LATIN_LOWER,
  arabic: ARABIC,
  arabicDigit: '٠١٢٣٤٥٦٧٨٩',
  persianDigit: '۰۱۲۳۴۵۶۷۸۹',
  cyrillicUpper: CYRILLIC_UPPER,
  cyrillicLower: CYRILLIC_LOWER,
  greekUpper: GREEK_UPPER,
  greekLower: GREEK_LOWER,
  otherDigit: DIGITS,
  otherUpper: LATIN_UPPER,
  otherLower: LATIN_LOWER,
};

/**
 * Builds a fake word of the same length and per-character script and case as `chars`, one byte of `bytes` per character
 * (bytes.length must be >= chars.length). Every letter and digit is replaced (`classifyChar`): DECISION (column classification, owner
 * 2026-10-06, stress finding O1): a letter of a script with no alphabet here is never sent real - it becomes a Latin letter of its case,
 * an accented Latin letter a plain one, a digit of another script an ASCII digit. Only a non-letter (never inside a word) is kept.
 */
export function buildWordFromBytes(chars: readonly string[], bytes: Uint8Array): string {
  const n = chars.length;
  let out = '';
  for (let i = 0; i < n; i++) {
    const ch = chars[i]!;
    const byte = bytes[i]!;
    const cls = classifyChar(ch);
    if (cls === 'other') out += ch;
    else {
      const alphabet = cls === 'hebrew' ? (i === n - 1 ? HEBREW_END : HEBREW_MID) : ALPHABET[cls];
      out += alphabet[byte % alphabet.length]; // (every alphabet here is in the BMP: one code unit per letter)
    }
  }
  return out;
}

// ---------- Deterministic byte stream from the key ----------

const utf8Encoder = new TextEncoder();

/**
 * `count` deterministic bytes derived from `key` and `label`, expanding past
 * one HMAC block (32 bytes) with counter mode: HMAC(key, `${label}|${counter}`).
 * Same key + label always yields the same bytes; nothing here is random.
 */
export function deriveBytes(key: Uint8Array, label: string, count: number): Uint8Array {
  const out = new Uint8Array(count);
  let filled = 0;
  let counter = 0;
  while (filled < count) {
    const block = hmacSha256(key, utf8Encoder.encode(`${label}|${counter}`));
    const take = Math.min(block.length, count - filled);
    out.set(block.subarray(0, take), filled);
    filled += take;
    counter++;
  }
  return out;
}
