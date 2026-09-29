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
import { relationHasHint } from './hints';
import type { PreflightResult } from './preflight';

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
}

export type FastPathResult = FastPathSuccess | FastPathFailure;

function fail(reason: FastPathReasonCode, params?: Record<string, string | number>): FastPathFailure {
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
function freshId(header: string, fallback: string, used: Set<string>): string {
  let base = slug(header);
  if (base === '' || /^[0-9]/.test(base)) base = fallback;
  let id = base;
  let n = 2;
  while (used.has(id)) id = `${base}${n++}`;
  used.add(id);
  return id;
}

function columnType(p: ProfileType): ColumnType {
  return p === 'empty' ? 'text' : p;
}

function isPlainXlsx(f: OutputFileSpec): boolean {
  return f.type === 'xlsx' && f.delimiter === undefined && f.header === undefined && f.encoding === undefined && f.quote === undefined;
}

// ---------------------------------------------------------------------------
// Build context
// ---------------------------------------------------------------------------

interface Ctx {
  usedIds: Set<string>;
  /** Input column index -> declared id, created lazily on first use. */
  inputIds: Map<number, string>;
  /** Input column index -> its (mutable) InputColumn declaration. */
  inputColumns: Map<number, InputColumn>;
  computed: Computed[];
  valueMaps: ValueMap[];
  /** Input columns actually fed into a rule (output, filter or dedupe key). */
  usedInputCols: Set<number>;
}

function ensureInputColumn(ctx: Ctx, analysis: PairAnalysis, i: number): string {
  const existing = ctx.inputIds.get(i);
  if (existing !== undefined) return existing;
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

// ---------------------------------------------------------------------------
// Layout eligibility (SPEC 6.5: "nothing beyond constant title rows")
// ---------------------------------------------------------------------------

function layoutIssue(analysis: PairAnalysis): FastPathFailure | null {
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

function thinEvidenceIssue(analysis: PairAnalysis, rel: Relation): FastPathFailure | null {
  if (rel.rel === 'mulConst' || rel.rel === 'addConst') {
    if (distinctNonZeroCount(analysis, rel.in[0]) < 3) return fail('thinEvidence', { column: rel.out, relation: rel.rel });
  }
  if (rel.rel === 'valueMap') {
    if (!valueMapHasRepeat(analysis, rel.in[0])) return fail('thinEvidence', { column: rel.out, relation: rel.rel });
  }
  return null;
}

// ---------------------------------------------------------------------------
// One output column's rule, from its chosen relation
// ---------------------------------------------------------------------------

function columnFrom(ctx: Ctx, analysis: PairAnalysis, outHeader: string, rel: Relation): string | FastPathFailure {
  const input = (i: number): string => ensureInputColumn(ctx, analysis, i);
  const use = (i: number): void => void ctx.usedInputCols.add(i);

  switch (rel.rel) {
    case 'copy': {
      use(rel.in[0]);
      return input(rel.in[0]);
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
        const col = ctx.inputColumns.get(rel.in[0])!;
        if (col.padLeft !== undefined && col.padLeft !== rel.length) {
          return fail('columnNotFullyExplained', { column: outHeader });
        }
        col.padLeft = rel.length;
        return inputId;
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
    case 'valueMap': {
      use(rel.in[0]);
      const inputId = input(rel.in[0]);
      ctx.valueMaps.push({ column: inputId, map: Object.fromEntries(rel.pairs), onMissing: 'flag' });
      return inputId;
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
        return inputId;
      }
      const id = newComputedId(ctx, outHeader);
      ctx.computed.push({ id, type: 'text', expr: { op: 'dateFormat', arg: { col: inputId }, format: rel.to } });
      return id;
    }
    case 'numberFormat': {
      use(rel.in[0]);
      const id = newComputedId(ctx, outHeader);
      ctx.computed.push({ id, type: 'text', expr: { op: 'toText', arg: { col: input(rel.in[0]) }, format: rel.format } });
      return id;
    }
    case 'mulConst':
    case 'addConst': {
      use(rel.in[0]);
      const inner: Expr = { op: rel.rel === 'mulConst' ? 'mul' : 'add', args: [{ col: input(rel.in[0]) }, { const: rel.const }] };
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
    // Unreachable in practice: 'aggregate' only appears for summary shapes
    // (the shape check above already rejects them), and 'split' has no Hint
    // equivalent, so bestHintableRelation/relationHasHint never choose it.
    case 'aggregate':
    case 'split':
      return fail('columnNotFullyExplained', { column: outHeader });
  }
}

// ---------------------------------------------------------------------------
// Dropped rows: dedupe and/or the best filter (SPEC 6.5: "fully explained")
// ---------------------------------------------------------------------------

function toFilterScalar(v: PayloadCell): FilterScalar {
  return v;
}

function buildRowFilter(fr: FilterRelation, column: string, assumptions: Assumption[]): RowFilter {
  if (fr.droppedWhen) {
    const { op, value } = fr.droppedWhen;
    if (op === 'isEmpty' || op === 'notEmpty') return { column, op };
    return { column, op, value: value! };
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

interface DroppedBuild {
  dedupe?: Dedupe;
  rowFilters: RowFilter[];
}

function buildDropped(analysis: PairAnalysis, ctx: Ctx): { build: DroppedBuild; assumptions: Assumption[] } | FastPathFailure {
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
    const column = ensureInputColumn(ctx, analysis, best.in[0]);
    ctx.usedInputCols.add(best.in[0]);
    build.rowFilters.push(buildRowFilter(best, column, assumptions));
  }

  return { build, assumptions };
}

// ---------------------------------------------------------------------------
// Validations (LEARN_PROMPT step 11)
// ---------------------------------------------------------------------------

function directOutputHeader(outputColumns: readonly { header: string; from: string }[], inputId: string): string | undefined {
  return outputColumns.find((c) => c.from === inputId)?.header;
}

const NUMERIC_PROFILE_TYPES: ReadonlySet<ProfileType> = new Set(['integer', 'decimal', 'currency', 'percent']);

function buildValidations(analysis: PairAnalysis, ctx: Ctx, outputColumns: readonly { header: string; from: string }[]): Validation[] {
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
    if (profile.key) {
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

  const ctx: Ctx = {
    usedIds: new Set(),
    inputIds: new Map(),
    inputColumns: new Map(),
    computed: [],
    valueMaps: [],
    usedInputCols: new Set(),
  };

  const outputColumns: { header: string; from: string; format?: string; width?: number }[] = [];

  for (const ca of analysis.columns) {
    const chosen = chooseColumnRelation(analysis, ca);
    if ('reason' in chosen) return chosen;
    const rel = chosen;

    const from = columnFrom(ctx, analysis, headerFor(analysis, ca, rel), rel);
    if (typeof from !== 'string') return from;

    const outProfile = analysis.output.profile[ca.out];
    const col: { header: string; from: string; format?: string; width?: number } = { header: headerFor(analysis, ca, rel), from };
    if (outProfile?.format !== undefined) col.format = outProfile.format;
    if (outProfile?.width !== undefined) col.width = outProfile.width;
    outputColumns.push(col);
  }

  const droppedResult = buildDropped(analysis, ctx);
  if ('reason' in droppedResult) return droppedResult;
  const { build: dropped, assumptions } = droppedResult;

  const validations = buildValidations(analysis, ctx, outputColumns);

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

  const titleRows: TitleRow[] = analysis.layout.titleRows.map((t): TitleRow => {
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

  const rules: LearnResult = {
    schemaVersion: 1,
    input,
    transform,
    output,
    validations,
    unsupported: [],
    assumptions,
  };

  return { rules, assumptions };
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
  return `${r.rel}:${r.in.join(',')}`;
}

/**
 * SPEC 6.5 eligibility for one output column, and which relation to build it
 * from: exactly one coverage-1.0 relation (after resolving the copy/normalize
 * non-ambiguity above), with a Hint equivalent (`relationHasHint`, since SPEC
 * 6.5 requires a *hint* at coverage 1.0, and `split` has none - see hints.ts),
 * and enough evidence (task: a mulConst/addConst seen on fewer than 3 distinct
 * non-zero values, or a valueMap whose every key appears only once).
 *
 * DECISION: when several relations tie (genuine ambiguity, e.g. `mulConst` vs
 * `valueMap` on data with too few distinct values to tell them apart), thin
 * evidence is checked first and reported in preference to `ambiguousColumn`:
 * it is the more fundamental problem - the tie exists only *because* the data
 * doesn't yet distinguish the readings, not because the data supports two
 * solid, competing interpretations.
 */
function chooseColumnRelation(analysis: PairAnalysis, ca: ColumnAnalysis): Relation | FastPathFailure {
  const c1 = ca.relations.filter((r) => r.coverage === 1);
  if (c1.length === 0) return fail('columnNotFullyExplained', { column: ca.out });
  const buckets = new Set(c1.map(ambiguityBucket));
  if (buckets.size >= 2) {
    for (const r of c1) {
      const thin = thinEvidenceIssue(analysis, r);
      if (thin) return thin;
    }
    return fail('ambiguousColumn', { column: ca.out });
  }
  const rel = c1.find((r) => r.rel === 'copy') ?? c1[0]!;
  if (!relationHasHint(rel)) return fail('columnNotFullyExplained', { column: ca.out });
  const thin = thinEvidenceIssue(analysis, rel);
  if (thin) return thin;
  return rel;
}

/** SPEC 8.13: a headerless output's columns still need a header, "used in the
 * UI and for matching"; the analysis has none to offer (there is no header
 * row), so this falls back to the source input column's own header. */
function headerFor(analysis: PairAnalysis, ca: ColumnAnalysis, rel: Relation): string {
  if (ca.header !== '') return ca.header;
  const i = rel.in[0];
  if (i !== undefined) return analysis.input.profile[i]?.header ?? `column${ca.out + 1}`;
  return `column${ca.out + 1}`;
}
