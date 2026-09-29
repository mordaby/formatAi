// End-to-end golden-file tests (SPEC 18/19 M0): convertFile() run on real
// xlsx/csv bytes, the produced file read back (ExcelJS for xlsx -- formats,
// bold, merges and the RTL sheet view; plain text for csv), and compared cell
// by cell against a hand-derived expected.json. Every expected.json in
// test/golden/cases/<name>/ was worked out by hand from that case's rules.json
// and input file (see the comments in each rules.json / build-inputs.ts) --
// none of it was produced by running the engine.
//
// Also: for every case, converting the same input twice must produce
// byte-identical output (determinism, SPEC 2.1 / 18).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { RulesSchema } from '@formatai/shared';
import type { Rules } from '@formatai/shared';
import { convertFile } from '../../src/convert';
import { checkLimits, typeCheck } from '../../src/check';
import { checkFormatLock, formatOf } from '../../src/registry';
import { readWorkbook } from '../../src/io/read';
import type { Flag, OutputFileSpec, RunSummary } from '../../src/types';

const here = path.dirname(fileURLToPath(import.meta.url));
const casesDir = path.join(here, 'cases');

// ---------------------------------------------------------------------------
// expected.json shapes
// ---------------------------------------------------------------------------

interface DateSpec {
  date: { y: number; m: number; d: number };
  serial: number;
}
type CellSpec = string | number | boolean | null | DateSpec;

interface ExpectedColumn {
  header: string;
  width?: number;
  format?: string;
  numeric?: boolean;
}

interface ExpectedRow {
  kind: 'title' | 'blank' | 'header' | 'data' | 'subtotal' | 'grandTotal';
  bold?: boolean;
  sourceRow?: number;
  /**
   * One entry per output column. NOTE on merged rows (a title row spanning
   * every column): ExcelJS resolves every cell inside a merged range to the
   * master (top-left) cell's value/font/numFmt when reading a workbook back,
   * so `cells` for such a row repeats the title text across every merged
   * column rather than `null` -- that repetition is what `expected.json`
   * records, because it is what reading the produced file back actually
   * returns (verified against a small ExcelJS round-trip: a merged A1:E1
   * reads back as the same value/bold on every one of its columns).
   */
  cells: CellSpec[];
  /** 0-based cell indices that must be flagged (highlighted); all others must not be. */
  flaggedCols?: number[];
}

interface ExpectedBase {
  flags: Flag[];
  summary: RunSummary;
}

interface ExpectedXlsx extends ExpectedBase {
  outputType: 'xlsx';
  sheetName: string;
  direction: 'rtl' | 'ltr';
  columns: ExpectedColumn[];
  merges: string[];
  rows: ExpectedRow[];
}

interface ExpectedCsv extends ExpectedBase {
  // SPEC 21 v3 amendment: 'txt' added alongside 'csv' so the same shape covers
  // both delimited-text output.file types (8.13) -- old cases here are always
  // 'csv'; the new supplier-pricelist-to-erp-load case below is 'txt'.
  outputType: 'csv' | 'txt';
  lines: string[];
}

type Expected = ExpectedXlsx | ExpectedCsv;

function isDateSpec(c: CellSpec): c is DateSpec {
  return typeof c === 'object' && c !== null && 'date' in c;
}

// ---------------------------------------------------------------------------
// Fixture loading
// ---------------------------------------------------------------------------

function loadCase(name: string): { rules: Rules; expected: Expected; inputFile: string; bytes: Uint8Array } {
  const dir = path.join(casesDir, name);
  const rules = JSON.parse(fs.readFileSync(path.join(dir, 'rules.json'), 'utf-8')) as Rules;
  const expected = JSON.parse(fs.readFileSync(path.join(dir, 'expected.json'), 'utf-8')) as Expected;
  const inputFile = fs.existsSync(path.join(dir, 'input.xlsx')) ? 'input.xlsx' : 'input.csv';
  const bytes = new Uint8Array(fs.readFileSync(path.join(dir, inputFile)));
  return { rules, expected, inputFile, bytes };
}

const CASES = [
  'he-commissions-report',
  'en-rename-reorder',
  'dedupe-columns-to-rows',
  'split-cell-csv-out',
  'fixed-fan-out-debit-credit',
  'summary-by-agent',
  'win1255-csv-rename',
] as const;

// ---------------------------------------------------------------------------
// xlsx assertions
// ---------------------------------------------------------------------------

/** The numFmt an actual xlsx cell should carry, per writeXlsx.ts's own rule:
 * data rows fall back to the column format when the cell has none; subtotal/
 * grandTotal rows only carry a format on cells that were actually summed
 * (their other cells are never dressed with the column's format); header,
 * title and blank rows never carry a numFmt at all. */
function expectedNumFmt(row: ExpectedRow, colIdx: number, columns: ExpectedColumn[]): string | undefined {
  const fmt = columns[colIdx]?.format;
  if (fmt === undefined) return undefined;
  if (row.kind === 'data') return fmt;
  if (row.kind === 'subtotal' || row.kind === 'grandTotal') {
    return row.cells[colIdx] === null ? undefined : fmt;
  }
  return undefined;
}

async function assertXlsxOutput(bytes: Uint8Array, expected: ExpectedXlsx, label: string): Promise<void> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(bytes as unknown as ArrayBuffer);
  const ws = wb.worksheets[0];
  if (!ws) throw new Error(`${label}: no worksheet in output`);

  expect(ws.name, `${label}: sheet name`).toBe(expected.sheetName);
  expect(ws.views?.[0]?.rightToLeft ?? false, `${label}: rightToLeft view`).toBe(expected.direction === 'rtl');

  const actualMerges = [...((ws.model.merges as string[] | undefined) ?? [])].sort();
  expect(actualMerges, `${label}: merges`).toEqual([...expected.merges].sort());

  expected.columns.forEach((c, i) => {
    if (c.width !== undefined) {
      expect(ws.getColumn(i + 1).width, `${label}: column ${i} width`).toBeCloseTo(c.width, 5);
    }
  });

  expected.rows.forEach((row, rIdx) => {
    const excelRow = ws.getRow(rIdx + 1);
    const expectBold = row.bold === true;

    row.cells.forEach((spec, cIdx) => {
      const cell = excelRow.getCell(cIdx + 1);
      const where = `${label}: row ${rIdx} (${row.kind}) col ${cIdx}`;

      if (spec === null) {
        expect(cell.value, where).toBeNull();
      } else if (isDateSpec(spec)) {
        expect(cell.value, `${where} (expected a date)`).toBeInstanceOf(Date);
        const d = cell.value as Date;
        expect(
          [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()],
          `${where}: y/m/d`,
        ).toEqual([spec.date.y, spec.date.m, spec.date.d]);
      } else {
        expect(cell.value, where).toBe(spec);
      }

      expect(cell.numFmt, `${where}: numFmt`).toBe(expectedNumFmt(row, cIdx, expected.columns));
      expect(cell.font?.bold ?? false, `${where}: bold`).toBe(expectBold);

      const flagged = row.flaggedCols?.includes(cIdx) ?? false;
      const pattern = (cell.fill as ExcelJS.FillPattern | undefined)?.pattern;
      if (flagged) expect(pattern, `${where}: expected flagged fill`).toBe('solid');
      else expect(pattern, `${where}: expected no flagged fill`).not.toBe('solid');
    });
  });
}

// ---------------------------------------------------------------------------
// csv assertions
// ---------------------------------------------------------------------------

function assertCsvOutput(bytes: Uint8Array, expected: ExpectedCsv, label: string): void {
  expect(Array.from(bytes.subarray(0, 3)), `${label}: UTF-8 BOM`).toEqual([0xef, 0xbb, 0xbf]);
  const text = new TextDecoder('utf-8').decode(bytes);
  const expectedText = expected.lines.map((l) => `${l}\r\n`).join('');
  expect(text, `${label}: exact csv text (BOM-stripped, CRLF line endings)`).toBe(expectedText);
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

// None of these cases' rules.json declare `output.file` (M0 predates SPEC 8.13),
// so convertFile would default to xlsx for all of them; force csv here the same
// way `{ outputType: 'csv' }` used to, via convertFile's `file` override.
function convertOpts(expected: Expected): { file?: { type: 'csv' } } {
  return expected.outputType === 'csv' ? { file: { type: 'csv' } } : {};
}

describe.each(CASES)('golden case: %s', (name) => {
  it('matches the hand-derived expected output', async () => {
    const { rules, expected, inputFile, bytes } = loadCase(name);
    const result = await convertFile(rules, bytes, inputFile, convertOpts(expected));
    if (!result.ok) throw new Error(`convertFile failed: ${JSON.stringify(result.error)}`);

    expect(result.flags, `${name}: flags`).toEqual(expected.flags);
    expect(result.summary, `${name}: summary`).toEqual(expected.summary);

    if (expected.outputType === 'xlsx') {
      // kind/sourceRow are in-memory pipeline facts that never reach the file
      // itself; check them straight off the engine's own OutputSheet.
      expect(result.sheet.rows.map((r) => r.kind), `${name}: row kinds`).toEqual(
        expected.rows.map((r) => r.kind),
      );
      expected.rows.forEach((r, i) => {
        if (r.sourceRow !== undefined) {
          expect(result.sheet.rows[i]?.sourceRow, `${name}: row ${i} sourceRow`).toBe(r.sourceRow);
        }
      });
      await assertXlsxOutput(result.bytes, expected, name);
    } else {
      assertCsvOutput(result.bytes, expected, name);
    }
  });

  it('is deterministic: converting the same input twice is byte-identical', async () => {
    const { rules, expected, inputFile, bytes } = loadCase(name);
    const a = await convertFile(structuredClone(rules), bytes, inputFile, convertOpts(expected));
    const b = await convertFile(structuredClone(rules), bytes, inputFile, convertOpts(expected));
    if (!a.ok || !b.ok) throw new Error('convertFile failed');
    expect(a.bytes.length, `${name}: determinism (length)`).toBe(b.bytes.length);
    expect(Buffer.from(b.bytes), `${name}: determinism (bytes)`).toEqual(Buffer.from(a.bytes));
  });
});

// ---------------------------------------------------------------------------
// SPEC 21 v3 amendment cases: output.file variety (a txt load file with no
// header in Windows-1255, and a csv with a non-default encoding/quoting), a
// transform.functions entry shared by three columns, a transform.tables
// lookup with an unknown key, and a registry pair proving the format lock
// (SPEC 8.12). Same ground rules as the M0 cases above: every expected.json
// was worked out by hand from that case's rules.json and input file, never by
// running the engine. These cases additionally assert that their rules.json
// parses cleanly (RulesSchema), type-checks and limit-checks with no
// problems, and -- for the csv/txt outputs -- round-trips through
// readWorkbook.
// ---------------------------------------------------------------------------

interface ExpectedDelimitedV3 extends ExpectedBase {
  outputType: 'csv' | 'txt';
  lines: string[];
}

/**
 * Standalone reference encoder for Windows-1255 (ASCII plus the Hebrew
 * alphabet block U+05D0-U+05EA only, which is all this suite's fixtures ever
 * use), written independently of writeDelimited.ts's own encoder so the
 * byte-exact check below doesn't just compare the engine against itself.
 * Mirrors build-inputs.ts's own encodeWindows1255 helper (used there to build
 * *input* fixtures) for the *output* side.
 */
function referenceEncodeWindows1255(text: string): Uint8Array {
  const bytes: number[] = [];
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp < 0x80) {
      bytes.push(cp);
    } else if (cp >= 0x05d0 && cp <= 0x05ea) {
      bytes.push(0xe0 + (cp - 0x05d0));
    } else {
      throw new Error(`referenceEncodeWindows1255: unsupported character U+${cp.toString(16)}`);
    }
  }
  return new Uint8Array(bytes);
}

function decodeDelimitedBytes(
  bytes: Uint8Array,
  encoding: NonNullable<OutputFileSpec['encoding']>,
  label: string,
): string {
  const hasBom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  if (encoding === 'utf8bom') {
    expect(hasBom, `${label}: UTF-8 BOM`).toBe(true);
    return new TextDecoder('utf-8').decode(bytes.subarray(3));
  }
  expect(hasBom, `${label}: no BOM`).toBe(false);
  if (encoding === 'utf8') return new TextDecoder('utf-8').decode(bytes);
  return new TextDecoder('windows-1255').decode(bytes);
}

/** Byte-exact assertion for a csv/txt output whose `output.file` (SPEC 8.13) the
 * rules file declares itself (unlike the M0 cases above, no `convertOpts` override
 * is needed here: these rules already carry the file spec being tested). */
function assertDelimitedOutputV3(
  bytes: Uint8Array,
  expected: ExpectedDelimitedV3,
  file: OutputFileSpec,
  label: string,
): void {
  const encoding = file.encoding ?? 'utf8bom';
  const text = decodeDelimitedBytes(bytes, encoding, label);
  const expectedText = expected.lines.map((l) => `${l}\r\n`).join('');
  expect(text, `${label}: exact text (BOM-stripped, CRLF line endings)`).toBe(expectedText);

  if (encoding === 'windows1255') {
    expect(Buffer.from(bytes), `${label}: exact windows-1255 bytes`).toEqual(
      Buffer.from(referenceEncodeWindows1255(expectedText)),
    );
  }
}

const V3_XLSX_CASES = [
  'freight-carrier-a',
  'freight-carrier-b',
  'payroll-to-deposits-function',
  'bank-export-lookup',
] as const;

describe.each(V3_XLSX_CASES)('golden case (SPEC 21 v3 amendment): %s', (name) => {
  it('rules parse with RulesSchema, and type-check/limit-check cleanly', () => {
    const { rules } = loadCase(name);
    expect(() => RulesSchema.parse(rules), `${name}: RulesSchema`).not.toThrow();
    expect(typeCheck(rules), `${name}: typeCheck`).toEqual([]);
    expect(checkLimits(rules, 'paid'), `${name}: checkLimits`).toEqual([]);
  });

  it('matches the hand-derived expected output', async () => {
    const { rules, expected, inputFile, bytes } = loadCase(name);
    if (expected.outputType !== 'xlsx') throw new Error(`${name}: expected an xlsx case`);
    const result = await convertFile(rules, bytes, inputFile);
    if (!result.ok) throw new Error(`convertFile failed: ${JSON.stringify(result.error)}`);

    expect(result.flags, `${name}: flags`).toEqual(expected.flags);
    expect(result.summary, `${name}: summary`).toEqual(expected.summary);
    expect(result.sheet.rows.map((r) => r.kind), `${name}: row kinds`).toEqual(
      expected.rows.map((r) => r.kind),
    );
    expected.rows.forEach((r, i) => {
      if (r.sourceRow !== undefined) {
        expect(result.sheet.rows[i]?.sourceRow, `${name}: row ${i} sourceRow`).toBe(r.sourceRow);
      }
    });
    await assertXlsxOutput(result.bytes, expected, name);
  });

  it('is deterministic: converting the same input twice is byte-identical', async () => {
    const { rules, inputFile, bytes } = loadCase(name);
    const a = await convertFile(structuredClone(rules), bytes, inputFile);
    const b = await convertFile(structuredClone(rules), bytes, inputFile);
    if (!a.ok || !b.ok) throw new Error('convertFile failed');
    expect(a.bytes.length, `${name}: determinism (length)`).toBe(b.bytes.length);
    expect(Buffer.from(b.bytes), `${name}: determinism (bytes)`).toEqual(Buffer.from(a.bytes));
  });
});

const V3_DELIMITED_CASES = ['supplier-pricelist-to-erp-load', 'customer-export-to-crm-csv'] as const;

describe.each(V3_DELIMITED_CASES)('golden case (SPEC 21 v3 amendment): %s', (name) => {
  it('rules parse with RulesSchema, and type-check/limit-check cleanly', () => {
    const { rules } = loadCase(name);
    expect(() => RulesSchema.parse(rules), `${name}: RulesSchema`).not.toThrow();
    expect(typeCheck(rules), `${name}: typeCheck`).toEqual([]);
    expect(checkLimits(rules, 'paid'), `${name}: checkLimits`).toEqual([]);
  });

  it('matches the hand-derived expected output', async () => {
    const { rules, expected, inputFile, bytes } = loadCase(name);
    if (expected.outputType === 'xlsx') throw new Error(`${name}: expected a delimited case`);
    const result = await convertFile(rules, bytes, inputFile);
    if (!result.ok) throw new Error(`convertFile failed: ${JSON.stringify(result.error)}`);

    expect(result.flags, `${name}: flags`).toEqual(expected.flags);
    expect(result.summary, `${name}: summary`).toEqual(expected.summary);
    const file = rules.output.file;
    if (!file) throw new Error(`${name}: rules.output.file must be declared (SPEC 8.13)`);
    assertDelimitedOutputV3(result.bytes, expected as ExpectedDelimitedV3, file, name);
  });

  it('is deterministic: converting the same input twice is byte-identical', async () => {
    const { rules, inputFile, bytes } = loadCase(name);
    const a = await convertFile(structuredClone(rules), bytes, inputFile);
    const b = await convertFile(structuredClone(rules), bytes, inputFile);
    if (!a.ok || !b.ok) throw new Error('convertFile failed');
    expect(a.bytes.length, `${name}: determinism (length)`).toBe(b.bytes.length);
    expect(Buffer.from(b.bytes), `${name}: determinism (bytes)`).toEqual(Buffer.from(a.bytes));
  });
});

describe('golden case (SPEC 21 v3 amendment): csv/txt outputs round-trip through readWorkbook', () => {
  it('supplier-pricelist-to-erp-load: tab-delimited, no header, Windows-1255 values round-trip', async () => {
    const { rules, expected, inputFile, bytes } = loadCase('supplier-pricelist-to-erp-load');
    if (expected.outputType === 'xlsx') throw new Error('expected a delimited case');
    const result = await convertFile(rules, bytes, inputFile);
    if (!result.ok) throw new Error('convertFile failed');

    const wb = await readWorkbook(result.bytes, 'output.txt');
    expect(wb.delimiter, 'detected delimiter').toBe('\t');
    expect(wb.encoding, 'detected encoding').toBe('windows-1255');
    const actualFields = (wb.sheets[0]?.rows ?? []).map((row) => row.map((c) => c?.v ?? null));
    const expectedFields = expected.lines.map((l) => l.split('\t'));
    expect(actualFields).toEqual(expectedFields);
  });

  it('customer-export-to-crm-csv: comma-delimited, quoted, header values round-trip', async () => {
    const { rules, expected, inputFile, bytes } = loadCase('customer-export-to-crm-csv');
    if (expected.outputType === 'xlsx') throw new Error('expected a delimited case');
    const result = await convertFile(rules, bytes, inputFile);
    if (!result.ok) throw new Error('convertFile failed');

    const wb = await readWorkbook(result.bytes, 'output.csv');
    expect(wb.delimiter, 'detected delimiter').toBe(',');
    expect(wb.encoding, 'detected encoding').toBe('utf-8');
    const actualFields = (wb.sheets[0]?.rows ?? []).map((row) => row.map((c) => c?.v ?? null));
    // Every field is individually quoted (quote: "all") and none of this
    // case's data contains a comma or a quote character, so stripping the
    // outer quotes and splitting on `","` recovers the raw written values
    // without needing a full RFC-4180 parser here.
    const expectedFields = expected.lines.map((l) => l.slice(1, -1).split('","'));
    expect(actualFields).toEqual(expectedFields);
  });
});

describe('registry pair (SPEC 8.12): freight-carrier-a / freight-carrier-b share one format', () => {
  const { rules: rulesA } = loadCase('freight-carrier-a');
  const { rules: rulesB } = loadCase('freight-carrier-b');
  const format = formatOf(rulesA);

  // Both conversions matching their own hand-derived expected output is
  // already asserted by the V3_XLSX_CASES loop above; these tests cover the
  // registry-specific relationship between the two rules files instead.

  it("carrier B's rules reproduce carrier A's format: checkFormatLock finds no problems", () => {
    expect(checkFormatLock(rulesB, format)).toEqual([]);
  });

  it('a deliberately altered copy of carrier B breaks the lock: a formatMismatch problem', () => {
    const altered = structuredClone(rulesB);
    const costColumn = altered.output.columns[3];
    if (!costColumn || costColumn.header !== 'Cost') {
      throw new Error('expected output.columns[3] to be the shared "Cost" column');
    }
    costColumn.header = 'Total Cost Adjusted';

    const problems = checkFormatLock(altered, format);
    expect(problems).toContainEqual(
      expect.objectContaining({ kind: 'formatMismatch', path: 'output.columns[3].header' }),
    );
  });
});
