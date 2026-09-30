// In-memory workbooks for the pair-analysis tests. Synthetic, domain-neutral data.
import Decimal from 'decimal.js';
import { expect } from 'vitest';
import { analyzePair } from '../../../src/learn/analyze';
import type { AnalyzeOptions, PairAnalysis, Relation } from '../../../src/learn/analyze';
import { mulberry32 } from '../../../src/learn/analyze/prng';
import type { RawCell, RawSheet, RawWorkbook } from '../../../src/types';
import { ymdToSerial } from '../../../src/values/dates';

export type V = string | number | boolean | null | RawCell;

export function cell(v: V): RawCell | null {
  if (v === null) return null;
  if (typeof v === 'object') return v;
  return { v };
}

export interface SheetOpts {
  name?: string;
  rtl?: boolean;
  widths?: (number | undefined)[];
}

export function sheet(rows: V[][], opts: SheetOpts = {}): RawSheet {
  const s: RawSheet = {
    name: opts.name ?? 'Sheet1',
    rows: rows.map((r) => r.map(cell)),
    merges: [],
    hiddenRows: [],
    hiddenCols: [],
    colWidths: opts.widths ?? [],
  };
  if (opts.rtl !== undefined) s.rightToLeft = opts.rtl;
  return s;
}

export function xlsx(rows: V[][], opts: SheetOpts = {}): RawWorkbook {
  return { fileType: 'xlsx', sheets: [sheet(rows, opts)] };
}

/** A delimited-text workbook as readWorkbook would give it: every cell a string. */
export function delimited(rows: V[][], type: 'csv' | 'txt', delimiter: ',' | '\t' = type === 'txt' ? '\t' : ','): RawWorkbook {
  const text = (v: V): string => (v === null ? '' : typeof v === 'object' ? String(v.v ?? '') : String(v));
  const s = sheet(rows.map((r) => r.map(text)), { name: 'out' });
  return { fileType: type, sheets: [s], encoding: 'utf-8', delimiter };
}

/** A real date cell (Excel serial with a date format). */
export function date(y: number, m: number, d: number, z = 'dd/mm/yyyy'): RawCell {
  return { v: ymdToSerial({ y, m, d }), isDate: true, z };
}

export function serial(y: number, m: number, d: number): number {
  return ymdToSerial({ y, m, d });
}

export function num(v: number, z: string): RawCell {
  return { v, z };
}

export function bold(v: string | number): RawCell {
  return { v, bold: true };
}

export function rng(seed: number): () => number {
  return mulberry32(seed);
}

export function pick<T>(r: () => number, xs: readonly T[]): T {
  return xs[Math.floor(r() * xs.length)]!;
}

export function analyzeOk(input: RawWorkbook, output: RawWorkbook, opts: AnalyzeOptions = {}): PairAnalysis {
  const a = analyzePair(input, output, opts);
  if (!a.ok) throw new Error(`analysis failed: ${JSON.stringify(a.issues)}`);
  return a;
}

/** The best relation of an output column. */
export function best(a: PairAnalysis, out: number): Relation {
  const rel = a.columns[out]?.relations[0];
  expect(rel, `no relation for output column ${out}`).toBeDefined();
  return rel!;
}

/** A relation of a given kind for an output column (any rank). */
export function findRel<K extends Relation['rel']>(a: PairAnalysis, out: number, kind: K): Extract<Relation, { rel: K }> | undefined {
  return a.columns[out]?.relations.find((r): r is Extract<Relation, { rel: K }> => r.rel === kind);
}

/** Excel ROUND (half away from zero, exact decimal). */
export function xround(x: number, digits: number): number {
  return new Decimal(String(x)).toDecimalPlaces(digits, Decimal.ROUND_HALF_UP).toNumber();
}

/** Exact decimal arithmetic for expected values. */
export function dec(x: number): Decimal {
  return new Decimal(String(x));
}
