// Pure date primitives: Excel serial <-> calendar date, text parsing, formatting.
// No DOM, no Node-only APIs, no clock/locale dependence. `Date.UTC`/`getUTC*` are
// used purely as deterministic calendar arithmetic (never local time, never "now").

import { padLeft } from './text';

export interface Ymd {
  y: number;
  m: number;
  d: number;
}

export const MONTH_NAMES: { he: string[]; en: string[] } = {
  he: [
    'ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני',
    'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר',
  ],
  en: [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ],
};

// DECISION: Hebrew has no standard 3-letter month abbreviation, so MMM in 'he'
// uses the first 3 characters of the full name. English uses conventional abbreviations.
const MONTH_SHORT_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function monthName(m: number, language: 'he' | 'en', style: 'full' | 'short'): string {
  const full = MONTH_NAMES[language][m - 1] ?? '';
  if (style === 'full') return full;
  if (language === 'en') return MONTH_SHORT_EN[m - 1] ?? full;
  return full.slice(0, 3);
}

function daysInMonth(y: number, m: number): number {
  const standard = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (m === 2) {
    // DECISION: 1900 is kept as a "leap" year here (29 days) so that the fake
    // Excel date 1900-02-29 (serial 60) round-trips as valid, matching Excel itself.
    if (y === 1900) return 29;
    const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
    return leap ? 29 : 28;
  }
  return standard[m - 1] ?? 31;
}

export function isValidYmd(ymd: Ymd): boolean {
  if (!Number.isInteger(ymd.y) || !Number.isInteger(ymd.m) || !Number.isInteger(ymd.d)) return false;
  if (ymd.m < 1 || ymd.m > 12) return false;
  if (ymd.d < 1) return false;
  return ymd.d <= daysInMonth(ymd.y, ymd.m);
}

// Day-number epoch: day N = this UTC instant + N days. Day 1 = 1900-01-01.
const EPOCH_UTC_MS = Date.UTC(1899, 11, 31);
const MS_PER_DAY = 86400000;

function dayNumberFromYmd(ymd: Ymd): number {
  const ms = Date.UTC(ymd.y, ymd.m - 1, ymd.d);
  return Math.round((ms - EPOCH_UTC_MS) / MS_PER_DAY);
}

function ymdFromDayNumber(n: number): Ymd {
  const ms = EPOCH_UTC_MS + n * MS_PER_DAY;
  const dt = new Date(ms);
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}

/**
 * Excel serial number to calendar date (1900 date system by default).
 * Ignores the time fraction. Reproduces Excel's 1900 leap-year bug: serial 60
 * is the fake 1900-02-29, and every serial above 60 is shifted back one day
 * relative to a naive day count. `date1904` shifts the serial by 1462 first.
 */
export function serialToYmd(serial: number, date1904 = false): Ymd {
  let s = Math.trunc(serial);
  if (date1904) s += 1462;
  if (s === 60) return { y: 1900, m: 2, d: 29 };
  const n = s > 60 ? s - 1 : s;
  return ymdFromDayNumber(n);
}

/** Calendar date to Excel serial number, 1900 date system (inverse of `serialToYmd`). */
export function ymdToSerial(ymd: Ymd): number {
  if (ymd.y === 1900 && ymd.m === 2 && ymd.d === 29) return 60;
  const n = dayNumberFromYmd(ymd);
  return n >= 60 ? n + 1 : n;
}

type FieldTok = 'D' | 'M' | 'Y';

/** Builds a regex + capture-group map for a D/DD/M/MM/YY/YYYY token format (parsing only). */
function tokenizeParseFormat(format: string): { regex: RegExp; groups: FieldTok[] } {
  const groups: FieldTok[] = [];
  let pattern = '^';
  let i = 0;
  while (i < format.length) {
    if (format.startsWith('YYYY', i)) { pattern += '(\\d{4})'; groups.push('Y'); i += 4; continue; }
    if (format.startsWith('DD', i)) { pattern += '(\\d{2})'; groups.push('D'); i += 2; continue; }
    if (format.startsWith('MM', i)) { pattern += '(\\d{2})'; groups.push('M'); i += 2; continue; }
    if (format.startsWith('YY', i)) { pattern += '(\\d{2})'; groups.push('Y'); i += 2; continue; }
    if (format[i] === 'D') { pattern += '(\\d{1,2})'; groups.push('D'); i += 1; continue; }
    if (format[i] === 'M') { pattern += '(\\d{1,2})'; groups.push('M'); i += 1; continue; }
    pattern += (format[i] as string).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    i += 1;
  }
  pattern += '$';
  return { regex: new RegExp(pattern), groups };
}

function extractFields(value: string, format: string): { day: number; month: number; year: number } | null {
  const { regex, groups } = tokenizeParseFormat(format);
  const m = regex.exec(value);
  if (!m) return null;
  let day = NaN;
  let month = NaN;
  let year = NaN;
  groups.forEach((g, idx) => {
    const raw = m[idx + 1] as string;
    const num = parseInt(raw, 10);
    if (g === 'D') day = num;
    else if (g === 'M') month = num;
    else if (g === 'Y') {
      // DECISION: two-digit years pivot at 50: 00-49 -> 2000s, 50-99 -> 1900s.
      year = raw.length <= 2 ? (num < 50 ? 2000 + num : 1900 + num) : num;
    }
  });
  if (Number.isNaN(day) || Number.isNaN(month) || Number.isNaN(year)) return null;
  return { day, month, year };
}

const PLAIN_NUMBER_RE = /^-?\d+(\.\d+)?$/;

/**
 * Parses `value` against `formats` in order, returning the first valid date.
 * The special format "excelSerial" matches a number, or a string that is a
 * plain integer/decimal, and is interpreted as an Excel serial date.
 * Token formats (D/DD/M/MM/YY/YYYY with literal separators) only match strings.
 */
export function parseDate(value: string | number, formats: string[], date1904 = false): Ymd | null {
  for (const format of formats) {
    if (format === 'excelSerial') {
      let num: number | null = null;
      if (typeof value === 'number') {
        num = value;
      } else if (PLAIN_NUMBER_RE.test(value.trim())) {
        num = Number(value.trim());
      }
      if (num !== null && Number.isFinite(num)) {
        const ymd = serialToYmd(num, date1904);
        if (isValidYmd(ymd)) return ymd;
      }
      continue;
    }

    // DECISION: token formats (D/DD/M/MM/YY/YYYY) only apply to string values;
    // a raw number can only match via the "excelSerial" format.
    if (typeof value !== 'string') continue;
    const fields = extractFields(value.trim(), format);
    if (!fields) continue;
    const ymd: Ymd = { y: fields.year, m: fields.month, d: fields.day };
    if (isValidYmd(ymd)) return ymd;
  }
  return null;
}

/**
 * When `text` fails to parse against `format` because the day/month are
 * impossible, but swapping day and month gives a valid date, returns that
 * swapped date. Used for flag suggestions (SPEC 8.9). Returns null when the
 * text doesn't fit the format's shape at all, or when neither reading is valid,
 * or when the original reading was already valid (nothing to suggest).
 */
export function suggestDaySwap(text: string, format: string): Ymd | null {
  const fields = extractFields(text.trim(), format);
  if (!fields) return null;
  const original: Ymd = { y: fields.year, m: fields.month, d: fields.day };
  if (isValidYmd(original)) return null;
  const swapped: Ymd = { y: fields.year, m: fields.day, d: fields.month };
  return isValidYmd(swapped) ? swapped : null;
}

/** Strips `[...]` bracket sections (locale prefixes, colors, elapsed-time markers). */
function stripBrackets(format: string): string {
  return format.replace(/\[[^\]]*\]/g, '');
}

/**
 * Formats `ymd` using `format`, which may be token style ("DD/MM/YYYY",
 * "MMMM YYYY") or Excel style ("dd/mm/yyyy", "mmmm yyyy", with optional
 * `[$-40D]`-style locale prefixes, quoted "..." literals and backslash escapes).
 * Matching is case-insensitive: d/D and y/Y are the same, m/M always means month.
 */
export function formatYmd(ymd: Ymd, format: string, language: 'he' | 'en'): string {
  const stripped = stripBrackets(format);
  let out = '';
  let i = 0;
  const n = stripped.length;
  while (i < n) {
    const ch = stripped[i] as string;
    if (ch === '"') {
      const end = stripped.indexOf('"', i + 1);
      if (end === -1) { out += stripped.slice(i + 1); break; }
      out += stripped.slice(i + 1, end);
      i = end + 1;
      continue;
    }
    if (ch === '\\') {
      if (i + 1 < n) { out += stripped[i + 1]; i += 2; continue; }
      i += 1;
      continue;
    }
    const four = stripped.slice(i, i + 4).toLowerCase();
    if (four === 'yyyy') { out += String(ymd.y); i += 4; continue; }
    if (four === 'mmmm') { out += monthName(ymd.m, language, 'full'); i += 4; continue; }
    const three = stripped.slice(i, i + 3).toLowerCase();
    if (three === 'mmm') { out += monthName(ymd.m, language, 'short'); i += 3; continue; }
    const two = stripped.slice(i, i + 2).toLowerCase();
    if (two === 'yy') { out += padLeft(String(((ymd.y % 100) + 100) % 100), 2, '0'); i += 2; continue; }
    if (two === 'dd') { out += padLeft(String(ymd.d), 2, '0'); i += 2; continue; }
    if (two === 'mm') { out += padLeft(String(ymd.m), 2, '0'); i += 2; continue; }
    const one = ch.toLowerCase();
    if (one === 'd') { out += String(ymd.d); i += 1; continue; }
    if (one === 'm') { out += String(ymd.m); i += 1; continue; }
    out += ch;
    i += 1;
  }
  return out;
}

/**
 * Converts a token-style date format ("DD/MM/YYYY", "MMMM YYYY") to an Excel
 * numFmt code ("dd/mm/yyyy", "mmmm yyyy"). Prefixes `[$-40D]` when the format
 * contains a month name and `language` is 'he', so Excel shows Hebrew month
 * names. Excel-style input is returned normalized (idempotent).
 */
export function toExcelDateFormat(format: string, language: 'he' | 'en'): string {
  const existingBrackets = format.match(/\[[^\]]*\]/g) ?? [];
  const core = stripBrackets(format);
  let out = '';
  let i = 0;
  const n = core.length;
  let hasMonthName = false;
  while (i < n) {
    const ch = core[i] as string;
    if (ch === '"') {
      const end = core.indexOf('"', i + 1);
      if (end === -1) { out += core.slice(i); break; }
      out += core.slice(i, end + 1);
      i = end + 1;
      continue;
    }
    if (ch === '\\') { out += core.slice(i, i + 2); i += 2; continue; }
    const four = core.slice(i, i + 4).toLowerCase();
    if (four === 'yyyy') { out += 'yyyy'; i += 4; continue; }
    if (four === 'mmmm') { out += 'mmmm'; hasMonthName = true; i += 4; continue; }
    const three = core.slice(i, i + 3).toLowerCase();
    if (three === 'mmm') { out += 'mmm'; hasMonthName = true; i += 3; continue; }
    const two = core.slice(i, i + 2).toLowerCase();
    if (two === 'yy') { out += 'yy'; i += 2; continue; }
    if (two === 'dd') { out += 'dd'; i += 2; continue; }
    if (two === 'mm') { out += 'mm'; i += 2; continue; }
    const oneLower = ch.toLowerCase();
    if (oneLower === 'd') { out += 'd'; i += 1; continue; }
    if (oneLower === 'm') { out += 'm'; i += 1; continue; }
    out += ch;
    i += 1;
  }
  if (existingBrackets.length > 0) {
    return existingBrackets.join('') + out;
  }
  if (language === 'he' && hasMonthName) {
    return '[$-40D]' + out;
  }
  return out;
}

/**
 * True when `numFmt` is a date format: it has day/year letters (or a month
 * token not paired with a time indicator) outside quotes/brackets. False for
 * "General", plain number/percent/text formats, and elapsed-time formats like
 * "[h]:mm:ss" (brackets are stripped, but the leftover time letters block it).
 */
export function isExcelDateFormat(numFmt: string): boolean {
  let s = stripBrackets(numFmt);
  s = s.replace(/"[^"]*"/g, '');
  const trimmed = s.trim();
  if (trimmed === '' || /^general$/i.test(trimmed)) return false;
  const hasTimeIndicator = /[hs]/i.test(trimmed) || /am\/pm/i.test(trimmed);
  const hasDateLetters = /[dy]/i.test(trimmed);
  if (hasDateLetters) return true;
  const hasMonth = /m/i.test(trimmed);
  return hasMonth && !hasTimeIndicator;
}
