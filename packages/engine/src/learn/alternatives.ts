// A second rule for one output column (learn-v8 `alternatives`; owner decision 2026-10-04; SPEC 9.2 layer 8, 21 v12 item 17). The AI step
// sees a few rows; when two different rules fit all of them, it gives the second one beside its answer, and code decides with every row
// of the example:
//   - both reproduce the column on every row: a genuine ambiguity - the user is asked (the ambiguity question, `AmbiguousColumn`, its two
//     readings the answer's rule (the default) and the alternative); until they answer the rules keep the answer's rule with a visible
//     check that flags a run-time row where the two differ (`sameAs`, SPEC 8.8);
//   - only one does: that one is the rule, silently (the alternative replaces the answer's rule for that column when it is the one);
//   - neither: nothing new - the learning loop goes on with the answer's rule, and the alternative is dropped.
//
// The standard path stays one rule per column at no extra cost: only a column WITH an alternative gets extra work - the rules with only that
// column's rule swapped in are run once, and only that column is compared, on every row (`verifyAgainstExample`'s `onlyColumns`). The
// other columns are never re-run or re-verified for an alternative: when one replaces the answer's rule, the answer's verification is
// carried over with that one column's results replaced (`withColumnResults`). Rules files stay one rule per column; alternatives live only
// in the learn session.
//
// Pure and synchronous, like the rest of this package.
import { limits, type Computed, type Expr, type LearnAlternative, type LearnResult, type Validation } from '@formatai/shared';
import { exprChildren } from '../pipeline/v1/expr';
import type { PairAnalysis } from './analyze';
import { unmaskRules, type Masker } from './mask';
import type { AmbiguousColumn, ColumnReading, RuleFragment } from './readings';
import { verifyAgainstExample, type VerifyOptions, type VerifyResult, type WrongRow } from './verify';

/** What code found for one alternative on every row of the example. */
export type AlternativeOutcome = 'bothPass' | 'answerOnly' | 'alternativeOnly' | 'bothFail';

export interface AlternativeResult {
  /** The output column (header) and its position. */
  column: string;
  out: number;
  outcome: AlternativeOutcome;
  /** `bothPass`: the question the user is asked (absent when the column already asks another one, see `resolveAlternatives`). */
  question?: AmbiguousColumn;
}

/** Runs the rules on the example and compares only the given column (the caller's `verifyAgainstExample` with `onlyColumns`). */
export type ColumnVerifier = (rules: LearnResult, column: number) => VerifyResult;

export interface ResolveInput {
  /** The answer as it will be used (unmasked, filled, verified as `verification`). */
  rules: LearnResult;
  /** The same answer in its own vocabulary (masked when masking is on): what a repair round sends back. */
  masked: LearnResult;
  verification: VerifyResult;
  /** The answer's alternatives, as the API returned them (in the answer's own vocabulary). */
  alternatives: readonly LearnAlternative[];
  masker?: Masker | undefined;
  /** One run of the rules with only `column` compared (`verifyAgainstExample(rules, analysis, { onlyColumns: [column], ... })`). */
  verifyColumn: ColumnVerifier;
  /** Output headers that already ask the user a question (the free engine's): an alternative adds no second question there. */
  asked?: ReadonlySet<string>;
}

export interface Resolved {
  rules: LearnResult;
  masked: LearnResult;
  verification: VerifyResult;
  results: AlternativeResult[];
}

/** `verifyColumn` for an analysis: one run, only that column compared, the wrong rows listed (and masked like the learn's). */
export function columnVerifier(analysis: PairAnalysis, masker?: Masker): ColumnVerifier {
  return (rules, column) => verifyAgainstExample(rules, analysis, { onlyColumns: [column], wrongRows: true, ...(masker ? { masker } : {}) } satisfies VerifyOptions);
}

/**
 * Tests each alternative against the answer on every row of the example and applies the outcome (see the file comment). One run of the
 * rules per alternative, nothing else; at most `limits.learn.maxAlternatives` are looked at, one per column, in order.
 */
export function resolveAlternatives(input: ResolveInput): Resolved {
  let { rules, masked, verification } = input;
  const results: AlternativeResult[] = [];
  const seen = new Set<string>();
  for (const given of input.alternatives.slice(0, limits.learn.maxAlternatives)) {
    if (seen.has(given.outputColumn)) continue;
    seen.add(given.outputColumn);
    const alternative = input.masker ? unmaskRules(given, input.masker) : given;
    const out = rules.output.columns.findIndex((c) => c.header === alternative.outputColumn);
    const column = rules.output.columns[out];
    // (The API checked it against the answer; a column without a rule here, or an id the rules now hold, has nothing to test.)
    if (!column || column.from === null || alternative.computed.some((c) => idsOf(rules).has(c.id))) continue;

    const variant = swapped(rules, out, alternative);
    const theirs = input.verifyColumn(variant, out);
    const answerPasses = passes(verification, column.header);
    const alternativePasses = passes(theirs, column.header);

    if (answerPasses && alternativePasses) {
      if (input.asked?.has(column.header)) {
        // DECISION: one question per column - the free engine's question about it stands (the worker asks it first), so the alternative
        // adds neither a question nor a check.
        results.push({ column: column.header, out, outcome: 'bothPass' });
        continue;
      }
      const check = sameAsCheck(rules, column.from, alternative);
      const question: AmbiguousColumn = { out, header: column.header, readings: [readingOf(rules, column.from, 'rule'), readingOf(variant, alternative.from, 'alternative')], defaultReading: 0, check };
      if (check) rules = { ...rules, validations: [...rules.validations, check] };
      results.push({ column: column.header, out, outcome: 'bothPass', question });
    } else if (alternativePasses) {
      // The alternative is the rule: the answer's own rule for this column goes (what only it read goes with it), in both vocabularies,
      // and the verification keeps every other column's results.
      rules = pruned(variant, column.from);
      masked = pruned(swapped(masked, out, given), column.from);
      verification = withColumnResults(verification, theirs, out, column.header);
      results.push({ column: column.header, out, outcome: 'alternativeOnly' });
    } else {
      results.push({ column: column.header, out, outcome: answerPasses ? 'answerOnly' : 'bothFail' });
    }
  }
  return { rules, masked, verification, results };
}

// ---------------------------------------------------------------------------
// The rules with one column's rule swapped in
// ---------------------------------------------------------------------------

function swapped(rules: LearnResult, out: number, alternative: LearnAlternative): LearnResult {
  return {
    ...rules,
    transform: { ...rules.transform, computed: [...rules.transform.computed, ...alternative.computed] },
    output: { ...rules.output, columns: rules.output.columns.map((c, i) => (i === out ? { ...c, from: alternative.from } : c)) },
  };
}

/** A column passes when it was compared on at least one row and no row differs in it. */
function passes(v: VerifyResult, header: string): boolean {
  return v.total > 0 && !v.mismatches.some((m) => m.column === header);
}

function idsOf(rules: LearnResult): Set<string> {
  const ids = new Set<string>([...rules.input.columns.map((c) => c.id), ...rules.transform.computed.map((c) => c.id)]);
  const ex = rules.transform.expand;
  if (ex?.mode === 'columnsToRows') [ex.labelId, ex.valueId].forEach((id) => ids.add(id));
  if (ex?.mode === 'splitCell') [ex.partId, ex.indexId, ex.countId].forEach((id) => id !== undefined && ids.add(id));
  if (ex?.mode === 'fixedFanOut') for (const row of ex.rows) for (const id of Object.keys(row.set)) ids.add(id);
  return ids;
}

/** Every column id an expression reads (its `col` leaves, and an across-row function's group and order columns). */
function readsOf(e: Expr, into: Set<string> = new Set()): Set<string> {
  if ('col' in e) into.add(e.col);
  if (!('op' in e)) return into;
  if (e.op === 'window') {
    for (const id of e.by ?? []) into.add(id);
    for (const key of e.order ?? []) into.add(key.column);
  }
  for (const child of exprChildren(e)) readsOf(child, into);
  return into;
}

/**
 * Takes out the computed columns (and their value maps) that nothing reads any more, starting from `from` - the rule the alternative
 * replaced - and following what they read. A check only code writes does not keep a column alive: a cut-off check on a column that goes,
 * goes with it (DECISION: one on a column that stays is kept - it is visible and deletable, and the alternative may compare it too).
 */
function pruned(rules: LearnResult, from: string): LearnResult {
  let current = rules;
  const queue = [from];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const id = queue.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const computed = current.transform.computed.find((c) => c.id === id);
    if (!computed || readers(current, id)) continue;
    current = {
      ...current,
      transform: { ...current.transform, computed: current.transform.computed.filter((c) => c.id !== id), valueMaps: current.transform.valueMaps.filter((vm) => vm.column !== id) },
      validations: current.validations.filter((v) => !(v.rule === 'cutoffRange' && v.column === id)),
    };
    queue.push(...readsOf(computed.expr));
  }
  return current;
}

/** Whether anything but a value map or a cut-off check reads `id`. */
function readers(rules: LearnResult, id: string): boolean {
  const t = rules.transform;
  if (rules.output.columns.some((c) => c.from === id)) return true;
  if (t.computed.some((c) => c.id !== id && readsOf(c.expr).has(id))) return true;
  if ((rules.input.rowFilters ?? []).some((f) => ('expr' in f ? readsOf(f.expr).has(id) : f.column === id))) return true;
  if (t.sort.some((s) => s.column === id) || t.group?.by === id) return true;
  if (t.dedupe && t.dedupe.keys !== 'all' && t.dedupe.keys.includes(id)) return true;
  if (rules.output.titleRows.some((row) => 'parts' in row && row.parts.some((p) => 'agg' in p && p.column === id))) return true;
  return rules.validations.some((v) => v.rule !== 'cutoffRange' && (((v.on ?? 'input') !== 'output' && v.column === id) || (v.rule === 'sameAs' && readsOf(v.expr).has(id))));
}

/**
 * The answer's verification with column `out`'s results replaced by `theirs` (a run of the variant with only that column compared): the
 * other columns, the row count, the layout rows and the extra rows are the answer's own (the variant only changes this column).
 */
export function withColumnResults(mine: VerifyResult, theirs: VerifyResult, out: number, header: string): VerifyResult {
  const mismatches = [...mine.mismatches.filter((m) => m.column !== header), ...theirs.mismatches];
  const byRow = new Map<number, WrongRow>();
  for (const w of mine.wrongRows ?? []) byRow.set(w.inRow, { ...w, cells: w.cells.filter((c) => c.out !== out) });
  for (const w of theirs.wrongRows ?? []) {
    const cells = w.cells.filter((c) => c.out === out);
    if (cells.length === 0) continue;
    const row = byRow.get(w.inRow);
    byRow.set(w.inRow, row ? { ...row, cells: [...row.cells, ...cells] } : { inRow: w.inRow, cells, extra: [] });
  }
  const wrongRows = [...byRow.values()].filter((w) => w.cells.length > 0 || w.extra.length > 0).sort((a, b) => a.inRow - b.inRow);
  const matched = mine.total - new Set(mismatches.map((m) => m.exampleRow)).size;
  // The diffs this column made in the answer's problems go; the alternative's own (when it is wrong somewhere) come in. A row the rules make
  // that the example does not have is not this column's (it is reported with `expected: null`, and stays).
  const ours = (p: VerifyResult['repairProblems'][number]): boolean => p.kind === 'diff' && p.out === out && p.expected !== null;
  const repairProblems = [...mine.repairProblems.filter((p) => !ours(p)), ...theirs.repairProblems.filter(ours)];
  // (Without the wrong rows, the extra rows are read from the problems: a diff with nothing expected.)
  const extraRows = mine.wrongRows ? wrongRows.some((w) => w.extra.length > 0) : mine.repairProblems.some((p) => p.kind === 'diff' && p.expected === null);
  return {
    ...mine,
    verified: mine.layoutProblems.length === 0 && matched === mine.total && !extraRows,
    matched,
    mismatches,
    repairProblems,
    ...(mine.wrongRows ? { wrongRows } : {}),
  };
}

// ---------------------------------------------------------------------------
// The question: two readings, and the check that marks it open
// ---------------------------------------------------------------------------

/** The computed columns `from` reads (itself first, transitively), in the rules' run order. */
function chainOf(rules: LearnResult, from: string): Computed[] {
  const byId = new Map(rules.transform.computed.map((c) => [c.id, c] as const));
  const needed = new Set<string>();
  const visit = (id: string): void => {
    const c = byId.get(id);
    if (!c || needed.has(id)) return;
    needed.add(id);
    for (const read of readsOf(c.expr)) visit(read);
  };
  visit(from);
  return rules.transform.computed.filter((c) => needed.has(c.id));
}

/**
 * A rule of the rules as a reading (`RuleFragment`): self-contained, so it applies to rules in any state - the input columns it reads (as
 * the rules declare them; the web matches them to its own by header), the computed columns it reads in run order, and the value maps on them.
 */
function readingOf(rules: LearnResult, from: string, kind: string): ColumnReading {
  const chain = chainOf(rules, from);
  const reads = new Set<string>([from]);
  for (const c of chain) readsOf(c.expr, reads);
  const inputColumns = rules.input.columns.filter((c) => reads.has(c.id));
  const own = new Set(chain.map((c) => c.id));
  const fragment: RuleFragment = { from, inputColumns, computed: chain, valueMaps: rules.transform.valueMaps.filter((vm) => own.has(vm.column)) };
  return { kind, columns: inputColumns.map((c) => c.header), fragment };
}

/** An expression's depth (a leaf alone is 1), as `checkRules` counts it. */
function depthOf(e: Expr): number {
  return 'op' in e ? 1 + Math.max(0, ...exprChildren(e).map(depthOf)) : 1;
}

/**
 * The check that goes with the open question (SPEC 8.8 `sameAs`): on the column the output column reads (`from`), the alternative written
 * out as ONE expression - its own computed columns put in place, every other column read as it is when input checks run. Null when it
 * cannot be said that way: the alternative uses an across-row function (only a computed column runs one), one of its own computed columns
 * reads a column with a value map (a computed column reads it BEFORE the value maps, a check AFTER them), or the expression would be
 * deeper than the rules allow. DECISION: an inner computed column's declared type is not applied in the written-out expression (the outer
 * value is read as the column's type, as the check compares it); a difference this makes is at most a flag, never a change in the output.
 */
function sameAsCheck(rules: LearnResult, from: string, alternative: LearnAlternative): Validation | null {
  const own = new Map(alternative.computed.map((c) => [c.id, c] as const));
  const mapped = new Set(rules.transform.valueMaps.map((vm) => vm.column));
  let possible = true;
  const inline = (e: Expr, depth: number): Expr => {
    if (depth > alternative.computed.length + 1) {
      possible = false;
      return e;
    }
    const walk = (v: unknown): unknown => {
      if (Array.isArray(v)) return v.map(walk);
      if (typeof v !== 'object' || v === null) return v;
      const o = v as Record<string, unknown>;
      if (o.op === 'window') possible = false;
      if (typeof o.col === 'string' && Object.keys(o).length === 1) {
        const inner = own.get(o.col);
        if (inner) return inline(inner.expr, depth + 1);
        if (mapped.has(o.col)) possible = false;
        return o;
      }
      return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, walk(x)]));
    };
    return walk(e) as Expr;
  };
  const top = own.get(alternative.from);
  const expr = top ? inline(top.expr, 1) : ({ col: alternative.from } as Expr);
  if (!possible || depthOf(expr) > limits.rules.maxExprDepth) return null;
  return { column: from, rule: 'sameAs', expr, severity: 'flag' };
}
