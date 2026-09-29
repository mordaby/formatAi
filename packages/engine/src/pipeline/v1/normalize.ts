// Steps 1-2 (SPEC 8.2): map input headers to column ids, and normalize every
// cell to its declared type. A value that fails to parse is kept as it is and
// reported (the caller turns the report into a "type" flag).

import Decimal from 'decimal.js';
import type { ColumnType, InputColumn } from '@formatai/shared';
import type { RawCell } from '../../types';
import { formatYmd, parseDate, suggestDaySwap } from '../../values/dates';
import { fromExcelNumber, parseNumber } from '../../values/numbers';
import { normalizeText, padLeft } from '../../values/text';
import {
  DateVal,
  dateFromSerial,
  dateFromYmd,
  decText,
  isBlankText,
  parseConstDate,
  type Val,
} from './values';

export type TypeCat = 'number' | 'date' | 'text' | 'idLike' | 'boolean';

export function typeCat(t: ColumnType): TypeCat {
  switch (t) {
    case 'integer':
    case 'decimal':
    case 'currency':
    case 'percent':
      return 'number';
    case 'date':
      return 'date';
    case 'idLike':
      return 'idLike';
    case 'boolean':
      return 'boolean';
    case 'text':
      return 'text';
  }
}

// DECISION: a date column with no `inputFormats` accepts real date cells plus
// day-first text (D/M/YYYY, D.M.YYYY) and ISO YYYY-MM-DD: SPEC 17 says default
// to DD/MM for Hebrew files. Month-first is never assumed. Plain numbers are
// read as Excel serials only when "excelSerial" is listed.
const DEFAULT_DATE_FORMATS = ['D/M/YYYY', 'D.M.YYYY', 'YYYY-MM-DD'];

export interface ColNorm {
  type: ColumnType;
  cat: TypeCat;
  padLeft: number | undefined;
  formats: string[];
  date1904: boolean;
  language: 'he' | 'en';
}

export function colNorm(
  col: { type: ColumnType; padLeft?: number; inputFormats?: string[] },
  date1904: boolean,
  language: 'he' | 'en',
): ColNorm {
  return {
    type: col.type,
    cat: typeCat(col.type),
    padLeft: col.padLeft,
    formats: col.inputFormats && col.inputFormats.length > 0 ? col.inputFormats : DEFAULT_DATE_FORMATS,
    date1904,
    language,
  };
}

/** Reusable out-parameter for normalizeCell (avoids allocating per cell). */
export interface NormIssue {
  /** messageKey of the failure, or null when the value normalized cleanly. */
  key: string | null;
  suggestion: string | number | undefined;
}

export function newIssue(): NormIssue {
  return { key: null, suggestion: undefined };
}

const DIGITS_RE = /^\d+$/;

function padId(s: string, n: number | undefined): string {
  // DECISION: padLeft restores lost leading zeros, so it applies only to
  // all-digit ids; ids with letters or signs are left untouched.
  return n !== undefined && DIGITS_RE.test(s) ? padLeft(s, n, '0') : s;
}

/** A raw JS number kept as-is: it becomes a Decimal (the pipeline never holds floats). */
function keepRaw(raw: string | number | boolean): Val {
  return typeof raw === 'number' ? (Number.isFinite(raw) ? fromExcelNumber(raw) : String(raw)) : raw;
}

/**
 * Normalizes one input cell to the column's declared type.
 *  - number types: xlsx numbers via fromExcelNumber, text via parseNumber
 *  - date: date cells (isDate) from their serial, anything else via `formats`
 *  - idLike: stays text; numbers become integer text; all-digit ids are padded
 *  - text: text as-is; numbers stringified plainly; date cells stay dates
 * On failure the raw value is returned and `issue.key` is set.
 */
export function normalizeCell(cell: RawCell | null | undefined, col: ColNorm, issue: NormIssue): Val {
  issue.key = null;
  issue.suggestion = undefined;
  if (cell === null || cell === undefined) return null;
  const raw = cell.v;
  if (raw === null) return null;
  if (typeof raw === 'string' && isBlankText(raw)) return null;

  switch (col.cat) {
    case 'number': {
      let d: Decimal | null = null;
      if (typeof raw === 'number') d = Number.isFinite(raw) ? fromExcelNumber(raw) : null;
      else if (typeof raw === 'string') d = parseNumber(raw);
      if (d === null) {
        issue.key = 'flag.parseFailed.number';
        return keepRaw(raw);
      }
      if (col.type === 'integer' && !d.isInteger()) issue.key = 'flag.parseFailed.integer';
      return d;
    }

    case 'date': {
      if (typeof raw === 'number') {
        if (cell.isDate === true) {
          const dv = dateFromSerial(raw, col.date1904);
          if (dv !== null) return dv;
        } else {
          const ymd = parseDate(raw, col.formats, col.date1904);
          const dv = ymd === null ? null : dateFromYmd(ymd);
          if (dv !== null) return dv;
        }
        issue.key = 'flag.parseFailed.date';
        return keepRaw(raw);
      }
      if (typeof raw === 'string') {
        const t = raw.trim();
        const ymd = parseDate(t, col.formats, col.date1904);
        const dv = ymd === null ? null : dateFromYmd(ymd);
        if (dv !== null) return dv;
        issue.key = 'flag.parseFailed.date';
        // Suggest a day/month swap only when it is mechanical: the text fits a
        // listed format, the date is impossible, and swapping makes it valid.
        for (const f of col.formats) {
          if (f === 'excelSerial') continue;
          const swapped = suggestDaySwap(t, f);
          if (swapped !== null) {
            issue.suggestion = formatYmd(swapped, f, col.language);
            break;
          }
        }
        return raw;
      }
      issue.key = 'flag.parseFailed.date';
      return raw;
    }

    case 'idLike': {
      if (typeof raw === 'string') return padId(raw.trim(), col.padLeft);
      if (typeof raw === 'number') {
        if (!Number.isFinite(raw)) {
          issue.key = 'flag.parseFailed.idLike';
          return String(raw);
        }
        const d = fromExcelNumber(raw);
        const t = decText(d);
        if (!d.isInteger()) {
          issue.key = 'flag.parseFailed.idLike';
          return t;
        }
        return padId(t, col.padLeft);
      }
      issue.key = 'flag.parseFailed.idLike';
      return raw;
    }

    case 'text': {
      if (typeof raw === 'string') return raw;
      if (typeof raw === 'number') {
        // DECISION: a real date cell in a text column stays a date (written back
        // as a date), rather than being turned into its serial number as text.
        if (cell.isDate === true) {
          const dv = dateFromSerial(raw, col.date1904);
          if (dv !== null) return dv;
        }
        return Number.isFinite(raw) ? decText(fromExcelNumber(raw)) : String(raw);
      }
      return raw;
    }

    case 'boolean': {
      // DECISION: boolean columns accept Excel booleans, text TRUE/FALSE (any
      // case) and the numbers 1/0. Anything else (e.g. כן/לא) is kept and
      // flagged: such columns should be declared as text.
      if (typeof raw === 'boolean') return raw;
      if (typeof raw === 'string') {
        const t = raw.trim().toLowerCase();
        if (t === 'true') return true;
        if (t === 'false') return false;
      } else if (raw === 1) return true;
      else if (raw === 0) return false;
      issue.key = 'flag.parseFailed.boolean';
      return keepRaw(raw);
    }
  }
}

/**
 * A constant from the rules (filter value) normalized like a cell of `col`, so
 * that e.g. an idLike filter value 123 is padded like the column's values.
 * Date constants are read as ISO first (see CONST_DATE_FORMATS), then via the
 * column's formats. A constant that doesn't normalize is kept as-is.
 */
export function normalizeConst(value: string | number | boolean | null, col: ColNorm): Val {
  if (value === null) return null;
  if (col.cat === 'date' && typeof value === 'string') {
    const d = parseConstDate(value);
    if (d !== null) return d;
  }
  if (col.cat === 'date' && typeof value === 'number') {
    // A number compared with a date column is an Excel serial.
    const d = dateFromSerial(value, false);
    if (d !== null) return d;
  }
  if (typeof value === 'number' && col.cat === 'number') {
    // JSON numbers are exact as written (0.17 stays 0.17).
    return Number.isFinite(value) ? new Decimal(value) : String(value);
  }
  const issue = newIssue();
  return normalizeCell({ v: value }, col, issue);
}

/**
 * Coerces an already-normalized value (e.g. an expression result) to a declared
 * type. Sets `issue.key` when the value can't be read as that type (kept as-is).
 */
export function coerceTo(v: Val, type: ColumnType, issue: NormIssue): Val {
  issue.key = null;
  issue.suggestion = undefined;
  if (v === null) return null;
  switch (typeCat(type)) {
    case 'number': {
      if (v instanceof Decimal) {
        if (type === 'integer' && !v.isInteger()) issue.key = 'flag.parseFailed.integer';
        return v;
      }
      if (v instanceof DateVal) return new Decimal(v.serial);
      if (typeof v === 'string') {
        const n = parseNumber(v);
        if (n !== null) {
          if (type === 'integer' && !n.isInteger()) issue.key = 'flag.parseFailed.integer';
          return n;
        }
      }
      issue.key = 'flag.parseFailed.number';
      return v;
    }
    case 'date': {
      if (v instanceof DateVal) return v;
      if (v instanceof Decimal) {
        const d = dateFromSerial(v.toNumber(), false);
        if (d !== null) return d;
      } else if (typeof v === 'string') {
        const d = parseConstDate(v);
        if (d !== null) return d;
      }
      issue.key = 'flag.parseFailed.date';
      return v;
    }
    case 'idLike': {
      if (v instanceof Decimal) {
        if (!v.isInteger()) issue.key = 'flag.parseFailed.idLike';
        return decText(v);
      }
      return v;
    }
    case 'text':
      return v instanceof Decimal ? decText(v) : v;
    case 'boolean': {
      if (typeof v === 'boolean') return v;
      if (typeof v === 'string') {
        const t = v.trim().toLowerCase();
        if (t === 'true') return true;
        if (t === 'false') return false;
      }
      if (v instanceof Decimal) {
        if (v.eq(1)) return true;
        if (v.isZero()) return false;
      }
      issue.key = 'flag.parseFailed.boolean';
      return v;
    }
  }
}

// ---------- Header mapping ----------

export interface HeaderMapping {
  /** Input column index per rules column (-1 when not found). */
  src: number[];
  /** Headers (from the rules) of required columns that weren't found. */
  missingRequired: string[];
}

// DECISION: the normalized header match also ignores ASCII/Unicode letter case
// (toLowerCase, which is locale-independent); it only matters for Latin headers.
function headerKey(s: string): string {
  return normalizeText(s).toLowerCase();
}

/**
 * Maps rule columns to input columns (SPEC 8.2 step 1). Each phase runs for all
 * still-unmatched columns before the next phase, so a loose match can never
 * steal a column another rule matches exactly:
 *   1. exact header   2. exact alias   3. normalized header or alias.
 * Each input column is claimed at most once (first free match, left to right),
 * so duplicate input headers map in order.
 */
export function mapHeaders(columns: InputColumn[], headers: string[]): HeaderMapping {
  const src: number[] = columns.map(() => -1);
  const claimed = new Array<boolean>(headers.length).fill(false);
  const normHeaders = headers.map((h) => headerKey(h));

  const claim = (ci: number, pred: (hi: number) => boolean): void => {
    for (let hi = 0; hi < headers.length; hi++) {
      if (!claimed[hi] && pred(hi)) {
        claimed[hi] = true;
        src[ci] = hi;
        return;
      }
    }
  };

  columns.forEach((c, ci) => {
    if (c.header !== '') claim(ci, (hi) => headers[hi] === c.header);
  });
  columns.forEach((c, ci) => {
    if (src[ci] !== -1 || !c.aliases) return;
    for (const a of c.aliases) {
      if (a === '') continue;
      claim(ci, (hi) => headers[hi] === a);
      if (src[ci] !== -1) return;
    }
  });
  columns.forEach((c, ci) => {
    if (src[ci] !== -1) return;
    const keys = [c.header, ...(c.aliases ?? [])].map(headerKey).filter((k) => k !== '');
    for (const k of keys) {
      claim(ci, (hi) => normHeaders[hi] === k);
      if (src[ci] !== -1) return;
    }
  });

  const missingRequired: string[] = [];
  columns.forEach((c, ci) => {
    if (src[ci] === -1 && c.required === true) missingRequired.push(c.header);
  });
  return { src, missingRequired };
}
