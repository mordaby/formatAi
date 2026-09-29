// Pure number primitives: exact decimal arithmetic on amounts (no floating point),
// text parsing of Excel-flavored number notations, and Excel-style rounding.
// No DOM, no Node-only APIs, no clock/locale dependence.

import Decimal from 'decimal.js';
import { normalizeText } from './text';

/**
 * Converts a raw JS number (as read from an Excel cell, a double) into the
 * Decimal a user would actually see: Excel displays at most 15 significant
 * digits, so we build the Decimal from that rounded representation instead of
 * the exact binary double. E.g. 0.30000000000000004 -> 0.3.
 */
export function fromExcelNumber(n: number): Decimal {
  if (!Number.isFinite(n)) return new Decimal(n);
  if (n === 0) return new Decimal(0);
  // toPrecision(15) may produce exponential notation for very large/small
  // magnitudes; Decimal parses that natively. decimal.js also drops
  // insignificant trailing zeros on construction, so no manual stripping is needed.
  return new Decimal(n.toPrecision(15));
}

const CURRENCY_RE = /^(₪|\$|€|NIS|ש"ח)\s*|\s*(₪|\$|€|NIS|ש"ח)$/gi;

function stripCurrency(s: string): string {
  return normalizeText(s).replace(CURRENCY_RE, '').trim();
}

// After commas are removed, the remainder must be a plain non-negative decimal.
const PLAIN_DECIMAL_RE = /^\d+(\.\d+)?$/;
// Before commas are removed: digits/commas with at most one decimal point
// (grouping is not strictly validated, only overall shape).
const GROUPED_DECIMAL_RE = /^\d[\d,]*(\.\d+)?$|^\.\d+$/;

/**
 * Parses a number that may be stored as text: trims; strips thousand
 * separators; strips an optional currency prefix/suffix (₪, $, €, NIS, ש"ח);
 * strips a trailing "%" (dividing by 100); and reads a negative sign as a
 * leading "-", a unicode minus "−", surrounding parentheses, or a trailing "-".
 * Returns null when the input isn't a number (including an empty string).
 */
export function parseNumber(input: string | number): Decimal | null {
  if (typeof input === 'number') {
    return Number.isFinite(input) ? fromExcelNumber(input) : null;
  }

  let s = input.trim();
  if (s === '') return null;

  s = s.replace(/−/g, '-'); // unicode minus -> ascii hyphen

  let negative = false;

  if (s.length >= 2 && s.startsWith('(') && s.endsWith(')')) {
    negative = true;
    s = s.slice(1, -1).trim();
  }

  s = stripCurrency(s);

  let percent = false;
  if (s.endsWith('%')) {
    percent = true;
    s = s.slice(0, -1).trim();
  }

  s = stripCurrency(s); // currency can also sit inside the parens/percent, e.g. "(₪150)" or "150%-"

  if (s.endsWith('-')) {
    negative = true;
    s = s.slice(0, -1).trim();
  }
  if (s.startsWith('-')) {
    negative = true;
    s = s.slice(1).trim();
  }

  if (s === '' || !GROUPED_DECIMAL_RE.test(s)) return null;
  const cleaned = s.replace(/,/g, '');
  if (!PLAIN_DECIMAL_RE.test(cleaned)) return null;

  let dec: Decimal;
  try {
    dec = new Decimal(cleaned);
  } catch {
    return null;
  }
  if (percent) dec = dec.div(100);
  if (negative) dec = dec.neg();
  return dec;
}

/**
 * Rounds `d` to `digits` decimal places, half away from zero (like Excel's
 * ROUND). `digits` may be negative to round to tens, hundreds, etc.
 */
export function excelRound(d: Decimal, digits: number): Decimal {
  const factor = new Decimal(10).pow(digits);
  return d.times(factor).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).div(factor);
}

/** Renders `d` in plain decimal notation, never exponential. */
export function decimalToPlain(d: Decimal): string {
  return d.toFixed();
}
