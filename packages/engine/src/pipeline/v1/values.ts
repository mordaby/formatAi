// Internal cell values for the v1 pipeline, and the typed comparisons shared by
// filters, expressions, dedupe, sort, group and validations.
//
// A normalized cell is one of:
//   null     empty (null cell, or text that is only whitespace)
//   string   text / idLike, or a value kept as-is after it failed to parse
//   boolean
//   Decimal  every number (never a JS float inside the pipeline)
//   DateVal  a calendar date
// JS numbers only appear at the output boundary (OutCell.v) and in Flag values.

import Decimal from 'decimal.js';
import { formatYmd, isValidYmd, parseDate, serialToYmd, ymdToSerial, type Ymd } from '../../values/dates';
import { parseNumber } from '../../values/numbers';
import { normalizeText } from '../../values/text';

export class DateVal implements Ymd {
  readonly y: number;
  readonly m: number;
  readonly d: number;
  /** Excel serial in the 1900 date system (what the output writes). */
  readonly serial: number;
  constructor(ymd: Ymd) {
    this.y = ymd.y;
    this.m = ymd.m;
    this.d = ymd.d;
    this.serial = ymdToSerial(ymd);
  }
}

export type Val = null | string | boolean | Decimal | DateVal;

export const ZERO = new Decimal(0);
export const ONE = new Decimal(1);

// DECISION: dates shown as text (concat, flag values, text comparisons, and date
// cells whose output column has no date format) use DD/MM/YYYY, the Israeli
// default (SPEC 17), in both languages. `dateFormat` gives explicit control.
export const DISPLAY_DATE_FORMAT = 'DD/MM/YYYY';

// DECISION: date *constants* written in rules (filter values, expression
// constants compared with dates, text coerced to a date) are read as ISO
// YYYY-MM-DD first, then day-first D/M/YYYY or D.M.YYYY. Never month-first.
export const CONST_DATE_FORMATS = ['YYYY-MM-DD', 'D/M/YYYY', 'D.M.YYYY'];

const SMALL_INTS: Decimal[] = [];
/** Shared Decimal for a small non-negative integer (index/count columns). */
export function decInt(n: number): Decimal {
  if (n >= 0 && n < 256) {
    let d = SMALL_INTS[n];
    if (d === undefined) {
      d = new Decimal(n);
      SMALL_INTS[n] = d;
    }
    return d;
  }
  return new Decimal(n);
}

const MAX_EXCEL_SERIAL = 2958465; // 9999-12-31

/** Excel serial (as read from a cell) to a DateVal; null when out of Excel's date range. */
export function dateFromSerial(serial: number, date1904: boolean): DateVal | null {
  if (!Number.isFinite(serial)) return null;
  const s1900 = Math.trunc(serial) + (date1904 ? 1462 : 0);
  if (s1900 < 1 || s1900 > MAX_EXCEL_SERIAL) return null;
  const ymd = serialToYmd(serial, date1904);
  return isValidYmd(ymd) ? new DateVal(ymd) : null;
}

/** A calendar date as a DateVal; null when Excel can't hold it (before 1900-01-01 or after 9999-12-31). */
export function dateFromYmd(ymd: Ymd): DateVal | null {
  if (!isValidYmd(ymd)) return null;
  const d = new DateVal(ymd);
  return d.serial >= 1 && d.serial <= MAX_EXCEL_SERIAL ? d : null;
}

export function parseConstDate(s: string): DateVal | null {
  const ymd = parseDate(s.trim(), CONST_DATE_FORMATS);
  return ymd ? dateFromYmd(ymd) : null;
}

/** Plain-notation text of a Decimal (never exponential, never "-0"). */
export function decText(d: Decimal): string {
  return d.isZero() ? '0' : d.toFixed();
}

/** Text form of a value, as used by text operations. Empty -> ''. */
export function toText(v: Val): string {
  if (v === null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (v instanceof DateVal) return formatYmd(v, DISPLAY_DATE_FORMAT, 'en');
  return decText(v);
}

/**
 * Numeric form of a value for arithmetic: Decimal, `null` for empty, or
 * `undefined` when the value is not a number (text that doesn't parse).
 * Dates are their Excel serial (as in Excel); booleans are 1/0 (as in Excel).
 */
export function toNum(v: Val): Decimal | null | undefined {
  if (v === null) return null;
  if (v instanceof Decimal) return v;
  if (v instanceof DateVal) return new Decimal(v.serial);
  if (typeof v === 'boolean') return v ? ONE : ZERO;
  const n = parseNumber(v);
  return n === null ? undefined : n;
}

/** Date form of a value: DateVal, `null` for empty, `undefined` when not a date. */
export function toDate(v: Val): DateVal | null | undefined {
  if (v === null) return null;
  if (v instanceof DateVal) return v;
  if (v instanceof Decimal) return dateFromSerial(v.toNumber(), false) ?? undefined;
  if (typeof v === 'string') return parseConstDate(v) ?? undefined;
  return undefined;
}

/**
 * Compares two strings by Unicode code point (not UTF-16 code unit, not locale).
 * Uses the standard fix-up so surrogate pairs sort above U+E000..U+FFFF.
 */
export function cmpCodePoints(a: string, b: string): number {
  if (a === b) return 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    let ca = a.charCodeAt(i);
    let cb = b.charCodeAt(i);
    if (ca !== cb) {
      if (ca >= 0xd800 && cb >= 0xd800) {
        ca = ca >= 0xe000 ? ca - 0x800 : ca + 0x2000;
        cb = cb >= 0xe000 ? cb - 0x800 : cb + 0x2000;
      }
      return ca < cb ? -1 : 1;
    }
  }
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
}

// normalizeText is the identity on printable ASCII without spaces or quote
// marks (' and `), which covers most ids and codes: skip it for those.
const ASCII_PLAIN_RE = /^[!-&(-_a-~]*$/;
// A bounded memo for the rest (Hebrew text repeats a lot: statuses, products,
// names). Pure function memo, so it can't affect results.
const NORM_MEMO = new Map<string, string>();
const NORM_MEMO_MAX = 20000;

/** normalizeText, fast for repeated and plain-ASCII strings. */
export function normText(s: string): string {
  if (ASCII_PLAIN_RE.test(s)) return s;
  let n = NORM_MEMO.get(s);
  if (n === undefined) {
    n = normalizeText(s);
    if (NORM_MEMO.size >= NORM_MEMO_MAX) NORM_MEMO.clear();
    NORM_MEMO.set(s, n);
  }
  return n;
}

/** normalizeText of the text form; used for every text equality/ordering. */
export function normKey(v: Val): string {
  return normText(toText(v));
}

/**
 * A comparison operand prepared once (e.g. a filter constant), so the per-row
 * comparison doesn't re-normalize it.
 */
export interface Prepared {
  v: Val;
  /** normalizeText(toText(v)) */
  text: string;
  /** Numeric form when the constant is a number or numeric text (else null). */
  num: Decimal | null;
  /** Date form when the constant is a date or date text (else null). */
  date: DateVal | null;
}

export function prepare(v: Val): Prepared {
  let num: Decimal | null = null;
  let date: DateVal | null = null;
  if (v instanceof Decimal) num = v;
  else if (v instanceof DateVal) date = v;
  else if (typeof v === 'string') {
    num = parseNumber(v);
    date = parseConstDate(v);
  }
  return { v, text: normKey(v), num, date };
}

/**
 * Typed three-way comparison of a (row) value with a prepared operand.
 * Returns null when either side is empty.
 *  - Decimal vs number-like  -> numeric
 *  - DateVal vs date-like    -> by date
 *  - boolean vs boolean      -> false < true
 *  - otherwise               -> text: normalizeText, then code point order
 * Text vs text never compares numerically, so "00123" and "123" differ.
 */
export function comparePrepared(a: Val, b: Prepared): number | null {
  if (a === null || b.v === null) return null;
  if (a instanceof Decimal) {
    if (b.num !== null) return a.cmp(b.num);
    if (b.v instanceof DateVal) return a.cmp(b.v.serial);
  } else if (a instanceof DateVal) {
    if (b.date !== null) return a.serial === b.date.serial ? 0 : a.serial < b.date.serial ? -1 : 1;
    if (b.v instanceof Decimal) return new Decimal(a.serial).cmp(b.v);
  } else if (typeof a === 'boolean') {
    if (typeof b.v === 'boolean') return a === b.v ? 0 : a ? 1 : -1;
  } else if (b.v instanceof Decimal) {
    // text row value vs numeric operand: numeric when the text is a number
    const n = parseNumber(a);
    if (n !== null) return n.cmp(b.v);
  } else if (b.v instanceof DateVal) {
    const d = parseConstDate(a);
    if (d !== null) return d.serial === b.v.serial ? 0 : d.serial < b.v.serial ? -1 : 1;
  }
  return cmpCodePoints(normKey(a), b.text);
}

/** Typed comparison of two values (see comparePrepared). */
export function compareVals(a: Val, b: Val): number | null {
  if (a === null || b === null) return null;
  return comparePrepared(a, prepare(b));
}

/**
 * Canonical identity string of a value, used for dedupe and group keys:
 * values compare after type normalization (trimmed, padded, quote marks and
 * geresh unified), with no fuzzy matching (SPEC 8.4).
 */
export function canonicalKey(v: Val): string {
  if (v === null) return '';
  if (typeof v === 'string') return 'T' + normText(v);
  if (typeof v === 'boolean') return v ? 'B1' : 'B0';
  if (v instanceof DateVal) return 'D' + v.serial;
  return 'N' + decText(v);
}

/** Truthiness for `if`/`and`/`or`/`not`: empty, false and 0 are false. */
export function truthy(v: Val): boolean {
  if (v === null) return false;
  if (typeof v === 'boolean') return v;
  if (v instanceof Decimal) return !v.isZero();
  return true;
}

/** A value as stored in a Flag (numbers become JS numbers at this boundary). */
export function flagValue(v: Val | number): string | number | boolean | null {
  if (v === null || typeof v === 'string' || typeof v === 'boolean' || typeof v === 'number') return v;
  if (v instanceof DateVal) return formatYmd(v, DISPLAY_DATE_FORMAT, 'en');
  return v.isZero() ? 0 : v.toNumber();
}

const BLANK_RE = /^\s*$/;
export function isBlankText(s: string): boolean {
  return BLANK_RE.test(s);
}
