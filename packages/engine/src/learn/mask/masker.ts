// The masking switch (SPEC 7.2): turns real text/ID values into consistent,
// same-shape fake values using a keyed HMAC, entirely locally. The key is
// supplied by the caller (the web app creates it with crypto.getRandomValues
// per session) and never leaves this object; the fake<->real map
// (`fakeToReal`) is exposed only so the caller can unmask constants that come
// back from the LLM (unmaskRules.ts) — it is never serialized into a payload.
//
// Amendment 2026-10-06 (SPEC 7.2): an ID stored as a NUMBER is masked too. A number in an ID column is masked as its digits, exactly
// like the same digits as text (a valid Israeli ID stays a valid one, the length is kept), and is sent as a number again: the example's
// cell is a number, and the server's sample run and the browser's verification compare typed, so a fake written as text would ask the
// rules for text where the real file wants a number (and a repair diff of the two would look the same once masked). Which columns
// are ID columns - `idLike` ones, and integer columns the pair analysis shows to be identifiers - is the caller's (`learn/maskTypes.ts`).

import { maskingIdentifiers, maskingVocabulary, type PayloadCell, type ProfileType } from '@formatai/shared';
import { MONTH_NAMES, WEEKDAY_NAMES, monthOfName } from '../../values/dates';
import { isValidIsraeliId, makeValidIsraeliId } from '../../values/israeliId';
import { normalizeText } from '../../values/text';
import { readsAsDate } from '../analyze/dateReadings';
import { buildWordFromBytes, deriveBytes, splitWords } from './words';

// ---------- Vocabulary that is never masked (SPEC 7.2: dates are sent real; learning-loop proposal 7.5) ----------

/** A placeholder cell compared without case and without any space (see `maskingVocabulary.noValueTokens`). */
function placeholderKey(s: string): string {
  return normalizeText(s).replace(/\s+/g, '').toLowerCase();
}
const NO_VALUE = new Set(maskingVocabulary.noValueTokens.map(placeholderKey));

/**
 * A month name in every form the date reader accepts (`toDate`'s `MMMM` / `MMM`: Hebrew or English, full or short, English in any
 * case, "מרס", "Sept"), and the Hebrew "ב" + a month name ("במרץ", the `D בMMMM YYYY` reading).
 */
function isMonthWord(word: string): boolean {
  if (monthOfName(word) !== undefined) return true;
  return word === 'במרס' || (word.startsWith('ב') && MONTH_NAMES.he.some((m) => word === `ב${m}` || word === `ב${m.slice(0, 3)}`));
}

/** English weekday names, full and short, in any case ("Monday", "thu"). */
const WEEKDAY_EN = new Set([...WEEKDAY_NAMES.en.full, ...WEEKDAY_NAMES.en.short].map((w) => w.toLowerCase()));
/** The Hebrew word after "יום" in a weekday name: "ראשון" ... "שישי" (full) and "א" ... "ו" (short, "יום א'"). */
const WEEKDAY_HE_AFTER_YOM = new Set(
  [...WEEKDAY_NAMES.he.full, ...WEEKDAY_NAMES.he.short].filter((w) => w.startsWith('יום ')).map((w) => w.slice('יום '.length).replace(/['׳]/g, '')),
);

/**
 * DECISION (owner, 2026-10-04): month and weekday names are vocabulary, not personal data, and are never masked. Hebrew weekdays
 * are kept only as a weekday NAME - "יום" followed by its day word ("יום שני", "יום ה'") - and "שבת"; on its own "שני" is also a
 * first name, so it is masked like any word. English month names that are also first names ("May", "June") are kept, as decided.
 */
function vocabularyWords(tokens: readonly { isWord: boolean; text: string }[]): Set<number> {
  const keep = new Set<number>();
  tokens.forEach((t, i) => {
    if (!t.isWord) return;
    if (isMonthWord(t.text) || WEEKDAY_EN.has(t.text.toLowerCase()) || t.text === 'שבת') keep.add(i);
    else if (t.text === 'יום') {
      const sep = tokens[i + 1];
      const day = tokens[i + 2];
      if (sep && !sep.isWord && sep.text.trim() === '' && day?.isWord && WEEKDAY_HE_AFTER_YOM.has(day.text)) {
        keep.add(i);
        keep.add(i + 2);
      }
    }
  });
  return keep;
}

// DECISION: a small, bounded number of retries when a freshly derived fake
// word collides with something it shouldn't (see pickCandidate below). This
// keeps generation synchronous and deterministic; if every attempt collides
// (astronomically unlikely for realistic word lengths) the last candidate is
// used as-is rather than looping forever.
const MAX_COLLISION_ATTEMPTS = 8;

export interface CreateMaskerOptions {
  /** Words from title/summary labels that don't appear in any data cell (SPEC 7.2)
   * and so are sent real. Can also be extended later with `addLabelWords`. */
  labelWords?: Iterable<string>;
}

export interface Masker {
  /**
   * Masks free text: splits `s` into words and separators (spaces and
   * punctuation are kept as-is), and replaces each word with a fake word of
   * the same script, same length and same per-character case, unless the
   * word is a registered label word (see `addLabelWords`).
   */
  maskText(s: string): string;
  /**
   * Masks an ID-like cell: digits stay digits. When the value is (after
   * left-padding) a valid Israeli ID, the fake is also a valid Israeli ID of
   * the same length (leading zeros, if the value had any, are preserved
   * because length is preserved exactly).
   */
  maskIdLike(s: string): string;
  /**
   * Masks a cell per SPEC 7.2: only `text` and `idLike` columns are masked. In an `idLike` column a NUMBER is masked too (amendment
   * 2026-10-06): as its digits, like `maskIdLike` of the same digits, and returned as a number of the same length (as text only in
   * the rare case its fake does not read back as the same digits: a fraction, a number too long to hold exactly).
   */
  maskCell(value: PayloadCell, columnType: ProfileType): PayloadCell;
  /** Registers more words (e.g. discovered later) that should pass through unmasked. */
  addLabelWords(words: Iterable<string>): void;
  /**
   * The local fake -> real map. Used by `unmaskRules` to restore constants;
   * never put into a payload (SPEC 15: "the masking map stays local").
   */
  readonly fakeToReal: ReadonlyMap<string, string>;
  /**
   * Amendment 2026-10-06: the real number behind a NUMBER constant the AI wrote, when `n` is the fake of a whole ID made of digits (a
   * number in an ID column, or digit text in one) of at least `maskingIdentifiers.minUnmaskDigits` digits; else undefined. Only those:
   * a short number in a rule (a rate, a threshold, `round`'s digits) is far more likely a real constant than a short fake ID.
   */
  realNumberOf(n: number): number | undefined;
  /** The inverse, for `maskRules` (the constants a completion call sends): the fake of a real ID number this masker has masked, else undefined. */
  fakeNumberOf(n: number): number | undefined;
}

/** The digits of a whole number (no sign, no exponent), or null: the only numbers `realNumberOf`/`fakeNumberOf` map. */
function digitsOf(n: number): string | null {
  return Number.isSafeInteger(n) && n >= 0 ? String(n) : null;
}

export function createMasker(hmacKey: Uint8Array, opts?: CreateMaskerOptions): Masker {
  // Namespaced so a word and an ID that happen to share the same digits never
  // share a cache slot (they can go through different fake-generation rules —
  // see maskIdLike). The public fakeToReal map below is not namespaced: it
  // only needs to map the fake text that could appear in an LLM response back
  // to the real text, regardless of which path produced it.
  const realToFake = new Map<string, string>();
  const fakeToReal = new Map<string, string>();
  // Every real word/id string this masker has produced a fake for, or passed
  // through as a label word — used for best-effort collision avoidance below.
  const seenReal = new Set<string>();
  const labelWords = new Set<string>();
  // Amendment 2026-10-06: the fakes of whole IDs made of digits (from `maskIdLike`, which every ID cell goes through, a number's digits
  // included), both ways - the only fakes a NUMBER constant is unmasked from (`realNumberOf`), and the reals `maskRules` masks.
  const idDigitsFakeToReal = new Map<string, string>();
  const idDigitsRealToFake = new Map<string, string>();

  if (opts?.labelWords) {
    for (const w of opts.labelWords) labelWords.add(normalizeText(w));
  }

  /**
   * Returns the first candidate from `makeCandidate` that (a) isn't already
   * the fake for a *different* real value, (b) — best effort — doesn't
   * equal a real word/id already seen in the data, and (c) keeps the real
   * value's leading digit non-zero when it is (see `keepsLeadingDigit`).
   *
   * DECISION: (b) can only be checked against words seen so far, not ones the
   * masker will encounter later; SPEC 7.2 asks to avoid this "when feasible",
   * not to guarantee it. (a) is a hard guarantee within one masker instance.
   */
  function pickCandidate(realKey: string, makeCandidate: (attempt: number) => string): string {
    let last = '';
    for (let attempt = 0; attempt < MAX_COLLISION_ATTEMPTS; attempt++) {
      const candidate = makeCandidate(attempt);
      last = candidate;
      const existingReal = fakeToReal.get(candidate);
      if (existingReal !== undefined && existingReal !== realKey) continue;
      if (seenReal.has(candidate) && candidate !== realKey) continue;
      if (!keepsLeadingDigit(realKey, candidate)) continue;
      return candidate;
    }
    return last;
  }

  /**
   * Amendment 2026-10-06: a run of digits that does not start with 0 gets a fake that does not either - the same shape (a "0" in front
   * is a different shape: a code whose leading zeros matter), and the condition for a number to stay a number of the same length once
   * masked. A candidate that breaks it is skipped like a collision; the first candidate is kept whenever it already holds, so most fakes
   * are what they were. (8 tries that each fail 1 time in 10: the last candidate is used as-is about once in 10^8.)
   */
  function keepsLeadingDigit(real: string, candidate: string): boolean {
    return !/^[1-9][0-9]*$/.test(real) || !candidate.startsWith('0');
  }

  function maskWord(word: string): string {
    // Same real ID -> same fake everywhere: a digit word inside a text cell that is a valid Israeli
    // ID goes through the ID generator, exactly like that ID in an idLike column. Otherwise
    // "312345002 - Cohen" and the ID column would carry different fakes and the AI could not see
    // that one is built from the other. DECISION: 5+ digits, so short numbers in text (quantities,
    // codes) keep plain word masking.
    if (/^\d{5,9}$/.test(word) && isValidIsraeliId(word)) return maskValidIsraeliId(word);
    const key = normalizeText(word);
    seenReal.add(key);

    const cachedNamespacedKey = `word:${key}`;
    const cached = realToFake.get(cachedNamespacedKey);
    if (cached !== undefined) return cached;

    // Label words are only ever registered up front (or via addLabelWords
    // before this word is first seen); once a word has been masked (above),
    // it stays masked for consistency even if later registered as a label.
    if (labelWords.has(key)) return word;

    const chars = Array.from(word);
    const fake = pickCandidate(key, (attempt) => {
      const label = `word:${key}${attempt > 0 ? `:retry${attempt}` : ''}`;
      const bytes = deriveBytes(hmacKey, label, chars.length);
      return buildWordFromBytes(chars, bytes);
    });

    realToFake.set(cachedNamespacedKey, fake);
    fakeToReal.set(fake, key);
    return fake;
  }

  // DECISION: "keep length; leading zeros kept when present" (SPEC 7.2) is
  // satisfied here by always returning a string of the exact same length as
  // the input (see forcedZeros below, which forces only the *padding*
  // positions --- the ones a real 9-digit id would gain from padStart --- to
  // stay zero, since those are the positions "lost" by stats.leadingZerosLost
  // in the first place). A stored value that is itself a full 9-character
  // id and happens to start with a literal '0' isn't specially pinned to
  // still start with '0' after masking: a single leading zero digit in an
  // otherwise free 9-digit id is not reliably distinguishable from a random
  // digit, and forcing it would leak one digit of the real id's shape.
  function maskValidIsraeliId(s: string): string {
    const real = normalizeText(s);
    const cachedNamespacedKey = `id:${real}`;
    const cached = realToFake.get(cachedNamespacedKey);
    if (cached !== undefined) return cached;
    seenReal.add(real);

    const length = real.length;
    const forcedZeros = 9 - length; // "keep length; leading zeros kept when present"
    const randomDigitCount = 8 - forcedZeros; // = length - 1

    const fake = pickCandidate(real, (attempt) => {
      const label = `id:${real}${attempt > 0 ? `:retry${attempt}` : ''}`;
      const bytes = deriveBytes(hmacKey, label, randomDigitCount);
      let seed8 = '0'.repeat(forcedZeros);
      for (let i = 0; i < randomDigitCount; i++) seed8 += String(bytes[i]! % 10);
      // seed8 is always exactly 8 digits: forcedZeros + randomDigitCount = 9 - length + length - 1 = 8.
      const fullId = makeValidIsraeliId(seed8);
      // Slicing off the forced leading zeros recovers exactly `length`
      // characters, and padStart(9, '0') on that result reconstructs fullId
      // (which is valid by construction) — so the shorter form is itself
      // "another valid Israeli ID after padding", per SPEC 7.2.
      return fullId.slice(forcedZeros);
    });

    realToFake.set(cachedNamespacedKey, fake);
    fakeToReal.set(fake, real);
    return fake;
  }

  function maskText(s: string): string {
    if (s === '') return s;
    // Sent as it is (SPEC 7.2, proposal 7.5): a placeholder for "no value", and a text that reads as a date (dates are sent real,
    // whatever the cell type). Everything else is masked word by word, month and weekday names kept.
    if (NO_VALUE.has(placeholderKey(s)) || readsAsDate(s)) return s;
    const tokens = splitWords(s);
    const keep = vocabularyWords(tokens);
    return tokens.map((t, i) => (t.isWord && !keep.has(i) ? maskWord(t.text) : t.text)).join('');
  }

  function maskIdLike(s: string): string {
    if (s === '') return s;
    // DECISION: only a pure digit string of plausible ID length is checked
    // for Israeli-ID validity; anything else (letters mixed in, separators,
    // too long) falls back to generic word masking, which already satisfies
    // "digits -> digits" character-by-character for any digit runs it contains.
    const fake = /^\d{1,9}$/.test(s) && isValidIsraeliId(s) ? maskValidIsraeliId(s) : maskText(s);
    if (/^\d+$/.test(s) && /^\d+$/.test(fake) && fake !== s) {
      idDigitsFakeToReal.set(fake, s);
      idDigitsRealToFake.set(s, fake);
    }
    return fake;
  }

  /** Amendment 2026-10-06: a number in an ID column, masked as its digits and sent as a number again (see `Masker.maskCell`). */
  function maskIdNumber(n: number): PayloadCell {
    if (!Number.isFinite(n)) return n;
    const fake = maskIdLike(String(n));
    const back = Number(fake);
    return String(back) === fake ? back : fake;
  }

  function maskCell(value: PayloadCell, columnType: ProfileType): PayloadCell {
    if (typeof value === 'number') return columnType === 'idLike' ? maskIdNumber(value) : value; // a number in any other column: sent real (SPEC 7.2)
    if (typeof value !== 'string') return value; // booleans, null: sent real regardless of type
    if (columnType === 'text') return maskText(value);
    if (columnType === 'idLike') return maskIdLike(value);
    return value; // integer/decimal/currency/percent/date/boolean/empty: sent real (SPEC 7.2)
  }

  function addLabelWords(words: Iterable<string>): void {
    for (const w of words) labelWords.add(normalizeText(w));
  }

  /** The digits of `n` when it is long enough to be mapped as an ID (see `realNumberOf`), else null. */
  function idDigits(n: number): string | null {
    const digits = digitsOf(n);
    return digits !== null && digits.length >= maskingIdentifiers.minUnmaskDigits ? digits : null;
  }

  function realNumberOf(n: number): number | undefined {
    const digits = idDigits(n);
    const real = digits === null ? undefined : idDigitsFakeToReal.get(digits);
    return real === undefined ? undefined : Number(real);
  }

  function fakeNumberOf(n: number): number | undefined {
    const digits = idDigits(n);
    const fake = digits === null ? undefined : idDigitsRealToFake.get(digits);
    // (a fake that starts with 0 has no number of the same length: left as it is)
    return fake === undefined || fake.startsWith('0') ? undefined : Number(fake);
  }

  return {
    maskText,
    maskIdLike,
    maskCell,
    addLabelWords,
    fakeToReal,
    realNumberOf,
    fakeNumberOf,
  };
}
