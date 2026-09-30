// SPEC 8.12/21 (v4 change: generic summary rows): translates the deprecated,
// id-based `output.grandTotal` / `transform.group.subtotal` (SPEC 8.1, kept only for
// backward compatibility - see `RulesSchema` in packages/shared/src/rules/schema.ts)
// into the generic, header-keyed `SummaryRow` model (SPEC 8.12), so both the engine's
// runtime layout (pipeline/v1/layout.ts) and the registry's `formatOf` build summary
// rows from ONE normalization instead of two. `effectiveOutputSummaryRows` /
// `effectiveGroupSummaryRows` are pure and need no row data: they only decide WHICH
// summary rows apply and what each one's `cells`/`labelColumn` are, by header.
//
// Byte-identical compatibility (SPEC 21 v4): `translateDeprecatedTotal` reproduces
// `totalRow`'s old id-based behavior exactly, including its one quirk - a grand total
// over a summary output (`group.showDetailRows: false`, SPEC 8.6) fills a summed
// column using that COLUMN's own `agg` (sum -> sum, count -> count, anything else is
// left blank) rather than always summing. A group subtotal never has this quirk: it
// only ever appears when `showDetailRows` is true (SPEC 8.2's `buildSheet` never even
// reads `group.subtotal` otherwise), so it always translates to a plain "sum" per
// summed column.
import type { Group, OutputColumnRule, RulesOutput, SummaryAgg, SummaryRow } from '@formatai/shared';

type DeprecatedTotal = { labelColumn: string; label: string; sum: string[] };

/** SPEC 21 v4: `output.grandTotal` / `group.subtotal` (ids), translated into a
 * `SummaryRow` (output headers) - see the file header for the `summaryMode` quirk. */
export function translateDeprecatedTotal(
  spec: DeprecatedTotal,
  columns: readonly OutputColumnRule[],
  summaryMode: boolean,
): SummaryRow {
  const sumIds = new Set(spec.sum);
  const cells: Record<string, SummaryAgg> = {};
  for (const c of columns) {
    if (c.from === null || !sumIds.has(c.from)) continue;
    if (!summaryMode) {
      cells[c.header] = 'sum';
      continue;
    }
    // SPEC 8.6/21 v4: a grand total over a summary output keeps each column's own
    // agg for sum/count, and leaves min/max/first blank (today's `totalRow` behavior).
    const agg = c.agg ?? 'first';
    if (agg === 'sum' || agg === 'count') cells[c.header] = agg;
  }
  const row: SummaryRow = { cells, label: spec.label };
  const labelCol = columns.find((c) => c.from === spec.labelColumn);
  if (labelCol) row.labelColumn = labelCol.header;
  return row;
}

export interface EffectiveSummaryRows {
  rows: SummaryRow[];
  /** Set only when `rows` came from translating a deprecated field, so a caller that
   * cares (the engine's `OutRow.kind`) can keep emitting 'grandTotal'/'subtotal' for
   * old-style rules files - never set for genuine `summaryRows`. */
  legacyKind?: 'grandTotal' | 'subtotal';
}

/** SPEC 8.12 v4: `output.summaryRows` if present and non-empty, else the deprecated
 * `output.grandTotal` translated (SPEC 21 v4 backward compatibility), else none. */
export function effectiveOutputSummaryRows(output: RulesOutput, group: Group | undefined): EffectiveSummaryRows {
  if (output.summaryRows && output.summaryRows.length > 0) return { rows: output.summaryRows };
  if (!output.grandTotal) return { rows: [] };
  const summaryMode = group !== undefined && group.showDetailRows === false;
  return {
    rows: [translateDeprecatedTotal(output.grandTotal, output.columns, summaryMode)],
    legacyKind: 'grandTotal',
  };
}

/** SPEC 8.12 v4: `group.summaryRows` if present and non-empty, else the deprecated
 * `group.subtotal` translated - which, like today, only ever applies when
 * `showDetailRows` is true - else none. */
export function effectiveGroupSummaryRows(
  group: Group,
  outputColumns: readonly OutputColumnRule[],
): EffectiveSummaryRows {
  if (group.summaryRows && group.summaryRows.length > 0) return { rows: group.summaryRows };
  if (!group.showDetailRows || !group.subtotal) return { rows: [] };
  return {
    rows: [translateDeprecatedTotal(group.subtotal, outputColumns, false)],
    legacyKind: 'subtotal',
  };
}
