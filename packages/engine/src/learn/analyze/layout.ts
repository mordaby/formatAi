// Output layout (SPEC 6.2 step 5): title rows (and the dates in them), blank-row
// rules, the group-by column, summary rows with per-column aggregates verified
// on every group, sort order, header style, formats, direction and language.

import type { RawSheet } from '../../types';
import { formatYmd } from '../../values/dates';
import {
  BOOL,
  DATE,
  EMPTY,
  NUM,
  TEXT,
  isEmptyRaw,
  keys,
  norms,
  rawText,
  ymdOfSerial,
  type ColumnData,
} from './cells';
import { aggHolds } from './relations';
import type {
  Alignment,
  ColumnProfile,
  LayoutAnalysis,
  OutputSide,
  SummaryAgg,
  SummaryRowAnalysis,
  TitlePart,
  TitleRowAnalysis,
} from './types';

export interface LayoutInput {
  out: Omit<OutputSide, 'profile'>;
  outProfile: ColumnProfile[];
  /** Output columns over every sheet row. */
  all: ColumnData[];
  /** Output columns over the data rows. */
  data: ColumnData[];
  inCols: ColumnData[];
  inProfile: ColumnProfile[];
  alignment: Alignment;
  /** Input rows that reach the output (title dates are taken over these). */
  keptRows: number[];
  /** Summary shape: the group column. */
  summaryGroupOut: number | null;
}

// ---------- title rows ----------

const TITLE_DATE_FORMATS = [
  'DD/MM/YYYY', 'D/M/YYYY', 'DD.MM.YYYY', 'YYYY-MM-DD', 'MM/DD/YYYY', 'MMMM YYYY', 'MMM YYYY', 'MM/YYYY', 'M/YYYY',
  'MM.YYYY', 'MM-YYYY', 'YYYY-MM', 'MMMM', 'YYYY',
];

const WORD_CHAR = /[\p{L}\p{N}]/u;

interface DateHit {
  start: number;
  end: number;
  in: number;
  agg: 'min' | 'max';
  format: string;
  language: 'he' | 'en';
}

function cellDisplay(sheet: RawSheet, r: number, c: number): string {
  const cell = sheet.rows[r]?.[c];
  if (!cell || isEmptyRaw(cell)) return '';
  if (cell.isDate && typeof cell.v === 'number') return formatYmd(ymdOfSerial(Math.trunc(cell.v)), cell.z ?? 'dd/mm/yyyy', 'en');
  return rawText(cell).trim();
}

/** Dates (min/max of an input date column, in a known format) that appear in the title text. */
function titleDates(text: string, dateCols: { in: number; min: number; max: number }[], language: 'he' | 'en'): DateHit[] {
  const hits: DateHit[] = [];
  const langs: ('he' | 'en')[] = language === 'he' ? ['he', 'en'] : ['en', 'he'];
  for (const dc of dateCols) {
    for (const agg of ['min', 'max'] as const) {
      const ymd = ymdOfSerial(agg === 'min' ? dc.min : dc.max);
      for (const format of TITLE_DATE_FORMATS) {
        for (const lang of /MMM/.test(format) ? langs : [langs[0]!]) {
          const rendered = formatYmd(ymd, format, lang);
          let at = text.indexOf(rendered);
          while (at >= 0) {
            const before = at > 0 ? text[at - 1]! : '';
            const after = text[at + rendered.length] ?? '';
            if (!WORD_CHAR.test(before) && !WORD_CHAR.test(after)) {
              hits.push({ start: at, end: at + rendered.length, in: dc.in, agg, format, language: lang });
              break;
            }
            at = text.indexOf(rendered, at + 1);
          }
        }
      }
    }
  }
  // Longest match first; then earliest; min before max; lower column; preferred language.
  hits.sort(
    (a, b) =>
      b.end - b.start - (a.end - a.start) ||
      a.start - b.start ||
      (a.agg === b.agg ? 0 : a.agg === 'min' ? -1 : 1) ||
      a.in - b.in ||
      (a.language === b.language ? 0 : a.language === language ? -1 : 1),
  );
  const chosen: DateHit[] = [];
  for (const h of hits) {
    if (chosen.length >= 2) break;
    if (chosen.some((c) => h.start < c.end && c.start < h.end)) continue;
    chosen.push(h);
  }
  return chosen.sort((a, b) => a.start - b.start);
}

function analyzeTitles(x: LayoutInput, language: 'he' | 'en'): TitleRowAnalysis[] {
  const { out } = x;
  if (out.headerless || out.headerRow <= 0) return [];
  const dateCols: { in: number; min: number; max: number }[] = [];
  x.inProfile.forEach((p, i) => {
    if (p.type !== 'date') return;
    const col = x.inCols[i]!;
    let min = Infinity;
    let max = -Infinity;
    const rows = x.keptRows.length > 0 ? x.keptRows : Array.from({ length: col.n }, (_, r) => r);
    for (const r of rows) {
      const d = col.date[r]!;
      if (Number.isNaN(d)) continue;
      if (d < min) min = d;
      if (d > max) max = d;
    }
    if (min !== Infinity) dateCols.push({ in: i, min, max });
  });
  const titles: TitleRowAnalysis[] = [];
  for (let r = 0; r < out.headerRow; r++) {
    if (out.rowKinds[r] === 'blank') {
      titles.push({ row: r, blank: true });
      continue;
    }
    const row = out.sheet.rows[r] ?? [];
    const texts: string[] = [];
    let bold = true;
    for (let c = 0; c < row.length; c++) {
      if (isEmptyRaw(row[c])) continue;
      texts.push(cellDisplay(out.sheet, r, c));
      if (!row[c]!.bold) bold = false;
    }
    const text = texts.join(' ');
    const t: TitleRowAnalysis = { row: r, text };
    if (bold && texts.length > 0) t.bold = true;
    const hits = titleDates(text, dateCols, language);
    if (hits.length > 0) {
      const h0 = hits[0]!;
      t.containsDate = { in: h0.in, agg: h0.agg, format: h0.format };
      const parts: TitlePart[] = [];
      let pos = 0;
      for (const h of hits) {
        if (h.start > pos) parts.push({ text: text.slice(pos, h.start) });
        parts.push({ in: h.in, agg: h.agg, format: h.format, language: h.language });
        pos = h.end;
      }
      if (pos < text.length) parts.push({ text: text.slice(pos) });
      t.parts = parts;
    }
    titles.push(t);
  }
  return titles;
}

// ---------- groups, blank rows and summary rows ----------

interface Block {
  data: number[];
  summaries: number[];
  blanksAfter: number[];
}

function rowBold(sheet: RawSheet, r: number): boolean {
  const row = sheet.rows[r] ?? [];
  let any = false;
  for (const c of row) {
    if (isEmptyRaw(c)) continue;
    if (!c!.bold) return false;
    any = true;
  }
  return any;
}

const NUMERIC_AGGS: SummaryAgg[] = ['sum', 'count', 'average', 'min', 'max', 'first', 'last'];
const DATE_AGGS: SummaryAgg[] = ['min', 'max', 'first', 'last'];
const TEXT_AGGS: SummaryAgg[] = ['first', 'last'];

/** One summary row kind (the j-th summary row of every group, or one row at the end), verified on every occurrence. */
function summaryRow(all: ColumnData[], sheet: RawSheet, occ: { row: number; group: number[] }[]): SummaryRowAnalysis {
  const first = occ[0]!.row;
  const holdsAll = (c: number, fn: SummaryAgg): boolean => occ.every((o) => aggHolds(all[c]!, o.group, fn, all[c]!, o.row));
  const cells: { out: number; agg: SummaryAgg }[] = [];
  const unexplained: number[] = [];
  let labelOut: number | undefined;
  let label: string | undefined;
  let labelVaries = false;

  for (let c = 0; c < all.length; c++) {
    const col = all[c]!;
    if (occ.every((o) => col.kind[o.row] === EMPTY)) continue;
    const kinds = occ.map((o) => col.kind[o.row]!).filter((k) => k !== EMPTY);
    const isText = kinds.every((k) => k === TEXT || k === BOOL) && occ.every((o) => col.kind[o.row] === EMPTY || col.numKey[o.row] === null);
    const aggs = isText ? TEXT_AGGS : kinds.every((k) => k === DATE) ? DATE_AGGS : NUMERIC_AGGS;
    const fn = aggs.find((a) => holdsAll(c, a));
    if (fn !== undefined) {
      cells.push({ out: c, agg: fn });
      continue;
    }
    if (isText && labelOut === undefined) {
      labelOut = c;
      label = col.text[first]!;
      labelVaries = occ.some((o) => col.text[o.row] !== label);
      continue;
    }
    unexplained.push(c);
  }
  const res: SummaryRowAnalysis = { cells, rows: occ.map((o) => o.row), unexplained };
  if (label !== undefined && labelOut !== undefined) {
    res.label = label;
    res.labelOut = labelOut;
  }
  if (labelVaries) res.labelVaries = true;
  if (rowBold(sheet, first)) res.bold = true;
  return res;
}

function analyzeBody(x: LayoutInput): {
  groupBy: LayoutAnalysis['groupBy'];
  summaryRows: SummaryRowAnalysis[];
  blankRowsBeforeSummary: number;
  unexplainedBlankRows: number[];
} {
  const { out, all } = x;
  const kinds = out.rowKinds;
  const bodyStart = out.headerless ? out.detection.dataStart : out.headerRow + 1;
  const blocks: Block[] = [];
  const endRows: number[] = [];
  const unexplainedBlankRows: number[] = [];
  let cur: Block | null = null;
  for (let r = Math.max(0, bodyStart); r < kinds.length; r++) {
    switch (kinds[r]) {
      case 'data':
        if (endRows.length > 0) break; // data after the end summary: nothing to explain here
        if (!cur || cur.summaries.length > 0 || cur.blanksAfter.length > 0) {
          cur = { data: [], summaries: [], blanksAfter: [] };
          blocks.push(cur);
        }
        cur.data.push(r);
        break;
      case 'summaryGroup':
        if (cur) cur.summaries.push(r);
        break;
      case 'blank':
        if (endRows.length > 0 || !cur) unexplainedBlankRows.push(r);
        else cur.blanksAfter.push(r);
        break;
      case 'summaryEnd':
        endRows.push(r);
        break;
      default:
        break;
    }
  }
  const allData: number[] = [];
  kinds.forEach((k, r) => {
    if (k === 'data') allData.push(r);
  });
  const last = blocks[blocks.length - 1];
  const blankRowsBeforeSummary = endRows.length > 0 && last ? last.blanksAfter.length : 0;
  const summaryRows = endRows.map((row) => summaryRow(all, out.sheet, [{ row, group: allData }]));

  if (x.summaryGroupOut !== null) {
    for (const b of blocks) unexplainedBlankRows.push(...(b === last && endRows.length > 0 ? [] : b.blanksAfter));
    return { groupBy: { out: x.summaryGroupOut, blankRowsAfter: 0 }, summaryRows, blankRowsBeforeSummary, unexplainedBlankRows };
  }

  // Group column: constant inside every block, a different value in each block.
  let groupOut = -1;
  const hasBoundaries = blocks.length >= 2 && blocks.some((b) => b.summaries.length > 0 || b.blanksAfter.length > 0);
  if (hasBoundaries) {
    for (let o = 0; o < all.length && groupOut < 0; o++) {
      const ks = keys(all[o]!);
      const seen = new Set<string>();
      const ok = blocks.every((b) => {
        const k0 = ks[b.data[0]!];
        if (k0 === null || k0 === undefined || seen.has(k0)) return false;
        seen.add(k0);
        return b.data.every((r) => ks[r] === k0);
      });
      if (ok) groupOut = o;
    }
  }
  if (groupOut < 0) {
    for (const b of blocks) if (!(b === last && endRows.length > 0)) unexplainedBlankRows.push(...b.blanksAfter);
    return { groupBy: null, summaryRows, blankRowsBeforeSummary, unexplainedBlankRows };
  }

  // Blank rows after each group: the common count (the last group only has them before end rows).
  const counts = new Map<number, number>();
  const counted = blocks.filter((_, i) => i < blocks.length - 1 || endRows.length > 0);
  for (const b of counted) counts.set(b.blanksAfter.length, (counts.get(b.blanksAfter.length) ?? 0) + 1);
  let blankRowsAfter = 0;
  let bestN = -1;
  for (const [n, c] of counts) {
    if (c > bestN || (c === bestN && n < blankRowsAfter)) {
      blankRowsAfter = n;
      bestN = c;
    }
  }
  for (const b of counted) if (b.blanksAfter.length !== blankRowsAfter) unexplainedBlankRows.push(...b.blanksAfter);
  if (endRows.length === 0 && last) unexplainedBlankRows.push(...last.blanksAfter);

  const groupSummaryRows: SummaryRowAnalysis[] = [];
  const maxOrd = Math.max(0, ...blocks.map((b) => b.summaries.length));
  for (let j = 0; j < maxOrd; j++) {
    const occ = blocks.filter((b) => b.summaries[j] !== undefined).map((b) => ({ row: b.summaries[j]!, group: b.data }));
    groupSummaryRows.push(summaryRow(all, out.sheet, occ));
  }
  const groupBy: NonNullable<LayoutAnalysis['groupBy']> = { out: groupOut, blankRowsAfter };
  if (groupSummaryRows.length > 0) groupBy.summaryRows = groupSummaryRows;
  unexplainedBlankRows.sort((a, b) => a - b);
  return { groupBy, summaryRows, blankRowsBeforeSummary, unexplainedBlankRows };
}

// ---------- sort ----------

function cmpCodePoints(a: string, b: string): number {
  if (a === b) return 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    let ca = a.charCodeAt(i);
    let cb = b.charCodeAt(i);
    if (ca !== cb) {
      if (ca >= 0xd800 && cb >= 0xd800) {
        ca = ca >= 0xe000 ? ca - 0x800 : ca + 0x2000;
        cb = cb >= 0xe000 ? cb - 0x800 : cb + 0x2000;
      }
      return ca < cb ? -1 : 1;
    }
  }
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
}

const NUMERIC_TYPES = new Set(['integer', 'decimal', 'currency', 'percent']);

/** Typed comparison for sort detection (numbers/dates < text < booleans, like the engine; empties handled by the caller). */
function comparer(col: ColumnData, profile: ColumnProfile | undefined): (a: number, b: number) => number {
  const nm = norms(col);
  const t = profile?.type;
  const rank = (k: number): number => {
    if (t === 'date' && !Number.isNaN(col.date[k]!)) return 0;
    if (t !== undefined && NUMERIC_TYPES.has(t) && !Number.isNaN(col.num[k]!)) return 0;
    if (col.kind[k] === NUM || col.kind[k] === DATE) return 0;
    return col.kind[k] === BOOL ? 2 : 1;
  };
  const val = (k: number): number => (t === 'date' || col.kind[k] === DATE ? col.date[k]! : col.num[k]!);
  return (a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    if (ra !== rb) return ra - rb;
    if (ra === 0) {
      const x = val(a);
      const y = val(b);
      return x === y ? 0 : x < y ? -1 : 1;
    }
    return cmpCodePoints(nm[a]!, nm[b]!);
  };
}

function detectSort(
  data: ColumnData[],
  profile: ColumnProfile[],
  inOf: Int32Array,
): { sort: { out: number; dir: 'asc' | 'desc' }[] | null; orderMatchesInput: boolean } {
  const n = inOf.length;
  let prev = -1;
  let monotone = true;
  for (let k = 0; k < n; k++) {
    const v = inOf[k]!;
    if (v < 0) continue;
    if (v < prev) {
      monotone = false;
      break;
    }
    prev = v;
  }
  if (monotone) return { sort: null, orderMatchesInput: true };

  const cmps = data.map((col, o) => comparer(col, profile[o]));
  const cmpDir = (o: number, a: number, b: number, desc: boolean): number => {
    const col = data[o]!;
    const ea = col.kind[a] === EMPTY;
    const eb = col.kind[b] === EMPTY;
    if (ea || eb) return ea === eb ? 0 : ea ? 1 : -1; // empties last in both directions
    const c = cmps[o]!(a, b);
    return desc ? -c : c;
  };
  const stable = (runs: number[][]): boolean =>
    runs.every((run) => {
      let p = -1;
      for (const k of run) {
        const v = inOf[k]!;
        if (v < 0) continue;
        if (v < p) return false;
        p = v;
      }
      return true;
    });

  let runs: number[][] = [Array.from({ length: n }, (_, k) => k)];
  const found: { out: number; dir: 'asc' | 'desc' }[] = [];
  for (let depth = 0; depth < 3; depth++) {
    let next: { out: number; dir: 'asc' | 'desc'; runs: number[][] } | null = null;
    for (let o = 0; o < data.length && next === null; o++) {
      if (found.some((f) => f.out === o)) continue;
      for (const dir of ['asc', 'desc'] as const) {
        const desc = dir === 'desc';
        const ordered = runs.every((run) => {
          for (let i = 1; i < run.length; i++) if (cmpDir(o, run[i - 1]!, run[i]!, desc) > 0) return false;
          return true;
        });
        if (!ordered) continue;
        const split: number[][] = [];
        for (const run of runs) {
          let cur: number[] = [run[0]!];
          for (let i = 1; i < run.length; i++) {
            if (cmpDir(o, run[i - 1]!, run[i]!, desc) === 0) cur.push(run[i]!);
            else {
              split.push(cur);
              cur = [run[i]!];
            }
          }
          split.push(cur);
        }
        if (split.length === runs.length) continue; // splits nothing
        next = { out: o, dir, runs: split };
        break;
      }
    }
    if (next === null) return { sort: null, orderMatchesInput: false };
    found.push({ out: next.out, dir: next.dir });
    runs = next.runs;
    if (stable(runs)) return { sort: found, orderMatchesInput: false };
  }
  return { sort: null, orderMatchesInput: false };
}

// ---------- language ----------

function hebrewShare(texts: string[]): number | null {
  let letters = 0;
  let hebrew = 0;
  for (const t of texts) {
    for (const ch of t) {
      if (/\p{L}/u.test(ch)) {
        letters++;
        if (ch >= 'א' && ch <= 'ת') hebrew++;
      }
    }
  }
  return letters === 0 ? null : hebrew / letters;
}

function detectLanguage(x: LayoutInput, titleTexts: string[]): 'he' | 'en' {
  const share = hebrewShare([...x.out.headers, ...titleTexts]);
  if (share !== null) return share > 0.5 ? 'he' : 'en';
  const sample: string[] = [];
  for (const col of x.data) {
    for (let k = 0; k < col.n && k < 200; k++) if (col.kind[k] === TEXT) sample.push(col.text[k]!);
  }
  const s = hebrewShare(sample);
  if (s !== null) return s > 0.5 ? 'he' : 'en';
  return x.out.direction === 'rtl' ? 'he' : 'en';
}

// ---------- entry ----------

export function analyzeLayout(x: LayoutInput): LayoutAnalysis {
  const { out } = x;
  const rawTitles: string[] = [];
  if (!out.headerless) {
    for (let r = 0; r < out.headerRow; r++) {
      const row = out.sheet.rows[r] ?? [];
      for (const c of row) if (!isEmptyRaw(c)) rawTitles.push(rawText(c));
    }
  }
  const language = detectLanguage(x, rawTitles);
  const titleRows = analyzeTitles(x, language);
  let headerBold = false;
  if (!out.headerless) {
    const header = out.sheet.rows[out.headerRow] ?? [];
    const filled = header.filter((c) => !isEmptyRaw(c));
    headerBold = filled.length > 0 && filled.every((c) => c!.bold === true);
  }
  const body = analyzeBody(x);
  const inOf = new Int32Array(out.dataRows.length).fill(-1);
  for (const a of x.alignment.rows) inOf[a.out] = a.in;
  const { sort, orderMatchesInput } = detectSort(x.data, x.outProfile, inOf);
  return {
    sheetName: out.sheetName,
    direction: out.direction,
    language,
    titleRows,
    headerRow: out.headerRow,
    headerBold,
    summary: x.summaryGroupOut !== null,
    groupBy: body.groupBy,
    summaryRows: body.summaryRows,
    sort,
    blankRowsBeforeSummary: body.blankRowsBeforeSummary,
    unexplainedBlankRows: body.unexplainedBlankRows,
    orderMatchesInput,
    columnFormats: x.outProfile.map((p) => p.format),
    columnWidths: x.outProfile.map((p) => p.width),
    file: out.file,
  };
}
