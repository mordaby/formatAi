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
// input column is an identifier when either is, so a sample's `in` and `out` carry the same fake. Amendment 2026-10-07 (engine audit):
// so does every relation that keeps part of the value (`KEEPS_VALUE`: padLeft, numberFormat, substr, split; a concat or template from an
// identifier input) - the 5-digit tail of an ID number was a measure, sent real.
// DECISION (owner): no guess from how values are used or repeat - an integer column with no identifier word in its name is a measure, sent
// real (a customer number named "Ref" included): a name the lists miss is what the external classification will add.
//
// Amendment 2026-10-07 (owner, "See what we send"): the user's choice per column (`UserColumnChoices`, on the analysis like the hints) is
// applied last and wins: 'sent' loosens anything, 'hidden' tightens anything masking can hide (not a date or a yes/no column: the masker
// sends those as they are). A copy keeps one class, so a choice on one column of a copy moves the columns it links (`applyChoices`).
// `codeColumnClasses` is the classification without them: the switches' presets, and what a decision about the rules reads.
//
// Every path that sends cells reads it here, so a value gets the same fake everywhere: the payload's samples, dropped rows and hint values
// (`payload.ts`), the learning loop's rows (`loop.ts`), the AI code checks' answers (`checks.ts`), the repair problems (`verify.ts`) and the
// completion call's constants (`maskFixed.ts`). Pure, synchronous; cached per analysis.

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
import type { ColumnChoice, ColumnProfile, PairAnalysis, UserColumnChoices } from './analyze';

/** What decided a column's class (for tests and the docs; masking reads the class only). `user`: the user's choice ("See what we send"). */
export type ClassSource = 'shape' | 'name' | 'profile' | 'hint' | 'copy' | 'user';

export interface ClassifiedColumn {
  class: ColumnClass;
  by: ClassSource;
  /** `by: 'shape'`: the identifier shape most cells have. */
  shape?: IdentifierKind;
  /** `by: 'user'`: the class code gave the column before the user's choice. */
  was?: ColumnClass;
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

/**
 * Relations whose output keeps part of an input value, verified by code on the example's rows (the analysis' relations, at its minimum
 * coverage) - amendment 2026-10-07 (engine audit): identifier status passes through every one of them, not only a copy.
 *  - `both`: the output is the value, or a part of it, so an identifier on EITHER side makes both identifiers (a copy, a case change,
 *    the value padded with zeros, rendered with a number format, a substr or a split part of it: the output's digits are the input's).
 *  - `toOutput`: the output holds the whole value of each input among other text (a concat, a template): an identifier input makes the
 *    output an identifier; an identifier output says nothing of its other inputs (an amount beside an ID stays a measure).
 */
const KEEPS_VALUE: Readonly<Record<string, 'both' | 'toOutput'>> = {
  copy: 'both',
  normalize: 'both',
  padLeft: 'both',
  numberFormat: 'both',
  substr: 'both',
  split: 'both',
  concat: 'toOutput',
  template: 'toOutput',
};

/** The input columns each output column keeps (part of) the value of, and which way identifier status passes (a fixed fan-out's positions too). */
function keptInputs(analysis: PairAnalysis): { out: number; in: number; way: 'both' | 'toOutput' }[] {
  const all = [...analysis.columns];
  if (analysis.shape.kind === 'families' && analysis.shape.pattern.mode === 'fixedFanOut') {
    for (const position of analysis.shape.pattern.positions) all.push(...position);
  }
  const pairs: { out: number; in: number; way: 'both' | 'toOutput' }[] = [];
  for (const ca of all) {
    for (const r of ca.relations) {
      const way = KEEPS_VALUE[r.rel];
      if (way === undefined) continue;
      for (const i of r.in) if (i < analysis.input.columnCount) pairs.push({ out: ca.out, in: i, way });
    }
  }
  return pairs;
}

const CACHE = new WeakMap<PairAnalysis, ColumnClasses>();
const CODE_CACHE = new WeakMap<PairAnalysis, ColumnClasses>();

/**
 * The class of every column of the example (see the file header), the user's choices included (`userColumnChoices`, applied last: see
 * `applyChoices`). Cached: the analysis (its `columnHints` and choices included) does not change.
 */
export function classifyColumns(analysis: PairAnalysis): ColumnClasses {
  const cached = CACHE.get(analysis);
  if (cached) return cached;
  const choices = analysis.userColumnChoices;
  const classes = choices && hasChoices(choices) ? classify(analysis, choices) : codeColumnClasses(analysis);
  CACHE.set(analysis, classes);
  return classes;
}

/**
 * The classes code gives, without the user's choices: what "See what we send" presets each switch to (and why), and what a decision about
 * the rules - not about what is sent - reads (a list keyed on an identifier, `oneTimers.ts`): hiding a column never changes what is learned.
 */
export function codeColumnClasses(analysis: PairAnalysis): ColumnClasses {
  const cached = CODE_CACHE.get(analysis);
  if (cached) return cached;
  const classes = classify(analysis, undefined);
  CODE_CACHE.set(analysis, classes);
  return classes;
}

function classify(analysis: PairAnalysis, choices: UserColumnChoices | undefined): ColumnClasses {
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
  const kept = keptInputs(analysis);
  // The user's choices (owner, 2026-10-07), before the copies are made to agree: a column the user chose to send stays sent (`pinned`).
  const pinned = choices ? applyChoices(analysis, { input, output }, kept, choices) : { input: new Set<number>(), output: new Set<number>() };
  // (Until nothing changes: an output that becomes an identifier through one input passes it back to another it copies.)
  for (let changed = true; changed; ) {
    changed = false;
    for (const { out: o, in: i, way } of kept) {
      const a = input[i];
      const b = output[o];
      if (!a || !b || (a.class === 'identifier') === (b.class === 'identifier')) continue;
      if (a.class === 'identifier') {
        if (pinned.output.has(o)) continue;
        output[o] = { class: 'identifier', by: 'copy' };
      } else if (way === 'both' && !pinned.input.has(i)) input[i] = { class: 'identifier', by: 'copy' };
      else continue;
      changed = true;
    }
  }
  return { input: input.map((c) => c.class), output: output.map((c) => c.class), detail: { input, output } };
}

// ---------------------------------------------------------------------------
// The user's choices ("See what we send", owner 2026-10-07)
// ---------------------------------------------------------------------------

function hasChoices(choices: UserColumnChoices): boolean {
  return Object.keys(choices.input ?? {}).length > 0 || Object.keys(choices.output ?? {}).length > 0;
}

/**
 * Whether masking can hide a column's values: not a date column, nor a yes/no column - the masker sends dates and booleans as they are
 * whatever the class (SPEC 7.2), so a switch there would hide nothing.
 */
export function canHideColumn(c: ColumnClass, p: ColumnProfile | undefined): boolean {
  return c !== 'date' && p?.type !== 'boolean';
}

/** A column the user chose to send: the class that sends its values as they are (a number column a measure, anything else a category). */
function sentClassOf(p: ColumnProfile | undefined): ColumnClass {
  if (p?.type === 'date') return 'date';
  return p && NUMERIC.has(p.type) ? 'measure' : 'category';
}

/**
 * Applies the user's choices to code's classes, in place (see `UserColumnChoices`): 'hidden' tightens what masking can hide (a column sent
 * real becomes an identifier, the class that hides numbers too), 'sent' loosens anything (an identifier or a text column becomes a measure
 * or a category). The user's choice wins, as with the masking switch itself. A copy keeps one class as always (`keptInputs`, `both`): a
 * choice on one column of a copy is the choice for every column it links, on both sides; when two of them disagree, hidden wins. Returns
 * the columns chosen 'sent', which a copy may then not make identifiers again.
 */
function applyChoices(
  analysis: PairAnalysis,
  classes: { input: ClassifiedColumn[]; output: ClassifiedColumn[] },
  kept: readonly { out: number; in: number; way: 'both' | 'toOutput' }[],
  choices: UserColumnChoices,
): { input: Set<number>; output: Set<number> } {
  const nIn = classes.input.length;
  const nOut = classes.output.length;
  const find = copyGroupsOf(nIn, nOut, kept);
  const chosen = new Map<number, ColumnChoice>();
  const choose = (node: number, choice: ColumnChoice | undefined): void => {
    if (choice !== 'hidden' && choice !== 'sent') return;
    const root = find(node);
    if (chosen.get(root) !== 'hidden') chosen.set(root, choice);
  };
  for (const [k, choice] of Object.entries(choices.input ?? {})) if (Number(k) >= 0 && Number(k) < nIn) choose(Number(k), choice);
  for (const [k, choice] of Object.entries(choices.output ?? {})) if (Number(k) >= 0 && Number(k) < nOut) choose(nIn + Number(k), choice);

  const pinned = { input: new Set<number>(), output: new Set<number>() };
  const apply = (list: ClassifiedColumn[], profiles: readonly ColumnProfile[], offset: number, pins: Set<number>): void => {
    list.forEach((code, k) => {
      const choice = chosen.get(find(offset + k));
      if (choice === 'hidden' && !isMasked(code.class) && canHideColumn(code.class, profiles[k])) list[k] = { class: 'identifier', by: 'user', was: code.class };
      else if (choice === 'sent') {
        pins.add(k);
        if (isMasked(code.class)) list[k] = { class: sentClassOf(profiles[k]), by: 'user', was: code.class };
      }
    });
  };
  apply(classes.input, analysis.input.profile, 0, pinned.input);
  apply(classes.output, analysis.output.profile, nIn, pinned.output);
  return pinned;
}

/**
 * The columns a copy links (`keptInputs`, `both`), as groups: the group of input column i is `find(i)`, of output column o `find(nIn + o)`.
 * A choice on one column of a group is the choice for all of them.
 */
function copyGroupsOf(nIn: number, nOut: number, kept: readonly { out: number; in: number; way: 'both' | 'toOutput' }[]): (node: number) => number {
  const parent = Array.from({ length: nIn + nOut }, (_, k) => k);
  const find = (k: number): number => {
    let root = k;
    while (parent[root] !== root) root = parent[root]!;
    return root;
  };
  for (const { out, in: i, way } of kept) {
    if (way !== 'both' || out >= nOut || i >= nIn) continue;
    const a = find(i);
    const b = find(nIn + out);
    // (the smaller node is the root: a group's id is its first column, input before output)
    if (a !== b) parent[Math.max(a, b)] = Math.min(a, b);
  }
  return find;
}

/** The analysis with the user's choices on it (none: without any), for `classifyColumns` - and so for every path that masks. */
export function withColumnChoices(analysis: PairAnalysis, choices: UserColumnChoices | undefined): PairAnalysis {
  const { userColumnChoices: _old, ...rest } = analysis;
  return choices && hasChoices(choices) ? { ...rest, userColumnChoices: choices } : rest;
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

/**
 * "See what we send" before the learn (owner, 2026-10-07): a column with what its switch needs - hidden now (the user's choice included),
 * hidden by code's own classification (the preset), why code calls it an identifier (the warning when it is un-hidden), whether masking can
 * hide it at all, and code's class (a measure: hiding it may keep the AI from rules on its real numbers). Headers and classes only.
 */
export interface SendColumn extends SentColumn {
  hiddenByDefault: boolean;
  /** Code's class, before the user's choice. */
  class: ColumnClass;
  /** Code found it an identifier: what said so (`shape`: the shape most cells have). */
  identifier?: { by: ClassSource; shape?: IdentifierKind };
  canHide: boolean;
  /**
   * The columns a copy links share a group (an id: the same number on both sides): a choice is made for the whole group, as the
   * classification applies it.
   */
  group: number;
}

export function sendColumns(analysis: PairAnalysis, masking: boolean): { input: SendColumn[]; output: SendColumn[] } {
  const now = classifyColumns(analysis);
  const code = codeColumnClasses(analysis);
  const nIn = analysis.input.headers.length;
  const group = copyGroupsOf(nIn, analysis.output.headers.length, keptInputs(analysis));
  const side = (headers: readonly string[], profiles: readonly ColumnProfile[], nowSide: readonly ColumnClass[], codeSide: readonly ClassifiedColumn[], offset: number): SendColumn[] =>
    headers.map((header, k) => {
      const c: ClassifiedColumn = codeSide[k] ?? { class: 'text', by: 'profile' };
      return {
        header,
        hidden: masking && isMasked(nowSide[k] ?? c.class),
        hiddenByDefault: masking && isMasked(c.class),
        class: c.class,
        ...(c.class === 'identifier' ? { identifier: { by: c.by, ...(c.shape ? { shape: c.shape } : {}) } } : {}),
        canHide: canHideColumn(c.class, profiles[k]),
        group: group(offset + k),
      };
    });
  return {
    input: side(analysis.input.headers, analysis.input.profile, now.input, code.detail.input, 0),
    output: side(analysis.output.headers, analysis.output.profile, now.output, code.detail.output, nIn),
  };
}
