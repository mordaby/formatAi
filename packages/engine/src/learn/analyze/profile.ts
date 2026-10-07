// Column profile (SPEC 7.1): type, shape, empty/distinct stats, lengths and
// ranges, and the flags the learn step needs (key, leadingZerosLost, israeliId,
// serialDates). Pure and deterministic.

import type { PayloadColumn, PayloadColumnStats, ProfileType } from '@formatai/shared';
import type { RawCell } from '../../types';
import { isValidIsraeliId } from '../../values/israeliId';
import {
  BOOL,
  DATE,
  EMPTY,
  NUM,
  TEXT,
  columnOfRows,
  detectTextDates,
  isoOfSerial,
  keys,
  type ColumnData,
} from './cells';
import type { ColumnProfile, ProfileOptions, ProfileTable } from './types';

const MAX_SHAPES = 4;
const MAX_SHAPE_CHARS = 80;
const MAX_SHAPE_VALUE_LEN = 30;
const DIGITS_RE = /^\d+$/;
const PERCENT_FMT_RE = /%/;
const CURRENCY_FMT_RE = /[₪$€]|\[\$[^\]]*\]|ש"ח|ש״ח|NIS/;
const CURRENCY_TEXT_RE = /[₪$€]|NIS|ש"ח|ש״ח/;

const LETTER_RE = /\p{L}/u;
const DIGIT_RE = /\p{N}/u;
const MARK_RE = /\p{M}/u;
const HEBREW_RE = /\p{Script=Hebrew}/u;

/**
 * Shape signature of one value: D = a digit, H = a Hebrew letter, A = any other letter, other characters literal.
 *
 * Amendment (2026-10-07, engine audit): script-agnostic. Every letter of every script is a shape letter (Cyrillic, Arabic, Greek, CJK, an
 * accented Latin letter: `A`), every digit of any script a `D`, and a combining mark (niqqud, an accent written apart) is dropped - it
 * belongs to the letter before it. Only separators (spaces, punctuation, symbols) are kept as they are, so a shape never holds a letter
 * or digit of the value: "Иван Петров" was sent whole, "José" as "AAAé".
 */
export function shapeOf(s: string): string {
  let out = '';
  for (const ch of s) {
    const c = ch.charCodeAt(0);
    if (c >= 48 && c <= 57) out += 'D';
    else if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122)) out += 'A';
    else if (c < 128) out += ch;
    else if (LETTER_RE.test(ch)) out += HEBREW_RE.test(ch) ? 'H' : 'A';
    else if (DIGIT_RE.test(ch)) out += 'D';
    else if (!MARK_RE.test(ch)) out += ch;
  }
  return out;
}

/** Whether a shape signature holds only shape letters, digits' `D` and separators (`shapeOf`'s alphabet): never a letter or digit of a value. */
export function isSafeShape(shape: string): boolean {
  for (const ch of shape) if (ch !== 'A' && ch !== 'D' && ch !== 'H' && ch !== '|' && (LETTER_RE.test(ch) || DIGIT_RE.test(ch) || MARK_RE.test(ch))) return false;
  return true;
}

/** Values read for the shape signature: spread over the whole column. */
const SHAPE_SAMPLE = 2000;

function shapeSignature(col: ColumnData): string | undefined {
  const counts = new Map<string, number>();
  let total = 0;
  const step = Math.max(1, Math.ceil(col.n / SHAPE_SAMPLE));
  for (let k = 0; k < col.n; k += step) {
    const kind = col.kind[k]!;
    if (kind === EMPTY || kind === DATE || kind === BOOL) continue;
    const t = col.text[k]!.trim();
    total++;
    if (t.length > MAX_SHAPE_VALUE_LEN) continue;
    const s = shapeOf(t);
    counts.set(s, (counts.get(s) ?? 0) + 1);
  }
  if (total === 0 || counts.size === 0) return undefined;
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const top = sorted.slice(0, MAX_SHAPES);
  const covered = top.reduce((s, [, n]) => s + n, 0);
  // DECISION: a shape is only useful when a few alternatives describe most values;
  // free text (names, notes) gets no shape rather than a misleading one.
  if (covered / total < 0.5) return undefined;
  const sig = top
    .map(([s]) => s)
    .sort((a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0))
    .join('|');
  return sig.length > MAX_SHAPE_CHARS ? undefined : sig;
}

function mostCommon(values: string[]): string | undefined {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best: string | undefined;
  let bestN = 0;
  for (const [v, n] of counts) {
    if (n > bestN) {
      best = v;
      bestN = n;
    }
  }
  return best;
}

/**
 * Profile of one column. `raw` gives the raw cells (for number formats); it is
 * only read when `opts.output` is set or to detect percent/currency formats.
 */
export function profileColumn(
  col: ColumnData,
  i: number,
  header: string,
  raw: (k: number) => RawCell | null | undefined,
  opts: ProfileOptions & { width?: number } = {},
): ColumnProfile {
  const n = col.n;
  let nonEmpty = 0;
  let nText = 0;
  let nNum = 0;
  let nNumText = 0;
  let nDate = 0;
  let nBool = 0;
  let allInteger = true;
  let minLen = Infinity;
  let maxLen = -Infinity;
  let minNum = Infinity;
  let maxNum = -Infinity;
  let minDate = Infinity;
  let maxDate = -Infinity;
  let digitStrings = true;
  let anyLeadingZero = false;
  let minDigits = Infinity;
  let maxDigits = -Infinity;
  let percentText = 0;
  let currencyText = 0;
  const zs: string[] = [];

  for (let k = 0; k < n; k++) {
    const kind = col.kind[k]!;
    if (kind === EMPTY) continue;
    nonEmpty++;
    const t = col.text[k]!.trim();
    if (kind !== DATE) {
      minLen = Math.min(minLen, t.length);
      maxLen = Math.max(maxLen, t.length);
    }
    if (kind === TEXT) {
      nText++;
      if (col.numKey[k] !== null) {
        nNumText++;
        if (t.endsWith('%')) percentText++;
        if (CURRENCY_TEXT_RE.test(t)) currencyText++;
      }
    } else if (kind === NUM) nNum++;
    else if (kind === DATE) nDate++;
    else nBool++;

    const nk = col.numKey[k];
    if (nk !== null && nk !== undefined) {
      const f = col.num[k]!;
      if (f < minNum) minNum = f;
      if (f > maxNum) maxNum = f;
      if (nk.includes('.')) allInteger = false;
    }
    const d = col.date[k]!;
    if (!Number.isNaN(d)) {
      if (d < minDate) minDate = d;
      if (d > maxDate) maxDate = d;
    }
    if ((kind === TEXT && DIGITS_RE.test(t)) || (kind === NUM && nk !== null && DIGITS_RE.test(nk!))) {
      if (kind === TEXT && t.length > 1 && t[0] === '0') anyLeadingZero = true;
      minDigits = Math.min(minDigits, t.length);
      maxDigits = Math.max(maxDigits, t.length);
    } else digitStrings = false;
    if (opts.output || kind === NUM) {
      const z = raw(k)?.z;
      if (z !== undefined) zs.push(z);
    }
  }

  // distinct (normalized)
  const ks = keys(col);
  const seen = new Set<string>();
  for (let k = 0; k < n; k++) {
    const key = ks[k];
    if (key !== null && key !== undefined) seen.add(key);
  }
  const distinctCount = seen.size;
  const distinctRatio = nonEmpty === 0 ? 0 : distinctCount / nonEmpty;
  const isKey = n >= 2 && nonEmpty === n && distinctCount === n;

  // Israeli id: 9 digits with a valid check digit on >= 95% of rows, after padding.
  let israeliId = false;
  if (nonEmpty > 0 && digitStrings && maxDigits <= 9) {
    let valid = 0;
    let long = 0;
    for (let k = 0; k < n; k++) {
      if (col.kind[k] === EMPTY) continue;
      const t = col.text[k]!.trim();
      if (t.length >= 7) long++;
      if (isValidIsraeliId(t)) valid++;
    }
    israeliId = valid / nonEmpty >= 0.95 && long / nonEmpty >= 0.95;
  }

  // Leading zeros lost: digit strings, none with a leading zero, some shorter than
  // the column's full length. DECISION: from the column alone this is only claimed
  // for Israeli ids (plain integers look exactly like ids with lost zeros); the pair
  // analysis also sets it when a padLeft relation proves it.
  const leadingZerosLost = israeliId && !anyLeadingZero && minDigits < 9;

  const numericAll = nonEmpty > 0 && nNum + nNumText === nonEmpty;
  let type: ProfileType;
  if (nonEmpty === 0) type = 'empty';
  else if (nBool === nonEmpty) type = 'boolean';
  else if (nDate === nonEmpty || (col.textDate !== null && nText === nonEmpty)) type = 'date';
  else if (
    digitStrings &&
    (anyLeadingZero ||
      israeliId ||
      leadingZerosLost ||
      minDigits >= 8 ||
      (nText === nonEmpty && minDigits === maxDigits && minDigits >= 5 && distinctRatio >= 0.5))
  ) {
    // DECISION: digit strings are ids when zeros matter, when they're Israeli ids,
    // when they're long (>= 8 digits: too long to be a plausible amount), or when
    // text digit strings (csv) all have the same length of 5+ and mostly differ.
    type = 'idLike';
  } else if (numericAll) {
    const zFmt = mostCommon(zs);
    if ((zFmt !== undefined && PERCENT_FMT_RE.test(zFmt)) || percentText > nNumText / 2) type = 'percent';
    else if ((zFmt !== undefined && CURRENCY_FMT_RE.test(zFmt)) || (nNumText > 0 && currencyText > nNumText / 2))
      type = 'currency';
    else type = allInteger ? 'integer' : 'decimal';
  } else type = 'text';

  const p: ColumnProfile = {
    i,
    header,
    type,
    rows: n,
    nonEmpty,
    emptyRate: n === 0 ? 0 : (n - nonEmpty) / n,
    distinctCount,
    distinctRatio,
    key: isKey,
    leadingZerosLost,
    israeliId,
    serialDates: false,
    numbersAsText: numericAll && nNumText > 0,
  };
  const shape = type === 'date' || type === 'boolean' || type === 'empty' ? undefined : shapeSignature(col);
  if (shape !== undefined) p.shape = shape;
  if (nonEmpty > 0 && (type === 'text' || type === 'idLike') && minLen !== Infinity) p.len = [minLen, maxLen];
  if (type === 'date' && minDate !== Infinity) p.range = [isoOfSerial(minDate), isoOfSerial(maxDate)];
  else if (numericAll && minNum !== Infinity && type !== 'idLike') p.range = [minNum, maxNum];
  if (type === 'date') {
    if (col.textDate !== null) {
      p.dateFormat = col.textDate.format;
      if (col.textDate.ambiguous) p.dayMonthAmbiguous = true;
    } else p.dateFormat = 'excel';
  }
  if (opts.output) {
    const z = mostCommon(zs);
    if (z !== undefined) p.format = z;
    if (opts.width !== undefined) p.width = opts.width;
  }
  return p;
}

function columnCountOf(table: ProfileTable): number {
  let n = 0;
  for (let c = table.headers.length - 1; c >= 0; c--) {
    if ((table.headers[c] ?? '').trim() !== '') {
      n = c + 1;
      break;
    }
  }
  if (n === 0) for (const r of table.rows) n = Math.max(n, r.length);
  return n;
}

/** Profiles every column of a table (SPEC 7.1). */
export function profileColumns(table: ProfileTable, opts: ProfileOptions = {}): ColumnProfile[] {
  const n = columnCountOf(table);
  const date1904 = table.date1904 === true;
  const out: ColumnProfile[] = [];
  for (let c = 0; c < n; c++) {
    const col = columnOfRows(table.rows, c, date1904);
    detectTextDates(col);
    const width = table.colWidths?.[c];
    out.push(
      profileColumn(col, c, table.headers[c] ?? '', (k) => table.rows[k]?.[c] ?? null, {
        ...opts,
        ...(width !== undefined ? { width } : {}),
      }),
    );
  }
  return out;
}

function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}

/**
 * The payload form of a profile (LEARN_PROMPT §3): stats keys only when
 * relevant. Headers and numbers are real; masking happens in the builder.
 */
export function toPayloadColumn(p: ColumnProfile): PayloadColumn {
  const stats: PayloadColumnStats = { empty: round3(p.emptyRate) };
  // DECISION: "values" (a count) when there are at most 20 distinct values, else the ratio.
  if (p.distinctCount <= 20) stats.values = p.distinctCount;
  else stats.distinct = round3(p.distinctRatio);
  if (p.len) stats.len = p.len;
  if (p.range) stats.range = p.range;
  // DECISION: only identifier-like columns carry `key` to the LLM: an all-distinct date or amount
  // column in one example is a coincidence, and `key` drives a `unique` check (LEARN_PROMPT step 11).
  if (p.key && (p.type === 'idLike' || p.type === 'text')) stats.key = true;
  if (p.leadingZerosLost) stats.leadingZerosLost = true;
  if (p.israeliId) stats.israeliId = true;
  if (p.serialDates) stats.serialDates = true;
  const col: PayloadColumn = { i: p.i, header: p.header, type: p.type, stats };
  if (p.shape !== undefined) col.shape = p.shape;
  if (p.format !== undefined) col.format = p.format;
  if (p.width !== undefined) col.width = p.width;
  return col;
}
