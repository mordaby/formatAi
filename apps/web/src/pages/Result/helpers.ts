// Small pure helpers of the Result screen: which "please check" entries a line owns, what the example shows for a
// column, and defaults for the things the map's "Add" buttons create.
import type { PayloadCell } from '@formatai/shared';
import { effectiveEndSummaryRows, lineIds, sourceOptions, type EditableRules, type EditAction } from '../../editor';
import { outputColumnType } from '../../editor/rulesUtil';
import type { Line } from '../../rulesText';
import type { LiveCheckResult } from '../../worker/editorApi';

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
