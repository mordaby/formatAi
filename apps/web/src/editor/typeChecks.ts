// The type checks an edit's own surfaces need (summary rows, checks), with the wording of the engine's
// `typeCheck` so the sentence a person sees is the same one the worker's static check would give.
// The main thread can't load the engine's checker (SPEC 2), and these are the only places where an edit of one
// column (its type changes) can break something else the editor shows.
import type { SummaryRow, Validation, ValueType } from '@formatai/shared';
import { SUMMARY_AGGS } from '@formatai/shared';
import { effectiveEndSummaryRows, effectiveGroupSummaryRows, idInfos, NUMERIC, outputColumnType } from './rulesUtil';
import type { EditableRules, EditProblem } from './types';

export function summaryRowProblems(rules: EditableRules, row: SummaryRow, path: string): EditProblem[] {
  const problems: EditProblem[] = [];
  const headers = new Set(rules.output.columns.map((c) => c.header));
  if (row.labelColumn !== undefined && !headers.has(row.labelColumn)) {
    problems.push({ code: 'unknownColumn', message: `unknown output header "${row.labelColumn}"`, column: row.labelColumn, path: `${path}.labelColumn` });
  }
  const infos = idInfos(rules);
  for (const [header, agg] of Object.entries(row.cells)) {
    const column = rules.output.columns.find((c) => c.header === header);
    if (!column) {
      problems.push({ code: 'unknownColumn', message: `unknown output header "${header}"`, column: header, path: `${path}.cells.${header}` });
      continue;
    }
    if (!(SUMMARY_AGGS as readonly string[]).includes(agg)) {
      problems.push({ code: 'badValue', message: `"${agg}" is not a summary`, path: `${path}.cells.${header}` });
      continue;
    }
    const type = outputColumnType(rules, column, infos);
    if (type === undefined) continue;
    if ((agg === 'sum' || agg === 'average') && !NUMERIC.has(type)) {
      problems.push({ code: 'typeMismatch', message: `${agg} applies to a numeric column; "${header}" is ${type}`, column: header, path: `${path}.cells.${header}` });
    } else if ((agg === 'min' || agg === 'max') && !NUMERIC.has(type) && type !== 'date') {
      problems.push({ code: 'typeMismatch', message: `${agg} applies to a numeric or date column; "${header}" is ${type}`, column: header, path: `${path}.cells.${header}` });
    }
  }
  return problems;
}


export function validationProblems(rules: EditableRules, v: Validation): EditProblem[] {
  const infos = idInfos(rules);
  let type: ValueType | undefined;
  if ((v.on ?? 'input') === 'output') {
    const col = rules.output.columns.find((c) => c.header === v.column);
    type = col ? outputColumnType(rules, col, infos) : undefined;
  } else {
    type = infos.get(v.column)?.type;
  }
  if (type === undefined) return [];
  const bad = (message: string): EditProblem[] => [{ code: 'typeMismatch', message, column: v.column, path: 'validation' }];
  switch (v.rule) {
    case 'range':
      return NUMERIC.has(type) ? [] : bad(`range applies to a numeric column; "${v.column}" is ${type}`);
    case 'dateRange':
      return type === 'date' ? [] : bad(`dateRange applies to a date column; "${v.column}" is ${type}`);
    case 'lengthEquals':
      return type === 'text' || type === 'idLike' ? [] : bad(`lengthEquals applies to a text column; "${v.column}" is ${type}`);
    case 'israeliIdChecksum':
      return type === 'text' || type === 'idLike' ? [] : bad(`israeliIdChecksum applies to a text/idLike column; "${v.column}" is ${type}`);
    default:
      return [];
  }
}


/** Every type problem in the summary rows and checks of a rules file (what an edit of some column can break). */
export function layoutTypeProblems(rules: EditableRules): EditProblem[] {
  const out: EditProblem[] = [];
  const keep = (list: EditProblem[]): void => {
    for (const p of list) if (p.code === 'typeMismatch') out.push(p);
  };
  effectiveEndSummaryRows(rules).forEach((r, i) => keep(summaryRowProblems(rules, r, `output.summaryRows[${i}]`)));
  effectiveGroupSummaryRows(rules).forEach((r, i) => keep(summaryRowProblems(rules, r, `transform.group.summaryRows[${i}]`)));
  rules.validations.forEach((v) => keep(validationProblems(rules, v)));
  return out;
}
