// Pair analysis (SPEC 6.2): everything code can learn from an example input
// and its hand-made output, on ALL rows of the real data, before any LLM call.
// Runs in the browser worker; pure, synchronous and deterministic (the random
// sample uses a seeded PRNG; no clock, no locale).

import type { RawWorkbook } from '../../types';
import { gather, isoOfSerial, normFast, norms, type ColumnData } from './cells';
import { alignRows } from './align';
import { findDerivation } from './derived';
import { analyzeDropped } from './dropped';
import { detectFamilies, type CreatedData, type FamilyFinding } from './families';
import { analyzeLayout } from './layout';
import { sampleIndices } from './prng';
import { profileColumn } from './profile';
import { findRelations, summaryRelations, type RelationEnv } from './relations';
import { decideHeader, explainedRate, firstRowExplained, HEADER_MIN_EXPLAINED, headerRowMayBeData } from './headerCheck';
import { identicalSheets, readInput, readOutput, type InputData, type OutputData } from './tables';
import type {
  AnalysisStage,
  AnalyzeOptions,
  ColumnAnalysis,
  ColumnProfile,
  CreatedColumn,
  PairAnalysis,
  PairAnalysisResult,
  PairShape,
  Relation,
  SideIssue,
} from './types';

export const DEFAULT_SAMPLE_SIZE = 2000;
export const DEFAULT_SEED = 1;
export const DEFAULT_MIN_COVERAGE = 0.9;

/** >= 3 output headers (that aren't input headers) equal values of one input column (SPEC 6.2 step 3). */
function detectPivot(
  inCols: ColumnData[],
  inHeaders: string[],
  outHeaders: string[],
  headerless: boolean,
): { in: number; outColumns: number[] } | null {
  if (headerless) return null;
  const inHeaderSet = new Set(inHeaders.map((h) => normFast(h).toLowerCase()));
  const cands = outHeaders
    .map((h, o) => ({ o, n: normFast(h).toLowerCase() }))
    .filter((x) => x.n !== '' && !inHeaderSet.has(x.n));
  if (cands.length < 3) return null;
  let best: { in: number; outColumns: number[] } | null = null;
  inCols.forEach((col, i) => {
    const nm = norms(col);
    const values = new Set<string>();
    for (let k = 0; k < col.n; k++) {
      if (nm[k] === '') continue;
      values.add(nm[k]!);
      if (values.size > 1000) return;
    }
    const hits = cands.filter((x) => values.has(x.n)).map((x) => x.o);
    if (hits.length >= 3 && (best === null || hits.length > best.outColumns.length)) best = { in: i, outColumns: hits };
  });
  return best;
}

function hebrewHeaders(headers: string[]): boolean {
  let letters = 0;
  let hebrew = 0;
  for (const h of headers) {
    for (const ch of h) {
      if (/\p{L}/u.test(ch)) {
        letters++;
        if (ch >= 'א' && ch <= 'ת') hebrew++;
      }
    }
  }
  return letters > 0 && hebrew / letters > 0.5;
}

function columnAnalysis(out: number, header: string, relations: Relation[]): ColumnAnalysis {
  return { out, header, relations, unknown: relations.length === 0, derived: null };
}

/** Facts the relations prove about input columns (SPEC 7.1 serialDates, leadingZerosLost). */
function refineInputProfiles(profile: ColumnProfile[], inCols: ColumnData[], columns: ColumnAnalysis[]): void {
  for (const ca of columns) {
    for (const rel of ca.relations) {
      if (rel.coverage < 1) continue;
      const i = rel.in[0];
      if (i === undefined || i >= profile.length) continue;
      const p = profile[i]!;
      if (rel.rel === 'dateFormat' && rel.from === 'excelSerial' && !p.serialDates) {
        p.serialDates = true;
        p.type = 'date';
        p.dateFormat = 'excelSerial';
        const col = inCols[i]!;
        let min = Infinity;
        let max = -Infinity;
        for (let k = 0; k < col.n; k++) {
          const v = col.num[k]!;
          if (Number.isNaN(v)) continue;
          min = Math.min(min, v);
          max = Math.max(max, v);
        }
        if (min !== Infinity) p.range = [isoOfSerial(min), isoOfSerial(max)];
        delete p.shape;
        delete p.len;
      }
      if (rel.rel === 'padLeft' && rel.char === '0' && (p.type === 'integer' || p.type === 'idLike' || p.type === 'text')) {
        if (p.shape === undefined || /^D+(\|D+)*$/.test(p.shape)) {
          p.leadingZerosLost = true;
          p.type = 'idLike';
          delete p.range;
          if (p.len === undefined && p.nonEmpty > 0) {
            const col = inCols[i]!;
            let lo = Infinity;
            let hi = -Infinity;
            for (let k = 0; k < col.n; k++) {
              if (col.text[k] === '') continue;
              lo = Math.min(lo, col.text[k]!.trim().length);
              hi = Math.max(hi, col.text[k]!.trim().length);
            }
            if (lo !== Infinity) p.len = [lo, hi];
          }
        }
      }
    }
  }
}

/**
 * Analyzes an example pair: tables, profiles, row alignment, output shape,
 * relations per output column, dropped rows, and output layout (SPEC 6.2).
 * Candidate relations are tested on a seeded random `sampleSize` aligned rows
 * first, then confirmed on all rows.
 *
 * For a csv/txt example output whose header row could not be told from data by
 * types (all-text columns, or a first row that reads as data), the pair itself
 * decides (headerCheck.ts): the first row is a header when it is NOT explained
 * as a data row while the rows below it are; otherwise it is data.
 */
export function analyzePair(inputWb: RawWorkbook, outputWb: RawWorkbook, opts: AnalyzeOptions = {}): PairAnalysisResult {
  const progress = (stage: AnalysisStage, fraction: number): void => opts.onProgress?.({ stage, fraction });

  // ---- tables ----
  progress('tables', 0);
  const inRes = readInput(inputWb, opts.inputSheet);
  const inputHeaders = inRes.ok ? inRes.data.side.headers : [];
  const outRes = readOutput(outputWb, opts, inputHeaders);
  if (!inRes.ok || !outRes.ok) {
    return { ok: false, issues: [...(inRes.ok ? [] : inRes.issues), ...(outRes.ok ? [] : outRes.issues)] };
  }
  const inp = inRes.data;
  const run = (outp: OutputData, outNotices: SideIssue[], report: typeof progress): PairAnalysis =>
    analyzeSides(inputWb, inp, inRes.notices, outp, outNotices, opts, report);
  const quiet = (): void => {};

  // The first reading reports progress; a second reading (header check) runs silently.
  let result = run(outRes.data, outRes.notices, progress);
  if (outRes.data.headerUncertain) {
    // DECISION (SPEC 8.13, 6.2): the types gave no evidence either way (or read the first row as
    // data), so test the first row against the pair. A header is a row that is NOT explained as a
    // data row while the rows below it are (>= 90%); a row explained like the others is data.
    if (outRes.data.side.headerless) {
      // Default reading: every row is data. Confirm row 0 is explained; if not, try it as a header.
      if (!(firstRowExplained(result) && explainedRate(result) >= HEADER_MIN_EXPLAINED)) {
        const alt = readOutput(outputWb, opts, inputHeaders, true);
        if (alt.ok) {
          const asHeader = run(alt.data, alt.notices, quiet);
          if (decideHeader(asHeader, result) === 'header') result = asHeader;
        }
      }
    } else if (headerRowMayBeData(result, inp.cols, outRes.data.all)) {
      // Default reading: row 0 is the header. Row 0 can only be data when it has an input row to
      // align with (by position or a key that occurs in the input); otherwise the header stays.
      const alt = readOutput(outputWb, opts, inputHeaders, false);
      if (alt.ok) {
        const asData = run(alt.data, alt.notices, quiet);
        if (decideHeader(result, asData) === 'data') result = asData;
      }
    }
  }
  progress('done', 1);
  return result;
}

/** Everything after reading the two tables (profiles .. layout) for one reading of the output. */
function analyzeSides(
  inputWb: RawWorkbook,
  inp: InputData,
  inNotices: SideIssue[],
  outp: OutputData,
  outNotices: SideIssue[],
  opts: AnalyzeOptions,
  progress: (stage: AnalysisStage, fraction: number) => void,
): PairAnalysis {
  const sampleSize = opts.sampleSize ?? DEFAULT_SAMPLE_SIZE;
  const seed = opts.seed ?? DEFAULT_SEED;
  const minCoverage = opts.minCoverage ?? DEFAULT_MIN_COVERAGE;
  const inSide = inp.side;
  const outSide = outp.side;
  const nIn = inSide.rows.length;
  const nOut = outSide.dataRows.length;

  // ---- profiles ----
  progress('profile', 0.1);
  const inProfile = inp.cols.map((col, i) =>
    profileColumn(col, i, inSide.headers[i] ?? '', (k) => inSide.rows[k]?.[i] ?? null),
  );
  const outProfile = outp.cols.map((col, o) => {
    const width = outSide.sheet.colWidths[o];
    return profileColumn(col, o, outSide.headers[o] ?? '', (k) => outSide.sheet.rows[outSide.dataRows[k]!]?.[o] ?? null, {
      output: true,
      ...(width !== undefined ? { width } : {}),
    });
  });
  const identical = identicalSheets(inputWb.sheets[inSide.sheetIndex]!, outSide.sheet);
  const pivot = detectPivot(inp.cols, inSide.headers, outSide.headers, outSide.headerless);

  // ---- alignment ----
  progress('align', 0.2);
  const { alignment, summary } = alignRows(inp.cols, outp.cols, nIn, nOut, seed);
  const K = alignment.rows.length;
  const outIdx = alignment.rows.map((r) => r.out);
  const inIdx = alignment.rows.map((r) => r.in);
  const outA = outp.cols.map((c) => gather(c, outIdx));

  // ---- shape ----
  progress('shape', 0.3);
  let finding: FamilyFinding | null = null;
  let created: CreatedData[] = [];
  let shape: PairShape;
  if (alignment.method === 'group' && summary !== null) {
    shape = { kind: 'summary', groupIn: summary.groupIn, groupOut: summary.groupOut, groups: summary.groups };
  } else {
    finding = detectFamilies(alignment.rows, inp.cols, inSide.headers, outA);
    const createdCols: CreatedColumn[] = [];
    if (finding.kind !== 'plain' && finding.kind !== 'rowExpansion') {
      created = finding.created;
      created.forEach((c, j) => createdCols.push({ index: inSide.columnCount + j, kind: c.kind }));
    }
    switch (finding.kind) {
      case 'plain':
        shape = { kind: 'plain' };
        break;
      case 'rowExpansion':
        shape = { kind: 'rowExpansion', families: finding.families, sizes: finding.sizes };
        break;
      case 'columnsToRows':
        shape = {
          kind: 'families',
          pattern: { mode: 'columnsToRows', in: finding.in, labelOut: finding.labelOut, valueOut: finding.valueOut, skipEmpty: finding.skipEmpty },
          families: finding.families,
          created: createdCols,
        };
        break;
      case 'splitCell':
        shape = {
          kind: 'families',
          pattern: { mode: 'splitCell', in: [finding.in], separator: finding.separator, out: finding.out, trim: true, skipEmpty: true },
          families: finding.families,
          created: createdCols,
        };
        break;
      case 'fixedFanOut':
        shape = {
          kind: 'families',
          pattern: { mode: 'fixedFanOut', size: finding.size, positions: [] },
          families: finding.families,
          created: createdCols,
        };
        break;
    }
  }
  if (pivot !== null) shape = { kind: 'pivot', in: pivot.in, outColumns: pivot.outColumns };

  // ---- relations ----
  progress('relations', 0.35);
  const language: 'he' | 'en' = outSide.headerless
    ? outSide.direction === 'rtl'
      ? 'he'
      : 'en'
    : hebrewHeaders(outSide.headers)
      ? 'he'
      : 'en';
  const sample = sampleIndices(K, sampleSize, seed);
  const columns: ColumnAnalysis[] = [];
  const nCols = outA.length;
  if (alignment.method === 'group' && summary !== null) {
    const groups = summary.groups;
    for (let o = 0; o < nCols; o++) {
      const rels = summaryRelations(inp.cols, outA[o]!, o, groups, summary.groupIn, o === summary.groupOut, minCoverage);
      columns.push(columnAnalysis(o, outSide.headers[o] ?? '', rels));
      progress('relations', 0.35 + (0.45 * (o + 1)) / Math.max(1, nCols));
    }
  } else {
    const src = [...inp.cols.map((c) => gather(c, inIdx)), ...created.map((c) => c.col)];
    const env: RelationEnv = { src, inputCount: inp.cols.length, total: K, sample, minCoverage, language };
    for (let o = 0; o < nCols; o++) {
      const rels = findRelations(env, outA[o]!, o, outProfile[o]?.format);
      const ca = columnAnalysis(o, outSide.headers[o] ?? '', rels);
      // SPEC 6.2 step 4 (v5): an unknown column the input still determines is derived (the AI can solve it),
      // not external data.
      if (ca.unknown) ca.derived = findDerivation(env, outA[o]!);
      columns.push(ca);
      progress('relations', 0.35 + (0.4 * (o + 1)) / Math.max(1, nCols));
    }
    // Fixed fan-out: relations per position in the family.
    if (finding?.kind === 'fixedFanOut' && shape.kind === 'families' && shape.pattern.mode === 'fixedFanOut') {
      const pos = created[0]!.col;
      const positions: ColumnAnalysis[][] = [];
      for (let p = 0; p < finding.size; p++) {
        const rowsP: number[] = [];
        for (let k = 0; k < K; k++) if (pos.num[k] === p + 1) rowsP.push(k);
        const envP: RelationEnv = {
          src: src.map((c) => gather(c, rowsP)),
          inputCount: inp.cols.length,
          total: rowsP.length,
          sample: sampleIndices(rowsP.length, sampleSize, seed + p + 1),
          minCoverage,
          globalIndex: rowsP,
          language,
        };
        const perCol: ColumnAnalysis[] = [];
        for (let o = 0; o < nCols; o++) {
          const outP = gather(outA[o]!, rowsP);
          perCol.push(columnAnalysis(o, outSide.headers[o] ?? '', findRelations(envP, outP, o, outProfile[o]?.format)));
        }
        positions.push(perCol);
      }
      shape.pattern.positions = positions;
    }
  }

  // ---- dropped rows ----
  progress('dropped', 0.8);
  const keptSet = new Set<number>();
  if (alignment.method === 'group' && summary !== null) for (const g of summary.groups) for (const r of g) keptSet.add(r);
  else for (const r of inIdx) keptSet.add(r);
  const keptRows = [...keptSet].sort((a, b) => a - b);
  const explains = finding && 'explainsDrop' in finding ? finding.explainsDrop : null;
  const explainedByExpand = explains ? alignment.droppedIn.filter((r) => explains(r)) : [];
  const expandSet = new Set(explainedByExpand);
  const droppedRows = alignment.droppedIn.filter((r) => !expandSet.has(r));
  const dropped = analyzeDropped(inp.cols, nIn, keptRows, droppedRows, explainedByExpand, alignment.key?.in ?? [], minCoverage);

  // ---- layout ----
  progress('layout', 0.9);
  const layout = analyzeLayout({
    out: outSide,
    outProfile,
    all: outp.all,
    data: outp.cols,
    inCols: inp.cols,
    inProfile,
    alignment,
    keptRows,
    summaryGroupOut: shape.kind === 'summary' ? shape.groupOut : null,
  });

  refineInputProfiles(inProfile, inp.cols, columns);

  const result: PairAnalysis = {
    ok: true,
    issues: [...inNotices, ...outNotices],
    identical,
    input: { ...inSide, profile: inProfile },
    output: { ...outSide, profile: outProfile },
    pivot,
    alignment,
    shape,
    columns,
    dropped,
    layout,
    sample: { size: sample.length, seed },
  };
  return result;
}
