// SPEC non-negotiable #8: "All limits, prices, model choices and prompt versions live
// in config, never in code." The footer/total label words that pre-flight detection
// (SPEC 6.1) and `input.stopAt` (SPEC 8.1) look for to find a totals row are config
// too, not a code constant - so a new language/label can be added without touching
// the engine.

export const detection = {
  /**
   * Prefixes (after `normalizeCellText`: trimmed, collapsed whitespace, quote marks
   * unified) that mark a row as a footer/total row to stop reading at, compared
   * case-insensitively (SPEC 17: Hebrew "סה\"כ" and English "Total").
   */
  footerLabelPrefixes: ['סה"כ', 'total'],
} as const;
