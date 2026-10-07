// buildPayload (SPEC 7.3, LEARN_PROMPT §3): the only user-derived content the
// LLM ever sees. Runs in the browser, after pre-flight, whether or not the
// fast path succeeded (a fast-path learn never calls this; a case that needs
// the LLM does). Pure and synchronous given the pair analysis; masking (when a
// masker is supplied) uses the same keyed-HMAC masker the pair analysis never
// touches, so the full files themselves never have to be re-read here.

import type {
  Band,
  ColumnClass,
  ColumnHint,
  Format,
  Hint,
  LearnPayload,
  LearnResult,
  OutputLayout,
  PayloadCell,
  PayloadColumn,
  RowHint,
  Rules,
  Sample,
  SummaryRowLayout,
  TitleRowLayout,
} from '@formatai/shared';
import { limits } from '@formatai/shared';
import type { RawCell } from '../types';
import { isSafeShape, toPayloadColumn } from './analyze';
import type { ColumnProfile, Family, PairAnalysis, SummaryRowAnalysis, TitleRowAnalysis } from './analyze';
import { isoOfSerial } from './analyze/cells';
import { completePayloadOf, fixedLabelTexts, type CompleteOptions } from './complete';
import { relationsToHints, type HintCandidate } from './hints';
import { mapRuleConstants, splitWords, type Masker } from './mask';
import { classifyColumns, inputClass, isMasked, outputClass } from './classify';
import type { PreflightResult } from './preflight';
import { normalizeText } from '../values/text';

/** A mutable, same-shape version of `limits.payload` (whose own type is a
 * `const`-narrowed literal, e.g. `maxPairs: 12`, too narrow for a caller to
 * override individual fields with an arbitrary number in tests/config). */
export type PayloadCaps = { -readonly [K in keyof typeof limits.payload]: number };

export interface BuildPayloadOptions {
  /** When given, samples/dropped rows/hint constants/target words are masked (SPEC 7.2). */
  masker?: Masker;
  /** SPEC 8.12/A2: attach mode. The existing format this input must produce. */
  target?: Format;
  /** Completion mode: the rules to keep and what is missing; `payload.complete` carries them (constants masked like the samples). */
  complete?: CompleteOptions;
  caps?: PayloadCaps;
  /**
   * Whether the payload carries the pattern hints - `bands`, `dependsOn`, `contains`: what the pair analysis GUESSES about a column it could
   * not explain (default true, as always). False (the eval's `--no-pattern-hints`, docs/proposals/ai-code-checks.md section 8): they are left
   * out, and so are the sample rows they would have pulled in; every other hint - the facts code proved, a copy, a template, `mul`, a window -
   * is sent as before. It measures the AI code checks against those hints: if checks alone do as well, the hints go.
   */
  patternHints?: boolean;
}

export interface BuildPayloadResult {
  payload: LearnPayload;
  /** One entry per `payload.samples[]` entry, in the same order: the real
   * (aligned-row / family) indices it came from, for mapping a browser diff
   * back onto the original sheets. `out` has one entry for a pair, or one per
   * family row when rows expand. */
  sampleRows: { in: number; out: number[] }[];
  /** The input rows (indices into `analysis.input.rows`) of `payload.dropped`, in the same order: with `sampleRows`, every row the
   * payload already sends, which the learning loop never sends again. */
  droppedRows: number[];
}

// ---------------------------------------------------------------------------
// Raw cell -> payload cell (SPEC 7.3: numbers as numbers, real dates as ISO)
// ---------------------------------------------------------------------------

function cellToPayload(cell: RawCell | null | undefined, date1904: boolean): PayloadCell {
  if (!cell || cell.v === null) return null;
  if (typeof cell.v === 'number') {
    if (cell.isDate) return isoOfSerial(Math.trunc(cell.v) + (date1904 ? 1462 : 0));
    return cell.v;
  }
  return cell.v;
}

function rowCells(row: (RawCell | null)[] | undefined, count: number, date1904: boolean): PayloadCell[] {
  const out: PayloadCell[] = [];
  for (let c = 0; c < count; c++) out.push(cellToPayload(row?.[c], date1904));
  return out;
}

/**
 * DECISION: the example output workbook's own date1904 flag isn't exposed on
 * `PairAnalysis.output` (only the input side carries it). Real 1904-system
 * output files are rare; rather than threading a new field through the whole
 * analyze module for it, real output date cells are read as the standard 1900
 * system here.
 */
function outputRowCells(analysis: PairAnalysis, outDataRow: number): PayloadCell[] {
  const sheetRow = analysis.output.dataRows[outDataRow];
  const row = sheetRow !== undefined ? analysis.output.sheet.rows[sheetRow] : undefined;
  return rowCells(row, analysis.output.columnCount, false);
}

function buildPairSample(analysis: PairAnalysis, alignedRow: number): { sample: Sample; sampleRow: { in: number; out: number[] } } {
  const { in: inRow, out: outRow } = analysis.alignment.rows[alignedRow]!;
  const sample: Sample = {
    in: rowCells(analysis.input.rows[inRow], analysis.input.columnCount, analysis.input.date1904),
    out: outputRowCells(analysis, outRow),
  };
  return { sample, sampleRow: { in: inRow, out: [outRow] } };
}

function buildFamilySample(analysis: PairAnalysis, family: Family): { sample: Sample; sampleRow: { in: number; out: number[] } } {
  const outRows = family.rows.map((k) => analysis.alignment.rows[k]!.out);
  const sample: Sample = {
    in: rowCells(analysis.input.rows[family.in], analysis.input.columnCount, analysis.input.date1904),
    out: outRows.map((o) => outputRowCells(analysis, o)),
  };
  return { sample, sampleRow: { in: family.in, out: outRows } };
}

// ---------------------------------------------------------------------------
// Sample selection: first rows, empty cells, extreme values, must-include
// failing rows, then filler - up to the cap (SPEC 7.3). A pair that repeats one
// already chosen (same input AND output values) takes no slot.
// ---------------------------------------------------------------------------

function hasEmptyCell(analysis: PairAnalysis, alignedRow: number): boolean {
  const { in: inRow, out: outRow } = analysis.alignment.rows[alignedRow]!;
  const inCells = analysis.input.rows[inRow] ?? [];
  for (let c = 0; c < analysis.input.columnCount; c++) {
    const cell = inCells[c];
    if (!cell || cell.v === null || cell.v === '') return true;
  }
  const sheetRow = analysis.output.dataRows[outRow];
  const outCells = (sheetRow !== undefined ? analysis.output.sheet.rows[sheetRow] : undefined) ?? [];
  for (let c = 0; c < analysis.output.columnCount; c++) {
    const cell = outCells[c];
    if (!cell || cell.v === null || cell.v === '') return true;
  }
  return false;
}

function numericValueOfOutputCell(analysis: PairAnalysis, outDataRow: number, col: number): number | null {
  const sheetRow = analysis.output.dataRows[outDataRow];
  const cell = sheetRow !== undefined ? analysis.output.sheet.rows[sheetRow]?.[col] : undefined;
  if (!cell || cell.v === null) return null;
  if (typeof cell.v === 'number') return cell.v;
  if (typeof cell.v === 'string') {
    const n = Number(cell.v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Aligned rows holding the min or max value of each output column, so extreme
 * values are represented among the samples (SPEC 7.3). */
function extremeValueRows(analysis: PairAnalysis): number[] {
  const K = analysis.alignment.rows.length;
  const rows = new Set<number>();
  for (let c = 0; c < analysis.output.columnCount; c++) {
    let minK = -1;
    let maxK = -1;
    let minV = Infinity;
    let maxV = -Infinity;
    for (let k = 0; k < K; k++) {
      const v = numericValueOfOutputCell(analysis, analysis.alignment.rows[k]!.out, c);
      if (v === null) continue;
      if (v < minV) {
        minV = v;
        minK = k;
      }
      if (v > maxV) {
        maxV = v;
        maxK = k;
      }
    }
    if (minK >= 0) rows.add(minK);
    if (maxK >= 0) rows.add(maxK);
  }
  return [...rows];
}

/**
 * What an aligned pair holds, compared on the REAL values (before masking and truncation): its input cells and its output cells. Two pairs
 * with the same key teach the AI step the same thing.
 */
function pairContentKey(analysis: PairAnalysis, alignedRow: number): string {
  const { in: inRow, out: outRow } = analysis.alignment.rows[alignedRow]!;
  return JSON.stringify([rowCells(analysis.input.rows[inRow], analysis.input.columnCount, analysis.input.date1904), outputRowCells(analysis, outRow)]);
}

/**
 * The aligned pairs to send, in priority order, at most `cap` (proposal 3.1 follow-up, owner decision 2026-10-04): a pair whose input cells
 * AND output cells equal a pair already chosen takes no slot - the AI step would see the same row twice. Pairs with the same input and a
 * different output (a row number, a "duplicate" flag, a running total) are informative and are kept. A must-include row (a failing row of
 * a hint) is always sent, even when an earlier row holds the same values. Dropped rows are chosen elsewhere and are unaffected.
 */
export function buildPairPriority(analysis: PairAnalysis, mustInclude: ReadonlySet<number>, cap: number): number[] {
  const K = analysis.alignment.rows.length;
  const order: number[] = [];
  const seen = new Set<number>();
  const contents = new Set<string>();
  const push = (k: number, always = false): void => {
    if (order.length >= cap || k < 0 || k >= K || seen.has(k)) return;
    seen.add(k);
    const content = pairContentKey(analysis, k);
    if (!always && contents.has(content)) return;
    contents.add(content);
    order.push(k);
  };
  for (const k of mustInclude) push(k, true);
  const firstRowsTarget = Math.min(cap, mustInclude.size + 3);
  for (let k = 0; k < K && order.length < firstRowsTarget; k++) push(k);
  for (let k = 0; k < K; k++) if (hasEmptyCell(analysis, k)) push(k);
  for (const k of extremeValueRows(analysis)) push(k);
  for (let k = 0; k < K && order.length < cap; k++) push(k); // filler: everything else, in row order
  return order;
}

function buildFamilyPriority(families: readonly Family[], mustInclude: ReadonlySet<number>): Family[] {
  const order: Family[] = [];
  const seen = new Set<number>();
  const push = (idx: number): void => {
    if (idx >= 0 && idx < families.length && !seen.has(idx)) {
      seen.add(idx);
      order.push(families[idx]!);
    }
  };
  for (const idx of mustInclude) push(idx);
  if (families.length > 0) {
    let smallest = 0;
    let largest = 0;
    families.forEach((f, i) => {
      if (f.rows.length < families[smallest]!.rows.length) smallest = i;
      if (f.rows.length > families[largest]!.rows.length) largest = i;
    });
    push(smallest);
    push(largest);
  }
  for (let i = 0; i < families.length; i++) push(i);
  return order;
}

function buildDroppedPriority(analysis: PairAnalysis, mustInclude: ReadonlySet<number>): number[] {
  const order: number[] = [];
  const seen = new Set<number>();
  const push = (r: number): void => {
    if (!seen.has(r)) {
      seen.add(r);
      order.push(r);
    }
  };
  for (const r of mustInclude) push(r);
  for (const r of analysis.dropped.rows) push(r);
  return order;
}

/** For every hint with coverage < 1, one real-data row that must make it into
 * the sent samples/dropped rows, so the sample selector's promise ("at least
 * one failing row of every hint with coverage < 1") holds. */
function mustIncludeRows(
  hints: readonly HintCandidate[],
  families: readonly Family[],
  isFamilies: boolean,
): { pairRows: Set<number>; familyIdx: Set<number>; droppedRows: Set<number> } {
  const pairRows = new Set<number>();
  const familyIdx = new Set<number>();
  const droppedRows = new Set<number>();
  for (const h of hints) {
    const row = h.failingRows?.[0];
    if (row === undefined) continue;
    if (h.rel === 'filter' || h.rel === 'dedupe') {
      droppedRows.add(row);
      continue;
    }
    if (isFamilies) {
      const idx = families.findIndex((f) => f.rows.includes(row));
      if (idx >= 0) familyIdx.add(idx);
    } else {
      pairRows.add(row);
    }
  }
  return { pairRows, familyIdx, droppedRows };
}

function computeFailsOn(failingRows: readonly number[] | undefined, indexOf: (row: number) => number): number[] | undefined {
  if (!failingRows || failingRows.length === 0) return undefined;
  const idxs = [...new Set(failingRows.map(indexOf).filter((i) => i >= 0))].sort((a, b) => a - b);
  return idxs.length > 0 ? idxs : undefined;
}

// ---------------------------------------------------------------------------
// Masking (SPEC 7.2): label words registered once, up front, then every cell/
// hint constant/target word is run through the same masker.
// ---------------------------------------------------------------------------

function extractWords(texts: readonly string[]): Set<string> {
  const words = new Set<string>();
  for (const t of texts) for (const tok of splitWords(t)) if (tok.isWord) words.add(normalizeText(tok.text));
  return words;
}

function collectLabelTexts(analysis: PairAnalysis, target?: Format, complete?: CompleteOptions): string[] {
  const texts: string[] = [];
  if (complete) texts.push(...fixedLabelTexts(complete.fixedRules));
  for (const t of analysis.layout.titleRows) if (t.text) texts.push(t.text);
  for (const s of analysis.layout.summaryRows) if (s.label) texts.push(s.label);
  if (analysis.layout.groupBy?.summaryRows) {
    for (const s of analysis.layout.groupBy.summaryRows) if (s.label) texts.push(s.label);
  }
  if (target) {
    for (const c of target.output.columns) texts.push(c.header);
    for (const t of target.output.titleRows) {
      if ('text' in t) texts.push(t.text);
      if ('parts' in t) for (const p of t.parts) if ('text' in p) texts.push(p.text);
    }
    for (const s of target.output.summaryRows) {
      if (s.label) texts.push(s.label);
      for (const h of Object.keys(s.cells)) texts.push(h);
    }
    for (const s of target.layout.sort) texts.push(s.header);
    if (target.layout.group) {
      texts.push(target.layout.group.by);
      for (const s of target.layout.group.summaryRows) {
        if (s.label) texts.push(s.label);
        for (const h of Object.keys(s.cells)) texts.push(h);
      }
    }
  }
  return texts;
}

/** The significant digits of a word of digits only (its leading zeros dropped), else null. */
function significantDigitsOf(word: string): string | null {
  return /^[0-9]+$/.test(word) ? word.replace(/^0+/, '') : null;
}

/**
 * The label words among `candidates` (normalized words of the title, summary-label and other label texts): those that appear in no text or
 * ID-like data cell of the example, input or output, in any row (SPEC 7.2). Scans until every candidate has turned up in a cell. A number
 * in an identifier column (amendment 2026-10-06, `classify.ts`) is masked as its digits, so those digits are data too: a title that
 * names one ("customer 100200") must not make them a label word the masker then lets through.
 */
function labelWordsOf(analysis: PairAnalysis, candidates: ReadonlySet<string>): Set<string> {
  const left = new Set(candidates);
  const types = classifyColumns(analysis);
  // Amendment 2026-10-06 (leading zeros survive masking): the masker masks a run of digits by its significant digits, so "12345" in a
  // title and "000012345" in a cell are the same value - a title word of digits is data when any cell holds those digits, zero-padded or not.
  const digitCandidates = new Map<string, string[]>();
  for (const w of candidates) {
    const significant = significantDigitsOf(w);
    if (significant !== null) digitCandidates.set(significant, [...(digitCandidates.get(significant) ?? []), w]);
  }
  const seen = (word: string): void => {
    left.delete(word);
    const significant = significantDigitsOf(word);
    if (significant !== null) for (const w of digitCandidates.get(significant) ?? []) left.delete(w);
  };
  const scan = (row: (RawCell | null)[] | undefined, classes: readonly ColumnClass[]): void => {
    if (!row) return;
    classes.forEach((cls, c) => {
      const cell = row[c];
      if (!cell || !isMasked(cls)) return;
      const text = typeof cell.v === 'string' ? cell.v : typeof cell.v === 'number' && cls === 'identifier' ? String(cell.v) : null;
      if (text !== null) for (const tok of splitWords(text)) if (tok.isWord) seen(normalizeText(tok.text));
    });
  };
  for (const row of analysis.input.rows) {
    if (left.size === 0) return left;
    scan(row, types.input);
  }
  for (const sheetRow of analysis.output.dataRows) {
    if (left.size === 0) return left;
    scan(analysis.output.sheet.rows[sheetRow], types.output);
  }
  return left;
}

/** A sample's cells masked by their column's class (`classify.ts`: an identifier stored as a number is masked as an ID). */
function maskSample(sample: Sample, analysis: PairAnalysis, masker: Masker): Sample {
  const inMasked = sample.in.map((v, i) => masker.maskCell(v, inputClass(analysis, i)));
  if (sample.out.length > 0 && Array.isArray(sample.out[0])) {
    const outMasked = (sample.out as PayloadCell[][]).map((row) => row.map((v, i) => masker.maskCell(v, outputClass(analysis, i))));
    return { in: inMasked, out: outMasked };
  }
  const outMasked = (sample.out as PayloadCell[]).map((v, i) => masker.maskCell(v, outputClass(analysis, i)));
  return { in: inMasked, out: outMasked };
}

function truncateCells(cells: readonly PayloadCell[], maxChars: number): PayloadCell[] {
  return cells.map((v) => (typeof v === 'string' && v.length > maxChars ? v.slice(0, maxChars) : v));
}

function truncateSample(sample: Sample, maxChars: number): Sample {
  if (sample.out.length > 0 && Array.isArray(sample.out[0])) {
    return { in: truncateCells(sample.in, maxChars), out: (sample.out as PayloadCell[][]).map((r) => truncateCells(r, maxChars)) };
  }
  return { in: truncateCells(sample.in, maxChars), out: truncateCells(sample.out as PayloadCell[], maxChars) };
}

function finishSample(sample: Sample, analysis: PairAnalysis, masker: Masker | undefined, maxChars: number): Sample {
  return truncateSample(masker ? maskSample(sample, analysis, masker) : sample, maxChars);
}

/**
 * The learning loop (`learn/loop.ts`): one row of the example as a sample, built, masked and truncated exactly like the payload's own
 * samples (the same masker, so a value has the same fake word in every round). When rows expand it is the whole family (the input row and
 * all its output rows); a row the example dropped is the input row with no output rows (`out: []`: the rules must make nothing for it).
 */
export function counterexampleSample(analysis: PairAnalysis, inRow: number, masker?: Masker, maxCellChars: number = limits.payload.maxCellChars): Sample {
  const aligned = analysis.alignment.rows.flatMap((r, k) => (r.in === inRow ? [k] : []));
  const inCells = rowCells(analysis.input.rows[inRow], analysis.input.columnCount, analysis.input.date1904);
  let sample: Sample;
  if (aligned.length === 0) {
    sample = { in: inCells, out: [] as PayloadCell[][] };
  } else if (analysis.shape.kind === 'families') {
    const family = analysis.shape.families.find((f) => f.in === inRow);
    // (every aligned input row is in a family; were one not, its aligned rows are the family)
    sample = family ? buildFamilySample(analysis, family).sample : { in: inCells, out: aligned.map((k) => outputRowCells(analysis, analysis.alignment.rows[k]!.out)) };
  } else {
    sample = buildPairSample(analysis, aligned[0]!).sample;
  }
  return finishSample(sample, analysis, masker, maxCellChars);
}

function maskColumnHintValue(h: ColumnHint, analysis: PairAnalysis, masker: Masker): ColumnHint {
  if (h.rel === 'valueMap') {
    const inType = inputClass(analysis, h.in[0]);
    const outType = outputClass(analysis, h.out);
    const pairs: [string, string][] = h.pairs.map(([from, to]) => [
      String(masker.maskCell(from, inType) ?? ''),
      String(masker.maskCell(to, outType) ?? ''),
    ]);
    return { ...h, pairs };
  }
  if (h.rel === 'constant') {
    const outType = outputClass(analysis, h.out);
    return { ...h, value: masker.maskCell(h.value, outType) };
  }
  if (h.rel === 'template') {
    // The fixed text is masked like any other text in the payload: a word that also sits in the (masked) sample
    // cells gets the same fake word, so the hint and the samples agree. Punctuation and label words stay real.
    const parts = h.parts.map((p) => (typeof p === 'string' ? masker.maskText(p) : p));
    return { ...h, parts };
  }
  if (h.rel === 'bands') {
    // The thresholds are numbers or ISO dates (sent real, SPEC 7.2); the band values are output cells, masked like samples.
    // Bands on a computed output column (`onOut`) are no different: the thresholds are numbers of that column, the values cells of `out`.
    // Amendment 2026-10-07 (engine audit): bands on an IDENTIFIER column have no thresholds - a cut-off is a value of the column (`hi`
    // when no rounder number fits), an ID the samples mask - like its `stats.range`. The hint still says the column decides by ranges.
    const outType = outputClass(analysis, h.out);
    const onIdentifier = (h.onOut !== undefined ? outputClass(analysis, h.onOut) : inputClass(analysis, h.in[0] ?? -1)) === 'identifier';
    const bands: Band[] = h.bands.map(({ lt, gte, value }) => ({ ...(onIdentifier ? {} : { ...(lt !== undefined ? { lt } : {}), ...(gte !== undefined ? { gte } : {}) }), value: masker.maskCell(value, outType) }));
    return { ...h, bands };
  }
  return h;
}

function maskRowHintValue(h: RowHint, analysis: PairAnalysis, masker: Masker): RowHint {
  if (h.rel !== 'filter') return h;
  const inType = inputClass(analysis, h.in[0]!);
  const out: RowHint = { ...h };
  if (h.keptValues) out.keptValues = h.keptValues.map((v) => masker.maskCell(v, inType));
  if (h.droppedValues) out.droppedValues = h.droppedValues.map((v) => masker.maskCell(v, inType));
  // Amendment 2026-10-07 (engine audit): a cut-off on an identifier column is one of its IDs (the edge value of the gap when no rounder
  // number fits): the hint keeps the comparison, not the value - like the column's `stats.range`.
  if (h.droppedWhen?.value !== undefined && inType === 'identifier') out.droppedWhen = { op: h.droppedWhen.op };
  return out;
}

function maskHintList(hints: readonly HintCandidate[], analysis: PairAnalysis, masker: Masker): HintCandidate[] {
  return hints.map((h): HintCandidate => {
    if (h.rel === 'filter' || h.rel === 'dedupe') return maskRowHintValue(h, analysis, masker) as HintCandidate;
    if (h.rel === 'expand') {
      if (h.mode !== 'fixedFanOut') return h;
      return { ...h, positions: h.positions.map((cols) => cols.map((c) => maskColumnHintValue(c, analysis, masker))) };
    }
    return maskColumnHintValue(h as ColumnHint, analysis, masker) as HintCandidate;
  });
}

/**
 * Completion mode (amendment 2026-10-06): a number constant of the rules to keep that is a value of a column masked as an ID is masked
 * here once, like that column's cells, so `maskFixedRules` sends its fake (`Masker.fakeNumberOf`) - even when no row this payload sends holds it.
 */
function registerIdConstants(analysis: PairAnalysis, rules: LearnResult | Rules, masker: Masker): void {
  const wanted = new Set<number>();
  mapRuleConstants(rules, (s) => s, (n) => {
    wanted.add(n);
    return n;
  });
  if (wanted.size === 0) return;
  const types = classifyColumns(analysis);
  const scan = (row: (RawCell | null)[] | undefined, classes: readonly ColumnClass[]): void => {
    classes.forEach((cls, c) => {
      const v = row?.[c]?.v;
      if (cls === 'identifier' && typeof v === 'number' && wanted.has(v)) masker.maskCell(v, cls);
    });
  };
  for (const row of analysis.input.rows) scan(row, types.input);
  for (const sheetRow of analysis.output.dataRows) scan(analysis.output.sheet.rows[sheetRow], types.output);
}

/** SPEC 8.12/A2: `target`'s own header/title/summary-label words get the same
 * treatment as any other label - real unless the word also appears in a data
 * cell, in which case `masker.maskText` (having had every genuine label word
 * pre-registered) masks it consistently with the samples. */
function buildTargetPayload(target: Format, masker: Masker | undefined): NonNullable<LearnPayload['target']> {
  const mask = (s: string): string => (masker ? masker.maskText(s) : s);
  const columns = target.output.columns.map((c) => ({ ...c, header: mask(c.header) }));
  const titleRows = target.output.titleRows.map((t) => {
    if ('blank' in t) return t;
    if ('parts' in t) return { ...t, parts: t.parts.map((p) => ('text' in p ? { ...p, text: mask(p.text) } : p)) };
    return { ...t, text: mask(t.text) };
  });
  const maskSummaryRow = <T extends { label?: string; cells: Record<string, unknown> }>(s: T): T => {
    const cells = Object.fromEntries(Object.entries(s.cells).map(([h, agg]) => [mask(h), agg]));
    return { ...s, ...(s.label !== undefined ? { label: mask(s.label) } : {}), cells } as T;
  };
  const summaryRows = target.output.summaryRows.map(maskSummaryRow);
  const output: Format['output'] = { ...target.output, columns, titleRows, summaryRows };
  const sort = target.layout.sort.map((s) => ({ ...s, header: mask(s.header) }));
  const layout: Format['layout'] = { sort };
  if (target.layout.group) {
    const g = target.layout.group;
    layout.group = {
      ...g,
      by: mask(g.by),
      summaryRows: g.summaryRows.map(maskSummaryRow),
      ...(g.agg ? { agg: Object.fromEntries(Object.entries(g.agg).map(([h, agg]) => [mask(h), agg])) } : {}),
    };
  }
  const validations = target.outputValidations.map((v) => ({ ...v, column: mask(v.column) }));
  return { output, layout, validations };
}

// ---------------------------------------------------------------------------
// Output layout (SPEC 7.3 §"output.layout details")
// ---------------------------------------------------------------------------

function toTitleRowLayout(t: TitleRowAnalysis, mask?: (s: string) => string): TitleRowLayout {
  const out: TitleRowLayout = { row: t.row };
  if (t.text !== undefined) out.text = mask ? mask(t.text) : t.text;
  if (t.blank) out.blank = true;
  if (t.bold) out.bold = true;
  if (t.containsDate) out.containsDate = t.containsDate;
  return out;
}

function toSummaryRowLayout(s: SummaryRowAnalysis, mask?: (s: string) => string): SummaryRowLayout {
  const out: SummaryRowLayout = { cells: s.cells };
  if (s.label !== undefined) out.label = mask ? mask(s.label) : s.label;
  if (s.labelOut !== undefined) out.labelOut = s.labelOut;
  if (s.bold) out.bold = true;
  return out;
}

function buildOutputLayout(analysis: PairAnalysis, masker?: Masker): OutputLayout {
  const mask = masker ? (s: string): string => masker.maskText(s) : undefined;
  const layout = analysis.layout;
  return {
    sheetName: layout.sheetName,
    direction: layout.direction,
    language: layout.language,
    titleRows: layout.titleRows.map((t) => toTitleRowLayout(t, mask)),
    headerRow: layout.headerRow,
    headerBold: layout.headerBold,
    summary: layout.summary,
    groupBy: layout.groupBy
      ? {
          out: layout.groupBy.out,
          blankRowsAfter: layout.groupBy.blankRowsAfter,
          ...(layout.groupBy.summaryRows ? { summaryRows: layout.groupBy.summaryRows.map((s) => toSummaryRowLayout(s, mask)) } : {}),
        }
      : null,
    summaryRows: layout.summaryRows.map((s) => toSummaryRowLayout(s, mask)),
    sort: layout.sort,
  };
}

// ---------------------------------------------------------------------------
// Size rules (SPEC 7.3 §"Size rules")
// ---------------------------------------------------------------------------

function byteSize(payload: LearnPayload): number {
  return new TextEncoder().encode(JSON.stringify(payload)).length;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/** The pattern hints (`BuildPayloadOptions.patternHints`): a column's dependency, its bands, a composition - guesses, not proven relations. */
export const PATTERN_HINT_RELS = ['bands', 'dependsOn', 'contains'] as const;

function isPatternHint(h: HintCandidate): boolean {
  return (PATTERN_HINT_RELS as readonly string[]).includes(h.rel);
}

export function buildPayload(analysis: PairAnalysis, preflight: PreflightResult, opts: BuildPayloadOptions = {}): BuildPayloadResult {
  const caps = opts.caps ?? limits.payload;
  const masker = opts.masker;
  const isFamilies = analysis.shape.kind === 'families';
  const families = analysis.shape.kind === 'families' ? analysis.shape.families : [];

  const hints = opts.patternHints === false ? relationsToHints(analysis, preflight).filter((h) => !isPatternHint(h)) : relationsToHints(analysis, preflight);
  const must = mustIncludeRows(hints, families, isFamilies);

  const pairPriority = isFamilies ? [] : buildPairPriority(analysis, must.pairRows, caps.maxPairs);
  const familyPriority = isFamilies ? buildFamilyPriority(families, must.familyIdx).slice(0, caps.maxFamilies) : [];
  const droppedPriority = buildDroppedPriority(analysis, must.droppedRows).slice(0, caps.maxDropped);

  // ---- masking setup: label words registered once, up front ----
  // SPEC 7.2: a label word is one that appears in NO data cell of the example - every row, not only the rows this payload sends: the
  // learning loop (`learn/loop.ts`) sends more rows later with the same masker, and a word that sits in one of them must be masked there.
  if (masker) masker.addLabelWords(labelWordsOf(analysis, extractWords(collectLabelTexts(analysis, opts.target, opts.complete))));

  const maskedHints = masker ? maskHintList(hints, analysis, masker) : hints;
  if (masker && opts.complete) registerIdConstants(analysis, opts.complete.fixedRules, masker);

  const buildSamples = (): { samples: Sample[]; sampleRows: { in: number; out: number[] }[] } => {
    const built = isFamilies ? familyPriority.map((f) => buildFamilySample(analysis, f)) : pairPriority.map((k) => buildPairSample(analysis, k));
    return {
      samples: built.map((b) => finishSample(b.sample, analysis, masker, caps.maxCellChars)),
      sampleRows: built.map((b) => b.sampleRow),
    };
  };

  const buildDroppedRows = (): PayloadCell[][] =>
    droppedPriority.map((r) => {
      const cells = rowCells(analysis.input.rows[r], analysis.input.columnCount, analysis.input.date1904);
      const masked = masker ? cells.map((v, i) => masker.maskCell(v, inputClass(analysis, i))) : cells;
      return truncateCells(masked, caps.maxCellChars);
    });

  let includeStats = true;
  let samplesBuilt = buildSamples();
  const droppedBuilt = buildDroppedRows();

  const finalize = (): BuildPayloadResult => {
    const droppedIndexOf = (row: number): number => droppedPriority.indexOf(row);
    const pairIndexOf = (row: number): number => pairPriority.indexOf(row);
    const familyIndexOf = (row: number): number => familyPriority.findIndex((f) => f.rows.includes(row));

    const wireHints: Hint[] = maskedHints.map((h) => {
      const { failingRows, ...rest } = h;
      const indexOf = h.rel === 'filter' || h.rel === 'dedupe' ? droppedIndexOf : isFamilies ? familyIndexOf : pairIndexOf;
      const failsOn = computeFailsOn(failingRows, indexOf);
      return failsOn ? ({ ...rest, failsOn } as Hint) : (rest as Hint);
    });

    // With masking on, an identifier column (amendment 2026-10-06) does not carry its real smallest and largest values (`stats.range`):
    // they are two of the IDs the samples mask. A masked column's `shape` (amendment 2026-10-07: script-agnostic, `shapeOf`) is sent only
    // when it holds nothing but shape letters, `D` and separators - never a letter or digit of a value.
    const types = masker ? classifyColumns(analysis) : null;
    const columnOf = (p: ColumnProfile, cls: ColumnClass | undefined): PayloadColumn => {
      const col = toPayloadColumn(p);
      if (!includeStats) delete col.stats;
      else if (cls === 'identifier') delete col.stats?.range;
      if (cls !== undefined && isMasked(cls) && col.shape !== undefined && !isSafeShape(col.shape)) delete col.shape;
      return col;
    };
    const inputColumns = analysis.input.profile.map((p, i) => columnOf(p, types?.input[i]));
    const outputColumns = analysis.output.profile.map((p, o) => columnOf(p, types?.output[o]));

    const payload: LearnPayload = {
      masking: masker !== undefined,
      input: {
        sheetName: analysis.input.sheetName,
        direction: analysis.input.direction,
        layout: analysis.input.layout,
        columns: inputColumns,
      },
      output: {
        file: analysis.layout.file,
        layout: buildOutputLayout(analysis, masker),
        columns: outputColumns,
      },
      samples: samplesBuilt.samples,
      hints: wireHints,
    };
    if (droppedBuilt.length > 0) payload.dropped = droppedBuilt;
    if (preflight.skipColumns.length > 0) payload.skipColumns = preflight.skipColumns;
    if (opts.target) payload.target = buildTargetPayload(opts.target, masker);
    if (opts.complete) payload.complete = completePayloadOf(opts.complete, masker, analysis);

    return { payload, sampleRows: samplesBuilt.sampleRows, droppedRows: [...droppedPriority] };
  };

  let result = finalize();
  // SPEC 7.3 "Size rules": drop samples first (never below the configured
  // minimum), then stats - in that order, re-measuring after each change.
  for (let guard = 0; byteSize(result.payload) > caps.maxBytes && guard < 100; guard++) {
    const list = isFamilies ? familyPriority : pairPriority;
    if (list.length > caps.minPairs) {
      list.pop();
      samplesBuilt = buildSamples();
      result = finalize();
      continue;
    }
    if (includeStats) {
      includeStats = false;
      result = finalize();
      continue;
    }
    break;
  }

  return result;
}
