// One generated stress case (eval/STRESS.md): from a seed, a messy input file, reference rules built from the rules language's real
// operations, the example output those rules make through the real `convertFile`, and a hold-out pair (fresh rows, same rules). The
// ground truth is the reference rules run by the engine's pipeline - the part under test is the FREE learn (pair analysis, fast path,
// local partial result), which never sees the reference rules.
import { checkLimits, convertFile, makeValidIsraeliId, typeCheck, type ConvertResult } from '@formatai/engine';
import { checkRules, RulesSchema, type Computed, type Expr, type InputColumn, type OutputColumnRule, type RowFilter, type Rules, type SummaryRow, type TitleRow } from '@formatai/shared';
import { chance, makeRng, pick, randInt, shuffle, type Rng } from '../cases/lib/prng';
import { EN_STATUS as CAT_EN_STATUS } from '../catalogue/data';
import { cellValue, DATE_KINDS, makeColumns, newValueState, NUMBER_KINDS, TEXT_KINDS, type GenCell, type InCol, type Lang, type ValueState } from './data';
import { delimitedText, encodableIn1255, writeInput, type FileArtifact, type InputLayout } from './files';

export type SizeProfile = 'small' | 'mixed' | 'large' | 'timing';

export interface StressCase {
  seed: number;
  profile: SizeProfile;
  lang: Lang | 'mixed';
  /** What the case exercises (coverage tags: file kinds, mess, column kinds, operations). */
  features: string[];
  cols: InCol[];
  layout: InputLayout;
  rules: Rules;
  exampleRows: GenCell[][];
  nextRows: GenCell[][];
  input: FileArtifact;
  output: FileArtifact;
  nextInput: FileArtifact;
  nextOutput: FileArtifact;
  /** The reference conversions (the truth: which input row made which output row, and the cells). */
  refExample: Extract<ConvertResult, { ok: true }>;
  refNext: Extract<ConvertResult, { ok: true }>;
  /** Generation time, ms (files + reference conversions). */
  genMs: number;
}

/** A generator bug (the reference rules are not valid, or the engine refused to run them): never an engine finding by itself. */
export class GenError extends Error {
  constructor(
    message: string,
    readonly rules?: Rules,
    readonly files: FileArtifact[] = [],
  ) {
    super(message);
    this.name = 'GenError';
  }
}

// ---------------------------------------------------------------------------
// Sizes
// ---------------------------------------------------------------------------

function sizeOf(rng: Rng, profile: SizeProfile): { rows: number; cols: number } {
  if (profile === 'timing') return { rows: 20000, cols: 20 };
  if (profile === 'small') return { rows: pick(rng, [2, 3, 5, 8, 12, 20, 30, 50, 80, 120]), cols: randInt(rng, 2, 12) };
  if (profile === 'large') return { rows: randInt(rng, 3000, 20000), cols: randInt(rng, 5, 40) };
  const r = rng();
  const rows = r < 0.5 ? randInt(rng, 2, 60) : r < 0.78 ? randInt(rng, 60, 500) : r < 0.92 ? randInt(rng, 500, 3000) : r < 0.98 ? randInt(rng, 3000, 8000) : randInt(rng, 8000, 20000);
  const c = rng();
  const cols = c < 0.6 ? randInt(rng, 2, 10) : c < 0.9 ? randInt(rng, 10, 20) : randInt(rng, 20, 40);
  return { rows, cols };
}

// ---------------------------------------------------------------------------
// Input declarations
// ---------------------------------------------------------------------------

function inputColumnOf(col: InCol, layout: InputLayout): InputColumn {
  const base = { id: col.id, header: col.header };
  switch (col.kind) {
    case 'idText':
      return { ...base, type: 'idLike' };
    case 'idNum':
      return { ...base, type: 'integer' };
    case 'israeliId':
      return col.asNumber ? { ...base, type: 'idLike', padLeft: 9 } : { ...base, type: 'idLike' };
    case 'int':
      return { ...base, type: 'integer' };
    case 'decimal':
    case 'money':
      return { ...base, type: 'decimal' };
    case 'date':
      return layout.fileType === 'xlsx' ? { ...base, type: 'date' } : { ...base, type: 'date', inputFormats: ['DD/MM/YYYY'] };
    case 'dateText':
      return { ...base, type: 'date', inputFormats: [col.dateFormat!] };
    case 'dateSerial':
      return { ...base, type: 'date', inputFormats: ['excelSerial'] };
    default:
      return { ...base, type: 'text' };
  }
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

interface Builder {
  rng: Rng;
  cols: InCol[];
  inputs: Map<string, InputColumn>;
  computed: Computed[];
  valueMaps: Rules['transform']['valueMaps'];
  out: OutputColumnRule[];
  headers: Set<string>;
  features: Set<string>;
  n: number;
  lang: Lang;
  /** Example rows, for picking values the data really holds. */
  rows: GenCell[][];
  outFileType: 'xlsx' | 'csv' | 'txt';
}

const RENAMES: Record<Lang, string[]> = {
  he: ['שם', 'קוד', 'ערך', 'סכום סופי', 'מזהה', 'תאריך סופי', 'סיווג', 'הערה', 'מחיר כולל', 'מספר', 'פרטים', 'תווית'],
  en: ['Name', 'Code', 'Value', 'Final Amount', 'Identifier', 'Final Date', 'Class', 'Remark', 'Gross', 'Number', 'Info', 'Label'],
};

function outHeader(b: Builder, col: InCol | null, rename: boolean): string {
  let h = col && !rename ? col.header : pick(b.rng, RENAMES[col?.lang ?? b.lang]);
  for (let k = 2; b.headers.has(h); k++) h = `${col && !rename ? col.header : h.replace(/ \d+$/, '')} ${k}`;
  b.headers.add(h);
  return h;
}

/** A computed column's id: "v" + a counter + what it is ("v3upper") - never an input id (those start with their kind). */
function newId(b: Builder, base: string): string {
  b.n += 1;
  return `v${b.n}${base}`;
}

/** An operand of a text join: a column that is not text is turned into text first (the language does not join a number as it is). */
function asText(b: Builder, col: InCol): Expr {
  const t = b.inputs.get(col.id)!.type;
  return t === 'text' || t === 'idLike' ? { col: col.id } : { op: 'toText', arg: { col: col.id } };
}

function addComputed(b: Builder, base: string, type: Computed['type'], expr: Expr): string {
  const id = newId(b, base);
  b.computed.push({ id, type, expr });
  return id;
}

function colsOf(b: Builder, pred: (c: InCol) => boolean): InCol[] {
  return b.cols.filter(pred);
}

/** The values a column holds in the example (text cells, trimmed of nothing). */
function textValues(b: Builder, col: InCol): string[] {
  const i = b.cols.indexOf(col);
  const out = new Set<string>();
  for (const r of b.rows) {
    const c = r[i];
    if (c && 's' in c && c.s.trim() !== '') out.add(c.s);
  }
  return [...out];
}

function numberValues(b: Builder, col: InCol): number[] {
  const i = b.cols.indexOf(col);
  const out: number[] = [];
  for (const r of b.rows) {
    const c = r[i];
    if (c && 'n' in c) out.push(c.n);
  }
  return out;
}

/** One output column made from `col` by a random operation that fits its kind. Returns the op's name (a feature tag). */
function addOutputColumn(b: Builder, col: InCol): string {
  const rng = b.rng;
  const id = col.id;
  const rename = chance(rng, 0.4);
  const push = (from: string, format?: string): void => {
    b.out.push({ header: outHeader(b, col, rename), from, ...(format !== undefined ? { format } : {}) });
  };
  const r = rng();
  if (r < 0.35) {
    push(id);
    return rename ? 'rename' : 'copy';
  }
  const kind = col.kind;
  if (TEXT_KINDS.has(kind)) {
    const others = colsOf(b, (c) => c !== col && (c.kind === 'name' || c.kind === 'city' || c.kind === 'category' || c.kind === 'code' || c.kind === 'company'));
    // (A value map, a case change, a cut of the text: each only where the example SHOWS it - two keys at least, a letter whose case
    // changes, a text longer than the part - or the example is the same as a copy and next month's file judges a rule it never held.)
    const values = textValues(b, col).map((v) => v.trim());
    if (kind === 'category' && values.length >= 2 && chance(rng, 0.45)) {
      const copyId = addComputed(b, 'mapped', 'text', { col: id });
      const vocab = col.vocab!;
      const targets = chance(rng, 0.5) ? CAT_EN_STATUS : vocab.map((_, k) => `K${k + 1}`);
      const map: Record<string, string> = {};
      vocab.forEach((v, k) => (map[v] = targets[k] ?? `K${k + 1}`));
      b.valueMaps.push({ column: copyId, map, onMissing: 'flag' });
      push(copyId);
      return 'valueMap';
    }
    if (kind === 'multi' && chance(rng, 0.5)) {
      push(addComputed(b, 'first', 'text', { op: 'trim', arg: { op: 'split', arg: { col: id }, separator: col.separator!.trim(), index: 1 } }));
      return 'split';
    }
    const t = rng();
    if (t < 0.3 && values.some((v) => v !== v.toUpperCase())) {
      push(addComputed(b, 'upper', 'text', { op: 'upper', arg: { op: 'trim', arg: { col: id } } }));
      return 'trimUpper';
    }
    if (t < 0.6) {
      const prefix = pick(rng, ['ID-', 'X', '#', 'מס ', 'C/']);
      push(addComputed(b, 'tpl', 'text', { op: 'concat', args: [{ const: prefix }, asText(b, col)] }));
      return 'template';
    }
    if (t < 0.85 && others.length > 0) {
      const other = pick(rng, others);
      const sep = pick(rng, [' - ', ', ', ' ', '/']);
      push(addComputed(b, 'concat', 'text', { op: 'concat', args: [asText(b, col), { const: sep }, asText(b, other)] }));
      return 'concat';
    }
    const shortest = Math.min(...values.map((v) => v.length));
    if (values.length > 0 && shortest >= 3) {
      push(addComputed(b, 'part', 'text', { op: 'substr', arg: { col: id }, start: 1, length: randInt(rng, 2, Math.min(5, shortest - 1)) }));
      return 'substr';
    }
    push(id);
    return 'copy';
  }
  if (kind === 'idNum' || kind === 'israeliId') {
    const input = b.inputs.get(id)!;
    if (kind === 'idNum' && chance(rng, 0.5)) {
      input.type = 'idLike';
      input.padLeft = (col.width ?? 7) + randInt(rng, 1, 3);
      push(id);
      return 'padLeft';
    }
    if (chance(rng, 0.5)) {
      push(addComputed(b, 'tpl', 'text', { op: 'concat', args: [{ const: pick(rng, ['C-', 'ת.ז ', 'N']) }, asText(b, col)] }));
      return 'template';
    }
    push(id);
    return 'copy';
  }
  if (NUMBER_KINDS.has(kind)) {
    const t = rng();
    const numbers = colsOf(b, (c) => c !== col && NUMBER_KINDS.has(c.kind));
    if (t < 0.25) {
      const k = pick(rng, [1.17, 0.9, 100, 1.5, 0.18, 12, 0.5, 3]);
      push(addComputed(b, 'scaled', 'decimal', { op: 'round', digits: 2, arg: { op: 'mul', args: [{ col: id }, { const: k }] } }));
      return 'mulConst';
    }
    if (t < 0.35) {
      push(addComputed(b, 'shifted', 'decimal', { op: 'round', digits: 2, arg: { op: 'add', args: [{ col: id }, { const: pick(rng, [10, -5, 2.5, 100]) }] } }));
      return 'addConst';
    }
    if (t < 0.5 && numbers.length > 0) {
      push(addComputed(b, 'product', 'decimal', { op: 'round', digits: 2, arg: { op: 'mul', args: [{ col: id }, { col: pick(rng, numbers).id }] } }));
      return 'mul';
    }
    if (t < 0.62) {
      push(addComputed(b, 'numText', 'text', { op: 'toText', arg: { col: id }, format: pick(rng, ['#,##0.00', '0.00', '#,##0']) }));
      return 'numberFormat';
    }
    if (t < 0.72 && b.outFileType === 'xlsx') {
      push(id, pick(rng, ['#,##0.00', '0.0', '#,##0 ₪']));
      return 'numberDisplayFormat';
    }
    // A band whose cut-off sits between two values of the example, so that both classes show.
    const distinct = [...new Set(numberValues(b, col))].sort((x, y) => x - y);
    if (t < 0.88 && distinct.length >= 2) {
      const cut = distinct[randInt(rng, 1, distinct.length - 1)]!;
      const [hi, lo] = col.lang === 'he' ? ['גבוה', 'נמוך'] : ['High', 'Low'];
      push(addComputed(b, 'band', 'text', { op: 'if', cond: { op: 'gte', args: [{ col: id }, { const: cut }] }, then: { const: hi }, else: { const: lo } }));
      return 'band';
    }
    const cats = colsOf(b, (c) => c.kind === 'category');
    if (cats.length > 0 && chance(rng, 0.6)) {
      push(addComputed(b, 'groupTotal', 'decimal', { op: 'window', fn: 'groupSum', arg: { col: id }, by: [pick(rng, cats).id] }));
      return 'groupSum';
    }
    push(id);
    return 'copy';
  }
  if (DATE_KINDS.has(kind)) {
    const t = rng();
    if (t < 0.4) {
      push(addComputed(b, 'dateText', 'text', { op: 'dateFormat', arg: { col: id }, format: pick(rng, ['DD/MM/YYYY', 'YYYY-MM-DD', 'MM/YYYY', 'D.M.YY', 'DD-MM-YYYY']) }));
      return 'dateFormat';
    }
    if (t < 0.55) {
      push(addComputed(b, 'datePart', 'integer', { op: 'datePart', arg: { col: id }, part: pick(rng, ['year', 'month', 'day'] as const) }));
      return 'datePart';
    }
    push(id, pick(rng, ['DD/MM/YYYY', 'YYYY-MM-DD', 'D/M/YYYY']));
    return 'dateCopy';
  }
  push(id);
  return 'copy';
}

function addRowOps(b: Builder, rules: Rules): void {
  const rng = b.rng;
  const f = b.features;
  // A filter: drop a category value, keep two, drop the small / large amounts, or drop empty cells.
  if (chance(rng, 0.3)) {
    const cats = colsOf(b, (c) => c.kind === 'category' && c.emptyRate === 0 && c.injectRate === 0 && c.messRate === 0);
    const nums = colsOf(b, (c) => (c.kind === 'int' || c.kind === 'decimal') && c.injectRate === 0);
    const withEmpty = colsOf(b, (c) => c.emptyRate > 0);
    const t = rng();
    let filter: RowFilter | null = null;
    if (t < 0.55 && cats.length > 0) {
      const col = pick(rng, cats);
      const seen = textValues(b, col);
      if (seen.length >= 2) {
        const s = shuffle(rng, seen);
        filter = chance(rng, 0.5) ? { column: col.id, op: 'ne', value: s[0]! } : chance(rng, 0.5) ? { column: col.id, op: 'oneOf', value: s.slice(0, Math.max(1, s.length - 1)) } : { column: col.id, op: 'notOneOf', value: [s[0]!] };
        (b as Builder & { filterCol?: InCol }).filterCol = col;
      }
    } else if (t < 0.85 && nums.length > 0) {
      const col = pick(rng, nums);
      const values = numberValues(b, col).sort((x, y) => x - y);
      if (values.length >= 4) {
        const cut = Math.round(values[Math.floor(values.length / 3)]!);
        filter = { column: col.id, op: pick(rng, ['gt', 'gte'] as const), value: cut };
        (b as Builder & { filterCol?: InCol; filterCut?: number }).filterCol = col;
        (b as Builder & { filterCut?: number }).filterCut = cut;
      }
    } else if (withEmpty.length > 0) {
      filter = { column: pick(rng, withEmpty).id, op: 'notEmpty' };
    }
    if (filter) {
      rules.input.rowFilters = [filter];
      f.add(`row:filter:${filter.op}`);
    }
  }
  if (chance(rng, 0.15)) {
    const keys = colsOf(b, (c) => c.kind === 'idNum' || c.kind === 'idText' || c.kind === 'code' || c.kind === 'name');
    rules.transform.dedupe =
      keys.length > 0 && chance(rng, 0.5) ? { keys: [pick(rng, keys).id], keep: pick(rng, ['first', 'last'] as const), action: 'remove' } : { keys: 'all', keep: 'first', action: 'remove' };
    f.add(`row:dedupe:${rules.transform.dedupe.keys === 'all' ? 'all' : 'key'}`);
  }
  const used = b.out.filter((o) => o.from !== null).map((o) => o.from!);
  if (chance(rng, 0.2) && used.length > 0) {
    rules.transform.sort = [{ column: pick(rng, used), dir: pick(rng, ['asc', 'desc'] as const) }];
    f.add('row:sort');
  }
  const multi = colsOf(b, (c) => c.kind === 'multi' && c.injectRate === 0);
  if (chance(rng, 0.1) && multi.length > 0) {
    const col = pick(rng, multi);
    rules.transform.expand = { mode: 'splitCell', column: col.id, separator: col.separator!.trim(), trim: true, partId: 'part', skipEmpty: true };
    b.out.push({ header: outHeader(b, null, true), from: 'part' });
    f.add('row:expand');
  }
  // Summary rows need a number column in the output (the sum) and a text column for the label.
  const numberOut = rules.output.columns.filter((o) => {
    const comp = b.computed.find((c) => c.id === o.from);
    if (comp) return comp.type === 'decimal' || comp.type === 'integer';
    const input = o.from !== null ? b.inputs.get(o.from) : undefined;
    return input !== undefined && (input.type === 'decimal' || input.type === 'integer');
  });
  if (chance(rng, 0.15) && numberOut.length > 0) {
    const label = b.lang === 'he' ? 'סה"כ' : 'Total';
    const cells: SummaryRow['cells'] = {};
    for (const o of numberOut.slice(0, 2)) cells[o.header] = 'sum';
    const labelColumn = rules.output.columns.find((o) => !(o.header in cells))?.header;
    rules.output.summaryRows = [{ label, ...(labelColumn !== undefined ? { labelColumn } : {}), bold: true, cells }];
    f.add('row:summary');
  } else if (chance(rng, 0.06) && numberOut.length > 0) {
    const cats = colsOf(b, (c) => c.kind === 'category' && b.out.some((o) => o.from === c.id));
    if (cats.length > 0) {
      rules.transform.group = { by: pick(rng, cats).id, showDetailRows: true, blankRowsAfter: 1, summaryRows: [{ label: b.lang === 'he' ? 'ביניים' : 'Subtotal', cells: { [numberOut[0]!.header]: 'sum' } }] };
      f.add('row:group');
    }
  }
  if (chance(rng, 0.15)) {
    const titles: TitleRow[] = [{ text: b.lang === 'he' ? 'דוח מסכם' : 'Summary report', bold: true }];
    if (chance(rng, 0.5)) titles.push({ blank: true });
    rules.output.titleRows = titles;
    f.add('out:titleRows');
  }
}

function makeRules(rng: Rng, cols: InCol[], layout: InputLayout, rows: GenCell[][], lang: Lang, features: Set<string>): Rules & { filterCol?: InCol; filterCut?: number } {
  const inputs = new Map(cols.map((c) => [c.id, inputColumnOf(c, layout)] as const));
  const outFileType = pick(rng, ['xlsx', 'xlsx', 'xlsx', 'csv', 'csv', 'txt'] as const);
  const b: Builder & { filterCol?: InCol; filterCut?: number } = {
    rng,
    cols,
    inputs,
    computed: [],
    valueMaps: [],
    out: [],
    headers: new Set(),
    features,
    n: 0,
    lang,
    rows,
    outFileType,
  };
  const nOut = Math.max(1, Math.min(randInt(rng, 1, cols.length + 3), 25));
  const order = shuffle(rng, cols);
  for (let k = 0; k < nOut; k++) {
    const col = order[k % order.length]!;
    features.add(`op:${addOutputColumn(b, col)}`);
  }
  if (chance(rng, 0.05)) {
    b.out.push({ header: outHeader(b, null, true), from: addComputed(b, 'fixed', 'text', { const: lang === 'he' ? 'קבוע' : 'Fixed' }) });
    features.add('op:constant');
  }
  const file = outFileType === 'xlsx' ? undefined : { type: outFileType, ...(chance(rng, 0.2) ? { header: false } : {}), ...(chance(rng, 0.3) ? { encoding: pick(rng, ['utf8', 'windows1255'] as const) } : {}), ...(chance(rng, 0.15) ? { quote: 'all' as const } : {}), ...(outFileType === 'csv' && chance(rng, 0.2) ? { delimiter: ';' as const } : {}) };
  const rules: Rules = {
    schemaVersion: 1,
    name: 'stress reference',
    meta: { source: 'examplePair', status: 'verified' },
    input: {
      sheet: { pick: 'first' },
      headerRow: 'auto',
      columns: cols.map((c) => inputs.get(c.id)!),
      ...(layout.totalsRow ? { stopAt: { when: 'firstCellMatches' as const, values: [layout.totalsLabel] } } : {}),
    },
    transform: { computed: b.computed, valueMaps: b.valueMaps, sort: [] },
    output: {
      ...(file ? { file } : {}),
      sheetName: lang === 'he' ? 'פלט' : 'Output',
      direction: lang === 'he' ? 'rtl' : 'ltr',
      language: lang,
      titleRows: [],
      columns: b.out,
      ...(chance(rng, 0.5) ? { headerStyle: { bold: true } } : {}),
    },
    validations: [],
    unsupported: [],
    assumptions: [],
  };
  addRowOps(b, rules);
  if (file) features.add(`out:${file.type}${file.header === false ? ':noHeader' : ''}${file.encoding ? `:${file.encoding}` : ''}`);
  else features.add('out:xlsx');
  return Object.assign(rules, b.filterCol ? { filterCol: b.filterCol } : {}, b.filterCut !== undefined ? { filterCut: b.filterCut } : {});
}

/** Every problem the rules language's own checks find in the reference rules: a non-empty list is a generator bug. */
export function ruleProblems(rules: Rules): string[] {
  const problems: string[] = [];
  const parsed = RulesSchema.safeParse(rules);
  if (!parsed.success) for (const i of parsed.error.issues.slice(0, 5)) problems.push(`schema ${i.path.join('.')}: ${i.message}`);
  for (const p of checkRules(rules)) problems.push(`checkRules ${p.path}: ${p.message}`);
  for (const p of typeCheck(rules)) problems.push(`typeCheck ${p.path}: ${p.message}`);
  for (const p of checkLimits(rules, 'paid')) problems.push(`limits: ${p.message}`);
  return problems;
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

const isBlankCell = (c: GenCell | undefined): boolean => c === null || c === undefined || ('s' in c && c.s.trim() === '');
const isBlankRow = (row: GenCell[]): boolean => row.every((c) => isBlankCell(c));

function genRows(rng: Rng, cols: InCol[], n: number, variant: 'example' | 'next', layout: InputLayout, st: ValueState): GenCell[][] {

  const rows: GenCell[][] = [];
  for (let i = 0; i < n; i++) {
    const row = cols.map((c) => cellValue(rng, c, st, variant));
    // (A row blank in every column splits the table in two: the engine reads a second table, rightly. Not what a case tests.)
    if (isBlankRow(row)) continue;
    rows.push(row);
    // An exact duplicate of an earlier row.
    if (layout.dupRate > 0 && rows.length > 1 && chance(rng, layout.dupRate)) rows.push([...rows[randInt(rng, 0, rows.length - 2)]!]);
  }
  return rows;
}

function totalsRowOf(cols: InCol[], rows: GenCell[][], label: string): GenCell[] {
  return cols.map((c, i) => {
    if (i === 0) return { s: label };
    if (c.kind !== 'int' && c.kind !== 'decimal') return null;
    let sum = 0;
    for (const r of rows) {
      const v = r[i];
      if (v && 'n' in v) sum += v.n;
    }
    return { n: Math.round(sum * 100) / 100 };
  });
}

/**
 * A fair hold-out (STRESS.md "Fair hold-outs"): next month may bring values the example never showed, except where the example cannot
 * say what the rule does with them - a filter's column keeps to the values the example showed, and no number of a filter's column falls
 * between the example's nearest values on each side of the cut-off.
 */
function makeFair(rows: GenCell[][], example: GenCell[][], cols: InCol[], filterCol: InCol | undefined, cut: number | undefined, rng: Rng): void {
  if (!filterCol) return;
  const i = cols.indexOf(filterCol);
  if (cut === undefined) {
    const seen = [...new Set(example.map((r) => r[i]).filter((c): c is { s: string } => c !== null && c !== undefined && 's' in c).map((c) => c.s))];
    if (seen.length === 0) return;
    for (const r of rows) {
      const c = r[i];
      if (c && 's' in c && !seen.includes(c.s)) r[i] = { s: pick(rng, seen) };
    }
    return;
  }
  const nums = example.map((r) => r[i]).filter((c): c is { n: number } => c !== null && c !== undefined && 'n' in c).map((c) => c.n);
  const below = Math.max(...nums.filter((v) => v < cut), -Infinity);
  const above = Math.min(...nums.filter((v) => v >= cut), Infinity);
  for (const r of rows) {
    const c = r[i];
    if (c && 'n' in c && c.n > below && c.n < above && c.n !== cut) r[i] = { ...c, n: c.n < cut ? below : above };
  }
}

/** The kinds of stray characters a cell may carry, each with what takes it out: the example shows a kind, or the hold-out has none. */
const MESS_KINDS: { test: RegExp; clean: (s: string) => string }[] = [
  { test: /[\u200e\u200f]/, clean: (s) => s.replace(/[\u200e\u200f]/g, '') },
  { test: /\u00a0/, clean: (s) => s.replace(/\u00a0/g, ' ') },
  { test: /^\s|\s$/, clean: (s) => s.trim() },
];

/** Fair hold-outs, continued: a column whose example cells show no stray space, NBSP or direction mark gets none next month either (the
 * example cannot say whether the rule keeps them or trims them: a copy and a trim fit it alike). Per kind: an example that shows a
 * direction mark says nothing about a leading space (a text reading drops the one and keeps the other). */
function cleanUnshownMess(rows: GenCell[][], example: GenCell[][], cols: InCol[]): void {
  cols.forEach((_, i) => {
    for (const kind of MESS_KINDS) {
      if (example.some((r) => { const c = r[i]; return c !== null && c !== undefined && 's' in c && kind.test.test(c.s); })) continue;
      for (const r of rows) {
        const c = r[i];
        if (c && 's' in c && kind.test.test(c.s)) r[i] = { s: kind.clean(c.s) };
      }
    }
  });
}

/** Fair hold-outs, continued: a column empty on every example row stays empty next month - a copy of it and an empty column (or any rule
 * on it) write the same example. */
function keepEmptyColumnsEmpty(rows: GenCell[][], example: GenCell[][], cols: InCol[]): void {
  cols.forEach((_, i) => {
    if (!example.every((r) => isBlankCell(r[i]))) return;
    for (const r of rows) r[i] = null;
  });
}

/** Fair hold-outs, continued: a column a value map reads takes next month only the keys its example shows - the example cannot say what
 * an unseen key maps to ("Closed" -> "K5" in a map whose every shown entry keeps its value). */
function keepShownMapKeys(rows: GenCell[][], example: GenCell[][], cols: InCol[], rules: Rules, rng: Rng): void {
  for (const vm of rules.transform.valueMaps) {
    const expr = rules.transform.computed.find((c) => c.id === vm.column)?.expr;
    const id = expr !== undefined && 'col' in expr ? expr.col : vm.column;
    const i = cols.findIndex((c) => c.id === id);
    if (i < 0) continue;
    const seen = [...new Set(example.map((r) => r[i]).filter((c): c is { s: string } => c !== null && c !== undefined && 's' in c).map((c) => c.s))];
    const keys = new Set(seen.map((s) => s.trim()));
    if (seen.length === 0) continue;
    for (const r of rows) {
      const c = r[i];
      if (c && 's' in c && !keys.has(c.s.trim())) r[i] = { s: pick(rng, seen) };
    }
  }
}

/** Fair hold-outs, continued: an ID column stored as numbers whose example shows no ID that lost its leading zero (every one 9 digits)
 * gets none next month either - the example cannot say whether a short ID is padded back (the reference rules pad it: `padLeft: 9`). */
function keepShownIdLengths(rows: GenCell[][], example: GenCell[][], cols: InCol[], rng: Rng): void {
  cols.forEach((col, i) => {
    if (col.kind !== 'israeliId' || !col.asNumber) return;
    if (example.some((r) => { const c = r[i]; return c !== null && c !== undefined && 'n' in c && c.n < 1e8; })) return;
    for (const r of rows) {
      const c = r[i];
      if (c && 'n' in c && c.n < 1e8) r[i] = { n: Number(makeValidIsraeliId(`${randInt(rng, 1, 3)}${String(c.n).padStart(8, '0').slice(1, 8)}`)) };
    }
  });
}

/**
 * The row-level parts of the reference rules the example does not SHOW (a sort the input is already in, a filter that drops nothing, a
 * dedupe that removes nothing): no learner can see them, so they are taken out of the reference rules (the hold-out would otherwise judge
 * the free engine on a rule its example never held).
 */
function unshownParts(rules: Rules, run: Extract<ConvertResult, { ok: true }>): ('sort' | 'filter' | 'dedupe')[] {
  const out: ('sort' | 'filter' | 'dedupe')[] = [];
  if (rules.transform.sort.length > 0 && !rules.transform.group) {
    const src = run.sheet.rows.filter((r) => r.kind === 'data').map((r) => r.sourceRow ?? 0);
    if (src.every((s, i) => i === 0 || s >= src[i - 1]!)) out.push('sort');
  }
  if ((rules.input.rowFilters?.length ?? 0) > 0 && run.summary.rowsFiltered === 0) out.push('filter');
  if (rules.transform.dedupe && run.summary.duplicatesRemoved.length === 0) out.push('dedupe');
  return out;
}

// ---------------------------------------------------------------------------
// The case
// ---------------------------------------------------------------------------

function chooseLayout(rng: Rng, lang: Lang | 'mixed', features: Set<string>): InputLayout {
  const fileType = pick(rng, ['xlsx', 'xlsx', 'xlsx', 'csv', 'csv', 'txt'] as const);
  const he = lang === 'he' || (lang === 'mixed' && chance(rng, 0.5));
  const titleRows: string[] = [];
  if (chance(rng, 0.25)) {
    titleRows.push(he ? 'דוח לקוחות חודשי' : 'Monthly customer report');
    if (chance(rng, 0.5)) titleRows.push(he ? 'הופק בתאריך 01/03/2026' : 'Produced 01/03/2026');
    if (chance(rng, 0.5)) titleRows.push('');
  }
  const layout: InputLayout = {
    fileType,
    delimiter: fileType === 'txt' ? '\t' : pick(rng, [',', ',', ';', '|'] as const),
    encoding: pick(rng, ['utf8', 'utf8bom', 'utf8bom', 'windows1255'] as const),
    quoteAll: chance(rng, 0.15),
    titleRows,
    mergeTitle: chance(rng, 0.5),
    totalsRow: chance(rng, 0.15),
    totalsLabel: he ? 'סה"כ' : 'Total',
    dupRate: chance(rng, 0.2) ? pick(rng, [0.02, 0.05, 0.1]) : 0,
    direction: he ? 'rtl' : 'ltr',
    sheetName: he ? 'נתונים' : 'Data',
    headerBold: chance(rng, 0.5),
  };
  features.add(`in:${fileType}`);
  if (fileType !== 'xlsx') features.add(`in:${fileType}:${layout.encoding}:${layout.delimiter === '\t' ? 'tab' : layout.delimiter}`);
  if (titleRows.length > 0) features.add('in:titleRows');
  if (layout.totalsRow) features.add('in:totalsRow');
  if (layout.dupRate > 0) features.add('in:duplicateRows');
  return layout;
}

function allStrings(rows: GenCell[][], headers: string[], layout: InputLayout): string[] {
  const out = [...headers, ...layout.titleRows];
  for (const r of rows) for (const c of r) out.push(delimitedText(c));
  return out;
}

export interface BuildOptions {
  profile?: SizeProfile;
}

/** The whole case for `seed`: deterministic (same seed, same files and rules). Throws `GenError` for a generator bug. */
export async function buildCase(seed: number, opts: BuildOptions = {}): Promise<StressCase> {
  const t0 = Date.now();
  const profile = opts.profile ?? 'mixed';
  const rng = makeRng(`stress#${seed}`);
  const features = new Set<string>();
  const size = sizeOf(rng, profile);
  const lang: Lang | 'mixed' = pick(rng, ['he', 'en', 'mixed'] as const);
  const colOpts = { lang, inject: chance(rng, 0.4), mess: chance(rng, 0.5), empties: chance(rng, 0.5), otherScripts: chance(rng, 0.15), emoji: chance(rng, 0.2) };
  const cols = makeColumns(rng, size.cols, colOpts);
  const layout = chooseLayout(rng, lang, features);
  features.add(`lang:${lang}`);
  for (const [k, on] of Object.entries(colOpts)) if (on && k !== 'lang') features.add(`mess:${k}`);
  for (const c of cols) features.add(`col:${c.kind}`);

  const exampleState = newValueState();
  const exampleRows = genRows(makeRng(`stress#${seed}:example`), cols, size.rows, 'example', layout, exampleState);
  const outLang: Lang = layout.direction === 'rtl' ? 'he' : 'en';
  const rules = makeRules(makeRng(`stress#${seed}:rules`), cols, layout, exampleRows, outLang, features);
  const { filterCol, filterCut, ...plain } = rules;
  const reference: Rules = plain;
  const nextN = Math.max(2, Math.round(size.rows * (0.5 + makeRng(`stress#${seed}:n`)() * 0.7)));
  const nextRng = makeRng(`stress#${seed}:next`);
  // Next month's IDs go on from where the example's ended (an order number never starts over).
  const nextRows = genRows(nextRng, cols, nextN, 'next', layout, { next: new Map(exampleState.next), pools: new Map() });
  makeFair(nextRows, exampleRows, cols, filterCol, filterCut, nextRng);
  cleanUnshownMess(nextRows, exampleRows, cols);
  keepShownIdLengths(nextRows, exampleRows, cols, nextRng);
  keepShownMapKeys(nextRows, exampleRows, cols, reference, nextRng);
  keepEmptyColumnsEmpty(nextRows, exampleRows, cols);
  for (let k = nextRows.length - 1; k >= 0; k--) if (isBlankRow(nextRows[k]!)) nextRows.splice(k, 1);

  const headers = cols.map((c) => c.header);
  // Windows-1255 holds Hebrew, not emoji or Arabic: a file that cannot be written in it is written in UTF-8 (as a real export would be).
  const strings = [...allStrings(exampleRows, headers, layout), ...allStrings(nextRows, headers, layout)];
  const encodable = strings.every(encodableIn1255);
  if (layout.encoding === 'windows1255' && !encodable) layout.encoding = 'utf8bom';
  if (reference.output.file?.encoding === 'windows1255' && !(encodable && reference.output.titleRows.every((t) => !('text' in t) || encodableIn1255(t.text)))) {
    reference.output.file = { ...reference.output.file, encoding: 'utf8bom' };
  }

  const problems = ruleProblems(reference);
  if (problems.length > 0) throw new GenError(`reference rules are invalid: ${problems.slice(0, 3).join(' | ')}`, reference);

  const withTotals = (rows: GenCell[][]): GenCell[][] => (layout.totalsRow ? [...rows, totalsRowOf(cols, rows, layout.totalsLabel)] : rows);
  const input = await writeInput(layout, headers, withTotals(exampleRows), 'input');
  const nextInput = await writeInput(layout, headers, withTotals(nextRows), 'next.input');

  const convert = async (file: FileArtifact): Promise<Extract<ConvertResult, { ok: true }>> => {
    let res: ConvertResult;
    try {
      res = await convertFile(reference, file.bytes, file.name);
    } catch (e) {
      throw new GenError(`reference convertFile threw on ${file.name}: ${(e as Error).message}`, reference, [input, nextInput]);
    }
    if (!res.ok) throw new GenError(`reference convertFile failed on ${file.name}: ${JSON.stringify(res.error)}`, reference, [input, nextInput]);
    return res;
  };
  let refExample = await convert(input);
  const unshown = unshownParts(reference, refExample);
  if (unshown.length > 0) {
    if (unshown.includes('sort')) reference.transform.sort = [];
    if (unshown.includes('filter')) delete reference.input.rowFilters;
    if (unshown.includes('dedupe')) delete reference.transform.dedupe;
    for (const f of [...features]) if (unshown.some((u) => f.startsWith(`row:${u}`))) features.delete(f);
    features.add(`unshown:${unshown.join('+')}`);
    refExample = await convert(input);
  }
  const refNext = await convert(nextInput);
  const ext = reference.output.file?.type ?? 'xlsx';
  return {
    seed,
    profile,
    lang,
    features: [...features].sort(),
    cols,
    layout,
    rules: reference,
    exampleRows,
    nextRows,
    input,
    output: { name: `output.${ext}`, bytes: refExample.bytes },
    nextInput,
    nextOutput: { name: `next.output.${ext}`, bytes: refNext.bytes },
    refExample,
    refNext,
    genMs: Date.now() - t0,
  };
}
