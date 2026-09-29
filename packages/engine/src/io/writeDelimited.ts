import Decimal from 'decimal.js';
import type { OutCell, OutputColumn, OutputFileSpec, OutputSheet } from '../types';

const INJECTION_PREFIX_RE = /^[=+\-@]/;

export type DelimitedWriteErrorCode = 'unquotableValue' | 'unencodable';

export type DelimitedWriteErrorDetails =
  | { code: 'unquotableValue'; row: number; col: number }
  | { code: 'unencodable'; row: number; col: number; char: string };

/**
 * Thrown by writeDelimited instead of silently altering data (SPEC: never
 * silently alter data). `row`/`col` are 0-based indices into the rows/cells
 * actually written (after `header: false` has removed header rows, if any).
 */
export class DelimitedWriteError extends Error {
  readonly code: DelimitedWriteErrorCode;
  readonly row: number;
  readonly col: number;
  readonly char?: string;

  constructor(details: DelimitedWriteErrorDetails) {
    super(
      details.code === 'unquotableValue'
        ? `Value at row ${details.row}, col ${details.col} contains the delimiter or a line break and quote mode is "none"`
        : `Character "${details.char}" at row ${details.row}, col ${details.col} has no Windows-1255 byte`
    );
    this.name = 'DelimitedWriteError';
    this.code = details.code;
    this.row = details.row;
    this.col = details.col;
    if (details.code === 'unencodable') this.char = details.char;
  }
}

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

/**
 * Formula-injection guard (SPEC 15), shared by csv and txt: a text cell
 * starting with = + - @ gets a leading apostrophe, unless the column is
 * numeric or the value is itself a number (a genuinely numeric value can't
 * carry a formula).
 */
function applyInjectionGuard(text: string, cell: OutCell, column: OutputColumn | undefined): string {
  const isNumberValue = typeof cell.v === 'number';
  const columnIsNumeric = column?.numeric === true;
  if (!isNumberValue && !columnIsNumeric && INJECTION_PREFIX_RE.test(text)) {
    return `'${text}`;
  }
  return text;
}

// DECISION (quote: "minimal"): quote a field when it contains the delimiter,
// a double quote, a CR or LF, or leading/trailing whitespace. The whitespace
// case isn't strictly required by RFC 4180, but many spreadsheet/ERP readers
// trim unquoted fields on import, which would silently eat meaningful
// leading/trailing spaces -- quoting protects them.
function needsQuoteMinimal(text: string, delimiter: string): boolean {
  if (text.length === 0) return false;
  if (text.includes(delimiter)) return true;
  if (text.includes('"')) return true;
  if (/[\r\n]/.test(text)) return true;
  if (text[0] === ' ' || text[text.length - 1] === ' ') return true;
  return false;
}

type QuoteMode = NonNullable<OutputFileSpec['quote']>;

function quoteField(text: string, delimiter: string, quoteMode: QuoteMode, row: number, col: number): string {
  if (quoteMode === 'none') {
    if (text.includes(delimiter) || /[\r\n]/.test(text)) {
      throw new DelimitedWriteError({ code: 'unquotableValue', row, col });
    }
    return text;
  }
  const needsQuote = quoteMode === 'all' || needsQuoteMinimal(text, delimiter);
  if (!needsQuote) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

function buildField(
  cell: OutCell,
  column: OutputColumn | undefined,
  delimiter: string,
  quoteMode: QuoteMode,
  row: number,
  col: number
): string {
  const raw = cellRawText(cell);
  const guarded = applyInjectionGuard(raw, cell, column);
  return quoteField(guarded, delimiter, quoteMode, row, col);
}

// ---------- Windows-1255 (Hebrew) encoding ----------
//
// DECISION: implemented as a built-in 128-entry table instead of pulling in
// iconv-lite. The engine has to run unchanged in a browser Web Worker (SPEC:
// no DOM / Node-only APIs); iconv-lite's encode/decode path allocates Node
// `Buffer`s internally, which don't exist in that environment without a
// bundler-supplied polyfill (see writeXlsx.ts's own note about ExcelJS for
// the same class of problem). Windows-1255 is ASCII-compatible for bytes
// 0x00-0x7F, so only the upper 128 byte values (0x80-0xFF) need a mapping
// table; `null` marks a byte the code page leaves unassigned.
// Source: the Unicode Consortium's CP1255.TXT "best fit" mapping.
const WINDOWS_1255_UPPER: readonly (number | null)[] = [
  /* 0x80 */ 0x20ac, null, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021,
  /* 0x88 */ 0x02c6, 0x2030, null, 0x2039, null, null, null, null,
  /* 0x90 */ null, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014,
  /* 0x98 */ 0x02dc, 0x2122, null, 0x203a, null, null, null, null,
  /* 0xa0 */ 0x00a0, 0x00a1, 0x00a2, 0x00a3, 0x20aa, 0x00a5, 0x00a6, 0x00a7,
  /* 0xa8 */ 0x00a8, 0x00a9, 0x00d7, 0x00ab, 0x00ac, 0x00ad, 0x00ae, 0x00af,
  /* 0xb0 */ 0x00b0, 0x00b1, 0x00b2, 0x00b3, 0x00b4, 0x00b5, 0x00b6, 0x00b7,
  /* 0xb8 */ 0x00b8, 0x00b9, 0x00f7, 0x00bb, 0x00bc, 0x00bd, 0x00be, 0x00bf,
  /* 0xc0 */ 0x05b0, 0x05b1, 0x05b2, 0x05b3, 0x05b4, 0x05b5, 0x05b6, 0x05b7,
  /* 0xc8 */ 0x05b8, 0x05b9, null, 0x05bb, 0x05bc, 0x05bd, 0x05be, 0x05bf,
  /* 0xd0 */ 0x05c0, 0x05c1, 0x05c2, 0x05c3, 0x05f0, 0x05f1, 0x05f2, 0x05f3,
  /* 0xd8 */ 0x05f4, null, null, null, null, null, null, null,
  /* 0xe0 */ 0x05d0, 0x05d1, 0x05d2, 0x05d3, 0x05d4, 0x05d5, 0x05d6, 0x05d7,
  /* 0xe8 */ 0x05d8, 0x05d9, 0x05da, 0x05db, 0x05dc, 0x05dd, 0x05de, 0x05df,
  /* 0xf0 */ 0x05e0, 0x05e1, 0x05e2, 0x05e3, 0x05e4, 0x05e5, 0x05e6, 0x05e7,
  /* 0xf8 */ 0x05e8, 0x05e9, 0x05ea, null, null, 0x200e, 0x200f, null,
];

const WINDOWS_1255_ENCODE_MAP: ReadonlyMap<number, number> = (() => {
  const m = new Map<number, number>();
  WINDOWS_1255_UPPER.forEach((codePoint, i) => {
    if (codePoint !== null) m.set(codePoint, 0x80 + i);
  });
  return m;
})();

function encodeWindows1255Field(text: string, row: number, col: number): number[] {
  const bytes: number[] = [];
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp < 0x80) {
      bytes.push(cp);
      continue;
    }
    const byte = WINDOWS_1255_ENCODE_MAP.get(cp);
    if (byte === undefined) {
      throw new DelimitedWriteError({ code: 'unencodable', row, col, char: ch });
    }
    bytes.push(byte);
  }
  return bytes;
}

function encodeWindows1255Document(fields: string[][], delimiter: string): Uint8Array {
  const delimiterByte = delimiter.charCodeAt(0);
  const bytes: number[] = [];
  fields.forEach((rowFields, rIdx) => {
    rowFields.forEach((field, cIdx) => {
      if (cIdx > 0) bytes.push(delimiterByte);
      bytes.push(...encodeWindows1255Field(field, rIdx, cIdx));
    });
    bytes.push(0x0d, 0x0a);
  });
  return new Uint8Array(bytes);
}

// ---------- writer ----------

/**
 * Writes an OutputSheet as delimited text (csv or txt) per SPEC 8.13.
 * Defaults: csv delimiter ',', txt '\t'; header true; encoding 'utf8bom';
 * quote 'minimal'; CRLF line endings.
 *
 * DECISION (CRLF): matches Excel/Windows ERP load-file conventions and the
 * engine's existing csv output; kept for both csv and txt.
 */
export function writeDelimited(sheet: OutputSheet, spec: OutputFileSpec): Uint8Array {
  const delimiter = spec.delimiter ?? (spec.type === 'txt' ? '\t' : ',');
  const header = spec.header ?? true;
  const quoteMode: QuoteMode = spec.quote ?? 'minimal';
  const encoding = spec.encoding ?? 'utf8bom';

  // header:false -> header-kind rows are dropped entirely; title/blank/subtotal/
  // grandTotal rows are written as ordinary rows, cells in column position (SPEC 8.13).
  const rows = header ? sheet.rows : sheet.rows.filter((r) => r.kind !== 'header');

  const fields: string[][] = rows.map((row, rIdx) =>
    row.cells.map((cell, cIdx) => buildField(cell, sheet.columns[cIdx], delimiter, quoteMode, rIdx, cIdx))
  );

  if (encoding === 'windows1255') {
    return encodeWindows1255Document(fields, delimiter);
  }

  const body = fields.map((rowFields) => `${rowFields.join(delimiter)}\r\n`).join('');
  const utf8 = new TextEncoder().encode(body);
  if (encoding === 'utf8bom') {
    const out = new Uint8Array(3 + utf8.length);
    out.set([0xef, 0xbb, 0xbf], 0);
    out.set(utf8, 3);
    return out;
  }
  return utf8;
}
