// Identifier-shaped values (SPEC 21 v15 item 3; column classification, owner 2026-10-06). The five shapes code recognizes, each checked by
// a maintained library - validator.js, one file per check so a bundle takes only these:
//   - an Israeli ID number: `isIdentityCard(s, 'he-IL')` - exactly 9 digits with a valid check digit;
//   - a phone number: `isMobilePhone` - Israel's numbering plan ('he-IL': 05x mobiles, 02 / 03 / 04 / 08 / 09 landlines, 077) for a number
//     written with a leading 0 or +972, and every country validator knows for another `+` number (its mobile plans);
//   - an email address: `isEmail`;
//   - a card number: `isCreditCard` - a known issuer's prefix and length, and the Luhn check;
//   - an IBAN: `isIBAN` - the country's format and the mod-97 check.
// One implementation, two users: the Save popup (`identifierKindOf`: a value a saved format would keep, whole and then word by word) and the
// engine's column classification (`identifierShapeOf`: one cell, whole - `learn/classify.ts`).
//
// DECISIONS (code adds only the gates the library leaves open; conservative: a popup on the bookkeepers' most common format would be worse
// than none):
//   - NO digit-run rule (owner, 2026-10-06). Ledger account numbers, item codes and barcodes are labels all the time (`expense -> 61000100`);
//     only a shape with a check digit or a fixed format counts. A 9-digit code passes the ID check 1 time in 10: the popup then asks once.
//   - A card is 13 to 19 digits (spaces or dashes between them): validator's issuer patterns alone let a short number starting 51-55 through.
//     An Israeli barcode (EAN-13, 729...) passes Luhn 1 time in 10 too, but no issuer starts with 7.
//   - A phone is written with a leading 0 or `+` (separators removed first: validator reads bare digits); without them it is any number.
//   - A NUMBER is checked as an ID (9 digits) or a card (13 to 16 digits, the safe integers) only: a phone stored as a number has lost its
//     leading zero, and so has an ID of 8 digits - both then look like any other number, and an amount is never an identifier.
//   - All zeros is no ID ("000000000" passes the check digit) and no card.
// Values are never logged: a caller reports the column and the kind found.
//
// Pure; shared by the browser (the Save popup, the engine's worker), the server and the eval.
import isCreditCard from 'validator/lib/isCreditCard.js';
import isEmail from 'validator/lib/isEmail.js';
import isIBANModule from 'validator/lib/isIBAN.js';
import isIdentityCard from 'validator/lib/isIdentityCard.js';
import isMobilePhoneModule from 'validator/lib/isMobilePhone.js';

/**
 * A validator function from its CommonJS file: a bundler hands over `exports.default`; Node hands over the module itself for the two
 * files that export more than one name (`isIBAN`, `isMobilePhone`), whose function is then its `default`.
 */
function unwrap<F extends (...args: never[]) => unknown>(f: F): F {
  return typeof f === 'function' ? f : (f as unknown as { default: F }).default;
}
const isIBAN = unwrap(isIBANModule);
const isMobilePhone = unwrap(isMobilePhoneModule);

export const IDENTIFIER_KINDS = ['israeliId', 'phone', 'email', 'card', 'iban'] as const;
export type IdentifierKind = (typeof IDENTIFIER_KINDS)[number];

/**
 * True when `s` is 1-9 digits that, once left-padded to 9 digits, pass the Israeli ID check digit (the library's). For an ID that lost its
 * leading zeros as a number: the engine's masker, the profile and the `israeliIdChecksum` check read it from here.
 */
export function isValidIsraeliId(s: string): boolean {
  return /^\d{1,9}$/.test(s) && isIdentityCard(s.padStart(9, '0'), 'he-IL');
}

/** An Israeli ID number as a value: exactly 9 digits (no padding: an 8-digit code is not an ID), a valid check digit, not all zeros. */
export function isIsraeliIdNumber(text: string): boolean {
  return /^\d{9}$/.test(text) && !/^0+$/.test(text) && isIdentityCard(text, 'he-IL');
}

/** The separators a phone may be written with. */
const PHONE_SEPARATORS = /[\s\-.()]/g;

/** A phone number: Israel's numbering plan (a leading 0 or +972), or a `+` number of a country the library knows. */
export function isPhoneNumber(text: string): boolean {
  const t = text.trim();
  if (!/^\+?[\d\s\-.()]+$/.test(t)) return false;
  const s = t.replace(PHONE_SEPARATORS, '');
  if (s.startsWith('+')) return isMobilePhone(s, 'any', { strictMode: true });
  return s.startsWith('0') && isMobilePhone(s, 'he-IL');
}

/** An email address. */
export function isEmailAddress(text: string): boolean {
  return isEmail(text.trim());
}

/** A card number: 13 to 19 digits (single spaces or dashes between them allowed), not all zeros, a known issuer and the Luhn check. */
export function isCardNumber(text: string): boolean {
  const t = text.trim();
  return /^\d(?:[ -]?\d){12,18}$/.test(t) && !/^[0 -]+$/.test(t) && isCreditCard(t);
}

/** An IBAN (spaces allowed): the country's format and the mod-97 check. */
export function isIban(text: string): boolean {
  return isIBAN(text.trim().replace(/\s+/g, '').toUpperCase());
}

/** The kind of a whole text value, or null. An ID before a phone: a 9-digit landline shape that passes the check digit is an ID. */
function kindOfText(t: string): IdentifierKind | null {
  if (t.includes('@')) return isEmailAddress(t) ? 'email' : null;
  if (/^[A-Za-z]{2}\d/.test(t)) return isIban(t) ? 'iban' : null;
  if (isCardNumber(t)) return 'card';
  if (isIsraeliIdNumber(t)) return 'israeliId';
  if (isPhoneNumber(t)) return 'phone';
  return null;
}

/** Direction marks and isolates a cell may carry around its text (they are invisible, and no shape holds one). */
const BIDI_MARKS = /[‎‏‪-‮⁦-⁩]/g;

/**
 * The identifier kind of ONE whole value, or null: a number as an ID or a card; a text (trimmed, direction marks and non-breaking spaces
 * ignored) by its whole shape. The engine's column classification reads its cells with this.
 */
export function identifierShapeOf(value: unknown): IdentifierKind | null {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value <= 0) return null;
    const s = String(value);
    if (isIsraeliIdNumber(s)) return 'israeliId';
    return s.length >= 13 && isCardNumber(s) ? 'card' : null;
  }
  if (typeof value !== 'string') return null;
  const t = value.replace(BIDI_MARKS, '').replace(/ /g, ' ').trim();
  return t.length < 6 ? null : kindOfText(t);
}

/** Where a longer text is split into words: spaces and the punctuation a label puts around a value. */
const WORD_BREAKS = /[\s,;:()[\]{}<>"'|/\\]+/;

/**
 * The identifier kind of a value a format would save, or null (see the file header): the whole value (`identifierShapeOf`), then word by
 * word - a label may hold an identifier beside other words ("ID 123456782", "write to dana@example.com").
 */
export function identifierKindOf(value: unknown): IdentifierKind | null {
  const whole = identifierShapeOf(value);
  if (whole || typeof value !== 'string') return whole;
  const t = value.trim();
  for (const word of t.split(WORD_BREAKS)) {
    // (A word is checked on its own shape; one that is the whole text was checked above.)
    if (word.length < 6 || word === t) continue;
    const k = kindOfText(word.replace(/^[.\-]+|[.\-]+$/g, ''));
    if (k) return k;
  }
  return null;
}
