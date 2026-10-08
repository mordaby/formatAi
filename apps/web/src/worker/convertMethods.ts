// The worker methods of "convert a file" and "batch" (SPEC 5 C/D, 8.12, 21 v5 item 5). They run on the user's real
// files, in the worker; the main thread only sees headers, counts, flags and the bytes it hands to the browser's
// download. Like the rest of the worker there is no network code here: matching takes the signatures (headers only)
// as an argument, and rules are fetched by the main thread.
import {
  extractTable,
  findFormatMatches,
  formatYmd,
  mapHeaders,
  matchConversions,
  missingInputColumns,
  pickConversion,
  readWorkbook,
  runRules,
  serialToYmd,
  unlikeColumns,
  writeOutput,
  writeXlsxWorkbook,
  writeZip,
} from '@formatai/engine';
import type { InputTable, OutputSheet, OutRow, RawCell, RawWorkbook } from '@formatai/engine';
import type { LearnResult, Rules } from '@formatai/shared';
import type { BatchArgs, BatchOutput, ColumnGapsArgs, ColumnGapsOutput, ConvertRunArgs, ConvertRunOutput, FormatMatchesArgs, FormatMatchesOutput, HeadersArgs, HeadersOutput, MatchFileArgs, MatchFileOutput, RowInputCell, SummaryTable } from './convertApi';
import { Transfer } from './runtime';

/** A detached-safe ArrayBuffer holding exactly `bytes`. */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buf = bytes.buffer as ArrayBuffer;
  if (bytes.byteOffset === 0 && bytes.byteLength === buf.byteLength) return buf;
  return buf.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

type Opened = { ok: true; wb: RawWorkbook } | { ok: false; reason: 'unreadable' };

/** An unsupported file type is the caller's error (the UI explains it); anything else that fails to open is "unreadable". */
async function open(file: { name: string; bytes: ArrayBuffer }): Promise<Opened> {
  try {
    return { ok: true, wb: await readWorkbook(new Uint8Array(file.bytes), file.name) };
  } catch (e) {
    if ((e as { code?: unknown } | null)?.code === 'unsupportedFileType') throw e;
    return { ok: false, reason: 'unreadable' };
  }
}

// ---------- the headers of a file, and matching ----------

/** The file's table as the engine would read it with no rules (first sheet, header row found automatically). */
async function readTable(file: { name: string; bytes: ArrayBuffer }): Promise<{ ok: true; table: InputTable } | { ok: false; reason: 'unreadable' | 'noTable' }> {
  const opened = await open(file);
  if (!opened.ok) return opened;
  const extracted = extractTable(opened.wb, {});
  if (!extracted.ok) return { ok: false, reason: 'noTable' };
  return { ok: true, table: extracted.table };
}

/** The headers of a file's table (SPEC 5 C: what matching looks at; never data). */
async function readHeaders(args: HeadersArgs): Promise<HeadersOutput> {
  const read = await readTable(args.file);
  if (!read.ok) return read;
  const { table } = read;
  return { ok: true, headers: table.headers, sheetName: table.sheetName, direction: table.direction, rows: table.rows.length };
}

/** Matches a file's headers against every saved SOURCE's signature (SPEC 8.12, 8.15); the pick is the engine's own rule. */
async function matchFile(args: MatchFileArgs): Promise<MatchFileOutput> {
  const read = await readTable(args.file);
  if (!read.ok) return read;
  const ranked = matchConversions(read.table.headers, args.signatures);
  return { ok: true, headers: read.table.headers, rows: read.table.rows.length, ranked, pick: pickConversion(ranked) };
}

/**
 * A learned example that matches a saved format (owner decision 2026-10-07, SPEC 5 A step 8): the formats whose output has the same structure,
 * whether the example input is one of their sources, and the format lock. Headers and rules only: no file is read.
 */
async function formatMatches(args: FormatMatchesArgs): Promise<FormatMatchesOutput> {
  return findFormatMatches({ rules: args.rules, inputHeaders: args.inputHeaders, candidates: args.candidates, sources: args.sources });
}

/**
 * What each conversion needs that the file does not have (SPEC 8.15, 21 v11 items 4-7): a required column, or a column the rules use though it is
 * optional. From the file's headers as matching read them, with the engine's own header mapping - nothing is parsed again.
 */
async function columnGaps(args: ColumnGapsArgs): Promise<ColumnGapsOutput> {
  return args.rules.map((rules) => missingInputColumns(rules, args.headers));
}

// ---------- running a conversion with the user's decisions ----------

/** A cell as text the column's own reader will accept back (a date cell shows in the column's date format). */
function cellValue(cell: RawCell | null | undefined, format: string | undefined, date1904: boolean): string | number | boolean | null {
  if (!cell || cell.v === null || cell.v === undefined) return null;
  if (cell.isDate === true && typeof cell.v === 'number') {
    try {
      return formatYmd(serialToYmd(cell.v, date1904), format ?? 'dd/mm/yyyy', 'en');
    } catch {
      return cell.v;
    }
  }
  return cell.v;
}

/** The input values of the rows the user has to look at, by the rules' input columns. */
function inputsOfRows(rules: LearnResult | Rules, table: InputTable, rowNumbers: Iterable<number>): Record<number, RowInputCell[]> {
  const cols = rules.input.columns;
  const { src } = mapHeaders(cols, table.headers);
  const indexOfRow = new Map<number, number>();
  table.rowNumbers.forEach((n, i) => indexOfRow.set(n, i));
  const out: Record<number, RowInputCell[]> = {};
  for (const rowNumber of rowNumbers) {
    const i = indexOfRow.get(rowNumber);
    if (i === undefined) continue;
    const raw = table.rows[i] ?? [];
    const cells: RowInputCell[] = [];
    cols.forEach((c, ci) => {
      const at = src[ci] ?? -1;
      if (at < 0) return; // an optional column the file doesn't have: nothing to show
      const cell = raw[at];
      cells.push({
        columnId: c.id,
        header: c.header,
        value: cellValue(cell, c.inputFormats?.[0], table.date1904 === true),
        ...(typeof cell?.v === 'string' && cell.v !== '' ? { isText: true as const } : {}),
      });
    });
    out[rowNumber] = cells;
  }
  return out;
}

/**
 * Flow C's run (SPEC 5 C) with per-run row decisions (SPEC 21 v5 item 5). In `review` mode the rules are run first and
 * the file is written only when nothing needs the user's eye; otherwise the flagged rows and their input values go
 * back, and the caller comes again with `mode: 'write'` and the decisions. The saved rules are never touched.
 */
async function convertWithDecisions(args: ConvertRunArgs): Promise<Transfer<ConvertRunOutput> | ConvertRunOutput> {
  const { rules, file, mode } = args;
  const opened = await open(file);
  if (!opened.ok) throw Object.assign(new Error('The file could not be read'), { code: 'unreadable' });
  const extracted = extractTable(opened.wb, rules.input);
  if (!extracted.ok) return { ok: false, error: extracted.error };
  const result = runRules(rules, extracted.table, {
    fileName: file.name,
    ...(args.rowDecisions !== undefined ? { rowDecisions: args.rowDecisions } : {}),
  });
  if (!result.ok) return { ok: false, error: result.error };

  const fileType = result.sheet.file?.type ?? 'xlsx';
  // SPEC 21 v11 items 4-7: a used column whose values mostly failed to parse is "same name, different meaning" - counts only, from the flags.
  const unlike = unlikeColumns(rules, result.flags, result.summary.rowsIn);
  const base = { ok: true as const, flags: result.flags, summary: result.summary, fileType, ...(unlike.length > 0 ? { unlike } : {}) };

  if (mode === 'review') {
    // Rows to look at: a flag not yet accepted, or a row a check with severity "block" left out.
    const rows = new Set<number>();
    for (const f of result.flags) if (f.accepted !== true) rows.add(f.rowNumber);
    for (const b of result.summary.blockedRows) rows.add(b.rowNumber);
    if (rows.size > 0) return { ...base, written: false, rowInputs: inputsOfRows(rules, extracted.table, rows) };
  }

  const bytes = toArrayBuffer(await writeOutput(result.sheet));
  const out: ConvertRunOutput = {
    ...base,
    written: true,
    bytes,
    preview: { ...result.sheet, rows: result.sheet.rows.slice(0, args.previewRows) },
    totalRows: result.sheet.rows.length,
  };
  return new Transfer(out, [bytes]);
}

// ---------- packing a batch ----------

function tableSheet(table: SummaryTable, language: 'he' | 'en'): OutputSheet {
  const rows: OutRow[] = [
    { kind: 'header', bold: true, cells: table.headers.map((h) => ({ v: h })) },
    ...table.rows.map((r): OutRow => ({ kind: 'data', cells: r.map((v) => ({ v })) })),
  ];
  return {
    name: table.sheetName,
    direction: language === 'he' ? 'rtl' : 'ltr',
    language,
    columns: table.headers.map((h, i) => ({
      header: h,
      // A width from the content, so the sheet opens readable (Excel characters, capped).
      width: Math.min(48, Math.max(10, h.length + 2, ...table.rows.slice(0, 200).map((r) => String(r[i] ?? '').length + 2))),
    })),
    rows,
    merges: [],
  };
}

/** A name that is safe as one zip path segment. */
function segment(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim();
  return cleaned === '' ? '_' : cleaned.slice(0, 80);
}

/** Two files with the same name in one folder must not overwrite each other in the zip: "a.xlsx", "a (2).xlsx". */
function uniquePath(used: Set<string>, folder: string, fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  const stem = dot > 0 ? fileName.slice(0, dot) : fileName;
  const ext = dot > 0 ? fileName.slice(dot) : '';
  const dir = folder === '' ? '' : `${segment(folder)}/`;
  let path = `${dir}${segment(stem)}${ext}`;
  for (let n = 2; used.has(path.toLowerCase()); n++) path = `${dir}${segment(stem)} (${n})${ext}`;
  used.add(path.toLowerCase());
  return path;
}

/** SPEC 5 D: the download of a batch - every converted file in a folder per format, plus the summary workbook. */
async function batch(args: BatchArgs): Promise<Transfer<BatchOutput>> {
  const { files, flags, language } = args.summary;
  const summary = toArrayBuffer(await writeXlsxWorkbook([tableSheet(files, language), tableSheet(flags, language)]));
  const used = new Set<string>();
  const entries = args.outputs.map((o) => ({ path: uniquePath(used, o.folder, o.fileName), bytes: o.bytes }));
  const summaryPath = uniquePath(used, '', args.summaryFileName);
  const zip = toArrayBuffer(await writeZip([...entries, { path: summaryPath, bytes: summary }]));
  // The summary is sent back as its own copy: the zip holds one, the download button another.
  const alone = summary.slice(0);
  return new Transfer({ zip, summary: alone }, [zip, alone]);
}

export const convertMethods = { readHeaders, matchFile, formatMatches, columnGaps, convertWithDecisions, batch };
