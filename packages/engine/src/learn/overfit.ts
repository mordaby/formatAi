// The overfitting guards (SPEC 9.2 layer 6, 21 v12 item 19): three shapes of rule that copy particular rows of the example instead of
// stating a rule, found in code whatever the prompt says. The learn-v8 measurement (2026-10-05) showed the model fitting every row at any
// cost - `if(rowNumber() = 1, 0, ...)` for one hand-edited row, a 3,269-character `switch` of supplier + item mapped to warehouse codes for
// a column whose values come from elsewhere - and both passed every check, because they DO reproduce the rows they were written from.
//
//   - position: a condition that compares a row-position window function (`rowNumber()`, `rank(...)`) of the whole file with a constant.
//     It singles out the rows that happen to sit there in this file. `rowNumber()` as a column's VALUE (a line number) is no condition and
//     stays allowed, and so does a position within a group (`rowNumber(by: customer) = 1`, the first row of each customer: it holds for
//     any number of groups, so the full verification judges it like any rule).
//   - caseList: a computed column that is a chain of cases (`switch`, or `if` nested in the else), each case giving a constant to the rows
//     an equality or range of input columns picks, whose conditions name rows one by one. A real mapping is a value map or a lookup table
//     (code fills those from every row and flags a new key at run time); a case list like this only repeats the example's answers. Counted
//     by ATOM, not by case (owner amendment, 2026-10-06): a case's condition is split into its top-level `or` disjuncts and the values of a
//     `oneOf` (an `and` stays one atom), so `or(id = "274...", id = "297...", ... 20 IDs) -> "Small"` is 20 atoms of one row each, not one
//     case of 20 rows - gpt-5's escalation wrote exactly that on the owner's 100-row file, 37 national IDs in a dozen cases, and it verified.
//     See `limits.learn.overfit` for the thresholds.
//   - measureKey: a lookup table keyed on a measure - a decimal, currency or percent column, an amount (`lookup("t", amount, "x")`). An
//     amount is no category: next month's file brings new ones, so a table of amounts only holds this file's rows (and code's fill, which
//     completes a lookup from every row, would copy every one of them). learn-v8.1 wrote exactly this for a hand-edited row in its first
//     real learn (2026-10-05): `coalesce(lookup("discountTable", amount, "discountAmount"), round(amount * 0.1, 2))`, filled to 150
//     entries, verified, wrong the next month. DECISION: an integer key may be a code (a branch number), and a date a calendar
//     (holidays). Amendment 2026-10-07 (engine audit): the key is judged by the columns its value is made of (`keyColumnsOf`: through
//     computed columns and functions of the value - `lookup(t, round(amount, 0), ...)` -, not through a condition), and a VALUE MAP on an
//     amount (or on a computed column made of one) is the same table written as a map: both are found (it was "a plain column as the key,
//     lookups only", and either escaped every guard).
//
// A finding becomes one `overfit` repair problem per column (`overfitProblems`), at most once per learn; an answer that still has it after
// that repair gets the column reported as unsupported by code (`withOverfitFallback`, reason `overfit`: "needs your input"), so a rule that
// only copies rows is never counted as verified. The API runs the guards on the samples (and the loop's rows), the browser on every row of
// the example (`learn/flow.ts`). A position condition that names exact rows (`rowNumber() = 54`, `rowExact`) is the browser's alone: a
// row it explains may be one edited by hand once, and the user is asked (SPEC 21 v12 item 20, `oneTimers.ts`). So is a case list only its
// atoms show (`atoms`): on a dozen sample rows a real list of categories names rows one by one too.
//
// Pure and synchronous, like the rest of this package.
import { limits, withColumnsTakenOut, withoutUnreadLists, type Computed, type Expr, type ExprNode, type LearnResult, type RepairProblem, type Rules } from '@formatai/shared';
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
  /**
   * caseList found only by counting atoms (some case's `or` / `oneOf` picks more rows as a whole than `maxRowsPerCase`): how many atoms
   * pin rows. DECISION: such a finding is the browser's alone (like `rowExact`): on the payload's dozen sample rows a real list of
   * categories (`oneOf(plan, "Basic", "Standard", "Pro")`) has every value on a row or two as well; only every row of the example tells.
   */
  atoms?: number;
  /**
   * position: every position condition of the computed column names exact rows (`rowNumber() = 54`), none a range. DECISION (SPEC 21 v12
   * item 20): such a finding is the browser's alone - the API's samples cannot tell whether that row was edited by hand once (a question for
   * the user) or the rule copies rows (the browser's guard: one repair, then the fallback); the browser judges it on every row (`learn/flow.ts`).
   */
  rowExact?: true;
  /** measureKey: found in a value map on an amount (`id` is the mapped column), not in a lookup (amendment 2026-10-07). */
  valueMap?: true;
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
  return positionComparisons(e, positionIds).length > 0;
}

/** Every comparison of a whole-file position with a constant in `e` (the comparison nodes themselves). */
function positionComparisons(e: Expr, positionIds: ReadonlySet<string>, out: ExprNode[] = []): ExprNode[] {
  if (!isNode(e)) return out;
  if (COMPARISONS.has(e.op)) {
    const [a, b] = (e as { args: [Expr, Expr] }).args;
    if ((isPosition(a, positionIds) && isConstant(b)) || (isPosition(b, positionIds) && isConstant(a))) {
      out.push(e);
      return out;
    }
  }
  if (e.op === 'oneOf' && isPosition(e.arg, positionIds)) {
    out.push(e);
    return out;
  }
  for (const c of exprChildren(e)) positionComparisons(c, positionIds, out);
  return out;
}

/**
 * Whether every position comparison in `e` names exact rows - `rowNumber() = 54`, `oneOf(rowNumber(), 54, 99)` - and none a range
 * (`rowNumber() <= 3`, `rowNumber() <> 1`). Such a condition picks single rows: whether each is a row edited by hand once, the user is asked
 * (SPEC 21 v12 item 20, `oneTimers.ts`) - which only every row of the example can tell (`OverfitFinding.rowExact`).
 */
function exactRows(e: Expr, positionIds: ReadonlySet<string>): boolean {
  const found = positionComparisons(e, positionIds);
  return found.length > 0 && found.every((n) => n.op === 'eq' || n.op === 'oneOf');
}

// ---------------------------------------------------------------------------
// caseList
// ---------------------------------------------------------------------------

interface Case {
  when: Expr;
  then: Expr;
}

/** The cases of a `switch`, or of an `if` chain nested in the else (`if(c1, v1, if(c2, v2, ...))`), in order; [] for anything else. */
export function casesOf(e: Expr): Case[] {
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
 * The atoms of a case's condition (owner amendment, 2026-10-06): its top-level `or` disjuncts, and each value of a `oneOf` as its own
 * (`oneOf(qty, 1, 4)` is `oneOf(qty, 1)` and `oneOf(qty, 4)`); an `and` stays one atom - a combination pins one row as a whole.
 */
export function atomsOf(when: Expr): Expr[] {
  if (isNode(when) && when.op === 'or') return when.args.flatMap(atomsOf);
  if (isNode(when) && when.op === 'oneOf' && when.values.length > 1) return when.values.map((v) => ({ op: 'oneOf', arg: when.arg, values: [v] }) satisfies Expr);
  return [when];
}

/**
 * The shape of a memorized case list, before the rows are counted: cases each giving a constant, each picking rows by equalities or ranges
 * of input columns, together reading at least two input columns, and at least `minCases` atoms (`atomsOf`) in all. DECISION: a chain on ONE
 * column is a value map or a band table written out (`switch(amount < 100, "A", amount < 200, "B", ...)`) - one key, one answer each, a rule
 * that holds for any row - so it is left to the full verification; a row of the example is pinned by a COMBINATION of its values. (One column
 * that is a key of the file pins rows too: that list is the user's question, not a guard's - `copiedLists`, `learn/oneTimers.ts`.)
 */
function caseListShape(e: Expr, inputIds: ReadonlySet<string>): { cases: Case[]; atoms: Expr[] } | null {
  const cases = casesOf(e);
  if (cases.length === 0) return null;
  const read = new Set<string>();
  for (const c of cases) {
    if (!isConstant(c.then) || !picksRows(c.when, inputIds, read)) return null;
  }
  const atoms = cases.flatMap((c) => atomsOf(c.when));
  return read.size >= 2 && atoms.length >= limits.learn.overfit.minCases ? { cases, atoms } : null;
}

const PROBE = '__overfitProbe';

/**
 * How many of the rows code can see each condition is the first to hold for, in order (for a case list's atoms, the cases' order: a row
 * goes to the first atom of the first case that takes it): the rules run on `table` with a hidden column that is the number of that
 * condition (0: none), and only that column read. Sort, groups and summary rows are left out (they never change which case a row takes);
 * filters, duplicates and expand stay (they decide which rows there are). Null when the rules cannot run.
 */
export function conditionCounts(rules: AnyRules, conditions: readonly Expr[], table: InputTable): number[] | null {
  let id = PROBE;
  while (rules.transform.computed.some((c) => c.id === id) || rules.input.columns.some((c) => c.id === id)) id = `_${id}`;
  const probe: Expr = { op: 'switch', cases: conditions.map((when, i) => ({ when, then: { const: i + 1 } })), else: { const: 0 } };
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
  const counts = new Array<number>(conditions.length).fill(0);
  for (const row of result.sheet.rows) {
    if (row.kind !== 'data') continue;
    const v = row.cells[0]?.v;
    if (typeof v === 'number' && v >= 1 && v <= conditions.length) counts[v - 1]! += 1;
  }
  return counts;
}

/**
 * Whether a case list copies rows, from its atoms' counts (owner amendment, 2026-10-06): at least `minCases` atoms each pin rows - pick one
 * to `maxRowsPerCase` of the rows code can see - and those row-pinning atoms are at least half of all the atoms (a real rule may list a rare
 * value or two beside its categories). DECISION: an atom that picks no row pins nothing (a value the earlier atoms already took, or one this
 * file does not have); it still counts among all the atoms. Or, as before atoms were counted, at least `minCases` cases each picking at most
 * `maxRowsPerCase` rows (`perCase`, which the samples can judge too). Null: no finding; `atoms`: how many atoms pin rows.
 */
function copiesRows(counts: readonly number[], shape: { cases: readonly Case[]; atoms: readonly Expr[] }): { atoms: number; perCase: boolean } | null {
  const { minCases, maxRowsPerCase } = limits.learn.overfit;
  let at = 0;
  const perCase =
    shape.cases.length >= minCases &&
    shape.cases.every((c) => {
      const n = atomsOf(c.when).length;
      const rows = counts.slice(at, at + n).reduce((a, b) => a + b, 0);
      at += n;
      return rows <= maxRowsPerCase;
    });
  const pinning = counts.filter((n) => n >= 1 && n <= maxRowsPerCase).length;
  const byAtoms = pinning >= minCases && pinning * 2 >= counts.length;
  return perCase || byAtoms ? { atoms: pinning, perCase } : null;
}

// ---------------------------------------------------------------------------
// measureKey
// ---------------------------------------------------------------------------

const MEASURE_TYPES: ReadonlySet<string> = new Set(['decimal', 'currency', 'percent']);

const BOOLEAN_OPS: ReadonlySet<string> = new Set(['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'and', 'or', 'not', 'oneOf', 'isEmpty', 'notEmpty', 'startsWith', 'endsWith', 'contains']);

/**
 * The columns a KEY is made of (amendment 2026-10-07, engine audit): the input and computed columns whose value reaches the key expression's
 * value - through the computed columns it reads (`lookup(t, trim(account), ...)` is keyed on Account, and so is a value map on a computed
 * copy of it), but not through a condition (`if(amount > 1000, "big", "small")` is keyed on a category, not on the amount), nor through a
 * lookup's own result. Input columns in the order first read; every computed column on the way is listed in `via`.
 */
export function keyColumnsOf(rules: AnyRules, key: Expr): { inputs: string[]; via: string[] } {
  const inputIds = new Set(rules.input.columns.map((c) => c.id));
  const computed = new Map(rules.transform.computed.map((c) => [c.id, c.expr] as const));
  const inputs: string[] = [];
  const via: string[] = [];
  const seen = new Set<string>();
  const visit = (e: Expr): void => {
    if ('col' in e) {
      if (seen.has(e.col)) return;
      seen.add(e.col);
      if (inputIds.has(e.col)) inputs.push(e.col);
      const expr = computed.get(e.col);
      if (expr !== undefined) {
        via.push(e.col);
        visit(expr);
      }
      return;
    }
    if (!isNode(e) || BOOLEAN_OPS.has(e.op) || e.op === 'lookup') return;
    let parts: Expr[];
    if (e.op === 'if') parts = [e.then, e.else];
    else if (e.op === 'switch') parts = [...e.cases.map((c) => c.then), e.else];
    else if (e.op === 'window') parts = e.arg !== undefined ? [e.arg] : [];
    else parts = exprChildren(e);
    for (const c of parts) visit(c);
  };
  visit(key);
  return { inputs, via };
}

/** Whether a key is made of a measure (an amount: a decimal, currency or percent input column, or a computed column of such a type). */
function keyedOnMeasure(rules: AnyRules, key: Expr, measureIds: ReadonlySet<string>): boolean {
  const { inputs, via } = keyColumnsOf(rules, key);
  return [...inputs, ...via].some((id) => measureIds.has(id));
}

/** Whether `e` looks a value up in a table by a measure (`lookup("t", amount, "x")`, `lookup("t", round(amount, 0), "x")`). */
function looksUpByMeasure(rules: AnyRules, e: Expr, measureIds: ReadonlySet<string>): boolean {
  if (!isNode(e)) return false;
  if (e.op === 'lookup' && keyedOnMeasure(rules, e.key, measureIds)) return true;
  return exprChildren(e).some((c) => looksUpByMeasure(rules, c, measureIds));
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
  // (Input columns too: a value map changes one in place - amendment 2026-10-07.)
  for (const id of [...rules.transform.computed.map((c) => c.id), ...rules.input.columns.map((c) => c.id)]) {
    const positions: number[] = [];
    rules.output.columns.forEach((col, i) => {
      if (col.from !== null && reaches(col.from, id, new Set())) positions.push(i);
    });
    out.set(id, positions);
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
  const add = (kind: OverfitKind, id: string, more: Partial<Pick<OverfitFinding, 'cases' | 'atoms' | 'rowExact' | 'valueMap'>> = {}): void => {
    for (const out of reached.get(id) ?? []) {
      const header = rules.output.columns[out]!.header;
      if (seen.has(`${kind}\u0000${header}`)) continue;
      seen.add(`${kind}\u0000${header}`);
      findings.push({ kind, outputColumn: header, out, id, ...more });
    }
  };
  for (const c of rules.transform.computed) {
    if (comparesPosition(c.expr, positionIds)) add('position', c.id, exactRows(c.expr, positionIds) ? { rowExact: true } : {});
    if (looksUpByMeasure(rules, c.expr, measureIds)) add('measureKey', c.id);
    const shape = caseListShape(c.expr, inputIds);
    if (shape && opts.table) {
      const counts = conditionCounts(rules, shape.atoms, opts.table);
      const found = counts ? copiesRows(counts, shape) : null;
      if (found) add('caseList', c.id, { cases: shape.cases.length, ...(found.perCase ? {} : { atoms: found.atoms }) });
    }
  }
  // A value map keyed on a measure (amendment 2026-10-07, engine audit): the same table of amounts as a lookup, written as a map - on an
  // amount column or a computed column made of one. (It was caught by neither guard: the lists leave a measure key to this one.)
  for (const vm of rules.transform.valueMaps) {
    if (Object.keys(vm.map).length > 0 && keyedOnMeasure(rules, { col: vm.column }, measureIds)) add('measureKey', vm.column, { valueMap: true });
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
      return f.atoms !== undefined
        ? `it is a list of ${f.cases ?? 'many'} cases whose conditions name ${f.atoms} values one by one, each picking one or two rows; a real mapping is a value map or a lookup table`
        : `it is a list of ${f.cases ?? 'many'} cases, each giving a constant to one or two rows; a real mapping is a value map or a lookup table`;
    case 'measureKey':
      return f.valueMap
        ? 'it maps amounts to values one by one, and the next file brings new amounts; a real mapping is keyed on a code or a category'
        : 'it looks values up by an amount, and the next file brings new amounts; a real mapping is keyed on a code or a category';
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

/**
 * The honest fallback: every output column with a finding is reported as unsupported by code (`from: null`, reason `overfit`: "needs your
 * input", like an `externalData` column the AI step reports itself), and the computed columns nothing reads any more are taken out, so the
 * rows the rule copied are never shown or saved as a rule - and so are the lookup tables nothing looks up any more (a table of the example's
 * amounts holds this file's rows). Everything else is kept as it is. The rules themselves when there is no finding. (`withColumnsTakenOut`,
 * shared: "Save without it" for a list copied from the example takes a column out the same way.)
 */
export function withOverfitFallback<R extends AnyRules>(rules: R, findings: readonly OverfitFinding[]): R {
  if (findings.length === 0) return rules;
  const out = withColumnsTakenOut(
    rules,
    new Set(findings.map((f) => f.outputColumn)),
    OVERFIT_REASON,
    findings.map((f) => f.id),
  );
  // (A value map of amounts nothing reads any more goes too: its entries are this file's rows.)
  return findings.some((f) => f.valueMap) ? withoutUnreadLists(out) : out;
}
