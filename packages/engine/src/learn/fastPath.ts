// The local fast path (SPEC 6.5): builds a verified rules file directly from
// the pair analysis, in code, with no LLM call, whenever the case is simple
// enough that nothing is left to guess. STRICT mode only (config
// `limits.learn.fastPathMode`): every output column needs its own
// coverage-1.0, unambiguous, well-evidenced hint; any dropped rows must be
// fully explained by a filter and/or dedupe hint; no rows expand; and the
// layout needs nothing beyond constant title rows. Anything else returns a
// reason instead, for the caller to fall back to the LLM path.
//
// DECISION (`limits.learn.fastPathMode`): 'wide' - a looser fast path that
// would also cover some cases that currently need the LLM - is reserved for
// later, once eval data shows the strict path leaves too much on the table;
// only 'strict' (this file) is implemented in M1.

import type {
  Assumption,
  ColumnType,
  Computed,
  Dedupe,
  Expr,
  FilterScalar,
  InputColumn,
  LearnResult,
  PayloadCell,
  ProfileType,
  RowFilter,
  RulesInput,
  RulesOutput,
  RulesTransform,
  TitleRow,
  Validation,
  ValueMap,
} from '@formatai/shared';
import type { OutputFileSpec } from '../types';
import type { ColumnAnalysis, FilterRelation, PairAnalysis, Relation } from './analyze';
import { significantDigits } from './analyze/cells';
import { SPLIT_SEPARATORS } from './analyze/relations';
import { relationHasHint } from './hints';
import type { PreflightResult } from './preflight';
import type { AmbiguousColumn, ColumnReading, RuleFragment } from './readings';
import { maxDistinctValues, templateOperandForm, type OperandForm } from './templateOperands';

// ---------------------------------------------------------------------------
// Public contract
// ---------------------------------------------------------------------------

export type FastPathReasonCode =
  | 'blocked'
  | 'columnNotFullyExplained'
  | 'ambiguousColumn'
  | 'thinEvidence'
  | 'rowsExpand'
  | 'droppedRowsUnexplained'
  | 'layoutUnsupported';

export interface FastPathFailure {
  reason: FastPathReasonCode;
  params?: Record<string, string | number>;
}

export interface FastPathSuccess {
  rules: LearnResult;
  assumptions: Assumption[];
  /**
   * The columns the example fits more than one rule for (a constant the input could write too, readings.ts): built from their data reading,
   * with the check that flags a row where the readings differ, until the user answers. Absent when there are none.
   */
  ambiguous?: AmbiguousColumn[];
}

export type FastPathResult = FastPathSuccess | FastPathFailure;

export function fail(reason: FastPathReasonCode, params?: Record<string, string | number>): FastPathFailure {
  return params ? { reason, params } : { reason };
}

// ---------------------------------------------------------------------------
// Ids and types
// ---------------------------------------------------------------------------

function slug(header: string): string {
  const words = header
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return '';
  return words.map((w, i) => (i === 0 ? w.toLowerCase() : w[0]!.toUpperCase() + w.slice(1).toLowerCase())).join('');
}

/** A short, unique camelCase id (LEARN_PROMPT step 12): an ascii-slug of the
 * header when one exists, else a neutral `c1`, `c2`, ... scheme. */
export function freshId(header: string, fallback: string, used: Set<string>): string {
  let base = slug(header);
  if (base === '' || /^[0-9]/.test(base)) base = fallback;
  let id = base;
  let n = 2;
  while (used.has(id)) id = `${base}${n++}`;
  used.add(id);
  return id;
}

export function columnType(p: ProfileType): ColumnType {
  return p === 'empty' ? 'text' : p;
}

export function isPlainXlsx(f: OutputFileSpec): boolean {
  return f.type === 'xlsx' && f.delimiter === undefined && f.header === undefined && f.encoding === undefined && f.quote === undefined;
}

// ---------------------------------------------------------------------------
// Build context
// ---------------------------------------------------------------------------

export interface Ctx {
  usedIds: Set<string>;
  /** Input column index -> declared id, created lazily on first use. */
  inputIds: Map<number, string>;
  /** Input column index -> its (mutable) InputColumn declaration. */
  inputColumns: Map<number, InputColumn>;
  computed: Computed[];
  valueMaps: ValueMap[];
  /** Input columns actually fed into a rule (output, filter or dedupe key). */
  usedInputCols: Set<number>;
  /**
   * Relation operands >= input.columnCount are columns a family pattern creates (SPEC 8.5); the local
   * partial result (partial.ts) maps each to the id its `expand` declares. Always empty for the strict
   * fast path, which never sees a family.
   */
  createdIds: Map<number, string>;
  /**
   * Input columns a `template` column reads as they are (its text was proven for the column as declared, see
   * templateOperands.ts), so no other column may later change how the engine reads them (zero padding).
   */
  templateCols: Set<number>;
  /**
   * Ids of the (input or family) columns an output column reads as they are (`from: id`). A value map changes its
   * column's cells for every reader that runs after it (SPEC 8.2 step 7), so a map never goes on a column that is
   * also read plainly, nor on a column another map already covers: it goes on a computed copy (see `mappedColumn`).
   */
  plainReads: Set<string>;
}

export function newCtx(): Ctx {
  return {
    usedIds: new Set(),
    inputIds: new Map(),
    inputColumns: new Map(),
    computed: [],
    valueMaps: [],
    usedInputCols: new Set(),
    createdIds: new Map(),
    templateCols: new Set(),
    plainReads: new Set(),
  };
}

/** A copy of the build state, to roll a failed column back (partial.ts builds tolerantly). */
export function snapshotCtx(ctx: Ctx): Ctx {
  return {
    usedIds: new Set(ctx.usedIds),
    inputIds: new Map(ctx.inputIds),
    inputColumns: new Map([...ctx.inputColumns].map(([i, c]) => [i, { ...c }])),
    computed: [...ctx.computed],
    valueMaps: [...ctx.valueMaps],
    usedInputCols: new Set(ctx.usedInputCols),
    createdIds: new Map(ctx.createdIds),
    templateCols: new Set(ctx.templateCols),
    plainReads: new Set(ctx.plainReads),
  };
}

export function restoreCtx(ctx: Ctx, snap: Ctx): void {
  ctx.usedIds = snap.usedIds;
  ctx.inputIds = snap.inputIds;
  ctx.inputColumns = snap.inputColumns;
  ctx.computed = snap.computed;
  ctx.valueMaps = snap.valueMaps;
  ctx.usedInputCols = snap.usedInputCols;
  ctx.createdIds = snap.createdIds;
  ctx.templateCols = snap.templateCols;
  ctx.plainReads = snap.plainReads;
}

export function ensureInputColumn(ctx: Ctx, analysis: PairAnalysis, i: number): string {
  const existing = ctx.inputIds.get(i);
  if (existing !== undefined) return existing;
  if (i >= analysis.input.columnCount) {
    const created = ctx.createdIds.get(i);
    if (created === undefined) throw new Error(`fastPath: operand ${i} is not an input column and no family column was declared for it`);
    return created;
  }
  const profile = analysis.input.profile[i]!;
  const id = freshId(profile.header, `c${i + 1}`, ctx.usedIds);
  ctx.inputIds.set(i, id);
  const col: InputColumn = { id, header: profile.header, type: columnType(profile.type) };
  // The pair analysis already promotes a plain-number column to 'date'
  // (excelSerial) or 'idLike' (leadingZerosLost) when a coverage-1.0 relation
  // proves it (analyzePair's refineInputProfiles), so `columnType(profile.type)`
  // above already reflects that; only `inputFormats` (needed to parse a text or
  // serial date) is left to set here.
  if (profile.type === 'date' && profile.dateFormat !== undefined && profile.dateFormat !== 'excel') {
    col.inputFormats = [profile.dateFormat];
  }
  ctx.inputColumns.set(i, col);
  return id;
}

function newComputedId(ctx: Ctx, outHeader: string): string {
  return freshId(outHeader, 'value', ctx.usedIds);
}

/** Declared type of an input column (a family column has none declared here: text). */
function declaredType(ctx: Ctx, i: number): ColumnType {
  return ctx.inputColumns.get(i)?.type ?? 'text';
}

/** A computed column that reads input column `i` as it is: the value as the input says, before any value map runs. */
function copyColumn(ctx: Ctx, analysis: PairAnalysis, i: number, outHeader: string): string {
  const id = newComputedId(ctx, outHeader);
  ctx.computed.push({ id, type: declaredType(ctx, i), expr: { col: ensureInputColumn(ctx, analysis, i) } });
  return id;
}

/** The id an output column reads when it shows input column `i` as it is: the column itself, unless a value map already translates it. */
function plainRead(ctx: Ctx, analysis: PairAnalysis, i: number, outHeader: string): string {
  const id = ensureInputColumn(ctx, analysis, i);
  if (ctx.valueMaps.some((vm) => vm.column === id)) return copyColumn(ctx, analysis, i, outHeader);
  ctx.plainReads.add(id);
  return id;
}

/**
 * The column a value map of input column `i` goes on: the column itself when nothing else reads it and its cells are
 * text (the learned shape), otherwise a computed copy that only this output reads, so that maps never overwrite each
 * other or a plain copy. A column with a number or date type gets the copy too: the map would leave text in it, and
 * the input-side checks on that column (range) run after the maps.
 */
function mappedColumn(ctx: Ctx, analysis: PairAnalysis, i: number, outHeader: string): string {
  const id = ensureInputColumn(ctx, analysis, i);
  const type = declaredType(ctx, i);
  const textLike = type === 'text' || type === 'idLike';
  const shared = ctx.plainReads.has(id) || ctx.valueMaps.some((vm) => vm.column === id);
  return shared || !textLike ? copyColumn(ctx, analysis, i, outHeader) : id;
}

// ---------------------------------------------------------------------------
// Layout eligibility (SPEC 6.5: "nothing beyond constant title rows")
// ---------------------------------------------------------------------------

export function layoutIssue(analysis: PairAnalysis): FastPathFailure | null {
  const layout = analysis.layout;
  if (layout.groupBy !== null) return fail('layoutUnsupported', { part: 'group' });
  if (layout.summaryRows.length > 0) return fail('layoutUnsupported', { part: 'summaryRows' });
  if (layout.sort !== null) return fail('layoutUnsupported', { part: 'sort' });
  if (layout.titleRows.some((t) => t.containsDate !== undefined)) return fail('layoutUnsupported', { part: 'dateTitle' });
  if (layout.unexplainedBlankRows.length > 0) return fail('layoutUnsupported', { part: 'blankRows' });
  return null;
}

// ---------------------------------------------------------------------------
// Thin evidence (task: mulConst/addConst on < 3 distinct non-zero values, a
// valueMap whose every key appears once) - read straight from the real,
// aligned data, the same rows the relation itself was tested against.
// ---------------------------------------------------------------------------

function alignedCellValue(analysis: PairAnalysis, alignedRow: number, inCol: number): PayloadCell {
  const inRow = analysis.alignment.rows[alignedRow]!.in;
  const cell = analysis.input.rows[inRow]?.[inCol];
  if (!cell) return null;
  return cell.v;
}

function distinctNonZeroCount(analysis: PairAnalysis, inCol: number): number {
  const seen = new Set<string>();
  const K = analysis.alignment.rows.length;
  for (let k = 0; k < K; k++) {
    const v = alignedCellValue(analysis, k, inCol);
    const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
    if (Number.isFinite(n) && n !== 0) seen.add(String(n));
  }
  return seen.size;
}

function valueMapHasRepeat(analysis: PairAnalysis, inCol: number): boolean {
  const counts = new Map<string, number>();
  const K = analysis.alignment.rows.length;
  for (let k = 0; k < K; k++) {
    const v = alignedCellValue(analysis, k, inCol);
    if (v === null || v === '') continue;
    const key = String(v);
    const n = (counts.get(key) ?? 0) + 1;
    counts.set(key, n);
    if (n > 1) return true;
  }
  return false;
}

/** Whether the example's output cells of column `out` are real numbers or dates (not text): a value map can only write text. */
function outputHoldsNonText(analysis: PairAnalysis, out: number): boolean {
  for (const sheetRow of analysis.output.dataRows) {
    const cell = analysis.output.sheet.rows[sheetRow]?.[out];
    if (cell && cell.v !== null && (typeof cell.v === 'number' || cell.isDate === true)) return true;
  }
  return false;
}

/** A constant of a calculation that is only right after rounding must be this round (significant digits) to be taken as a rate. */
const MAX_EXACT_CONST_DIGITS = 4;

type SplitRelation = Extract<Relation, { rel: 'split' }>;

/** The text of each aligned input cell that has a value (numbers as their plain text), with the parts a split makes of it. */
function splitRows(analysis: PairAnalysis, rel: SplitRelation, separator = rel.separator): { k: number; text: string; parts: string[] }[] {
  const rows: { k: number; text: string; parts: string[] }[] = [];
  const K = analysis.alignment.rows.length;
  for (let k = 0; k < K; k++) {
    const v = alignedCellValue(analysis, k, rel.in[0]);
    const text = typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '';
    if (text.trim() === '') continue;
    rows.push({ k, text, parts: text.trim().split(separator) });
  }
  return rows;
}

/** The example output's text (number as plain text) of aligned row `k`, column `out`. */
function alignedOutputText(analysis: PairAnalysis, k: number, out: number): string {
  const sheetRow = analysis.output.dataRows[analysis.alignment.rows[k]!.out];
  const v = sheetRow === undefined ? undefined : analysis.output.sheet.rows[sheetRow]?.[out]?.v;
  return typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '';
}

/** Whether another separator, cutting some part of every text, writes the whole example output as well. */
function otherSeparatorFits(analysis: PairAnalysis, rel: SplitRelation): boolean {
  return SPLIT_SEPARATORS.filter((sep) => sep !== rel.separator).some((sep) => {
    const rows = splitRows(analysis, rel, sep);
    if (rows.length === 0) return false;
    for (const index of [1, -1, 2, -2, 3, -3]) {
      if (rows.every(({ k, parts }) => (index > 0 ? parts[index - 1] : parts[parts.length + index])?.trim() === alignedOutputText(analysis, k, rel.out))) return true;
    }
    return false;
  });
}

function splitPartsNeedTrim(analysis: PairAnalysis, rel: SplitRelation): boolean {
  return splitRows(analysis, rel).some(({ parts }) => {
    const part = rel.index > 0 ? parts[rel.index - 1] : parts[parts.length + rel.index];
    return part !== undefined && part !== part.trim();
  });
}

/**
 * Evidence for a `split`: the separator really cuts the text on at least 3 different values (one that never occurs
 * shows nothing), no other separator writes the same output (a space and a comma give the same last word until a
 * text has both), and the part is told apart by its position. When every text has the same number of parts, "the
 * 2nd" and "the last" (or "the 2nd from the end") give the same result on the example and a different one on a text
 * with more parts, so the example cannot say which was meant - except for the first part, the natural reading.
 */
function splitEvidenceIssue(analysis: PairAnalysis, rel: SplitRelation): FastPathFailure | null {
  const rows = splitRows(analysis, rel).filter(({ parts }) => parts.length >= 2);
  if (new Set(rows.map((r) => r.text)).size < 3) return fail('thinEvidence', { column: rel.out, relation: rel.rel });
  const sameCount = rows.every((r) => r.parts.length === rows[0]!.parts.length);
  if ((sameCount && rel.index !== 1) || otherSeparatorFits(analysis, rel)) return fail('ambiguousColumn', { column: rel.out });
  return null;
}

function thinEvidenceIssue(analysis: PairAnalysis, rel: Relation): FastPathFailure | null {
  if (rel.rel === 'mulConst' || rel.rel === 'addConst') {
    if (distinctNonZeroCount(analysis, rel.in[0]) < 3) return fail('thinEvidence', { column: rel.out, relation: rel.rel });
    // A constant with many significant digits that only fits after rounding the result is an approximation of
    // something else (a rate, its reciprocal), not a number anybody wrote: it would drift on next month's values.
    if (rel.round !== undefined && significantDigits(rel.divisorText ?? rel.constText) > MAX_EXACT_CONST_DIGITS) {
      return fail('thinEvidence', { column: rel.out, relation: rel.rel });
    }
  }
  if (rel.rel === 'valueMap') {
    if (!valueMapHasRepeat(analysis, rel.in[0])) return fail('thinEvidence', { column: rel.out, relation: rel.rel });
    // A value map writes text, so it cannot make the numbers (or dates) this column holds; and a number tied to a
    // key may be a fixed rate - or a figure of the group (a total, a count) that is different next month. The
    // example cannot tell them apart: the AI step decides (a lookup table gives a typed value).
    if (outputHoldsNonText(analysis, rel.out)) return fail('thinEvidence', { column: rel.out, relation: rel.rel });
  }
  if (rel.rel === 'split') return splitEvidenceIssue(analysis, rel);
  // A template whose every input column takes fewer than 3 different values is as likely a value map (or plain
  // fixed text): nothing shows that the columns really vary.
  if (rel.rel === 'template' && maxDistinctValues(analysis, rel.in, 3) < 3) {
    return fail('thinEvidence', { column: rel.out, relation: rel.rel });
  }
  return null;
}

// ---------------------------------------------------------------------------
// One output column's rule, from its chosen relation
// ---------------------------------------------------------------------------

/**
 * A number format that may carry one quoted text in front and one behind (`"₪"#,##0.00`, `#,##0.00" ₪"`), split
 * into the fixed texts and the number format between them. Null when a quote is anywhere else (a text with a quote
 * in it, a text in the middle): not something the join below could say.
 */
function numberFormatParts(format: string): { prefix: string; core: string; suffix: string } | null {
  const m = /^(?:"([^"]*)")?([^"]*)(?:"([^"]*)")?$/.exec(format);
  if (m === null || m[2] === '') return null;
  return { prefix: m[1] ?? '', core: m[2]!, suffix: m[3] ?? '' };
}

export function columnFrom(ctx: Ctx, analysis: PairAnalysis, outHeader: string, rel: Relation): string | FastPathFailure {
  const input = (i: number): string => ensureInputColumn(ctx, analysis, i);
  const use = (i: number): void => void ctx.usedInputCols.add(i);

  switch (rel.rel) {
    case 'copy': {
      use(rel.in[0]);
      return plainRead(ctx, analysis, rel.in[0], outHeader);
    }
    case 'normalize': {
      use(rel.in[0]);
      let expr: Expr = { op: 'trim', arg: { col: input(rel.in[0]) } };
      if (rel.case === 'upper') expr = { op: 'upper', arg: expr };
      else if (rel.case === 'lower') expr = { op: 'lower', arg: expr };
      const id = newComputedId(ctx, outHeader);
      ctx.computed.push({ id, type: 'text', expr });
      return id;
    }
    case 'padLeft': {
      use(rel.in[0]);
      const inputId = input(rel.in[0]);
      if (rel.char === '0') {
        if (ctx.templateCols.has(rel.in[0])) return fail('columnNotFullyExplained', { column: outHeader });
        const col = ctx.inputColumns.get(rel.in[0])!;
        if (col.padLeft !== undefined && col.padLeft !== rel.length) {
          return fail('columnNotFullyExplained', { column: outHeader });
        }
        col.padLeft = rel.length;
        return plainRead(ctx, analysis, rel.in[0], outHeader);
      }
      const id = newComputedId(ctx, outHeader);
      ctx.computed.push({ id, type: 'text', expr: { op: 'padLeft', arg: { col: inputId }, length: rel.length, char: rel.char } });
      return id;
    }
    case 'substr': {
      use(rel.in[0]);
      const start = rel.from === 'start' ? 1 : rel.from === 'end' ? -rel.length : rel.from;
      const id = newComputedId(ctx, outHeader);
      ctx.computed.push({ id, type: 'text', expr: { op: 'substr', arg: { col: input(rel.in[0]) }, start, length: rel.length } });
      return id;
    }
    case 'concat': {
      // The engine's `concat` is plain string concatenation with no built-in
      // separator or skip-empty (SPEC 8.3); a separator is reproduced by
      // interleaving `{const: separator}` between the column args, which only
      // matches the example when every part is always present. `skipEmpty`
      // would need a per-row conditional join the fast path doesn't build, so
      // such a column is left for the LLM instead.
      if (rel.skipEmpty) return fail('columnNotFullyExplained', { column: outHeader });
      rel.in.forEach(use);
      const args: Expr[] = [];
      rel.in.forEach((i, idx) => {
        if (idx > 0 && rel.separator !== '') args.push({ const: rel.separator });
        args.push({ col: input(i) });
      });
      const id = newComputedId(ctx, outHeader);
      ctx.computed.push({ id, type: 'text', expr: { op: 'concat', args } });
      return id;
    }
    case 'template': {
      // Fixed text around 1-2 input values (limits.learn.template): `concat` of const literals and the columns.
      // DECISION: only true input columns, and only when the engine's text for each column is proven to be the
      // text the analysis compared (templateOperands.ts); anything else is left to the AI step.
      const forms = new Map<number, OperandForm>();
      for (const i of rel.in) {
        if (i >= analysis.input.columnCount) return fail('columnNotFullyExplained', { column: outHeader });
        input(i);
        const col = ctx.inputColumns.get(i)!;
        const form = col.padLeft === undefined ? templateOperandForm(analysis, i, col.type) : null;
        if (form === null) return fail('columnNotFullyExplained', { column: outHeader });
        forms.set(i, form);
      }
      for (const i of rel.in) {
        use(i);
        ctx.templateCols.add(i);
      }
      const operand = (i: number): Expr => {
        const col: Expr = { col: input(i) };
        const form = forms.get(i);
        return form === 'trim' ? { op: 'trim', arg: col } : form === 'toText' ? { op: 'toText', arg: col } : col;
      };
      const args: Expr[] = rel.parts.map((p) => (typeof p === 'string' ? { const: p } : operand(p.in)));
      const id = newComputedId(ctx, outHeader);
      ctx.computed.push({ id, type: 'text', expr: { op: 'concat', args } });
      return id;
    }
    case 'valueMap': {
      use(rel.in[0]);
      const column = mappedColumn(ctx, analysis, rel.in[0], outHeader);
      ctx.valueMaps.push({ column, map: Object.fromEntries(rel.pairs), onMissing: 'flag' });
      return column;
    }
    case 'constant': {
      const v = rel.value;
      const type: ColumnType = typeof v === 'number' ? (Number.isInteger(v) ? 'integer' : 'decimal') : typeof v === 'boolean' ? 'boolean' : 'text';
      const id = newComputedId(ctx, outHeader);
      ctx.computed.push({ id, type, expr: { const: v } });
      return id;
    }
    case 'dateFormat': {
      use(rel.in[0]);
      const inputId = input(rel.in[0]);
      const outProfile = analysis.output.profile[rel.out];
      // A text column whose values all happen to read as dates (e.g. every
      // cell is "YYYY-MM-DD") is ALSO profiled as type 'date' (profile.ts), so
      // the real/text distinction is `dateFormat === 'excel'` (a genuine Excel
      // date cell), not the profile type alone.
      if (outProfile?.type === 'date' && outProfile.dateFormat === 'excel') {
        // Text/serial date -> real date output cell: a plain copy. The engine
        // parses it via input.columns[].inputFormats and writes it as a real
        // date, rendered with output.columns[].format (set by the caller).
        return plainRead(ctx, analysis, rel.in[0], outHeader);
      }
      const id = newComputedId(ctx, outHeader);
      ctx.computed.push({ id, type: 'text', expr: { op: 'dateFormat', arg: { col: inputId }, format: rel.to } });
      return id;
    }
    case 'numberFormat': {
      use(rel.in[0]);
      const parts = numberFormatParts(rel.format);
      if (parts === null) return fail('columnNotFullyExplained', { column: outHeader });
      let expr: Expr = { op: 'toText', arg: { col: input(rel.in[0]) }, format: parts.core };
      if (parts.prefix !== '' || parts.suffix !== '') {
        // `toText` renders the digits only, never a quoted text of the format ("₪"#,##0.00 would lose the ₪): the
        // fixed text is joined on. That reads the same only when every row has a number (an empty cell would still
        // get the symbol), and, for a symbol IN FRONT, only when no number is negative (the analysis writes -₪5.00,
        // the join ₪-5.00). Anything else is left to the AI step.
        const profile = analysis.input.profile[rel.in[0]];
        if (profile === undefined || profile.emptyRate > 0) return fail('columnNotFullyExplained', { column: outHeader });
        if (parts.prefix !== '' && (profile.range === undefined || typeof profile.range[0] !== 'number' || profile.range[0] < 0)) {
          return fail('columnNotFullyExplained', { column: outHeader });
        }
        const args: Expr[] = [];
        if (parts.prefix !== '') args.push({ const: parts.prefix });
        args.push(expr);
        if (parts.suffix !== '') args.push({ const: parts.suffix });
        expr = { op: 'concat', args };
      }
      const id = newComputedId(ctx, outHeader);
      ctx.computed.push({ id, type: 'text', expr });
      return id;
    }
    case 'mulConst':
    case 'addConst': {
      use(rel.in[0]);
      // "x / 1.17", not "x * 0.854701": the analysis found the output to be a division by a rounder constant.
      const inner: Expr =
        rel.divisor !== undefined
          ? { op: 'div', args: [{ col: input(rel.in[0]) }, { const: rel.divisor }] }
          : { op: rel.rel === 'mulConst' ? 'mul' : 'add', args: [{ col: input(rel.in[0]) }, { const: rel.const }] };
      const expr: Expr = rel.round !== undefined ? { op: 'round', digits: rel.round, arg: inner } : inner;
      const id = newComputedId(ctx, outHeader);
      ctx.computed.push({ id, type: 'decimal', expr });
      return id;
    }
    case 'add':
    case 'sub':
    case 'mul':
    case 'div': {
      rel.in.forEach(use);
      const [a, b] = rel.in;
      const inner: Expr = { op: rel.rel, args: [{ col: input(a) }, { col: input(b) }] };
      const expr: Expr = rel.round !== undefined ? { op: 'round', digits: rel.round, arg: inner } : inner;
      const id = newComputedId(ctx, outHeader);
      ctx.computed.push({ id, type: 'decimal', expr });
      return id;
    }
    case 'sum': {
      rel.in.forEach(use);
      const inner: Expr = { op: 'add', args: rel.in.map((i) => ({ col: input(i) })) };
      const expr: Expr = rel.round !== undefined ? { op: 'round', digits: rel.round, arg: inner } : inner;
      const id = newComputedId(ctx, outHeader);
      ctx.computed.push({ id, type: 'decimal', expr });
      return id;
    }
    case 'split': {
      // One part of a text cut at a separator: the engine's `split` (1-based; negative counts from the end). The
      // analysis compares the part trimmed, so a part with spaces around it needs `trim` too.
      use(rel.in[0]);
      const part: Expr = { op: 'split', arg: { col: input(rel.in[0]) }, separator: rel.separator, index: rel.index };
      const id = newComputedId(ctx, outHeader);
      ctx.computed.push({ id, type: 'text', expr: splitPartsNeedTrim(analysis, rel) ? { op: 'trim', arg: part } : part });
      return id;
    }
    // Unreachable in practice: 'aggregate' only appears for summary shapes
    // (the shape check above already rejects them).
    case 'aggregate':
      return fail('columnNotFullyExplained', { column: outHeader });
    // Across rows, order-independent only (docs/proposals/window-operations.md): a group's total on every row, or a count per group.
    // Nothing that depends on the order of the rows (a running total, a row number, previous / next, a rank) is ever built here.
    case 'window': {
      rel.in.forEach(use);
      rel.by.forEach(use);
      const by: string[] = rel.by.map(input);
      const x = rel.in[0];
      // The sum of an integer column is an integer; anything else is a decimal (the example's own cells are not the type: next month's may differ).
      const type: ColumnType = rel.fn === 'groupCount' ? 'integer' : declaredType(ctx, x as number) === 'integer' ? 'integer' : 'decimal';
      const expr: Expr = { op: 'window', fn: rel.fn, ...(x === undefined ? {} : { arg: { col: input(x) } }), by };
      const id = newComputedId(ctx, outHeader);
      ctx.computed.push({ id, type, expr });
      return id;
    }
  }
}

// ---------------------------------------------------------------------------
// Dropped rows: dedupe and/or the best filter (SPEC 6.5: "fully explained")
// ---------------------------------------------------------------------------

function toFilterScalar(v: PayloadCell): FilterScalar {
  return v;
}

/**
 * A row filter KEEPS the rows its condition holds for (SPEC 8.3, `input.rowFilters`), while the analysis reports the
 * condition that DROPS rows (`droppedWhen`): the rule is its complement.
 */
const KEEP_OP = {
  isEmpty: 'notEmpty',
  notEmpty: 'isEmpty',
  gt: 'lte',
  gte: 'lt',
  lt: 'gte',
  lte: 'gt',
} as const;

export function buildRowFilter(fr: FilterRelation, column: string, assumptions: Assumption[]): RowFilter {
  if (fr.droppedWhen) {
    const { op, value } = fr.droppedWhen;
    // Where exactly between the largest dropped and the smallest kept value the line was drawn is not forced by the
    // data (LEARN_PROMPT step 4: say so).
    if (op !== 'isEmpty' && op !== 'notEmpty') assumptions.push({ reasonCode: 'filterGuessed' });
    const keep = KEEP_OP[op];
    if (keep === 'isEmpty' || keep === 'notEmpty') return { column, op: keep };
    return { column, op: keep, value: value! };
  }
  // Value-set filter (LEARN_PROMPT step 4 tie-break): prefer the reading that
  // removes fewer kinds of rows going forward - drop only the specifically
  // observed bad values and keep everything else, including values never seen
  // in the example - and record the choice whenever it wasn't forced by the
  // data (both readings were available).
  if (fr.droppedValues && fr.keptValues) assumptions.push({ reasonCode: 'filterGuessed' });
  if (fr.droppedValues) {
    return fr.droppedValues.length === 1
      ? { column, op: 'ne', value: toFilterScalar(fr.droppedValues[0]!) }
      : { column, op: 'notOneOf', value: fr.droppedValues.map(toFilterScalar) };
  }
  return fr.keptValues!.length === 1
    ? { column, op: 'eq', value: toFilterScalar(fr.keptValues![0]!) }
    : { column, op: 'oneOf', value: fr.keptValues!.map(toFilterScalar) };
}

export interface DroppedBuild {
  dedupe?: Dedupe;
  rowFilters: RowFilter[];
}

export function buildDropped(analysis: PairAnalysis, ctx: Ctx): { build: DroppedBuild; assumptions: Assumption[] } | FastPathFailure {
  const dropped = analysis.dropped;
  if (dropped.unexplained.length > 0) return fail('droppedRowsUnexplained');

  const assumptions: Assumption[] = [];
  const build: DroppedBuild = { rowFilters: [] };

  if (dropped.dedupe) {
    if (dropped.dedupe.coverage < 1) return fail('droppedRowsUnexplained', { part: 'dedupe' });
    const keys = dropped.dedupe.keys === 'all' ? 'all' : dropped.dedupe.keys.map((c) => ensureInputColumn(ctx, analysis, c));
    for (const c of dropped.dedupe.in) ctx.usedInputCols.add(c);
    build.dedupe = { keys, keep: dropped.dedupe.keep, action: 'remove' };
  }

  const best = dropped.filters[0];
  if (best) {
    if (best.coverage < 1) return fail('droppedRowsUnexplained', { part: 'filter' });
    if (!best.droppedWhen && !best.droppedValues && !best.keptValues) {
      // Neither value list was small enough to send (SPEC 6.2's MAX_LISTED_VALUES):
      // there is no concrete list of values to write a rule with.
      return fail('droppedRowsUnexplained', { part: 'filterTooManyValues' });
    }
    // A threshold "drop when above X" is kept as "X or below", and an empty cell is never above or below anything,
    // so that rule would silently drop the rows whose cell is empty - rows the example kept (a coverage-1.0 threshold
    // never drops an empty cell: it could not explain that row). What a future empty cell should get is not
    // something the example shows: left to the AI step.
    const thresholdOp = best.droppedWhen !== undefined && best.droppedWhen.op !== 'isEmpty' && best.droppedWhen.op !== 'notEmpty';
    if (thresholdOp && analysis.input.profile[best.in[0]]!.emptyRate > 0) return fail('droppedRowsUnexplained', { part: 'filterKeepsEmpty' });
    const column = ensureInputColumn(ctx, analysis, best.in[0]);
    ctx.usedInputCols.add(best.in[0]);
    build.rowFilters.push(buildRowFilter(best, column, assumptions));
  }

  return { build, assumptions };
}

// ---------------------------------------------------------------------------
// Validations (LEARN_PROMPT step 11)
// ---------------------------------------------------------------------------

function directOutputHeader(outputColumns: readonly { header: string; from: string | null }[], inputId: string): string | undefined {
  return outputColumns.find((c) => c.from === inputId)?.header;
}

const NUMERIC_PROFILE_TYPES: ReadonlySet<ProfileType> = new Set(['integer', 'decimal', 'currency', 'percent']);

export function buildValidations(analysis: PairAnalysis, ctx: Ctx, outputColumns: readonly { header: string; from: string | null }[]): Validation[] {
  const validations: Validation[] = [];
  const entries = [...ctx.inputColumns.entries()].sort((a, b) => a[0] - b[0]);
  for (const [i, col] of entries) {
    const profile = analysis.input.profile[i]!;
    // A check "describes the format itself" (LEARN_PROMPT step 11) when the
    // column feeds an output column unchanged; only then is it put `on:
    // "output"`, keyed by the output header, so it stays with the format when
    // a second source is attached to it (SPEC 8.12). Otherwise it stays a
    // conversion-only, input-side check.
    const outHeader = directOutputHeader(outputColumns, col.id);

    if (profile.israeliId) {
      validations.push(
        outHeader !== undefined
          ? { on: 'output', column: outHeader, rule: 'israeliIdChecksum', severity: 'flag' }
          : { column: col.id, rule: 'israeliIdChecksum', severity: 'flag' },
      );
    }
    if (NUMERIC_PROFILE_TYPES.has(profile.type) && profile.range && typeof profile.range[0] === 'number' && profile.range[0] >= 0) {
      validations.push(
        outHeader !== undefined
          ? { on: 'output', column: outHeader, rule: 'range', min: 0, severity: 'flag' }
          : { column: col.id, rule: 'range', min: 0, severity: 'flag' },
      );
    }
    // DECISION: `unique` only for identifier-like columns (idLike / text). A date or amount
    // column that happens to be all-distinct in one example is a coincidence, not a rule —
    // flagging next month's repeated dates or amounts would just be noise.
    if (profile.key && (profile.type === 'idLike' || profile.type === 'text')) {
      validations.push(
        outHeader !== undefined
          ? { on: 'output', column: outHeader, rule: 'unique', severity: 'flag' }
          : { column: col.id, rule: 'unique', severity: 'flag' },
      );
    }
    // "required for input columns that are never empty and that the output
    // needs" (LEARN_PROMPT step 11): unlike the three checks above, this one
    // is about THIS source's input, so it always stays on the input side.
    if (profile.emptyRate === 0 && ctx.usedInputCols.has(i)) {
      col.required = true;
      validations.push({ column: col.id, rule: 'required', severity: 'flag' });
    }
  }
  return validations;
}

// ---------------------------------------------------------------------------
// IDs stored as numbers (amendment 2026-10-06: numeric IDs on the free path)
// ---------------------------------------------------------------------------

/** Every non-empty cell of input column `i` is a whole number stored as a number (not text, not a date), and there is one at least. */
function inputHoldsWholeNumbers(analysis: PairAnalysis, i: number): boolean {
  let any = false;
  for (const row of analysis.input.rows) {
    const cell = row?.[i];
    if (!cell || cell.v === null || cell.v === '') continue;
    if (typeof cell.v !== 'number' || cell.isDate === true || !Number.isSafeInteger(cell.v)) return false;
    any = true;
  }
  return any;
}

/** Every non-empty cell of the example's output column `out` is a number (not text, not a date), and there is one at least. */
function outputHoldsNumbers(analysis: PairAnalysis, out: number): boolean {
  let any = false;
  for (const sheetRow of analysis.output.dataRows) {
    const cell = analysis.output.sheet.rows[sheetRow]?.[out];
    if (!cell || cell.v === null || cell.v === '') continue;
    if (typeof cell.v !== 'number' || cell.isDate === true) return false;
    any = true;
  }
  return any;
}

/**
 * The bug (amendment 2026-10-06): the profile calls a column of identifiers `idLike` whatever its cells hold - an Israeli ID, a number
 * of 8 digits or more - and the free path declared the input column with that type. But a declared `idLike` is a READING: the engine
 * reads every cell as text (so that `padLeft` can restore zeros) and writes text, while the example output, a copy of IDs stored as
 * numbers, holds numbers - and the verification compares typed (a number is never equal to text that reads like it). A file that only
 * copied a numeric ID column could never pass without the AI.
 *
 * Now an input column the profile calls `idLike` whose cells are all whole numbers stored as numbers is declared `integer`, so it is
 * read and written as the numbers it holds, when every output column that copies it holds numbers in the example and nothing else
 * reads it but a row filter or a dedupe key. A column that is padded (`padLeft`: zero-padded text, which stays text), cut, joined,
 * mapped or written into a template keeps `idLike`, and so does one an output column shows as text. `outputColumns[k]` is the output
 * column built for `analysis.columns[k]` (the fast path and the partial result build them in that order); `alsoReads` is any other part
 * of the rules that names input columns (the checks of an ambiguous column, the partial result's `expand`).
 */
export function declareNumericIds(analysis: PairAnalysis, ctx: Ctx, outputColumns: readonly BuiltOutputColumn[], alsoReads?: unknown): void {
  const otherReaders = JSON.stringify({ computed: ctx.computed, valueMaps: ctx.valueMaps, alsoReads: alsoReads ?? null });
  for (const [i, col] of ctx.inputColumns) {
    if (col.type !== 'idLike' || col.padLeft !== undefined || ctx.templateCols.has(i)) continue;
    if (otherReaders.includes(JSON.stringify(col.id)) || !inputHoldsWholeNumbers(analysis, i)) continue;
    const copies = analysis.columns.map((ca, k) => ({ out: ca.out, from: outputColumns[k]?.from })).filter((c) => c.from === col.id);
    if (copies.length > 0 && copies.every((c) => outputHoldsNumbers(analysis, c.out))) col.type = 'integer';
  }
}

// ---------------------------------------------------------------------------
// Assembly (shared with the local partial result, partial.ts)
// ---------------------------------------------------------------------------

export interface BuiltOutputColumn {
  header: string;
  from: string | null;
  format?: string;
  width?: number;
}

export interface AssembleExtras {
  /** `transform.expand`, when the rows expand (partial.ts only). */
  expand?: NonNullable<RulesTransform['expand']>;
  /** Title rows to write (default: every title row of the example, as constants). */
  titleRows?: TitleRow[];
  unsupported?: LearnResult['unsupported'];
}

/** The rules file from what the builders collected: input columns, computed columns, value maps, dropped-row
 * rules, output columns and validations. The strict fast path and the partial result share this. */
export function assembleRules(
  analysis: PairAnalysis,
  ctx: Ctx,
  outputColumns: BuiltOutputColumn[],
  dropped: DroppedBuild,
  validations: Validation[],
  assumptions: Assumption[],
  extras: AssembleExtras = {},
): LearnResult {
  const input: RulesInput = {
    sheet: { pick: 'first' },
    headerRow: 'auto',
    columns: [...ctx.inputColumns.entries()].sort((a, b) => a[0] - b[0]).map(([, col]) => col),
  };
  if (analysis.input.layout.footerFirstCell.length > 0) {
    input.stopAt = { when: 'firstCellMatches', values: analysis.input.layout.footerFirstCell };
  }
  if (dropped.rowFilters.length > 0) input.rowFilters = dropped.rowFilters;

  const transform: RulesTransform = { computed: ctx.computed, valueMaps: ctx.valueMaps, sort: [] };
  if (dropped.dedupe) transform.dedupe = dropped.dedupe;
  if (extras.expand) transform.expand = extras.expand;

  const titleRows: TitleRow[] =
    extras.titleRows ??
    analysis.layout.titleRows.map((t): TitleRow => {
      if (t.blank) return { blank: true };
      return t.bold ? { text: t.text ?? '', bold: true } : { text: t.text ?? '' };
    });

  const output: RulesOutput = {
    sheetName: analysis.layout.sheetName,
    direction: analysis.layout.direction,
    language: analysis.layout.language,
    titleRows,
    columns: outputColumns,
  };
  if (!isPlainXlsx(analysis.layout.file)) output.file = analysis.layout.file;
  if (analysis.layout.headerBold) output.headerStyle = { bold: true };

  return {
    schemaVersion: 1,
    input,
    transform,
    output,
    validations,
    unsupported: extras.unsupported ?? [],
    assumptions,
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Builds a verified rules file straight from the pair analysis, with no LLM
 * call (SPEC 6.5), or reports why it can't. Strict: every output column must
 * be explained by exactly one coverage-1.0, well-evidenced, hintable relation;
 * dropped rows must be fully (coverage 1.0) explained by dedupe and/or a
 * filter; no rows may expand; and the layout may hold nothing beyond constant
 * title rows.
 */
export function fastPath(analysis: PairAnalysis, preflight: PreflightResult): FastPathResult {
  if (preflight.status === 'block') return fail('blocked');
  if (analysis.shape.kind !== 'plain') return fail('rowsExpand', { shape: analysis.shape.kind });

  const layoutFail = layoutIssue(analysis);
  if (layoutFail) return layoutFail;

  const ctx = newCtx();

  const outputColumns: { header: string; from: string; format?: string; width?: number }[] = [];
  const ambiguous: AmbiguousColumn[] = [];

  for (const ca of analysis.columns) {
    const chosen = chooseColumn(analysis, ca);
    if ('reason' in chosen) return chosen;
    const rel = chosen.relation;

    const from = columnFrom(ctx, analysis, headerFor(analysis, ca, rel), rel);
    if (typeof from !== 'string') return from;
    if (chosen.ambiguity) ambiguous.push(chosen.ambiguity.column);

    const outProfile = analysis.output.profile[ca.out];
    const col: { header: string; from: string; format?: string; width?: number } = { header: headerFor(analysis, ca, rel), from };
    if (outProfile?.format !== undefined) col.format = outProfile.format;
    if (outProfile?.width !== undefined) col.width = outProfile.width;
    outputColumns.push(col);
  }

  const droppedResult = buildDropped(analysis, ctx);
  if ('reason' in droppedResult) return droppedResult;
  const { build: dropped, assumptions } = droppedResult;

  declareNumericIds(analysis, ctx, outputColumns, ambiguous);
  const validations = [...buildValidations(analysis, ctx, outputColumns), ...readingChecks(ambiguous)];

  const rules = assembleRules(analysis, ctx, outputColumns, dropped, validations, assumptions);

  return ambiguous.length > 0 ? { rules, assumptions, ambiguous } : { rules, assumptions };
}

/** A relation can be written as a rule: it has a Hint equivalent (SPEC 6.5), or it is a `split`, which only the formula `split(x, sep, n)` says. */
function hasRuleForm(rel: Relation): boolean {
  return rel.rel === 'split' || rel.rel === 'window' || relationHasHint(rel);
}

/** Groups a relation into an "ambiguity bucket": relations in the same bucket
 * would produce the same value on any future row, so a tie between them isn't
 * a genuine ambiguity. `copy` and `normalize` (with no case change - see
 * `normalizeCase`) tie at coverage 1.0 together whenever the text needs no
 * whitespace/quote cleanup at all - precisely the ordinary case of an
 * already-clean column copied as-is - so they share a bucket keyed by source
 * column; every other relation gets its own bucket keyed by kind + operands,
 * so e.g. two `copy`s of *different* source columns (or `copy` vs `mulConst`)
 * are correctly seen as different buckets. */
function ambiguityBucket(r: Relation): string {
  if (r.rel === 'copy' || r.rel === 'normalize') return `text:${r.in[0]}`;
  if (r.rel === 'template') return `template:${JSON.stringify(r.parts)}`;
  // Two readings of an across-row column (another amount, another group column) are different rules next month.
  if (r.rel === 'window') return `window:${r.fn}:${r.in.join(',')}:${r.by.join(',')}`;
  return `${r.rel}:${r.in.join(',')}`;
}

/**
 * SPEC 6.5 eligibility for one output column, and which relation to build it
 * from: exactly one coverage-1.0 relation (after resolving the copy/normalize
 * non-ambiguity above), with a rule form (a Hint equivalent, `relationHasHint`:
 * SPEC 6.5 requires a *hint* at coverage 1.0; `split` has none - see hints.ts -
 * but is written as the formula `split(x, sep, n)`, see `hasRuleForm`), and
 * enough evidence (a mulConst/addConst seen on fewer than 3 distinct non-zero
 * values, or with a long constant that only fits after rounding; a valueMap
 * whose every key appears only once or that must write numbers; a split that
 * cuts fewer than 3 different texts, or whose position the example cannot fix).
 *
 * DECISION: when several relations tie (genuine ambiguity, e.g. `mulConst` vs
 * `valueMap` on data with too few distinct values to tell them apart), thin
 * evidence is checked first and reported in preference to `ambiguousColumn`:
 * it is the more fundamental problem - the tie exists only *because* the data
 * doesn't yet distinguish the readings, not because the data supports two
 * solid, competing interpretations.
 */
export function chooseColumnRelation(analysis: PairAnalysis, ca: ColumnAnalysis): Relation | FastPathFailure {
  let c1 = ca.relations.filter((r) => r.coverage === 1);
  // DECISION: one value on every row that the input can write too (a copy of a column, the month or year of a date column,
  // a fixed part of a text: relations.ts `constantSources`) is a label or a value of the data - the example cannot say which,
  // and a label built as a constant is wrong next month. Whatever else fits the column (a copy, a date format, ...) fits just
  // as well: nothing is built HERE. `chooseColumn` (above) builds the data reading and asks the user when there is one (`ambiguityOf`);
  // this is what is left - no data reading code can write as a rule - and the AI step or the user decides. Only an across-row
  // relation (a group's total, a count per group) that holds on every row still outranks it, as it outranks any lookalike below.
  if (ca.derivableConstant !== undefined && !c1.some((r) => r.rel === 'window')) return fail('ambiguousColumn', { column: ca.out });
  if (c1.length === 0) return fail('columnNotFullyExplained', { column: ca.out });
  // An across-row relation (a group's total, a count per group) ranks above the lookalikes the same cells also fit (a value map of the
  // group key, a constant): only the across-row readings compete with each other.
  if (c1.some((r) => r.rel === 'window')) c1 = c1.filter((r) => r.rel === 'window');
  // An across-row pattern that holds on every row but is not one the free engine writes (a running total, a row number, a rank ...) is
  // the truth about this column: a lookalike (a value map of the key, a constant) must not be built in its place. The AI step gets it.
  if (ca.windows?.some((w) => w.coverage === 1 && !w.built) === true && !c1.some((r) => r.rel === 'window')) {
    return fail('columnNotFullyExplained', { column: ca.out });
  }
  const buckets = new Set(c1.map(ambiguityBucket));
  if (buckets.size >= 2) {
    for (const r of c1) {
      const thin = thinEvidenceIssue(analysis, r);
      if (thin) return thin;
    }
    return fail('ambiguousColumn', { column: ca.out });
  }
  const rel = c1.find((r) => r.rel === 'copy') ?? c1[0]!;
  if (!hasRuleForm(rel)) return fail('columnNotFullyExplained', { column: ca.out });
  const thin = thinEvidenceIssue(analysis, rel);
  if (thin) return thin;
  return rel;
}

// ---------------------------------------------------------------------------
// Ambiguous columns: a constant the input could write too (SPEC 6.2 step 4, 6.5, 21 v12 item 11)
// ---------------------------------------------------------------------------

/** At most this many data readings of one column are offered next to the constant: the question stays short. */
const MAX_DATA_READINGS = 2;

/** One ambiguous column, with the data reading the free engine builds until the user answers. */
export interface Ambiguity {
  column: AmbiguousColumn;
  relation: Relation;
}

/** A relation as a rule fragment: built the way the strict path builds it, in a context of its own (so its ids are local to it). */
function fragmentOf(analysis: PairAnalysis, header: string, rel: Relation): RuleFragment | null {
  if (!rel.in.every((i) => i < analysis.input.columnCount)) return null; // (a column a family creates is declared by the expand, not here)
  const ctx = newCtx();
  try {
    const from = columnFrom(ctx, analysis, header, rel);
    if (typeof from !== 'string') return null;
    return {
      from,
      inputColumns: [...ctx.inputColumns.entries()].sort((a, b) => a[0] - b[0]).map(([, col]) => col),
      computed: [...ctx.computed],
      valueMaps: [...ctx.valueMaps],
    };
  } catch {
    return null;
  }
}

/**
 * The competing readings of a column that holds one value on every row that the input can write too (relations.ts `constantSources`),
 * or null when it is not one, or when the data has no reading code can write as a rule (a date column that mixes several formats: the
 * month of it has no rule here) - such a column is still not built and goes to the AI step, as before.
 *
 * DECISION (owner, 2026-10-04): the AI step sees the same rows as the free engine, so sending the column to it is pointless; the user
 * knows which reading is meant. The readings are the constant and each data reading the example proves on EVERY row (the relations
 * the guard found at coverage 1.0: a copy of a column, a prefix, a part of a split text, a date format), as ready-to-apply fragments.
 * The default is the data reading (it follows next month's data; a constant built by guess is wrong next month), with a check that flags
 * a row where it differs from the constant. A data reading must pass the same evidence rules as any built relation (`thinEvidenceIssue`).
 * Only a text or number constant: a boolean would need a different check.
 */
export function ambiguityOf(analysis: PairAnalysis, ca: ColumnAnalysis): Ambiguity | null {
  const value = ca.derivableValue;
  if (ca.derivableConstant === undefined || (typeof value !== 'string' && typeof value !== 'number')) return null;
  const c1 = ca.relations.filter((r) => r.coverage === 1);
  // An across-row relation that holds on every row outranks any lookalike, as everywhere else.
  if (c1.some((r) => r.rel === 'window')) return null;

  // One data reading per input column (the best ranked: the user chooses between "the constant" and "what column X says", not between
  // two ways of cutting the same text); a copy and a normalized copy of a column are one reading, the plain copy.
  const bySource = new Map<string, Relation>();
  for (const r of c1) {
    if (r.rel === 'constant' || r.rel === 'aggregate' || !hasRuleForm(r) || thinEvidenceIssue(analysis, r)) continue;
    const source = r.in.join(',');
    const held = bySource.get(source);
    if (held === undefined || (r.rel === 'copy' && held.rel !== 'copy')) bySource.set(source, r);
  }

  const data: { rel: Relation; header: string; fragment: RuleFragment }[] = [];
  for (const rel of bySource.values()) {
    if (data.length >= MAX_DATA_READINGS) break;
    const header = headerFor(analysis, ca, rel);
    const fragment = fragmentOf(analysis, header, rel);
    if (fragment !== null) data.push({ rel, header, fragment });
  }
  const first = data[0];
  if (first === undefined) return null;

  const total = analysis.alignment.rows.length;
  const constant: Relation = { rel: 'constant', in: [], value, out: ca.out, coverage: 1, matched: total, total, failing: [], failCount: 0 };
  const constantFragment = fragmentOf(analysis, first.header, constant);
  if (constantFragment === null) return null;

  const headers = (rel: Relation): string[] => rel.in.map((i) => analysis.input.profile[i]?.header ?? '');
  const readings: ColumnReading[] = [
    { kind: 'constant', columns: [], fragment: constantFragment },
    ...data.map((d): ColumnReading => ({ kind: d.rel.rel, columns: headers(d.rel), fragment: d.fragment })),
  ];
  const column: AmbiguousColumn = {
    out: ca.out,
    header: first.header,
    readings,
    defaultReading: 1,
    // The default reading writes the data's value; the check flags a row where it is not the constant.
    check: { on: 'output', column: first.header, rule: 'oneOf', values: [String(value)], severity: 'flag' },
    value,
  };
  return { column, relation: first.rel };
}

/** The columns of the example's output that fit more than one rule, each with its readings (see `ambiguityOf`). */
export function ambiguousColumns(analysis: PairAnalysis): AmbiguousColumn[] {
  const out: AmbiguousColumn[] = [];
  for (const ca of analysis.columns) {
    const a = ambiguityOf(analysis, ca);
    if (a) out.push(a.column);
  }
  return out;
}

/** The checks that go with unanswered questions (readings.ts `AmbiguousColumn.check`). */
export function readingChecks(columns: readonly AmbiguousColumn[]): Validation[] {
  return columns.flatMap((c) => (c.check === null ? [] : [c.check]));
}

/**
 * The relation to build one output column from, or why it can't be built. Like `chooseColumnRelation`, except that a column the
 * example fits more than one rule for (`ambiguityOf`) is built from its data reading and says so: the question goes to the user.
 */
export function chooseColumn(analysis: PairAnalysis, ca: ColumnAnalysis): { relation: Relation; ambiguity?: Ambiguity } | FastPathFailure {
  const ambiguity = ambiguityOf(analysis, ca);
  if (ambiguity) return { relation: ambiguity.relation, ambiguity };
  const chosen = chooseColumnRelation(analysis, ca);
  return 'reason' in chosen ? chosen : { relation: chosen };
}

/** SPEC 8.13: a headerless output's columns still need a header, "used in the
 * UI and for matching"; the analysis has none to offer (there is no header
 * row), so this falls back to the source input column's own header. */
export function headerFor(analysis: PairAnalysis, ca: ColumnAnalysis, rel: Relation): string {
  if (ca.header !== '') return ca.header;
  const i = rel.in[0];
  if (i !== undefined) return analysis.input.profile[i]?.header ?? `column${ca.out + 1}`;
  return `column${ca.out + 1}`;
}
