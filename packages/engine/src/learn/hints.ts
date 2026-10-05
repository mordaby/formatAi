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

import { limits, type ColumnHint, type ExpandHint, type Hint, type RowHint } from '@formatai/shared';
import type { ColumnAnalysis, DedupeRelation, Derivation, FilterRelation, PairAnalysis, Relation, WindowFinding } from './analyze';
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
    case 'template':
      return { rel: 'template', in: rel.in, parts: rel.parts };
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
    // An across-row relation is hinted through its WindowFinding (`windowHintCandidate`), and only when
    // `limits.learn.window.hintsEnabled` (on since learn-v7): the fast path writes it, but it has no column hint of this kind.
    case 'window':
      return null;
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

/** A derived column's hint (SPEC 6.2 step 4 v5): `bands` when the output is a few contiguous ranges of one input
 * column, `contains` when the output text is composed from input values (their text is inside the output cells),
 * else `dependsOn` (the same input values always give the same output value).
 * Owner amendment 2026-10-05: bands on a computed OUTPUT column carry `onOut` (that column's position), with `in` = the
 * input columns it is computed from. DECISION: that column's own hint (its `mul`, `sum` ...) is sent as usual - it is
 * how the model sees what `onOut` is - so nothing is folded into this one. */
function derivedHintCandidate(out: number, d: Derivation): HintCandidate {
  const failingRows = d.coverage < 1 && d.failing.length > 0 ? d.failing : undefined;
  const base = { out, coverage: d.coverage, ...(failingRows ? { failingRows } : {}) };
  if (d.kind === 'bands') return { rel: 'bands', in: d.in, ...(d.onOut !== undefined ? { onOut: d.onOut } : {}), bands: d.bands, ...base };
  if (d.kind === 'composition') return { rel: 'contains', in: d.in, ...base };
  return { rel: 'dependsOn', in: d.in, ...base };
}

/**
 * The `rel: 'window'` hint of an across-row finding (docs/proposals/window-operations.md section 6): a fact at coverage 1, a hint with
 * `failsOn` below. `order` is only said where the order matters (not for a group's total or count): `'file'` for the input's row order,
 * `'output'` when only the order the example output shows fits, or the exact keys of a `rank`.
 */
export function windowHintCandidate(f: WindowFinding): HintCandidate {
  const groupFn = f.fn === 'groupSum' || f.fn === 'groupAvg' || f.fn === 'groupMin' || f.fn === 'groupMax' || f.fn === 'groupCount';
  const failingRows = f.coverage < 1 && f.failing.length > 0 ? f.failing : undefined;
  return {
    out: f.out,
    rel: 'window',
    fn: f.fn,
    ...(f.in.length > 0 ? { in: [f.in[0] as number] as [number] } : {}),
    ...(f.by.length > 0 ? { by: f.by } : {}),
    ...(groupFn ? {} : { order: f.order }),
    ...(f.ties !== undefined ? { ties: f.ties } : {}),
    ...(f.alt !== undefined && f.alt.length > 0
      ? { alt: f.alt.slice(0, 3).map((a) => ({ ...(a.in !== undefined ? { in: [a.in[0] as number] as [number] } : {}), ...(a.by !== undefined ? { by: a.by } : {}) })) }
      : {}),
    coverage: f.coverage,
    ...(failingRows ? { failingRows } : {}),
  } as HintCandidate;
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
 * relation, or - for a derived column no relation explains - its `bands` /
 * `contains` / `dependsOn` hint), the shape's expand hint when rows expand, and the
 * dropped-rows hints (dedupe, then the best filter).
 */
export function relationsToHints(analysis: PairAnalysis, preflight: PreflightResult): HintCandidate[] {
  const skip = new Set(preflight.skipColumns);
  const hints: HintCandidate[] = [];

  for (const ca of analysis.columns) {
    if (skip.has(ca.out)) continue;
    // Across rows. With the switch on (learn-v7), the window finding is the column's hint and the lookalikes it beat (a value map of the
    // group key, a constant) are not sent. With it off the AI is not told about window functions: a column the free engine knows to be a
    // group's total or count gets no hint at all rather than the misleading value map; any other column is hinted as before.
    if (limits.learn.window.hintsEnabled) {
      const finding = ca.windows?.[0];
      if (finding !== undefined) {
        hints.push(windowHintCandidate(finding));
        continue;
      }
    } else if (ca.relations.some((r) => r.rel === 'window')) {
      continue;
    }
    const rel = bestHintableRelation(ca);
    if (rel) hints.push(toColumnHintCandidate(rel));
    else if (ca.derived) hints.push(derivedHintCandidate(ca.out, ca.derived));
  }

  const expandHint = expandHintCandidate(analysis);
  if (expandHint) hints.push(expandHint);

  const droppedRows = new Set(analysis.dropped.rows);
  if (analysis.dropped.dedupe) hints.push(dedupeToHintCandidate(analysis.dropped.dedupe));
  const bestFilter = analysis.dropped.filters[0];
  if (bestFilter) hints.push(filterToHintCandidate(bestFilter, droppedRows));

  return hints;
}
