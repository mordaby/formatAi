// The overfitting guards (SPEC 9.2 layer 6, 21 v12 item 19): three shapes of rule that copy particular rows of the example instead of
// stating a rule, found in code whatever the prompt says. The learn-v8 measurement (2026-10-05) showed the model fitting every row at any
// cost - `if(rowNumber() = 1, 0, ...)` for one hand-edited row, a 3,269-character `switch` of supplier + item mapped to warehouse codes for
// a column whose values come from elsewhere - and both passed every check, because they DO reproduce the rows they were written from.
//
//   - position: a condition that compares a row-position window function (`rowNumber()`, `rank(...)`) of the whole file with a constant.
//     It singles out the rows that happen to sit there in this file. `rowNumber()` as a column's VALUE (a line number) is no condition and
//     stays allowed, and so does a position within a group (`rowNumber(by: customer) = 1`, the first row of each customer: it holds for
//     any number of groups, so the full verification judges it like any rule).
//   - caseList: a computed column that is a long chain of cases (`switch`, or `if` nested in the else), each case giving a constant to
//     the rows an equality or range of input columns picks, and each case picking at most a couple of the rows code can see. A real
//     mapping is a value map or a lookup table (code fills those from every row and flags a new key at run time); a case list like this
//     only repeats the example's answers. See `limits.learn.overfit` for the thresholds.
//   - measureKey: a lookup table keyed on a measure - a decimal, currency or percent column, an amount (`lookup("t", amount, "x")`). An
//     amount is no category: next month's file brings new ones, so a table of amounts only holds this file's rows (and code's fill, which
//     completes a lookup from every row, would copy every one of them). learn-v8.1 wrote exactly this for a hand-edited row in its first
//     real learn (2026-10-05): `coalesce(lookup("discountTable", amount, "discountAmount"), round(amount * 0.1, 2))`, filled to 150
//     entries, verified, wrong the next month. DECISION: lookups only, and a plain column as the key - no kept rules file of the
//     measurement keys one on a measure; an integer key may be a code (a branch number), and a date a calendar (holidays).
//
// A finding becomes one `overfit` repair problem per column (`overfitProblems`), at most once per learn; an answer that still has it after
// that repair gets the column reported as unsupported by code (`withOverfitFallback`, reason `overfit`: "needs your input"), so a rule that
// only copies rows is never counted as verified. The API runs the guards on the samples (and the loop's rows), the browser on every row of
// the example (`learn/flow.ts`).
//
// Pure and synchronous, like the rest of this package.
import { limits, type Computed, type Expr, type ExprNode, type LearnResult, type RepairProblem, type Rules } from '@formatai/shared';
import { runRules } from '../pipeline/runRules';
import { exprChildren } from '../pipeline/v1/expr';
import type { InputTable } from '../types';

export type OverfitKind = 'position' | 'caseList' | 'measureKey';

export interface OverfitFinding {
  kind: OverfitKind;
  /** The output column (header) whose rule copies rows, and its position in `output.columns`. */
  outputColumn: string;
  out: number;
  /** The computed column the finding is in (the output column's own, or one it reads). */
  id: string;
  /** caseList: how many cases the chain has. */
  cases?: number;
}

/** The unsupported reason code code writes for a column whose only rule copied rows (never offered to the AI step: `AI_UNSUPPORTED_REASON_CODES`). */
export const OVERFIT_REASON = 'overfit' as const;

type AnyRules = LearnResult | Rules;

const isNode = (e: Expr): e is ExprNode => 'op' in e;

/** A constant: a literal, or a fixed date (`date("2026-01-31")`). */
function isConstant(e: Expr): boolean {
  return 'const' in e || (isNode(e) && e.op === 'dateLiteral');
}

const COMPARISONS: ReadonlySet<string> = new Set(['eq', 'ne', 'gt', 'gte', 'lt', 'lte']);
const POSITION_FNS: ReadonlySet<string> = new Set(['rowNumber', 'rank']);

// ---------------------------------------------------------------------------
// position
// ---------------------------------------------------------------------------

/** A row's position in the whole file: `rowNumber()` / `rank(...)` with no `by:`, or a computed column that is one. */
function isPosition(e: Expr, positionIds: ReadonlySet<string>): boolean {
  if ('col' in e) return positionIds.has(e.col);
  return isNode(e) && e.op === 'window' && POSITION_FNS.has(e.fn) && (e.by === undefined || e.by.length === 0);
}

/** The computed columns whose value is a whole-file position (directly, or a copy of one), in rules order. */
export function positionColumns(computed: readonly Computed[]): Set<string> {
  const ids = new Set<string>();
  for (const c of computed) if (isPosition(c.expr, ids)) ids.add(c.id);
  return ids;
}

/** Whether `e` holds a comparison of a whole-file position with a constant (`rowNumber() = 1`, `rank(order: x) <= 3`, `oneOf(rowNumber(), 1, 2)`). */
export function comparesPosition(e: Expr, positionIds: ReadonlySet<string>): boolean {
  if (!isNode(e)) return false;
  if (COMPARISONS.has(e.op)) {
    const [a, b] = (e as { args: [Expr, Expr] }).args;
    if ((isPosition(a, positionIds) && isConstant(b)) || (isPosition(b, positionIds) && isConstant(a))) return true;
  }
  if (e.op === 'oneOf' && isPosition(e.arg, positionIds)) return true;
  return exprChildren(e).some((c) => comparesPosition(c, positionIds));
}

// ---------------------------------------------------------------------------
// caseList
// ---------------------------------------------------------------------------

interface Case {
  when: Expr;
  then: Expr;
}

/** The cases of a `switch`, or of an `if` chain nested in the else (`if(c1, v1, if(c2, v2, ...))`), in order; [] for anything else. */
function casesOf(e: Expr): Case[] {
  const cases: Case[] = [];
  let at = e;
  for (;;) {
    if (isNode(at) && at.op === 'switch') {
      cases.push(...at.cases);
      at = at.else;
    } else if (isNode(at) && at.op === 'if') {
      cases.push({ when: at.cond, then: at.then });
      at = at.else;
    } else {
      return cases;
    }
  }
}

/**
 * Whether `e` only picks rows by their input values: equalities and ranges of an input column with a constant (`supplier = "A"`,
 * `qty >= 30`, `oneOf(item, "a", "b")`), joined by `and` / `or`. The input columns it reads are added to `read`.
 */
function picksRows(e: Expr, inputIds: ReadonlySet<string>, read: Set<string>): boolean {
  if (!isNode(e)) return false;
  switch (e.op) {
    case 'and':
    case 'or':
      return e.args.length > 0 && e.args.every((a) => picksRows(a, inputIds, read));
    case 'eq':
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const [a, b] = e.args;
      const col = 'col' in a && isConstant(b) ? a.col : 'col' in b && isConstant(a) ? b.col : undefined;
      if (col === undefined || !inputIds.has(col)) return false;
      read.add(col);
      return true;
    }
    case 'oneOf':
      if (!('col' in e.arg) || !inputIds.has(e.arg.col)) return false;
      read.add(e.arg.col);
      return true;
    default:
      return false;
  }
}

/**
 * The shape of a memorized case list, before the rows are counted: at least `minCases` cases, each giving a constant, each picking rows by
 * equalities or ranges of input columns, and together reading at least two input columns. DECISION: a chain on ONE column is a value map or
 * a band table written out (`switch(amount < 100, "A", amount < 200, "B", ...)`) - one key, one answer each, a rule that holds for any row -
 * so it is left to the full verification; a row of the example is pinned by a COMBINATION of its values. (One column that is a key of the
 * file would pin rows too, but a special value in it - a house account - is a real rule as often as not: no finding.)
 */
function caseListShape(e: Expr, inputIds: ReadonlySet<string>): Case[] | null {
  const cases = casesOf(e);
  if (cases.length < limits.learn.overfit.minCases) return null;
  const read = new Set<string>();
  for (const c of cases) {
    if (!isConstant(c.then) || !picksRows(c.when, inputIds, read)) return null;
  }
  return read.size >= 2 ? cases : null;
}

const PROBE = '__overfitProbe';

/**
 * How many of the rows code can see each case is the one taken for: the rules run on `table` with a hidden column that is the number of the
 * case taken (0: none), and only that column read. Sort, groups and summary rows are left out (they never change which case a row takes);
 * filters, duplicates and expand stay (they decide which rows there are). Null when the rules cannot run.
 */
function caseCounts(rules: AnyRules, cases: readonly Case[], table: InputTable): number[] | null {
  let id = PROBE;
  while (rules.transform.computed.some((c) => c.id === id) || rules.input.columns.some((c) => c.id === id)) id = `_${id}`;
  const probe: Expr = { op: 'switch', cases: cases.map((c, i) => ({ when: c.when, then: { const: i + 1 } })), else: { const: 0 } };
  const { group: _group, ...transform } = rules.transform;
  const { summaryRows: _summaryRows, grandTotal: _grandTotal, ...output } = rules.output;
  const probed = {
    ...rules,
    transform: { ...transform, computed: [{ id, type: 'integer' as const, expr: probe }, ...rules.transform.computed], sort: [] },
    output: { ...output, titleRows: [], columns: [{ header: id, from: id }] },
    validations: [],
  } as AnyRules;
  const result = runRules(probed, table);
  if (!result.ok) return null;
  const counts = new Array<number>(cases.length).fill(0);
  for (const row of result.sheet.rows) {
    if (row.kind !== 'data') continue;
    const v = row.cells[0]?.v;
    if (typeof v === 'number' && v >= 1 && v <= cases.length) counts[v - 1]! += 1;
  }
  return counts;
}

// ---------------------------------------------------------------------------
// measureKey
// ---------------------------------------------------------------------------

const MEASURE_TYPES: ReadonlySet<string> = new Set(['decimal', 'currency', 'percent']);

/** Whether `e` looks a value up in a table by a measure column (`lookup("t", amount, "x")`). */
function looksUpByMeasure(e: Expr, measureIds: ReadonlySet<string>): boolean {
  if (!isNode(e)) return false;
  if (e.op === 'lookup' && 'col' in e.key && measureIds.has(e.key.col)) return true;
  return exprChildren(e).some((c) => looksUpByMeasure(c, measureIds));
}

// ---------------------------------------------------------------------------
// The findings
// ---------------------------------------------------------------------------

/** The column ids an expression reads (a window's `by` / `order` columns included). */
function idsRead(e: Expr, out: Set<string>): Set<string> {
  if ('col' in e) out.add(e.col);
  else if (isNode(e)) {
    for (const c of exprChildren(e)) idsRead(c, out);
    if (e.op === 'window') {
      for (const id of e.by ?? []) out.add(id);
      for (const o of e.order ?? []) out.add(o.column);
    }
  }
  return out;
}

/** For each computed column, the output columns (positions) whose value it reaches: its own, and those of every computed column reading it. */
function outputsReached(rules: AnyRules): Map<string, number[]> {
  const reads = new Map(rules.transform.computed.map((c) => [c.id, idsRead(c.expr, new Set())] as const));
  const reaches = (from: string, target: string, seen: Set<string>): boolean => {
    if (from === target) return true;
    if (seen.has(from)) return false;
    seen.add(from);
    return [...(reads.get(from) ?? [])].some((id) => reaches(id, target, seen));
  };
  const out = new Map<string, number[]>();
  for (const c of rules.transform.computed) {
    const positions: number[] = [];
    rules.output.columns.forEach((col, i) => {
      if (col.from !== null && reaches(col.from, c.id, new Set())) positions.push(i);
    });
    out.set(c.id, positions);
  }
  return out;
}

export interface OverfitOptions {
  /**
   * The rows code can see, as the rules read them: the samples (and the loop's rows) on the server, every row of the example in the browser.
   * Null: the rows cannot be counted, so no case list is ever reported (a position needs no rows).
   */
  table: InputTable | null;
}

/**
 * Every rule of `rules` that copies particular rows of the example: one finding per output column and kind (a column is named once per kind,
 * whichever computed column it reads holds the shape). Only columns that have a rule and are not already reported as unsupported.
 */
export function overfitFindings(rules: AnyRules, opts: OverfitOptions): OverfitFinding[] {
  const inputIds = new Set(rules.input.columns.map((c) => c.id));
  const measureIds = new Set([...rules.input.columns, ...rules.transform.computed].filter((c) => MEASURE_TYPES.has(c.type)).map((c) => c.id));
  const positionIds = positionColumns(rules.transform.computed);
  const reached = outputsReached(rules);
  const findings: OverfitFinding[] = [];
  const seen = new Set<string>();
  const add = (kind: OverfitKind, id: string, cases?: number): void => {
    for (const out of reached.get(id) ?? []) {
      const header = rules.output.columns[out]!.header;
      if (seen.has(`${kind}\u0000${header}`)) continue;
      seen.add(`${kind}\u0000${header}`);
      findings.push({ kind, outputColumn: header, out, id, ...(cases !== undefined ? { cases } : {}) });
    }
  };
  for (const c of rules.transform.computed) {
    if (comparesPosition(c.expr, positionIds)) add('position', c.id);
    if (looksUpByMeasure(c.expr, measureIds)) add('measureKey', c.id);
    const cases = caseListShape(c.expr, inputIds);
    if (cases && opts.table) {
      const counts = caseCounts(rules, cases, opts.table);
      if (counts && counts.every((n) => n <= limits.learn.overfit.maxRowsPerCase)) add('caseList', c.id, cases.length);
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// What a finding becomes
// ---------------------------------------------------------------------------

/** The part of the problem message that says what was found (no value of any row: the guards' own words only). */
function whatWasFound(f: OverfitFinding): string {
  switch (f.kind) {
    case 'position':
      return 'it compares a row position (rowNumber or rank) with a constant';
    case 'caseList':
      return `it is a list of ${f.cases ?? 'many'} cases, each giving a constant to one or two rows; a real mapping is a value map or a lookup table`;
    case 'measureKey':
      return 'it looks values up by an amount, and the next file brings new amounts; a real mapping is keyed on a code or a category';
  }
}

/**
 * One `overfit` repair problem per output column (several findings on one column make one problem), in the plain words of the problem kind
 * (LEARN_PROMPT §4): this rule copies particular rows of the example; write a rule that holds for any row, or report the column as unsupported.
 */
export function overfitProblems(findings: readonly OverfitFinding[]): RepairProblem[] {
  const byColumn = new Map<string, OverfitFinding[]>();
  for (const f of findings) byColumn.set(f.outputColumn, [...(byColumn.get(f.outputColumn) ?? []), f]);
  return [...byColumn.entries()].map(([header, fs]) => ({
    kind: 'overfit',
    out: fs[0]!.out,
    message: `Column "${header}": this rule copies particular rows of the example (${fs.map(whatWasFound).join('; ')}); write a rule that holds for any row, or report the column as unsupported.`,
  }));
}

/** Every id the rules mention outside the computed column `id` itself (its readers, filters, sort, group, validations, output ...). */
function referencedElsewhere(rules: AnyRules, id: string): boolean {
  const rest = { ...rules, transform: { ...rules.transform, computed: rules.transform.computed.filter((c) => c.id !== id) } };
  const text = JSON.stringify(rest);
  return text.includes(JSON.stringify(id));
}

/**
 * The honest fallback: every output column with a finding is reported as unsupported by code (`from: null`, reason `overfit`: "needs your
 * input", like an `externalData` column the AI step reports itself), and the computed columns nothing reads any more are taken out, so the
 * rows the rule copied are never shown or saved as a rule. Everything else is kept as it is. The rules themselves when there is no finding.
 */
export function withOverfitFallback<R extends AnyRules>(rules: R, findings: readonly OverfitFinding[]): R {
  if (findings.length === 0) return rules;
  const headers = new Set(findings.map((f) => f.outputColumn));
  const columns = rules.output.columns.map((c) => (headers.has(c.header) ? { ...c, from: null } : c));
  const unsupported = [
    ...rules.unsupported,
    ...[...headers].filter((h) => !rules.unsupported.some((u) => u.outputColumn === h)).map((outputColumn) => ({ outputColumn, reasonCode: OVERFIT_REASON })),
  ];
  let next = { ...rules, output: { ...rules.output, columns }, unsupported } as R;
  // The computed columns the dropped rules read, when nothing else reads them now (one at a time: a helper may free another).
  const candidates = new Set(findings.map((f) => f.id));
  for (let changed = true; changed; ) {
    changed = false;
    for (const c of next.transform.computed) {
      if (!candidates.has(c.id) || referencedElsewhere(next, c.id)) continue;
      for (const id of idsRead(c.expr, new Set())) candidates.add(id);
      next = { ...next, transform: { ...next.transform, computed: next.transform.computed.filter((x) => x.id !== c.id) } } as R;
      changed = true;
      break;
    }
  }
  // ... and the lookup tables nothing looks up any more (a table of the example's amounts holds this file's rows).
  const tables = next.transform.tables;
  if (tables && tables.length > 0) {
    const text = JSON.stringify({ ...next, transform: { ...next.transform, tables: [] } });
    const used = tables.filter((t) => text.includes(`"table":${JSON.stringify(t.name)}`));
    if (used.length < tables.length) next = { ...next, transform: { ...next.transform, tables: used } } as R;
  }
  return next;
}
