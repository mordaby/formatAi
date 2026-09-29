// The v1 engine: the fixed pipeline of SPEC 8.2, for rules that already passed
// schema validation and checkRules. Pure and synchronous; no clock, no
// randomness, no locale, all arithmetic in decimal.js.

import type { LearnResult } from '@formatai/shared';
import type { Flag, InputTable, RawCell, RunResult, RunSummary } from '../../types';
import { applyDedupe } from './dedupe';
import { applyExpand } from './expand';
import { compileFilter, type RowPredicate } from './filters';
import { buildSheet } from './layout';
import { colNorm, mapHeaders, newIssue, normalizeCell, type ColNorm, type NormIssue } from './normalize';
import { flagOrigin, slotOrThrow, type Row, type RunCtx, type SlotPlan } from './rows';
import { applySort } from './sort';
import { applyComputed, applyValueMaps } from './transform';
import { applyValidations } from './validate';
import type { Val } from './values';

export interface RunOptionsV1 {
  fileName?: string;
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
  return { slotOf, types, width: types.length };
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
  const ctx: RunCtx = { fileName: opts.fileName, language, date1904, plan };
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
    for (let ci = 0; ci < inCols.length; ci++) {
      const src = mapping.src[ci] as number;
      if (src < 0) continue; // missing optional column: stays empty
      const cell = raw[src];
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
    if (any) rows.push(row);
  }
  summary.rowsIn = rows.length;

  // 3. Row filters (ANDed).
  const filters = rules.input.rowFilters ?? [];
  if (filters.length > 0) {
    const preds: { slot: number; test: RowPredicate }[] = filters.map((f) => {
      const slot = slotOrThrow(plan, f.column);
      return { slot, test: compileFilter(f, norms[slot]!) };
    });
    const before = rows.length;
    rows = rows.filter((r) => preds.every((p) => p.test(r.v[p.slot] ?? null)));
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

  // 11 (run early, see validate.ts). Validations: flag, or block before any total is built.
  rows = applyValidations(ctx, rows, rules.validations, summary);

  // Flags, for the rows that reach the output, in input-row order.
  const flags: Flag[] = [];
  for (const r of rows) {
    if (!r.o.emitted) {
      r.o.emitted = true;
      if (r.o.flags !== null) for (const f of r.o.flags) flags.push(f);
    }
    if (r.flags !== null) for (const f of r.flags) flags.push(f);
  }

  // 8. Sort (stable).
  rows = applySort(ctx, rows, rules.transform.sort);

  // 9-10. Group and output layout.
  const { sheet, dataRows } = buildSheet(ctx, rules, rows);
  // DECISION: rowsOut counts data rows (detail or summary rows), not title,
  // header, blank, subtotal or grand-total rows.
  summary.rowsOut = dataRows;

  return { ok: true, sheet, flags, summary };
}
