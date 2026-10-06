// The masking switch (SPEC 7.2): what is vocabulary rather than personal data, and so is sent as it is with masking on.
// A list in config, like the footer labels (`detection.ts`), so a new spelling can be added without touching the engine.

export const maskingVocabulary = {
  /**
   * Placeholders that mean "no value" (SPEC 7.2, learning-loop proposal 7.5): a cell that is EXACTLY one of these is sent as
   * it is, never masked - a cleanup rule ("N/A" -> empty) cannot be learned from a masked "O/F". Compared case-insensitively
   * and with every space removed ("n / a" is "N/A", "לא  ידוע" is "לא ידוע"); only the whole cell counts, so a name next to
   * one is masked as before. Punctuation-only tokens ("-", "?") are never masked anyway (only words are), and are listed
   * here so the list says everything in one place.
   */
  noValueTokens: ['N/A', 'NA', 'n.a.', '#N/A', '-', '--', '—', '–', 'null', 'none', 'nil', '?', 'אין', 'לא ידוע', 'ריק', 'ללא'],
} as const;

/**
 * Amendment 2026-10-06 (SPEC 7.2): identifiers stored as numbers are masked. An `idLike` column is masked whatever its cells hold; an
 * INTEGER column is masked like one when the pair analysis shows it is an identifier, not a measure (`learn/maskTypes.ts` in the engine):
 * (almost) every row holds its own value, and no output column computes anything from it.
 */
export const maskingIdentifiers = {
  /** Unique per row: the profile's `key` (every row, all different), or at least this share of distinct values ... */
  minDistinctRatio: 0.9,
  /** ... over at least this many non-empty rows. */
  minRows: 6,
  /**
   * A NUMBER constant in the rules the AI returns is unmasked only when it is the fake of an ID of at least this many digits (a fake
   * written as text is unmasked whatever its length, as before). DECISION: a short number in a rule (a rate, a threshold, 100, 1000) is
   * far more likely a real constant than the fake of a short code, and with 1-3 digits a fake collides with one often (a code of 1..9
   * takes nearly every one-digit number); from 4 digits on a collision is rare (50 codes cover under 1% of the 4-digit numbers).
   */
  minUnmaskDigits: 4,
} as const;
