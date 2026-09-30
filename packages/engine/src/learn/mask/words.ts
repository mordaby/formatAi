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

export type CharClass = 'digit' | 'latinUpper' | 'latinLower' | 'hebrew' | 'other';

const DIGIT_RE = /[0-9]/;
const LATIN_UPPER_RE = /[A-Z]/;
const LATIN_LOWER_RE = /[a-z]/;
// The Hebrew letter block (U+05D0-U+05EA) includes both base forms and the
// five final forms (ך ם ן ף ץ); classification doesn't need to tell them apart,
// only word-end placement does (see HEBREW_END below).
const HEBREW_RE = /[א-ת]/;

export function classifyChar(ch: string): CharClass {
  if (DIGIT_RE.test(ch)) return 'digit';
  if (LATIN_UPPER_RE.test(ch)) return 'latinUpper';
  if (LATIN_LOWER_RE.test(ch)) return 'latinLower';
  if (HEBREW_RE.test(ch)) return 'hebrew';
  return 'other';
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

/**
 * Builds a fake word of the same length and per-character script/case as
 * `chars`, one byte of `bytes` per character (bytes.length must be >= chars.length).
 * Characters outside digit/Latin/Hebrew (SPEC 7.1's shape signature only
 * models D/A/H; everything else is "literal") pass through unchanged —
 * DECISION: there is no fake alphabet to draw from for an unmodeled script,
 * and leaving it as-is is safer than inventing one.
 */
export function buildWordFromBytes(chars: readonly string[], bytes: Uint8Array): string {
  const n = chars.length;
  let out = '';
  for (let i = 0; i < n; i++) {
    const ch = chars[i]!;
    const byte = bytes[i]!;
    switch (classifyChar(ch)) {
      case 'digit':
        out += DIGITS[byte % DIGITS.length];
        break;
      case 'latinUpper':
        out += LATIN_UPPER[byte % LATIN_UPPER.length];
        break;
      case 'latinLower':
        out += LATIN_LOWER[byte % LATIN_LOWER.length];
        break;
      case 'hebrew': {
        const alphabet = i === n - 1 ? HEBREW_END : HEBREW_MID;
        out += alphabet[byte % alphabet.length];
        break;
      }
      default:
        out += ch;
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
