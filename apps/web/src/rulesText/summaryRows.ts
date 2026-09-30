// Older saved rules carry `output.grandTotal` / `transform.group.subtotal` (ids, sum only)
// instead of `summaryRows` (output headers, any aggregate). The engine translates them at run
// time; the rules map shows the same thing, so this mirrors that translation (engine:
// rules/summaryRows.ts). Pure, types from shared only.
import type { LearnResult, OutputColumnRule, Rules, SummaryAgg, SummaryRow } from '@formatai/shared';

type LegacyTotal = { labelColumn: string; label: string; sum: string[] };

function translate(spec: LegacyTotal, columns: readonly OutputColumnRule[], summaryMode: boolean): SummaryRow {
  const sumIds = new Set(spec.sum);
  const cells: Record<string, SummaryAgg> = {};
  for (const c of columns) {
    if (c.from === null || !sumIds.has(c.from)) continue;
    if (!summaryMode) {
      cells[c.header] = 'sum';
      continue;
    }
    // A grand total over a one-row-per-group output keeps each column's own sum/count.
    const agg = c.agg ?? 'first';
    if (agg === 'sum' || agg === 'count') cells[c.header] = agg;
  }
  const row: SummaryRow = { cells, label: spec.label };
  const labelCol = columns.find((c) => c.from === spec.labelColumn);
  if (labelCol) row.labelColumn = labelCol.header;
  return row;
}

/** Summary rows written after all data rows. */
export function endSummaryRows(rules: LearnResult | Rules): SummaryRow[] {
  const { output, transform } = rules;
  if (output.summaryRows && output.summaryRows.length > 0) return output.summaryRows;
  if (!output.grandTotal) return [];
  const summaryMode = transform.group !== undefined && transform.group.showDetailRows === false;
  return [translate(output.grandTotal, output.columns, summaryMode)];
}

/** Summary rows written after each group. */
export function groupSummaryRows(rules: LearnResult | Rules): SummaryRow[] {
  const group = rules.transform.group;
  if (!group) return [];
  if (group.summaryRows && group.summaryRows.length > 0) return group.summaryRows;
  if (!group.showDetailRows || !group.subtotal) return [];
  return [translate(group.subtotal, rules.output.columns, false)];
}
