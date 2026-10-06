// Amendment 2026-10-06 (SPEC 7.2): identifiers stored as numbers are masked. The type each column of the example is MASKED as - the
// one `Masker.maskCell` is given - which is the profile's type, except:
//   - an INTEGER input column the pair analysis shows to be an identifier, not a measure, is masked as `idLike` (`identifierColumns`);
//   - an output column that copies an ID column is masked as `idLike` too, whatever its profile type (a text one too: stress test), so a
//     sample's `in` and `out` carry the same fake and the AI step still sees the copy.
// `idLike` columns are ID columns whatever their cells hold (the masker masks a number in one as its digits). A measure (an amount, a
// quantity) stays real: rules cannot be learned without it, and the server's sample run computes on the values the payload carries.
//
// Every path that sends cells with masking on reads its types here, so the same value gets the same fake everywhere: the payload's
// samples, dropped rows and hint values (`payload.ts`), the learning loop's rows (`loop.ts`, `payload.ts` `counterexampleSample`), and the
// rows and values in the full verification's repair problems (`verify.ts`).
//
// Pure, synchronous and computed from the pair analysis alone (cached per analysis).

import { maskingIdentifiers, type ProfileType, type SummaryAgg, type SummaryRowLayout, type WindowFn } from '@formatai/shared';
import type { ColumnAnalysis, ColumnProfile, PairAnalysis, Relation } from './analyze';
import { bestHintableRelation } from './hints';

export interface MaskTypes {
  /** Per input column: the type its cells are masked as. */
  input: ProfileType[];
  /** Per output column: the type its cells are masked as. */
  output: ProfileType[];
}

/** Relations that compute the output from the operand's value: an operand of one is a measure. */
const ARITHMETIC: ReadonlySet<string> = new Set(['mulConst', 'addConst', 'add', 'sub', 'mul', 'div', 'sum']);
/** Relations whose output IS the operand's value (a copy): an output column that copies an ID column is masked like it. */
const COPIES: ReadonlySet<string> = new Set(['copy', 'normalize']);
/** Window functions that compute with the column they read. */
const NUMERIC_WINDOW_FNS: ReadonlySet<WindowFn> = new Set<WindowFn>(['runningSum', 'groupSum', 'groupAvg', 'groupMin', 'groupMax']);
/** Aggregates that compute with the column's values (a group's `aggregate` relation, a summary row's cell). */
const NUMERIC_AGGS: ReadonlySet<SummaryAgg> = new Set<SummaryAgg>(['sum', 'min', 'max', 'average']);
/** A filter threshold: the rows dropped are those above or below a number of the column. */
const THRESHOLD_OPS: ReadonlySet<string> = new Set(['gt', 'gte', 'lt', 'lte']);

/** Every column analysis of the pair: one per output column, and one per output column and position of a fixed fan-out. */
function columnAnalyses(analysis: PairAnalysis): ColumnAnalysis[] {
  const all = [...analysis.columns];
  if (analysis.shape.kind === 'families' && analysis.shape.pattern.mode === 'fixedFanOut') {
    for (const position of analysis.shape.pattern.positions) all.push(...position);
  }
  return all;
}

/** The input columns each output column is a copy of (a `COPIES` relation, at the analysis' minimum coverage), by output column. */
function copiedInputs(analysis: PairAnalysis): Map<number, Set<number>> {
  const copied = new Map<number, Set<number>>();
  for (const ca of columnAnalyses(analysis)) {
    for (const r of ca.relations) {
      const i = r.in[0];
      if (!COPIES.has(r.rel) || i === undefined || i >= analysis.input.columnCount) continue;
      const set = copied.get(ca.out) ?? new Set<number>();
      set.add(i);
      copied.set(ca.out, set);
    }
  }
  return copied;
}

/** The relations that explain a column: its best one, and the best one the AI step is hinted (they differ only past a `split`). */
function explaining(ca: ColumnAnalysis): Relation[] {
  const best = ca.relations[0];
  const hinted = bestHintableRelation(ca);
  return [...(best ? [best] : []), ...(hinted && hinted !== best ? [hinted] : [])];
}

/**
 * The input columns some output column computes with, so are measures (or dates), never identifiers, whatever their values look like: the
 * operands of the arithmetic, numeric aggregate or number/date format that explains an output column, of its window pattern (or its order),
 * the column its bands are sorted by (or computed from), the best filter's threshold column, the cells a columns-to-rows pattern turns into
 * rows, a date title's column, and the column an output column copies when a summary row totals it.
 * DECISION: only what EXPLAINS a column counts - its best relation (the hint the AI step gets), not every partial relation the tests found
 * at 90% coverage: a 0/1 column is `round(a / b)` on 11 rows of 12 by chance, and that must not send an ID column real.
 */
export function measureColumns(analysis: PairAnalysis): Set<number> {
  const used = new Set<number>();
  const add = (cols: readonly number[]): void => {
    for (const c of cols) if (c < analysis.input.columnCount) used.add(c);
  };
  for (const ca of columnAnalyses(analysis)) {
    for (const r of explaining(ca)) {
      if (ARITHMETIC.has(r.rel)) add(r.in);
      else if (r.rel === 'aggregate' && NUMERIC_AGGS.has(r.fn)) add(r.in);
      else if (r.rel === 'window' && r.fn === 'groupSum') add(r.in);
      // A date (a serial number), or a number shown with a number format - a quantity; a format of zeros only pads, as an ID's would.
      else if (r.rel === 'dateFormat' || (r.rel === 'numberFormat' && !/^0+$/.test(r.format))) add(r.in);
    }
    const window = ca.windows?.[0];
    if (window) {
      if (NUMERIC_WINDOW_FNS.has(window.fn)) add(window.in);
      // An order by the column's values (a rank, a running total in that order): the values' order is the rule.
      if (Array.isArray(window.order)) add(window.order.map((k) => k.in));
    }
    // Bands on an input column, or on an output column computed from these (`onOut`): `in` names the input columns either way.
    if (ca.derived?.kind === 'bands') add(ca.derived.in);
  }
  const filter = analysis.dropped.filters[0];
  if (filter?.droppedWhen && THRESHOLD_OPS.has(filter.droppedWhen.op)) add(filter.in);
  if (analysis.shape.kind === 'families' && analysis.shape.pattern.mode === 'columnsToRows') add(analysis.shape.pattern.in);
  for (const t of analysis.layout.titleRows) for (const p of t.parts ?? []) if ('in' in p) add([p.in]);
  // A total, average, minimum or maximum row of an output column computes with the input column that column copies.
  const copied = copiedInputs(analysis);
  const summaryRows: SummaryRowLayout[] = [...analysis.layout.summaryRows, ...(analysis.layout.groupBy?.summaryRows ?? [])];
  for (const s of summaryRows) for (const cell of s.cells) if (NUMERIC_AGGS.has(cell.agg)) add([...(copied.get(cell.out) ?? [])]);
  return used;
}

/** (Almost) every row holds its own value: the profile's key (unique and never empty), or 90% distinct over 6 rows or more. */
function uniquePerRow(p: ColumnProfile): boolean {
  return p.key || (p.nonEmpty >= maskingIdentifiers.minRows && p.distinctRatio >= maskingIdentifiers.minDistinctRatio);
}

/**
 * The INTEGER input columns that are identifiers (amendment 2026-10-06): unique per row (`uniquePerRow`), and no output column computes
 * anything from them (`measureColumns`) - copied, padded, cut, or a key that decides another column, and nothing else. DECISION: a unique
 * integer column that is only copied is masked even if it is in fact an amount: the AI step only has to copy it, which it can from fakes,
 * and a guess that keeps an ID real is the failure this rule exists to stop. A decimal, currency or percent column is never an identifier.
 */
export function identifierColumns(analysis: PairAnalysis): Set<number> {
  const measures = measureColumns(analysis);
  const ids = new Set<number>();
  for (const p of analysis.input.profile) if (p.type === 'integer' && uniquePerRow(p) && !measures.has(p.i)) ids.add(p.i);
  return ids;
}

const CACHE = new WeakMap<PairAnalysis, MaskTypes>();

/** The type every column of the example is masked as (see the file header). Cached: the pair analysis does not change once made. */
export function maskTypes(analysis: PairAnalysis): MaskTypes {
  const cached = CACHE.get(analysis);
  if (cached) return cached;
  const ids = identifierColumns(analysis);
  const input = analysis.input.profile.map((p): ProfileType => (ids.has(p.i) ? 'idLike' : p.type));
  const copied = copiedInputs(analysis);
  const output = analysis.output.profile.map((p, o): ProfileType => {
    // (A text column too - a copy with "n/a" on a row: a number in a text column is sent real. `idLike` masks its words as text.)
    if (p.type === 'idLike') return p.type;
    const copiesId = [...(copied.get(o) ?? [])].some((i) => input[i] === 'idLike');
    return copiesId ? 'idLike' : p.type;
  });
  const types = { input, output };
  CACHE.set(analysis, types);
  return types;
}

/** The type input column `i` is masked as ('text' for a column the profile does not know, as the payload always did). */
export function inputMaskType(analysis: PairAnalysis, i: number): ProfileType {
  return maskTypes(analysis).input[i] ?? 'text';
}

/** The type output column `o` is masked as. */
export function outputMaskType(analysis: PairAnalysis, o: number): ProfileType {
  return maskTypes(analysis).output[o] ?? 'text';
}
