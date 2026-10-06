// Identifier-shaped values (docs/proposals/saved-format-contents.md section 5; SPEC 21 v15): a value a saved format would keep - a label, a
// table key or value, a condition's constant, a "Do this every time?" fix - is checked against the shapes code recognizes with CERTAINTY:
//   - an Israeli ID number: exactly 9 digits with a valid check digit (`isValidIsraeliId`);
//   - a phone number: Israeli mobile / VoIP (05x / 07x, 10 digits), a landline (02 / 03 / 04 / 08 / 09, 9 digits), or an international `+`
//     form (`+` and 8 to 15 digits: +972 ... is one of them);
//   - an email address;
//   - a card number: 13 to 19 digits, Luhn-valid, starting with 2-6 (the payment cards' major industry identifiers);
//   - an IBAN: a country code, two check digits and 11 to 30 letters or digits, mod-97 valid.
// A match goes to the one popup at Save ("Target customer keeps an ID number in its rules"); nothing else is done with it here.
//
// DECISIONS (conservative: a popup on the bookkeepers' most common format would be worse than none):
//   - NO digit-run rule (owner, 2026-10-06). Accounting formats map to ledger account numbers, item codes and barcodes as labels all the time
//     (`expense -> 61000100`); only a shape with a check digit or a fixed format counts. A 9-digit code passes the ID check 1 time in 10:
//     the popup then asks once, and Keep keeps it.
//   - A card starts with 2-6: an Israeli barcode (EAN-13, 729...) is 13 digits and passes Luhn 1 time in 10 too, but starts with 7.
//   - A NUMBER is checked as an ID (9 digits) or a card (13 to 16 digits, the safe integers) only: a phone stored as a number has lost its
//     leading zero, and so has an ID of 8 digits - both then look like any other number, and an amount is never an identifier.
//   - The whole value is checked first (separators allowed: "03-123 4567", "4580 1234 5678 9010", "IL62 0108 0000 0009 9999 999"), then each
//     word of a longer text ("ID 123456782", "write to dana@example.com"): a label may hold an identifier beside other words.
//   - All zeros is no ID ("000000000" passes the check digit) and no card.
// Values are never logged: a caller reports the column and the kind found.
//
// Pure; shared by the browser (the Save popup), the engine and the eval.

export const IDENTIFIER_KINDS = ['israeliId', 'phone', 'email', 'card', 'iban'] as const;
export type IdentifierKind = (typeof IDENTIFIER_KINDS)[number];

/**
 * True when `s` is 1-9 digits that, once left-padded to 9 digits, pass the standard Israeli ID check-digit algorithm (alternating weights
 * 1/2, digits of a weighted product >= 10 are summed, total must be a multiple of 10). (The engine's masker and the `israeliIdChecksum`
 * check read it from here.)
 */
export function isValidIsraeliId(s: string): boolean {
  if (!/^\d{1,9}$/.test(s)) return false;
  const id = s.padStart(9, '0');
  let sum = 0;
  for (let i = 0; i < 9; i++) {
    const weight = (i % 2) + 1;
    let digit = Number(id[i]) * weight;
    if (digit > 9) digit -= 9;
    sum += digit;
  }
  return sum % 10 === 0;
}

/** An Israeli ID number as a saved value: exactly 9 digits (no padding: an 8-digit code is not an ID), a valid check digit, not all zeros. */
export function isIsraeliIdNumber(text: string): boolean {
  return /^\d{9}$/.test(text) && !/^0+$/.test(text) && isValidIsraeliId(text);
}

/** The separators a phone, a card or an IBAN may be written with. */
const SEPARATORS = /[\s\-.()]/g;

/** A phone number: Israeli 05x / 07x (10 digits) or a landline 02 / 03 / 04 / 08 / 09 (9 digits), or `+` and 8 to 15 digits. */
export function isPhoneNumber(text: string): boolean {
  const t = text.trim();
  if (!/^\+?[\d\s\-.()]+$/.test(t)) return false;
  const s = t.replace(SEPARATORS, '');
  if (s.startsWith('+')) return /^\+[1-9]\d{7,14}$/.test(s);
  return /^0[57]\d{8}$/.test(s) || /^0[2-489]\d{7}$/.test(s);
}

/** An email address (an ASCII local part, a domain with at least one dot, a top-level domain of letters). */
export function isEmailAddress(text: string): boolean {
  return /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/.test(text.trim());
}

/** The Luhn check of a digit string. */
export function luhnValid(digits: string): boolean {
  if (!/^\d+$/.test(digits)) return false;
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

/** A card number: 13 to 19 digits (single spaces or dashes between them allowed), starting with 2-6, Luhn-valid, not all zeros. */
export function isCardNumber(text: string): boolean {
  const t = text.trim();
  if (!/^\d(?:[ -]?\d){12,18}$/.test(t)) return false;
  const s = t.replace(/[ -]/g, '');
  return /^[2-6]/.test(s) && !/^0+$/.test(s) && luhnValid(s);
}

/** The mod-97 of a long number written as text (IBAN check, ISO 13616), digit by digit. */
function mod97(digits: string): number {
  let r = 0;
  for (const ch of digits) r = (r * 10 + Number(ch)) % 97;
  return r;
}

/** An IBAN: a country code, check digits 02-98 and 11 to 30 letters or digits (spaces allowed), whose mod-97 is 1. */
export function isIban(text: string): boolean {
  const s = text.trim().replace(/\s+/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(s)) return false;
  const check = Number(s.slice(2, 4));
  if (check < 2 || check > 98) return false;
  const moved = s.slice(4) + s.slice(0, 4);
  const digits = moved.replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));
  return mod97(digits) === 1;
}

/** The kind of a whole value (text), or null. An ID before a phone: a 9-digit landline shape that passes the check digit is an ID. */
function kindOfText(t: string): IdentifierKind | null {
  if (t.includes('@')) return isEmailAddress(t) ? 'email' : null;
  if (/^[A-Za-z]{2}\d/.test(t)) return isIban(t) ? 'iban' : null;
  if (isCardNumber(t)) return 'card';
  if (isIsraeliIdNumber(t)) return 'israeliId';
  if (isPhoneNumber(t)) return 'phone';
  return null;
}

/** Where a longer text is split into words: spaces and the punctuation a label puts around a value. */
const WORD_BREAKS = /[\s,;:()[\]{}<>"'|/\\]+/;

/**
 * The identifier kind of a value a format would save, or null (see the file header): a number as an ID or a card; a text as a whole, then
 * word by word.
 */
export function identifierKindOf(value: unknown): IdentifierKind | null {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value <= 0) return null;
    const s = String(value);
    if (isIsraeliIdNumber(s)) return 'israeliId';
    return s.length >= 13 && isCardNumber(s) ? 'card' : null;
  }
  if (typeof value !== 'string') return null;
  const t = value.trim();
  if (t.length < 6) return null;
  const whole = kindOfText(t);
  if (whole) return whole;
  for (const word of t.split(WORD_BREAKS)) {
    // (A word is checked on its own shape; one that is the whole text was checked above.)
    if (word.length < 6 || word === t) continue;
    const k = kindOfText(word.replace(/^[.\-]+|[.\-]+$/g, ''));
    if (k) return k;
  }
  return null;
}
