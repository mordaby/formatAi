// Every edit the rules map can make, as a pure step over the rules: `(rules, action) -> rules | problems`.
// Steps build the same JSON the engine runs (computed columns with generated ids, formula ASTs, value
// maps), never text to be executed. `model.ts` wraps each step with validation, history and the
// bookkeeping (edited lines, format change); this file only knows about rules.
import type {
  FilterScalar,
  OutputColumnRule,
  RowFilter,
  SortKey,
  SummaryRow,
  TitleRow,
  Validation,
  ValueType,
} from '@formatai/shared';
import { parseFormula } from '@formatai/engine/formula';
import { applyColumnMethod, mismatchMessage } from './columnMethod';
import { fail, isProblems } from './problems';
import { summaryRowProblems, validationProblems } from './typeChecks';
import {
  effectiveEndSummaryRows,
  effectiveGroupSummaryRows,
  idInfos,
  pruneComputed,
  pruneValueMaps,
} from './rulesUtil';
import type {
  EditableRules,
  EditAction,
  EditProblem,
  ExpandInput,
  FilterInput,
  FunctionInput,
  GroupInput,
  SummaryScope,
} from './types';

type Out = EditableRules | EditProblem[];
type Action<T extends EditAction['type']> = Extract<EditAction, { type: T }>;

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

function noItem(what: string, index: number, path = 'index'): EditProblem[] {
  return fail({ code: 'noSuchItem', message: `there is no ${what} ${index + 1}`, path });
}

function clampIndex(at: number | undefined, length: number): number {
  if (at === undefined || !Number.isFinite(at)) return length;
  return Math.max(0, Math.min(length, Math.trunc(at)));
}

function move<T>(list: readonly T[], from: number, to: number): T[] {
  const copy = [...list];
  const [item] = copy.splice(from, 1);
  copy.splice(to, 0, item as T);
  return copy;
}

function withOutput(rules: EditableRules, patch: Partial<EditableRules['output']>): EditableRules {
  return { ...rules, output: { ...rules.output, ...patch } } as EditableRules;
}
function withTransform(rules: EditableRules, patch: Partial<EditableRules['transform']>): EditableRules {
  return { ...rules, transform: { ...rules.transform, ...patch } } as EditableRules;
}
function withInput(rules: EditableRules, patch: Partial<EditableRules['input']>): EditableRules {
  return { ...rules, input: { ...rules.input, ...patch } } as EditableRules;
}

/** Drops a key whose value is undefined, so a cleared optional field leaves no `undefined` in the JSON. */
function omit<T extends object, K extends keyof T>(obj: T, key: K): Omit<T, K> {
  const { [key]: _removed, ...rest } = obj;
  void _removed;
  return rest;
}

// ---------- headers: a rename follows every place that names an output header ----------

function mapSummaryRow(row: SummaryRow, rename: (header: string) => string | undefined): SummaryRow {
  const cells: SummaryRow['cells'] = {};
  for (const [h, agg] of Object.entries(row.cells)) {
    const name = rename(h);
    if (name !== undefined) Object.defineProperty(cells, name, { value: agg, enumerable: true, writable: true, configurable: true });
  }
  const next: SummaryRow = { ...row, cells };
  if (row.labelColumn !== undefined) {
    const name = rename(row.labelColumn);
    if (name === undefined) delete next.labelColumn;
    else next.labelColumn = name;
  }
  return next;
}

/** Applies `rename` to every summary row, output validation, and "Needs input"/"Please check" entry. `undefined` = the header is gone. */
function followHeader(rules: EditableRules, rename: (header: string) => string | undefined): EditableRules {
  let next = rules;
  if (next.output.summaryRows) next = withOutput(next, { summaryRows: next.output.summaryRows.map((r) => mapSummaryRow(r, rename)) });
  const g = next.transform.group;
  if (g?.summaryRows) next = withTransform(next, { group: { ...g, summaryRows: g.summaryRows.map((r) => mapSummaryRow(r, rename)) } });
  const validations: Validation[] = [];
  for (const v of next.validations) {
    if ((v.on ?? 'input') !== 'output') {
      validations.push(v);
      continue;
    }
    const name = rename(v.column);
    if (name !== undefined) validations.push({ ...v, column: name });
  }
  const unsupported = next.unsupported.flatMap((u) => {
    const name = rename(u.outputColumn);
    return name === undefined ? [] : [{ ...u, outputColumn: name }];
  });
  const assumptions = next.assumptions.flatMap((a) => {
    if (a.outputColumn === undefined) return [a];
    const name = rename(a.outputColumn);
    return name === undefined ? [] : [{ ...a, outputColumn: name }];
  });
  return { ...next, validations, unsupported, assumptions } as EditableRules;
}

function checkHeader(rules: EditableRules, header: string, except?: number): EditProblem[] {
  if (header.trim() === '') return [{ code: 'emptyHeader', message: 'a column needs a name', path: 'header' }];
  if (rules.output.columns.some((c, i) => i !== except && c.header === header)) {
    return [{ code: 'duplicateHeader', message: `there is already a column called "${header}"`, path: 'header', column: header }];
  }
  return [];
}

function setColumnHeader(rules: EditableRules, a: Action<'setColumnHeader'>): Out {
  const col = rules.output.columns[a.index];
  if (!col) return noItem('column', a.index);
  const problems = checkHeader(rules, a.header, a.index);
  if (problems.length > 0) return problems;
  if (col.header === a.header) return rules;
  const old = col.header;
  const renamed = withOutput(rules, { columns: rules.output.columns.map((c, i) => (i === a.index ? { ...c, header: a.header } : c)) });
  return followHeader(renamed, (h) => (h === old ? a.header : h));
}

function reorderColumns(rules: EditableRules, a: Action<'reorderColumns'>): Out {
  const n = rules.output.columns.length;
  if (!Number.isInteger(a.from) || a.from < 0 || a.from >= n) return noItem('column', a.from, 'from');
  const to = Math.max(0, Math.min(n - 1, Math.trunc(a.to)));
  if (to === a.from) return rules;
  return withOutput(rules, { columns: move(rules.output.columns, a.from, to) });
}

function addColumn(rules: EditableRules, a: Action<'addColumn'>): Out {
  let header = a.header;
  if (header === undefined) {
    let n = rules.output.columns.length + 1;
    while (rules.output.columns.some((c) => c.header === `Column ${n}`)) n++;
    header = `Column ${n}`;
  }
  const problems = checkHeader(rules, header);
  if (problems.length > 0) return problems;
  const at = clampIndex(a.at, rules.output.columns.length);
  const column: OutputColumnRule = { header, from: null };
  const columns = [...rules.output.columns];
  columns.splice(at, 0, column);
  const next = withOutput(rules, { columns });
  return a.method && a.method.kind !== 'empty' ? applyColumnMethod(next, at, a.method) : next;
}

function removeColumn(rules: EditableRules, a: Action<'removeColumn'>): Out {
  const col = rules.output.columns[a.index];
  if (!col) return noItem('column', a.index);
  if (rules.output.columns.length <= 1) {
    return fail({ code: 'rule', message: 'a file needs at least one column', path: 'index' });
  }
  let next = withOutput(rules, { columns: rules.output.columns.filter((_, i) => i !== a.index) });
  next = followHeader(next, (h) => (h === col.header ? undefined : h));
  if (col.from !== null) {
    next = pruneComputed(next, [col.from]);
    next = pruneValueMaps(next, [col.from]);
  }
  return next;
}

function setColumnFormat(rules: EditableRules, a: Action<'setColumnFormat'>): Out {
  const col = rules.output.columns[a.index];
  if (!col) return noItem('column', a.index);
  const problems: EditProblem[] = [];
  if (typeof a.format === 'string' && a.format.trim() === '') problems.push({ code: 'badValue', message: 'a format cannot be empty', path: 'format' });
  if (typeof a.width === 'number' && !(a.width > 0 && Number.isFinite(a.width))) {
    problems.push({ code: 'badValue', message: 'a width must be a positive number', path: 'width' });
  }
  if (problems.length > 0) return problems;
  let next: OutputColumnRule = { ...col };
  if (a.format === null) next = omit(next, 'format') as OutputColumnRule;
  else if (a.format !== undefined) next.format = a.format;
  if (a.width === null) next = omit(next, 'width') as OutputColumnRule;
  else if (a.width !== undefined) next.width = a.width;
  return withOutput(rules, { columns: rules.output.columns.map((c, i) => (i === a.index ? next : c)) });
}

function setColumnAgg(rules: EditableRules, a: Action<'setColumnAgg'>): Out {
  const col = rules.output.columns[a.index];
  if (!col) return noItem('column', a.index);
  const next: OutputColumnRule = a.agg === null ? (omit(col, 'agg') as OutputColumnRule) : { ...col, agg: a.agg };
  return withOutput(rules, { columns: rules.output.columns.map((c, i) => (i === a.index ? next : c)) });
}

// ---------- filters ----------

const NEEDS_NO_VALUE = new Set(['isEmpty', 'notEmpty']);
const NEEDS_LIST = new Set(['oneOf', 'notOneOf']);

function scalarFor(type: ValueType | undefined, column: string, v: FilterScalar): FilterScalar | EditProblem {
  if (v === null) return null;
  const mismatch = (got: string): EditProblem => ({
    code: 'typeMismatch',
    message: `filter value does not suit column "${column}" (${type}): got ${got}`,
    path: 'value',
    column,
  });
  switch (type) {
    case 'integer':
    case 'decimal': {
      if (typeof v === 'number') return v;
      if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v.replace(/,/g, '')))) return Number(v.replace(/,/g, ''));
      return mismatch(typeof v === 'boolean' ? 'boolean' : 'text');
    }
    case 'text':
    case 'idLike':
      return typeof v === 'string' ? v : String(v);
    case 'boolean': {
      if (typeof v === 'boolean') return v;
      if (v === 'true' || v === 'false') return v === 'true';
      return mismatch(typeof v === 'number' ? 'decimal' : 'text');
    }
    case 'date':
      return mismatch(typeof v === 'number' ? (Number.isInteger(v) ? 'integer' : 'decimal') : typeof v === 'boolean' ? 'boolean' : 'text');
    default:
      return v;
  }
}

function buildFilter(rules: EditableRules, input: FilterInput): RowFilter | EditProblem[] {
  const inputCol = rules.input.columns.find((c) => c.id === input.column);
  if (!inputCol) return fail({ code: 'unknownColumn', message: `unknown column id "${input.column}"`, column: input.column, path: 'column' });
  const type = idInfos(rules).get(input.column)?.type;
  if (NEEDS_NO_VALUE.has(input.op)) return { column: input.column, op: input.op } as RowFilter;
  if (NEEDS_LIST.has(input.op)) {
    const list = Array.isArray(input.value) ? input.value : input.value === undefined ? [] : [input.value];
    if (list.length === 0) return fail({ code: 'badValue', message: 'give at least one value', path: 'value' });
    const out: FilterScalar[] = [];
    for (const v of list) {
      const s = scalarFor(type, input.column, v);
      if (typeof s === 'object' && s !== null) return fail(s);
      out.push(s);
    }
    return { column: input.column, op: input.op, value: out } as RowFilter;
  }
  if (input.value === undefined || Array.isArray(input.value)) return fail({ code: 'badValue', message: 'give one value', path: 'value' });
  const s = scalarFor(type, input.column, input.value);
  if (typeof s === 'object' && s !== null) return fail(s);
  return { column: input.column, op: input.op, value: s } as RowFilter;
}

function addFilter(rules: EditableRules, a: Action<'addFilter'>): Out {
  const f = buildFilter(rules, a.filter);
  if (isProblems(f)) return f;
  const list = [...(rules.input.rowFilters ?? [])];
  list.splice(clampIndex(a.at, list.length), 0, f);
  return withInput(rules, { rowFilters: list });
}

function updateFilter(rules: EditableRules, a: Action<'updateFilter'>): Out {
  const list = rules.input.rowFilters ?? [];
  if (!list[a.index]) return noItem('filter', a.index);
  const f = buildFilter(rules, a.filter);
  if (isProblems(f)) return f;
  return withInput(rules, { rowFilters: list.map((x, i) => (i === a.index ? f : x)) });
}

function removeFilter(rules: EditableRules, a: Action<'removeFilter'>): Out {
  const list = rules.input.rowFilters ?? [];
  if (!list[a.index]) return noItem('filter', a.index);
  const next = list.filter((_, i) => i !== a.index);
  return next.length === 0 ? ({ ...rules, input: omit(rules.input, 'rowFilters') } as EditableRules) : withInput(rules, { rowFilters: next });
}

// ---------- duplicates, expand ----------

function setDedupe(rules: EditableRules, a: Action<'setDedupe'>): Out {
  if (!a.enabled) {
    if (!rules.transform.dedupe) return rules;
    return { ...rules, transform: omit(rules.transform, 'dedupe') } as EditableRules;
  }
  const current = rules.transform.dedupe;
  const keys = a.keys ?? current?.keys ?? 'all';
  if (keys !== 'all') {
    if (keys.length === 0) return fail({ code: 'badValue', message: 'choose at least one column, or all columns', path: 'keys' });
    const ids = new Set(rules.input.columns.map((c) => c.id));
    for (const k of keys) {
      if (!ids.has(k)) return fail({ code: 'unknownColumn', message: `unknown column id "${k}"`, column: k, path: 'keys' });
    }
  }
  // "flag" is the safe default: nothing disappears (SPEC 8.4).
  return withTransform(rules, { dedupe: { keys, keep: a.keep ?? current?.keep ?? 'first', action: a.action ?? current?.action ?? 'flag' } });
}

function parseSet(set: Record<string, string>, path: string): Record<string, import('@formatai/shared').Expr> | EditProblem[] {
  const out: Record<string, import('@formatai/shared').Expr> = {};
  const problems: EditProblem[] = [];
  for (const [id, text] of Object.entries(set)) {
    if (!IDENT.test(id)) {
      problems.push({ code: 'badValue', message: `"${id}" is not a usable column id (letters, digits and _)`, path: `${path}.${id}` });
      continue;
    }
    const parsed = parseFormula(text);
    if (!parsed.ok) problems.push({ code: 'formula', message: parsed.error.message, offset: parsed.error.offset, path: `${path}.${id}` });
    else Object.defineProperty(out, id, { value: parsed.expr, enumerable: true, writable: true, configurable: true });
  }
  return problems.length > 0 ? problems : out;
}

function setExpand(rules: EditableRules, a: Action<'setExpand'>): Out {
  const ex: ExpandInput | null = a.expand;
  if (ex === null) {
    if (!rules.transform.expand) return rules;
    return { ...rules, transform: omit(rules.transform, 'expand') } as EditableRules;
  }
  const inputIds = new Set(rules.input.columns.map((c) => c.id));
  const problems: EditProblem[] = [];
  const needInput = (id: string, path: string): void => {
    if (!inputIds.has(id)) problems.push({ code: 'unknownColumn', message: `unknown column id "${id}"`, column: id, path });
  };
  const needIdent = (id: string | undefined, path: string): void => {
    if (id !== undefined && !IDENT.test(id)) problems.push({ code: 'badValue', message: `"${id}" is not a usable column id (letters, digits and _)`, path });
  };
  if (ex.mode === 'columnsToRows') {
    ex.columns.forEach((c, i) => needInput(c, `columns[${i}]`));
    needIdent(ex.labelId, 'labelId');
    needIdent(ex.valueId, 'valueId');
    if (ex.columns.length === 0) problems.push({ code: 'tooFewTerms', message: 'choose at least one column to turn into rows', path: 'columns' });
    if (problems.length > 0) return problems;
    return withTransform(rules, { expand: ex });
  }
  if (ex.mode === 'splitCell') {
    needInput(ex.column, 'column');
    needIdent(ex.partId, 'partId');
    needIdent(ex.indexId, 'indexId');
    needIdent(ex.countId, 'countId');
    if (ex.separator === '') problems.push({ code: 'badValue', message: 'the separator cannot be empty', path: 'separator' });
    if (problems.length > 0) return problems;
    return withTransform(rules, { expand: ex });
  }
  if (ex.rows.length === 0) return fail({ code: 'tooFewTerms', message: 'a fan-out needs at least one row', path: 'rows' });
  const rows: { set: Record<string, import('@formatai/shared').Expr> }[] = [];
  for (let i = 0; i < ex.rows.length; i++) {
    const set = parseSet(ex.rows[i]!.set, `rows[${i}].set`);
    if (isProblems(set)) return set;
    rows.push({ set });
  }
  return withTransform(rules, { expand: { mode: 'fixedFanOut', rows } });
}

// ---------- title ----------

function setTitleRows(rules: EditableRules, rows: TitleRow[]): EditableRules {
  return withOutput(rules, { titleRows: rows });
}

function setTitleText(rules: EditableRules, a: Action<'setTitleText'>): Out {
  const rows = rules.output.titleRows;
  if (a.index < 0 || a.index > rows.length) return noItem('title row', a.index);
  const prev = rows[a.index];
  const bold = a.bold ?? (prev && 'bold' in prev ? prev.bold : undefined);
  const row: TitleRow = bold === undefined ? { text: a.text } : { text: a.text, bold };
  const list = [...rows];
  list[a.index] = row;
  return setTitleRows(rules, list);
}

function insertMonthFromDate(rules: EditableRules, a: Action<'insertMonthFromDate'>): Out {
  const infos = idInfos(rules);
  const info = infos.get(a.column);
  if (!info) return fail({ code: 'unknownColumn', message: `unknown column id "${a.column}"`, column: a.column, path: 'column' });
  if (info.type !== undefined && info.type !== 'date') {
    return fail({ code: 'typeMismatch', message: mismatchMessage('date', info.type), column: a.column, path: 'column' });
  }
  const rows = rules.output.titleRows;
  if (a.index < 0 || a.index > rows.length) return noItem('title row', a.index);
  const part = { agg: a.agg ?? ('max' as const), column: a.column, format: a.format ?? 'MMMM YYYY' };
  const prev = rows[a.index];
  let row: TitleRow;
  if (prev && 'parts' in prev) row = { ...prev, parts: [...prev.parts, part] };
  else if (prev && 'text' in prev) row = { parts: prev.text === '' ? [part] : [{ text: prev.text }, part], ...(prev.bold === undefined ? {} : { bold: prev.bold }) };
  else row = { parts: [part] };
  const list = [...rows];
  list[a.index] = row;
  return setTitleRows(rules, list);
}

// ---------- sort, group, summary rows ----------

function setSort(rules: EditableRules, keys: SortKey[]): Out {
  const seen = new Set<string>();
  for (const k of keys) {
    if (seen.has(k.column)) return fail({ code: 'duplicateKey', message: `"${k.column}" is in the sort twice`, column: k.column, path: 'keys' });
    seen.add(k.column);
  }
  return withTransform(rules, { sort: keys });
}

function setGroup(rules: EditableRules, group: GroupInput | null): Out {
  if (group === null) {
    if (!rules.transform.group) return rules;
    return { ...rules, transform: omit(rules.transform, 'group') } as EditableRules;
  }
  if (group.blankRowsAfter !== undefined && (!Number.isInteger(group.blankRowsAfter) || group.blankRowsAfter < 0 || group.blankRowsAfter > 20)) {
    return fail({ code: 'badValue', message: 'blank rows is a whole number from 0 to 20', path: 'blankRowsAfter' });
  }
  const current = rules.transform.group;
  const next = { ...(current ?? {}), by: group.by, showDetailRows: group.showDetailRows } as NonNullable<EditableRules['transform']['group']>;
  if (group.blankRowsAfter === undefined) delete next.blankRowsAfter;
  else next.blankRowsAfter = group.blankRowsAfter;
  return withTransform(rules, { group: next });
}

/** Sets the summary rows of a scope. A stored file that still has the old `grandTotal`/`subtotal` is migrated: the old field is dropped. */
function setSummary(rules: EditableRules, scope: SummaryScope, rows: SummaryRow[]): Out {
  const problems = rows.flatMap((r, i) => summaryRowProblems(rules, r, `rows[${i}]`));
  if (problems.length > 0) return problems;
  if (scope === 'end') {
    let output = omit(rules.output, 'grandTotal') as EditableRules['output'];
    output = rows.length === 0 ? (omit(output, 'summaryRows') as EditableRules['output']) : { ...output, summaryRows: rows };
    return { ...rules, output } as EditableRules;
  }
  const g = rules.transform.group;
  if (!g) return fail({ code: 'noGroup', message: 'groups are not set up: choose what to group by first', path: 'scope' });
  let group = omit(g, 'subtotal') as NonNullable<EditableRules['transform']['group']>;
  group = rows.length === 0 ? (omit(group, 'summaryRows') as typeof group) : { ...group, summaryRows: rows };
  return withTransform(rules, { group });
}

function currentSummary(rules: EditableRules, scope: SummaryScope): SummaryRow[] {
  return scope === 'end' ? effectiveEndSummaryRows(rules) : effectiveGroupSummaryRows(rules);
}

function addSummaryRow(rules: EditableRules, a: Action<'addSummaryRow'>): Out {
  const list = [...currentSummary(rules, a.scope)];
  list.splice(clampIndex(a.at, list.length), 0, a.row);
  return setSummary(rules, a.scope, list);
}
function updateSummaryRow(rules: EditableRules, a: Action<'updateSummaryRow'>): Out {
  const list = currentSummary(rules, a.scope);
  if (!list[a.index]) return noItem('summary row', a.index);
  return setSummary(rules, a.scope, list.map((r, i) => (i === a.index ? a.row : r)));
}
function removeSummaryRow(rules: EditableRules, a: Action<'removeSummaryRow'>): Out {
  const list = currentSummary(rules, a.scope);
  if (!list[a.index]) return noItem('summary row', a.index);
  return setSummary(rules, a.scope, list.filter((_, i) => i !== a.index));
}

function setOutputOptions(rules: EditableRules, a: Action<'setOutputOptions'>): Out {
  const p = a.patch;
  if (p.sheetName !== undefined && (p.sheetName.trim() === '' || p.sheetName.length > 31 || /[[\]:*?/\\]/.test(p.sheetName))) {
    return fail({ code: 'badValue', message: 'a sheet name has 1 to 31 characters and none of [ ] : * ? / \\', path: 'sheetName' });
  }
  const patch: Partial<EditableRules['output']> = {};
  if (p.sheetName !== undefined) patch.sheetName = p.sheetName;
  if (p.direction !== undefined) patch.direction = p.direction;
  if (p.language !== undefined) patch.language = p.language;
  if (p.file !== undefined) patch.file = p.file;
  if (p.headerBold !== undefined) patch.headerStyle = { ...(rules.output.headerStyle ?? {}), bold: p.headerBold };
  return withOutput(rules, patch);
}

// ---------- checks ----------

function addValidation(rules: EditableRules, a: Action<'addValidation'>): Out {
  const problems = validationProblems(rules, a.validation);
  if (problems.length > 0) return problems;
  const list = [...rules.validations];
  list.splice(clampIndex(a.at, list.length), 0, a.validation);
  return { ...rules, validations: list } as EditableRules;
}
function updateValidation(rules: EditableRules, a: Action<'updateValidation'>): Out {
  if (!rules.validations[a.index]) return noItem('check', a.index);
  const problems = validationProblems(rules, a.validation);
  if (problems.length > 0) return problems;
  return { ...rules, validations: rules.validations.map((v, i) => (i === a.index ? a.validation : v)) } as EditableRules;
}
function removeValidation(rules: EditableRules, a: Action<'removeValidation'>): Out {
  if (!rules.validations[a.index]) return noItem('check', a.index);
  return { ...rules, validations: rules.validations.filter((_, i) => i !== a.index) } as EditableRules;
}

function dismissAssumption(rules: EditableRules, a: Action<'dismissAssumption'>): Out {
  if (!rules.assumptions[a.index]) return noItem('assumption', a.index);
  return { ...rules, assumptions: rules.assumptions.filter((_, i) => i !== a.index) } as EditableRules;
}

// ---------- functions and tables (SPEC 8.14) ----------

function setFunction(rules: EditableRules, fn: FunctionInput): Out {
  if (!IDENT.test(fn.name)) return fail({ code: 'badValue', message: 'a function name uses letters, digits and _', path: 'name' });
  const params = fn.params.map((p) => p.name);
  if (params.some((p) => !IDENT.test(p))) return fail({ code: 'badValue', message: 'a parameter name uses letters, digits and _', path: 'params' });
  // A name the formula language already uses (round, if, ...) could never be called from a formula.
  const probe = parseFormula(`${fn.name}(${params.map(() => '1').join(', ')})`);
  if (!probe.ok || !('op' in probe.expr) || probe.expr.op !== 'call' || probe.expr.fn !== fn.name) {
    return fail({ code: 'badValue', message: `"${fn.name}" is a name the formulas already use`, path: 'name' });
  }
  const body = parseFormula(fn.body, { params });
  if (!body.ok) return fail({ code: 'formula', message: body.error.message, offset: body.error.offset, path: 'body' });
  const def = { name: fn.name, params: fn.params, returns: fn.returns, body: body.expr };
  const list = rules.transform.functions ?? [];
  const at = list.findIndex((f) => f.name === fn.name);
  return withTransform(rules, { functions: at < 0 ? [...list, def] : list.map((f, i) => (i === at ? def : f)) });
}
function removeFunction(rules: EditableRules, name: string): Out {
  const list = rules.transform.functions ?? [];
  if (!list.some((f) => f.name === name)) return fail({ code: 'noSuchItem', message: `there is no function "${name}"`, path: 'name' });
  const next = list.filter((f) => f.name !== name);
  return next.length === 0 ? ({ ...rules, transform: omit(rules.transform, 'functions') } as EditableRules) : withTransform(rules, { functions: next });
}
function setTable(rules: EditableRules, a: Action<'setTable'>): Out {
  const list = rules.transform.tables ?? [];
  const at = list.findIndex((t) => t.name === a.table.name);
  return withTransform(rules, { tables: at < 0 ? [...list, a.table] : list.map((t, i) => (i === at ? a.table : t)) });
}
function removeTable(rules: EditableRules, name: string): Out {
  const list = rules.transform.tables ?? [];
  if (!list.some((t) => t.name === name)) return fail({ code: 'noSuchItem', message: `there is no table "${name}"`, path: 'name' });
  const next = list.filter((t) => t.name !== name);
  return next.length === 0 ? ({ ...rules, transform: omit(rules.transform, 'tables') } as EditableRules) : withTransform(rules, { tables: next });
}

// ---------- the dispatcher ----------

/** Actions that change the rules. (markException / unmarkException / setAdvancedJson / replaceRules are handled by the model.) */
export type RulesAction = Exclude<EditAction, { type: 'markException' | 'unmarkException' | 'setAdvancedJson' | 'replaceRules' }>;

export function applyRulesAction(rules: EditableRules, a: RulesAction): Out {
  switch (a.type) {
    case 'setColumnHeader':
      return setColumnHeader(rules, a);
    case 'reorderColumns':
      return reorderColumns(rules, a);
    case 'addColumn':
      return addColumn(rules, a);
    case 'removeColumn':
      return removeColumn(rules, a);
    case 'setColumnMethod':
      return applyColumnMethod(rules, a.index, a.method);
    case 'setColumnFormat':
      return setColumnFormat(rules, a);
    case 'setColumnAgg':
      return setColumnAgg(rules, a);
    case 'addFilter':
      return addFilter(rules, a);
    case 'updateFilter':
      return updateFilter(rules, a);
    case 'removeFilter':
      return removeFilter(rules, a);
    case 'setDedupe':
      return setDedupe(rules, a);
    case 'setExpand':
      return setExpand(rules, a);
    case 'setTitleRows':
      return setTitleRows(rules, a.rows);
    case 'addTitleRow': {
      const rows = [...rules.output.titleRows];
      rows.splice(clampIndex(a.at, rows.length), 0, a.row);
      return setTitleRows(rules, rows);
    }
    case 'removeTitleRow':
      return rules.output.titleRows[a.index] ? setTitleRows(rules, rules.output.titleRows.filter((_, i) => i !== a.index)) : noItem('title row', a.index);
    case 'setTitleText':
      return setTitleText(rules, a);
    case 'insertMonthFromDate':
      return insertMonthFromDate(rules, a);
    case 'setSort':
      return setSort(rules, a.keys);
    case 'setGroup':
      return setGroup(rules, a.group);
    case 'setSummaryRows':
      return setSummary(rules, a.scope, a.rows);
    case 'addSummaryRow':
      return addSummaryRow(rules, a);
    case 'updateSummaryRow':
      return updateSummaryRow(rules, a);
    case 'removeSummaryRow':
      return removeSummaryRow(rules, a);
    case 'setOutputOptions':
      return setOutputOptions(rules, a);
    case 'addValidation':
      return addValidation(rules, a);
    case 'updateValidation':
      return updateValidation(rules, a);
    case 'removeValidation':
      return removeValidation(rules, a);
    case 'dismissAssumption':
      return dismissAssumption(rules, a);
    case 'setFunction':
      return setFunction(rules, a.fn);
    case 'removeFunction':
      return removeFunction(rules, a.name);
    case 'setTable':
      return setTable(rules, a);
    case 'removeTable':
      return removeTable(rules, a.name);
  }
}
