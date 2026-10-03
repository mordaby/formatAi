// The fixed lock of completion mode (LEARN_PROMPT "Completing a partial rules file", SPEC 9.2 layer 5): the
// user already has part of the rules, and the AI step may only ADD what is missing. So the answer must contain
// every element of `complete.fixed` unchanged - the same idea as the format lock (8.12) and the source lock (8.15),
// but as containment: new ids, input columns, computed columns, functions and tables are welcome, nothing fixed
// may change or disappear, and every layout part that is not listed as missing must stay as it is.
//
// DECISION: the lock is CONTAINMENT, not equality (new ids, input columns, computed columns, functions and tables are welcome), and each layout
// part is frozen unless it is listed: rows = transform.expand, droppedRows = rowFilters + dedupe, sort, group (by, showDetailRows; blankRows =
// blankRowsAfter; summaryRows = its summary rows), summaryRows = output.summaryRows, dateTitle = output.titleRows. A listed part may differ, but
// must still contain whatever fixed element it had. The part codes are the existing `AiStepPartCode`s (`dateTitle`, not `titleDate`).
//
// Both sides are canonicalized first (`canonicalizeRules`: the same formula, written with other spacing or a
// re-associated `a + b + c`, is the same rule) and compared with `deepEqual`, which treats an absent key like an
// explicit `undefined`. Pure: used by the API (on the wire-decoded answer and the wire-decoded `complete.fixed`,
// both still masked when masking is on) and by the browser (on the unmasked answer and the real fixed rules).
import type { AiStepPartCode, LearnResult, Rules, SummaryRow, Validation } from '@formatai/shared';
import { DEFAULT_OUTPUT_FILE } from '@formatai/shared';
import { canonicalizeRules } from '../formula/canonicalize';
import { deepEqual } from './deepEqual';

export interface FixedProblem {
  kind: 'fixedMismatch';
  /** Dotted/bracketed path into the ANSWER (or the fixed rules, for something that is missing). */
  path: string;
  message: string;
}

export interface FixedLockOptions {
  /** Output column positions the AI step had to produce (`complete.columns`). */
  columns: readonly number[];
  /** Layout parts the AI step had to produce (`complete.parts`). */
  parts: readonly AiStepPartCode[];
}

/** `rules` without `name`/`meta` (what a `LearnResult` is), so a stored `Rules` compares like a learn answer. */
function plain(rules: LearnResult | Rules): LearnResult {
  return canonicalizeRules({
    schemaVersion: rules.schemaVersion,
    input: rules.input,
    transform: rules.transform,
    output: rules.output,
    validations: rules.validations,
    unsupported: rules.unsupported,
    assumptions: rules.assumptions,
  });
}

function validationKey(v: Validation): string {
  return JSON.stringify(v, Object.keys(v).sort());
}

/** Every `col` a tree reads (an `Expr` leaf is `{ col: id }`), found by a plain deep walk so a new operation is covered too. */
function columnsRead(value: unknown, into: Set<string>): void {
  if (Array.isArray(value)) {
    for (const v of value) columnsRead(v, into);
    return;
  }
  if (value === null || typeof value !== 'object') return;
  const o = value as Record<string, unknown>;
  if (typeof o.col === 'string') into.add(o.col);
  for (const v of Object.values(o)) columnsRead(v, into);
}

/** Every column id a FIXED output column depends on: its `from`, and whatever a fixed computed column it reads reads in turn. */
function readByFixedColumns(fixed: LearnResult, produced: ReadonlySet<number>): Map<string, string> {
  const reader = new Map<string, string>(); // column id -> header of a fixed output column that reads it
  const computed = new Map(fixed.transform.computed.map((c) => [c.id, c] as const));
  fixed.output.columns.forEach((col, i) => {
    if (produced.has(i) || col.from === null) return;
    const stack = [col.from];
    const seen = new Set<string>();
    while (stack.length > 0) {
      const id = stack.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      if (!reader.has(id)) reader.set(id, col.header);
      const c = computed.get(id);
      if (c) {
        const reads = new Set<string>();
        columnsRead(c.expr, reads);
        stack.push(...reads);
      }
    }
  });
  return reader;
}

/** Whether every element of `need` is (deep-)equal to a different element of `have` (a multiset containment). */
function containsAll(have: readonly unknown[], need: readonly unknown[]): boolean {
  const left = [...have];
  for (const n of need) {
    const at = left.findIndex((h) => deepEqual(h, n));
    if (at < 0) return false;
    left.splice(at, 1);
  }
  return true;
}

/**
 * Checks an answer (`result`) against the rules it had to keep (`fixed`). Returns one `fixedMismatch` problem per
 * thing that changed, went missing or was not produced - `[]` when the lock holds.
 */
export function checkFixedLock(result: LearnResult | Rules, fixed: LearnResult | Rules, opts: FixedLockOptions): FixedProblem[] {
  const r = plain(result);
  const f = plain(fixed);
  const parts = new Set<AiStepPartCode>(opts.parts);
  const produced = new Set<number>(opts.columns);
  const problems: FixedProblem[] = [];
  const problem = (path: string, message: string): void => void problems.push({ kind: 'fixedMismatch', path, message });

  // ---- input ----
  if (!deepEqual(r.input.sheet, f.input.sheet)) problem('input.sheet', 'the sheet choice is part of complete.fixed and must stay unchanged');
  if (!deepEqual(r.input.headerRow, f.input.headerRow)) problem('input.headerRow', 'headerRow is part of complete.fixed and must stay unchanged');
  if (!deepEqual(r.input.stopAt, f.input.stopAt)) problem('input.stopAt', 'stopAt is part of complete.fixed and must stay unchanged');
  for (const fc of f.input.columns) {
    const at = r.input.columns.findIndex((c) => c.id === fc.id);
    if (at < 0) problem('input.columns', `input column "${fc.id}" is part of complete.fixed and must not be removed`);
    else if (!deepEqual(r.input.columns[at], fc)) problem(`input.columns[${at}]`, `input column "${fc.id}" is part of complete.fixed and must stay unchanged`);
  }
  const rFilters = r.input.rowFilters ?? [];
  const fFilters = f.input.rowFilters ?? [];
  if (!containsAll(rFilters, fFilters)) problem('input.rowFilters', 'every row filter of complete.fixed must stay, unchanged');
  else if (!parts.has('droppedRows') && rFilters.length !== fFilters.length) problem('input.rowFilters', 'droppedRows is not listed in complete.parts, so no row filter may be added');

  // ---- transform ----
  const rt = r.transform;
  const ft = f.transform;
  if (ft.dedupe !== undefined ? !deepEqual(rt.dedupe, ft.dedupe) : rt.dedupe !== undefined && !parts.has('droppedRows')) {
    problem('transform.dedupe', ft.dedupe !== undefined ? 'dedupe is part of complete.fixed and must stay unchanged' : 'droppedRows is not listed in complete.parts, so dedupe must not be added');
  }
  if (ft.expand !== undefined ? !deepEqual(rt.expand, ft.expand) : rt.expand !== undefined && !parts.has('rows')) {
    problem('transform.expand', ft.expand !== undefined ? 'expand is part of complete.fixed and must stay unchanged' : 'rows is not listed in complete.parts, so expand must not be added');
  }
  for (const fc of ft.computed) {
    const at = rt.computed.findIndex((c) => c.id === fc.id);
    if (at < 0) problem('transform.computed', `computed column "${fc.id}" is part of complete.fixed and must not be removed`);
    else if (!deepEqual(rt.computed[at], fc)) problem(`transform.computed[${at}]`, `computed column "${fc.id}" is part of complete.fixed and must stay unchanged`);
  }
  if (!containsAll(rt.valueMaps, ft.valueMaps)) problem('transform.valueMaps', 'every value map of complete.fixed must stay, unchanged');
  else {
    // A value map changes its column for everything that reads it: a NEW one on a column a fixed output column reads would change that column.
    const reads = readByFixedColumns(f, produced);
    const left = [...ft.valueMaps];
    rt.valueMaps.forEach((vm, at) => {
      const i = left.findIndex((m) => deepEqual(m, vm));
      if (i >= 0) {
        left.splice(i, 1);
        return;
      }
      const header = reads.get(vm.column);
      if (header !== undefined) {
        problem(`transform.valueMaps[${at}]`, `a value map on "${vm.column}" would also change the fixed output column "${header}"; copy "${vm.column}" into a new computed column and map the copy`);
      }
    });
  }
  if (!parts.has('sort') ? !deepEqual(rt.sort, ft.sort) : !containsAll(rt.sort, ft.sort)) {
    problem('transform.sort', parts.has('sort') ? 'the sort keys of complete.fixed must stay' : 'sort is not listed in complete.parts, so it must stay as in complete.fixed');
  }
  const fg = ft.group;
  const rg = rt.group;
  if (fg === undefined) {
    if (rg !== undefined && !parts.has('group')) problem('transform.group', 'group is not listed in complete.parts, so no group may be added');
  } else if (rg === undefined) {
    problem('transform.group', 'the group of complete.fixed must not be removed');
  } else {
    if (!parts.has('group') && (rg.by !== fg.by || rg.showDetailRows !== fg.showDetailRows)) problem('transform.group', 'group.by and group.showDetailRows are part of complete.fixed and must stay unchanged');
    if (!parts.has('group') && !parts.has('blankRows') && (rg.blankRowsAfter ?? 0) !== (fg.blankRowsAfter ?? 0)) problem('transform.group.blankRowsAfter', 'blankRows is not listed in complete.parts, so blankRowsAfter must stay unchanged');
    const rs: SummaryRow[] = rg.summaryRows ?? [];
    const fs: SummaryRow[] = fg.summaryRows ?? [];
    if (!containsAll(rs, fs) || (!parts.has('group') && !parts.has('summaryRows') && rs.length !== fs.length)) {
      problem('transform.group.summaryRows', 'the group summary rows of complete.fixed must stay unchanged (summaryRows is not listed in complete.parts)');
    }
  }
  for (const fn of ft.functions ?? []) {
    const at = (rt.functions ?? []).findIndex((x) => x.name === fn.name);
    if (at < 0) problem('transform.functions', `function "${fn.name}" is part of complete.fixed and must not be removed`);
    else if (!deepEqual(rt.functions![at], fn)) problem(`transform.functions[${at}]`, `function "${fn.name}" is part of complete.fixed and must stay unchanged`);
  }
  for (const tb of ft.tables ?? []) {
    const at = (rt.tables ?? []).findIndex((x) => x.name === tb.name);
    if (at < 0) problem('transform.tables', `table "${tb.name}" is part of complete.fixed and must not be removed`);
    else if (!deepEqual(rt.tables![at], tb)) problem(`transform.tables[${at}]`, `table "${tb.name}" is part of complete.fixed and must stay unchanged`);
  }

  // ---- output ----
  const ro = r.output;
  const fo = f.output;
  if (!deepEqual(ro.file ?? DEFAULT_OUTPUT_FILE, fo.file ?? DEFAULT_OUTPUT_FILE)) problem('output.file', 'output.file is part of complete.fixed and must stay unchanged');
  if (ro.sheetName !== fo.sheetName) problem('output.sheetName', `output.sheetName must stay "${fo.sheetName}"`);
  if (ro.direction !== fo.direction) problem('output.direction', `output.direction must stay "${fo.direction}"`);
  if (ro.language !== fo.language) problem('output.language', `output.language must stay "${fo.language}"`);
  if (!deepEqual(ro.headerStyle, fo.headerStyle)) problem('output.headerStyle', 'output.headerStyle is part of complete.fixed and must stay unchanged');
  if (!parts.has('dateTitle') ? !deepEqual(ro.titleRows, fo.titleRows) : !containsAll(ro.titleRows, fo.titleRows)) {
    problem('output.titleRows', parts.has('dateTitle') ? 'the title rows of complete.fixed must stay' : 'dateTitle is not listed in complete.parts, so output.titleRows must stay as in complete.fixed');
  }
  const rSummary = ro.summaryRows ?? [];
  const fSummary = fo.summaryRows ?? [];
  if (!parts.has('summaryRows') ? !deepEqual(rSummary, fSummary) : !containsAll(rSummary, fSummary)) {
    problem('output.summaryRows', parts.has('summaryRows') ? 'the summary rows of complete.fixed must stay' : 'summaryRows is not listed in complete.parts, so output.summaryRows must stay as in complete.fixed');
  }
  if (ro.columns.length !== fo.columns.length) {
    problem('output.columns', `output.columns must keep its ${fo.columns.length} columns in order (got ${ro.columns.length})`);
  } else {
    fo.columns.forEach((fc, i) => {
      const rc = ro.columns[i]!;
      const path = `output.columns[${i}]`;
      if (rc.header !== fc.header) problem(`${path}.header`, `must stay "${fc.header}", got "${rc.header}"`);
      if (rc.format !== fc.format) problem(`${path}.format`, `must stay ${JSON.stringify(fc.format)}, got ${JSON.stringify(rc.format)}`);
      if (rc.width !== fc.width) problem(`${path}.width`, `must stay ${JSON.stringify(fc.width)}, got ${JSON.stringify(rc.width)}`);
      if (rc.agg !== fc.agg) problem(`${path}.agg`, `must stay ${JSON.stringify(fc.agg)}, got ${JSON.stringify(rc.agg)}`);
      if (produced.has(i)) {
        if (rc.from === null && !r.unsupported.some((u) => u.outputColumn === rc.header)) {
          problem(`${path}.from`, `output column "${rc.header}" is listed in complete.columns: give it a "from", or report it in unsupported`);
        }
      } else if (rc.from !== fc.from) {
        problem(`${path}.from`, `the "from" of "${fc.header}" is part of complete.fixed and must stay ${JSON.stringify(fc.from)}, got ${JSON.stringify(rc.from)}`);
      }
    });
  }

  // ---- validations and unsupported ----
  const have = new Set(r.validations.map(validationKey));
  for (const v of f.validations) {
    if (!have.has(validationKey(v))) problem('validations', `a check of complete.fixed is missing or changed (${v.rule} on "${v.column}")`);
  }
  const producedHeaders = new Set([...produced].map((i) => fo.columns[i]?.header).filter((h): h is string => h !== undefined));
  for (const u of f.unsupported) {
    if (producedHeaders.has(u.outputColumn)) continue; // a listed column may finally be produced
    if (!r.unsupported.some((x) => x.outputColumn === u.outputColumn && x.reasonCode === u.reasonCode)) {
      problem('unsupported', `the unsupported entry for "${u.outputColumn}" (${u.reasonCode}) is part of complete.fixed and must stay`);
    }
  }

  return problems;
}
