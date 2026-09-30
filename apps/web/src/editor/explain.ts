// Static-check problems (SPEC 9.2 layers 1-5) in plain words, each tied to the line of the rules map it is about,
// so a blocked save can say "Column "Total": ..." and the map can mark that line.
import type { StaticProblem } from '../worker/editorApi';
import { lineIds } from './lines';
import type { EditableRules, LineId } from './types';

export interface ExplainedProblem {
  layer: StaticProblem['layer'];
  /** Stable code for the UI's own wording: `<layer>.<kind>`. */
  code: string;
  /** The line of the rules map it is about, when it can be told. */
  lineId?: LineId;
  /** What that line is called, e.g. `Column "Total"`. */
  where: string;
  /** One sentence in plain words. */
  text: string;
  /** The checker's own message, for a details view. */
  detail: string;
  path?: string;
}

const COMPUTED = /^transform\.computed\[(\d+)\]/;

function locate(rules: EditableRules, path: string | undefined): { lineId?: LineId; where: string } {
  if (path === undefined || path === '') return { where: 'The rules' };
  let m: RegExpMatchArray | null;

  if ((m = path.match(/^output\.columns\[(\d+)\]/))) {
    const col = rules.output.columns[Number(m[1])];
    if (col) return { lineId: lineIds.col(col.header), where: `Column "${col.header}"` };
  }
  if ((m = path.match(COMPUTED))) {
    const c = rules.transform.computed[Number(m[1])];
    const col = c ? rules.output.columns.find((o) => o.from === c.id) : undefined;
    if (col) return { lineId: lineIds.col(col.header), where: `Column "${col.header}"` };
    return { where: c ? `The helper "${c.id}"` : 'A helper column' };
  }
  if ((m = path.match(/^input\.rowFilters\[(\d+)\]/))) return { lineId: lineIds.filter(Number(m[1])), where: `Filter ${Number(m[1]) + 1}` };
  if (path.startsWith('transform.dedupe')) return { lineId: lineIds.dedupe, where: 'Duplicates' };
  if (path.startsWith('transform.expand')) return { lineId: lineIds.expand, where: 'One row becomes several' };
  if (path.startsWith('transform.sort') || path.startsWith('layout.sort')) return { lineId: lineIds.sort, where: 'Sort' };
  if ((m = path.match(/^transform\.group\.summaryRows\[(\d+)\]/))) return { lineId: lineIds.summaryGroup(Number(m[1])), where: `Group summary row ${Number(m[1]) + 1}` };
  if (path.startsWith('transform.group') || path.startsWith('layout.group')) return { lineId: lineIds.group, where: 'Groups' };
  if ((m = path.match(/^output\.summaryRows\[(\d+)\]/))) return { lineId: lineIds.summaryEnd(Number(m[1])), where: `Summary row ${Number(m[1]) + 1}` };
  if ((m = path.match(/^output\.titleRows\[(\d+)\]/))) return { lineId: lineIds.title(Number(m[1])), where: `Title row ${Number(m[1]) + 1}` };
  if (path.startsWith('output.titleRows')) return { where: 'The title rows' };
  if ((m = path.match(/^validations\[(\d+)\]/))) return { lineId: lineIds.check(Number(m[1])), where: `Check ${Number(m[1]) + 1}` };
  if ((m = path.match(/^transform\.functions\[(\d+)\]/))) {
    const fn = rules.transform.functions?.[Number(m[1])];
    if (fn) return { lineId: lineIds.fn(fn.name), where: `Function "${fn.name}"` };
  }
  if ((m = path.match(/^transform\.tables\[(\d+)\]/))) {
    const t = rules.transform.tables?.[Number(m[1])];
    if (t) return { lineId: lineIds.table(t.name), where: `Table "${t.name}"` };
  }
  if (path.startsWith('output.')) return { where: 'The output file' };
  // (the source lock, SPEC 8.15: a column the file has, as the conversion declares it)
  if ((m = path.match(/^input\.columns\[(\d+)\]/))) {
    const col = rules.input.columns[Number(m[1])];
    if (col) return { where: `Input column "${col.header}"` };
  }
  if (path.startsWith('input.')) return { where: 'The input' };
  return { where: 'The rules' };
}

function sentence(p: StaticProblem, where: string): string {
  const m = p.message;
  switch (p.layer) {
    case 'structure':
      return `${where} is not valid: ${m}.`;
    case 'references':
      if (/unknown column id "(.+)"/.test(m)) return `${where} uses a column ("${/"(.+)"/.exec(m)?.[1]}") that does not exist.`;
      if (/unknown output header/.test(m)) return `${where} names a column of the file ("${/"(.+)"/.exec(m)?.[1]}") that does not exist.`;
      if (/collides/.test(m)) return `${where} reuses a name that is already taken.`;
      return `${where}: ${m}.`;
    case 'types': {
      const mismatch = /^expected (\w+), got (\w+)/.exec(m);
      if (mismatch) return `${where} mixes up kinds of values: it needs ${article(mismatch[1]!)} but gets ${article(mismatch[2]!)}.`;
      return `${where}: ${m}.`;
    }
    case 'limits':
      if (/rules exceeds/.test(m)) return `${m[0]!.toUpperCase()}${m.slice(1)}. Remove some rules or upgrade.`;
      return `${where} is too big: ${m}.`;
    case 'formatLock':
      return `${where} no longer matches the format this source belongs to: ${m}.`;
    case 'sourceLock':
      return `${where} doesn't match the source you chose: ${m}.`;
  }
}

function article(type: string): string {
  switch (type) {
    case 'decimal':
    case 'integer':
      return 'a number';
    case 'text':
    case 'idLike':
      return 'text';
    case 'date':
      return 'a date';
    case 'boolean':
      return 'a yes/no value';
    default:
      return type;
  }
}

export function explainStaticProblems(rules: EditableRules, problems: readonly StaticProblem[]): ExplainedProblem[] {
  return problems.map((p) => {
    const { lineId, where } = locate(rules, p.path);
    return {
      layer: p.layer,
      code: `${p.layer}.${p.kind}`,
      ...(lineId === undefined ? {} : { lineId }),
      where,
      text: sentence(p, where),
      detail: p.message,
      ...(p.path === undefined ? {} : { path: p.path }),
    };
  });
}
