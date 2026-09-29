// Internal text-normalization helpers used by detectTable and extractTable.
// Not re-exported from io/index.ts: this is plumbing, not part of the public contract.

import { detection } from '@formatai/shared';

/**
 * Unify the various quote-mark and geresh characters that show up in Hebrew
 * spreadsheets into plain ASCII `"` and `'` (SPEC 17: "different quote characters
 * (״ vs " vs '') and geresh (׳ vs ')").
 */
export function normalizeQuotes(input: string): string {
  return (
    input
      // two adjacent apostrophes used as a poor-man's double quote
      .replace(/''/g, '"')
      // Hebrew gershayim (U+05F4), right/left double quotation marks
      .replace(/[״”“]/g, '"')
      // Hebrew geresh (U+05F3), right/left single quotation marks
      .replace(/[׳’‘]/g, "'")
  );
}

/** Trim, collapse internal whitespace runs, and unify quote/geresh characters. */
export function normalizeCellText(input: string): string {
  const collapsed = input.replace(/\s+/g, ' ').trim();
  return normalizeQuotes(collapsed);
}

/** True when `text` (after normalization) starts with a known footer/total label
 * (SPEC non-negotiable 8: the label words live in shared config, not here). */
export function isFooterLabel(text: string): boolean {
  const norm = normalizeCellText(text).toLowerCase();
  return detection.footerLabelPrefixes.some((p) => norm.startsWith(p.toLowerCase()));
}

const HEBREW_RE = /[֐-׿]/;

export function hasHebrew(text: string): boolean {
  return HEBREW_RE.test(text);
}

/** 0-based column index -> Excel column letters ("A", "B", ..., "AA", ...). */
export function colLetter(index: number): string {
  let n = index + 1;
  let s = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}
