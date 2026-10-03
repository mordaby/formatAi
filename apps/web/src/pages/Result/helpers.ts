// Small pure helpers of the Result screen: which "please check" entries a line owns, what the example shows for a
// column, and defaults for the things the map's "Add" buttons create.
import type { PayloadCell } from '@formatai/shared';
import { effectiveEndSummaryRows, lineIds, sourceOptions, type EditableRules, type EditAction } from '../../editor';
import { editorConfig } from '../../editor/config';
import { outputColumnType } from '../../editor/rulesUtil';
import type { Line } from '../../rulesText';
import type { ColumnCheck, LiveCheckResult } from '../../worker/editorApi';

/** The rule for this column mostly fails against the example: fewer than `mostlyFailsBelow` of the counted rows match in it. */
export function isFailingColumn(check: ColumnCheck | undefined): boolean {
  if (!check || !check.inExample || check.total <= 0) return false;
  return check.matched / check.total < editorConfig.mostlyFailsBelow;
}

/**
 * The output columns that have no rule yet: nothing fills them (`from: null`), or the rules list them as unsupported (the AI step
 * has not worked them out, or their values are not in the input). They are left out of the comparison with the example, and the
 * preview shows them empty (never with the example's values, which would look like a working rule).
 */
export function columnsWithoutRule(rules: EditableRules): Set<string> {
  const headers = new Set<string>();
  for (const c of rules.output.columns) if (c.from === null) headers.add(c.header);
  for (const u of rules.unsupported) if (rules.output.columns.some((c) => c.header === u.outputColumn)) headers.add(u.outputColumn);
  return headers;
}

/** Where one output column's rule doesn't reproduce the example, for the notice on its line and above the preview. */
export interface ColumnMismatch {
  /** Position in `rules.output.columns` (and in the live check's `perColumn`). */
  index: number;
  header: string;
  /** Rows of the example that don't match in this column (exact). */
  count: number;
  /** The first of them, by row number, as many as `mismatchRowsShown` (the check lists cell mismatches up to a cap, so these can be fewer than `count`). */
  rows: number[];
  /** There are more rows than the ones listed. */
  more: boolean;
  /** Mostly failing: the notice says the rule doesn't reproduce the example instead of counting rows. */
  failing: boolean;
}

/** One entry per output column of the rules whose values don't all match the example, in column order. */
export function columnMismatches(live: LiveCheckResult | null | undefined, rules: EditableRules): ColumnMismatch[] {
  if (!live) return [];
  const out: ColumnMismatch[] = [];
  live.perColumn.forEach((check, index) => {
    if (!check.inExample || check.total <= 0 || check.matched >= check.total) return;
    // Only columns the rules have (a column the example has and the rules don't is not a rule to fix).
    if (rules.output.columns[index]?.header !== check.header) return;
    const rows = new Set<number>();
    for (const m of live.mismatches) {
      if (m.columnIndex === index || (m.columnIndex < 0 && m.column === check.header)) rows.add(m.exampleRow);
    }
    const sorted = [...rows].sort((x, y) => x - y);
    const count = check.total - check.matched;
    out.push({ index, header: check.header, count, rows: sorted.slice(0, editorConfig.mismatchRowsShown), more: count > sorted.slice(0, editorConfig.mismatchRowsShown).length, failing: isFailingColumn(check) });
  });
  return out;
}

/** Indexes into `rules.assumptions` that belong to this line (what "Keep" dismisses). */
export function assumptionIndexes(rules: EditableRules, line: Line): number[] {
  const out: number[] = [];
  rules.assumptions.forEach((a, i) => {
    let mine = false;
    if (a.outputColumn !== undefined) mine = line.target.kind === 'column' && line.target.header === a.outputColumn;
    else if (a.reasonCode === 'filterGuessed') mine = line.target.kind === 'filter';
    else if (a.reasonCode === 'sortGuessed') mine = line.target.kind === 'sort';
    else if (a.reasonCode === 'titleGuessed') mine = line.target.kind === 'title';
    else if (a.reasonCode === 'formatGuessed') mine = line.target.kind === 'file';
    if (mine) out.push(i);
  });
  return out;
}

/** A line has "Keep / Change" when it is "please check" because of an assumption the user can dismiss. */
export function canKeep(rules: EditableRules, line: Line): boolean {
  return line.status === 'check' && assumptionIndexes(rules, line).length > 0;
}

/** The distinct, non-empty values the example output shows in column `index` (position), first `limit` of them. */
export function exampleValues(live: LiveCheckResult | null | undefined, index: number, limit = 8): PayloadCell[] {
  if (!live) return [];
  const seen = new Set<string>();
  const out: PayloadCell[] = [];
  for (const row of live.preview) {
    const v = row.expected[index];
    if (v === null || v === undefined || v === '') continue;
    const key = `${typeof v}:${String(v)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
    if (out.length >= limit) break;
  }
  return out;
}

/** "New column", "New column 2", ...: the first name no output column has. */
export function freshHeader(rules: EditableRules, base: string): string {
  const used = new Set(rules.output.columns.map((c) => c.header));
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) if (!used.has(`${base} ${n}`)) return `${base} ${n}`;
}

export type AddKind = 'column' | 'filter' | 'dedupe' | 'title' | 'sort' | 'group' | 'summaryEnd' | 'check';

export interface AddPlan {
  action: EditAction;
  /** The id of the line the new item will have, once applied. */
  lineId: string;
}

/** The action (and the line it creates) behind an "Add ..." button. `undefined` when the rules have nothing to build it from. */
export function planAdd(rules: EditableRules, kind: AddKind, labels: { column: string; title: string; total: string }): AddPlan | undefined {
  const sources = sourceOptions(rules);
  const first = sources[0]?.id;
  switch (kind) {
    case 'column': {
      const header = freshHeader(rules, labels.column);
      return { action: { type: 'addColumn', header, method: { kind: 'empty' } }, lineId: lineIds.col(header) };
    }
    case 'filter':
      if (first === undefined) return undefined;
      return {
        action: { type: 'addFilter', filter: { column: first, op: 'notEmpty' } },
        lineId: lineIds.filter((rules.input.rowFilters ?? []).length),
      };
    case 'dedupe':
      return { action: { type: 'setDedupe', enabled: true, keys: 'all', keep: 'first', action: 'flag' }, lineId: lineIds.dedupe };
    case 'title':
      return { action: { type: 'addTitleRow', row: { text: labels.title } }, lineId: lineIds.title(rules.output.titleRows.length) };
    case 'sort':
      if (first === undefined) return undefined;
      return { action: { type: 'setSort', keys: [{ column: first, dir: 'asc' }] }, lineId: lineIds.sort };
    case 'group':
      if (first === undefined) return undefined;
      return { action: { type: 'setGroup', group: { by: first, showDetailRows: true } }, lineId: lineIds.group };
    case 'summaryEnd': {
      const cols = rules.output.columns;
      const numeric = cols.find((c) => {
        const type = outputColumnType(rules, c);
        return type === 'integer' || type === 'decimal';
      });
      const target = numeric ?? cols[0];
      if (!target) return undefined;
      return {
        action: { type: 'addSummaryRow', scope: 'end', row: { label: labels.total, cells: { [target.header]: numeric ? 'sum' : 'count' } } },
        lineId: lineIds.summaryEnd(effectiveEndSummaryRows(rules).length),
      };
    }
    case 'check':
      if (first === undefined) return undefined;
      return {
        action: { type: 'addValidation', validation: { column: first, rule: 'required', severity: 'flag' } },
        lineId: lineIds.check(rules.validations.length),
      };
  }
}
