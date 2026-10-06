// The stress test's input files: generated cells (`data.ts`) written as xlsx (through the engine's own writer, like every eval fixture -
// `cases/lib/fixtures.ts`), or as csv / txt by a small writer of its own, so a delimited input can hold exactly what a messy export holds:
// a cell that starts with "=" (the engine's writer would guard it), a title line, a BOM or none, Windows-1255 bytes.
import { ymdToSerial } from '@formatai/engine';
import { writeFixture, type Cell, type RowSpec } from '../cases/lib/fixtures';
import { formatDateText, type GenCell } from './data';

export interface FileArtifact {
  /** File name with extension ("input.xlsx"). */
  name: string;
  bytes: Uint8Array;
}

export interface InputLayout {
  fileType: 'xlsx' | 'csv' | 'txt';
  /** csv / txt only. */
  delimiter: ',' | ';' | '\t' | '|';
  encoding: 'utf8' | 'utf8bom' | 'windows1255';
  /** csv / txt: quote every field (some exports do). */
  quoteAll: boolean;
  /** Title lines above the header ("" = a blank line). */
  titleRows: string[];
  /** xlsx: merge the first title across the columns. */
  mergeTitle: boolean;
  /** A totals row under the data: `totalsLabel` in the first cell, the sums of the number columns. */
  totalsRow: boolean;
  totalsLabel: string;
  /** Share of exact duplicate rows inserted. */
  dupRate: number;
  direction: 'rtl' | 'ltr';
  sheetName: string;
  headerBold: boolean;
}

/** The text a delimited file holds for a generated cell (a real date in the day-first form a delimited export writes). */
export function delimitedText(c: GenCell): string {
  if (c === null) return '';
  if ('s' in c) return c.s;
  if ('n' in c) return String(c.n);
  return formatDateText(c.d, 'DD/MM/YYYY');
}

function xlsxCell(c: GenCell): Cell {
  if (c === null) return null;
  if ('s' in c) return c.s;
  if ('n' in c) return c.z !== undefined ? { v: c.n, z: c.z } : c.n;
  return { v: ymdToSerial(c.d), z: c.z, isDate: true };
}

// ---- Windows-1255: the Hebrew letters, the shekel sign, NBSP and the direction marks; anything else cannot be written ----
function win1255Byte(cp: number): number | undefined {
  if (cp < 0x80) return cp;
  if (cp >= 0x05d0 && cp <= 0x05ea) return 0xe0 + (cp - 0x05d0);
  const special: Record<number, number> = { 0x20aa: 0xa4, 0x00a0: 0xa0, 0x200e: 0xfd, 0x200f: 0xfe, 0x20ac: 0x80, 0x05f3: 0xd7, 0x05f4: 0xd8 };
  return special[cp];
}

export function encodableIn1255(s: string): boolean {
  for (const ch of s) if (win1255Byte(ch.codePointAt(0)!) === undefined) return false;
  return true;
}

function encode1255(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  let i = 0;
  for (const ch of s) out[i++] = win1255Byte(ch.codePointAt(0)!)!;
  return out.subarray(0, i);
}

function quoteField(text: string, delimiter: string, all: boolean): string {
  if (all || text.includes(delimiter) || text.includes('"') || /[\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

/** Writes the input file: titles, header, data rows (and the totals row, already in `rows` when the layout has one). */
export async function writeInput(layout: InputLayout, headers: string[], rows: GenCell[][], name = 'input'): Promise<FileArtifact> {
  if (layout.fileType === 'xlsx') {
    const width = headers.length;
    const titleSpecs: RowSpec[] = layout.titleRows.map((t) => ({ cells: [t === '' ? null : t, ...Array.from({ length: width - 1 }, () => null)], bold: t !== '' }));
    const spec = {
      name: layout.sheetName,
      direction: layout.direction,
      language: layout.direction === 'rtl' ? ('he' as const) : ('en' as const),
      rows: [...titleSpecs, { cells: headers, ...(layout.headerBold ? { bold: true } : {}) }, ...rows.map((r) => ({ cells: r.map(xlsxCell) }))],
      merges: layout.mergeTitle && layout.titleRows.length > 0 && layout.titleRows[0] !== '' && width > 1 ? [{ s: { r: 0, c: 0 }, e: { r: 0, c: width - 1 } }] : [],
    };
    return { name: `${name}.xlsx`, bytes: await writeFixture(spec) };
  }
  const d = layout.delimiter;
  const lines: string[] = [];
  for (const t of layout.titleRows) lines.push(t === '' ? '' : quoteField(t, d, layout.quoteAll));
  lines.push(headers.map((h) => quoteField(h, d, layout.quoteAll)).join(d));
  for (const r of rows) lines.push(r.map((c) => quoteField(delimitedText(c), d, layout.quoteAll)).join(d));
  const text = `${lines.join('\r\n')}\r\n`;
  let bytes: Uint8Array;
  if (layout.encoding === 'windows1255') bytes = encode1255(text);
  else {
    const utf8 = new TextEncoder().encode(text);
    if (layout.encoding === 'utf8bom') {
      bytes = new Uint8Array(utf8.length + 3);
      bytes.set([0xef, 0xbb, 0xbf], 0);
      bytes.set(utf8, 3);
    } else bytes = utf8;
  }
  return { name: `${name}.${layout.fileType}`, bytes };
}
