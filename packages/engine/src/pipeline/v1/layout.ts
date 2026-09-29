// Steps 9-10 (SPEC 8.2, 8.6, 8.7, 8.12 v4): group, then the output sheet (title rows,
// header, data rows, summary rows, blank rows, direction, language).
// Cell encoding happens here, at the boundary: this is the only place a
// Decimal becomes a JS number.

import Decimal from 'decimal.js';
import type { LearnResult, OutputColumnRule, SummaryAgg, SummaryRow, TitleRow } from '@formatai/shared';
import type { CellRange, OutCell, OutputColumn, OutputSheet, OutRow, OutRowKind } from '../../types';
import { effectiveGroupSummaryRows, effectiveOutputSummaryRows } from '../../rules/summaryRows';
import { formatYmd, isExcelDateFormat, toExcelDateFormat } from '../../values/dates';
import { excelRound } from '../../values/numbers';
import { typeCat } from './normalize';
import { slotOrThrow, type Row, type RunCtx } from './rows';
import { cmpKeyPart, keyPart } from './sort';
import { DISPLAY_DATE_FORMAT, DateVal, canonicalKey, decInt, decText, toText, type Val } from './values';

type ColKind = 'number' | 'date' | 'text';

export interface OutCol {
  rule: OutputColumnRule;
  /** Row slot of `from`, or -1 for `from: null` (an empty column). */
  slot: number;
  kind: ColKind;
  /** Excel number format for this column's cells (dates: an Excel date format). */
  z: string | undefined;
  /** Excel date format used for date values. */
  dateZ: string;
  /** Format used to render date values as text (CSV). */
  dateFmt: string;
  /** Memo of rendered date texts by serial (dates repeat a lot). */
  dateText: Map<number, string>;
}

export function isDateFormat(fmt: string, lang: 'he' | 'en'): boolean {
  return isExcelDateFormat(toExcelDateFormat(fmt, lang));
}

function inferKind(rows: Row[], slot: number): ColKind {
  for (const r of rows) {
    const v = r.v[slot] ?? null;
    if (v === null) continue;
    if (v instanceof Decimal) return 'number';
    if (v instanceof DateVal) return 'date';
    return 'text';
  }
  return 'text';
}

export function planColumns(ctx: RunCtx, rules: LearnResult, rows: Row[]): OutCol[] {
  const lang = ctx.language;
  return rules.output.columns.map((rule) => {
    const slot = rule.from === null ? -1 : slotOrThrow(ctx.plan, rule.from);
    let kind: ColKind = 'text';
    if (slot >= 0) {
      const t = ctx.plan.types[slot];
      if (t === undefined) kind = inferKind(rows, slot);
      else {
        const cat = typeCat(t);
        kind = cat === 'number' ? 'number' : cat === 'date' ? 'date' : 'text';
      }
    }
    // Summary outputs: sum/count columns hold numbers whatever the source type.
    const group = rules.transform.group;
    if (group !== undefined && !group.showDetailRows && (rule.agg === 'sum' || rule.agg === 'count')) {
      kind = 'number';
    }
    const fmt = rule.format;
    const fmtIsDate = fmt !== undefined && isDateFormat(fmt, lang);
    // DECISION: date values in a column without a date format are written with
    // the default DD/MM/YYYY (SPEC 17), never as bare serial numbers.
    const dateFmt = fmtIsDate ? (fmt as string) : DISPLAY_DATE_FORMAT;
    const dateZ = toExcelDateFormat(dateFmt, lang);
    let z: string | undefined;
    if (kind === 'date') z = dateZ;
    else if (fmt !== undefined) z = fmtIsDate ? toExcelDateFormat(fmt, lang) : fmt;
    return { rule, slot, kind, z, dateZ, dateFmt, dateText: new Map<number, string>() };
  });
}

function numOut(d: Decimal): number {
  return d.isZero() ? 0 : d.toNumber();
}

function encode(v: Val, col: OutCol, lang: 'he' | 'en', flagged: boolean): OutCell {
  let cell: OutCell;
  if (v === null) cell = { v: null };
  else if (v instanceof Decimal) {
    cell = { v: numOut(v) };
    // A number kept as-is in a date column (failed parse) is not dressed as a date.
    if (col.z !== undefined && col.kind !== 'date') cell.z = col.z;
  } else if (v instanceof DateVal) {
    let text = col.dateText.get(v.serial);
    if (text === undefined) {
      text = formatYmd(v, col.dateFmt, lang);
      col.dateText.set(v.serial, text);
    }
    cell = { v: v.serial, isDate: true, z: col.dateZ, text };
  } else if (typeof v === 'string') {
    cell = { v };
    if (col.z !== undefined && col.kind !== 'date') cell.z = col.z;
  } else {
    cell = { v };
  }
  if (flagged) cell.flagged = true;
  return cell;
}

function emptyCells(n: number): OutCell[] {
  const cells: OutCell[] = new Array<OutCell>(n);
  for (let i = 0; i < n; i++) cells[i] = { v: null };
  return cells;
}

function dataRow(row: Row, cols: OutCol[], lang: 'he' | 'en'): OutRow {
  const cells: OutCell[] = new Array<OutCell>(cols.length);
  for (let i = 0; i < cols.length; i++) {
    const col = cols[i] as OutCol;
    if (col.slot < 0) {
      cells[i] = { v: null };
      continue;
    }
    const flagged = row.flagged !== null && row.flagged.has(col.slot);
    cells[i] = encode(row.v[col.slot] ?? null, col, lang, flagged);
  }
  return { kind: 'data', cells, sourceRow: row.o.rowNumber };
}

/** Sum of the numeric values (empty and non-numeric values are skipped); null when there are none. */
function sumSlot(rows: Row[], slot: number): Decimal | null {
  let acc: Decimal | null = null;
  for (const r of rows) {
    const v = r.v[slot];
    if (v instanceof Decimal) acc = acc === null ? v : acc.plus(v);
  }
  return acc;
}

/**
 * One column's aggregate over `rows` (SPEC 8.6 summary-output columns and SPEC 8.12 v4
 * summary rows share this set - v4 adds `average`/`last`). `count` counts non-empty
 * cells (blocked rows never reach `rows` at all, so they never count - unchanged);
 * `min`/`max` compare like `sort` (numbers and dates); `average` is the sum of the
 * numeric values divided by their count, in exact decimal.js precision (DECISION:
 * SPEC 8.12 v4 leaves rounding to the column's own number format, so the value itself
 * is never pre-rounded here); `first`/`last` are the first/last non-empty value, in
 * row order.
 */
function aggregateValue(rows: Row[], slot: number, agg: SummaryAgg): { v: Val; flagged: boolean } {
  const flagged = rows.some((r) => r.flagged !== null && r.flagged.has(slot));
  switch (agg) {
    case 'sum':
      return { v: sumSlot(rows, slot), flagged };
    case 'count': {
      let n = 0;
      for (const r of rows) if ((r.v[slot] ?? null) !== null) n++;
      return { v: decInt(n), flagged };
    }
    case 'average': {
      let sum: Decimal | null = null;
      let n = 0;
      for (const r of rows) {
        const v = r.v[slot];
        if (v instanceof Decimal) {
          sum = sum === null ? v : sum.plus(v);
          n++;
        }
      }
      return { v: sum === null ? null : sum.dividedBy(n), flagged };
    }
    case 'min':
    case 'max':
      return { v: extreme(rows, slot, agg), flagged };
    case 'first': {
      for (const r of rows) {
        const v = r.v[slot] ?? null;
        if (v !== null) return { v, flagged };
      }
      return { v: null, flagged };
    }
    case 'last': {
      let last: Val = null;
      for (const r of rows) {
        const v = r.v[slot] ?? null;
        if (v !== null) last = v;
      }
      return { v: last, flagged };
    }
  }
}

/** `aggregateValue` for a summary-output column (SPEC 8.6): the column's own `agg`,
 * defaulting to "first" (the group key's own column has none). */
function aggregateCol(rows: Row[], col: OutCol): { v: Val; flagged: boolean } {
  if (col.slot < 0) return { v: null, flagged: false };
  return aggregateValue(rows, col.slot, col.rule.agg ?? 'first');
}

/**
 * Renders one generic summary row (SPEC 8.12 v4): the label goes in `labelColumn`
 * (falling back to the first output column with no `cells` entry, then column 0 - the
 * same fallback the deprecated, id-based `grandTotal`/`subtotal` used), and each named
 * output column shows its aggregate over `rows` (the group's rows for
 * `group.summaryRows`, all rows for `output.summaryRows`). Cells that aren't listed in
 * `cells` are left empty, like today's grand total/subtotal.
 */
function buildSummaryRow(
  rows: Row[],
  summaryRow: SummaryRow,
  cols: OutCol[],
  lang: 'he' | 'en',
  kind: OutRowKind,
): OutRow {
  const cells = emptyCells(cols.length);
  let labelAt =
    summaryRow.labelColumn === undefined ? -1 : cols.findIndex((c) => c.rule.header === summaryRow.labelColumn);
  if (labelAt < 0) labelAt = cols.findIndex((c) => !(c.rule.header in summaryRow.cells));
  if (labelAt < 0) labelAt = 0;
  if (summaryRow.label !== undefined && summaryRow.label !== '' && cols.length > 0) {
    cells[labelAt] = { v: summaryRow.label };
  }
  cols.forEach((c, i) => {
    if (c.slot < 0) return;
    const agg = summaryRow.cells[c.rule.header];
    if (agg === undefined) return;
    // DECISION: like the deprecated grandTotal/subtotal before it, a summary-row cell
    // is never highlighted, even when a flagged row feeds its aggregate.
    const { v } = aggregateValue(rows, c.slot, agg);
    if (v !== null) cells[i] = encode(v, c, lang, false);
  });
  const row: OutRow = { kind, cells };
  if (summaryRow.bold === true) row.bold = true;
  return row;
}

/** Typed min/max over non-empty values (same ordering as sort). */
function extreme(rows: Row[], slot: number, which: 'min' | 'max'): Val {
  let best: Val = null;
  let bestKey = keyPart(null);
  for (const r of rows) {
    const v = r.v[slot] ?? null;
    if (v === null) continue;
    const k = keyPart(v);
    if (best === null) {
      best = v;
      bestKey = k;
      continue;
    }
    const c = cmpKeyPart(k, bestKey, false);
    if ((which === 'min' && c < 0) || (which === 'max' && c > 0)) {
      best = v;
      bestKey = k;
    }
  }
  return best;
}

// ---------- Title rows (SPEC 8.7) ----------

/**
 * Renders a number with a simple Excel number format ("0", "0.00", "#,##0.00",
 * "0%"): decimal places, thousands separators and percent. Used only for title
 * aggregates, which are text.
 */
export function formatNumberText(d: Decimal, fmt: string): string {
  const section = (fmt.split(';')[0] ?? '').replace(/"[^"]*"|\[[^\]]*\]|\\./g, '');
  if (/general/i.test(section) || !/[0#]/.test(section)) return decText(d);
  const percent = section.includes('%');
  let x = percent ? d.times(100) : d;
  const dot = section.indexOf('.');
  const decimals = dot >= 0 ? (section.slice(dot + 1).match(/[0#]/g)?.length ?? 0) : 0;
  x = excelRound(x, decimals);
  let s = x.abs().toFixed(decimals);
  if (section.includes(',')) {
    const [intPart, frac] = s.split('.') as [string, string | undefined];
    const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    s = frac === undefined ? grouped : `${grouped}.${frac}`;
  }
  return (x.isNegative() && !x.isZero() ? '-' : '') + s + (percent ? '%' : '');
}

function titleText(ctx: RunCtx, tr: Extract<TitleRow, { parts: unknown }>, rows: Row[]): string {
  let out = '';
  for (const p of tr.parts) {
    if ('text' in p) {
      out += p.text;
      continue;
    }
    const v = extreme(rows, slotOrThrow(ctx.plan, p.column), p.agg);
    if (v === null) continue;
    if (v instanceof DateVal) out += formatYmd(v, p.format, ctx.language);
    else if (v instanceof Decimal) out += formatNumberText(v, p.format);
    else out += toText(v);
  }
  return out;
}

// ---------- Sheet ----------

/**
 * Builds the output sheet from the final rows (already filtered, expanded,
 * computed, mapped, validated and sorted).
 */
export function buildSheet(ctx: RunCtx, rules: LearnResult, rows: Row[]): { sheet: OutputSheet; dataRows: number } {
  const lang = ctx.language;
  const out = rules.output;
  const cols = planColumns(ctx, rules, rows);
  const n = cols.length;
  const sheetRows: OutRow[] = [];
  const merges: CellRange[] = [];

  // Title rows: one text cell merged across all output columns.
  for (const tr of out.titleRows) {
    if ('blank' in tr) {
      sheetRows.push({ kind: 'blank', cells: emptyCells(n) });
      continue;
    }
    const text = 'parts' in tr ? titleText(ctx, tr, rows) : tr.text;
    const cells = emptyCells(n);
    if (n > 0) cells[0] = text === '' ? { v: null } : { v: text };
    const row: OutRow = { kind: 'title', cells };
    if (tr.bold === true) {
      row.bold = true;
      if (n > 0) (cells[0] as OutCell).bold = true;
    }
    if (n > 1) merges.push({ s: { r: sheetRows.length, c: 0 }, e: { r: sheetRows.length, c: n - 1 } });
    sheetRows.push(row);
  }

  // Header row.
  const header: OutRow = { kind: 'header', cells: cols.map((c) => ({ v: c.rule.header })) };
  if (out.headerStyle?.bold === true) header.bold = true;
  sheetRows.push(header);

  // Body.
  let dataRows = 0;
  const group = rules.transform.group;
  // SPEC 8.12 v4: `output.summaryRows` as written, or the deprecated `grandTotal`
  // translated (SPEC 21 v4) - computed once, since it's also needed below to decide
  // whether a blank row follows the last group.
  const outputSummary = effectiveOutputSummaryRows(out, group);
  if (group === undefined) {
    for (const r of rows) sheetRows.push(dataRow(r, cols, lang));
    dataRows = rows.length;
  } else {
    // DECISION: groups appear in sorted order, by the first appearance of each
    // key; rows with the same key that aren't contiguous after the sort are
    // gathered into their key's group (keeping their relative order).
    const bySlot = slotOrThrow(ctx.plan, group.by);
    const order: Row[][] = [];
    const index = new Map<string, number>();
    for (const r of rows) {
      const k = canonicalKey(r.v[bySlot] ?? null);
      let gi = index.get(k);
      if (gi === undefined) {
        gi = order.length;
        index.set(k, gi);
        order.push([]);
      }
      (order[gi] as Row[]).push(r);
    }
    const blanks = group.blankRowsAfter ?? 0;
    // SPEC 8.12 v4: `group.summaryRows` as written, or the deprecated `subtotal`
    // translated (SPEC 21 v4) - same list after every group.
    const groupSummary = effectiveGroupSummaryRows(group, rules.output.columns);
    order.forEach((g, gi) => {
      if (group.showDetailRows) {
        for (const r of g) sheetRows.push(dataRow(r, cols, lang));
        dataRows += g.length;
      } else {
        // Summary output (SPEC 8.6): one row per group.
        const cells = cols.map((c) => {
          const a = aggregateCol(g, c);
          return c.slot < 0 ? { v: null } : encode(a.v, c, lang, a.flagged);
        });
        // sourceRow: the group's first input row, so the UI can point at it.
        sheetRows.push({ kind: 'data', cells, sourceRow: (g[0] as Row).o.rowNumber });
        dataRows++;
      }
      // SPEC 8.12 v4: summary rows after each group, in order, before blankRowsAfter.
      for (const sr of groupSummary.rows) {
        sheetRows.push(buildSummaryRow(g, sr, cols, lang, groupSummary.legacyKind ?? 'summaryRow'));
      }
      // DECISION: blankRowsAfter follows every group, including the last one
      // when output-level summary rows come next; trailing blank rows at the
      // very end of the sheet are not written.
      const isLast = gi === order.length - 1;
      if (!isLast || outputSummary.rows.length > 0) {
        for (let b = 0; b < blanks; b++) sheetRows.push({ kind: 'blank', cells: emptyCells(n) });
      }
    });
  }

  // SPEC 8.12 v4: summary rows after all data rows, in order.
  for (const sr of outputSummary.rows) {
    sheetRows.push(buildSummaryRow(rows, sr, cols, lang, outputSummary.legacyKind ?? 'summaryRow'));
  }

  const columns: OutputColumn[] = cols.map((c) => {
    const oc: OutputColumn = { header: c.rule.header };
    if (c.rule.width !== undefined) oc.width = c.rule.width;
    if (c.z !== undefined) oc.format = c.z;
    if (c.kind === 'number') oc.numeric = true;
    return oc;
  });

  return {
    sheet: {
      name: out.sheetName,
      // SPEC 8.13: absent `output.file` means xlsx; leave OutputSheet.file
      // absent too (rather than present-and-undefined) so writeOutput's own
      // "absent -> xlsx" default is the only place that default lives.
      ...(out.file !== undefined ? { file: out.file } : {}),
      direction: out.direction,
      language: out.language,
      columns,
      rows: sheetRows,
      merges,
    },
    dataRows,
  };
}
