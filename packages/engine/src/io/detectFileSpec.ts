import type { OutputFileSpec, RawCell, RawSheet, RawWorkbook } from '../types';
import { decodeCsvBytes, detectCsvEncoding, detectDelimiter, type DetectedDelimiter } from './read';

/**
 * What sniffDelimitedText learns straight from the raw bytes of a delimited
 * text file, for information a RawWorkbook can't carry (we may not add
 * fields to types.ts here -- src/io is the only package in scope for this
 * change; see the top-level task notes).
 */
export interface DelimitedSniffResult {
  delimiter: DetectedDelimiter;
  encoding: 'utf-8' | 'utf-8-bom' | 'windows-1255';
  /** True when every non-empty field in the file's raw text was quoted. */
  allQuoted: boolean;
}

/**
 * Sniffs a csv/txt file's delimiter, encoding and whether every field was
 * quoted, directly from its bytes. Pass the result into detectFileSpec so it
 * can set `quote: 'all'` (RawWorkbook itself has no room to carry this).
 */
export function sniffDelimitedText(bytes: Uint8Array): DelimitedSniffResult {
  const encoding = detectCsvEncoding(bytes);
  const text = decodeCsvBytes(bytes, encoding);
  const delimiter = detectDelimiter(text);
  const allQuoted = computeAllQuoted(text, delimiter);
  return { delimiter, encoding, allQuoted };
}

/** Quote-tracking scan: true when every non-empty field was wrapped in quotes. */
function computeAllQuoted(text: string, delimiter: string): boolean {
  let sawNonEmpty = false;
  let allQuoted = true;
  let field = '';
  let quotedField = false;
  let inQuotes = false;
  let atFieldStart = true;
  let i = 0;
  const n = text.length;

  const endField = (): void => {
    if (field !== '') {
      sawNonEmpty = true;
      if (!quotedField) allQuoted = false;
    }
    field = '';
    quotedField = false;
    atFieldStart = true;
  };

  while (i < n) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }

    if (ch === '"' && atFieldStart) {
      inQuotes = true;
      quotedField = true;
      atFieldStart = false;
      i += 1;
      continue;
    }
    if (ch === delimiter) {
      endField();
      i += 1;
      continue;
    }
    if (ch === '\r') {
      endField();
      i += text[i + 1] === '\n' ? 2 : 1;
      continue;
    }
    if (ch === '\n') {
      endField();
      i += 1;
      continue;
    }
    field += ch;
    atFieldStart = false;
    i += 1;
  }
  endField();

  return sawNonEmpty && allQuoted;
}

function mapEncoding(e: 'utf-8' | 'utf-8-bom' | 'windows-1255'): NonNullable<OutputFileSpec['encoding']> {
  if (e === 'utf-8-bom') return 'utf8bom';
  if (e === 'windows-1255') return 'windows1255';
  return 'utf8';
}

type Token = 'empty' | 'number' | 'date' | 'text';

function cellText(cell: RawCell | null | undefined): string {
  if (!cell || cell.v === null) return '';
  return String(cell.v).trim();
}

function classifyToken(cell: RawCell | null | undefined): Token {
  const s = cellText(cell);
  if (s === '') return 'empty';
  if (/^-?\d+(\.\d+)?$/.test(s)) return 'number';
  if (/^\d{1,4}[/.-]\d{1,2}[/.-]\d{1,4}$/.test(s)) return 'date';
  return 'text';
}

/**
 * DECISION (SPEC 8.13 "header"): true when the first row is all non-empty,
 * distinct text AND either (a) at least one column below it is consistently
 * non-text (numbers/dates), catching the ordinary "Name, Amount, Date"
 * case, or (b) a column's data shape doesn't fit its header even though our
 * coarse number/date regex still calls it "text" -- e.g. a header word with
 * no digits sitting above a column of alphanumeric codes that all contain a
 * digit (order numbers, SKUs). Without either signal we can't tell a real
 * header from an ordinary all-text first data row, so we default to false:
 * a headerless system load file is the more surprising case to get wrong
 * silently (SPEC 8.13's whole point is that those are first-class outputs).
 */
function detectHeaderPresence(sheet: RawSheet): boolean {
  const rows = sheet.rows;
  if (rows.length < 2) return false;

  const first = rows[0] ?? [];
  const dataRows = rows.slice(1);
  const colCount = Math.max(first.length, ...dataRows.map((r) => r.length));
  if (colCount === 0) return false;

  const headerTexts: string[] = [];
  for (let c = 0; c < colCount; c++) {
    const cell = first[c] ?? null;
    if (classifyToken(cell) !== 'text') return false; // must be non-empty, non-numeric-looking text
    headerTexts.push(cellText(cell).toLowerCase());
  }
  if (new Set(headerTexts).size !== headerTexts.length) return false; // must be distinct

  let hasNonTextColumn = false;
  let shapeMismatch = false;
  for (let c = 0; c < colCount; c++) {
    const types = new Set<Token>();
    let allDataHaveDigit = true;
    let sawData = false;
    for (const row of dataRows) {
      const cell = row[c] ?? null;
      const t = classifyToken(cell);
      if (t === 'empty') continue;
      types.add(t);
      sawData = true;
      if (!/\d/.test(cellText(cell))) allDataHaveDigit = false;
    }
    if (types.size > 0 && !types.has('text')) hasNonTextColumn = true;
    const headerHasDigit = /\d/.test(headerTexts[c] ?? '');
    if (sawData && !headerHasDigit && allDataHaveDigit) shapeMismatch = true;
  }
  return hasNonTextColumn || shapeMismatch;
}

/**
 * Detects an `output.file` spec (SPEC 8.13) from an example output file
 * already read into a RawWorkbook. `sniff` (from sniffDelimitedText, run on
 * the file's original bytes) fills in `quote: 'all'`; without it, quote
 * defaults to 'minimal'. xlsx/xls always map to `{ type: 'xlsx' }` -- csv/txt
 * ignore styles, widths, bold and direction (SPEC 8.13), so nothing else is
 * detected for those file types.
 */
export function detectFileSpec(wb: RawWorkbook, sheetIndex = 0, sniff?: DelimitedSniffResult): OutputFileSpec {
  if (wb.fileType === 'xlsx' || wb.fileType === 'xls') {
    return { type: 'xlsx' };
  }

  const fileType = wb.fileType; // 'csv' | 'txt'
  const sheet = wb.sheets[sheetIndex];
  const delimiter = wb.delimiter ?? sniff?.delimiter ?? ',';
  const encodingKey = wb.encoding ?? sniff?.encoding ?? 'utf-8';
  const quote: NonNullable<OutputFileSpec['quote']> = sniff?.allQuoted ? 'all' : 'minimal';
  const header = sheet ? detectHeaderPresence(sheet) : true;

  return {
    type: fileType,
    delimiter,
    encoding: mapEncoding(encodingKey),
    quote,
    header,
  };
}
