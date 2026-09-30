// Flow D as a state machine (SPEC 5 D): many files, one at a time in the worker. Each file is matched on its own (only a
// clear, single winner is used: no guessing, no per-file mapping in the MVP), converted with its source's rules, and
// gets a status: converted, converted with flags, or didn't match. Then the worker packs a zip (a folder per format) and
// a summary workbook. Files and their bytes stay on this computer; POST /runs gets counts only.
import type { ConversionMatch, Flag } from '@formatai/engine';
import type { Rules, SignatureEntry, Tier } from '@formatai/shared';
import { tiers } from '@formatai/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError } from '../../api/http';
import { useConvertApi } from '../../api/convert';
import { downloadBytes, outputFileName } from '../../flow/download';
import { isCancellation } from '../../flow/errors';
import { useI18n, type I18n } from '../../i18n';
import { useServices } from '../../services';
import type { BatchOutputFile, SignatureInput, SummaryTable } from '../../worker/convertApi';
import { columnLabel, isolate, runCounts } from '../Convert/logic';

export type BatchStatus = 'queued' | 'running' | 'converted' | 'convertedFlags' | 'noMatch';

/** Why a file didn't match (or couldn't be converted): said in plain words next to the file. */
export type NoMatchReason =
  | { kind: 'unreadable' }
  | { kind: 'noTable' }
  | { kind: 'noSource' }
  | { kind: 'unsure' }
  | { kind: 'missing'; columns: string[] }
  | { kind: 'rules'; source: string }
  | { kind: 'gone' }
  | { kind: 'failed' };

export interface BatchItem {
  id: number;
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

export type BatchPhase = 'idle' | 'running' | 'packing' | 'done';

export type BatchSources = { status: 'loading' } | { status: 'ready'; entries: SignatureEntry[] } | { status: 'error' };

export interface BatchDownloads {
  zip: ArrayBuffer;
  summary: ArrayBuffer;
}

export interface AddResult {
  /** Files not added: wrong type or too large. */
  skipped: number;
  /** Files not added because the plan's files-per-run limit was reached. */
  overLimit: number;
}

export interface UseBatchFlow {
  sources: BatchSources;
  phase: BatchPhase;
  items: BatchItem[];
  /** How many files are done, for the progress line. */
  done: number;
  stopped: boolean;
  packError: boolean;
  downloads: BatchDownloads | null;
  filesPerRun: number;
  add(files: readonly File[]): AddResult;
  remove(id: number): void;
  clear(): void;
  run(): void;
  stop(): void;
  downloadZip(): void;
  downloadSummary(): void;
  reset(): void;
}

const ACCEPTED = ['.xlsx', '.xls', '.csv', '.txt'];
const fileKey = (f: File): string => `${f.name}|${f.size}|${f.lastModified}`;

function toSignature(e: SignatureEntry): SignatureInput {
  return { id: e.conversionId, name: e.sourceName, columns: e.columns };
}

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
    case 'rules':
      return t('batch.reason.rules', { source: isolate(reason.source) });
    case 'gone':
      return t('batch.reason.gone');
    case 'failed':
      return t('batch.reason.failed');
  }
}

export function useBatchFlow({ tier, enabled }: { tier: Tier; enabled: boolean }): UseBatchFlow {
  const i18n = useI18n();
  const { engine } = useServices();
  const api = useConvertApi();
  const limits = tiers[tier];
  const filesPerRun = limits.filesPerRun;

  const [sources, setSources] = useState<BatchSources>({ status: 'loading' });
  const [phase, setPhase] = useState<BatchPhase>('idle');
  const [items, setItems] = useState<BatchItem[]>([]);
  const [stopped, setStopped] = useState(false);
  const [packError, setPackError] = useState(false);
  const [downloads, setDownloads] = useState<BatchDownloads | null>(null);

  const itemsRef = useRef<BatchItem[]>([]);
  itemsRef.current = items;
  const nextId = useRef(1);
  const abortRef = useRef<AbortController | null>(null);
  const runRef = useRef(0);
  /** The converted files' bytes, by item id: held until the zip is made. */
  const outputs = useRef(new Map<number, ArrayBuffer>());
  /** Rules by conversion id, fetched once per batch. */
  const rulesCache = useRef(new Map<string, Rules>());
  const i18nRef = useRef(i18n);
  i18nRef.current = i18n;

  useEffect(() => {
    if (!enabled) return;
    const abort = new AbortController();
    setSources({ status: 'loading' });
    api.signatures(abort.signal).then(
      (list) => setSources({ status: 'ready', entries: list }),
      (e: unknown) => {
        if (!abort.signal.aborted && !(e instanceof DOMException && e.name === 'AbortError')) setSources({ status: 'error' });
      },
    );
    return () => abort.abort();
  }, [api, enabled]);

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
      const result: AddResult = { skipped: 0, overLimit: 0 };
      const have = new Set(itemsRef.current.map((i) => fileKey(i.file)));
      const fresh: BatchItem[] = [];
      for (const f of files) {
        const name = f.name.toLowerCase();
        if (!ACCEPTED.some((ext) => name.endsWith(ext)) || f.size > limits.maxFileBytes) {
          result.skipped++;
          continue;
        }
        if (have.has(fileKey(f))) continue;
        if (itemsRef.current.length + fresh.length >= filesPerRun) {
          result.overLimit++;
          continue;
        }
        have.add(fileKey(f));
        fresh.push({ id: nextId.current++, file: f, status: 'queued', flags: [], columnLabels: {} });
      }
      if (fresh.length > 0) setItems((list) => [...list, ...fresh]);
      return result;
    },
    [filesPerRun, limits.maxFileBytes],
  );

  const remove = useCallback((id: number) => setItems((list) => list.filter((i) => i.id !== id)), []);
  const clear = useCallback(() => setItems([]), []);

  /** One file, start to finish: match, fetch the rules, convert. */
  const convertOne = useCallback(
    async (item: BatchItem, entries: readonly SignatureEntry[], signal: AbortSignal): Promise<Partial<BatchItem>> => {
      const noMatch = (reason: NoMatchReason): Partial<BatchItem> => ({ status: 'noMatch', reason });
      const bytes = (): Promise<ArrayBuffer> => item.file.arrayBuffer();
      const matched = await engine.matchFile({ file: { name: item.file.name, bytes: await bytes() }, signatures: entries.map(toSignature) }, { signal });
      if (!matched.ok) return noMatch({ kind: matched.reason });
      // Only a clear winner is used: never a guess (DECISION 10), and no per-file mapping in a batch.
      if (matched.pick.kind !== 'auto') return noMatch({ kind: matched.pick.options.length === 0 ? 'noSource' : 'unsure' });
      const match: ConversionMatch = matched.pick.match;
      if (match.missingRequired.length > 0) return noMatch({ kind: 'missing', columns: match.missingRequired });

      const entry = entries.find((e) => e.conversionId === match.id);
      let rules = rulesCache.current.get(match.id);
      if (!rules) {
        try {
          rules = (await api.conversion(match.id, signal)).rules;
        } catch (e) {
          if (e instanceof ApiError && (e.code === 'notFound' || e.status === 404)) return noMatch({ kind: 'gone' });
          throw e;
        }
        rulesCache.current.set(match.id, rules);
      }
      const out = await engine.convertWithDecisions({ rules, file: { name: item.file.name, bytes: await bytes() }, mode: 'write', previewRows: 0 }, { signal });
      if (!out.ok) {
        if (out.error.code === 'missingRequiredColumns') return noMatch({ kind: 'missing', columns: out.error.missing ?? [] });
        if (out.error.code === 'noTable') return noMatch({ kind: 'noTable' });
        if (out.error.code === 'invalidRules') return noMatch({ kind: 'rules', source: match.name });
        return noMatch({ kind: 'failed' });
      }
      if (!out.written) return noMatch({ kind: 'failed' });
      outputs.current.set(item.id, out.bytes);
      // SPEC 14.1, 15: counts only - never a value, a header or a file name.
      void api.recordRun(match.id, runCounts(out.summary, out.flags)).catch(() => undefined);
      return {
        status: out.flags.length > 0 ? 'convertedFlags' : 'converted',
        conversionId: match.id,
        formatName: entry?.formatName ?? '',
        sourceName: match.name,
        rowsIn: out.summary.rowsIn,
        rowsOut: out.summary.rowsOut,
        flags: out.flags,
        columnLabels: Object.fromEntries([...new Set(out.flags.map((f) => f.column))].map((c) => [c, columnLabel(rules, c)])),
        outputName: outputFileName(item.file.name, rules),
      };
    },
    [api, engine],
  );

  /** The zip and the summary workbook, made in the worker from what was converted. */
  const pack = useCallback(
    async (finished: readonly BatchItem[], signal: AbortSignal): Promise<BatchDownloads | null> => {
      const { t, code, lang } = i18nRef.current;
      const converted = finished.filter((i) => i.status === 'converted' || i.status === 'convertedFlags');
      if (converted.length === 0) return null;

      const statusText = (i: BatchItem): string => t(i.status === 'converted' ? 'batch.status.converted' : i.status === 'convertedFlags' ? 'batch.status.convertedFlags' : 'batch.status.noMatch');
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
          i.flags.map((f) => [i.file.name, f.rowNumber, i.columnLabels[f.column] ?? f.column, f.value, code({ kind: 'flag', code: f.messageKey, ...(f.params ? { params: f.params } : {}) })]),
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

  const run = useCallback(() => {
    if (sources.status !== 'ready' || itemsRef.current.length === 0) return;
    abortRef.current?.abort();
    const abort = new AbortController();
    abortRef.current = abort;
    const runId = ++runRef.current;
    const entries = sources.entries;
    const queue = itemsRef.current.map((i) => i.id);
    outputs.current.clear();
    rulesCache.current.clear();
    setStopped(false);
    setPackError(false);
    setDownloads(null);
    setItems((list) => list.map((i) => ({ file: i.file, id: i.id, status: 'queued', flags: [], columnLabels: {} })));
    setPhase('running');

    void (async () => {
      const finished = new Map<number, BatchItem>();
      let wasStopped = false;
      for (const id of queue) {
        if (abort.signal.aborted || runId !== runRef.current) {
          wasStopped = true;
          break;
        }
        const base = itemsRef.current.find((i) => i.id === id);
        if (!base) continue;
        patch(id, { status: 'running' });
        let change: Partial<BatchItem>;
        try {
          change = await convertOne(base, entries, abort.signal);
        } catch (e) {
          if (abort.signal.aborted || isCancellation(e)) {
            wasStopped = true;
            break;
          }
          change = { status: 'noMatch', reason: { kind: 'failed' } };
        }
        if (runId !== runRef.current) return;
        finished.set(id, { ...base, ...change });
        patch(id, change);
      }
      if (runId !== runRef.current) return;
      // A stopped batch keeps what it converted; files it never reached are dropped from the list.
      const done = queue.flatMap((id) => (finished.has(id) ? [finished.get(id) as BatchItem] : []));
      if (wasStopped) {
        setItems(done);
        setStopped(true);
      }
      setPhase('packing');
      // Stopping the run must not stop the packing of what it did convert: a fresh signal.
      const packing = new AbortController();
      abortRef.current = packing;
      try {
        setDownloads(await pack(done, packing.signal));
      } catch (e) {
        if (runId !== runRef.current || isCancellation(e)) return;
        setPackError(true);
      }
      if (runId === runRef.current) setPhase('done');
    })();
  }, [convertOne, pack, patch, sources]);

  const stop = useCallback(() => abortRef.current?.abort(), []);

  const reset = useCallback(() => {
    runRef.current++;
    abortRef.current?.abort();
    outputs.current.clear();
    rulesCache.current.clear();
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

  const done = useMemo(() => items.filter((i) => i.status !== 'queued' && i.status !== 'running').length, [items]);

  return { sources, phase, items, done, stopped, packError, downloads, filesPerRun, add, remove, clear, run, stop, downloadZip, downloadSummary, reset };
}
