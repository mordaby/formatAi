// Column classification (owner, 2026-10-06; SPEC 21 "column classification"): ONE class per input and output column of the example, the
// single source of truth for WHETHER masking hides a column's values. `identifier` and `text` are masked (the masker decides HOW: shape,
// leading zeros, check digit, unmasking); `category`, `measure` and `date` are sent real. Decided in this order, the first that speaks wins:
//   1. Value shapes (shared `identifierShapeOf`: validator.js, the same checks as the Save popup): when most non-empty cells have one
//      identifier shape (`columnClassification.shapeShare`), the column is an `identifier`.
//   2. The column's name (`columnNames`, he + en): a measure word keeps a numeric column a `measure`, however long its numbers (a 1,000,000
//      price stays real); otherwise an identifier word makes any column but a date or a boolean an `identifier`, even when its numbers repeat.
//   3. The profile type: text -> `text`; numbers -> `measure`; dates -> `date`; `idLike` -> `identifier`; booleans -> `category`.
// Then an external classification, when the caller gives one (`ColumnClassHints`, by header: the AI step's, later) may tighten anything to
// masked, and loosen a text column to a `category` only when code confirms it (few values, each on 2 rows or more, no identifier shape, no
// identifier or person word in the name); it never loosens an identifier. Last, a copy keeps one class: an output column that copies an
// input column is an identifier when either is, so a sample's `in` and `out` carry the same fake.
// DECISION (owner): no guess from how values are used or repeat - an integer column with no identifier word in its name is a measure, sent
// real (a customer number named "Ref" included): a name the lists miss is what the external classification will add.
//
// Every path that sends cells reads it here, so a value gets the same fake everywhere: the payload's samples, dropped rows and hint values
// (`payload.ts`), the learning loop's rows (`loop.ts`), the AI code checks' answers (`checks.ts`), the repair problems (`verify.ts`) and the
// completion call's constants. Pure, synchronous; cached per analysis.

import {
  columnClassification,
  columnNames,
  identifierShapeOf,
  nameHolds,
  normalizeColumnName,
  type ColumnClass,
  type ColumnClassHint,
  type IdentifierKind,
  type ProfileType,
} from '@formatai/shared';
import type { RawCell } from '../types';
import { normalizeText } from '../values/text';
import type { ColumnProfile, PairAnalysis } from './analyze';

/** What decided a column's class (for tests and the docs; masking reads the class only). */
export type ClassSource = 'shape' | 'name' | 'profile' | 'hint' | 'copy';

export interface ClassifiedColumn {
  class: ColumnClass;
  by: ClassSource;
  /** `by: 'shape'`: the identifier shape most cells have. */
  shape?: IdentifierKind;
}

export interface ColumnClasses {
  /** Per input column. */
  input: ColumnClass[];
  /** Per output column. */
  output: ColumnClass[];
  /** The same, with what decided each class. */
  detail: { input: ClassifiedColumn[]; output: ClassifiedColumn[] };
}

/** Whether masking hides the values of a column of this class. */
export function isMasked(c: ColumnClass): boolean {
  return c === 'identifier' || c === 'text';
}

// ---------------------------------------------------------------------------
// One column
// ---------------------------------------------------------------------------

/** A column's cells: `n` of them, the k-th by `at`. */
interface Cells {
  n: number;
  at(k: number): RawCell | null | undefined;
}

/** A cell's value when it can hold an identifier: a number or non-empty text, not a date cell. */
function valueOf(cell: RawCell | null | undefined): string | number | null {
  const v = cell?.v;
  if (cell?.isDate || v === null || v === undefined || typeof v === 'boolean') return null;
  return typeof v === 'string' && v.trim() === '' ? null : v;
}

/** Step 1: the identifier shape at least `shapeShare` of the column's non-empty cells (read evenly, up to `shapeSample`) have, or null. */
function shapeOfColumn(cells: Cells): IdentifierKind | null {
  const step = Math.max(1, Math.ceil(cells.n / columnClassification.shapeSample));
  const counts = new Map<IdentifierKind, number>();
  let read = 0;
  for (let k = 0; k < cells.n; k += step) {
    const v = valueOf(cells.at(k));
    if (v === null) continue;
    read++;
    const kind = identifierShapeOf(v);
    if (kind) counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  for (const [kind, n] of counts) if (n / read >= columnClassification.shapeShare) return kind;
  return null;
}

const NUMERIC: ReadonlySet<ProfileType> = new Set<ProfileType>(['integer', 'decimal', 'currency', 'percent', 'idLike']);

/** Step 2: the class the name gives, or null. A date or a boolean column keeps its profile's class whatever its name. */
function classOfName(p: ColumnProfile): ColumnClass | null {
  if (p.type === 'date' || p.type === 'boolean') return null;
  if (nameHolds(p.header, columnNames.measure)) return NUMERIC.has(p.type) ? 'measure' : null;
  return nameHolds(p.header, columnNames.identifier) ? 'identifier' : null;
}

/** Step 3: the profile type's class. */
function classOfProfile(type: ProfileType): ColumnClass {
  if (type === 'idLike') return 'identifier';
  if (type === 'date') return 'date';
  if (type === 'boolean') return 'category';
  return NUMERIC.has(type) ? 'measure' : 'text';
}

function classifyOne(p: ColumnProfile | undefined, cells: Cells): ClassifiedColumn {
  const shape = shapeOfColumn(cells);
  if (shape) return { class: 'identifier', by: 'shape', shape };
  if (!p) return { class: 'text', by: 'profile' };
  const named = classOfName(p);
  return named ? { class: named, by: 'name' } : { class: classOfProfile(p.type), by: 'profile' };
}

/**
 * Code's confirmation that a text column is a category (an external classification asked to send it real): at most `maxValues` distinct
 * values, each on at least `minRowsPerValue` rows, none of them identifier-shaped, and no identifier or person word in the name.
 */
function confirmsCategory(header: string, cells: Cells): boolean {
  if (nameHolds(header, columnNames.identifier) || nameHolds(header, columnNames.person)) return false;
  const { maxValues, minRowsPerValue } = columnClassification.category;
  const counts = new Map<string, { n: number; value: string | number }>();
  for (let k = 0; k < cells.n; k++) {
    const v = valueOf(cells.at(k));
    if (v === null) continue;
    const key = normalizeText(String(v)).trim();
    const seen = counts.get(key);
    if (seen) seen.n++;
    else if (counts.size === maxValues) return false;
    else counts.set(key, { n: 1, value: v });
  }
  return counts.size > 0 && [...counts.values()].every((c) => c.n >= minRowsPerValue && identifierShapeOf(c.value) === null);
}

/** An external classification's hint applied to code's class (see the file header). */
function withHint(code: ClassifiedColumn, hint: ColumnClassHint, header: string, cells: Cells): ClassifiedColumn {
  switch (hint) {
    case 'identifier':
    case 'contact':
      return code.class === 'identifier' ? code : { class: 'identifier', by: 'hint' };
    case 'person':
    case 'text':
      // Masked whatever it holds: a text column stays text; a column sent real becomes an identifier, the class that hides numbers too.
      return isMasked(code.class) ? code : { class: 'identifier', by: 'hint' };
    case 'category':
      return code.class === 'text' && confirmsCategory(header, cells) ? { class: 'category', by: 'hint' } : code;
    case 'measure':
    case 'date':
      return code; // never loosens
  }
}

// ---------------------------------------------------------------------------
// The example's columns
// ---------------------------------------------------------------------------

/** Relations whose output IS the operand's value (a copy). */
const COPIES: ReadonlySet<string> = new Set(['copy', 'normalize']);

/** The input columns each output column copies (a `COPIES` relation at the analysis' minimum coverage; a fixed fan-out's positions too). */
function copiedInputs(analysis: PairAnalysis): [number, number][] {
  const all = [...analysis.columns];
  if (analysis.shape.kind === 'families' && analysis.shape.pattern.mode === 'fixedFanOut') {
    for (const position of analysis.shape.pattern.positions) all.push(...position);
  }
  const pairs: [number, number][] = [];
  for (const ca of all) {
    for (const r of ca.relations) {
      const i = r.in[0];
      if (COPIES.has(r.rel) && i !== undefined && i < analysis.input.columnCount) pairs.push([ca.out, i]);
    }
  }
  return pairs;
}

const CACHE = new WeakMap<PairAnalysis, ColumnClasses>();

/** The class of every column of the example (see the file header). Cached: the analysis (its `columnHints` included) does not change. */
export function classifyColumns(analysis: PairAnalysis): ColumnClasses {
  const cached = CACHE.get(analysis);
  if (cached) return cached;
  const hints = new Map(Object.entries(analysis.columnHints ?? {}).map(([h, hint]) => [normalizeColumnName(h), hint] as const));
  const one = (p: ColumnProfile | undefined, header: string, cells: Cells): ClassifiedColumn => {
    const code = classifyOne(p, cells);
    const hint = hints.get(normalizeColumnName(header));
    return hint ? withHint(code, hint, header, cells) : code;
  };
  const inRows = analysis.input.rows;
  const input = analysis.input.headers.map((h, i) => one(analysis.input.profile[i], h, { n: inRows.length, at: (k) => inRows[k]?.[i] }));
  const outRows = analysis.output.dataRows;
  const outSheet = analysis.output.sheet.rows;
  const output = analysis.output.headers.map((h, o) => one(analysis.output.profile[o], h, { n: outRows.length, at: (k) => outSheet[outRows[k]!]?.[o] }));
  for (const [o, i] of copiedInputs(analysis)) {
    const a = input[i];
    const b = output[o];
    if (!a || !b || (a.class === 'identifier') === (b.class === 'identifier')) continue;
    if (a.class !== 'identifier') input[i] = { class: 'identifier', by: 'copy' };
    else output[o] = { class: 'identifier', by: 'copy' };
  }
  const classes: ColumnClasses = { input: input.map((c) => c.class), output: output.map((c) => c.class), detail: { input, output } };
  CACHE.set(analysis, classes);
  return classes;
}

/** The class of input column `i` ('text' for a column the analysis does not know: masked, as the payload always did). */
export function inputClass(analysis: PairAnalysis, i: number): ColumnClass {
  return classifyColumns(analysis).input[i] ?? 'text';
}

/** The class of output column `o`. */
export function outputClass(analysis: PairAnalysis, o: number): ColumnClass {
  return classifyColumns(analysis).output[o] ?? 'text';
}

/** "See what we send" (SPEC 15): per column of the example, its header and whether its values are hidden (masking on) or sent as they are. */
export interface SentColumn {
  header: string;
  hidden: boolean;
}

export function sentColumns(analysis: PairAnalysis, masking: boolean): { input: SentColumn[]; output: SentColumn[] } {
  const c = classifyColumns(analysis);
  const side = (headers: readonly string[], classes: readonly ColumnClass[]): SentColumn[] =>
    headers.map((header, k) => ({ header, hidden: masking && isMasked(classes[k] ?? 'text') }));
  return { input: side(analysis.input.headers, c.input), output: side(analysis.output.headers, c.output) };
}
