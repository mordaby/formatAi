// Column-wise views of the cells, computed once per column and shared by the
// profile, the alignment and every relation test. Struct-of-arrays so tests on
// 20,000-row pairs stay fast; exact values (canonical decimal text, Decimal)
// are kept next to the float used for quick pre-filters.

import Decimal from 'decimal.js';
import type { PayloadCell } from '@formatai/shared';
import type { RawCell } from '../../types';
import { isValidYmd, serialToYmd, ymdToSerial, type Ymd } from '../../values/dates';
import { parseNumber } from '../../values/numbers';
import { normalizeText } from '../../values/text';

export const EMPTY = 0;
export const TEXT = 1;
export const NUM = 2;
export const DATE = 3;
export const BOOL = 4;

export interface TextDateInfo {
  /** Token format of the values, e.g. "DD/MM/YYYY". */
  format: string;
  order: 'DMY' | 'MDY' | 'YMD';
  sep: string;
  /** Every value also reads as a valid date with day and month swapped. */
  ambiguous: boolean;
  /** The swapped reading's format, when ambiguous. */
  altFormat?: string;
}

export interface ColumnData {
  n: number;
  /** EMPTY | TEXT | NUM | DATE | BOOL, as stored in the file. */
  kind: Uint8Array;
  /** Display text: the string as written; canonical decimal for numbers; ISO date; TRUE/FALSE. '' when empty. */
  text: string[];
  /** Canonical decimal text when the value is a number or numeric text, else null. */
  numKey: (string | null)[];
  /** Float of numKey (NaN when not numeric). Only for pre-filters: exact checks use Decimal. */
  num: Float64Array;
  /** 1900-system Excel serial when the value is a date (real date cell, or text read with textDate), else NaN. */
  date: Float64Array;
  /** Set when every non-empty value is text in one date format. */
  textDate: TextDateInfo | null;
  /** Serials of the swapped day/month reading (ambiguous text dates). Lazy: see altDates(). */
  alt?: Float64Array;
  /** Lazy: see norms(). */
  norm?: string[];
  /** Lazy: see keys(). */
  key?: (string | null)[];
  /** Lazy: see decOf(). */
  dec?: (Decimal | null | undefined)[];
}

// ---------- numbers ----------

/** Canonical decimal text of a number as Excel shows it (15 significant digits), never exponential. */
export function canonNum(n: number): string {
  if (n === 0) return '0';
  if (Number.isInteger(n) && Math.abs(n) < 1e15) return String(n);
  const p = n.toPrecision(15);
  const s = String(Number(p));
  if (s.includes('e')) {
    const d = new Decimal(p);
    return d.isZero() ? '0' : d.toFixed();
  }
  return s;
}

const HAS_DIGIT = /\d/;
const HAS_LETTER = /[A-Za-zא-ת]/;
const CURRENCY_WORD = /NIS|ש"ח|ש״ח/;
/** Dates and similar digit groups ("31/01/2024", "2024-01-31") are never numbers. */
const DIGIT_GROUPS = /^\d{1,4}[./-]\d{1,2}[./-]\d{1,4}$/;
/** Plain numbers skip parseNumber's general path. */
const PLAIN_NUMBER = /^-?\d{1,15}(\.\d{1,15})?$/;

/** Canonical decimal text of a number stored as text ("1,234.50", "₪100", "12%"), else null. */
export function numericText(s: string): string | null {
  const t = s.trim();
  if (t.length === 0 || t.length > 40 || !HAS_DIGIT.test(t)) return null;
  if (HAS_LETTER.test(t) && !CURRENCY_WORD.test(t)) return null;
  if (DIGIT_GROUPS.test(t)) return null;
  if (PLAIN_NUMBER.test(t)) {
    const n = Number(t);
    if (Number.isSafeInteger(n) && !t.includes('.')) return n === 0 ? '0' : String(n);
  }
  const d = parseNumber(t);
  if (d === null) return null;
  return d.isZero() ? '0' : d.toFixed();
}

/** Decimal places of a canonical decimal text. */
export function decimalsOf(numKey: string): number {
  const dot = numKey.indexOf('.');
  return dot < 0 ? 0 : numKey.length - dot - 1;
}

/** Significant digits of a canonical decimal text ("1.17" 3, "0.854701" 6, "120" 2, "0.5" 1): how round a constant is. */
export function significantDigits(numKey: string): number {
  return new Decimal(numKey).sd();
}

// ---------- dates ----------

const YMD_MEMO = new Map<number, Ymd>();

export function ymdOfSerial(serial: number): Ymd {
  let y = YMD_MEMO.get(serial);
  if (y === undefined) {
    y = serialToYmd(serial);
    if (YMD_MEMO.size > 50000) YMD_MEMO.clear();
    YMD_MEMO.set(serial, y);
  }
  return y;
}

const ISO_MEMO = new Map<number, string>();

export function isoOfSerial(serial: number): string {
  let s = ISO_MEMO.get(serial);
  if (s === undefined) {
    const { y, m, d } = ymdOfSerial(serial);
    s = `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    if (ISO_MEMO.size > 50000) ISO_MEMO.clear();
    ISO_MEMO.set(serial, s);
  }
  return s;
}

const DMY_RE = /^(\d{1,2})([./-])(\d{1,2})\2(\d{4}|\d{2})$/;
const YMD_RE = /^(\d{4})([./-])(\d{1,2})\2(\d{1,2})$/;

function fullYear(raw: string): number {
  const n = parseInt(raw, 10);
  // Same pivot as values/dates: 00-49 -> 2000s, 50-99 -> 1900s.
  return raw.length <= 2 ? (n < 50 ? 2000 + n : 1900 + n) : n;
}

function serialOf(y: number, m: number, d: number): number {
  const ymd = { y, m, d };
  return isValidYmd(ymd) ? ymdToSerial(ymd) : NaN;
}

/** Serial of a text date read with `order` (and separator), NaN when it doesn't parse. */
export function parseTextDate(s: string, order: 'DMY' | 'MDY' | 'YMD', sep: string): number {
  const t = s.trim();
  if (order === 'YMD') {
    const m = YMD_RE.exec(t);
    if (!m || m[2] !== sep) return NaN;
    return serialOf(parseInt(m[1]!, 10), parseInt(m[3]!, 10), parseInt(m[4]!, 10));
  }
  const m = DMY_RE.exec(t);
  if (!m || m[2] !== sep) return NaN;
  const a = parseInt(m[1]!, 10);
  const b = parseInt(m[3]!, 10);
  const y = fullYear(m[4]!);
  return order === 'DMY' ? serialOf(y, b, a) : serialOf(y, a, b);
}

/**
 * The single date format all `texts` share, or null. DD/MM vs MM/DD is decided
 * by values above 12; when nothing decides it, day-first is chosen (SPEC 17:
 * Hebrew files default to DD/MM) and `ambiguous` is set.
 */
export function detectTextDateFormat(texts: string[]): TextDateInfo | null {
  if (texts.length === 0) return null;
  const first = texts[0]!.trim();
  const ymd = YMD_RE.exec(first);
  if (ymd) {
    const sep = ymd[2]!;
    let padM = true;
    let padD = true;
    for (const raw of texts) {
      const m = YMD_RE.exec(raw.trim());
      if (!m || m[2] !== sep) return null;
      if (Number.isNaN(serialOf(parseInt(m[1]!, 10), parseInt(m[3]!, 10), parseInt(m[4]!, 10)))) return null;
      if (m[3]!.length < 2) padM = false;
      if (m[4]!.length < 2) padD = false;
    }
    return { format: `YYYY${sep}${padM ? 'MM' : 'M'}${sep}${padD ? 'DD' : 'D'}`, order: 'YMD', sep, ambiguous: false };
  }
  const dmy = DMY_RE.exec(first);
  if (!dmy) return null;
  const sep = dmy[2]!;
  const yLen = dmy[4]!.length;
  let dmyOk = true;
  let mdyOk = true;
  let pad1 = true;
  let pad2 = true;
  for (const raw of texts) {
    const m = DMY_RE.exec(raw.trim());
    if (!m || m[2] !== sep || m[4]!.length !== yLen) return null;
    const a = parseInt(m[1]!, 10);
    const b = parseInt(m[3]!, 10);
    const y = fullYear(m[4]!);
    if (dmyOk && Number.isNaN(serialOf(y, b, a))) dmyOk = false;
    if (mdyOk && Number.isNaN(serialOf(y, a, b))) mdyOk = false;
    if (!dmyOk && !mdyOk) return null;
    if (m[1]!.length < 2) pad1 = false;
    if (m[3]!.length < 2) pad2 = false;
  }
  const yTok = yLen === 4 ? 'YYYY' : 'YY';
  const dmyFmt = `${pad1 ? 'DD' : 'D'}${sep}${pad2 ? 'MM' : 'M'}${sep}${yTok}`;
  const mdyFmt = `${pad1 ? 'MM' : 'M'}${sep}${pad2 ? 'DD' : 'D'}${sep}${yTok}`;
  // DECISION: when every value reads both ways, day-first wins (SPEC 17) and the
  // pair analysis tries the other reading against the output before trusting it.
  if (dmyOk && mdyOk) return { format: dmyFmt, order: 'DMY', sep, ambiguous: true, altFormat: mdyFmt };
  if (dmyOk) return { format: dmyFmt, order: 'DMY', sep, ambiguous: false };
  return { format: mdyFmt, order: 'MDY', sep, ambiguous: false };
}

/**
 * Marks a column as text dates when every non-empty value is text in one date
 * format, filling `date` with the serials. Mixed columns are left alone.
 */
export function detectTextDates(col: ColumnData): void {
  const texts: string[] = [];
  for (let k = 0; k < col.n; k++) {
    const kind = col.kind[k]!;
    if (kind === EMPTY) continue;
    if (kind !== TEXT) return;
    texts.push(col.text[k]!);
  }
  const info = detectTextDateFormat(texts);
  if (!info) return;
  col.textDate = info;
  for (let k = 0; k < col.n; k++) {
    if (col.kind[k] === TEXT) col.date[k] = parseTextDate(col.text[k]!, info.order, info.sep);
  }
}

/** Serials of the swapped reading of an ambiguous text-date column (the primary reading otherwise). */
export function altDates(col: ColumnData): Float64Array {
  const info = col.textDate;
  if (!info || !info.ambiguous) return col.date;
  if (col.alt) return col.alt;
  const order = info.order === 'DMY' ? 'MDY' : 'DMY';
  const alt = new Float64Array(col.n).fill(NaN);
  for (let k = 0; k < col.n; k++) {
    if (col.kind[k] === TEXT) alt[k] = parseTextDate(col.text[k]!, order, info.sep);
  }
  col.alt = alt;
  return alt;
}

// ---------- building ----------

/** Column view of a list of cells. `date1904` shifts real date serials to the 1900 system. */
export function columnFromCells(cells: ArrayLike<RawCell | null | undefined>, date1904: boolean): ColumnData {
  const n = cells.length;
  const kind = new Uint8Array(n);
  const text: string[] = new Array(n);
  const numKey: (string | null)[] = new Array(n);
  const num = new Float64Array(n).fill(NaN);
  const date = new Float64Array(n).fill(NaN);
  for (let k = 0; k < n; k++) {
    const cell = cells[k];
    const v = cell ? cell.v : null;
    numKey[k] = null;
    if (v === null || v === undefined) {
      text[k] = '';
      continue;
    }
    if (typeof v === 'string') {
      if (v.trim() === '') {
        text[k] = '';
        continue;
      }
      kind[k] = TEXT;
      text[k] = v;
      const nk = numericText(v);
      if (nk !== null) {
        numKey[k] = nk;
        num[k] = Number(nk);
      }
      continue;
    }
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) {
        kind[k] = TEXT;
        text[k] = String(v);
        continue;
      }
      if (cell!.isDate) {
        const serial = Math.trunc(v) + (date1904 ? 1462 : 0);
        if (serial >= 1 && serial <= 2958465) {
          kind[k] = DATE;
          date[k] = serial;
          text[k] = isoOfSerial(serial);
          continue;
        }
      }
      kind[k] = NUM;
      const nk = canonNum(v);
      numKey[k] = nk;
      num[k] = Number(nk);
      text[k] = nk;
      continue;
    }
    kind[k] = BOOL;
    text[k] = v ? 'TRUE' : 'FALSE';
  }
  return { n, kind, text, numKey, num, date, textDate: null };
}

/** Column `c` of row-major rows. */
export function columnOfRows(rows: (RawCell | null)[][], c: number, date1904: boolean): ColumnData {
  const cells: (RawCell | null)[] = new Array(rows.length);
  for (let r = 0; r < rows.length; r++) cells[r] = rows[r]![c] ?? null;
  return columnFromCells(cells, date1904);
}

/** A column restricted to (and reordered by) `idx`. */
export function gather(col: ColumnData, idx: ArrayLike<number>): ColumnData {
  const n = idx.length;
  const kind = new Uint8Array(n);
  const text: string[] = new Array(n);
  const numKey: (string | null)[] = new Array(n);
  const num = new Float64Array(n);
  const date = new Float64Array(n);
  const norm = col.norm ? (new Array(n) as string[]) : undefined;
  const key = col.key ? (new Array(n) as (string | null)[]) : undefined;
  const dec = col.dec ? (new Array(n) as (Decimal | null | undefined)[]) : undefined;
  const alt = col.alt ? new Float64Array(n) : undefined;
  for (let i = 0; i < n; i++) {
    const j = idx[i]!;
    kind[i] = col.kind[j]!;
    text[i] = col.text[j]!;
    numKey[i] = col.numKey[j]!;
    num[i] = col.num[j]!;
    date[i] = col.date[j]!;
    if (norm) norm[i] = col.norm![j]!;
    if (key) key[i] = col.key![j]!;
    if (dec) dec[i] = col.dec![j];
    if (alt) alt[i] = col.alt![j]!;
  }
  const out: ColumnData = { n, kind, text, numKey, num, date, textDate: col.textDate };
  if (norm) out.norm = norm;
  if (key) out.key = key;
  if (dec) out.dec = dec;
  if (alt) out.alt = alt;
  return out;
}

// ---------- derived views ----------

// normalizeText is the identity on printable ASCII without spaces or quote marks.
const ASCII_PLAIN_RE = /^[!-&(-_a-~]*$/;
const NORM_MEMO = new Map<string, string>();

/** normalizeText, fast for plain ASCII and repeated values. */
export function normFast(s: string): string {
  if (ASCII_PLAIN_RE.test(s)) return s;
  let n = NORM_MEMO.get(s);
  if (n === undefined) {
    n = normalizeText(s);
    if (NORM_MEMO.size >= 20000) NORM_MEMO.clear();
    NORM_MEMO.set(s, n);
  }
  return n;
}

/** Normalized, case-folded display text ('' for empty). */
export function norms(col: ColumnData): string[] {
  if (col.norm) return col.norm;
  const out: string[] = new Array(col.n);
  for (let k = 0; k < col.n; k++) {
    const t = col.text[k]!;
    out[k] = t === '' ? '' : col.kind[k] === TEXT ? normFast(t).toLowerCase() : t;
  }
  col.norm = out;
  return out;
}

/**
 * Matching keys (null for empty): numbers and numeric text by canonical value
 * (so "00123" matches 123), dates by serial, text normalized and case-folded.
 */
export function keys(col: ColumnData): (string | null)[] {
  if (col.key) return col.key;
  const nm = norms(col);
  const out: (string | null)[] = new Array(col.n);
  for (let k = 0; k < col.n; k++) {
    const kind = col.kind[k]!;
    if (kind === EMPTY) out[k] = null;
    else if (kind === DATE) out[k] = `\u0002${col.date[k]}`;
    else if (kind === BOOL) out[k] = `\u0001${col.text[k]}`;
    else out[k] = col.numKey[k] ?? nm[k]!;
  }
  col.key = out;
  return out;
}

/** Exact Decimal of a numeric cell (null when not numeric). */
export function decOf(col: ColumnData, k: number): Decimal | null {
  let cache = col.dec;
  if (!cache) {
    cache = new Array(col.n);
    col.dec = cache;
  }
  let d = cache[k];
  if (d === undefined) {
    const nk = col.numKey[k];
    d = nk === null || nk === undefined ? null : new Decimal(nk);
    cache[k] = d;
  }
  return d;
}

/** The value as it goes into the payload (numbers as numbers, dates as ISO text). */
export function payloadCell(col: ColumnData, k: number): PayloadCell {
  switch (col.kind[k]) {
    case EMPTY:
      return null;
    case NUM:
      return Number(col.numKey[k]);
    case BOOL:
      return col.text[k] === 'TRUE';
    default:
      return col.text[k]!;
  }
}

/** Display text of a raw cell (headers, titles, labels). */
export function rawText(cell: RawCell | null | undefined): string {
  if (!cell || cell.v === null) return '';
  if (typeof cell.v === 'string') return cell.v;
  if (typeof cell.v === 'boolean') return cell.v ? 'TRUE' : 'FALSE';
  return canonNum(cell.v);
}

export function isEmptyRaw(cell: RawCell | null | undefined): boolean {
  if (!cell || cell.v === null) return true;
  return typeof cell.v === 'string' && cell.v.trim() === '';
}

/** Share of non-empty cells that are numeric (numbers or numeric text). */
export function numericShare(col: ColumnData): number {
  let ne = 0;
  let nn = 0;
  for (let k = 0; k < col.n; k++) {
    const kind = col.kind[k]!;
    if (kind === EMPTY) continue;
    ne++;
    if (kind !== DATE && col.numKey[k] !== null) nn++;
  }
  return ne === 0 ? 0 : nn / ne;
}

export function nonEmptyCount(col: ColumnData): number {
  let ne = 0;
  for (let k = 0; k < col.n; k++) if (col.kind[k] !== EMPTY) ne++;
  return ne;
}
