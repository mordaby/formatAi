// Flow D as a state machine (SPEC 5 D, 8.15): many files, one at a time in the worker. It is the several-files half of the Run
// screen (/convert): the page owns the saved sources (scoped by `?format=`) and hands them in. Each file is matched to a SOURCE on its
// own (only a clear, single winner is used: no guessing, no per-file mapping in the MVP) and converted with the rules of every
// conversion that source has, and gets a status: converted, converted with flags, or didn't match. Then the worker packs a zip
// (a folder per format) and a summary workbook. Files and their bytes stay on this computer; POST /runs gets counts only.
//
// DECISION (SPEC 5 D, owner 2026-10-08): every file is matched FIRST. When some file's source feeds several formats, the batch asks ONCE,
// for all its files, which formats to make - the formats the matched files can be made into, each with how many files, none ticked - and
// each file is then made into the chosen formats its source feeds (a file none of whose formats was chosen is "not made", and said so).
// Two senders can use the same column names for different things, so a format made is always one the user ticked. When every matched
// source feeds one format (always so on `?format=`), nothing is asked. The list holds one BatchItem per (file, conversion): results stay
// grouped by format, the zip has a folder per format and the summary workbook a row per (file, format). `fileId` ties the items of one file.
//
// DECISION (SPEC 21 v11 items 4-7): what a file lacks is settled per format, like in the single-file flow: a format whose rules need a column
// the file does not have (required, or used though optional), or whose used column's values mostly did not parse as before, is not made
// and its item is "needs attention" with the reason - in the file's result and in the summary - while the file's other formats are
// converted. A batch asks nothing, so there is no "Run anyway" here: that file can be run on its own on this screen.
import type { Flag } from '@formatai/engine';
import type { Rules, SignatureEntry, SourceConversionRef, Tier } from '@formatai/shared';
import { tiers } from '@formatai/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError } from '../../api/http';
import { useConvertApi } from '../../api/convert';
import { downloadBytes, outputFileName } from '../../flow/download';
import { isCancellation } from '../../flow/errors';
import { useI18n, type I18n } from '../../i18n';
import { useServices } from '../../services';
import { isAcceptedFile } from '../../ui';
import type { BatchOutputFile, SummaryTable } from '../../worker/convertApi';
import { attentionLines } from '../Convert/attention';
import { attentionOfGaps, attentionOfUnlike, columnLabel, isolate, runCounts, signatureOf, type Attention } from '../Convert/logic';

export type BatchStatus = 'queued' | 'running' | 'converted' | 'convertedFlags' | 'noMatch' | 'needsAttention' | 'notChosen';

/** Why a file didn't match (or couldn't be converted): said in plain words next to the file. */
export type NoMatchReason =
  | { kind: 'unreadable' }
  | { kind: 'noTable' }
  | { kind: 'noSource' }
  | { kind: 'unsure' }
  | { kind: 'missing'; columns: string[] }
  /** SPEC 21 v11 items 4-7: the format was not made because of what this file lacks (or how its values look); the others of the file were. */
  | { kind: 'attention'; format: string; attention: Attention }
  | { kind: 'rules'; source: string }
  /** None of the formats the user chose at the batch's question is one this file's source feeds. */
  | { kind: 'notChosen' }
  | { kind: 'gone' }
  | { kind: 'failed' };

export interface BatchItem {
  id: number;
  /** The id of the file's first item: every (file, conversion) item of one file shares it. */
  fileId: number;
  file: File;
  status: BatchStatus;
  reason?: NoMatchReason;
  conversionId?: string;
  formatName?: string;
  sourceName?: string;
  rowsIn?: number;
  rowsOut?: number;
  flags: Flag[];
  /** A flag's column id as the user knows it (the file's column header), for the flag lists. */
  columnLabels: Record<string, string>;
  /** The name of the converted file inside the zip. */
  outputName?: string;
}

/** `matching`: every file is matched before anything is converted; `choosing`: the batch's one question, which formats to make. */
export type BatchPhase = 'idle' | 'matching' | 'choosing' | 'running' | 'packing' | 'done';

/** A format the matched files can be made into, for the batch's question: how many of the files its sources take. */
export interface BatchFormatChoice {
  formatId: string;
  formatName: string;
  files: number;
}

/** What matching one file gave: its source (and the headers read), or why it can't be converted. */
type Matched = { kind: 'matched'; source: SignatureEntry; headers: readonly string[] } | { kind: 'noMatch'; reason: NoMatchReason };

/** What converting one file gave for ONE of its conversions: the item's fields, the file made, and the counts to report. */
interface ConversionResult {
  change: Partial<BatchItem>;
  bytes?: ArrayBuffer;
  record?: { conversionId: string; counts: { rows: number; flagged: number } };
}

export interface BatchDownloads {
  zip: ArrayBuffer;
  summary: ArrayBuffer;
}

export interface AddResult {
  /** Files that went into the list. */
  added: number;
  /** Files not added: wrong type or too large. */
  skipped: number;
  /** Files not added because the plan's files-per-run limit was reached. */
  overLimit: number;
}

export interface UseBatchFlow {
  phase: BatchPhase;
  items: BatchItem[];
  /** How many FILES are done, for the progress line (one file can give several items). */
  done: number;
  /** How many files the list holds. */
  total: number;
  /** How many files were matched so far (the `matching` phase's progress). */
  matched: number;
  /** The formats to choose from (the `choosing` phase), in the order they first appear; none is ticked. */
  choices: BatchFormatChoice[];
  stopped: boolean;
  packError: boolean;
  downloads: BatchDownloads | null;
  filesPerRun: number;
  add(files: readonly File[]): AddResult;
  remove(id: number): void;
  clear(): void;
  run(): void;
  /** The answer to the batch's question: the ids of the formats to make (at least one). */
  choose(formatIds: readonly string[]): void;
  /** Back from the question: nothing is converted, and the files stay in the list. */
  cancelChoice(): void;
  stop(): void;
  downloadZip(): void;
  downloadSummary(): void;
  reset(): void;
}

const fileKey = (f: File): string => `${f.name}|${f.size}|${f.lastModified}`;

/** The sentence for a "didn't match" reason. */
export function reasonText(i18n: I18n, reason: NoMatchReason): string {
  const { t } = i18n;
  switch (reason.kind) {
    case 'unreadable':
      return t('batch.reason.unreadable');
    case 'noTable':
      return t('batch.reason.noTable');
    case 'noSource':
      return t('batch.reason.noSource');
    case 'unsure':
      return t('batch.reason.unsure');
    case 'missing':
      return t('batch.reason.missing', { columns: reason.columns.map(isolate).join(', ') });
    case 'attention':
      return attentionLines(i18n, reason.format, reason.attention).join(' ');
    case 'rules':
      return t('batch.reason.rules', { source: isolate(reason.source) });
    case 'notChosen':
      return t('batch.reason.notChosen');
    case 'gone':
      return t('batch.reason.gone');
    case 'failed':
      return t('batch.reason.failed');
  }
}

/** `entries` are the sources the page may run: each feeds at least one format, and on `?format=` only that format's conversion (SPEC 8.15). */
export function useBatchFlow({ tier, entries }: { tier: Tier; entries: readonly SignatureEntry[] }): UseBatchFlow {
  const i18n = useI18n();
  const { engine } = useServices();
  const api = useConvertApi();
  const limits = tiers[tier];
  const filesPerRun = limits.filesPerRun;

  const [phase, setPhase] = useState<BatchPhase>('idle');
  const [items, setItems] = useState<BatchItem[]>([]);
  const [stopped, setStopped] = useState(false);
  const [packError, setPackError] = useState(false);
  const [downloads, setDownloads] = useState<BatchDownloads | null>(null);
  const [matched, setMatched] = useState(0);
  const [choices, setChoices] = useState<BatchFormatChoice[]>([]);

  const itemsRef = useRef<BatchItem[]>([]);
  itemsRef.current = items;
  const nextId = useRef(1);
  const abortRef = useRef<AbortController | null>(null);
  const runRef = useRef(0);
  /** The converted files' bytes, by item id: held until the zip is made. */
  const outputs = useRef(new Map<number, ArrayBuffer>());
  /** Rules by conversion id, fetched once per batch. */
  const rulesCache = useRef(new Map<string, Rules>());
  /** The batch waiting at the question: its files (in the list's order) and what matching gave each, by file id. */
  const pending = useRef<{ queue: number[]; matches: Map<number, Matched> } | null>(null);
  const i18nRef = useRef(i18n);
  i18nRef.current = i18n;

  useEffect(
    () => () => {
      runRef.current++;
      abortRef.current?.abort();
    },
    [],
  );

  const patch = useCallback((id: number, change: Partial<BatchItem>) => {
    setItems((list) => list.map((it) => (it.id === id ? { ...it, ...change } : it)));
  }, []);

  const add = useCallback(
    (files: readonly File[]): AddResult => {
      const result: AddResult = { added: 0, skipped: 0, overLimit: 0 };
      const have = new Set(itemsRef.current.map((i) => fileKey(i.file)));
      const fresh: BatchItem[] = [];
      for (const f of files) {
        if (!isAcceptedFile(f.name) || f.size > limits.maxFileBytes) {
          result.skipped++;
          continue;
        }
        if (have.has(fileKey(f))) continue;
        if (itemsRef.current.length + fresh.length >= filesPerRun) {
          result.overLimit++;
          continue;
        }
        have.add(fileKey(f));
        const id = nextId.current++;
        fresh.push({ id, fileId: id, file: f, status: 'queued', flags: [], columnLabels: {} });
      }
      if (fresh.length > 0) setItems((list) => [...list, ...fresh]);
      result.added = fresh.length;
      return result;
    },
    [filesPerRun, limits.maxFileBytes],
  );

  const remove = useCallback((id: number) => setItems((list) => list.filter((i) => i.id !== id)), []);
  const clear = useCallback(() => setItems([]), []);

  /**
   * One file's conversion to one format: fetch its rules (once per batch), check the format against the file's headers, convert, and
   * check how the values read. A format that needs attention is not made (SPEC 21 v11 items 4-7); the others of the file still are.
   */
  const convertTo = useCallback(
    async (item: BatchItem, source: SignatureEntry, conv: SourceConversionRef, headers: readonly string[], signal: AbortSignal): Promise<ConversionResult> => {
      const failed = (reason: NoMatchReason): ConversionResult => ({ change: { status: 'noMatch', reason, conversionId: conv.conversionId, formatName: conv.formatName, sourceName: source.name } });
      const attention = (needs: Attention): ConversionResult => ({
        change: { status: 'needsAttention', reason: { kind: 'attention', format: conv.formatName, attention: needs }, conversionId: conv.conversionId, formatName: conv.formatName, sourceName: source.name },
      });
      let rules = rulesCache.current.get(conv.conversionId);
      if (!rules) {
        try {
          rules = (await api.conversion(conv.conversionId, signal)).rules;
        } catch (e) {
          if (e instanceof ApiError && (e.code === 'notFound' || e.status === 404)) return failed({ kind: 'gone' });
          throw e;
        }
        rulesCache.current.set(conv.conversionId, rules);
      }
      // What this format needs that the file does not have: the engine's own header mapping over the headers matching read (no file is
      // parsed again). Without headers nothing is claimed, and a missing required column is still the engine's refusal below.
      const [gaps] = headers.length > 0 ? await engine.columnGaps({ headers: [...headers], rules: [rules] }, { signal }) : [[]];
      const missing = attentionOfGaps(gaps ?? []);
      if (missing) return attention(missing);
      const out = await engine.convertWithDecisions({ rules, file: { name: item.file.name, bytes: await item.file.arrayBuffer() }, mode: 'write', previewRows: 0 }, { signal });
      if (!out.ok) {
        if (out.error.code === 'missingRequiredColumns') return failed({ kind: 'missing', columns: out.error.missing ?? [] });
        if (out.error.code === 'noTable') return failed({ kind: 'noTable' });
        if (out.error.code === 'invalidRules') return failed({ kind: 'rules', source: source.name });
        return failed({ kind: 'failed' });
      }
      if (!out.written) return failed({ kind: 'failed' });
      // "Same name, different meaning": the file is withheld, not written into the zip (counts only: no value is looked at).
      const unlike = attentionOfUnlike(out.unlike);
      if (unlike) return attention(unlike);
      return {
        bytes: out.bytes,
        // SPEC 14.1, 15: counts only - never a value, a header or a file name.
        record: { conversionId: conv.conversionId, counts: runCounts(out.summary, out.flags) },
        change: {
          status: out.flags.length > 0 ? 'convertedFlags' : 'converted',
          conversionId: conv.conversionId,
          formatName: conv.formatName,
          sourceName: source.name,
          rowsIn: out.summary.rowsIn,
          rowsOut: out.summary.rowsOut,
          flags: out.flags,
          columnLabels: Object.fromEntries([...new Set(out.flags.map((f) => f.column))].map((c) => [c, columnLabel(rules, c)])),
          outputName: outputFileName(item.file.name, rules),
        },
      };
    },
    [api, engine],
  );

  /** Matches one file to a source: only a clear winner is used (never a guess, DECISION 10), and no per-file mapping in a batch. */
  const matchOne = useCallback(
    async (item: BatchItem, entries: readonly SignatureEntry[], signal: AbortSignal): Promise<Matched> => {
      const noMatch = (reason: NoMatchReason): Matched => ({ kind: 'noMatch', reason });
      const result = await engine.matchFile({ file: { name: item.file.name, bytes: await item.file.arrayBuffer() }, signatures: entries.map(signatureOf) }, { signal });
      if (!result.ok) return noMatch({ kind: result.reason });
      if (result.pick.kind !== 'auto') return noMatch({ kind: result.pick.options.length === 0 ? 'noSource' : 'unsure' });
      const match = result.pick.match;
      const source = entries.find((e) => e.sourceId === match.id);
      if (!source) return noMatch({ kind: 'gone' });
      return { kind: 'matched', source, headers: result.headers };
    },
    [engine],
  );

  /**
   * One matched file, converted with each conversion of its source - only those of the chosen formats when the batch asked (`chosen`).
   * What the file lacks (a missing required column, or one that is used) is settled per format (SPEC 21 v11 items 4-7), not by stopping the file.
   */
  const convertMatched = useCallback(
    async (item: BatchItem, m: Matched, chosen: ReadonlySet<string> | null, signal: AbortSignal): Promise<ConversionResult[]> => {
      if (m.kind === 'noMatch') return [{ change: { status: 'noMatch', reason: m.reason } }];
      const { source } = m;
      const convs = chosen ? source.conversions.filter((c) => chosen.has(c.formatId)) : source.conversions;
      if (convs.length === 0) return [{ change: { status: 'notChosen', reason: { kind: 'notChosen' }, sourceName: source.name } }];
      const results: ConversionResult[] = [];
      for (const conv of convs) results.push(await convertTo(item, source, conv, m.headers, signal));
      return results;
    },
    [convertTo],
  );

  /** The zip and the summary workbook, made in the worker from what was converted. */
  const pack = useCallback(
    async (finished: readonly BatchItem[], signal: AbortSignal): Promise<BatchDownloads | null> => {
      const { t, code, lang } = i18nRef.current;
      const converted = finished.filter((i) => i.status === 'converted' || i.status === 'convertedFlags');
      if (converted.length === 0) return null;

      const statusText = (i: BatchItem): string =>
        t(i.status === 'converted' ? 'batch.status.converted' : i.status === 'convertedFlags' ? 'batch.status.convertedFlags' : i.status === 'needsAttention' ? 'batch.status.needsAttention' : i.status === 'notChosen' ? 'batch.status.notChosen' : 'batch.status.noMatch');
      // A file that was made into several formats appears once per format, so its flag rows say which format they belong to
      // (the sheet keeps its five columns: file, row, column, value, message).
      const perFile = new Map<number, number>();
      for (const i of converted) perFile.set(i.fileId, (perFile.get(i.fileId) ?? 0) + 1);
      const flagFile = (i: BatchItem): string => ((perFile.get(i.fileId) ?? 0) > 1 ? `${i.file.name} (${i.formatName ?? ''})` : i.file.name);
      const files: SummaryTable = {
        sheetName: t('batch.summary.sheet.files'),
        headers: (['file', 'format', 'source', 'status', 'rowsIn', 'rowsOut', 'flagged', 'note'] as const).map((k) => t(`batch.summary.col.${k}` as const)),
        rows: finished.map((i) => [
          i.file.name,
          i.formatName ?? '',
          i.sourceName ?? '',
          statusText(i),
          i.rowsIn ?? null,
          i.rowsOut ?? null,
          new Set(i.flags.map((f) => f.rowNumber)).size,
          i.reason ? reasonText(i18nRef.current, i.reason).replace(/[⁦-⁩]/g, '') : '',
        ]),
      };
      const flags: SummaryTable = {
        sheetName: t('batch.summary.sheet.flags'),
        headers: (['file', 'row', 'column', 'value', 'message'] as const).map((k) => t(`batch.summary.col.${k}` as const)),
        rows: finished.flatMap((i) =>
          i.flags.map((f) => [flagFile(i), f.rowNumber, i.columnLabels[f.column] ?? f.column, f.value, code({ kind: 'flag', code: f.messageKey, ...(f.params ? { params: f.params } : {}) })]),
        ),
      };
      const outputFiles: BatchOutputFile[] = converted.flatMap((i) => {
        const bytes = outputs.current.get(i.id);
        return bytes ? [{ folder: i.formatName ?? '', fileName: i.outputName ?? i.file.name, bytes: bytes.slice(0) }] : [];
      });
      const out = await engine.batch({ outputs: outputFiles, summary: { files, flags, language: lang }, summaryFileName: t('batch.summary.file') }, { signal });
      return { zip: out.zip, summary: out.summary };
    },
    [engine],
  );

  /** The converting half of a run: every file of `queue`, with what matching gave it; then the zip. */
  const convertAll = useCallback(
    (runId: number, abort: AbortController, queue: readonly number[], matches: ReadonlyMap<number, Matched>, chosen: ReadonlySet<string> | null) => {
      setPhase('running');
      void (async () => {
        /** The items of every file that was finished, by file. */
        const finished = new Map<number, BatchItem[]>();
        let wasStopped = false;
        for (const id of queue) {
          if (abort.signal.aborted || runId !== runRef.current) {
            wasStopped = true;
            break;
          }
          const base = itemsRef.current.find((i) => i.id === id);
          const m = matches.get(id);
          if (!base || !m) continue;
          patch(id, { status: 'running' });
          let results: ConversionResult[];
          try {
            results = await convertMatched(base, m, chosen, abort.signal);
          } catch (e) {
            if (abort.signal.aborted || isCancellation(e)) {
              wasStopped = true;
              break;
            }
            results = [{ change: { status: 'noMatch', reason: { kind: 'failed' } } }];
          }
          if (runId !== runRef.current) return;
          // One item per (file, conversion): the first takes the file's place in the list, the others follow it.
          const made = results.map((r, k): BatchItem => {
            const itemId = k === 0 ? base.id : nextId.current++;
            if (r.bytes) outputs.current.set(itemId, r.bytes);
            return { ...base, ...r.change, id: itemId };
          });
          finished.set(id, made);
          setItems((list) => list.flatMap((i) => (i.id === id ? made : [i])));
          // Counts only, once per converted (file, conversion); a file the user stopped on is reported for none of them.
          for (const r of results) if (r.record) void api.recordRun(r.record.conversionId, r.record.counts).catch(() => undefined);
        }
        if (runId !== runRef.current) return;
        // A stopped batch keeps what it converted; files it never reached are dropped from the list.
        const kept = queue.flatMap((id) => finished.get(id) ?? []);
        if (wasStopped) {
          setItems(kept);
          setStopped(true);
        }
        setPhase('packing');
        // Stopping the run must not stop the packing of what it did convert: a fresh signal.
        const packing = new AbortController();
        abortRef.current = packing;
        try {
          setDownloads(await pack(kept, packing.signal));
        } catch (e) {
          if (runId !== runRef.current || isCancellation(e)) return;
          setPackError(true);
        }
        if (runId === runRef.current) setPhase('done');
      })();
    },
    [api, convertMatched, pack, patch],
  );

  const run = useCallback(() => {
    if (entries.length === 0 || itemsRef.current.length === 0) return;
    abortRef.current?.abort();
    const abort = new AbortController();
    abortRef.current = abort;
    const runId = ++runRef.current;
    const queue = itemsRef.current.map((i) => i.id);
    outputs.current.clear();
    rulesCache.current.clear();
    pending.current = null;
    setStopped(false);
    setPackError(false);
    setDownloads(null);
    setMatched(0);
    setChoices([]);
    setItems((list) => list.filter((i) => i.id === i.fileId).map((i) => ({ file: i.file, id: i.id, fileId: i.fileId, status: 'queued', flags: [], columnLabels: {} })));
    setPhase('matching');

    void (async () => {
      const matches = new Map<number, Matched>();
      for (const id of queue) {
        const base = itemsRef.current.find((i) => i.id === id);
        if (!base) continue;
        try {
          matches.set(id, await matchOne(base, entries, abort.signal));
        } catch (e) {
          // Stopped while the files were read: nothing was converted, so the list is back as it was.
          if (abort.signal.aborted || isCancellation(e)) {
            if (runId === runRef.current) setPhase('idle');
            return;
          }
          matches.set(id, { kind: 'noMatch', reason: { kind: 'failed' } });
        }
        if (runId !== runRef.current) return;
        setMatched(matches.size);
      }
      if (runId !== runRef.current) return;
      if (abort.signal.aborted) {
        setPhase('idle');
        return;
      }
      // Asked only when a matched file's source feeds several formats: then every format the matched files can be made into is listed,
      // with how many of the files its sources take.
      const sources = [...matches.values()].flatMap((m) => (m.kind === 'matched' ? [m.source] : []));
      if (!sources.some((src) => src.conversions.length > 1)) {
        convertAll(runId, abort, queue, matches, null);
        return;
      }
      const formats = new Map<string, BatchFormatChoice>();
      for (const src of sources) {
        for (const formatId of new Set(src.conversions.map((c) => c.formatId))) {
          const had = formats.get(formatId);
          const formatName = had?.formatName ?? src.conversions.find((c) => c.formatId === formatId)?.formatName ?? '';
          formats.set(formatId, { formatId, formatName, files: (had?.files ?? 0) + 1 });
        }
      }
      pending.current = { queue, matches };
      setChoices([...formats.values()]);
      setPhase('choosing');
    })();
  }, [convertAll, entries, matchOne]);

  const choose = useCallback(
    (formatIds: readonly string[]) => {
      const waiting = pending.current;
      if (!waiting || formatIds.length === 0) return;
      pending.current = null;
      const abort = new AbortController();
      abortRef.current = abort;
      setChoices([]);
      convertAll(runRef.current, abort, waiting.queue, waiting.matches, new Set(formatIds));
    },
    [convertAll],
  );

  const cancelChoice = useCallback(() => {
    runRef.current++;
    pending.current = null;
    setChoices([]);
    setPhase('idle');
  }, []);

  const stop = useCallback(() => abortRef.current?.abort(), []);

  const reset = useCallback(() => {
    runRef.current++;
    abortRef.current?.abort();
    outputs.current.clear();
    rulesCache.current.clear();
    pending.current = null;
    setChoices([]);
    setMatched(0);
    setItems([]);
    setPhase('idle');
    setStopped(false);
    setPackError(false);
    setDownloads(null);
  }, []);

  const downloadZip = useCallback(() => {
    if (downloads) downloadBytes(i18nRef.current.t('batch.summary.zip'), downloads.zip, 'application/zip');
  }, [downloads]);
  const downloadSummary = useCallback(() => {
    if (downloads) downloadBytes(i18nRef.current.t('batch.summary.file'), downloads.summary, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  }, [downloads]);

  const done = useMemo(() => new Set(items.filter((i) => i.status !== 'queued' && i.status !== 'running').map((i) => i.fileId)).size, [items]);
  const total = useMemo(() => new Set(items.map((i) => i.fileId)).size, [items]);

  return { phase, items, done, total, matched, choices, stopped, packError, downloads, filesPerRun, add, remove, clear, run, choose, cancelChoice, stop, downloadZip, downloadSummary, reset };
}
