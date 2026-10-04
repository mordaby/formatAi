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
