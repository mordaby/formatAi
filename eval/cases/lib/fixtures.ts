// Builds the raw xlsx/csv/txt bytes for eval fixtures (both "input" files and,
// for the two cases the engine's rules language genuinely cannot produce -
// pivot, external-data column - the hand-built "output" files too).
//
// DECISION: rather than adding a direct dependency on exceljs/xlsx to the
// `@formatai/eval` package (which would need `pnpm add`, out of scope for this
// task), every fixture here is built by constructing an engine `OutputSheet`
// (packages/engine/src/types.ts) and handing it to the engine's own
// `writeOutput`/`writeXlsx`/`writeDelimited` (already a dependency via
// `@formatai/engine`). Those writers don't care whether the sheet they're
// asked to write represents a "real" conversion result or a synthetic fixture -
// they just turn an OutputSheet into bytes - so this gives byte-valid,
// engine-readable xlsx/csv/txt files without reaching into another package's
// node_modules. `OutRow.kind` only affects `writeXlsx`'s own numFmt fallback
// (SPEC 8.13's cell.z ?? column.format, data rows only) and writeDelimited's
// header-row filtering; since fixtures here always set `z` explicitly per cell
// and never declare column-level formats, every row is written as kind 'data'
// uniformly - the distinction plays no role in what bytes come out.
import type { OutCell, OutputFileSpec, OutputSheet } from '@formatai/engine';
import { writeOutput, ymdToSerial } from '@formatai/engine';

/** One cell's contents. A bare primitive becomes `{ v: primitive }`; the object
 * form adds a number format (`z`), marks a date (`isDate`, `v` must then be an
 * Excel serial - see `dateCell`), or bolds the cell. */
export type Cell =
  | string
  | number
  | boolean
  | null
  | { v: string | number | boolean | null; z?: string; isDate?: boolean; bold?: boolean };

export interface RowSpec {
  cells: Cell[];
  /** Bolds every cell in the row that doesn't set its own `bold`. */
  bold?: boolean;
}

export interface SheetSpec {
  /** Sheet/tab name (xlsx) or the name used to derive it for csv/txt fixtures. */
  name: string;
  direction?: 'rtl' | 'ltr';
  language?: 'he' | 'en';
  /** Absent -> xlsx (SPEC 8.13's own default). */
  file?: OutputFileSpec;
  rows: RowSpec[];
}

function toOutCell(c: Cell): OutCell {
  if (c === null || typeof c !== 'object') return { v: c };
  const cell: OutCell = { v: c.v };
  if (c.z !== undefined) cell.z = c.z;
  if (c.isDate === true) cell.isDate = true;
  if (c.bold === true) cell.bold = true;
  return cell;
}

/** Builds the engine's neutral `OutputSheet` shape from a `SheetSpec`. Exported
 * mainly so `build.ts` can inspect the shape in a test/debug context; callers
 * normally just want `writeFixture`. */
export function buildOutputSheet(spec: SheetSpec): OutputSheet {
  return {
    name: spec.name,
    ...(spec.file !== undefined ? { file: spec.file } : {}),
    direction: spec.direction ?? 'ltr',
    language: spec.language ?? 'en',
    columns: [],
    rows: spec.rows.map((r) => ({
      kind: 'data',
      cells: r.cells.map(toOutCell),
      ...(r.bold === true ? { bold: true } : {}),
    })),
    merges: [],
  };
}

/** Renders a `SheetSpec` to file bytes via the engine's own writer (xlsx/csv/txt,
 * dispatched by `spec.file`, exactly like a real conversion's output - SPEC 8.13). */
export async function writeFixture(spec: SheetSpec): Promise<Uint8Array> {
  return writeOutput(buildOutputSheet(spec));
}

/** A native Excel date cell: `serial` + a date-shaped number format, so
 * `readWorkbook` reports `isDate: true` on read-back (SPEC 17's "Excel serial
 * numbers vs text dates" distinction) - mirrors the golden fixtures' own
 * `dateCell` helper (packages/engine/test/golden/build-inputs.ts). */
export function dateCell(y: number, m: number, d: number, fmt = 'dd/mm/yyyy'): Cell {
  return { v: ymdToSerial({ y, m, d }), z: fmt, isDate: true };
}

/** Formats y/m/d as `DD/MM/YYYY` text (for fixtures that store dates as plain
 * text, e.g. the bank-export DD/MM-vs-MM/DD trap - SPEC 17). */
export function ddmmyyyy(y: number, m: number, d: number): string {
  const p2 = (n: number): string => String(n).padStart(2, '0');
  return `${p2(d)}/${p2(m)}/${y}`;
}

/** Zero-pads a numeric id to `len` digits (for building idLike fixture values by
 * hand, distinct from the engine's own `padLeft` rule under test). */
export function padNum(n: number, len: number): string {
  return String(n).padStart(len, '0');
}
