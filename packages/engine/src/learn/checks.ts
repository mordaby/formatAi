// AI code checks (docs/proposals/ai-code-checks.md, owner decision 2026-10-05; SPEC 21 v14): the AI step (prompt learn-v9) may ask code a
// few closed, typed questions about the WHOLE example before it answers - `test`, `ranges`, `dependsOn`, `values`, `rows` (`@formatai/shared`
// `checks.ts`). This module answers them, on EVERY aligned row of the example, in the browser's worker (and in the eval harness, which runs
// the same `learnFromExamples`). Pure and deterministic (the masker is keyed; the clock only decides whether a check ran out of time).
//
// Nothing new is computed here: every check is a thin wrapper over engine code that exists.
//   - The formulas (`rule`, `let`, `where`) are read by the formula parser, their constants unmasked with the session masker (they are written
//     in the payload's masked vocabulary, `unmaskRules`), and RUN by the engine itself: one small rules file per check - the example's columns
//     as input columns, the helpers and the rule as computed columns - on a table of the example's aligned rows (`runRules`). So a check reads
//     a value exactly as the rules will (types, dates, numbers written as text), and any operation the language has works in it.
//   - `test` compares the rule's cell with the example's exactly like the full verification does (`cellMatchesExample`: formats, dates, numbers).
//   - Every value that leaves is masked like the samples, with the same masker and key (`maskCell` by the column's class, `classify.ts`:
//     numbers, dates and "no value" placeholders stay real, except an identifier stored as a number - amendment 2026-10-06),
//     and every row is a sample-shaped row of the example (`counterexampleSample`: `{ in, out }`, a whole family when rows expand), cut to the
//     payload's cell length. A value computed from an identifier column is masked like one; with masking on, `values` gives no min / max of
//     an identifier column and `ranges` refuses to sort by one (its from / to would be real IDs).
//   - Rows count toward the learn's row limit (`limits.learn.loop.maxRowsTotal`) with the samples, the dropped rows and the loop's rows: a row
//     already sent is shown again without counting; past the limit an answer gives counts only and says how many rows it withheld.
//
// Columns are named the way the prompt says: an input column is `in<i>` (its position), an output column is its header (in `column`, `by`,
// `on`) or `out<i>` inside a formula - the example's own value -, a helper is its `let` id, and in completion mode the ids of the user's
// rules (`complete.fixed`) work too: its input columns and its computed columns (the total `value2` a class is cut by). A field also takes an
// input column's header when no id or output header has that name.
//
// Errors are answers: a formula that does not parse, an unknown column, a type that does not fit, a `by` with no numbers or dates, a check
// that ran out of time - each is `{ error }` with a short message, never a throw.
import {
  checkRules,
  limits,
  type Check,
  type CheckAnswer,
  type CheckLet,
  type ColumnClass,
  type ColumnType,
  type Computed,
  type DependsOnAnswer,
  type Expr,
  type InputColumn,
  type LearnResult,
  type PayloadCell,
  type ProfileType,
  type RangesAnswer,
  type RangesRun,
  type RowsAnswer,
  type Rules,
  type Sample,
  type TestAnswer,
  type ValuesAnswer,
} from '@formatai/shared';
import { inferComputedTypes, typeCheck } from '../check/typeCheck';
import { parseFormula } from '../formula/parseFormula';
import { runRules } from '../pipeline/runRules';
import { mapHeaders } from '../pipeline/v1/normalize';
import type { InputTable, OutCell, RawCell } from '../types';
import type { PairAnalysis } from './analyze';
import { isoOfSerial } from './analyze/cells';
import { unmaskRules, type Masker } from './mask';
import { inputClass, outputClass } from './classify';
import { counterexampleSample } from './payload';
import { cellMatchesExample, exampleCellAt } from './verify';

const caps = limits.learn.checks;

export interface CheckContext {
  analysis: PairAnalysis;
  /** The session masker (masking on): what leaves is masked with it, and the formulas' constants are unmasked with it. */
  masker?: Masker | undefined;
  /** Completion mode: the user's rules (real values) - their input and computed column ids may be named by a check. */
  fixedRules?: LearnResult | Rules | undefined;
  /** Input rows (indices into `analysis.input.rows`) already sent in this learn: the payload's samples and dropped rows, earlier checks' rows. */
  sent: ReadonlySet<number>;
  /** How many rows not sent yet the answers may still show (the learn's row limit minus every row sent). */
  rowBudget: number;
  /** The clock of the time budget, in ms (default `Date.now`): a test passes its own. */
  now?: () => number;
  /** Default `limits.learn.checks.timeBudgetMs`. */
  timeBudgetMs?: number;
}

export interface AnsweredChecks {
  /** One answer per check, in order. */
  answers: CheckAnswer[];
  /** The input rows the answers show that were not sent before, in the order shown: they count toward the learn's row limit. */
  rowsShown: number[];
}

/** What a learn's checks came to (`LearnFromExamplesResult.checks`, the eval report). Present only when the AI step asked any. */
export interface CheckSummary {
  /** Rounds of checks answered (steps made). */
  rounds: number;
  /** Checks answered over every round (the ones the API dropped not included). */
  asked: number;
  /** Rows of the example the answers showed, not counting rows the payload had already sent. */
  rowsShown: number;
  /** Checks the API dropped (past the cap, or not one of the checks). */
  dropped: number;
  /** Answers that were errors (a formula that did not parse, an unknown column, the time budget ...). */
  errors: number;
}

// ---------- Errors ----------

class CheckFailure extends Error {}

function fail(message: string): never {
  throw new CheckFailure(message);
}

// ---------- The example as a table of aligned rows ----------

/** Where a name points: an input column (by position), an output column (by position), or a computed column (a `let` or the user's). */
type Ref = { kind: 'in'; pos: number; id: string } | { kind: 'out'; pos: number; id: string } | { kind: 'computed'; id: string };

interface Example {
  /** The aligned rows in file order (input row, then output row): `k` indexes `analysis.alignment.rows`. */
  rows: { k: number; inRow: number; outRow: number }[];
  table: InputTable;
  /** Input columns of every check's rules: each input position under its id (the user's when they name it, else `__in<i>`). */
  inputColumns: InputColumn[];
  /** The id each input position goes by in a check's rules. */
  inputIds: string[];
  /** The user's ids (completion mode): input columns by position, and their computed columns. */
  fixedInput: Map<string, number>;
  fixedComputed: Computed[];
  fixedFunctions: NonNullable<LearnResult['transform']['functions']>;
  fixedTables: NonNullable<LearnResult['transform']['tables']>;
}

const IN_ID = (i: number): string => `__in${i}`;
const OUT_ID = (c: number): string => `__out${c}`;
const RULE_ID = '__rule';
const WHERE_ID = '__where';

/** A profile type as a rules column type (`empty` reads as text). */
function columnTypeOf(t: ProfileType | undefined): ColumnType {
  return t === undefined || t === 'empty' ? 'text' : t;
}

/** A profile's date reading: the token format of text dates, when it is one (real dates need none). */
function inputFormatsOf(p: { type: ProfileType; dateFormat?: string } | undefined): string[] | undefined {
  return p?.type === 'date' && p.dateFormat !== undefined && p.dateFormat !== 'excel' ? [p.dateFormat] : undefined;
}

function buildExample(analysis: PairAnalysis, fixedRules: LearnResult | Rules | undefined): Example {
  const rows = analysis.alignment.rows
    .map((r, k) => ({ k, inRow: r.in, outRow: r.out }))
    .sort((a, b) => a.inRow - b.inRow || a.outRow - b.outRow);
  const inCount = analysis.input.columnCount;
  const outCount = analysis.output.columnCount;
  const date1904 = analysis.input.date1904;

  // The user's input columns (completion mode), found in the example the way the engine finds them (header, alias, normalized).
  const fixedInput = new Map<string, number>();
  const declared: (InputColumn | null)[] = new Array<InputColumn | null>(inCount).fill(null);
  if (fixedRules) {
    const mapping = mapHeaders(fixedRules.input.columns, analysis.input.headers);
    fixedRules.input.columns.forEach((col, ci) => {
      const pos = mapping.src[ci] ?? -1;
      if (pos < 0 || declared[pos] !== null) return;
      const { aliases: _aliases, required: _required, ...rest } = col;
      declared[pos] = { ...rest, header: `#in${pos}` };
      fixedInput.set(col.id, pos);
    });
  }
  const inputColumns: InputColumn[] = [];
  const inputIds: string[] = [];
  for (let i = 0; i < inCount; i++) {
    const p = analysis.input.profile[i];
    const formats = inputFormatsOf(p);
    const col = declared[i] ?? { id: IN_ID(i), header: `#in${i}`, type: columnTypeOf(p?.type), ...(formats ? { inputFormats: formats } : {}) };
    inputColumns.push(col);
    inputIds.push(col.id);
  }

  // One table row per aligned row: its input cells, then the example's output cells (read as the 1900 date system, like the payload's).
  const shift = (cell: RawCell | null | undefined): RawCell | null =>
    !cell ? null : date1904 && cell.isDate === true && typeof cell.v === 'number' ? { ...cell, v: cell.v - 1462 } : cell;
  const tableRows = rows.map(({ inRow, outRow }) => {
    const input = analysis.input.rows[inRow] ?? [];
    const sheetRow = analysis.output.dataRows[outRow];
    const output = (sheetRow !== undefined ? analysis.output.sheet.rows[sheetRow] : undefined) ?? [];
    const cells: (RawCell | null)[] = [];
    for (let i = 0; i < inCount; i++) cells.push(input[i] ?? null);
    for (let c = 0; c < outCount; c++) cells.push(shift(output[c]));
    return cells;
  });
  const headers = [...Array.from({ length: inCount }, (_, i) => `#in${i}`), ...Array.from({ length: outCount }, (_, c) => `#out${c}`)];
  const table: InputTable = {
    sheetName: analysis.input.sheetName,
    direction: analysis.input.direction,
    headers,
    rows: tableRows,
    rowNumbers: rows.map((_, j) => j + 1),
    ...(date1904 ? { date1904: true } : {}),
  };
  return {
    rows,
    table,
    inputColumns,
    inputIds,
    fixedInput,
    fixedComputed: fixedRules ? fixedRules.transform.computed : [],
    fixedFunctions: fixedRules?.transform.functions ?? [],
    fixedTables: fixedRules?.transform.tables ?? [],
  };
}

// ---------- Names ----------

interface Names {
  ex: Example;
  analysis: PairAnalysis;
  /** The check's own helpers, in order. */
  lets: ReadonlySet<string>;
  fixedComputedIds: ReadonlySet<string>;
}

/** A name inside a formula: a `let` id, the user's ids (completion), `in<i>`, `out<i>`. Null when it names nothing. */
function resolveName(name: string, n: Names): Ref | null {
  if (name.startsWith('__')) return null;
  if (n.lets.has(name) || n.fixedComputedIds.has(name)) return { kind: 'computed', id: name };
  const fixedPos = n.ex.fixedInput.get(name);
  if (fixedPos !== undefined) return { kind: 'in', pos: fixedPos, id: name };
  const m = /^(in|out)(\d{1,3})$/.exec(name);
  if (m) {
    const pos = Number(m[2]);
    if (m[1] === 'in' && pos < n.analysis.input.columnCount) return { kind: 'in', pos, id: n.ex.inputIds[pos]! };
    if (m[1] === 'out' && pos < n.analysis.output.columnCount) return { kind: 'out', pos, id: OUT_ID(pos) };
  }
  return null;
}

/** A column field of a check (`column`, `by`, `on`): a name as in a formula, else an output header, else an input header. */
function resolveField(field: string, value: string, n: Names): Ref {
  const named = resolveName(value, n);
  if (named) return named;
  const out = n.analysis.output.headers.indexOf(value);
  if (out >= 0 && value !== '') return { kind: 'out', pos: out, id: OUT_ID(out) };
  const inp = n.analysis.input.headers.indexOf(value);
  if (inp >= 0 && value !== '') return { kind: 'in', pos: inp, id: n.ex.inputIds[inp]! };
  return fail(`${field}: ${unknownColumn(value, n)}`);
}

function unknownColumn(name: string, n: Names): string {
  const inputs = n.analysis.input.columnCount;
  const outputs = n.analysis.output.columnCount;
  return `no column "${name}" (an input column is in0 to in${inputs - 1}; an output column is its header, or out0 to out${outputs - 1} in a formula${n.lets.size > 0 ? '; or a let id' : ''})`;
}

/** The column names an expression reads: `col` leaves, and a window's `by` and `order` columns. */
function namesOf(expr: unknown, out: Set<string> = new Set()): Set<string> {
  if (Array.isArray(expr)) {
    for (const e of expr) namesOf(e, out);
    return out;
  }
  if (typeof expr !== 'object' || expr === null) return out;
  const node = expr as Record<string, unknown>;
  if (typeof node.col === 'string') out.add(node.col);
  if (node.op === 'window') {
    if (Array.isArray(node.by)) for (const b of node.by) if (typeof b === 'string') out.add(b);
    if (Array.isArray(node.order)) for (const o of node.order) if (o && typeof (o as { column?: unknown }).column === 'string') out.add((o as { column: string }).column);
  }
  for (const [k, v] of Object.entries(node)) if (k !== 'col' && typeof v === 'object' && v !== null) namesOf(v, out);
  return out;
}

/** The expression with every name replaced by the id it goes by in the check's rules (`rename` gives it). */
function renameIn<T>(expr: T, rename: (name: string) => string): T {
  if (Array.isArray(expr)) return expr.map((e) => renameIn(e, rename)) as T;
  if (typeof expr !== 'object' || expr === null) return expr;
  const node = expr as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === 'col' && typeof v === 'string') out[k] = rename(v);
    else if (node.op === 'window' && k === 'by' && Array.isArray(v)) out[k] = v.map((b) => (typeof b === 'string' ? rename(b) : b));
    else if (node.op === 'window' && k === 'order' && Array.isArray(v)) {
      out[k] = v.map((o) => (o && typeof (o as { column?: unknown }).column === 'string' ? { ...(o as object), column: rename((o as { column: string }).column) } : o));
    } else out[k] = renameIn(v, rename);
  }
  return out as T;
}

// ---------- A check's rules: its formulas, run once on every row ----------

interface Formula {
  /** What the error messages call it: `rule`, `where`, `let total`. */
  label: string;
  id: string;
  expr: Expr;
}

interface Run {
  /** Per check-table row, the cells of each column asked for (by id). */
  cell(id: string, j: number): OutCell | undefined;
}

/** Reads a formula of a check: parsed, its constants unmasked (written in the payload's vocabulary), its names checked. */
function readFormula(label: string, text: string, n: Names, masker: Masker | undefined): Expr {
  const parsed = parseFormula(text, { promptOpsOnly: true, allowWindows: true });
  if (!parsed.ok) return fail(`${label}: ${parsed.error.message} (at ${parsed.error.offset})`);
  for (const name of namesOf(parsed.expr)) if (!resolveName(name, n)) fail(`${label}: ${unknownColumn(name, n)}`);
  return masker ? unmaskRules(parsed.expr, masker) : parsed.expr;
}

/**
 * Builds the check's rules - the example's columns, the user's computed columns the check needs (completion mode), its helpers and its
 * formulas, and one output column per value asked for - checks them like any rules (references, types) and runs them on every row.
 */
function runCheck(ex: Example, n: Names, analysis: PairAnalysis, formulas: readonly Formula[], wanted: readonly string[], formats: ReadonlyMap<string, string>): Run {
  const rename = (name: string): string => resolveName(name, n)?.id ?? name;
  const own: Computed[] = formulas.map((f) => ({ id: f.id, type: 'text', expr: renameIn(f.expr, rename) }));

  // The user's computed columns this check reads, directly or through one another, in their own order (completion mode).
  const needed = new Set<string>([...wanted, ...own.flatMap((c) => [...namesOf(c.expr)])]);
  const byId = new Map(ex.fixedComputed.map((c) => [c.id, c] as const));
  for (let grew = true; grew; ) {
    grew = false;
    for (const id of [...needed]) {
      const c = byId.get(id);
      if (!c) continue;
      for (const m of namesOf(c.expr)) {
        if (!needed.has(m)) {
          needed.add(m);
          grew = true;
        }
      }
    }
  }
  const fixed = ex.fixedComputed.filter((c) => needed.has(c.id));

  // The example's output columns a formula or a field reads, as input columns of the check's own table.
  const outs = [...needed].flatMap((id) => {
    const m = /^__out(\d+)$/.exec(id);
    return m ? [Number(m[1])] : [];
  });
  const outColumns: InputColumn[] = [...new Set(outs)].sort((a, b) => a - b).map((c) => {
    const p = analysis.output.profile[c];
    const formats = inputFormatsOf(p);
    return { id: OUT_ID(c), header: `#out${c}`, type: columnTypeOf(p?.type), ...(formats ? { inputFormats: formats } : {}) };
  });

  const draft = (computed: Computed[]): LearnResult => ({
    schemaVersion: 1,
    input: { sheet: { pick: 'first' }, headerRow: 'auto', columns: [...ex.inputColumns, ...outColumns] },
    transform: {
      ...(ex.fixedFunctions.length > 0 ? { functions: ex.fixedFunctions } : {}),
      ...(ex.fixedTables.length > 0 ? { tables: ex.fixedTables } : {}),
      computed,
      valueMaps: [],
      sort: [],
    },
    output: {
      sheetName: 'checks',
      direction: 'ltr',
      language: analysis.layout.language,
      titleRows: [],
      columns: wanted.map((id, j) => ({ header: `c${j}`, from: id, ...(formats.has(id) ? { format: formats.get(id)! } : {}) })),
    },
    validations: [],
    unsupported: [],
    assumptions: [],
  });

  // Nobody declared a type for the check's own formulas: each is declared as what it gives, so only a real mismatch inside one is an error.
  const inferred = inferComputedTypes(draft([...fixed, ...own]));
  const typed = own.map((c, i) => ({ ...c, type: (inferred[fixed.length + i] ?? 'text') as ColumnType }));
  const rules = draft([...fixed, ...typed]);

  const labelOf = (path: string): string => {
    const m = /^transform\.computed\[(\d+)\]/.exec(path);
    if (!m) return 'the check';
    const i = Number(m[1]);
    return i < fixed.length ? `the column "${fixed[i]!.id}" of complete.fixed` : (formulas[i - fixed.length]?.label ?? 'the check');
  };
  const referenceProblem = checkRules(rules)[0];
  if (referenceProblem) fail(`${labelOf(referenceProblem.path)}: ${referenceProblem.message}`);
  const typeProblem = typeCheck(rules)[0];
  if (typeProblem) fail(`${labelOf(typeProblem.path)}: ${typeProblem.message}`);
  const where = typed.find((c) => c.id === WHERE_ID);
  if (where && where.type !== 'boolean') fail(`where: must be a condition (true or false), not ${where.type}`);

  const result = runRules(rules, ex.table, {});
  if (!result.ok) fail(`the check could not run (${result.error.code})`);
  const byRow = new Map<number, OutCell[]>();
  for (const row of result.sheet.rows) if (row.kind === 'data' && row.sourceRow !== undefined) byRow.set(row.sourceRow, row.cells);
  const colOf = new Map(wanted.map((id, j) => [id, j] as const));
  return { cell: (id, j) => byRow.get(j + 1)?.[colOf.get(id) ?? -1] };
}

// ---------- Values ----------

/** A rules cell as a payload value: a real date as ISO text, like the samples. */
function outValue(cell: OutCell | undefined): PayloadCell {
  if (cell === undefined || cell.v === undefined) return null;
  if (cell.isDate === true && typeof cell.v === 'number') return isoOfSerial(cell.v);
  return cell.v;
}

/** A cell of the example as a payload value (numbers as numbers, real dates as ISO text). */
function rawValue(cell: RawCell | null | undefined, date1904: boolean): PayloadCell {
  if (!cell || cell.v === null) return null;
  if (typeof cell.v === 'number' && cell.isDate) return isoOfSerial(Math.trunc(cell.v) + (date1904 ? 1462 : 0));
  return cell.v;
}

/** How a value of `by` sorts: a number, a date (ISO text), or nothing that sorts. */
function orderOf(cell: OutCell | undefined): { kind: 'number'; v: number } | { kind: 'date'; v: string } | { kind: 'none' } {
  if (cell === undefined || cell.v === null || cell.v === undefined || cell.v === '') return { kind: 'none' };
  if (cell.isDate === true && typeof cell.v === 'number') return { kind: 'date', v: isoOfSerial(cell.v) };
  if (typeof cell.v === 'number' && Number.isFinite(cell.v)) return { kind: 'number', v: cell.v };
  return { kind: 'none' };
}

const isEmpty = (v: PayloadCell): boolean => v === null || v === '';
/** Values compared as the example shows them: "" and an empty cell are one value. */
const keyOf = (v: PayloadCell): string => (isEmpty(v) ? 'null' : JSON.stringify(v));

// ---------- Answering ----------

interface Answering {
  ctx: CheckContext;
  ex: Example;
  /** Rows sent so far, this round's included. */
  sent: Set<number>;
  rowsShown: number[];
  left: number;
  started: number;
}

/**
 * One row of the example for an answer, masked like a sample: shown when it was sent before, or while the row budget lasts (it is counted
 * then); null when the budget is used up (the answer says it withheld it).
 */
function takeRow(a: Answering, inRow: number): Sample | null {
  if (!a.sent.has(inRow)) {
    if (a.left <= 0) return null;
    a.left--;
    a.sent.add(inRow);
    a.rowsShown.push(inRow);
  }
  return counterexampleSample(a.ctx.analysis, inRow, a.ctx.masker);
}

/** A value as the AI step may see it: masked like the samples' cells of its kind, cut to the payload's cell length. */
function sendable(v: PayloadCell, type: ColumnClass, masker: Masker | undefined): PayloadCell {
  const masked = masker ? masker.maskCell(v, type) : v;
  const max = limits.payload.maxCellChars;
  return typeof masked === 'string' && masked.length > max ? masked.slice(0, max) : masked;
}

function checkTime(a: Answering): void {
  const budget = a.ctx.timeBudgetMs ?? caps.timeBudgetMs;
  if ((a.ctx.now ?? Date.now)() - a.started > budget) {
    fail(`the check ran out of time (${budget / 1000} s): ask something simpler, or fewer rows with where`);
  }
}

/** Reads the check's helpers and formulas, resolves its fields, runs it: what every check does before it counts anything. */
/** One more formula a check runs besides its helpers and `where`: the `test` rule. */
interface ExtraFormula {
  label: string;
  id: string;
  text: string;
}

/** What a check has once it ran: its run, its fields' columns, the rows `where` keeps, and the type each column's values are masked as. */
interface Prepared {
  run: Run;
  refs: Ref[];
  rows: number[];
  maskType: (ref: Ref) => ColumnClass;
}

/**
 * Amendment 2026-10-06 (identifiers stored as numbers are masked): the class a column's values are masked by in an answer - the payload's
 * (`classify.ts`) for the example's own columns; for a computed column (a `let`, the `test` rule, the user's), `identifier` when it reads an
 * identifier column, directly or through another computed column, else `text` as before. DECISION: anything computed from an identifier is
 * masked like one (a copy, `in0 + 0`, is that ID; a count such as its length is masked too and reads wrong - safe, never a real ID).
 */
function maskTypeOf(ref: Ref, n: Names, exprs: ReadonlyMap<string, Expr>, seen: Set<string> = new Set()): ColumnClass {
  if (ref.kind === 'in') return inputClass(n.analysis, ref.pos);
  if (ref.kind === 'out') return outputClass(n.analysis, ref.pos);
  if (seen.has(ref.id)) return 'text';
  seen.add(ref.id);
  const expr = exprs.get(ref.id);
  if (expr === undefined) return 'text';
  for (const name of namesOf(expr)) {
    const read = resolveName(name, n);
    if (read && maskTypeOf(read, n, exprs, seen) === 'identifier') return 'identifier';
  }
  return 'text';
}

function prepare(a: Answering, check: Check, fields: { name: string; value: string }[], extra: readonly ExtraFormula[]): Prepared {
  const { analysis, masker } = a.ctx;
  const lets: CheckLet[] = check.let ?? [];
  if (lets.length > caps.maxLets) fail(`let: at most ${caps.maxLets} helper columns`);
  const fixedComputedIds = new Set(a.ex.fixedComputed.map((c) => c.id));
  const seen = new Set<string>();
  const formulas: Formula[] = [];
  for (const l of lets) {
    if (/^(in|out)\d+$/.test(l.id) || l.id.startsWith('__')) fail(`let ${l.id}: the id is a column name already; choose another`);
    if (seen.has(l.id) || fixedComputedIds.has(l.id) || a.ex.fixedInput.has(l.id)) fail(`let ${l.id}: the id is used already; choose another`);
    // A helper reads the example's columns and the helpers before it.
    formulas.push({ label: `let ${l.id}`, id: l.id, expr: readFormula(`let ${l.id}`, l.expr, { ex: a.ex, analysis, lets: seen, fixedComputedIds }, masker) });
    seen.add(l.id);
  }
  const names: Names = { ex: a.ex, analysis, lets: seen, fixedComputedIds };
  const where = 'where' in check && check.where !== undefined ? readFormula('where', check.where, names, masker) : null;
  const own: Formula[] = extra.map((f) => ({ label: f.label, id: f.id, expr: readFormula(f.label, f.text, names, masker) }));
  if (where) formulas.push({ label: 'where', id: WHERE_ID, expr: where });
  formulas.push(...own);

  const refs = fields.map((f) => resolveField(f.name, f.value, names));
  const wanted = [...new Set([...refs.map((r) => r.id), ...(where ? [WHERE_ID] : []), ...own.map((f) => f.id)])];
  // `test`: the rule's cells take the example column's format, so they are compared exactly like the full verification compares.
  const formats = new Map<string, string>();
  if (check.check === 'test') {
    const out = refs[0];
    const format = out?.kind === 'out' ? analysis.output.profile[out.pos]?.format : undefined;
    if (format !== undefined) formats.set(RULE_ID, format);
  }
  const run = runCheck(a.ex, names, analysis, formulas, wanted, formats);
  checkTime(a);
  const rows: number[] = [];
  a.ex.rows.forEach((_, j) => {
    if (!where || run.cell(WHERE_ID, j)?.v === true) rows.push(j);
  });
  // Every computed column the check may show, by id, with its names as written: the user's columns, the helpers, the rule.
  const exprs = new Map<string, Expr>([...a.ex.fixedComputed.map((c) => [c.id, c.expr] as const), ...formulas.map((f) => [f.id, f.expr] as const)]);
  const types = new Map<string, ColumnClass>();
  const maskType = (ref: Ref): ColumnClass => {
    const key = `${ref.kind}:${ref.id}`;
    let type = types.get(key);
    if (type === undefined) types.set(key, (type = maskTypeOf(ref, names, exprs)));
    return type;
  };
  return { run, refs, rows, maskType };
}

/** The value of a column at a check-table row, as the samples show it (raw for the example's own columns), and the type it is masked by. */
function displayOf(a: Answering, p: Prepared, ref: Ref, j: number): { v: PayloadCell; type: ColumnClass } {
  const { analysis } = a.ctx;
  const row = a.ex.rows[j]!;
  const type = p.maskType(ref);
  if (ref.kind === 'in') return { v: rawValue(analysis.input.rows[row.inRow]?.[ref.pos], analysis.input.date1904), type };
  if (ref.kind === 'out') return { v: exampleCellAt(analysis, row.k, ref.pos).v, type };
  return { v: outValue(p.run.cell(ref.id, j)), type };
}

/** With masking on, an identifier column (`classify.ts`): its values never leave real - no min / max, no sorting by it. */
function maskedId(a: Answering, p: Prepared, ref: Ref): boolean {
  return a.ctx.masker !== undefined && p.maskType(ref) === 'identifier';
}

function answerTest(a: Answering, check: Extract<Check, { check: 'test' }>): TestAnswer {
  const { analysis, masker } = a.ctx;
  const p = prepare(a, check, [{ name: 'column', value: check.column }], [{ label: 'rule', id: RULE_ID, text: check.rule }]);
  const { run, refs, rows } = p;
  const out = refs[0]!;
  if (out.kind !== 'out') fail(`column: "${check.column}" is not an output column (an output header, or out0 to out${analysis.output.columnCount - 1})`);
  // `expected` is masked like the column's cells; `got` too, or like an ID when the rule reads one (a wrong rule may give an ID elsewhere).
  const type = p.maskType(out);
  const gotType = p.maskType({ kind: 'computed', id: RULE_ID }) === 'identifier' ? 'identifier' : type;
  const failingRows: number[] = [];
  let matched = 0;
  for (const j of rows) {
    if (cellMatchesExample(analysis, a.ex.rows[j]!.k, out.pos, run.cell(RULE_ID, j))) matched++;
    else failingRows.push(j);
  }
  checkTime(a);
  const failing: TestAnswer['failing'] = [];
  const shown = new Set<number>();
  let withheld = 0;
  for (const j of failingRows) {
    if (failing.length + withheld >= caps.maxFailingRows) break;
    const { k, inRow } = a.ex.rows[j]!;
    if (shown.has(inRow)) continue;
    shown.add(inRow);
    const row = takeRow(a, inRow);
    if (!row) {
      withheld++;
      continue;
    }
    failing.push({ row, expected: sendable(exampleCellAt(analysis, k, out.pos).v, type, masker), got: sendable(outValue(run.cell(RULE_ID, j)), gotType, masker) });
  }
  return { rows: rows.length, matched, failing, ...(withheld > 0 ? { withheld } : {}) };
}

function answerRanges(a: Answering, check: Extract<Check, { check: 'ranges' }>): RangesAnswer {
  const { masker } = a.ctx;
  const p = prepare(a, check, [{ name: 'column', value: check.column }, { name: 'by', value: check.by }], []);
  const { run, refs, rows } = p;
  const [col, by] = refs as [Ref, Ref];
  // DECISION (amendment 2026-10-06): a run's from / to are values of `by` - real IDs if it is one; refused rather than masked (a masked
  // from / to would not sort like the IDs, and an order of ID numbers is no rule anyway).
  if (maskedId(a, p, by)) fail('by: sorting by an identifier column is not supported');
  const points: { x: number | string; key: string; v: PayloadCell; type: ColumnClass }[] = [];
  let noValue = 0;
  let numbers = 0;
  let dates = 0;
  for (const j of rows) {
    const x = orderOf(run.cell(by.id, j));
    if (x.kind === 'none') {
      noValue++;
      continue;
    }
    if (x.kind === 'number') numbers++;
    else dates++;
    const shown = displayOf(a, p, col, j);
    points.push({ x: x.v, key: keyOf(shown.v), v: shown.v, type: shown.type });
  }
  if (numbers === 0 && dates === 0 && rows.length > 0) fail(`by: "${check.by}" holds no numbers or dates on these rows`);
  if (numbers > 0 && dates > 0) fail(`by: "${check.by}" holds both numbers and dates`);
  // Sorted by `by` (ties keep the file order); rows with the same `by` are one point of the line.
  points.sort((p, q) => (p.x < q.x ? -1 : p.x > q.x ? 1 : 0));
  /** A run of the line: its first and last `by`, its value (`key` null: one `by` value with two values), its rows. */
  interface Span {
    from: number | string;
    to: number | string;
    key: string | null;
    v: PayloadCell;
    type: ColumnClass;
    rows: number;
  }
  const runs: Span[] = [];
  let mixed = 0;
  for (let i = 0; i < points.length; ) {
    let end = i;
    while (end < points.length && points[end]!.x === points[i]!.x) end++;
    const group = points.slice(i, end);
    const keys = new Set(group.map((p) => p.key));
    const key = keys.size === 1 ? group[0]!.key : null;
    if (key === null) mixed++;
    const last = runs[runs.length - 1];
    if (last && key !== null && last.key === key) {
      last.to = group[0]!.x;
      last.rows += group.length;
    } else {
      runs.push({ from: group[0]!.x, to: group[0]!.x, key, v: group[0]!.v, type: group[0]!.type, rows: group.length });
    }
    i = end;
  }
  checkTime(a);
  if (mixed > 0 || runs.length > caps.maxRuns) return { rows: rows.length, noValue, clean: false, runCount: runs.length, mixed };
  const listed: RangesRun[] = runs.map((r) => ({ from: r.from, to: r.to, value: sendable(r.v, r.type, masker), rows: r.rows }));
  return { rows: rows.length, noValue, clean: true, runs: listed };
}

function answerDependsOn(a: Answering, check: Extract<Check, { check: 'dependsOn' }>): DependsOnAnswer {
  const { masker } = a.ctx;
  if (check.on.length < 1 || check.on.length > caps.maxOn) fail(`on: 1 or ${caps.maxOn} columns`);
  const p = prepare(
    a,
    check,
    [{ name: 'column', value: check.column }, ...check.on.map((value, i) => ({ name: `on[${i}]`, value }))],
    [],
  );
  const { refs, rows } = p;
  const [col, ...on] = refs as [Ref, ...Ref[]];
  // key -> value -> { rows, the first row }, in the order first seen (file order).
  const groups = new Map<string, { key: { v: PayloadCell; type: ColumnClass }[]; values: Map<string, { v: PayloadCell; type: ColumnClass; rows: number; first: number }> }>();
  for (const j of rows) {
    const key = on.map((r) => displayOf(a, p, r, j));
    const k = key.map((d) => keyOf(d.v)).join('\u0000');
    const value = displayOf(a, p, col, j);
    let g = groups.get(k);
    if (!g) {
      g = { key, values: new Map() };
      groups.set(k, g);
    }
    const vk = keyOf(value.v);
    const seen = g.values.get(vk);
    if (seen) seen.rows++;
    else g.values.set(vk, { ...value, rows: 1, first: j });
  }
  checkTime(a);
  let rowsAgree = 0;
  let keysConflict = 0;
  for (const g of groups.values()) {
    if (g.values.size === 1) rowsAgree += [...g.values.values()][0]!.rows;
    else keysConflict++;
  }
  const conflicts: DependsOnAnswer['conflicts'] = [];
  let withheld = 0;
  for (const g of groups.values()) {
    if (conflicts.length >= caps.maxConflicts) break;
    if (g.values.size < 2) continue;
    // The two values the key gives most often (ties: the one seen first).
    const ordered = [...g.values.values()].sort((p, q) => q.rows - p.rows || p.first - q.first);
    const x = ordered[0]!;
    const y = ordered[1]!;
    const shown: Sample[] = [];
    for (const j of [x.first, y.first]) {
      const row = takeRow(a, a.ex.rows[j]!.inRow);
      if (row) shown.push(row);
      else withheld++;
    }
    conflicts.push({ key: g.key.map((d) => sendable(d.v, d.type, masker)), values: [sendable(x.v, x.type, masker), sendable(y.v, y.type, masker)], rows: shown });
  }
  return { rows: rows.length, keys: groups.size, rowsAgree, keysConflict, conflicts, ...(withheld > 0 ? { withheld } : {}) };
}

function answerValues(a: Answering, check: Extract<Check, { check: 'values' }>): ValuesAnswer {
  const { masker } = a.ctx;
  const p = prepare(a, check, [{ name: 'column', value: check.column }], []);
  const { run, refs, rows } = p;
  const col = refs[0]!;
  const counts = new Map<string, { v: PayloadCell; type: ColumnClass; rows: number; first: number }>();
  let empty = 0;
  const numbers: number[] = [];
  const dates: string[] = [];
  let other = false;
  for (const j of rows) {
    const shown = displayOf(a, p, col, j);
    if (isEmpty(shown.v)) {
      empty++;
      continue;
    }
    const k = keyOf(shown.v);
    const seen = counts.get(k);
    if (seen) seen.rows++;
    else counts.set(k, { ...shown, rows: 1, first: j });
    const x = orderOf(run.cell(col.id, j));
    if (x.kind === 'number') numbers.push(x.v);
    else if (x.kind === 'date') dates.push(x.v);
    else other = true;
  }
  checkTime(a);
  const top = [...counts.values()]
    .sort((p, q) => q.rows - p.rows || p.first - q.first)
    .slice(0, caps.maxValues)
    .map((c) => ({ value: sendable(c.v, c.type, masker), rows: c.rows }));
  const answer: ValuesAnswer = { rows: rows.length, distinct: counts.size, empty, top };
  // DECISION (amendment 2026-10-06): an identifier column's min / max are left out, not masked - a masked min is not the smallest fake,
  // and the smallest and largest ID are two real IDs (the payload's `stats.range` of such a column is left out the same way).
  if (maskedId(a, p, col)) return answer;
  if (!other && numbers.length > 0 && dates.length === 0) {
    answer.min = numbers.reduce((m, v) => (v < m ? v : m));
    answer.max = numbers.reduce((m, v) => (v > m ? v : m));
  } else if (!other && dates.length > 0 && numbers.length === 0) {
    answer.min = dates.reduce((m, v) => (v < m ? v : m));
    answer.max = dates.reduce((m, v) => (v > m ? v : m));
  }
  return answer;
}

function answerRows(a: Answering, check: Extract<Check, { check: 'rows' }>): RowsAnswer {
  if (!Number.isInteger(check.limit) || check.limit < 1 || check.limit > caps.maxRowsPerCheck) fail(`limit: 1 to ${caps.maxRowsPerCheck}`);
  const { rows } = prepare(a, check, [], []);
  const shownRows: Sample[] = [];
  const seen = new Set<number>();
  let withheld = 0;
  for (const j of rows) {
    if (shownRows.length + withheld >= check.limit) break;
    const { inRow } = a.ex.rows[j]!;
    if (seen.has(inRow)) continue;
    seen.add(inRow);
    const row = takeRow(a, inRow);
    if (row) shownRows.push(row);
    else withheld++;
  }
  return { matched: rows.length, rows: shownRows, ...(withheld > 0 ? { withheld } : {}) };
}

function answerOne(a: Answering, check: Check): CheckAnswer {
  switch (check.check) {
    case 'test':
      return answerTest(a, check);
    case 'ranges':
      return answerRanges(a, check);
    case 'dependsOn':
      return answerDependsOn(a, check);
    case 'values':
      return answerValues(a, check);
    case 'rows':
      return answerRows(a, check);
    default:
      return fail('not one of the checks (test, ranges, dependsOn, values, rows)');
  }
}

/**
 * Answers the checks of one round on every aligned row of the example (see the file header): one answer per check, in order - an error is
 * an answer too - and the rows the answers show that were not sent before. Each check has its own time budget.
 */
export function answerChecks(checks: readonly Check[], ctx: CheckContext): AnsweredChecks {
  const ex = buildExample(ctx.analysis, ctx.fixedRules);
  const a: Answering = { ctx, ex, sent: new Set(ctx.sent), rowsShown: [], left: Math.max(0, ctx.rowBudget), started: 0 };
  const answers = checks.map((check): CheckAnswer => {
    a.started = (ctx.now ?? Date.now)();
    // A failing check gives back the rows it took (none are shown).
    const before = { left: a.left, shown: a.rowsShown.length };
    try {
      return answerOne(a, check);
    } catch (err) {
      if (!(err instanceof CheckFailure)) throw err;
      for (const inRow of a.rowsShown.splice(before.shown)) a.sent.delete(inRow);
      a.left = before.left;
      return { error: err.message };
    }
  });
  return { answers, rowsShown: a.rowsShown };
}

/** The summary of a learn's rounds (`LearnFromExamplesResult.checks`). */
export function checkSummaryOf(rounds: readonly { checks: readonly Check[]; answers: readonly CheckAnswer[]; dropped?: readonly string[] }[], rowsShown: number): CheckSummary {
  return {
    rounds: rounds.length,
    asked: rounds.reduce((n, r) => n + r.checks.length, 0),
    rowsShown,
    dropped: rounds.reduce((n, r) => n + (r.dropped?.length ?? 0), 0),
    errors: rounds.reduce((n, r) => n + r.answers.filter((x) => 'error' in x).length, 0),
  };
}

/** An answer with its rows taken out (counts only, the rows said to be withheld): for a round too large to send whole. */
export function withoutRows(answer: CheckAnswer): CheckAnswer {
  if ('failing' in answer) {
    const { failing, withheld, ...rest } = answer;
    return failing.length === 0 ? answer : { ...rest, failing: [], withheld: (withheld ?? 0) + failing.length };
  }
  if ('conflicts' in answer) {
    const rows = answer.conflicts.reduce((n, c) => n + c.rows.length, 0);
    return rows === 0 ? answer : { ...answer, conflicts: answer.conflicts.map((c) => ({ ...c, rows: [] })), withheld: (answer.withheld ?? 0) + rows };
  }
  if ('matched' in answer && Array.isArray(answer.rows)) {
    const { rows, withheld, ...rest } = answer;
    return rows.length === 0 ? answer : { ...rest, rows: [], withheld: (withheld ?? 0) + rows.length };
  }
  return answer;
}
