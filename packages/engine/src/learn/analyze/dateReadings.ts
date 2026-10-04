// Date readings of an input column, for one question only: could the column's DATES write this output value?
// (the constant guard in relations.ts: a "03/2026" in every row of a March file may be a label or the month of the data.)
//
// This is NOT the date detection the relations use (`dateSources`, one text format per column): it reads each cell on its own,
// so a column that mixes real dates, day/month text, ISO text and month-name text (a column typed by several people) is read
// too. DECISION: the reading is LENIENT: a text that reads two ways (05/03/2026 as 5 March or 3 May) gives both readings, and the
// output value only has to match one of them. A guard that is too strict would let a wrong constant through; one that is too
// lenient only sends a column to the AI step.

import { compileDateParser, ymdToSerial, type Ymd } from '../../values/dates';
import { DATE, NUM, TEXT, parseTextDate, type ColumnData } from './cells';

const SEPARATORS = ['/', '.', '-'];
const ORDERS = ['DMY', 'MDY', 'YMD'] as const;

/** Month-name formats a cell may be written in ("26 במרץ 2026", "March 26, 2026", "26-Mar-26"); the Hebrew "ב" glues to the name. */
const NAME_FORMATS = ['D MMMM YYYY', 'D בMMMM YYYY', 'D MMM YYYY', 'MMMM D, YYYY', 'MMM D, YYYY', 'D-MMM-YY', 'D-MMM-YYYY', 'MMMM YYYY', 'MMM YYYY'];

let nameParsers: ((text: string) => Ymd | null)[] | undefined;

/** Plain numbers read as Excel serials only in the range of 1910-01-01 .. 2099-12-31 (as `dateSources` does). */
const SERIAL_MIN = 3654;
const SERIAL_MAX = 73415;

/** Every serial a text cell can be read as, by the formats above; empty when it reads as no date. */
function textReadings(text: string): number[] {
  const t = text.trim();
  const found: number[] = [];
  const add = (serial: number): void => {
    if (!Number.isNaN(serial) && !found.includes(serial)) found.push(serial);
  };
  for (const sep of SEPARATORS) for (const order of ORDERS) add(parseTextDate(t, order, sep));
  nameParsers ??= NAME_FORMATS.map(compileDateParser);
  for (const parse of nameParsers) {
    const ymd = parse(t);
    if (ymd !== null) add(ymdToSerial(ymd));
  }
  return found;
}

/** Three numeric parts with one separator: day and month (1-2 digits each, either order) and a year (2 or 4 digits), or ISO order. */
const DATE_SHAPE_DMY = /^(\d{1,2})([./-])(\d{1,2})\2(\d{4}|\d{2})$/;
const DATE_SHAPE_YMD = /^(\d{4})([./-])(\d{1,2})\2(\d{1,2})$/;

/**
 * Whether a text reads as a date (SPEC 7.2, the masking switch: dates are sent real, text dates too): any reading of
 * `textReadings` (day/month, month/day or ISO numbers with / . -, a month name in Hebrew or English), or the SHAPE of one -
 * DECISION: a date the example got wrong ("31/02/2026", "00/13/2026") is what a cleanup rule is about, so it is sent as it is
 * too, as long as its two short parts are at most 31 and a 4-digit year is between 1900 and 2099 (a phone number or a code
 * with three parts does not fit that shape).
 */
export function readsAsDate(text: string): boolean {
  const t = text.trim();
  if (t === '') return false;
  if (textReadings(t).length > 0) return true;
  const dmy = DATE_SHAPE_DMY.exec(t);
  if (dmy) return Number(dmy[1]) <= 31 && Number(dmy[3]) <= 31 && (dmy[4]!.length === 2 || plausibleYear(Number(dmy[4])));
  const ymd = DATE_SHAPE_YMD.exec(t);
  return ymd !== null && plausibleYear(Number(ymd[1])) && Number(ymd[3]) <= 31 && Number(ymd[4]) <= 31;
}

function plausibleYear(y: number): boolean {
  return y >= 1900 && y <= 2099;
}

const MEMO = new WeakMap<ColumnData, (number[][] | null)>();

/**
 * The serials each row's cell can be read as (one list per row), or null when some row has no reading: an empty cell, a text
 * that is no date, a number that is no serial. Null means the column cannot write a date-derived value on EVERY row.
 */
export function dateReadings(col: ColumnData): number[][] | null {
  if (MEMO.has(col)) return MEMO.get(col)!;
  const rows: number[][] = [];
  let ok = true;
  for (let k = 0; k < col.n && ok; k++) {
    const kind = col.kind[k]!;
    if (kind === DATE) rows.push([col.date[k]!]);
    else if (kind === NUM || (kind === TEXT && col.numKey[k] !== null)) {
      const v = col.num[k]!;
      if (Number.isInteger(v) && v >= SERIAL_MIN && v <= SERIAL_MAX) rows.push([v]);
      else ok = false;
    } else if (kind === TEXT) {
      const reads = textReadings(col.text[k]!);
      if (reads.length === 0) ok = false;
      else rows.push(reads);
    } else {
      ok = false; // empty (or a boolean): nothing to derive a date from on this row
    }
  }
  const result = ok && rows.length === col.n ? rows : null;
  MEMO.set(col, result);
  return result;
}
