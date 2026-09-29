// Steps 9-10 (SPEC 8.2, 8.6, 8.7): group, then the output sheet (title rows,
// header, data rows, subtotals, blank rows, grand total, direction, language).
// Cell encoding happens here, at the boundary: this is the only place a
// Decimal becomes a JS number.

import Decimal from 'decimal.js';
import type { GrandTotal, GroupSubtotal, LearnResult, OutputColumnRule, TitleRow } from '@formatai/shared';
import type { CellRange, OutCell, OutputColumn, OutputSheet, OutRow } from '../../types';
import { formatYmd, isExcelDateFormat, toExcelDateFormat } from '../../values/dates';
import { excelRound } from '../../values/numbers';
import { typeCat } from './normalize';
import { slotOrThrow, type Row, type RunCtx } from './rows';
import { cmpKeyPart, keyPart } from './sort';
import { DISPLAY_DATE_FORMAT, DateVal, canonicalKey, decInt, decText, toText, type Val } from './values';

type ColKind = 'number' | 'date' | 'text';

interface OutCol {
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

function isDateFormat(fmt: string, lang: 'he' | 'en'): boolean {
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

function planColumns(ctx: RunCtx, rules: LearnResult, rows: Row[]): OutCol[] {
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

/** Subtotal / grand-total row: the label in the label column, sums in the summed columns. */
function totalRow(
  kind: 'subtotal' | 'grandTotal',
  rows: Row[],
  spec: GroupSubtotal | GrandTotal,
  cols: OutCol[],
  lang: 'he' | 'en',
  summaryMode = false,
): OutRow {
  const cells = emptyCells(cols.length);
  const sumIds = new Set(spec.sum);
  // DECISION: the label goes in the first output column showing labelColumn;
  // if no output column shows it, in the first output column that isn't summed.
  let labelAt = cols.findIndex((c) => c.rule.from === spec.labelColumn);
  if (labelAt < 0) labelAt = cols.findIndex((c) => c.rule.from === null || !sumIds.has(c.rule.from));
  if (labelAt < 0) labelAt = 0;
  if (spec.label !== '' && cols.length > 0) cells[labelAt] = { v: spec.label };
  cols.forEach((c, i) => {
    if (c.rule.from === null || !sumIds.has(c.rule.from)) return;
    let s: Decimal | null;
    if (!summaryMode) s = sumSlot(rows, c.slot);
    else {
      // DECISION: in a summary output the grand total adds up the summary
      // column itself: sum columns get the total sum, count columns the total
      // count; min/max/first columns stay empty.
      const agg = c.rule.agg ?? 'first';
      if (agg === 'sum') s = sumSlot(rows, c.slot);
      else if (agg === 'count') s = aggregate(rows, c).v as Decimal;
      else s = null;
    }
    if (s !== null) cells[i] = encode(s, c, lang, false);
  });
  return { kind, cells };
}

/** Aggregate for a summary output column (SPEC 8.6). */
function aggregate(rows: Row[], col: OutCol): { v: Val; flagged: boolean } {
  if (col.slot < 0) return { v: null, flagged: false };
  const slot = col.slot;
  const flagged = rows.some((r) => r.flagged !== null && r.flagged.has(slot));
  // DECISION: a summary column without `agg` uses "first"; "first" is the first
  // non-empty value of the group; "count" counts non-empty values (like COUNTA).
  const agg = col.rule.agg ?? 'first';
  switch (agg) {
    case 'sum':
      return { v: sumSlot(rows, slot), flagged };
    case 'count': {
      let n = 0;
      for (const r of rows) if ((r.v[slot] ?? null) !== null) n++;
      return { v: decInt(n), flagged };
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
  }
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
    order.forEach((g, gi) => {
      if (group.showDetailRows) {
        for (const r of g) sheetRows.push(dataRow(r, cols, lang));
        dataRows += g.length;
        if (group.subtotal !== undefined) sheetRows.push(totalRow('subtotal', g, group.subtotal, cols, lang));
      } else {
        // Summary output (SPEC 8.6): one row per group; the subtotal spec does
        // not apply (the summary row is the total).
        const cells = cols.map((c) => {
          const a = aggregate(g, c);
          return c.slot < 0 ? { v: null } : encode(a.v, c, lang, a.flagged);
        });
        // sourceRow: the group's first input row, so the UI can point at it.
        sheetRows.push({ kind: 'data', cells, sourceRow: (g[0] as Row).o.rowNumber });
        dataRows++;
      }
      // DECISION: blankRowsAfter follows every group, including the last one
      // when a grand total comes next; trailing blank rows at the very end of
      // the sheet are not written.
      const isLast = gi === order.length - 1;
      if (!isLast || out.grandTotal !== undefined) {
        for (let b = 0; b < blanks; b++) sheetRows.push({ kind: 'blank', cells: emptyCells(n) });
      }
    });
  }

  if (out.grandTotal !== undefined) {
    const summaryMode = group !== undefined && !group.showDetailRows;
    sheetRows.push(totalRow('grandTotal', rows, out.grandTotal, cols, lang, summaryMode));
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
      direction: out.direction,
      language: out.language,
      columns,
      rows: sheetRows,
      merges,
    },
    dataRows,
  };
}
