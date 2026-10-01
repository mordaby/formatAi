// The v1 engine: the fixed pipeline of SPEC 8.2, for rules that already passed
// schema validation and checkRules. Pure and synchronous; no clock, no
// randomness, no locale, all arithmetic in decimal.js.

import type { LearnResult } from '@formatai/shared';
import type { Flag, InputTable, RawCell, RowDecisions, RunResult, RunSummary } from '../../types';
import { applyDedupe } from './dedupe';
import { applyExpand } from './expand';
import { compileFunctions, compileTables, type CompileEnv } from './expr';
import { compileExprFilter, compileFilter } from './filters';
import { buildSheet, planColumns } from './layout';
import { colNorm, mapHeaders, newIssue, normalizeCell, type ColNorm, type NormIssue } from './normalize';
import { flagOrigin, slotOrThrow, type Row, type RunCtx, type SlotPlan } from './rows';
import { applySort } from './sort';
import { applyComputed, applyValueMaps } from './transform';
import { countWindows } from './window';
import { applyOutputValidations, applyValidations } from './validate';
import type { Val } from './values';

export interface RunOptionsV1 {
  fileName?: string;
  /** SPEC 21 v5 item 5: per-run decisions about input rows, applied without touching the rules. */
  rowDecisions?: RowDecisions;
}

/** A per-run decision, after checking the shape (they come from the UI, so they are untrusted). */
type Decision = { kind: 'skip' } | { kind: 'keep' } | { kind: 'override'; values: Map<string, string | number | boolean | null> };

function readDecisions(raw: RowDecisions | undefined): Map<number, Decision> {
  const out = new Map<number, Decision>();
  if (raw === undefined || raw === null || typeof raw !== 'object') return out;
  for (const key of Object.keys(raw)) {
    const rowNumber = Number(key);
    if (!Number.isInteger(rowNumber) || rowNumber < 1) continue;
    const d = (raw as Record<string, unknown>)[key];
    if (typeof d !== 'object' || d === null) continue;
    const action = (d as { action?: unknown }).action;
    if (action === 'skip') out.set(rowNumber, { kind: 'skip' });
    else if (action === 'keep') out.set(rowNumber, { kind: 'keep' });
    else if (action === 'override') {
      const vals = (d as { values?: unknown }).values;
      if (typeof vals !== 'object' || vals === null) continue;
      const values = new Map<string, string | number | boolean | null>();
      for (const k of Object.keys(vals)) {
        const v = (vals as Record<string, unknown>)[k];
        if (v === null || typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))) values.set(k, v);
      }
      if (values.size > 0) out.set(rowNumber, { kind: 'override', values });
    }
  }
  return out;
}

/** The cell an override value becomes: read by the column's type like any file cell. A number given for a
 * real date cell stays a date serial. */
function overrideCell(orig: RawCell | null | undefined, v: string | number | boolean | null): RawCell | null {
  if (v === null) return null;
  if (typeof v === 'number' && orig?.isDate === true) return { v, isDate: true, ...(orig.z !== undefined ? { z: orig.z } : {}) };
  return { v };
}

/**
 * Assigns every column id a row slot: input columns first (slot = position in
 * input.columns), then ids created by expand, then computed ids.
 */
export function planSlots(rules: LearnResult): SlotPlan {
  const slotOf = new Map<string, number>();
  const types: SlotPlan['types'] = [];
  const add = (id: string, type: SlotPlan['types'][number]): void => {
    if (slotOf.has(id)) return;
    slotOf.set(id, types.length);
    types.push(type);
  };
  for (const c of rules.input.columns) add(c.id, c.type);
  const ex = rules.transform.expand;
  if (ex !== undefined) {
    if (ex.mode === 'columnsToRows') {
      add(ex.labelId, 'text');
      add(ex.valueId, ex.valueType);
    } else if (ex.mode === 'splitCell') {
      add(ex.partId, 'text');
      if (ex.indexId !== undefined) add(ex.indexId, 'integer');
      if (ex.countId !== undefined) add(ex.countId, 'integer');
    } else {
      // New ids get no declared type (inferred from values at output);
      // overwritten ids keep theirs.
      for (const r of ex.rows) for (const id of Object.keys(r.set)) add(id, undefined);
    }
  }
  for (const c of rules.transform.computed) add(c.id, c.type);
  const windowBase = types.length;
  return { slotOf, types, width: windowBase + countWindows(rules.transform.computed), windowBase };
}

interface MemoEntry {
  v: Val;
  key: string | null;
  suggestion: string | number | undefined;
}

class CellMemo {
  private readonly plain = new Map<string | number, MemoEntry>();
  private readonly dates = new Map<string | number, MemoEntry>();

  normalize(cell: RawCell | null | undefined, norm: ColNorm, issue: NormIssue): Val {
    const rv = cell?.v;
    if (cell === null || cell === undefined || rv === null || rv === undefined || typeof rv === 'boolean') {
      return normalizeCell(cell, norm, issue);
    }
    const map = typeof rv === 'number' && cell.isDate === true ? this.dates : this.plain;
    let e = map.get(rv);
    if (e === undefined) {
      const v = normalizeCell(cell, norm, issue);
      e = { v, key: issue.key, suggestion: issue.suggestion };
      map.set(rv, e);
    } else {
      issue.key = e.key;
      issue.suggestion = e.suggestion;
    }
    return e.v;
  }
}

export function runV1(rules: LearnResult, table: InputTable, opts: RunOptionsV1 = {}): RunResult {
  const language = rules.output.language;
  const date1904 = table.date1904 === true;
  const plan = planSlots(rules);
  // transform.functions/tables (SPEC 8.14): compiled once, shared by every
  // expression in the rules file (row filters, computed columns, fixedFanOut).
  const tables = compileTables(rules.transform.tables);
  const functions = compileFunctions(rules.transform.functions, { language }, tables);
  const decisions = readDecisions(opts.rowDecisions);
  const keepRows = new Set<number>();
  const skipRows = new Set<number>();
  for (const [rowNumber, d] of decisions) {
    if (d.kind === 'keep') keepRows.add(rowNumber);
    else if (d.kind === 'skip') skipRows.add(rowNumber);
  }
  const ctx: RunCtx = { fileName: opts.fileName, language, date1904, plan, functions, tables, keepRows };
  const inCols = rules.input.columns;

  // 1. Read: map headers to ids.
  const mapping = mapHeaders(inCols, table.headers);
  if (mapping.missingRequired.length > 0) {
    return {
      ok: false,
      error: {
        code: 'missingRequiredColumns',
        missing: mapping.missingRequired,
        params: { count: mapping.missingRequired.length },
      },
    };
  }

  const summary: RunSummary = {
    rowsIn: 0,
    rowsOut: 0,
    rowsFiltered: 0,
    duplicatesRemoved: [],
    duplicatesFlagged: 0,
    blockedRows: [],
  };
  if (opts.rowDecisions !== undefined) {
    summary.skippedByUser = [];
    summary.editedByUser = [];
    summary.acceptedByUser = [];
  }

  // Row-decision overrides address an input column by id or header (the rules' own, or the file's).
  const colByKey = new Map<string, number>();
  if (decisions.size > 0) {
    inCols.forEach((c, ci) => colByKey.set(c.id, ci));
    inCols.forEach((c, ci) => {
      if (c.header !== '' && !colByKey.has(c.header)) colByKey.set(c.header, ci);
    });
    inCols.forEach((_, ci) => {
      const h = mapping.src[ci] as number;
      const fileHeader = h >= 0 ? table.headers[h] : undefined;
      if (fileHeader !== undefined && fileHeader !== '' && !colByKey.has(fileHeader)) colByKey.set(fileHeader, ci);
    });
  }

  // 2. Normalize types. Input column i lives in slot i.
  const norms = inCols.map((c) => colNorm(c, date1904, language));
  const issue = newIssue();
  // Per-column memo of normalizeCell for repeated raw values (dates, amounts,
  // ids repeat a lot). normalizeCell is pure, and DateVal/Decimal are immutable,
  // so sharing results between rows is safe. Text columns need no work.
  const memos = norms.map((n) => (n.cat === 'text' ? null : new CellMemo()));
  let rows: Row[] = [];
  for (let ri = 0; ri < table.rows.length; ri++) {
    const raw = table.rows[ri] ?? [];
    const v = new Array<Val>(plan.width).fill(null);
    const row: Row = {
      v,
      o: { rowNumber: table.rowNumbers[ri] ?? ri + 1, flags: null, emitted: false },
      flags: null,
      flagged: null,
    };
    let any = false;
    // SPEC 21 v5 item 5: a one-off value edit replaces the cells BEFORE normalization, so the row
    // is read (and flagged) exactly as if the file had held these values.
    const decision = decisions.get(row.o.rowNumber);
    let overrides: Map<number, string | number | boolean | null> | null = null;
    if (decision?.kind === 'override') {
      for (const [key, value] of decision.values) {
        const ci = colByKey.get(key);
        if (ci === undefined) continue;
        if (overrides === null) overrides = new Map();
        overrides.set(ci, value);
      }
    }
    for (let ci = 0; ci < inCols.length; ci++) {
      const src = mapping.src[ci] as number;
      let cell: RawCell | null | undefined = src < 0 ? undefined : raw[src];
      if (overrides !== null && overrides.has(ci)) cell = overrideCell(cell, overrides.get(ci) ?? null);
      else if (src < 0) continue; // missing optional column: stays empty
      const memo = memos[ci];
      const val = memo ? memo.normalize(cell, norms[ci]!, issue) : normalizeCell(cell, norms[ci]!, issue);
      if (val === null) continue;
      any = true;
      v[ci] = val;
      if (issue.key !== null) {
        const col = inCols[ci]!;
        flagOrigin(ctx, row, ci, {
          column: col.id,
          rule: 'type',
          value: cell?.v ?? null,
          messageKey: issue.key,
          params: { type: col.type },
          ...(issue.suggestion !== undefined ? { suggestion: issue.suggestion } : {}),
        });
      }
    }
    // DECISION: an input row whose mapped cells are all empty (a spacer row
    // inside the data) is skipped and not counted in rowsIn.
    if (any) {
      rows.push(row);
      if (overrides !== null) {
        summary.editedByUser?.push({ rowNumber: row.o.rowNumber, columns: [...overrides.keys()].sort((a, b) => a - b).map((ci) => inCols[ci]!.id) });
      }
    }
  }
  summary.rowsIn = rows.length;

  // Rows the user skipped for this run leave here, as if they weren't in the file (before filters
  // and duplicates, so a skipped row is never the "kept" copy of a duplicate).
  if (skipRows.size > 0) {
    rows = rows.filter((row) => {
      if (!skipRows.has(row.o.rowNumber)) return true;
      summary.skippedByUser?.push({ rowNumber: row.o.rowNumber });
      return false;
    });
  }

  // 3. Row filters (ANDed). SPEC 8.3: `{ column, op, value? }` for simple cases,
  // or `{ expr }` (any condition) for the rest.
  const filters = rules.input.rowFilters ?? [];
  if (filters.length > 0) {
    const exprEnv: CompileEnv = { slotOf: plan.slotOf, language, functions, tables };
    const preds: ((row: Row) => boolean)[] = filters.map((f) => {
      if ('expr' in f) {
        const test = compileExprFilter(f.expr, exprEnv);
        return (row) => test(row.v);
      }
      const slot = slotOrThrow(plan, f.column);
      const test = compileFilter(f, norms[slot]!);
      return (row) => test(row.v[slot] ?? null);
    });
    const before = rows.length;
    rows = rows.filter((row) => preds.every((p) => p(row)));
    summary.rowsFiltered = before - rows.length;
  }

  // 4. Duplicates.
  const dedupe = rules.transform.dedupe;
  if (dedupe !== undefined) {
    const ids = dedupe.keys === 'all' ? inCols.map((c) => c.id) : dedupe.keys;
    rows = applyDedupe(ctx, rows, dedupe, { ids, slots: ids.map((id) => slotOrThrow(plan, id)) }, summary);
  }

  // 5. Expand.
  if (rules.transform.expand !== undefined) rows = applyExpand(ctx, rows, rules.transform.expand, inCols);

  // 6. Computed columns (after expand: once per new row).
  applyComputed(ctx, rows, rules.transform.computed);

  // 7. Value maps.
  applyValueMaps(ctx, rows, rules.transform.valueMaps);

  // 11a (run early, see validate.ts). Input validations: flag, or block before any total is built.
  rows = applyValidations(ctx, rows, rules.validations, summary);
  // Keep this order (pre-sort, in whatever order dedupe/expand/computed left
  // the rows) so flags are reported in input-row order regardless of the
  // output sort -- captured now, read after output validations below, since
  // sort only reorders the array and doesn't touch the Row objects themselves.
  const preSortRows = rows;

  // 8. Sort (stable).
  rows = applySort(ctx, rows, rules.transform.sort);

  // 11b. Output validations (SPEC 8.8): `column` names an output header, so
  // they run once the output columns are planned -- and *before* group/
  // subtotal/grand-total, so a blocked row is excluded from every total
  // (buildSheet only ever aggregates the `rows` it's handed; see validate.ts).
  const outCols = planColumns(ctx, rules, rows);
  rows = applyOutputValidations(ctx, rows, outCols, rules.validations, summary);
  // Across-row (window) values were calculated over the rows of step 6, blocked ones included (validations run after, and may read
  // those very values), so a total or running balance counts rows the output leaves out. Say so, as a count.
  if (plan.width > plan.windowBase && summary.blockedRows.length > 0) summary.blockedInWindows = summary.blockedRows.length;

  // Flags, for the rows that reach the output, in input-row order: a row
  // dropped by an output-severity block (kept out of `rows` above) drops its
  // flags too, just like an input-severity block already does.
  const survived = new Set(rows);
  const flags: Flag[] = [];
  for (const r of preSortRows) {
    if (!survived.has(r)) continue;
    if (!r.o.emitted) {
      r.o.emitted = true;
      if (r.o.flags !== null) for (const f of r.o.flags) flags.push(f);
    }
    if (r.flags !== null) for (const f of r.flags) flags.push(f);
  }

  // SPEC 21 v5 item 5: "keep it as is" accepts the flags of those rows for this run. They stay in the
  // list (marked `accepted`), but the cells are no longer highlighted.
  if (keepRows.size > 0) {
    const perRow = new Map<number, number>();
    for (const f of flags) {
      if (!keepRows.has(f.rowNumber)) continue;
      f.accepted = true;
      perRow.set(f.rowNumber, (perRow.get(f.rowNumber) ?? 0) + 1);
    }
    for (const r of rows) if (keepRows.has(r.o.rowNumber)) r.flagged = null;
    if (summary.acceptedByUser !== undefined) {
      for (const rowNumber of [...perRow.keys()].sort((a, b) => a - b)) summary.acceptedByUser.push({ rowNumber, flags: perRow.get(rowNumber) as number });
    }
  }

  // 9-10. Group and output layout.
  const { sheet, dataRows } = buildSheet(ctx, rules, rows);
  // DECISION: rowsOut counts data rows (detail or summary rows), not title,
  // header, blank, subtotal or grand-total rows.
  summary.rowsOut = dataRows;

  return { ok: true, sheet, flags, summary };
}
