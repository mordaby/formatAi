import Decimal from 'decimal.js';
import type { OutCell, OutputColumn, OutputSheet } from '../types';

const INJECTION_PREFIX_RE = /^[=+\-@]/;

function numberToPlainString(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  // DECISION: route through decimal.js so large/small magnitudes never render
  // in exponential notation (spreadsheets never show "1e+21").
  return new Decimal(n).toFixed();
}

function cellRawText(cell: OutCell): string {
  if (cell.text !== undefined) return cell.text;
  const v = cell.v;
  if (v === null) return '';
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (typeof v === 'number') return numberToPlainString(v);
  return v;
}

function csvQuote(text: string): string {
  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function csvField(cell: OutCell, column: OutputColumn | undefined): string {
  let text = cellRawText(cell);

  // Formula-injection guard (SPEC 15): a text cell starting with = + - @ gets a
  // leading apostrophe, unless the column is numeric or the value is itself a
  // number (a genuinely numeric value can't carry a formula).
  const isNumberValue = typeof cell.v === 'number';
  const columnIsNumeric = column?.numeric === true;
  if (!isNumberValue && !columnIsNumeric && INJECTION_PREFIX_RE.test(text)) {
    text = `'${text}`;
  }

  return csvQuote(text);
}

/** Writes an OutputSheet as UTF-8-with-BOM CSV, CRLF line endings, RFC-4180 quoting. */
export function writeCsv(sheet: OutputSheet): Uint8Array {
  const lines = sheet.rows.map((row) =>
    row.cells.map((cell, i) => csvField(cell, sheet.columns[i])).join(',')
  );
  const body = lines.map((line) => `${line}\r\n`).join('');
  return new TextEncoder().encode(`﻿${body}`);
}
