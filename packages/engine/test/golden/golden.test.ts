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
import type { Rules } from '@formatai/shared';
import { convertFile } from '../../src/convert';
import type { Flag, RunSummary } from '../../src/types';

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
  outputType: 'csv';
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

describe.each(CASES)('golden case: %s', (name) => {
  it('matches the hand-derived expected output', async () => {
    const { rules, expected, inputFile, bytes } = loadCase(name);
    const result = await convertFile(rules, bytes, inputFile, { outputType: expected.outputType });
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
    const a = await convertFile(structuredClone(rules), bytes, inputFile, { outputType: expected.outputType });
    const b = await convertFile(structuredClone(rules), bytes, inputFile, { outputType: expected.outputType });
    if (!a.ok || !b.ok) throw new Error('convertFile failed');
    expect(a.bytes.length, `${name}: determinism (length)`).toBe(b.bytes.length);
    expect(Buffer.from(b.bytes), `${name}: determinism (bytes)`).toEqual(Buffer.from(a.bytes));
  });
});
