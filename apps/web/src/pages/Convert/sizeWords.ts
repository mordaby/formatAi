// A size in words (SPEC 5 C, 8.15, 2026-10-08): "Total" in this file is mostly in the tens; this format was learned on thousands to tens of thousands.
// A size is a decade exponent (floor(log10 |v|)): 0 is the single digits, 1 the tens, 3 the thousands, 4 the tens of thousands. The decades people
// name have a word in the dictionaries (`conv.size.d0` .. `d9`, en and he); any other is said as the plain numbers it spans ("0.01 to 0.1").
// Pure: only the dictionary and a number formatter. It says what the numbers LOOK like - never which size is right.
import type { SizeRange } from '@formatai/shared';
import type { I18n, MessageKey } from '../../i18n';

/** The decades that have a word, 10^0 .. 10^9, by exponent. */
const WORDS: readonly MessageKey[] = [
  'conv.size.d0',
  'conv.size.d1',
  'conv.size.d2',
  'conv.size.d3',
  'conv.size.d4',
  'conv.size.d5',
  'conv.size.d6',
  'conv.size.d7',
  'conv.size.d8',
  'conv.size.d9',
];

const wordOf = (i18n: I18n, decade: number): string | null => {
  const key = Number.isInteger(decade) ? WORDS[decade] : undefined;
  return key ? i18n.t(key) : null;
};

/** The numbers a decade spans, as plain digits in the UI language: 10^e up to 10^(e+1) ("0.01", "100,000"). */
function digits(i18n: I18n, exponent: number): string {
  return new Intl.NumberFormat(i18n.lang, { maximumFractionDigits: 12 }).format(10 ** exponent);
}

/** Where the file's numbers mostly are, after "mostly": "in the tens", "in the thousands", or "between 0.01 and 0.1". */
export function fileSizePhrase(i18n: I18n, medianDecade: number): string {
  const word = wordOf(i18n, medianDecade);
  return word !== null ? i18n.t('conv.size.in', { size: word }) : i18n.t('conv.size.between', { from: digits(i18n, medianDecade), to: digits(i18n, medianDecade + 1) });
}

/**
 * What the format was learned on, after "learned on": "thousands", "thousands to tens of thousands", or - when an end of the range has no word -
 * the plain numbers it spans ("numbers from 0.01 to 1,000").
 */
export function savedSizePhrase(i18n: I18n, saved: SizeRange): string {
  const lo = wordOf(i18n, saved.lo);
  const hi = wordOf(i18n, saved.hi);
  if (lo !== null && hi !== null) return saved.lo === saved.hi ? lo : i18n.t('conv.size.span', { from: lo, to: hi });
  return i18n.t('conv.size.numbers', { from: digits(i18n, saved.lo), to: digits(i18n, saved.hi + 1) });
}
