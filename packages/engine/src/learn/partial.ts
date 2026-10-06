// The local partial result (SPEC 21 v5 item 1): what code alone can build from the pair analysis when
// the example needs the AI step (the caller may not use it yet). Like the strict fast path
// (fastPath.ts, same builders) but tolerant: every output column the code explained (one coverage-1.0,
// unambiguous, well-evidenced relation) gets its rule; EVERY other output column gets `from: null` and
// comes back listed as "needs the AI step". "Code found no relation" is not certainty (SPEC 6.4, 21 v7 note):
// a column no detector explained (EXTERNAL: no relation, not derived either - maybe reformatted numbers or
// dates, a calculation mixed in) is listed in `needsAi` too, and also in `external`, only so the UI can say it
// "may come from another source". It is never put in `rules.unsupported`: only the AI step says that.
// A DERIVED column - unexplained by any relation, yet determined by the input (bands on a number, a
// category dependency; see analyze/derived.ts) - needs the AI step, and is not in `external`. So does a
// column banded on another output column the input computes (a class by a total, `onOut`, owner amendment
// 2026-10-05): it is derived like any other, and the total column itself is built here as usual.
//
// Structure the strict path refuses outright is built here only where the analysis says exactly what
// it is, and otherwise reported in `needsAiParts` instead of guessed:
//   - the two simple family patterns (columns to rows, split cell) become `transform.expand`, straight
//     from the pattern the analysis verified on every family;
//   - dedupe and a filter are built when they explain every dropped row (as in the strict path);
//   - constant title rows are kept; a title with a date from the data is not;
//   - sort, groups, summary rows, blank rows, a summary output and a fixed fan-out are not built.
// A partial result is never saved as a conversion: it is the local result shown before the AI step
// (5 E).

import type { AiStepPartCode, Assumption, ColumnType, Expand, LearnResult, TitleRow } from '@formatai/shared';
import { AI_STEP_PART_CODES } from '@formatai/shared';
import { isExternalColumn, type ColumnAnalysis, type PairAnalysis, type Relation } from './analyze';
import {
  assembleRules,
  buildDropped,
  buildValidations,
  builtOutputFormat,
  chooseColumn,
  columnFrom,
  declareNumericIds,
  ensureInputColumn,
  fail,
  freshId,
  headerFor,
  newCtx,
  readingChecks,
  restoreCtx,
  snapshotCtx,
  type BuiltOutputColumn,
  type Ctx,
  type DroppedBuild,
  type FastPathFailure,
} from './fastPath';
import type { PreflightResult } from './preflight';
import type { AmbiguousColumn } from './readings';

export interface PartialRulesResult {
  /** Rules that load and run: solved columns are built, the rest have `from: null` (and are not in `unsupported`: only the AI step reports that). */
  rules: LearnResult;
  assumptions: Assumption[];
  /** Headers of the output columns code built and can check against the example. */
  solved: string[];
  /** Headers of every column that needs the AI step (including `external`). */
  needsAi: string[];
  /** The subset of `needsAi` whose values code could not find in the input file at all: they "may come from another source" (wording only; the AI step still tries them). */
  external: string[];
  /** Output column positions (0-based) of `solved`, for `verifyAgainstExample`'s `onlyColumns`. */
  solvedColumns: number[];
  /** What besides columns still needs the AI step (rows that change shape, dropped rows, sort, groups...). */
  needsAiParts: AiStepPartCode[];
  /**
   * The columns built here whose example fits more than one rule (a constant the input could write too): each is in `solved`, built from its
   * data reading with the check that flags a row where the readings differ, and is a question for the user - never for the AI step.
   */
  ambiguous: AmbiguousColumn[];
}

export type PartialRulesOutcome = PartialRulesResult | FastPathFailure;

const NUMERIC_TYPES: ReadonlySet<ColumnType> = new Set<ColumnType>(['integer', 'decimal', 'currency', 'percent']);

/** The header shown for an output column that was not built (a headerless output falls back to its source's header). */
function looseHeader(analysis: PairAnalysis, ca: ColumnAnalysis): string {
  if (ca.header !== '') return ca.header;
  const rel = ca.relations[0];
  return rel !== undefined ? headerFor(analysis, ca, rel) : `column${ca.out + 1}`;
}

// ---------------------------------------------------------------------------
// Expand, from a family pattern
// ---------------------------------------------------------------------------

/** Whether some coverage-1.0 relation of an output column reads the family column created at `index`. */
function createdIndexUsed(analysis: PairAnalysis, index: number): boolean {
  return analysis.columns.some((ca) => ca.relations.some((r) => r.coverage === 1 && (r.in as readonly number[]).includes(index)));
}

function buildExpand(analysis: PairAnalysis, ctx: Ctx): Expand | null {
  const shape = analysis.shape;
  if (shape.kind !== 'families') return null;
  const p = shape.pattern;
  const created = (kind: string): number | undefined => shape.created.find((c) => c.kind === kind)?.index;
  const outHeader = (out: number): string => analysis.columns[out]?.header ?? '';

  if (p.mode === 'columnsToRows') {
    const columns = p.in.map((i) => ensureInputColumn(ctx, analysis, i));
    p.in.forEach((i) => ctx.usedInputCols.add(i));
    const labelId = freshId(outHeader(p.labelOut), 'label', ctx.usedIds);
    const valueId = freshId(outHeader(p.valueOut), 'value', ctx.usedIds);
    const labelIndex = created('label');
    const valueIndex = created('value');
    if (labelIndex !== undefined) ctx.createdIds.set(labelIndex, labelId);
    if (valueIndex !== undefined) ctx.createdIds.set(valueIndex, valueId);
    const types = new Set(p.in.map((i) => ctx.inputColumns.get(i)!.type));
    const only = types.size === 1 ? [...types][0]! : undefined;
    const valueType: ColumnType = only ?? ([...types].every((t) => NUMERIC_TYPES.has(t)) ? 'decimal' : 'text');
    return { mode: 'columnsToRows', columns, labelId, valueId, valueType, skipEmpty: p.skipEmpty };
  }

  if (p.mode === 'splitCell') {
    const column = ensureInputColumn(ctx, analysis, p.in[0]);
    ctx.usedInputCols.add(p.in[0]);
    const partId = freshId(outHeader(p.out), 'part', ctx.usedIds);
    const partIndex = created('part');
    if (partIndex !== undefined) ctx.createdIds.set(partIndex, partId);
    const expand: Extract<Expand, { mode: 'splitCell' }> = { mode: 'splitCell', column, separator: p.separator, trim: p.trim, partId, skipEmpty: p.skipEmpty };
    const positionIndex = created('position');
    if (positionIndex !== undefined && createdIndexUsed(analysis, positionIndex)) {
      expand.indexId = freshId('position', 'position', ctx.usedIds);
      ctx.createdIds.set(positionIndex, expand.indexId);
    }
    const countIndex = created('count');
    if (countIndex !== undefined && createdIndexUsed(analysis, countIndex)) {
      expand.countId = freshId('count', 'count', ctx.usedIds);
      ctx.createdIds.set(countIndex, expand.countId);
    }
    return expand;
  }

  return null; // fixedFanOut: each position has its own rule; left to the AI step
}

// ---------------------------------------------------------------------------
// Layout parts the local build doesn't reproduce
// ---------------------------------------------------------------------------

function layoutParts(analysis: PairAnalysis): Set<AiStepPartCode> {
  const parts = new Set<AiStepPartCode>();
  const layout = analysis.layout;
  if (layout.groupBy !== null) parts.add('group');
  if (layout.summaryRows.length > 0) parts.add('summaryRows');
  if (layout.sort !== null) parts.add('sort');
  if (layout.titleRows.some((t) => t.containsDate !== undefined)) parts.add('dateTitle');
  if (layout.unexplainedBlankRows.length > 0) parts.add('blankRows');
  return parts;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Builds what code can build from the pair analysis - see the file header. Returns `{ reason: 'blocked' }`
 * when pre-flight blocked the pair (there is nothing to build for a pair that can't be learned at all).
 */
export function partialRules(analysis: PairAnalysis, preflight: PreflightResult): PartialRulesOutcome {
  if (preflight.status === 'block') return fail('blocked');

  const ctx = newCtx();
  const parts = layoutParts(analysis);

  // ---- the shape of the rows ----
  let expand: Expand | null = null;
  let rowsBuilt = analysis.shape.kind === 'plain';
  if (analysis.shape.kind === 'families') {
    expand = buildExpand(analysis, ctx);
    rowsBuilt = expand !== null;
  }
  if (!rowsBuilt) parts.add('rows');

  // ---- columns ----
  const outputColumns: BuiltOutputColumn[] = [];
  const solved: string[] = [];
  const needsAi: string[] = [];
  const external: string[] = [];
  const solvedColumns: number[] = [];
  const ambiguous: AmbiguousColumn[] = [];

  for (const ca of analysis.columns) {
    // Neither a derived column nor an external one is built here: both "need the AI step" (external only changes the wording).
    const isExternal = isExternalColumn(ca);
    let from: string | null = null;
    let header = looseHeader(analysis, ca);

    if (rowsBuilt && !isExternal) {
      const chosen = chooseColumn(analysis, ca);
      if (!('reason' in chosen) && operandsAvailable(analysis, ctx, chosen.relation)) {
        const rel = chosen.relation;
        const snap = snapshotCtx(ctx);
        const built = columnFrom(ctx, analysis, headerFor(analysis, ca, rel), rel);
        if (typeof built === 'string') {
          from = built;
          header = headerFor(analysis, ca, rel);
          if (chosen.ambiguity) ambiguous.push(chosen.ambiguity.column);
        } else {
          restoreCtx(ctx, snap);
        }
      }
    }

    const outProfile = analysis.output.profile[ca.out];
    const col: BuiltOutputColumn = { header, from };
    const format = builtOutputFormat(analysis, ca.out);
    if (format !== undefined) col.format = format;
    if (outProfile?.width !== undefined) col.width = outProfile.width;
    outputColumns.push(col);

    if (from !== null) {
      solved.push(header);
      solvedColumns.push(ca.out);
    } else {
      needsAi.push(header);
      if (isExternal) external.push(header);
    }
  }

  // ---- dropped rows: only when fully explained, exactly as the strict path builds them ----
  let dropped: DroppedBuild = { rowFilters: [] };
  let assumptions: Assumption[] = [];
  if (rowsBuilt) {
    const snap = snapshotCtx(ctx);
    const built = buildDropped(analysis, ctx);
    if ('reason' in built) {
      restoreCtx(ctx, snap);
      // Nothing to explain when no input row was dropped; a `droppedRowsUnexplained` result means some were.
      parts.add('droppedRows');
    } else {
      dropped = built.build;
      assumptions = built.assumptions;
    }
  }

  // ---- input columns: the schema needs at least one ----
  if (ctx.inputColumns.size === 0 && analysis.input.columnCount > 0) ensureInputColumn(ctx, analysis, 0);

  // An ID column stored as numbers that the output copies as numbers is read as numbers (amendment 2026-10-06, see fastPath.ts).
  declareNumericIds(analysis, ctx, outputColumns, { expand, ambiguous });

  // A columns-to-rows expand removes the columns it turns into rows, so no input-side check can name them.
  const consumed = new Set(expand?.mode === 'columnsToRows' ? expand.columns : []);
  const validations = [...buildValidations(analysis, ctx, outputColumns).filter((v) => v.on === 'output' || !consumed.has(v.column)), ...readingChecks(ambiguous)];

  const titleRows: TitleRow[] = analysis.layout.titleRows
    .filter((t) => t.containsDate === undefined)
    .map((t): TitleRow => (t.blank ? { blank: true } : t.bold ? { text: t.text ?? '', bold: true } : { text: t.text ?? '' }));

  const rules = assembleRules(analysis, ctx, outputColumns, dropped, validations, assumptions, {
    ...(expand ? { expand } : {}),
    titleRows,
  });

  return {
    rules,
    assumptions,
    solved,
    needsAi,
    external,
    solvedColumns,
    needsAiParts: AI_STEP_PART_CODES.filter((code) => parts.has(code)),
    ambiguous,
  };
}

/** A relation can be built only when each operand is an input column, or a family column the expand declares. */
function operandsAvailable(analysis: PairAnalysis, ctx: Ctx, rel: Relation): boolean {
  return rel.in.every((i) => i < analysis.input.columnCount || ctx.createdIds.has(i));
}
