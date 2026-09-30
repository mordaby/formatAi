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
 * How sure detectFileSpec is about `header`:
 *  - 'evidence': decided from the types of the first row and of the rows below
 *    it (a number or date in the first row, a consistently numeric or date
 *    column below a text first row, a header word above a column of codes);
 *  - 'ambiguous': the first row is distinct text and nothing below it has a
 *    type that tells a header from an ordinary first data row (e.g. every
 *    column is text). `header` then only holds the default; pair analysis
 *    resolves it against the input (see learn/analyze/headerCheck.ts).
 */
export type HeaderConfidence = 'evidence' | 'ambiguous';

export interface DetectedFileSpec {
  spec: OutputFileSpec;
  /** How `spec.header` was decided. Always 'evidence' for xlsx/xls (no header notion). */
  headerConfidence: HeaderConfidence;
}

interface HeaderDetection {
  header: boolean;
  confidence: HeaderConfidence;
}

/**
 * DECISION (SPEC 8.13 "header"): true when the first row is all non-empty,
 * distinct text AND either (a) at least one column below it is consistently
 * non-text (numbers/dates), catching the ordinary "Name, Amount, Date"
 * case, or (b) a column's data shape doesn't fit its header even though our
 * coarse number/date regex still calls it "text" -- e.g. a header word with
 * no digits sitting above a column of alphanumeric codes that all contain a
 * digit (order numbers, SKUs). Those are 'evidence' answers, and so is a
 * first row that is not all distinct text (empty, numeric or repeated cells:
 * it reads as data).
 *
 * DECISION: when the first row is distinct text and NOTHING below it gives
 * type evidence either way (typically a csv where every column is text, e.g.
 * a CRM import with renamed headers), the answer is 'ambiguous' and the
 * default is header: true. Most exports have a header row; counting it as data
 * inflates the row count (and can hit a tier's row limit) and feeds a header
 * to pair analysis as if it were a record. A headerless all-text load file is
 * still first-class (SPEC 8.13): pair analysis tells them apart by testing
 * whether the first row is explained as a data row of the example pair.
 */
function detectHeaderPresence(sheet: RawSheet): HeaderDetection {
  const evidence = (header: boolean): HeaderDetection => ({ header, confidence: 'evidence' });
  const rows = sheet.rows;
  if (rows.length < 2) return evidence(false);

  const first = rows[0] ?? [];
  const dataRows = rows.slice(1);
  const colCount = Math.max(first.length, ...dataRows.map((r) => r.length));
  if (colCount === 0) return evidence(false);

  const headerTexts: string[] = [];
  for (let c = 0; c < colCount; c++) {
    const cell = first[c] ?? null;
    if (classifyToken(cell) !== 'text') return evidence(false); // must be non-empty, non-numeric-looking text
    headerTexts.push(cellText(cell).toLowerCase());
  }
  if (new Set(headerTexts).size !== headerTexts.length) return evidence(false); // must be distinct

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
  if (hasNonTextColumn || shapeMismatch) return evidence(true);
  // DECISION: no type evidence either way -> ambiguous, default header: true.
  return { header: true, confidence: 'ambiguous' };
}

/**
 * Detects an `output.file` spec (SPEC 8.13) from an example output file
 * already read into a RawWorkbook. `sniff` (from sniffDelimitedText, run on
 * the file's original bytes) fills in `quote: 'all'`; without it, quote
 * defaults to 'minimal'. xlsx/xls always map to `{ type: 'xlsx' }` -- csv/txt
 * ignore styles, widths, bold and direction (SPEC 8.13), so nothing else is
 * detected for those file types.
 *
 * For a csv/txt whose columns are all text, `header` is only the default
 * (true); use detectFileSpecWithConfidence to tell that apart from a header
 * decided by type evidence.
 */
export function detectFileSpec(wb: RawWorkbook, sheetIndex = 0, sniff?: DelimitedSniffResult): OutputFileSpec {
  return detectFileSpecWithConfidence(wb, sheetIndex, sniff).spec;
}

/**
 * Same as detectFileSpec, plus how sure the `header` answer is
 * ('ambiguous' = all-text columns, default header: true). Kept separate so the
 * public OutputFileSpec shape doesn't change.
 */
export function detectFileSpecWithConfidence(wb: RawWorkbook, sheetIndex = 0, sniff?: DelimitedSniffResult): DetectedFileSpec {
  if (wb.fileType === 'xlsx' || wb.fileType === 'xls') {
    return { spec: { type: 'xlsx' }, headerConfidence: 'evidence' };
  }

  const fileType = wb.fileType; // 'csv' | 'txt'
  const sheet = wb.sheets[sheetIndex];
  const delimiter = wb.delimiter ?? sniff?.delimiter ?? ',';
  const encodingKey = wb.encoding ?? sniff?.encoding ?? 'utf-8';
  const quote: NonNullable<OutputFileSpec['quote']> = sniff?.allQuoted ? 'all' : 'minimal';
  const detection: HeaderDetection = sheet ? detectHeaderPresence(sheet) : { header: true, confidence: 'evidence' };

  return {
    spec: {
      type: fileType,
      delimiter,
      encoding: mapEncoding(encodingKey),
      quote,
      header: detection.header,
    },
    headerConfidence: detection.confidence,
  };
}
