// The stress test's invariants (eval/STRESS.md), checked on one generated case (`gen.ts`) against the FREE engine only: the learn runs
// with `ai: 'notAllowed'` and a `callLearn` that throws, so no AI step - and no network - is ever reached. The truth every check compares
// with is the reference rules' own conversion (`StressCase.refExample` / `refNext`): which input row made which output row, and its cells.
//
//   1. Analysis and the free learn never throw; they end in a result, a partial result, or a stated block.
//   2. No silent wrong values: what the free engine reports as verified / solved reproduces the example exactly, and on the hold-out it is
//      right or the run flags the row. (Also: every data row of the input file is read - none lost to table detection.)
//   3. A column it cannot solve is reported (needs the AI step / your input), never filled.
//   4. With masking on, the AI payload (and what the learning loop would send) holds no real text or identifier.
//   5. No output file holds a live formula from the data.
//   6. Time: learn and convert within budget (10 s each on 20,000 x 20).
import {
  aiReadiness,
  convertFile,
  counterexampleSample,
  createMasker,
  learnFromExamples,
  maskTypes,
  MONTH_NAMES,
  normalizeText,
  preflight,
  readZip,
  splitWords,
  verifyAgainstExample,
  WEEKDAY_NAMES,
  type ConvertResult,
  type LearnFromExamplesResult,
  type Masker,
  type OutCell,
  type OutRow,
  type PairAnalysis,
} from '@formatai/engine';
import { maskingVocabulary, type LearnPayload, type LearnResult, type PayloadCell } from '@formatai/shared';
import { SENSITIVE_KINDS, type InCol } from './data';
import type { StressCase } from './gen';

export type FailureKind =
  | 'learnThrew'
  | 'badPath'
  | 'rowsMisread'
  | 'learnedConvertFailed'
  | 'verifiedButDiffers'
  | 'solvedColumnWrong'
  | 'holdoutConvertFailed'
  | 'holdoutSilent'
  | 'holdoutRowsSilent'
  | 'holdoutLayout'
  | 'unsolvedFilled'
  | 'unsolvedNotReported'
  | 'maskLeak'
  | 'maskLeakScript'
  | 'liveFormula'
  | 'slow'
  | 'checkCrashed';

export type FindingKind =
  | 'localNotVerified'
  | 'partialMismatchReported'
  | 'holdoutAssumed'
  | 'idNumberSentReal'
  | 'csvLeadingControl'
  | 'payloadNotBuilt';

export interface Failure {
  kind: FailureKind;
  /** The invariant (1-6) it breaks. */
  invariant: number;
  detail: string;
}

export interface Finding {
  kind: FindingKind;
  detail: string;
}

export interface CaseResult {
  seed: number;
  profile: string;
  features: string[];
  rowsIn: number;
  cols: number;
  outCols: number;
  fileType: string;
  outFileType: string;
  path: string;
  solved: number;
  needsAiParts: string[];
  failures: Failure[];
  findings: Finding[];
  ms: { gen: number; learn: number; convert: number; holdout: number; mask: number };
  /** The rules the free engine learned (local or partial), for a repro. */
  learned: LearnResult | null;
}

export interface CheckOptions {
  /** Learn / convert budget in ms (invariant 6), applied to every case at least `budgetRows` x `budgetCols` big. */
  budgetMs?: number;
  budgetRows?: number;
  budgetCols?: number;
  /** Skip the masking check (invariant 4). */
  noMask?: boolean;
}

const MASK_KEY = new Uint8Array(32).map((_, i) => (i * 37 + 11) & 0xff);

// ---------------------------------------------------------------------------
// Cell comparison
// ---------------------------------------------------------------------------

type V = string | number | boolean | null;

function cellV(c: OutCell | undefined): { v: V; date: boolean } {
  if (c === undefined || c.v === null || c.v === '') return { v: null, date: false };
  return { v: c.v, date: c.isDate === true };
}

/** A number as a delimited file writes it: plain digits, never an exponent. */
function plainNumber(n: number): string {
  const s = String(n);
  if (!/e/i.test(s)) return s;
  return n.toFixed(20).replace(/\.?0+$/, '');
}

/**
 * What a csv / txt file shows for a cell: its display text (a date's formatted text), a number's plain digits, and text that starts like a
 * formula with the writer's apostrophe in front (so "=1+1" and the "'=1+1" an example output read back holds are one value).
 */
function shownText(c: OutCell | undefined): string {
  if (c === undefined || c.v === null) return '';
  if (typeof c.v === 'number' && c.text === undefined) return plainNumber(c.v);
  const text = c.text ?? (typeof c.v === 'boolean' ? (c.v ? 'TRUE' : 'FALSE') : String(c.v));
  return typeof c.v !== 'number' && /^[=+\-@]/.test(text) ? `'${text}` : text;
}

/**
 * Whether two cells are the same to the person who opens the file: typed in xlsx (a number is not text that reads like it, a date is
 * not text), the shown text in csv / txt (where every cell is text: a real date and the same date written as text are one value).
 */
function sameCell(a: OutCell | undefined, b: OutCell | undefined, delimited = false): boolean {
  if (delimited) return shownText(a) === shownText(b);
  const x = cellV(a);
  const y = cellV(b);
  if (x.date !== y.date) return false;
  if (typeof x.v === 'number' && typeof y.v === 'number') return Math.abs(x.v - y.v) < 1e-9;
  return x.v === y.v;
}

function show(c: OutCell | undefined): string {
  const x = cellV(c);
  return x.v === null ? '(empty)' : `${JSON.stringify(x.v)}${x.date ? ' (date)' : ''}`;
}

/** Data rows grouped by the input row that made them, in order. */
function bySource(rows: readonly OutRow[]): Map<number, OutRow[]> {
  const m = new Map<number, OutRow[]>();
  for (const r of rows) {
    if (r.kind !== 'data' || r.sourceRow === undefined) continue;
    const list = m.get(r.sourceRow) ?? [];
    list.push(r);
    m.set(r.sourceRow, list);
  }
  return m;
}

interface CellDiff {
  sourceRow: number;
  col: number;
  expected: OutCell | undefined;
  actual: OutCell | undefined;
}

/** The cells of `cols` that differ, on the data rows both sides made (paired by input row and position within it). */
function diffColumns(expected: readonly OutRow[], actual: readonly OutRow[], cols: readonly number[], delimited: boolean): { diffs: CellDiff[]; onlyExpected: number[]; onlyActual: number[] } {
  const e = bySource(expected);
  const a = bySource(actual);
  const diffs: CellDiff[] = [];
  const onlyExpected: number[] = [];
  const onlyActual: number[] = [];
  for (const [src, eRows] of e) {
    const aRows = a.get(src);
    if (!aRows) {
      onlyExpected.push(src);
      continue;
    }
    if (aRows.length !== eRows.length) (aRows.length < eRows.length ? onlyExpected : onlyActual).push(src);
    const n = Math.min(aRows.length, eRows.length);
    for (let k = 0; k < n; k++) {
      for (const c of cols) {
        if (!sameCell(eRows[k]!.cells[c], aRows[k]!.cells[c], delimited)) diffs.push({ sourceRow: src, col: c, expected: eRows[k]!.cells[c], actual: aRows[k]!.cells[c] });
      }
    }
  }
  for (const src of a.keys()) if (!e.has(src)) onlyActual.push(src);
  return { diffs, onlyExpected, onlyActual };
}

/** Positional compare of two whole sheets (every row kind, every cell): the first difference, or null. */
function firstSheetDiff(expected: readonly OutRow[], actual: readonly OutRow[], headerless: boolean, delimited: boolean): string | null {
  const keep = (r: OutRow): boolean => !(headerless && r.kind === 'header');
  const e = expected.filter(keep);
  const a = actual.filter(keep);
  const kindOf = (k: OutRow['kind']): string => (k === 'subtotal' || k === 'grandTotal' ? 'summaryRow' : k);
  for (let i = 0; i < Math.max(e.length, a.length); i++) {
    const er = e[i];
    const ar = a[i];
    if (!er || !ar) return `row ${i + 1}: ${er ? 'missing' : 'extra'} ${kindOf((er ?? ar)!.kind)} row`;
    if (kindOf(er.kind) !== kindOf(ar.kind)) return `row ${i + 1}: expected a ${er.kind} row, got a ${ar.kind} row`;
    if (er.kind === 'blank') continue;
    for (let c = 0; c < Math.max(er.cells.length, ar.cells.length); c++) {
      if (!sameCell(er.cells[c], ar.cells[c], delimited)) return `row ${i + 1} (${er.kind}), column ${c + 1}: expected ${show(er.cells[c])}, got ${show(ar.cells[c])}`;
    }
  }
  return null;
}

/**
 * Everything but the data cells (those are judged with the flags, `diffColumns`): the sequence of row kinds, the cells of the title, header,
 * summary and blank rows, and the order of the data rows (by the input row each came from). The first difference, or null.
 */
function layoutDiff(expected: readonly OutRow[], actual: readonly OutRow[], headerless: boolean, delimited: boolean): string | null {
  const keep = (r: OutRow): boolean => !(headerless && r.kind === 'header');
  const e = expected.filter(keep);
  const a = actual.filter(keep);
  const kindOf = (k: OutRow['kind']): string => (k === 'subtotal' || k === 'grandTotal' ? 'summaryRow' : k);
  for (let i = 0; i < Math.max(e.length, a.length); i++) {
    const er = e[i];
    const ar = a[i];
    if (!er || !ar) return `row ${i + 1}: ${er ? 'missing' : 'extra'} ${kindOf((er ?? ar)!.kind)} row`;
    if (kindOf(er.kind) !== kindOf(ar.kind)) return `row ${i + 1}: expected a ${er.kind} row, got a ${ar.kind} row`;
    if (er.kind === 'blank') continue;
    if (er.kind === 'data') {
      if (er.sourceRow !== ar.sourceRow) return `row ${i + 1}: the data rows come in another order (expected the row of input row ${er.sourceRow}, got input row ${ar.sourceRow})`;
      continue;
    }
    for (let c = 0; c < Math.max(er.cells.length, ar.cells.length); c++) {
      if (!sameCell(er.cells[c], ar.cells[c], delimited)) return `row ${i + 1} (${er.kind}), column ${c + 1}: expected ${show(er.cells[c])}, got ${show(ar.cells[c])}`;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Invariant 5: live formulas
// ---------------------------------------------------------------------------

const FORMULA_START = /^[=+\-@]/;
const PLAIN_NUMBER = /^-?\d+(\.\d+)?$/;

/** The fields of a delimited file (RFC 4180 quoting), as text. */
function delimitedFields(text: string, delimiter: string): string[] {
  const fields: string[] = [];
  let i = 0;
  let field = '';
  let quoted = false;
  while (i < text.length) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i += 2;
        continue;
      }
      if (ch === '"') {
        quoted = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"' && field === '') {
      quoted = true;
      i++;
      continue;
    }
    if (ch === delimiter || ch === '\n') {
      fields.push(field.replace(/\r$/, ''));
      field = '';
      i++;
      continue;
    }
    field += ch;
    i++;
  }
  if (field !== '') fields.push(field.replace(/\r$/, ''));
  return fields;
}

async function liveFormulas(bytes: Uint8Array, file: { type: 'xlsx' | 'csv' | 'txt'; delimiter?: string; encoding?: string }, label: string): Promise<{ failures: string[]; leadingControl: string[] }> {
  const failures: string[] = [];
  const leadingControl: string[] = [];
  if (file.type === 'xlsx') {
    for (const e of await readZip(bytes)) {
      if (!e.path.startsWith('xl/worksheets/') || !e.path.endsWith('.xml')) continue;
      const xml = new TextDecoder().decode(e.bytes as Uint8Array);
      const m = /<f[\s>][^<]*/.exec(xml);
      if (m) failures.push(`${label}: ${e.path} holds a formula: ${m[0].slice(0, 80)}`);
    }
    return { failures, leadingControl };
  }
  const delimiter = file.delimiter ?? (file.type === 'txt' ? '\t' : ',');
  const text = file.encoding === 'windows1255' ? new TextDecoder('windows-1255').decode(bytes) : new TextDecoder().decode(bytes).replace(/^﻿/, '');
  for (const f of delimitedFields(text, delimiter)) {
    if (FORMULA_START.test(f) && !PLAIN_NUMBER.test(f)) failures.push(`${label}: field ${JSON.stringify(f.slice(0, 60))} starts like a formula`);
    else if (/^[\t\r]\s*[=+\-@]/.test(f)) leadingControl.push(`${label}: field ${JSON.stringify(f.slice(0, 60))}`);
  }
  return { failures: failures.slice(0, 5), leadingControl: leadingControl.slice(0, 3) };
}

// ---------------------------------------------------------------------------
// Invariant 4: masking
// ---------------------------------------------------------------------------

const WORD_RE = /[\p{L}\p{Nd}]+/gu;

function tokens(s: string): string[] {
  return s.match(WORD_RE) ?? [];
}

/** A word worth checking: 4+ letters/digits (a shorter fake equals its real word by chance too often), and not a plain number below 6 digits. */
function checkable(t: string, min = 4): boolean {
  if (t.length < min) return false;
  if (/^\d+$/.test(t)) return t.length >= 6 || (t.startsWith('0') && t.length >= min);
  return true;
}

/** Words the payload may hold real: headers, title and summary labels, sheet names, month and weekday names, no-value placeholders. */
function allowedReal(c: StressCase, analysis: PairAnalysis): Set<string> {
  const texts: string[] = [
    ...analysis.input.headers,
    ...analysis.output.headers,
    ...c.cols.map((x) => x.header),
    ...c.rules.output.columns.map((o) => o.header),
    ...c.layout.titleRows,
    c.layout.totalsLabel,
    c.layout.sheetName,
    c.rules.output.sheetName,
    ...c.rules.output.titleRows.flatMap((t) => ('text' in t ? [t.text] : [])),
    ...(c.rules.output.summaryRows ?? []).flatMap((s) => (s.label ? [s.label] : [])),
    ...(c.rules.transform.group?.summaryRows ?? []).flatMap((s) => (s.label ? [s.label] : [])),
    ...MONTH_NAMES.he,
    ...MONTH_NAMES.en,
    ...WEEKDAY_NAMES.he.full,
    ...WEEKDAY_NAMES.en.full,
    ...WEEKDAY_NAMES.en.short,
    ...maskingVocabulary.noValueTokens,
  ];
  const out = new Set<string>();
  for (const t of texts) for (const w of tokens(normalizeText(t))) out.add(w);
  return out;
}

/** The generator column behind each input column of the analysis (by header), or undefined. */
function inputKinds(c: StressCase, analysis: PairAnalysis): (InCol | undefined)[] {
  const byHeader = new Map(c.cols.map((x) => [normalizeText(x.header), x] as const));
  return analysis.input.headers.map((h) => byHeader.get(normalizeText(h)));
}

interface MaskCtx {
  c: StressCase;
  analysis: PairAnalysis;
  masker: Masker;
  allowed: Set<string>;
  kinds: (InCol | undefined)[];
  types: ReturnType<typeof maskTypes>;
  /** Every checkable word of a sensitive column's real cells (for the output side and the payload's other parts). */
  sensitive: Map<string, string>;
  /** Every identifier number of an ID column (by maskTypes) or a generated ID column, by value. */
  idNumbers: Map<number, { header: string; maskedAsId: boolean }>;
  leaks: { kind: FailureKind; detail: string }[];
  findings: Finding[];
  reportedIdColumns: Set<string>;
}

/** Letters of a script the masker has a fake alphabet for (words.ts: digits, Latin, the Hebrew letters). */
const MODELED = /^[0-9A-Za-zא-ת]+$/;

function leakOf(m: MaskCtx, where: string, word: string): void {
  // Masked to itself (a script the masker has no fake alphabet for, or a 1-in-millions coincidence) or not masked at all.
  const self = m.masker.maskText(word) === word;
  const kind: FailureKind = MODELED.test(word) ? 'maskLeak' : 'maskLeakScript';
  const same = m.leaks.filter((l) => l.kind === kind).length;
  if (same < 6) m.leaks.push({ kind, detail: `${where}: real word ${JSON.stringify(word)}${self ? ' (the masker maps it to itself)' : ''}` });
}

/** One masked cell against the real value it came from: none of the real cell's checkable words may survive. */
function checkCellPair(m: MaskCtx, where: string, real: PayloadCell | undefined, masked: PayloadCell | undefined, col: InCol | undefined, maskType: string | undefined): void {
  if (real === null || real === undefined) return;
  if (typeof real === 'number') {
    const id = m.idNumbers.get(real);
    if (id && masked === real) {
      if (id.maskedAsId) leakOf(m, `${where} (ID column "${id.header}")`, String(real));
      else if (!m.reportedIdColumns.has(id.header)) {
        m.reportedIdColumns.add(id.header);
        m.findings.push({ kind: 'idNumberSentReal', detail: `"${id.header}" holds generated ID numbers, maskTypes does not mask it as an ID (sent real)` });
      }
    }
    return;
  }
  if (typeof real !== 'string' || typeof masked !== 'string') return;
  const sensitiveCol = col !== undefined ? SENSITIVE_KINDS.has(col.kind) : maskType === 'text' || maskType === 'idLike';
  if (!sensitiveCol) return;
  // The payload cuts a cell at 40 characters: only words wholly inside the masked cell's length can be compared.
  const maskedWords = new Set(tokens(masked));
  for (const w of tokens(real)) {
    if (!checkable(w) || m.allowed.has(w)) continue;
    if (maskedWords.has(w)) leakOf(m, where, w);
  }
}

/** Every string (except headers and format names) and every number anywhere in a JSON value: the parts of the payload with no row index. */
function walk(v: unknown, path: string, onString: (s: string, path: string) => void, onNumber: (n: number, path: string) => void, key = ''): void {
  // A problem's `message` is English prose ("the example output has a title row ..."): only the values it quotes are data.
  if (typeof v === 'string') onString(key === 'message' ? (v.match(/"(?:[^"\\]|\\.)*"/g) ?? []).join(' ') : v, path);
  else if (typeof v === 'number') onNumber(v, path);
  else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`, onString, onNumber));
  else if (v !== null && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      if (['header', 'sheetName', 'shape', 'format', 'type', 'rel', 'mode', 'op', 'direction', 'language', 'to', 'from', 'separator', 'encoding', 'quote', 'delimiter', 'agg', 'fn', 'containsDate', 'kind'].includes(k)) continue;
      walk(x, `${path}.${k}`, onString, onNumber, k);
    }
  }
}

function checkLooseParts(m: MaskCtx, label: string, value: unknown): void {
  walk(
    value,
    label,
    (s, path) => {
      for (const w of tokens(s)) if (checkable(w, 6) && !m.allowed.has(w) && m.sensitive.has(w)) leakOf(m, `${path} (word of "${m.sensitive.get(w)}")`, w);
    },
    (n, path) => {
      const id = m.idNumbers.get(n);
      if (id?.maskedAsId) leakOf(m, `${path} (ID column "${id.header}")`, String(n));
    },
  );
}

function maskCheck(c: StressCase, analysis: PairAnalysis, res: LearnFromExamplesResult): { leaks: { kind: FailureKind; detail: string }[]; findings: Finding[] } {
  const findings: Finding[] = [];
  const pf = preflight(analysis, 'paid');
  if (pf.status === 'block') return { leaks: [], findings };
  const masker = createMasker(MASK_KEY);
  const readiness = aiReadiness(analysis, pf, { masker });
  if (!readiness.ready || !readiness.built) {
    findings.push({ kind: 'payloadNotBuilt', detail: readiness.ready ? 'no payload' : readiness.issues.map((i) => i.code).join(', ') });
    return { leaks: [], findings };
  }
  const built = readiness.built;
  const payload: LearnPayload = built.payload;
  const types = maskTypes(analysis);
  const kinds = inputKinds(c, analysis);
  const allowed = allowedReal(c, analysis);
  const sensitive = new Map<string, string>();
  const idNumbers = new Map<number, { header: string; maskedAsId: boolean }>();
  analysis.input.rows.forEach((row) => {
    row.forEach((cell, i) => {
      const col = kinds[i];
      const v = cell?.v;
      const header = analysis.input.headers[i] ?? `column${i + 1}`;
      if (typeof v === 'string' && ((col && SENSITIVE_KINDS.has(col.kind)) || (!col && (types.input[i] === 'text' || types.input[i] === 'idLike')))) {
        for (const w of tokens(v)) if (checkable(w) && !allowed.has(w)) sensitive.set(w, header);
      }
      if (typeof v === 'number' && Number.isInteger(v) && String(Math.abs(v)).length >= 6 && (types.input[i] === 'idLike' || (col && (col.kind === 'idNum' || col.kind === 'israeliId')))) {
        idNumbers.set(v, { header, maskedAsId: types.input[i] === 'idLike' });
      }
    });
  });
  const m: MaskCtx = { c, analysis, masker, allowed, kinds, types, sensitive, idNumbers, leaks: [], findings, reportedIdColumns: new Set() };

  // Samples: each against the rows it came from.
  payload.samples.forEach((s, i) => {
    const rows = built.sampleRows[i];
    if (!rows) return;
    const realIn = analysis.input.rows[rows.in] ?? [];
    s.in.forEach((masked, col) => checkCellPair(m, `samples[${i}].in[${col}]`, realIn[col]?.v ?? null, masked, kinds[col], types.input[col]));
    const outs = Array.isArray(s.out[0]) ? (s.out as PayloadCell[][]) : [s.out as PayloadCell[]];
    outs.forEach((outRow, k) => {
      const sheetRow = analysis.output.dataRows[rows.out[k] ?? -1];
      const realOut = sheetRow !== undefined ? (analysis.output.sheet.rows[sheetRow] ?? []) : [];
      outRow.forEach((masked, col) => {
        const real = realOut[col]?.v ?? null;
        if (typeof real === 'string' && typeof masked === 'string') {
          const maskedWords = new Set(tokens(masked));
          for (const w of tokens(real)) if (checkable(w) && !allowed.has(w) && sensitive.has(w) && maskedWords.has(w)) leakOf(m, `samples[${i}].out[${col}] (word of "${sensitive.get(w)}")`, w);
        } else checkCellPair(m, `samples[${i}].out[${col}]`, real, masked, undefined, types.output[col]);
      });
    });
  });
  (payload.dropped ?? []).forEach((d, i) => {
    const realIn = analysis.input.rows[built.droppedRows[i] ?? -1] ?? [];
    d.forEach((masked, col) => checkCellPair(m, `dropped[${i}][${col}]`, realIn[col]?.v ?? null, masked, kinds[col], types.input[col]));
  });
  // Everything else: hints, layout, column stats.
  checkLooseParts(m, 'hints', payload.hints);
  checkLooseParts(m, 'input', payload.input);
  checkLooseParts(m, 'output', payload.output);

  // What the learning loop would send next: a few more rows, masked by the same masker.
  const sent = new Set(built.sampleRows.map((r) => r.in));
  let extra = 0;
  for (let r = 0; r < analysis.input.rows.length && extra < 4; r++) {
    if (sent.has(r)) continue;
    extra++;
    const s = counterexampleSample(analysis, r, masker);
    const realIn = analysis.input.rows[r] ?? [];
    s.in.forEach((masked, col) => checkCellPair(m, `loop row ${r}.in[${col}]`, realIn[col]?.v ?? null, masked, kinds[col], types.input[col]));
    checkLooseParts(m, `loop row ${r}.out`, s.out);
  }
  // A repair round's problems: the learned rules (or rules with no column) verified on every row, masked.
  if (res.rules) {
    const v = verifyAgainstExample(res.rules, analysis, { masker, wrongRows: true });
    checkLooseParts(m, 'repairProblems', v.repairProblems);
  }
  return { leaks: m.leaks, findings };
}

// ---------------------------------------------------------------------------
// The case
// ---------------------------------------------------------------------------

function flaggedRows(res: Extract<ConvertResult, { ok: true }>): Set<number> {
  return new Set(res.flags.filter((f) => f.accepted !== true).map((f) => f.rowNumber));
}

function outputFileOf(rules: LearnResult): { type: 'xlsx' | 'csv' | 'txt'; delimiter?: string; encoding?: string } {
  return rules.output.file ?? { type: 'xlsx' };
}

export async function checkCase(c: StressCase, opts: CheckOptions = {}): Promise<CaseResult> {
  const failures: Failure[] = [];
  const findings: Finding[] = [];
  const fail = (kind: FailureKind, invariant: number, detail: string): void => void failures.push({ kind, invariant, detail });
  const result: CaseResult = {
    seed: c.seed,
    profile: c.profile,
    features: c.features,
    rowsIn: c.exampleRows.length,
    cols: c.cols.length,
    outCols: c.rules.output.columns.length,
    fileType: c.layout.fileType,
    outFileType: c.rules.output.file?.type ?? 'xlsx',
    path: 'error',
    solved: 0,
    needsAiParts: [],
    failures,
    findings,
    ms: { gen: c.genMs, learn: 0, convert: 0, holdout: 0, mask: 0 },
    learned: null,
  };
  const budget = opts.budgetMs ?? 10_000;
  const big = c.exampleRows.length >= (opts.budgetRows ?? 15_000) && c.cols.length >= (opts.budgetCols ?? 15);

  // ---- 2 (reading): every generated data row is read, by the reference run too (the engine's own table detection decides that) ----
  for (const [label, ref, rows] of [['example', c.refExample, c.exampleRows], ['hold-out', c.refNext, c.nextRows]] as const) {
    if (ref.summary.rowsIn !== rows.length) fail('rowsMisread', 2, `${label}: the file has ${rows.length} data rows, the engine read ${ref.summary.rowsIn} (table detection: header row ${ref.detection.headerRow + 1}, data ${ref.detection.dataStart + 1}-${ref.detection.dataEnd + 1}, footer rows ${JSON.stringify(ref.detection.footerRows.map((r) => r + 1))})`);
  }

  // ---- 5: the reference outputs themselves ----
  const refFile = outputFileOf(c.rules);
  for (const [label, bytes] of [['reference example output', c.output.bytes], ['reference hold-out output', c.nextOutput.bytes]] as const) {
    const lf = await liveFormulas(bytes, refFile, label);
    for (const f of lf.failures) fail('liveFormula', 5, f);
    for (const f of lf.leadingControl) findings.push({ kind: 'csvLeadingControl', detail: f });
  }

  // ---- 1: the free learn ----
  let analysis: PairAnalysis | undefined;
  let res: LearnFromExamplesResult;
  const t0 = Date.now();
  try {
    res = await learnFromExamples({
      input: { bytes: c.input.bytes, name: c.input.name },
      output: { bytes: c.output.bytes, name: c.output.name },
      masking: false,
      tier: 'paid',
      ai: 'notAllowed',
      callLearn: async () => {
        throw new Error('the stress test never calls the AI step');
      },
      onAnalysis: (a) => {
        analysis = a;
      },
    });
  } catch (e) {
    result.ms.learn = Date.now() - t0;
    fail('learnThrew', 1, (e as Error).stack?.split('\n').slice(0, 4).join(' | ') ?? String(e));
    return result;
  }
  result.ms.learn = Date.now() - t0;
  if (big && result.ms.learn > budget) fail('slow', 6, `learn took ${result.ms.learn} ms on ${c.exampleRows.length} x ${c.cols.length}`);
  result.path = res.path;
  result.learned = res.rules;

  if (!['local', 'partial', 'blocked', 'notReady'].includes(res.path)) fail('badPath', 1, `path "${res.path}" with the AI step not allowed`);
  if (res.path === 'blocked' && !res.preflight.issues.some((i) => i.severity === 'block' || i.severity === 'warn')) fail('badPath', 1, 'blocked with no block or warning stated');
  if (res.path === 'notReady' && (!res.readiness || res.readiness.ready || res.readiness.issues.length === 0)) fail('badPath', 1, 'notReady with no readiness issue stated');
  if ((res.path === 'local' || res.path === 'partial') && !res.rules) fail('badPath', 1, `path ${res.path} with no rules`);

  // ---- 4: masking ----
  if (!opts.noMask && analysis) {
    const tm = Date.now();
    try {
      const mc = maskCheck(c, analysis, res);
      for (const l of mc.leaks) fail(l.kind, 4, l.detail);
      findings.push(...mc.findings);
    } catch (e) {
      fail('checkCrashed', 4, `mask check threw: ${(e as Error).stack?.split('\n').slice(0, 3).join(' | ')}`);
    }
    result.ms.mask = Date.now() - tm;
  }

  const rules = res.rules;
  if (!rules || (res.path !== 'local' && res.path !== 'partial')) return result;

  const total = rules.output.columns.length;
  const solvedIdx = res.path === 'local' ? [...Array(total).keys()] : (res.partial?.solvedColumns ?? []);
  result.solved = solvedIdx.length;
  result.needsAiParts = res.partial?.needsAiParts ?? [];
  const complete = res.path === 'local' || (solvedIdx.length === total && (res.partial?.needsAiParts.length ?? 0) === 0);
  const assumed = rules.assumptions.length > 0;

  // ---- 3: what is not solved is reported, and left empty ----
  if (res.path === 'partial' && res.partial) {
    const p = res.partial;
    if (p.solved.length + p.needsAi.length !== total) fail('unsolvedNotReported', 3, `${total} output columns, ${p.solved.length} solved + ${p.needsAi.length} needing the AI step`);
    rules.output.columns.forEach((col, i) => {
      const solved = p.solvedColumns.includes(i);
      if (!solved && col.from !== null) fail('unsolvedFilled', 3, `column ${i + 1} "${col.header}" is not solved but reads "${col.from}"`);
      if (solved && col.from === null) fail('unsolvedNotReported', 3, `column ${i + 1} "${col.header}" is listed as solved but has no rule`);
      if (!solved && !p.needsAi.includes(col.header)) fail('unsolvedNotReported', 3, `column ${i + 1} "${col.header}" is neither solved nor listed as needing the AI step`);
    });
  }

  // ---- 2: the example, converted with what was learned ----
  const tc = Date.now();
  let mine: ConvertResult;
  try {
    mine = await convertFile(rules, c.input.bytes, c.input.name);
  } catch (e) {
    fail('learnedConvertFailed', 2, `convertFile(example) threw: ${(e as Error).message}`);
    return result;
  }
  result.ms.convert = Date.now() - tc;
  if (big && result.ms.convert > budget) fail('slow', 6, `convert took ${result.ms.convert} ms on ${c.exampleRows.length} x ${c.cols.length}`);
  if (!mine.ok) {
    fail('learnedConvertFailed', 2, `convertFile(example) failed: ${JSON.stringify(mine.error)}`);
    return result;
  }
  {
    const lf = await liveFormulas(mine.bytes, outputFileOf(rules), 'learned example output');
    for (const f of lf.failures) fail('liveFormula', 5, f);
  }
  const headerless = rules.output.file?.header === false;
  const delimited = (c.rules.output.file?.type ?? 'xlsx') !== 'xlsx';
  const verified = res.verification?.verified === true;
  if (res.path === 'local' && !verified) {
    const m = res.verification?.mismatches[0];
    findings.push({ kind: 'localNotVerified', detail: `the fast path's rules do not verify: ${res.verification?.layoutProblems[0] ?? `${res.verification?.matched}/${res.verification?.total} rows`}${m ? `; e.g. row ${m.exampleRow} "${m.column}": expected ${JSON.stringify(m.expected)}, got ${JSON.stringify(m.actual)}` : ''}` });
  }
  if (complete && verified) {
    const d = firstSheetDiff(c.refExample.sheet.rows, mine.sheet.rows, headerless, delimited);
    if (d) fail('verifiedButDiffers', 2, `${res.path} result reported verified, but the example converts differently: ${d}`);
  }
  {
    const { diffs } = diffColumns(c.refExample.sheet.rows, mine.sheet.rows, solvedIdx, delimited);
    const reported = new Set(res.verification?.mismatches.map((x) => x.column) ?? []);
    const byCol = new Map<number, CellDiff[]>();
    for (const d of diffs) byCol.set(d.col, [...(byCol.get(d.col) ?? []), d]);
    for (const [col, ds] of byCol) {
      const header = rules.output.columns[col]?.header ?? `column${col + 1}`;
      const d = ds[0]!;
      const detail = `column ${col + 1} "${header}": ${ds.length} cell(s) differ from the example, e.g. input row ${d.sourceRow}: expected ${show(d.expected)}, got ${show(d.actual)}`;
      if (verified || !reported.has(header)) fail('solvedColumnWrong', 2, `${res.path} result ${verified ? 'reported verified' : 'built the column'} - ${detail}`);
      else findings.push({ kind: 'partialMismatchReported', detail });
    }
  }

  // ---- 2: the hold-out, converted with what was learned: right, or the row is flagged ----
  const th = Date.now();
  let next: ConvertResult;
  try {
    next = await convertFile(rules, c.nextInput.bytes, c.nextInput.name);
  } catch (e) {
    fail('holdoutConvertFailed', 2, `convertFile(hold-out) threw: ${(e as Error).message}`);
    return result;
  }
  result.ms.holdout = Date.now() - th;
  if (!next.ok) {
    fail('holdoutConvertFailed', 2, `the learned rules cannot convert the hold-out file the reference rules convert: ${JSON.stringify(next.error)}`);
    return result;
  }
  {
    const lf = await liveFormulas(next.bytes, outputFileOf(rules), 'learned hold-out output');
    for (const f of lf.failures) fail('liveFormula', 5, f);
  }
  if (verified || res.path === 'partial') {
    const flagged = flaggedRows(next);
    // A column the example's own check already shows wrong is reported, not silent: the hold-out judges the others.
    const reported = new Set(res.verification?.mismatches.map((x) => x.column) ?? []);
    const judged = solvedIdx.filter((i) => !reported.has(rules.output.columns[i]?.header ?? ''));
    const { diffs, onlyExpected, onlyActual } = diffColumns(c.refNext.sheet.rows, next.sheet.rows, judged, delimited);
    const silent = diffs.filter((d) => d.actual?.flagged !== true && !flagged.has(d.sourceRow));
    if (silent.length > 0) {
      const d = silent[0]!;
      const header = rules.output.columns[d.col]?.header ?? `column${d.col + 1}`;
      const cols = [...new Set(silent.map((x) => x.col + 1))];
      const detail = `${silent.length} hold-out cell(s) wrong and not flagged (columns ${cols.join(', ')}), e.g. input row ${d.sourceRow}, "${header}": expected ${show(d.expected)}, got ${show(d.actual)}`;
      if (assumed) findings.push({ kind: 'holdoutAssumed', detail: `${detail}; the rules state: ${rules.assumptions.map((a) => a.reasonCode).join(', ')}` });
      else fail('holdoutSilent', 2, `${res.path}${verified ? ' (verified)' : ''}: ${detail}`);
    }
    if (complete && verified && (onlyExpected.length > 0 || onlyActual.length > 0)) {
      const detail = `hold-out rows differ: ${onlyExpected.length} row(s) the reference makes are missing (input rows ${onlyExpected.slice(0, 5).join(', ')}), ${onlyActual.length} extra (input rows ${onlyActual.slice(0, 5).join(', ')})`;
      if (assumed) findings.push({ kind: 'holdoutAssumed', detail: `${detail}; the rules state: ${rules.assumptions.map((a) => a.reasonCode).join(', ')}` });
      else fail('holdoutRowsSilent', 2, detail);
    } else if (complete && verified && silent.length === 0) {
      // Same rows and cells: only a layout row or the order can still differ.
      const d = layoutDiff(c.refNext.sheet.rows, next.sheet.rows, headerless, delimited);
      if (d && !assumed) fail('holdoutLayout', 2, `hold-out layout differs: ${d}`);
    }
  }
  return result;
}
