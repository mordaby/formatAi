// The masking switch (SPEC 7.2): turns real text/ID values into consistent,
// same-shape fake values using a keyed HMAC, entirely locally. The key is
// supplied by the caller (the web app creates it with crypto.getRandomValues
// per session) and never leaves this object; the fake<->real map
// (`fakeToReal`) is exposed only so the caller can unmask constants that come
// back from the LLM (unmaskRules.ts) — it is never serialized into a payload.

import type { PayloadCell, ProfileType } from '@formatai/shared';
import { isValidIsraeliId, makeValidIsraeliId } from '../../values/israeliId';
import { normalizeText } from '../../values/text';
import { buildWordFromBytes, deriveBytes, splitWords } from './words';

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
  /** Masks a cell per SPEC 7.2: only `text` and `idLike` columns are masked. */
  maskCell(value: PayloadCell, columnType: ProfileType): PayloadCell;
  /** Registers more words (e.g. discovered later) that should pass through unmasked. */
  addLabelWords(words: Iterable<string>): void;
  /**
   * The local fake -> real map. Used by `unmaskRules` to restore constants;
   * never put into a payload (SPEC 15: "the masking map stays local").
   */
  readonly fakeToReal: ReadonlyMap<string, string>;
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

  if (opts?.labelWords) {
    for (const w of opts.labelWords) labelWords.add(normalizeText(w));
  }

  /**
   * Returns the first candidate from `makeCandidate` that (a) isn't already
   * the fake for a *different* real value, and (b) — best effort — doesn't
   * equal a real word/id already seen in the data.
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
      return candidate;
    }
    return last;
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
    return splitWords(s)
      .map((t) => (t.isWord ? maskWord(t.text) : t.text))
      .join('');
  }

  function maskIdLike(s: string): string {
    if (s === '') return s;
    // DECISION: only a pure digit string of plausible ID length is checked
    // for Israeli-ID validity; anything else (letters mixed in, separators,
    // too long) falls back to generic word masking, which already satisfies
    // "digits -> digits" character-by-character for any digit runs it contains.
    if (/^\d{1,9}$/.test(s) && isValidIsraeliId(s)) {
      return maskValidIsraeliId(s);
    }
    return maskText(s);
  }

  function maskCell(value: PayloadCell, columnType: ProfileType): PayloadCell {
    if (typeof value !== 'string') return value; // numbers, booleans, null: sent real regardless of type
    if (columnType === 'text') return maskText(value);
    if (columnType === 'idLike') return maskIdLike(value);
    return value; // integer/decimal/currency/percent/date/boolean/empty: sent real (SPEC 7.2)
  }

  function addLabelWords(words: Iterable<string>): void {
    for (const w of words) labelWords.add(normalizeText(w));
  }

  return {
    maskText,
    maskIdLike,
    maskCell,
    addLabelWords,
    fakeToReal,
  };
}
