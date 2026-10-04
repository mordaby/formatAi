// Code fills the data parameters of an AI answer from every row of the example (docs/proposals/learning-loop.md 7.1; owner decision
// 2026-10-04; SPEC 8.8, 8.14, 9.2). The AI step sees a few masked rows and writes the LOGIC: which columns, which conditions, which
// functions. What a few rows cannot show - fifty branch names, the exact cut-off, the third status of a list - is DATA, and code has
// every row of the example, with real values. So after an answer has passed the server's checks and before the full verification of
// each round, `learnFromExamples` runs `fillParams` on the unmasked answer, and the check on every row decides as before.
//
// Only these well-defined shapes, never "any constant":
//  1. lookup tables (`lookup(...)` against `transform.tables`) and value maps: every key -> value pair the example shows, the key read
//     from the input row (the rules' own key expression, run by the engine), the value from the aligned output row. A key whose rows
//     disagree is not filled. A lookup inside a condition is filled only from the rows where its branch is the one taken.
//  2. value lists in conditions (`oneOf`, an or-chain of `=` on one column, a single `=`): a value of that column is added when EVERY row
//     holding it is right with the condition true and some of them are wrong now.
//  3. cut-offs: a comparison of one numeric or date column with one constant. Its outcome on every gap between neighbouring values of the
//     column is known from two runs (the comparison forced true, then false), so the range where the most rows match is exact, not
//     sampled. The AI's value is kept when it is inside, else the roundest number inside; a range that is more than one value becomes a
//     visible check (`cutoffRange`, SPEC 8.8) the user approves.
//  4. band tables (ranges -> labels): every boundary is a comparison of that column with a constant, settled as in 3, one at a time.
//  5. the day/month order of text dates (`toDate` with a format, `inputFormats`): a value with a part above 12 proves it; when no value
//     does, the AI's choice is kept and reported as an ambiguity for the ambiguity question (`ambiguities`).
//  6. which duplicate is kept (`dedupe.keep`) and which values a filter drops (an `ne` / `notOneOf` list): changed when the other choice
//     makes fewer rows wrong.
//
// Privacy: this runs on the unmasked rules and the real example, in the browser (and the eval harness); nothing it fills is ever put in
// a request - a repair round sends the answer as the AI wrote it. The result records kinds and counts only, never a value.
//
// Pure and synchronous, like the rest of this package.
import Decimal from 'decimal.js';
import { limits, type ColumnType, type Expr, type ExprConstValue, type ExprNode, type FilterScalar, type LearnResult, type PayloadCell, type RowFilter, type RulesTable, type TableCellValue, type Validation } from '@formatai/shared';
import { deepEqual } from '../registry/deepEqual';
import { runRules } from '../pipeline/runRules';
import { exprChildren } from '../pipeline/v1/expr';
import { colNorm, mapHeaders, newIssue, normalizeCell, normalizeConst } from '../pipeline/v1/normalize';
import { DateVal, decText, normText, toText, type Val } from '../pipeline/v1/values';
import type { OutCell, OutRow } from '../types';
import { compileDateParser, serialToYmd, ymdToSerial } from '../values/dates';
import { isoOfSerial } from './analyze/cells';
import type { PairAnalysis } from './analyze';
import { wrongCount } from './loop';
import { alignedActualRows, cellMatchesExample, exampleCellAt, exampleTable, verifyAgainstExample } from './verify';

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

/** The kinds of data parameter code fills (the proposal's 7.1 list). */
export type FillKind = 'lookup' | 'valueMap' | 'valueList' | 'cutoff' | 'band' | 'dayMonthOrder' | 'dedupeKeep' | 'filterList';

export interface FillCount {
  kind: FillKind;
  /** lookup / valueMap: entries added; valueList / filterList: values added or taken out; cutoff / band: cut-offs moved or given a check;
   * dayMonthOrder: formats turned around; dedupeKeep: 1. */
  count: number;
}

/**
 * What the example could not settle and the user is asked (the ambiguity question, proposal 7.2). The day/month order of text dates:
 * every date text of `column` reads both ways (no part above 12), so the AI's `format` was kept; `other` is the same format with day and
 * month swapped. `swapDayMonth(rules, a)` applies the other reading.
 */
export interface DayMonthAmbiguity {
  kind: 'dayMonthOrder';
  /** The input column's header, as in the file. */
  column: string;
  /** The format the rules read it with ("DD/MM/YYYY") and the other order ("MM/DD/YYYY"). */
  format: string;
  other: string;
}
export type Ambiguity = DayMonthAmbiguity;

/** What code filled in an answer: kinds and counts only, no value (the learn result's `filled`, the eval report's "filled by code"). */
export interface FillSummary {
  /** One entry per kind that filled something, in the order of `FillKind`. */
  filled: FillCount[];
  /** Cut-off checks added (`cutoffRange` validations, SPEC 8.8). */
  checks: number;
}

export interface FillResult extends FillSummary {
  /** The answer with its data parameters filled (the answer itself when nothing was, or when filling made it worse). */
  rules: LearnResult;
  ambiguities: Ambiguity[];
}

export interface FillOptions {
  /** Completion mode: the user's rules. A part of the answer equal to one of theirs is theirs, and code never changes it. */
  fixed?: LearnResult;
}

const KIND_ORDER: readonly FillKind[] = ['lookup', 'valueMap', 'valueList', 'cutoff', 'band', 'dayMonthOrder', 'dedupeKeep', 'filterList'];

// ---------------------------------------------------------------------------
// Running the rules on the example, row by row
// ---------------------------------------------------------------------------

/** A value read from the rules' own evaluation of an expression on each row: a hidden computed column right after `after`. */
interface Probe {
  /** The computed column it runs after (it may read every column before it); null: before every computed column. */
  after: string | null;
  expr: Expr;
  type: ColumnType;
}

interface Run {
  /** Per aligned row of the example, the row the rules made for it (null: none). */
  rows: (OutRow | null)[];
  /** Per probe, its output position in `rows[k].cells`. */
  at: number[];
}

const PROBE = '__fillProbe';

/** Runs `rules` with `probes` on the example; null when they cannot run. */
function runOn(rules: LearnResult, analysis: PairAnalysis, probes: readonly Probe[] = []): Run | null {
  const computed = [...rules.transform.computed];
  const columns = [...rules.output.columns];
  const at: number[] = [];
  probes.forEach((p, i) => {
    const id = `${PROBE}${i}`;
    const after = p.after === null ? -1 : computed.findIndex((c) => c.id === p.after);
    computed.splice(after + 1, 0, { id, type: p.type, expr: p.expr });
    at.push(columns.length);
    columns.push({ header: id, from: id });
  });
  const probed: LearnResult = probes.length === 0 ? rules : { ...rules, transform: { ...rules.transform, computed }, output: { ...rules.output, columns } };
  const result = runRules(probed, exampleTable(analysis));
  if (!result.ok) return null;
  return { rows: alignedActualRows(analysis, result.sheet.rows), at };
}

/** A probe cell as a value: null when empty or missing; a real date as its serial. */
function cellValue(cell: OutCell | undefined): string | number | boolean | null {
  if (cell === undefined || cell.v === undefined || cell.v === null) return null;
  return cell.v;
}

/** `truthy` of the engine (`if`, `and`, `or`), read from a probe cell. */
function truthyCell(cell: OutCell | undefined): boolean {
  const v = cellValue(cell);
  if (v === null) return false;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  return v !== '';
}

/** Whether the row the rules made for aligned row `k` matches the example on every column of `columns`. */
function rowOk(analysis: PairAnalysis, run: Run, k: number, columns: readonly number[]): boolean {
  const row = run.rows[k];
  if (!row) return false;
  return columns.every((c) => cellMatchesExample(analysis, k, c, row.cells[c]));
}

/** The number of wrong things the full verification counts (the learning loop's measure). */
function wrongOf(rules: LearnResult, analysis: PairAnalysis): number {
  const v = verifyAgainstExample(rules, analysis, { wrongRows: true });
  if (v.layoutIssues.some((i) => i.code === 'runFailed')) return Number.POSITIVE_INFINITY;
  return wrongCount(v.wrongRows ?? [], v.layoutIssues.length);
}

// ---------------------------------------------------------------------------
// Expressions
// ---------------------------------------------------------------------------

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

function isNode(e: Expr): e is ExprNode {
  return 'op' in e;
}

/** Every node of `e`, depth first, parents before children. */
function nodesOf(e: Expr, out: ExprNode[] = []): ExprNode[] {
  if (!isNode(e)) return out;
  out.push(e);
  for (const ch of exprChildren(e)) nodesOf(ch, out);
  return out;
}

/** The column ids an expression reads. */
function idsRead(e: Expr, out = new Set<string>()): Set<string> {
  if ('col' in e) out.add(e.col);
  else if (isNode(e)) {
    for (const ch of exprChildren(e)) idsRead(ch, out);
    if (e.op === 'window') {
      for (const id of e.by ?? []) out.add(id);
      for (const o of e.order ?? []) out.add(o.column);
    }
  }
  return out;
}

/** The output positions a computed column reaches: its own output columns and those of every computed column that reads it (no `agg`). */
function outputsOf(rules: LearnResult, id: string): number[] {
  const ids = new Set([id]);
  for (const c of rules.transform.computed) if ([...idsRead(c.expr)].some((x) => ids.has(x))) ids.add(c.id);
  const out: number[] = [];
  rules.output.columns.forEach((o, i) => {
    if (o.from !== null && ids.has(o.from) && o.agg === undefined) out.push(i);
  });
  return out;
}

/** The declared type of a column id (an input or computed column), or undefined. */
function typeOfId(rules: LearnResult, id: string): ColumnType | undefined {
  return rules.input.columns.find((c) => c.id === id)?.type ?? rules.transform.computed.find((c) => c.id === id)?.type;
}

const NUMERIC: ReadonlySet<ColumnType> = new Set(['integer', 'decimal', 'currency', 'percent']);

function hasWindow(rules: LearnResult): boolean {
  return rules.transform.computed.some((c) => nodesOf(c.expr).some((n) => n.op === 'window'));
}

// ---------------------------------------------------------------------------
// The fill
// ---------------------------------------------------------------------------

class Filler {
  readonly counts = new Map<FillKind, number>();
  checks = 0;
  readonly ambiguities: Ambiguity[] = [];

  constructor(
    readonly analysis: PairAnalysis,
    private readonly fixed: LearnResult | undefined,
  ) {}

  count(kind: FillKind, n: number): void {
    if (n > 0) this.counts.set(kind, (this.counts.get(kind) ?? 0) + n);
  }

  /** Completion mode: whether `part` equals one of the user's own (then code never changes it). */
  isFixed<T>(part: T, list: (f: LearnResult) => readonly T[] | T | undefined): boolean {
    if (!this.fixed) return false;
    const theirs = list(this.fixed);
    if (theirs === undefined) return false;
    return Array.isArray(theirs) ? theirs.some((x) => deepEqual(x, part)) : deepEqual(theirs, part);
  }

  fixedComputed(rules: LearnResult, ci: number): boolean {
    return this.isFixed(rules.transform.computed[ci], (f) => f.transform.computed);
  }
}

/**
 * Fills the data parameters of `answer` (unmasked) from every row of the example. See the file header for what, and when. The answer is
 * returned unchanged when nothing could be filled, and when the filled rules would make more of the example wrong than the answer does
 * (the check on every row decides).
 */
export function fillParams(answer: LearnResult, analysis: PairAnalysis, opts: FillOptions = {}): FillResult {
  const none: FillResult = { rules: answer, filled: [], checks: 0, ambiguities: [] };
  // Summary outputs (one row per group) are checked per group, not per row: never filled (the free engine never builds them either).
  if (answer.transform.group !== undefined && !answer.transform.group.showDetailRows) return none;
  if (analysis.alignment.rows.length === 0 || runOn(answer, analysis) === null) return none;

  const f = new Filler(analysis, opts.fixed);
  let rules = clone(answer);
  rules = fillRowChoices(rules, f);
  rules = fillDayMonth(rules, f);
  rules = fillLookups(rules, f);
  rules = fillValueMaps(rules, f);
  // DECISION: an across-row (window) function reads other rows, so a condition forced on every row at once would not show what one row
  // does: conditions are left as the AI wrote them when the rules hold a window.
  if (!hasWindow(rules)) rules = fillConditions(rules, f);

  const filled = KIND_ORDER.filter((k) => f.counts.has(k)).map((kind) => ({ kind, count: f.counts.get(kind)! }));
  if (filled.length === 0) return { ...none, ambiguities: f.ambiguities };
  if (wrongOf(rules, analysis) > wrongOf(answer, analysis)) return { ...none, ambiguities: f.ambiguities };
  return { rules, filled, checks: f.checks, ambiguities: f.ambiguities };
}

// ---------------------------------------------------------------------------
// 6. Which duplicate is kept, which values a filter drops
// ---------------------------------------------------------------------------

/** A value as a filter or a list constant holds it. */
function constOf(v: Val): FilterScalar | undefined {
  if (v === null) return null;
  if (typeof v === 'string' || typeof v === 'boolean') return v;
  if (v instanceof DateVal) return isoOfSerial(v.serial);
  return v.toNumber();
}

function fillRowChoices(rules: LearnResult, f: Filler): LearnResult {
  let wrong = wrongOf(rules, f.analysis);
  if (wrong === 0) return rules;

  // Which duplicate is kept: the other choice, when it makes fewer rows wrong.
  const dedupe = rules.transform.dedupe;
  if (dedupe && !f.isFixed(dedupe, (x) => x.transform.dedupe)) {
    const other: LearnResult = { ...rules, transform: { ...rules.transform, dedupe: { ...dedupe, keep: dedupe.keep === 'first' ? 'last' : 'first' } } };
    const w = wrongOf(other, f.analysis);
    if (w < wrong) {
      rules = other;
      wrong = w;
      f.count('dedupeKeep', 1);
    }
  }

  // Which values a filter drops (an `ne` / `notOneOf` list on one input column): add the values whose every row the example dropped, and
  // take out the ones whose every row the example kept, when that makes fewer rows wrong.
  const filters = rules.input.rowFilters ?? [];
  for (let i = 0; i < filters.length; i++) {
    const filter = (rules.input.rowFilters ?? [])[i];
    if (!filter || 'expr' in filter || (filter.op !== 'ne' && filter.op !== 'notOneOf')) continue;
    if (f.isFixed(filter, (x) => x.input.rowFilters ?? [])) continue;
    const next = filterListFilled(rules, filter as DropList, f.analysis);
    if (!next) continue;
    const candidate: LearnResult = { ...rules, input: { ...rules.input, rowFilters: next.filter ? (rules.input.rowFilters ?? []).map((x, j) => (j === i ? next.filter! : x)) : (rules.input.rowFilters ?? []).filter((_, j) => j !== i) } };
    const w = wrongOf(candidate, f.analysis);
    if (w < wrong) {
      rules = candidate;
      wrong = w;
      f.count('filterList', next.changed);
      if (!next.filter) i--;
    }
  }
  return rules;
}

/** The filter with its list completed from the example (null filter: nothing left to drop), or null when nothing would change. */
type DropList = { column: string; op: 'ne'; value: FilterScalar } | { column: string; op: 'notOneOf'; value: FilterScalar[] };

function filterListFilled(rules: LearnResult, filter: DropList, analysis: PairAnalysis): { filter: RowFilter | null; changed: number } | null {
  const ci = rules.input.columns.findIndex((c) => c.id === filter.column);
  const col = rules.input.columns[ci];
  if (!col) return null;
  const src = mapHeaders(rules.input.columns, analysis.input.headers).src[ci] ?? -1;
  if (src < 0) return null;
  const norm = colNorm(col, analysis.input.date1904, rules.output.language);
  const keyOf = (v: Val): string | null => (v === null ? null : normText(toText(v)));

  // Every input row by the value of the filter's column: is it dropped by the example, or kept (aligned)?
  const dropped = new Set(analysis.alignment.droppedIn);
  const kept = new Set(analysis.alignment.rows.map((r) => r.in));
  const byKey = new Map<string, { value: Val; dropped: number; kept: number; other: number }>();
  analysis.input.rows.forEach((row, r) => {
    const v = normalizeCell(row?.[src], norm, newIssue());
    const key = keyOf(v);
    if (key === null) return;
    let e = byKey.get(key);
    if (!e) byKey.set(key, (e = { value: v, dropped: 0, kept: 0, other: 0 }));
    if (dropped.has(r)) e.dropped++;
    else if (kept.has(r)) e.kept++;
    else e.other++;
  });

  const list: FilterScalar[] = filter.op === 'ne' ? [filter.value] : [...filter.value];
  const listed = new Set(list.map((x) => keyOf(normalizeConst(x, norm))));
  let changed = 0;
  const out = list.filter((x) => {
    const e = byKey.get(keyOf(normalizeConst(x, norm)) ?? '');
    const keep = !(e && e.kept > 0 && e.dropped === 0 && e.other === 0);
    if (!keep) changed++;
    return keep;
  });
  for (const [key, e] of byKey) {
    if (listed.has(key) || e.dropped === 0 || e.kept > 0 || e.other > 0) continue;
    const c = constOf(e.value);
    if (c === undefined || c === null) continue;
    out.push(c);
    changed++;
  }
  if (changed === 0) return null;
  if (out.length === 0) return { filter: null, changed };
  return { filter: out.length === 1 ? { column: filter.column, op: 'ne', value: out[0]! } : { column: filter.column, op: 'notOneOf', value: out }, changed };
}

// ---------------------------------------------------------------------------
// 5. The day/month order of text dates
// ---------------------------------------------------------------------------

/** `format` with day and month swapped ("DD/MM/YYYY" -> "MM/DD/YYYY"), or null when it has no numeric day AND month (or a month name). */
export function swapDayMonthFormat(format: string): string | null {
  if (format === 'excelSerial' || format.includes('MMM')) return null;
  let out = '';
  let day = false;
  let month = false;
  for (let i = 0; i < format.length; ) {
    if (format.startsWith('DD', i)) [out, day, i] = [out + 'MM', true, i + 2];
    else if (format.startsWith('MM', i)) [out, month, i] = [out + 'DD', true, i + 2];
    else if (format[i] === 'D') [out, day, i] = [out + 'M', true, i + 1];
    else if (format[i] === 'M') [out, month, i] = [out + 'D', true, i + 1];
    else [out, i] = [out + format[i], i + 1];
  }
  return day && month ? out : null;
}

/** What the example's texts say about reading them with `format` or with day and month swapped. */
function dayMonthVerdict(texts: readonly string[], format: string, other: string): 'keep' | 'swap' | 'unproven' | 'none' {
  const [a, b] = [compileDateParser(format), compileDateParser(other)];
  let onlyFormat = 0;
  let onlyOther = 0;
  let both = 0;
  for (const t of texts) {
    const [x, y] = [a(t) !== null, b(t) !== null];
    if (x && y) both++;
    else if (x) onlyFormat++;
    else if (y) onlyOther++;
  }
  if (onlyOther > 0 && onlyFormat === 0) return 'swap';
  if (onlyFormat > 0) return 'keep';
  return both > 0 ? 'unproven' : 'none';
}

function fillDayMonth(rules: LearnResult, f: Filler): LearnResult {
  const analysis = f.analysis;
  const headers = mapHeaders(rules.input.columns, analysis.input.headers).src;
  const textsOfInput = (ci: number): string[] => {
    const src = headers[ci] ?? -1;
    if (src < 0) return [];
    const out: string[] = [];
    for (const row of analysis.input.rows) {
      const v = row?.[src]?.v;
      if (typeof v === 'string' && v.trim() !== '') out.push(v);
    }
    return out;
  };

  // `inputFormats` of an input column.
  let next = rules;
  rules.input.columns.forEach((col, ci) => {
    if (col.type !== 'date' || !col.inputFormats || f.isFixed(col, (x) => x.input.columns)) return;
    let texts: string[] | undefined;
    const formats = [...col.inputFormats];
    let changed = false;
    formats.forEach((format, i) => {
      const other = swapDayMonthFormat(format);
      if (other === null || formats.includes(other)) return;
      texts ??= textsOfInput(ci);
      const verdict = dayMonthVerdict(texts, format, other);
      if (verdict === 'swap') {
        formats[i] = other;
        changed = true;
        f.count('dayMonthOrder', 1);
      } else if (verdict === 'unproven') f.ambiguities.push({ kind: 'dayMonthOrder', column: col.header, format, other });
    });
    if (changed) next = { ...next, input: { ...next.input, columns: next.input.columns.map((c, j) => (j === ci ? { ...c, inputFormats: formats } : c)) } };
  });
  rules = next;

  // `toDate(text, format)` in a computed column: the texts are the rules' own argument, run on every row.
  for (let ci = 0; ci < rules.transform.computed.length; ci++) {
    if (f.fixedComputed(rules, ci)) continue;
    const c = rules.transform.computed[ci]!;
    const sites = nodesOf(c.expr).filter((n): n is Extract<ExprNode, { op: 'toDate' }> => n.op === 'toDate' && swapDayMonthFormat(n.format) !== null);
    if (sites.length === 0) continue;
    const run = runOn(rules, analysis, sites.map((n) => ({ after: c.id, expr: n.arg, type: 'text' as const })));
    if (!run) continue;
    let expr = c.expr;
    sites.forEach((n, s) => {
      const texts = run.rows.flatMap((row) => {
        const v = cellValue(row?.cells[run.at[s]!]);
        return typeof v === 'string' && v.trim() !== '' ? [v] : [];
      });
      const other = swapDayMonthFormat(n.format)!;
      const verdict = dayMonthVerdict(texts, n.format, other);
      if (verdict === 'swap') {
        expr = replaceNode(expr, n, { ...n, format: other });
        f.count('dayMonthOrder', 1);
      } else if (verdict === 'unproven') f.ambiguities.push({ kind: 'dayMonthOrder', column: inputHeaderOf(rules, n.arg) ?? c.id, format: n.format, other });
    });
    if (expr !== c.expr) rules = withComputedExpr(rules, ci, expr);
  }
  return rules;
}

/** The header of the first input column an expression reads. */
function inputHeaderOf(rules: LearnResult, e: Expr): string | undefined {
  for (const id of idsRead(e)) {
    const col = rules.input.columns.find((c) => c.id === id);
    if (col) return col.header;
  }
  return undefined;
}

/**
 * The answer to a day/month question (proposal 7.2): every place the rules read `a.column` with `a.format` reads it with `a.other`
 * instead (the column's `inputFormats`, and `toDate` on that column). Pure.
 */
export function swapDayMonth(rules: LearnResult, a: DayMonthAmbiguity): LearnResult {
  const ids = new Set(rules.input.columns.filter((c) => c.header === a.column).map((c) => c.id));
  const swap = (expr: Expr): Expr => {
    let out = expr;
    for (const n of nodesOf(expr)) {
      if (n.op === 'toDate' && n.format === a.format && [...idsRead(n.arg)].some((id) => ids.has(id))) out = replaceNode(out, n, { ...n, format: a.other });
    }
    return out;
  };
  return {
    ...rules,
    input: { ...rules.input, columns: rules.input.columns.map((c) => (c.header === a.column && c.inputFormats ? { ...c, inputFormats: c.inputFormats.map((x) => (x === a.format ? a.other : x)) } : c)) },
    transform: { ...rules.transform, computed: rules.transform.computed.map((c) => ({ ...c, expr: swap(c.expr) })) },
  };
}

// ---------------------------------------------------------------------------
// 1. Lookup tables and value maps
// ---------------------------------------------------------------------------

/** What has to hold on a row for a branch to be the one taken: an expression truthy, falsy, or empty (the args before it in a coalesce). */
interface PathStep {
  expr: Expr;
  want: 'truthy' | 'falsy' | 'empty';
}

interface LookupSite {
  node: Extract<ExprNode, { op: 'lookup' }>;
  path: PathStep[];
}

/** The lookups whose value IS the column's value on the rows where their branch is taken (`if`, `switch`, `coalesce`), with that branch. */
function lookupSites(e: Expr, path: PathStep[], out: LookupSite[]): LookupSite[] {
  if (!isNode(e)) return out;
  switch (e.op) {
    case 'lookup':
      out.push({ node: e, path });
      break;
    case 'if':
      lookupSites(e.then, [...path, { expr: e.cond, want: 'truthy' }], out);
      lookupSites(e.else, [...path, { expr: e.cond, want: 'falsy' }], out);
      break;
    case 'switch': {
      const before: PathStep[] = [];
      for (const cs of e.cases) {
        lookupSites(cs.then, [...path, ...before, { expr: cs.when, want: 'truthy' }], out);
        before.push({ expr: cs.when, want: 'falsy' });
      }
      lookupSites(e.else, [...path, ...before], out);
      break;
    }
    case 'coalesce':
      e.args.forEach((a, i) => lookupSites(a, [...path, ...e.args.slice(0, i).map((x) => ({ expr: x, want: 'empty' as const }))], out));
      break;
    default:
      break;
  }
  return out;
}

/** The text a lookup compares a key by (`normKey`), from a probe cell; null when empty, a date or not a plain value. */
function keyText(cell: OutCell | undefined): string | null {
  if (!cell || cell.isDate === true) return null;
  const v = cellValue(cell);
  if (v === null || typeof v === 'boolean') return null;
  return typeof v === 'number' ? decText(new Decimal(v)) : v;
}

/** A cell value to put in a table or a map, keyed for "do these rows agree" (empty text and an empty cell are the same). */
function agreeKey(v: PayloadCell): string {
  return v === '' || v === null ? 'null' : JSON.stringify(v);
}

/** Per key: the value every row of the key agrees on, or undefined for a key whose rows disagree. */
type Pairs = Map<string, { key: string; value: PayloadCell | undefined }>;

function addPair(pairs: Pairs, norm: string, key: string, value: PayloadCell): void {
  const e = pairs.get(norm);
  if (!e) pairs.set(norm, { key, value });
  else if (e.value !== undefined && agreeKey(e.value) !== agreeKey(value)) e.value = undefined;
}

function fillLookups(rules: LearnResult, f: Filler): LearnResult {
  const tables = rules.transform.tables ?? [];
  if (tables.length === 0) return rules;
  const analysis = f.analysis;
  /** table name -> return column -> pairs. */
  const found = new Map<string, Map<string, Pairs>>();

  for (let ci = 0; ci < rules.transform.computed.length; ci++) {
    const c = rules.transform.computed[ci]!;
    // The lookup's value must be what an output column shows: an output column reads this computed column directly, and no value map changes it.
    const out = rules.output.columns.findIndex((o) => o.from === c.id && o.agg === undefined);
    if (out < 0 || rules.transform.valueMaps.some((m) => m.column === c.id)) continue;
    const sites = lookupSites(c.expr, [], []).filter((s) => tables.some((t) => t.name === s.node.table && !f.isFixed(t, (x) => x.transform.tables ?? [])));
    if (sites.length === 0) continue;
    const probes: Probe[] = [];
    const plan = sites.map((s) => {
      const key = probes.push({ after: c.id, expr: s.node.key, type: 'text' }) - 1;
      const path = s.path.map((p) => ({ want: p.want, at: probes.push({ after: c.id, expr: p.expr, type: p.want === 'empty' ? 'text' : 'boolean' }) - 1 }));
      return { site: s, key, path };
    });
    const run = runOn(rules, analysis, probes);
    if (!run) continue;
    for (const { site, key, path } of plan) {
      const byReturn = found.get(site.node.table) ?? new Map<string, Pairs>();
      found.set(site.node.table, byReturn);
      const pairs = byReturn.get(site.node.return) ?? (new Map() as Pairs);
      byReturn.set(site.node.return, pairs);
      run.rows.forEach((row, k) => {
        if (!row) return;
        // The context: only the rows where this lookup's branch is the one taken (the rules' own evaluation of each condition).
        const taken = path.every((p) => {
          const cell = row.cells[run.at[p.at]!];
          return p.want === 'empty' ? cellValue(cell) === null : truthyCell(cell) === (p.want === 'truthy');
        });
        if (!taken) return;
        const text = keyText(row.cells[run.at[key]!]);
        const expected = exampleCellAt(analysis, k, out);
        if (text === null || expected.date) return;
        addPair(pairs, normText(text), text, expected.v);
      });
    }
  }

  let added = 0;
  const nextTables = tables.map((t) => {
    const byReturn = found.get(t.name);
    if (!byReturn) return t;
    const filled = tableFilled(t, byReturn);
    added += filled.rows.length - t.rows.length;
    return filled;
  });
  if (added === 0) return rules;
  f.count('lookup', added);
  return { ...rules, transform: { ...rules.transform, tables: nextTables } };
}

/**
 * `table` with a row for every key the example shows and the table lacks, each return column from the lookups that return it (null where
 * none does). DECISION: entries the AI wrote are never changed, only added to - a key it got wrong stays wrong and goes back to the loop.
 * DECISION: a table that would pass `limits.rules.maxTableRows` is not filled at all (half a table is no better than the AI's).
 */
function tableFilled(table: RulesTable, byReturn: ReadonlyMap<string, Pairs>): RulesTable {
  const have = new Set(table.rows.map((r) => normText(toText(constValOf(r[0] ?? null)))));
  const numericKeys = table.rows.length > 0 && table.rows.every((r) => typeof r[0] === 'number');
  const fresh = new Map<string, TableCellValue[]>();
  for (const [returnColumn, pairs] of byReturn) {
    const at = table.columns.indexOf(returnColumn);
    if (at <= 0) continue;
    for (const [norm, { key, value }] of pairs) {
      if (value === undefined || have.has(norm)) continue;
      let row = fresh.get(norm);
      if (!row) {
        // Numbers when the AI's keys are numbers, and only when the number reads back as the same text (never "0101" as 101).
        const asNumber = numericKeys && /^-?\d+(\.\d+)?$/.test(key) && decText(new Decimal(key)) === key ? Number(key) : null;
        row = [asNumber ?? key, ...table.columns.slice(1).map(() => null)];
        fresh.set(norm, row);
      }
      row[at] = value === '' ? null : value;
    }
  }
  if (fresh.size === 0 || table.rows.length + fresh.size > limits.rules.maxTableRows) return table;
  return { ...table, rows: [...table.rows, ...fresh.values()] };
}

/** A table cell as the engine reads it (the key compare), without decimal.js. */
function constValOf(v: TableCellValue): Val {
  if (v === null || v === '') return null;
  if (typeof v === 'number') return new Decimal(v);
  return v;
}

function fillValueMaps(rules: LearnResult, f: Filler): LearnResult {
  const analysis = f.analysis;
  let added = 0;
  const maps = rules.transform.valueMaps.map((vm, i) => {
    if (f.isFixed(vm, (x) => x.transform.valueMaps)) return vm;
    // A second map on the same column would see the first one's output: left alone.
    if (rules.transform.valueMaps.some((m, j) => j !== i && m.column === vm.column)) return vm;
    const outs = rules.output.columns.flatMap((o, c) => (o.from === vm.column && o.agg === undefined ? [c] : []));
    if (outs.length === 0) return vm;
    // The value before the map: the rules run without it.
    const run = runOn({ ...rules, transform: { ...rules.transform, valueMaps: rules.transform.valueMaps.filter((_, j) => j !== i) } }, analysis);
    if (!run) return vm;
    const out = outs[0]!;
    const pairs: Pairs = new Map();
    run.rows.forEach((row, k) => {
      const text = keyText(row?.cells[out]);
      const expected = exampleCellAt(analysis, k, out);
      // DECISION: a value map writes text; a number or a date the example shows is not a map entry (the check would not match it).
      if (text === null || expected.date || (expected.v !== null && typeof expected.v !== 'string')) return;
      addPair(pairs, normText(text), text, expected.v);
    });
    const have = new Set(Object.keys(vm.map).map(normText));
    const map = { ...vm.map };
    for (const [norm, { key, value }] of pairs) {
      if (value === undefined || have.has(norm)) continue;
      map[key] = value === null ? '' : String(value);
      added++;
    }
    return Object.keys(map).length === Object.keys(vm.map).length ? vm : { ...vm, map };
  });
  if (added === 0) return rules;
  f.count('valueMap', added);
  return { ...rules, transform: { ...rules.transform, valueMaps: maps } };
}

// ---------------------------------------------------------------------------
// 2-4. Value lists and cut-offs in conditions
// ---------------------------------------------------------------------------

/** A comparison node (`eq` ... `lte` share one shape in the AST). */
type CmpNode = Extract<ExprNode, { op: 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' }>;
type ListNode = Extract<ExprNode, { op: 'oneOf' }> | Extract<ExprNode, { op: 'and' | 'or' }> | CmpNode;
type CutNode = CmpNode;

interface ListSite {
  kind: 'list';
  node: ListNode;
  /** The expression the list is about, and the constants it holds. */
  arg: Expr;
  values: ExprConstValue[];
}
interface CutSite {
  kind: 'cut';
  node: CutNode;
  /** The column compared, and the comparison written with the column on the left. */
  column: string;
  op: 'gt' | 'gte' | 'lt' | 'lte';
  isDate: boolean;
  /** The AI's cut-off: a number, or a date's serial. */
  k: number;
}
type Site = ListSite | CutSite;

/** `eq(x, const)` or `eq(const, x)`: the other side and the constant (a text or a number). */
function eqConst(n: ExprNode): { arg: Expr; value: ExprConstValue } | null {
  if (n.op !== 'eq') return null;
  const [a, b] = n.args;
  const isValue = (e: Expr): e is { const: string | number } => 'const' in e && (typeof e.const === 'string' || typeof e.const === 'number');
  if (isValue(b) && !('const' in a)) return { arg: a, value: b.const };
  if (isValue(a) && !('const' in b)) return { arg: b, value: a.const };
  return null;
}

function listSiteOf(n: ExprNode): ListSite | null {
  if (n.op === 'oneOf' && !('const' in n.arg) && n.values.every((v) => typeof v === 'string' || typeof v === 'number')) return { kind: 'list', node: n, arg: n.arg, values: n.values };
  const single = eqConst(n);
  if (single) return { kind: 'list', node: n as ListNode, arg: single.arg, values: [single.value] };
  if (n.op === 'or' && n.args.length > 0) {
    const eqs = n.args.map((a) => (isNode(a) ? eqConst(a) : null));
    if (eqs.every((x) => x !== null) && eqs.every((x) => deepEqual(x!.arg, eqs[0]!.arg))) return { kind: 'list', node: n, arg: eqs[0]!.arg, values: eqs.map((x) => x!.value) };
  }
  return null;
}

function cutSiteOf(rules: LearnResult, n: ExprNode): CutSite | null {
  if (n.op !== 'gt' && n.op !== 'gte' && n.op !== 'lt' && n.op !== 'lte') return null;
  const flip = { gt: 'lt', gte: 'lte', lt: 'gt', lte: 'gte' } as const;
  const [a, b] = n.args;
  const [column, constant, op] = 'col' in a ? [a.col, b, n.op] : 'col' in b ? [b.col, a, flip[n.op]] : [null, null, n.op];
  if (column === null || constant === null) return null;
  const type = typeOfId(rules, column);
  if (type === undefined) return null;
  if (NUMERIC.has(type) && 'const' in constant && typeof constant.const === 'number') return { kind: 'cut', node: n, column, op, isDate: false, k: constant.const };
  if (type === 'date' && isNode(constant) && constant.op === 'dateLiteral') {
    const [y, m, d] = constant.value.split('-').map(Number) as [number, number, number];
    return { kind: 'cut', node: n, column, op, isDate: true, k: ymdToSerial({ y, m, d }) };
  }
  return null;
}

/** The conditions of one computed column, depth first; a list is one site (its own `=` are not sites again). */
function sitesOf(rules: LearnResult, e: Expr, out: Site[] = []): Site[] {
  if (!isNode(e)) return out;
  const list = listSiteOf(e);
  if (list) {
    out.push(list);
    return out;
  }
  const cut = cutSiteOf(rules, e);
  if (cut) out.push(cut);
  for (const ch of exprChildren(e)) sitesOf(rules, ch, out);
  return out;
}

function fillConditions(rules: LearnResult, f: Filler): LearnResult {
  let budget = limits.learn.fill.maxConditions;
  for (let ci = 0; ci < rules.transform.computed.length && budget > 0; ci++) {
    if (f.fixedComputed(rules, ci)) continue;
    const id = rules.transform.computed[ci]!.id;
    const outs = outputsOf(rules, id);
    if (outs.length === 0) continue;
    const count = sitesOf(rules, rules.transform.computed[ci]!.expr).length;
    // Bands: a column compared with constants in more than one place of the same formula.
    const cuts = sitesOf(rules, rules.transform.computed[ci]!.expr).filter((s): s is CutSite => s.kind === 'cut');
    for (let s = 0; s < count && budget > 0; s++) {
      // Sites are found again on the current rules: a fill changes constants and lists, never how many sites there are or their order.
      const site = sitesOf(rules, rules.transform.computed[ci]!.expr)[s]!;
      budget--;
      const next = site.kind === 'list' ? fillList(rules, ci, site, outs, f) : fillCut(rules, ci, site, outs, f, cuts.filter((c) => c.column === site.column).length > 1);
      if (next) rules = next;
    }
  }
  return rules;
}

/** The rules with node `target` of computed column `ci` forced to a constant, plus probes. */
function forced(rules: LearnResult, ci: number, target: ExprNode, value: boolean): LearnResult {
  return withComputedExpr(rules, ci, replaceNode(rules.transform.computed[ci]!.expr, target, { const: value }));
}

/**
 * A value list (`oneOf`, an or-chain of `=`, one `=`): a value of its column is added when EVERY row holding it is right with the
 * condition true, and some are wrong now (the rest of the formula does not already explain them). Conservative by construction: a row that
 * does not agree keeps its value out.
 */
function fillList(rules: LearnResult, ci: number, site: ListSite, outs: readonly number[], f: Filler): LearnResult | null {
  const analysis = f.analysis;
  const c = rules.transform.computed[ci]!;
  const probe: Probe = { after: c.id, expr: site.arg, type: 'text' };
  const [whenTrue, now] = [runOn(forced(rules, ci, site.node, true), analysis, [probe]), runOn(rules, analysis, [probe])];
  if (!whenTrue || !now) return null;
  const numbers = site.values.every((v) => typeof v === 'number');
  const listed = new Set(site.values.map((v) => normText(String(v))));
  const groups = new Map<string, { text: string; allTrue: boolean; someWrong: boolean }>();
  now.rows.forEach((row, k) => {
    const text = keyText(row?.cells[now.at[0]!]);
    if (text === null) return;
    const key = normText(text);
    if (listed.has(key)) return;
    const g = groups.get(key) ?? { text, allTrue: true, someWrong: false };
    groups.set(key, g);
    if (!rowOk(analysis, whenTrue, k, outs)) g.allTrue = false;
    if (!rowOk(analysis, now, k, outs)) g.someWrong = true;
  });
  const added: ExprConstValue[] = [];
  for (const g of groups.values()) {
    if (!g.allTrue || !g.someWrong) continue;
    if (numbers && !/^-?\d+(\.\d+)?$/.test(g.text)) continue;
    added.push(numbers ? Number(g.text) : g.text);
  }
  if (added.length === 0) return null;
  const values = [...site.values, ...added];
  let node: ExprNode;
  if (site.node.op === 'oneOf') node = { ...site.node, values };
  else node = { op: 'or', args: values.map((v) => ({ op: 'eq', args: [site.arg, { const: v }] }) as Expr) };
  f.count('valueList', added.length);
  return withComputedExpr(rules, ci, replaceNode(c.expr, site.node, node));
}

/**
 * A cut-off (the column compared with one constant): with the comparison forced true, then false, every row's outcome is known for every
 * place the line could be drawn, so each gap between neighbouring values of the column is scored exactly (DECISION: no candidate needs a
 * run of its own, so no sampling: two runs per cut-off, whatever the number of values). Only the rows whose outcome the comparison decides
 * (right one way, wrong the other) take part. The range is the run of best-scoring gaps holding the AI's value, else the best run nearest
 * to it; an open-ended range (the example has rows on one side only) is left as the AI wrote it.
 */
function fillCut(rules: LearnResult, ci: number, site: CutSite, outs: readonly number[], f: Filler, band: boolean): LearnResult | null {
  const analysis = f.analysis;
  const c = rules.transform.computed[ci]!;
  const probe: Probe = { after: c.id, expr: { col: site.column }, type: site.isDate ? 'date' : 'decimal' };
  const [whenTrue, whenFalse] = [runOn(forced(rules, ci, site.node, true), analysis, [probe]), runOn(forced(rules, ci, site.node, false), analysis, [probe])];
  if (!whenTrue || !whenFalse) return null;

  // The rows the comparison decides, with their value of the column and which outcome is right.
  const decided: { x: number; trueOk: boolean }[] = [];
  let decimals = 0;
  whenTrue.rows.forEach((row, k) => {
    const v = cellValue(row?.cells[whenTrue.at[0]!]);
    if (typeof v !== 'number') return;
    const [t, fl] = [rowOk(analysis, whenTrue, k, outs), rowOk(analysis, whenFalse, k, outs)];
    if (t === fl) return;
    decided.push({ x: v, trueOk: t });
    decimals = Math.max(decimals, decimalsOf(v));
  });
  if (decided.length === 0) return null;

  // Distinct values u[0..m-1]; gap g in 0..m lies between u[g-1] and u[g]. "Upper" comparisons (gt/gte) are true above the gap.
  const u = [...new Set(decided.map((d) => d.x))].sort((a, b) => a - b);
  const m = u.length;
  const upper = site.op === 'gt' || site.op === 'gte';
  const at = new Map(u.map((x, i) => [x, i] as const));
  const okAbove = new Array<number>(m).fill(0); // rows at u[i] that are right when the comparison holds for them
  const okBelow = new Array<number>(m).fill(0);
  for (const d of decided) {
    const i = at.get(d.x)!;
    if (d.trueOk === upper) okAbove[i]!++;
    else okBelow[i]!++;
  }
  const score: number[] = [];
  let below = 0;
  let above = okAbove.reduce((a, b) => a + b, 0);
  for (let g = 0; g <= m; g++) {
    score.push(below + above);
    if (g < m) {
      below += okBelow[g]!;
      above -= okAbove[g]!;
    }
  }
  const best = Math.max(...score);
  // The AI's gap: how many values fall below its line.
  const strictBelow = site.op === 'gte' || site.op === 'lt'; // the cut-off itself is on the upper side of the line
  const aiGap = u.filter((x) => (strictBelow ? x < site.k : x <= site.k)).length;
  let g0: number;
  if (score[aiGap] === best) g0 = aiGap;
  else {
    // DECISION: the best run nearest the AI's value (its logic was right, its number a guess); a tie goes to the lower one.
    let nearest = -1;
    for (let g = 0; g <= m; g++) if (score[g] === best && (nearest < 0 || Math.abs(g - aiGap) < Math.abs(nearest - aiGap))) nearest = g;
    g0 = nearest;
  }
  let [lo, hi] = [g0, g0];
  while (lo > 0 && score[lo - 1] === best) lo--;
  while (hi < m && score[hi + 1] === best) hi++;
  if (lo === 0 || hi === m) return null; // open-ended: the example has rows on one side of the line only

  // The range of the cut-off: between u[lo-1] and u[hi], the cut-off on the upper side's edge (gte, lt) or the lower side's (gt, lte).
  const low = u[lo - 1]!;
  const high = u[hi]!;
  const includes: 'high' | 'low' = strictBelow ? 'high' : 'low';
  const inside = (x: number): boolean => (includes === 'high' ? x > low && x <= high : x >= low && x < high);
  const value = inside(site.k) ? site.k : site.isDate ? roundestDate(low, high, includes) : roundestNumber(low, high, includes, decimals);
  const settled = site.isDate ? high - low <= 1 : new Decimal(high).minus(low).lte(new Decimal(10).pow(-decimals));

  let next = rules;
  if (value !== site.k) {
    const constant: Expr = site.isDate ? { op: 'dateLiteral', value: isoOfSerial(value) } : { const: value };
    const [a, b] = site.node.args;
    const node: CutNode = { ...site.node, args: 'col' in a && a.col === site.column ? [a, constant] : [constant, b] };
    next = withComputedExpr(next, ci, replaceNode(c.expr, site.node, node));
  }
  let checked = false;
  if (!settled) {
    const shown = (x: number): number | string => (site.isDate ? isoOfSerial(x) : x);
    const check: Validation = { column: site.column, rule: 'cutoffRange', low: shown(low), high: shown(high), value: shown(value), includes, severity: 'flag' };
    if (!next.validations.some((v) => deepEqual(v, check))) {
      next = { ...next, validations: [...next.validations, check] };
      f.checks++;
      checked = true;
    }
  }
  if (value === site.k && !checked) return null;
  f.count(band ? 'band' : 'cutoff', 1);
  return next;
}

function decimalsOf(x: number): number {
  const s = new Decimal(x).toFixed();
  const dot = s.indexOf('.');
  return dot < 0 ? 0 : s.length - dot - 1;
}

/**
 * The roundest number inside the range: the fewest significant digits, then the closest to the middle, then the lower; never finer than
 * the data's own decimals (an edge itself always qualifies at that grain).
 */
export function roundestNumber(low: number, high: number, includes: 'high' | 'low', decimals: number): number {
  const [lo, hi] = [new Decimal(low), new Decimal(high)];
  const mid = lo.plus(hi).div(2);
  const top = Math.max(0, Math.ceil(Math.log10(Math.max(Math.abs(low), Math.abs(high), 1)))) + 1;
  for (let e = top; e >= -decimals; e--) {
    const step = new Decimal(10).pow(e);
    // The multiples of `step` inside: (lo, hi] or [lo, hi).
    let first = includes === 'high' ? lo.div(step).floor().plus(1) : lo.div(step).ceil();
    const last = includes === 'high' ? hi.div(step).floor() : hi.div(step).ceil().minus(1);
    if (first.gt(last)) continue;
    let best: { v: Decimal; digits: number; dist: Decimal } | null = null;
    for (let n = 0; first.lte(last) && n < 20; n++, first = first.plus(1)) {
      const v = first.times(step);
      const digits = first.abs().toFixed().replace(/0+$/, '').length || 1;
      const dist = v.minus(mid).abs();
      if (!best || digits < best.digits || (digits === best.digits && dist.lt(best.dist))) best = { v, digits, dist };
    }
    return best!.v.toNumber();
  }
  return includes === 'high' ? high : low;
}

/** The roundest date inside the range (Excel serials): a January 1st, else a 1st of a month, else the day closest to the middle. */
export function roundestDate(low: number, high: number, includes: 'high' | 'low'): number {
  const [from, to] = includes === 'high' ? [low + 1, high] : [low, high - 1];
  const mid = (from + to) / 2;
  const pick = (candidates: number[]): number | null =>
    candidates.length === 0 ? null : candidates.reduce((a, b) => (Math.abs(b - mid) < Math.abs(a - mid) ? b : a));
  const firsts: number[] = [];
  const years: number[] = [];
  const start = serialToYmd(from);
  for (let y = start.y, mo = start.m; ; ) {
    const s = ymdToSerial({ y, m: mo, d: 1 });
    if (s > to) break;
    if (s >= from) {
      firsts.push(s);
      if (mo === 1) years.push(s);
    }
    [y, mo] = mo === 12 ? [y + 1, 1] : [y, mo + 1];
  }
  return pick(years) ?? pick(firsts) ?? Math.round(mid);
}

// ---------------------------------------------------------------------------
// Tree edits
// ---------------------------------------------------------------------------

/** `e` with the node `target` (by identity) replaced; every other node is shared. */
function replaceNode(e: Expr, target: ExprNode, by: Expr): Expr {
  if (e === target) return by;
  if (!isNode(e)) return e;
  let changed = false;
  const copy: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(e)) {
    let next: unknown = v;
    if (Array.isArray(v)) {
      const arr = v.map((x: unknown) => {
        if (x && typeof x === 'object' && 'when' in x && 'then' in x) {
          const cs = x as { when: Expr; then: Expr };
          const [w, t] = [replaceNode(cs.when, target, by), replaceNode(cs.then, target, by)];
          return w === cs.when && t === cs.then ? x : { when: w, then: t };
        }
        return x && typeof x === 'object' && ('op' in x || 'col' in x || 'const' in x || 'param' in x) ? replaceNode(x as Expr, target, by) : x;
      });
      if (arr.some((x, i) => x !== v[i])) next = arr;
    } else if (v && typeof v === 'object' && ('op' in v || 'col' in v || 'const' in v || 'param' in v)) {
      next = replaceNode(v as Expr, target, by);
    }
    if (next !== v) changed = true;
    copy[k] = next;
  }
  return changed ? (copy as unknown as Expr) : e;
}

function withComputedExpr(rules: LearnResult, ci: number, expr: Expr): LearnResult {
  return { ...rules, transform: { ...rules.transform, computed: rules.transform.computed.map((c, i) => (i === ci ? { ...c, expr } : c)) } };
}
