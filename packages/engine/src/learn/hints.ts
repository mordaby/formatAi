// relationsToHints (SPEC 6.2 end / LEARN_PROMPT §3): turns the pair analysis's
// code-level relations into the Hint shapes the LLM - and the local fast path
// (fastPath.ts, via `bestHintableRelation`/`relationHasHint`) - consume.
//
// Relations already meet coverage >= minCoverage (SPEC 6.2 default 0.9), so
// this module only reshapes them: it drops analyze-only bookkeeping fields a
// Hint doesn't carry (`matched`, `total`, `failCount`, `normalize.case`,
// `concat.skipEmpty`, `mulConst`/`addConst.constText`), and skips the one
// relation kind with no Hint equivalent at all (`split`: a whole-part text
// split has no shape in LEARN_PROMPT §3's Hint vocabulary - only the `expand`
// family patterns do). A column whose only qualifying relation is `split`
// simply gets no hint, exactly like a column with no qualifying relation.
//
// `failsOn` (LEARN_PROMPT §3: "sample indices where a hint fails") can't be
// filled in here: which real rows end up as payload samples is only decided
// later, by the sample selector (payload.ts). Instead every `HintCandidate`
// with coverage < 1 keeps its real-data `failingRows` (aligned-row indices for
// column/expand hints, input-row indices for row hints) so the sample selector
// can (a) make sure at least one of them becomes a sample/dropped row and (b)
// translate it into the final `failsOn` before the Hint is sent.

import type { ColumnHint, ExpandHint, Hint, RowHint } from '@formatai/shared';
import type { ColumnAnalysis, DedupeRelation, FilterRelation, PairAnalysis, Relation } from './analyze';
import type { PreflightResult } from './preflight';

/** A Hint plus the real-data row indices it fails on (coverage < 1 only),
 * before the sample selector translates them into payload sample indices.
 * Internal to the engine's learn pipeline; never sent to the LLM as-is. */
export type HintCandidate = (ColumnHint | RowHint | ExpandHint) & { failingRows?: number[] };

// Plain `Omit` doesn't distribute over a union (it only keeps keys common to
// every member); this does, so each variant keeps just its own extra fields.
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type ColumnHintBody = DistributiveOmit<ColumnHint, 'out' | 'coverage' | 'failsOn'>;

/** The Hint shape for one relation, or null when SPEC's Hint vocabulary has no
 * equivalent for it (`split`). Strips analyze-only fields (see file header). */
function columnHintBody(rel: Relation): ColumnHintBody | null {
  switch (rel.rel) {
    case 'copy':
      return { rel: 'copy', in: rel.in };
    case 'normalize':
      return { rel: 'normalize', in: rel.in };
    case 'padLeft':
      return { rel: 'padLeft', in: rel.in, length: rel.length, char: rel.char };
    case 'substr':
      return { rel: 'substr', in: rel.in, from: rel.from, length: rel.length };
    case 'split':
      return null;
    case 'concat':
      return { rel: 'concat', in: rel.in, separator: rel.separator };
    case 'valueMap':
      return { rel: 'valueMap', in: rel.in, pairs: rel.pairs };
    case 'constant':
      return { rel: 'constant', in: [], value: rel.value };
    case 'dateFormat':
      return { rel: 'dateFormat', in: rel.in, from: rel.from, to: rel.to };
    case 'numberFormat':
      return { rel: 'numberFormat', in: rel.in, format: rel.format };
    case 'mulConst':
    case 'addConst':
      return { rel: rel.rel, in: rel.in, const: rel.const, ...(rel.round !== undefined ? { round: rel.round } : {}) };
    case 'add':
    case 'sub':
    case 'mul':
    case 'div':
      return { rel: rel.rel, in: rel.in, ...(rel.round !== undefined ? { round: rel.round } : {}) };
    case 'sum':
      return { rel: 'sum', in: rel.in, ...(rel.round !== undefined ? { round: rel.round } : {}) };
    case 'aggregate':
      return { rel: 'aggregate', in: rel.in, fn: rel.fn };
  }
}

/** True when `rel` has a Hint equivalent (everything except `split`). Used by
 * fastPath.ts, since SPEC 6.5 requires a coverage-1.0 *hint*, not merely a
 * coverage-1.0 relation. */
export function relationHasHint(rel: Relation): boolean {
  return columnHintBody(rel) !== null;
}

/** The best (first, per analyzePair's own best-first ordering) relation of `ca`
 * that has a Hint equivalent. */
export function bestHintableRelation(ca: ColumnAnalysis): Relation | null {
  for (const rel of ca.relations) {
    if (relationHasHint(rel)) return rel;
  }
  return null;
}

function toColumnHintCandidate(rel: Relation): HintCandidate {
  const body = columnHintBody(rel);
  if (body === null) throw new Error(`hints: relation "${rel.rel}" has no Hint equivalent`);
  const failingRows = rel.coverage < 1 ? rel.failing : undefined;
  return {
    ...body,
    out: rel.out,
    coverage: rel.coverage,
    ...(failingRows ? { failingRows } : {}),
  } as HintCandidate;
}

/** SPEC 6.2 step 3 families: the expand hint for the shape's family pattern.
 * By construction every family matches the pattern exactly (detectFamilies
 * requires `families.every(...)` to pick a pattern at all), so coverage is
 * always 1. */
function expandHintCandidate(analysis: PairAnalysis): HintCandidate | null {
  if (analysis.shape.kind !== 'families') return null;
  const p = analysis.shape.pattern;
  if (p.mode === 'columnsToRows') {
    return { rel: 'expand', mode: 'columnsToRows', in: p.in, labelOut: p.labelOut, valueOut: p.valueOut, skipEmpty: p.skipEmpty, coverage: 1 };
  }
  if (p.mode === 'splitCell') {
    return { rel: 'expand', mode: 'splitCell', in: p.in, separator: p.separator, out: p.out, coverage: 1 };
  }
  // fixedFanOut: one hint array per position, each entry the best hintable,
  // coverage-1.0 relation of that position for one output column (SPEC:
  // "position 1: {...}; position 2: {...}"). DECISION: a position hint with
  // coverage < 1 is left out rather than threading its own failingRows through
  // a nested array - a rare case (position-specific evidence is usually exact
  // by construction, since a fixed fan-out pattern already requires every
  // family to have the same size) and not worth the extra complexity.
  const positions: ColumnHint[][] = p.positions.map((cols) => {
    const arr: ColumnHint[] = [];
    for (const ca of cols) {
      const rel = bestHintableRelation(ca);
      if (rel && rel.coverage === 1) {
        const { failingRows: _f, ...hint } = toColumnHintCandidate(rel);
        arr.push(hint as ColumnHint);
      }
    }
    return arr;
  });
  return { rel: 'expand', mode: 'fixedFanOut', size: p.size, positions, coverage: 1 };
}

function filterToHintCandidate(fr: FilterRelation, droppedRows: ReadonlySet<number>): HintCandidate {
  const hint: RowHint = { rel: 'filter', in: fr.in, coverage: fr.coverage };
  if (fr.keptValues !== undefined) hint.keptValues = fr.keptValues;
  if (fr.droppedValues !== undefined) hint.droppedValues = fr.droppedValues;
  if (fr.droppedWhen !== undefined) hint.droppedWhen = fr.droppedWhen;
  if (fr.coverage < 1) {
    // DECISION: a filter's `failing` lists INPUT rows (kept or dropped); only
    // the ones that are also among the (up to 5) dropped rows sent to the LLM
    // can be pointed at by `failsOn` (samples only ever carry KEPT rows, and a
    // filter's failure on a kept row would show up as a plain copy mismatch
    // there anyway, without needing `failsOn`). A misclassified kept row is
    // therefore not tracked here; this only affects the rare case where
    // coverage < 1 AND the failing example happens to be a kept row.
    const failingRows = fr.failing.filter((r) => droppedRows.has(r));
    if (failingRows.length > 0) return { ...hint, failingRows };
  }
  return hint as HintCandidate;
}

function dedupeToHintCandidate(d: DedupeRelation): HintCandidate {
  const hint: RowHint = { rel: 'dedupe', in: d.in, keys: d.keys, keep: d.keep, coverage: d.coverage };
  if (d.coverage < 1) {
    const consistent = (row: number, of: number): boolean => (d.keep === 'first' ? row > of : row < of);
    const failingRows = d.duplicates.filter((x) => !consistent(x.row, x.of)).map((x) => x.row);
    if (failingRows.length > 0) return { ...hint, failingRows };
  }
  return hint as HintCandidate;
}

/**
 * Every hint the LLM (and the local fast path) receive for this pair: one
 * per output column not in `preflight.skipColumns` (its best hintable
 * relation), the shape's expand hint when rows expand, and the dropped-rows
 * hints (dedupe, then the best filter).
 */
export function relationsToHints(analysis: PairAnalysis, preflight: PreflightResult): HintCandidate[] {
  const skip = new Set(preflight.skipColumns);
  const hints: HintCandidate[] = [];

  for (const ca of analysis.columns) {
    if (skip.has(ca.out)) continue;
    const rel = bestHintableRelation(ca);
    if (rel) hints.push(toColumnHintCandidate(rel));
  }

  const expandHint = expandHintCandidate(analysis);
  if (expandHint) hints.push(expandHint);

  const droppedRows = new Set(analysis.dropped.rows);
  if (analysis.dropped.dedupe) hints.push(dedupeToHintCandidate(analysis.dropped.dedupe));
  const bestFilter = analysis.dropped.filters[0];
  if (bestFilter) hints.push(filterToHintCandidate(bestFilter, droppedRows));

  return hints;
}
