// A one-time edit or a rule? (owner decision 2026-10-05; SPEC 8.11, 9.2, 21 v12 item 20). A row of an example output is sometimes edited by
// hand, once. The AI step then tends to write a part of a rule that exists only to reproduce that row - `if(order = "ORD-1052", 0, ...)` -
// and the check on every row cannot tell: the part DOES reproduce the row. Code can count, though. For the rules as applied (after code
// filled them, `fillParams`), on every row of the example, how many rows each part of a rule explains:
//   - each branch of an `if` / `switch`: the rows where it is the one taken AND the output column matches the example there;
//   - each entry of a lookup table, each entry of a value map: the rows whose key it is, the output matching;
//   - each value of a value list in a condition (`oneOf`, an or-chain of `=`): the rows holding it where the branch is taken, matching.
// A part that explains exactly one row, and applies to no other, singled out by something unique to that row in the example - an ID (a
// column that is a key of the example), an exact amount or date no other row has, its position in the file - is a question for the user:
// "Row 54: Discount is 0 instead of Amount x 0.1. A one-time change, or a rule we missed?" (the Result screen). The answers: one-time takes
// the part out (`withoutRulePart`, shared) so the column's remaining rule applies to every row, and the row is listed as one that does not
// follow the rule; a rule keeps it; "not sure" keeps it with a check (`oneTimeCheck`) that flags a later row the part applies to.
//
// DECISION (the ask rule, conservative: questions must stay rare): only the three ways of singling out a row above, each judged on every
// row of the example - an ID is a column that is a key of the example read as text (every row has a value, no two the same); an amount (a
// decimal, currency or percent column) or a date counts only when no other row has that value; a position is a comparison of a whole-file
// `rowNumber()` / `rank()` with a constant. A categorical value that merely appears once ("Status = On hold" on one row), a threshold that
// happens to pick one row (`amount > 2500`) or a combination of those is a plausible real rule, and is not asked (learn-v8's
// `if(and(customer = "Soylent Co", amount > 2500), 0, ...)` for discount-hand-edited is not). A branch is singled out by one of the
// conjuncts of its condition; a list value, a lookup key or a value-map entry by its own column. At most `limits.learn.oneTimer.maxQuestions`
// per learn, in output order; a column with more such parts than fit is not a few one-time edits - it asks nothing and is left to the
// overfitting guards (`overfit.ts`: a memorized case list, a table of amounts fall back to "needs your input", never 13 or 150 questions).
// DECISION (the guards, `learn/flow.ts`): the one guard a question replaces is `position`, for a column whose every position condition is
// a part asked here (the row-position branch: `if(rowNumber() = 54, 0, ...)` - the user decides, no repair is spent on it). The API leaves a
// position condition that names exact rows to the browser (`OverfitFinding.rowExact`): only every row of the example can tell.
//
// The second kind of question (owner amendment, 2026-10-06: "a list copied from the example is asked at Save"): a column whose value comes
// from a lookup table or a value map keyed on a column that takes a different value on every row the list applies to. Code's fill completes
// such a list from every row, and a copied list always reproduces the example it was copied from - the guards catch one keyed on an amount
// (`measureKey`), not one keyed on an account or an order number. Such a list is sometimes exactly right (recurring customers) and
// sometimes useless (order numbers); code cannot tell which, so the user is asked, neutrally - at Save only, before the rules are stored
// (owner decision, same day: fewer clicks; the web app's "Save this format?"). `copiedLists` finds them. "Keep it" keeps the list as it is (a
// new key is flagged at run time, as for any lookup); "Save without it" takes the column's rule out - the column needs the user's input
// (`withoutCopiedList`, shared).
//
// Generalized (docs/proposals/saved-format-contents.md section 3; owner, 2026-10-06; SPEC 21 v15): a LIST is an output column whose value
// comes from a lookup, a value map or a chain of cases whose entries are fixed values keyed on one input column - whatever shape the AI wrote
// (one entry per key, or grouped by label: `oneOf(product, "card", "computer", "screen") -> "Electronics"`), whether its key repeats or not.
// Nobody can deduce it from the input, and a saved format would keep it, so it is retried once for logic (`listRetryProblems`, the learn
// flow) and, if it stays, asked about at Save. The copied list above - one row per entry, keyed on a column unique per row - is one case of
// it, with the same question. NOT a list: a small vocabulary (a translation of a category column with few values: at most
// `limits.learn.lists.vocabulary.maxEntries` entries, each giving its value to at least `minRowsPerEntry` rows, keyed on a column that is not
// an identifier - the column classification, `classify.ts`), and the one-time edits above (fewer than `limits.learn.lists.minEntries` entries).
//
// Real values (the question shows the row's own values) - this runs in the browser and the eval, never on the server, and nothing here is
// ever sent. Pure and synchronous, like the rest of this package.
import {
  checkRules,
  limits,
  withoutRulePart,
  type ColumnType,
  type CopiedListRule,
  type Expr,
  type ExprConstValue,
  type ExprNode,
  type LearnResult,
  type PayloadCell,
  type RepairProblem,
  type RulePart,
  type Rules,
  type TableCellValue,
  type Validation,
} from '@formatai/shared';
import { typeCheck } from '../check/typeCheck';
import { deepEqual } from '../registry/deepEqual';
import { exprChildren } from '../pipeline/v1/expr';
import { mapHeaders } from '../pipeline/v1/normalize';
import { normText } from '../pipeline/v1/values';
import type { OutCell } from '../types';
import { isoOfSerial } from './analyze/cells';
import type { PairAnalysis } from './analyze';
import { probeCellValue, probeKeyText, probeTruthy, runWithProbes, valueListOf, type ProbedRun, type RunProbe } from './fillParams';
import { atomsOf, casesOf, comparesPosition, overfitFindings, positionColumns, type OverfitFinding } from './overfit';
import { cellMatchesExample, exampleCellAt } from './verify';
import { inputClass } from './classify';

/** What singles the one row out: an ID (a key column of the example), an exact amount or date no other row has, its position in the file. */
export type OneTimeBy = 'id' | 'amount' | 'date' | 'position';

/** One part of the rules and the rows of the example it explains (`partSupport`). */
export interface PartSupport {
  part: RulePart;
  /** The output column whose value the part gives: its position and header. */
  out: number;
  header: string;
  /** The computed column the part is in (a value-map entry: none). */
  computed?: string;
  /** Rows of the example (aligned rows) the part applies to: its branch taken, its key or value on the row. */
  taken: number;
  /** Of those, the rows whose output cell matches the example: the rows the part explains. */
  support: number;
  /** The first rows it explains (aligned row indexes, `analysis.alignment.rows`), at most two. */
  explains: number[];
  /** A part that explains exactly one row and applies to no other: what singles that row out, when it is unique to it (else absent). */
  by?: OneTimeBy;
  /** `by` id / amount / date: the input column (header) that singles it out. */
  byColumn?: string;
}

/**
 * A question: "Row N: <column> is <value> instead of <the rest of its rule>. A one-time change, or a rule we missed?" (the first kind;
 * DECISION: `kind` is left out, so a question reads exactly as before the second kind came).
 */
export interface OneTimeRowQuestion {
  kind?: 'row';
  /** The output column: position and header. */
  out: number;
  header: string;
  part: RulePart;
  /** The row, as the live check numbers rows (1-based, the example output sheet's own row). */
  row: number;
  /** Its input row's number in the input file (1-based), for showing the row's own values. */
  inputRow: number;
  by: OneTimeBy;
  /** `by` id / amount / date: the input column that singles the row out, and its value in that row (a real date as ISO text). */
  byColumn?: string;
  key?: PayloadCell;
  /** The example's value in that row (what the part gives) and what the column's rule gives there without the part. Real values. */
  value: PayloadCell;
  rest: PayloadCell;
  /**
   * What "Not sure" adds (SPEC 8.8 `sameAs` with `oneTime`): the column's rule without the part, so a later row the part gives another value
   * is flagged. Null when no check can say it (the rest of the rule reads other rows, a value map changes the column, a value-map entry).
   */
  check: Validation | null;
}

/**
 * The second kind (owner amendment, 2026-10-06; generalized by docs/proposals/saved-format-contents.md section 3), asked at Save: "<column> is a
 * list of <entries> fixed values taken from your example (one for each <key column>). Keep this list in the saved format?" What the dialog
 * needs, and no cell value. (DECISION: the kind keeps its name - a list copied from the example is one case of it - so the eval's
 * `answers.copiedList` and the save paths of #55 stay as they are.)
 */
export interface CopiedListQuestion {
  kind: 'copiedList';
  /** The output column: position and header. */
  out: number;
  header: string;
  /** The input column (header) the list is keyed on. */
  keyColumn: string;
  /** The entries of the list the example uses: each gives at least one row of the example its value (a chain: its named values). */
  entries: number;
  /** The list - a lookup table, a value map, or a chain of cases - for the answer "Save without it" (`withoutCopiedList`, shared). */
  list: CopiedListRule;
}

export type OneTimeQuestion = OneTimeRowQuestion | CopiedListQuestion;

export interface OneTimeResult {
  questions: OneTimeQuestion[];
  /** Columns with one-row parts that were not asked: more than the questions left (left to the overfitting guards). */
  handedOff: { header: string; parts: number }[];
}

export interface OneTimeOptions {
  /** Completion mode: only these output columns (the ones the AI step was asked for; the rest are the user's own rules). */
  columns?: ReadonlySet<string>;
  /** Completion mode: the user's own rules - a lookup or a value map they wrote (its table, its computed column, its map) is never asked about. */
  fixed?: LearnResult | Rules;
  /** Default `limits.learn.oneTimer.maxQuestions`. */
  maxQuestions?: number;
  /** A list is asked about from this many entries. Default `limits.learn.lists.minEntries`. */
  minListEntries?: number;
}

const MEASURES: ReadonlySet<ColumnType> = new Set(['decimal', 'currency', 'percent']);

const isNode = (e: Expr): e is ExprNode => 'op' in e;

// ---------------------------------------------------------------------------
// Where the parts are
// ---------------------------------------------------------------------------

/** What has to hold on a row for a part's branch to be the one taken (as `fillParams`' lookup sites). */
interface Step {
  expr: Expr;
  want: 'truthy' | 'falsy' | 'empty';
}

type Site =
  | { kind: 'branch'; computed: string; out: number; path: Step[]; when: Expr; then: Expr }
  | { kind: 'list'; computed: string; out: number; path: Step[]; arg: Expr; values: ExprConstValue[] }
  | { kind: 'lookup'; computed: string; out: number; path: Step[]; table: string; key: Expr }
  | { kind: 'valueMap'; column: string; out: number; map: Record<string, string> };

/** The value lists a condition holds as a conjunct (the condition itself, or one of an `and`): true on a row means the list holds there. */
function listsIn(cond: Expr): { arg: Expr; values: ExprConstValue[] }[] {
  if (!isNode(cond)) return [];
  if (cond.op === 'and') return cond.args.flatMap(listsIn);
  const list = valueListOf(cond);
  // (One `=` is no list: the branch it picks is the part.)
  return list && list.values.length >= 2 ? [{ arg: list.arg, values: list.values }] : [];
}

/** The parts of one computed column's expression, with what must hold for each to be reached (`if` / `switch` / `coalesce`). */
function sitesIn(e: Expr, path: Step[], at: { computed: string; out: number }, out: Site[]): void {
  if (!isNode(e)) return;
  switch (e.op) {
    case 'if': {
      const taken = [...path, { expr: e.cond, want: 'truthy' as const }];
      out.push({ kind: 'branch', ...at, path, when: e.cond, then: e.then });
      for (const l of listsIn(e.cond)) out.push({ kind: 'list', ...at, path: taken, ...l });
      sitesIn(e.then, taken, at, out);
      sitesIn(e.else, [...path, { expr: e.cond, want: 'falsy' }], at, out);
      return;
    }
    case 'switch': {
      const before: Step[] = [];
      for (const cs of e.cases) {
        const reach = [...path, ...before];
        const taken = [...reach, { expr: cs.when, want: 'truthy' as const }];
        out.push({ kind: 'branch', ...at, path: reach, when: cs.when, then: cs.then });
        for (const l of listsIn(cs.when)) out.push({ kind: 'list', ...at, path: taken, ...l });
        sitesIn(cs.then, taken, at, out);
        before.push({ expr: cs.when, want: 'falsy' });
      }
      sitesIn(e.else, [...path, ...before], at, out);
      return;
    }
    case 'coalesce':
      e.args.forEach((a, i) => sitesIn(a, [...path, ...e.args.slice(0, i).map((x) => ({ expr: x, want: 'empty' as const }))], at, out));
      return;
    case 'lookup':
      out.push({ kind: 'lookup', ...at, path, table: e.table, key: e.key });
      return;
    // A condition in a value's place is not a branch, and an across-row function reads other rows: neither holds a part.
    case 'and':
    case 'or':
    case 'not':
    case 'eq':
    case 'ne':
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte':
    case 'oneOf':
    case 'isEmpty':
    case 'notEmpty':
    case 'startsWith':
    case 'endsWith':
    case 'contains':
    case 'window':
      return;
    default:
      for (const ch of exprChildren(e)) sitesIn(ch, path, at, out);
  }
}

/**
 * Every part of the rules whose value an output column shows: the parts of a computed column an output column reads directly (DECISION: a
 * helper column's parts are not counted, and neither are those of a column a value map changes - its value is then the map's), and the
 * entries of a value map on a column an output column reads (only map on that column).
 */
function sitesOf(rules: LearnResult): Site[] {
  const sites: Site[] = [];
  const mapped = new Set(rules.transform.valueMaps.map((m) => m.column));
  for (const c of rules.transform.computed) {
    const out = rules.output.columns.findIndex((o) => o.from === c.id && o.agg === undefined);
    if (out < 0 || mapped.has(c.id)) continue;
    sitesIn(c.expr, [], { computed: c.id, out }, sites);
  }
  rules.transform.valueMaps.forEach((vm, i) => {
    if (rules.transform.valueMaps.some((m, j) => j !== i && m.column === vm.column)) return;
    const out = rules.output.columns.findIndex((o) => o.from === vm.column && o.agg === undefined);
    if (out >= 0) sites.push({ kind: 'valueMap', column: vm.column, out, map: vm.map });
  });
  return sites;
}

// ---------------------------------------------------------------------------
// Counting
// ---------------------------------------------------------------------------

/** The probes of one run, shared by every site that needs the same expression. */
class Probes {
  readonly list: RunProbe[] = [];
  private readonly at = new Map<string, number>();
  constructor(private readonly after: string | null) {}
  add(expr: Expr, type: ColumnType): number {
    const key = `${type}\u0000${JSON.stringify(expr)}`;
    let i = this.at.get(key);
    if (i === undefined) {
      i = this.list.push({ after: this.after, expr, type }) - 1;
      this.at.set(key, i);
    }
    return i;
  }
}

function stepHolds(run: ProbedRun, k: number, step: { at: number; want: Step['want'] }): boolean {
  const cell = run.rows[k]?.cells[run.at[step.at]!];
  if (step.want === 'empty') return cell === undefined || cell.v === undefined || cell.v === null;
  return probeTruthy(cell) === (step.want === 'truthy');
}

/** A key or a value as the engine compares it (`normText` of its text); null for an empty one. */
function textKey(v: TableCellValue | ExprConstValue | undefined): string | null {
  if (v === null || v === undefined || typeof v === 'boolean') return null;
  return normText(String(v));
}

function probeKey(run: ProbedRun, k: number, at: number): string | null {
  const t = probeKeyText(run.rows[k]?.cells[run.at[at]!]);
  return t === null ? null : normText(t);
}

interface Counter {
  part: RulePart;
  out: number;
  computed?: string;
  taken: Set<number>;
  explains: Set<number>;
  /** list / lookup / value-map parts: the rows holding the value or key at all (wherever the branch goes), for "no other row has it". */
  holders: Set<number>;
  /** The expression whose value singles a row out (a list's argument, a lookup's key, the mapped column). */
  keyExpr?: Expr;
}

/** The input column an expression is (a plain `col` of a declared input column), or undefined. */
function inputColumnOf(rules: LearnResult, e: Expr): { id: string; header: string; type: ColumnType; index: number } | undefined {
  if (!('col' in e)) return undefined;
  const index = rules.input.columns.findIndex((c) => c.id === e.col);
  const c = rules.input.columns[index];
  return c ? { id: c.id, header: c.header, type: c.type, index } : undefined;
}

/**
 * How many rows of the example each part of the rules explains (see the file comment), on the rules as they are (call it after `fillParams`).
 * One run of the rules with every condition, key and value read on each row; a second, small one for the exact amounts and dates a branch
 * names. Empty when the rules cannot run, or for a summary output (one row per group: counted per group, never per row).
 */
export function partSupport(rules: LearnResult, analysis: PairAnalysis): PartSupport[] {
  if (rules.transform.group !== undefined && !rules.transform.group.showDetailRows) return [];
  if (analysis.alignment.rows.length === 0) return [];
  const sites = sitesOf(rules);
  if (sites.length === 0) return [];
  const last = rules.transform.computed[rules.transform.computed.length - 1]?.id ?? null;
  const probes = new Probes(last);
  const steps = (path: Step[]): { at: number; want: Step['want'] }[] => path.map((s) => ({ at: probes.add(s.expr, s.want === 'empty' ? 'text' : 'boolean'), want: s.want }));
  const plan = sites.map((s) => {
    switch (s.kind) {
      case 'branch':
        return { s, path: steps(s.path), when: probes.add(s.when, 'boolean') };
      case 'list':
      case 'lookup':
        return { s, path: steps(s.path), key: probes.add(s.kind === 'list' ? s.arg : s.key, 'text') };
      case 'valueMap':
        return { s, path: [], key: probes.add({ col: s.column }, 'text') };
    }
  });
  const run = runWithProbes(rules, analysis, probes.list);
  if (!run) return [];

  const counters = new Map<string, Counter>();
  const counter = (part: RulePart, out: number, computed?: string, keyExpr?: Expr): Counter => {
    const id = JSON.stringify(part);
    let c = counters.get(id);
    if (!c) {
      c = { part, out, ...(computed !== undefined ? { computed } : {}), taken: new Set(), explains: new Set(), holders: new Set(), ...(keyExpr ? { keyExpr } : {}) };
      counters.set(id, c);
    }
    return c;
  };
  const matches = (k: number, out: number): boolean => cellMatchesExample(analysis, k, out, run.rows[k]?.cells[out]);
  const tables = new Map((rules.transform.tables ?? []).map((t) => [t.name, t] as const));

  for (const p of plan) {
    const s = p.s;
    if (s.kind === 'branch') {
      const c = counter({ kind: 'branch', computed: s.computed, when: s.when, then: s.then }, s.out, s.computed);
      run.rows.forEach((row, k) => {
        if (!row || !p.path.every((st) => stepHolds(run, k, st)) || !probeTruthy(row.cells[run.at[(p as { when: number }).when]!])) return;
        c.taken.add(k);
        if (matches(k, s.out)) c.explains.add(k);
      });
      continue;
    }
    const keyAt = (p as { key: number }).key;
    // Each value (list), each key (lookup table), each entry (value map), by the text the engine compares it by.
    const parts = new Map<string, Counter>();
    if (s.kind === 'list') {
      for (const v of s.values) {
        const t = textKey(v);
        if (t !== null) parts.set(t, counter({ kind: 'listValue', computed: s.computed, arg: s.arg, value: v }, s.out, s.computed, s.arg));
      }
    } else if (s.kind === 'lookup') {
      for (const r of tables.get(s.table)?.rows ?? []) {
        const t = textKey(r[0]);
        if (t !== null && !parts.has(t)) parts.set(t, counter({ kind: 'lookupEntry', table: s.table, key: r[0] ?? null }, s.out, s.computed, s.key));
      }
    } else {
      for (const [from, to] of Object.entries(s.map)) {
        const t = textKey(from);
        // (An entry that writes the value it reads changes nothing: no part.)
        if (t !== null && !parts.has(t) && t !== textKey(to)) parts.set(t, counter({ kind: 'valueMapEntry', column: s.column, from }, s.out, undefined, { col: s.column }));
      }
    }
    run.rows.forEach((row, k) => {
      if (!row) return;
      const t = probeKey(run, k, keyAt);
      const c = t === null ? undefined : parts.get(t);
      if (!c) return;
      c.holders.add(k);
      if (!p.path.every((st) => stepHolds(run, k, st))) return;
      c.taken.add(k);
      if (matches(k, s.out)) c.explains.add(k);
    });
  }

  const support: PartSupport[] = [...counters.values()].map((c) => ({
    part: c.part,
    out: c.out,
    header: rules.output.columns[c.out]?.header ?? '',
    ...(c.computed !== undefined ? { computed: c.computed } : {}),
    taken: c.taken.size,
    support: c.explains.size,
    explains: [...c.explains].sort((a, b) => a - b).slice(0, 2),
  }));

  // What singles the one row out, for the parts that explain one row and apply to no other.
  const idLike = idLikeColumns(rules, analysis);
  const exact: { s: PartSupport; at: number; by: 'amount' | 'date'; header: string }[] = [];
  const exactProbes = new Probes(last);
  const positions = positionColumns(rules.transform.computed);
  for (const s of support) {
    if (s.taken !== 1 || s.support !== 1) continue;
    const c = counters.get(JSON.stringify(s.part))!;
    if (s.part.kind === 'branch') {
      const conjuncts = conjunctsOf(s.part.when);
      if (conjuncts.some((x) => comparesPosition(x, positions))) {
        s.by = 'position';
        continue;
      }
      for (const x of conjuncts) {
        const eq = equalityOf(x);
        const col = eq ? inputColumnOf(rules, eq.arg) : undefined;
        if (!eq || !col) continue;
        if (idLike.has(col.id)) {
          s.by = 'id';
          s.byColumn = col.header;
          break;
        }
        const by = MEASURES.has(col.type) ? 'amount' : col.type === 'date' ? 'date' : null;
        if (by) {
          exact.push({ s, at: exactProbes.add(x, 'boolean'), by, header: col.header });
          break;
        }
      }
      continue;
    }
    // A list value, a lookup key, a value-map entry: its column, and how many rows hold the value at all. (A list of row positions -
    // `oneOf(rowNumber(), 54, 99)` - names its row by its position.)
    if (s.part.kind === 'listValue' && comparesPosition({ op: 'oneOf', arg: s.part.arg, values: [s.part.value] }, positions)) {
      s.by = 'position';
      continue;
    }
    const col = c.keyExpr ? inputColumnOf(rules, c.keyExpr) : undefined;
    if (!col || c.holders.size !== 1) continue;
    if (idLike.has(col.id)) {
      s.by = 'id';
      s.byColumn = col.header;
    } else if (MEASURES.has(col.type) || col.type === 'date') {
      s.by = col.type === 'date' ? 'date' : 'amount';
      s.byColumn = col.header;
    }
  }
  // An exact amount or date a branch names: no other row of the example may have it.
  if (exact.length > 0) {
    const second = runWithProbes(rules, analysis, exactProbes.list);
    if (second) {
      for (const e of exact) {
        const holders = second.rows.filter((row) => row && probeTruthy(row.cells[second.at[e.at]!])).length;
        if (holders === 1) {
          e.s.by = e.by;
          e.s.byColumn = e.header;
        }
      }
    }
  }
  return support;
}

/** The conjuncts of a condition (an `and` flattened). */
function conjunctsOf(e: Expr): Expr[] {
  return isNode(e) && e.op === 'and' ? e.args.flatMap(conjunctsOf) : [e];
}

/** `x = constant` (either side) or `oneOf(x, constant)`: the expression compared and the constant (a literal or a fixed date). */
function equalityOf(e: Expr): { arg: Expr } | null {
  if (!isNode(e)) return null;
  const constant = (x: Expr): boolean => 'const' in x || (isNode(x) && x.op === 'dateLiteral');
  if (e.op === 'eq') {
    const [a, b] = e.args;
    if (constant(b) && !constant(a)) return { arg: a };
    if (constant(a) && !constant(b)) return { arg: b };
    return null;
  }
  if (e.op === 'oneOf' && e.values.length === 1) return { arg: e.arg };
  return null;
}

/**
 * The input columns that identify a row of the example: a key of it (every row has a value, no two the same - the profile's `key`), read as
 * text (an ID or a text key; a number or a date that happens to be unique is an amount or a date, judged by its value instead).
 */
function idLikeColumns(rules: LearnResult, analysis: PairAnalysis): Set<string> {
  const src = mapHeaders(rules.input.columns, analysis.input.headers).src;
  const ids = new Set<string>();
  rules.input.columns.forEach((c, ci) => {
    const p = analysis.input.profile[src[ci] ?? -1];
    if (p && p.key && (p.type === 'idLike' || p.type === 'text') && (c.type === 'idLike' || c.type === 'text')) ids.add(c.id);
  });
  return ids;
}

// ---------------------------------------------------------------------------
// The questions
// ---------------------------------------------------------------------------

/** A probe or output cell as the check reads it: a real date as its ISO text. */
function payloadOf(cell: OutCell | undefined): PayloadCell {
  if (cell === undefined || cell.v === undefined || cell.v === null) return null;
  if (cell.isDate === true && typeof cell.v === 'number') return isoOfSerial(cell.v);
  return cell.v;
}

/**
 * The questions to ask about the rules (call it on the rules as applied, after `fillParams`): the parts that explain exactly one row of the
 * example, singled out by something unique to it, at most `maxQuestions`, column by column in output order; a column with more than fit is
 * handed off (no question). A part whose row the rest of the rule gives the same value is not asked (nothing would change). Then the copied
 * lists (`copiedLists`), one per column at most, whose entries are no row question of their own; all in output order.
 */
export function oneTimeQuestions(rules: LearnResult, analysis: PairAnalysis, opts: OneTimeOptions = {}): OneTimeResult {
  const lists = copiedLists(rules, analysis, opts);
  const askable = oneTimeParts(rules, analysis, opts, lists);
  const src = mapHeaders(rules.input.columns, analysis.input.headers).src;
  /** The input cell of column `header` (as the rules declare it) in input row `inRow`, as the example has it. */
  const inputCell = (header: string, inRow: number): PayloadCell => {
    const at = src[rules.input.columns.findIndex((c) => c.header === header)] ?? -1;
    const cell = analysis.input.rows[inRow]?.[at];
    if (!cell || cell.v === null) return null;
    if (typeof cell.v === 'number' && cell.isDate) return isoOfSerial(Math.trunc(cell.v) + (analysis.input.date1904 ? 1462 : 0));
    return cell.v;
  };
  const rows = askable.asked.map((s): OneTimeQuestion => {
    const k = s.explains[0]!;
    const aligned = analysis.alignment.rows[k]!;
    return {
      out: s.out,
      header: s.header,
      part: s.part,
      row: (analysis.output.dataRows[aligned.out] ?? 0) + 1,
      inputRow: analysis.input.rowNumbers[aligned.in] ?? aligned.in + 1,
      by: s.by!,
      ...(s.byColumn !== undefined ? { byColumn: s.byColumn, key: inputCell(s.byColumn, aligned.in) } : {}),
      value: exampleCellAt(analysis, k, s.out).v,
      rest: s.rest,
      check: oneTimeCheck(rules, s),
    };
  });
  // (A stable sort: the row questions keep their order, a column's list question comes after its row questions.)
  const questions = [...rows, ...lists].sort((a, b) => a.out - b.out);
  return { questions, handedOff: askable.handedOff };
}

/** Whether a part is an entry of one of the copied lists asked about (that question covers it). */
function inCopiedList(part: RulePart, lists: readonly CopiedListQuestion[]): boolean {
  return lists.some((l) => {
    switch (l.list.kind) {
      case 'lookup':
        return part.kind === 'lookupEntry' && part.table === l.list.table;
      case 'valueMap':
        return part.kind === 'valueMapEntry' && part.column === l.list.column;
      case 'cases':
        return (part.kind === 'branch' || part.kind === 'listValue') && part.computed === l.list.computed;
    }
  });
}

/**
 * The parts to ask about: those that explain one row singled out by something unique to it, column by column in output order while
 * questions are left (a column with more than fit is handed off whole), and only where the rest of the column's rule gives that row another
 * value (one run of the rules without the part, each: `rest`). The learn flow uses this to decide which `position` findings a question replaces.
 * The entries of a copied list asked about (`lists`) are not parts here: the list's own question covers them.
 */
export function oneTimeParts(
  rules: LearnResult,
  analysis: PairAnalysis,
  opts: OneTimeOptions = {},
  lists: readonly CopiedListQuestion[] = [],
): { asked: (PartSupport & { rest: PayloadCell })[]; handedOff: OneTimeResult['handedOff'] } {
  const max = opts.maxQuestions ?? limits.learn.oneTimer.maxQuestions;
  // DECISION: one question per row of a column - a branch that applies to that row alone over the value of its own list that names it
  // (`if(oneOf(rowNumber(), 54, 99), ...)` with no row 99: the branch is the part; taken out, nothing of it is left for a later file).
  const seenRow = new Set<string>();
  const single = partSupport(rules, analysis).filter((s) => {
    if (s.by === undefined || (opts.columns !== undefined && !opts.columns.has(s.header))) return false;
    if (inCopiedList(s.part, lists)) return false;
    const key = `${s.out}\u0000${s.explains[0]}`;
    if (seenRow.has(key)) return false;
    seenRow.add(key);
    return true;
  });
  const byColumn = new Map<number, PartSupport[]>();
  for (const s of single) byColumn.set(s.out, [...(byColumn.get(s.out) ?? []), s]);
  const chosen: PartSupport[] = [];
  const handedOff: OneTimeResult['handedOff'] = [];
  for (const out of [...byColumn.keys()].sort((a, b) => a - b)) {
    const parts = byColumn.get(out)!;
    if (chosen.length + parts.length > max) handedOff.push({ header: parts[0]!.header, parts: parts.length });
    else chosen.push(...parts);
  }
  const asked: (PartSupport & { rest: PayloadCell })[] = [];
  for (const s of chosen) {
    const k = s.explains[0]!;
    const without = withoutRulePart(rules, s.part);
    const run = without ? runWithProbes(without, analysis) : null;
    const cell = run?.rows[k]?.cells[s.out];
    // (Taken out, the part changes nothing on its row: there is nothing to ask.)
    if (!run || cellMatchesExample(analysis, k, s.out, cell)) continue;
    asked.push({ ...s, rest: payloadOf(cell) });
  }
  return { asked, handedOff };
}

/**
 * The output columns (headers) whose `position` findings (`overfit.ts`) a one-time question replaces: every finding on the column is a
 * position condition, and with the column's asked parts taken out (`oneTimeParts`, on the rules as applied) none is left. Those rows go to
 * the user, not to a repair.
 */
export function questionedPositions(rules: LearnResult, analysis: PairAnalysis, findings: readonly OverfitFinding[], columns?: ReadonlySet<string> | null): Set<string> {
  const headers = new Set(findings.filter((f) => f.kind === 'position').map((f) => f.outputColumn));
  for (const f of findings) if (f.kind !== 'position') headers.delete(f.outputColumn);
  const waived = new Set<string>();
  if (headers.size === 0) return waived;
  const { asked } = oneTimeParts(rules, analysis, columns ? { columns } : {});
  for (const header of headers) {
    const parts = asked.filter((s) => s.header === header);
    if (parts.length === 0) continue;
    let without: LearnResult | null = rules;
    for (const s of parts) without = without && withoutRulePart(without, s.part);
    if (!without) continue;
    if (overfitFindings(without, { table: null }).some((f) => f.kind === 'position' && f.outputColumn === header)) continue;
    waived.add(header);
  }
  return waived;
}

// ---------------------------------------------------------------------------
// A list of fixed values (owner amendment, 2026-10-06; generalized by docs/proposals/saved-format-contents.md section 3)
// ---------------------------------------------------------------------------

/**
 * The lists to ask about (call it on the rules as applied, after `fillParams`; see the file header). An output column is a list when its
 * value comes from
 *   - a lookup table or a value map (one code filled or the AI step wrote) keyed on a plain input column, where the list applies (its branch
 *     taken, a key on the row), or
 *   - a computed column it shows that is a chain of constants (`switch` / nested `if`, a constant else) whose every atom (`atomsOf`: an `or`
 *     disjunct, a `oneOf` value) is an equality of ONE plain input column with a value - one entry per key, or grouped by label
 *     (`switch(oneOf(product, "card", "computer"), "Electronics", ...)`): the same list written out;
 * and it has at least `minListEntries` entries the example uses (an entry that gives at least one row of the example its value), unless it is
 * a small vocabulary: at most `limits.learn.lists.vocabulary.maxEntries` entries, each giving its value to at least `minRowsPerEntry` rows,
 * keyed on an input column that is not an identifier (the column classification, `classify.ts`). One question
 * per column at most (its list with the most entries), in output order.
 *
 * DECISIONS (conservative: code asks only what it can say plainly):
 *  - the key is a plain input column of the rules (the question names it); a key worked out by an expression is not asked about;
 *  - a lookup or a value map keyed on an amount (a decimal, currency or percent column) is the guards' (`measureKey`: one repair, then "needs
 *    your input"); a chain on an amount column is no guard's, and is asked like any other;
 *  - a chain's else is a constant (#55): a chain whose else is a rule is that rule with exceptions - the one-time edits' and the guards';
 *  - completion mode: only the columns the AI step was asked for (`columns`), and never a lookup or a value map the user wrote (`fixed`: the
 *    same computed column, a table of the same name, a value map on the same column);
 *  - the copied list of #55 (a key unique per row, one row per entry) is a list whatever its size from `minListEntries` (6) on: no entry gives
 *    two rows their value, so it is never a vocabulary;
 *  - not counted against `limits.learn.oneTimer.maxQuestions` (that budget is for the one-row parts; a list is one question for a whole
 *    column), and the list's entries are no one-row parts of their own (`oneTimeParts`).
 * Empty for a summary output (one row per group), or when the rules cannot run.
 */
export function copiedLists(rules: LearnResult, analysis: PairAnalysis, opts: OneTimeOptions = {}): CopiedListQuestion[] {
  if (rules.transform.group !== undefined && !rules.transform.group.showDetailRows) return [];
  if (analysis.alignment.rows.length === 0) return [];
  const min = opts.minListEntries ?? limits.learn.lists.minEntries;
  const vocabulary = limits.learn.lists.vocabulary;
  const fixed = opts.fixed;
  const tables = new Map((rules.transform.tables ?? []).map((t) => [t.name, t] as const));
  const src = mapHeaders(rules.input.columns, analysis.input.headers).src;
  /** The key column is an identifier (the column classification, `classify.ts`). */
  const identifier = (index: number): boolean => inputClass(analysis, src[index] ?? -1) === 'identifier';
  const theirs = (s: Extract<Site, { kind: 'lookup' | 'valueMap' }>): boolean => {
    if (!fixed) return false;
    if (s.kind === 'valueMap') return fixed.transform.valueMaps.some((m) => m.column === s.column);
    const mine = rules.transform.computed.find((c) => c.id === s.computed);
    return (fixed.transform.tables ?? []).some((t) => t.name === s.table) || fixed.transform.computed.some((c) => c.id === s.computed && deepEqual(c.expr, mine?.expr));
  };
  const candidates = sitesOf(rules).flatMap((s) => {
    if (s.kind !== 'lookup' && s.kind !== 'valueMap') return [];
    const header = rules.output.columns[s.out]?.header ?? '';
    if (opts.columns !== undefined && !opts.columns.has(header)) return [];
    const keyExpr: Expr = s.kind === 'lookup' ? s.key : { col: s.column };
    const key = inputColumnOf(rules, keyExpr);
    if (!key || MEASURES.has(key.type) || theirs(s)) return [];
    // The keys the list holds, as the engine compares them (a value-map entry that writes the value it reads changes nothing: no entry).
    const entries = new Set<string>();
    if (s.kind === 'lookup') {
      for (const r of tables.get(s.table)?.rows ?? []) {
        const t = textKey(r[0]);
        if (t !== null) entries.add(t);
      }
    } else {
      for (const [from, to] of Object.entries(s.map)) {
        const t = textKey(from);
        if (t !== null && t !== textKey(to)) entries.add(t);
      }
    }
    if (entries.size < min) return [];
    const list: CopiedListRule = s.kind === 'lookup' ? { kind: 'lookup', computed: s.computed, table: s.table } : { kind: 'valueMap', column: s.column };
    return [{ s, header, keyExpr, key, entries, list }];
  });
  // The same list written out: a computed column an output column shows that is a chain of constants naming one input column's values.
  const mapped = new Set(rules.transform.valueMaps.map((m) => m.column));
  const chains = rules.transform.computed.flatMap((c) => {
    const out = rules.output.columns.findIndex((o) => o.from === c.id && o.agg === undefined);
    const header = rules.output.columns[out]?.header ?? '';
    if (out < 0 || mapped.has(c.id) || (opts.columns !== undefined && !opts.columns.has(header))) return [];
    if (fixed && fixed.transform.computed.some((x) => x.id === c.id && deepEqual(x.expr, c.expr))) return [];
    const chain = chainListOf(rules, c.expr);
    return chain && chain.atoms.length >= min ? [{ computed: c.id, out, header, ...chain }] : [];
  });
  if (candidates.length === 0 && chains.length === 0) return [];

  const last = rules.transform.computed[rules.transform.computed.length - 1]?.id ?? null;
  const probes = new Probes(last);
  const plan = candidates.map((c) => ({
    c,
    path: (c.s.kind === 'lookup' ? c.s.path : []).map((st) => ({ at: probes.add(st.expr, st.want === 'empty' ? 'text' : 'boolean'), want: st.want })),
    key: probes.add(c.keyExpr, 'text'),
  }));
  // A chain: which of its atoms is the first to hold on each row (0: none - the chain's else).
  const chainPlan = chains.map((c) => ({
    c,
    atom: probes.add({ op: 'switch', cases: c.atoms.map((when, i) => ({ when, then: { const: i + 1 } })), else: { const: 0 } }, 'integer'),
  }));
  const run = runWithProbes(rules, analysis, probes.list);
  if (!run) return [];

  const best = new Map<number, CopiedListQuestion>();
  /** A list with `rows` (per entry the example uses: the rows it gives their value) - unless it is too short or a small vocabulary. */
  const consider = (out: number, header: string, key: { header: string; index: number }, rows: ReadonlyMap<unknown, number>, list: CopiedListRule): void => {
    const entries = rows.size;
    if (entries < min) return;
    const small = entries <= vocabulary.maxEntries && [...rows.values()].every((n) => n >= vocabulary.minRowsPerEntry) && !identifier(key.index);
    if (small) return;
    const known = best.get(out);
    if (!known || known.entries < entries) best.set(out, { kind: 'copiedList', out, header, keyColumn: key.header, entries, list });
  };
  for (const { c, path, key } of plan) {
    const rows = new Map<string, number>();
    run.rows.forEach((row, k) => {
      if (!row || !path.every((st) => stepHolds(run, k, st))) return;
      const t = probeKey(run, k, key);
      if (t === null || !c.entries.has(t) || !cellMatchesExample(analysis, k, c.s.out, row.cells[c.s.out])) return;
      rows.set(t, (rows.get(t) ?? 0) + 1);
    });
    consider(c.s.out, c.header, c.key, rows, c.list);
  }
  for (const { c, atom } of chainPlan) {
    const rows = new Map<number, number>();
    run.rows.forEach((row, k) => {
      if (!row) return;
      const at = probeCellValue(row.cells[run.at[atom]!]);
      if (typeof at !== 'number' || at < 1 || at > c.atoms.length || !cellMatchesExample(analysis, k, c.out, row.cells[c.out])) return;
      rows.set(at - 1, (rows.get(at - 1) ?? 0) + 1);
    });
    consider(c.out, c.header, c.column, rows, { kind: 'cases', computed: c.computed, column: c.column.id });
  }
  return [...best.values()].sort((a, b) => a.out - b.out);
}

/**
 * Logic first (docs/proposals/saved-format-contents.md section 4; SPEC 21 v15): the problems of the ONE automatic round a learn makes for the
 * lists of its kept answer - a `list` problem per column, in the proposal's words, naming the column (as the answer wrote it: `masked`, the
 * vocabulary the round sends back; headers are sent as they are), the number of values and the key column. No value, masked or not.
 */
export function listRetryProblems(lists: readonly CopiedListQuestion[], masked: LearnResult): RepairProblem[] {
  return lists.map((q) => {
    const column = masked.output.columns[q.out]?.header ?? q.header;
    return {
      kind: 'list',
      out: q.out,
      message: `Column "${column}" is a list of ${q.entries} fixed values, one per ${q.keyColumn}. Find the rule behind it from the other columns. Only if no rule exists - the value depends on each ${q.keyColumn} itself, or comes from outside the file - keep the list.`,
    };
  });
}

/** A constant: a literal, or a fixed date. */
const isConstantExpr = (e: Expr): boolean => 'const' in e || (isNode(e) && e.op === 'dateLiteral');

/** The column an atom names one value of: `column = constant` (either side) or `oneOf(column, value)`; undefined for anything else. */
function namedColumn(atom: Expr): string | undefined {
  if (!isNode(atom)) return undefined;
  if (atom.op === 'eq') {
    const [a, b] = atom.args;
    if ('col' in a && isConstantExpr(b)) return a.col;
    if ('col' in b && isConstantExpr(a)) return b.col;
    return undefined;
  }
  return atom.op === 'oneOf' && 'col' in atom.arg && atom.values.length === 1 ? atom.arg.col : undefined;
}

/**
 * A chain of constants that names one input column's values one by one: `switch(id = "A-1", "x", or(id = "A-2", id = "A-3"), "y", ...,
 * "z")` or the same as nested ifs - every case and the else a constant, every atom of every condition (`atomsOf`) an equality of the same
 * plain input column with a value. Its column and its atoms in order; null for anything else.
 */
function chainListOf(rules: LearnResult, e: Expr): { column: { id: string; header: string; index: number }; atoms: Expr[] } | null {
  const cases = casesOf(e);
  if (cases.length === 0) return null;
  let last = e;
  while (isNode(last) && (last.op === 'switch' || last.op === 'if')) last = last.else;
  if (!isConstantExpr(last) || cases.some((c) => !isConstantExpr(c.then))) return null;
  const atoms = cases.flatMap((c) => atomsOf(c.when));
  const named = new Set(atoms.map(namedColumn));
  const [id] = named;
  if (named.size !== 1 || id === undefined) return null;
  const column = inputColumnOf(rules, { col: id });
  return column ? { column: { id: column.id, header: column.header, index: column.index }, atoms } : null;
}

// ---------------------------------------------------------------------------
// "Not sure": the check that flags a later row the part applies to
// ---------------------------------------------------------------------------

function hasWindow(e: Expr): boolean {
  return isNode(e) && (e.op === 'window' || exprChildren(e).some(hasWindow));
}

function readsAny(e: Expr, ids: ReadonlySet<string>): boolean {
  if ('col' in e) return ids.has(e.col);
  return isNode(e) && exprChildren(e).some((c) => readsAny(c, ids));
}

/** `e` with every lookup in `table` answering its missing-key value for `key` (the table without that row, said in one expression). */
function withoutKey(e: Expr, table: string, key: TableCellValue): Expr {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (typeof v !== 'object' || v === null) return v;
    const o = v as Record<string, unknown>;
    const copy = Object.fromEntries(Object.entries(o).map(([k, x]) => [k, walk(x)])) as Record<string, unknown>;
    if (o.op === 'lookup' && o.table === table) {
      const node = copy as unknown as Extract<ExprNode, { op: 'lookup' }>;
      const missing: Expr = node.onMissing === 'keep' ? node.key : { const: null };
      return { op: 'if', cond: { op: 'eq', args: [node.key, { const: key }] }, then: missing, else: node } satisfies Expr;
    }
    return copy;
  };
  return walk(e) as Expr;
}

/**
 * The check "Not sure" keeps (SPEC 8.8 `sameAs`, `oneTime`): on the computed column the part is in, the column's rule without the part, so a
 * run-time row where the part gives another value than the rest of the rule is flagged. Null when it cannot be said that way (as for an
 * alternative's check): the rest reads other rows (an across-row function runs only in a computed column), it reads a column a value map
 * changes (a check reads it after the maps, the rule before), a value-map entry (the check reads the column after its map), or the rules
 * with it would not pass their checks (the expression too deep, a type that does not fit).
 */
export function oneTimeCheck(rules: LearnResult, s: Pick<PartSupport, 'part' | 'computed'>): Validation | null {
  if (s.part.kind === 'valueMapEntry' || s.computed === undefined) return null;
  const c = rules.transform.computed.find((x) => x.id === s.computed);
  if (!c) return null;
  let expr: Expr;
  if (s.part.kind === 'lookupEntry') expr = withoutKey(c.expr, s.part.table, s.part.key);
  else {
    const without = withoutRulePart(rules, s.part);
    const next = without?.transform.computed.find((x) => x.id === c.id);
    if (!next) return null;
    expr = next.expr;
  }
  const mapped = new Set(rules.transform.valueMaps.map((m) => m.column));
  if (hasWindow(expr) || readsAny(expr, mapped)) return null;
  const check: Validation = { column: c.id, rule: 'sameAs', expr, severity: 'flag', oneTime: true };
  const withCheck = { ...rules, validations: [...rules.validations, check] };
  if (checkRules(withCheck).length > checkRules(rules).length || typeCheck(withCheck).length > typeCheck(rules).length) return null;
  return check;
}
