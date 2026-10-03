// Flow C as a small state machine (SPEC 5 C, 8.12, 8.15, 21 v5 item 5, 21 v6). The file and its bytes stay on this computer:
// the worker reads the headers, matches them to the saved SOURCES' signatures, runs the rules and writes the file. What
// crosses the network is only a conversion's rules (in), a confirmed rename (a source's alias) and the counts of a run (out).
//
// A file is matched to a SOURCE; a source feeds one or several formats (one conversion each):
//
//   idle -> matching -> (choose a source) -> (mapping | missing)            structure checked ONCE per source
//                                          -> (formats)                     only when the source feeds several formats
//                                          -> running -> review -> writing  once per chosen conversion, one after another,
//                                             running -> done                each with its OWN review before writing
//   after the last one: done (exactly one file) or results (several: a download each and a zip)
import type { ConversionMatch, Flag, OutputSheet, RunError, RunSummary } from '@formatai/engine';
import type { ConversionDetail, Rules, SignatureEntry, SourceConversionRef } from '@formatai/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError } from '../../api/http';
import { useConvertApi } from '../../api/convert';
import { webConfig } from '../../config';
import { downloadBytes, outputMimeType } from '../../flow/download';
import { isCancellation, toFlowError, type FlowError } from '../../flow/errors';
import { useI18n, type I18n } from '../../i18n';
import { useServices } from '../../services';
import type { BatchOutputFile, RowInputCell, SummaryTable } from '../../worker/convertApi';
import { RpcRemoteError } from '../../worker/rpcClient';
import { convertErrorText } from './errors';
import { applyToAll, baseName, columnLabel, flaggedRowCount, reviewRows, runCounts, scopeSources, signatureOf, toRowDecisions, withAliases, type Choices, type ReviewRow, type RowChoice } from './logic';
import { convertSession } from './session';

/** Everything the run needs to know about the conversion it uses (rules included, with any confirmed rename already in). */
export interface Target {
  conversionId: string;
  formatId: string;
  formatName: string;
  /** The SOURCE's name. */
  sourceName: string;
  rules: Rules;
}

export type ConvertError = FlowError | { kind: 'unreadable' } | { kind: 'noTable' } | { kind: 'sheetNotFound' } | { kind: 'invalidRules' } | { kind: 'gone' };

export interface Finished {
  fileName: string;
  bytes: ArrayBuffer;
  fileType: 'xlsx' | 'csv' | 'txt';
  flags: Flag[];
  summary: RunSummary;
  preview: OutputSheet;
  totalRows: number;
}

/** A conversion that ran: the rules it ran with (flags are named from them) and the file it made. */
export interface RunResult {
  target: Target;
  finished: Finished;
}

/** Why one of several conversions made no file (the others went on). */
export type FormatFailure = ConvertError | { kind: 'missing'; columns: string[] };

export interface FailedFormat {
  conversionId: string;
  formatName: string;
  failure: FormatFailure;
}

/**
 * One dropped file on its way through the conversions of its source (SPEC 8.15). `queue` holds the conversions to run - one
 * when the source feeds one format (or the page is restricted to one), else the ones the user chose - and `index` the one being
 * run or reviewed. The renames the user confirmed are kept here (keyed by the SOURCE's header) and applied in memory to every
 * conversion that runs.
 */
export interface Job {
  file: File;
  /** The source with only the conversions this page may use. */
  source: SignatureEntry;
  mapping: Record<string, string>;
  queue: SourceConversionRef[];
  index: number;
  results: RunResult[];
  failed: FailedFormat[];
}

/** "Format 2 of 3": shown while one of several conversions is under review. */
export interface Step {
  n: number;
  total: number;
}

export type Phase =
  | { kind: 'idle' }
  | { kind: 'matching' }
  /** Options are SOURCES (`id` is the source's id). */
  | { kind: 'choose'; options: ConversionMatch[] }
  | { kind: 'noMatch' }
  /** Required columns are missing but the file has columns nothing claimed: the user can say which is which (once per source). */
  | { kind: 'mapping'; source: SignatureEntry; match: ConversionMatch }
  /** Required columns are missing and nothing can stand in for them: stop, and say exactly which (and which formats it affects). */
  | { kind: 'missing'; source: SignatureEntry; missing: string[] }
  /** The source feeds several formats: which of them to make (all pre-checked). `mapping` is any rename already confirmed. */
  | { kind: 'formats'; source: SignatureEntry; mapping: Record<string, string> }
  | { kind: 'running'; target: Target | null }
  | { kind: 'review'; target: Target; step: Step | null; flags: Flag[]; summary: RunSummary; rowInputs: Record<number, RowInputCell[]>; rows: ReviewRow[]; choices: Choices }
  | { kind: 'writing'; target: Target }
  /** Exactly one file was made. */
  | { kind: 'done'; target: Target; finished: Finished }
  /** Several formats were made (or some could not be): a file each, and all of them in one zip. */
  | { kind: 'results'; source: SignatureEntry; results: RunResult[]; failed: FailedFormat[] }
  | { kind: 'error'; error: ConvertError };

export type SourcesState = { status: 'loading' } | { status: 'ready'; entries: SignatureEntry[] } | { status: 'error' };

export interface UseConvertFlow {
  sources: SourcesState;
  /** The sources this page may run: those that feed a format (and, on `?format=`, that format's conversion only). */
  entries: SignatureEntry[];
  phase: Phase;
  file: File | null;
  /** A confirmed rename that could not be saved (the file was converted anyway). */
  aliasNotSaved: boolean;
  /** The zip of several results is being made / could not be made. */
  packing: boolean;
  packError: boolean;
  start(file: File): void;
  /** From "which source is this file?" (a source id). */
  choose(sourceId: string): void;
  /** From "this file feeds N formats": runs these conversions, one after another. */
  chooseFormats(conversionIds: readonly string[]): void;
  /** From the renamed-columns step: required header -> the file's header (null: "it's not in this file"). */
  submitMapping(mapping: Record<string, string | null>, remember: boolean): void;
  setChoice(rowNumber: number, choice: RowChoice | null): void;
  keepAll(): void;
  skipAll(): void;
  clearChoices(): void;
  /** "Create the file": converts with the decisions. */
  create(): void;
  download(): void;
  /** One format's file from the results screen. */
  downloadOne(conversionId: string): void;
  /** Every result in one zip (a folder per format) with a small summary sheet. */
  downloadAll(): void;
  /** Keeps the file (and the rest of the run) for the trip to the rules editor and back (`/convert?resume=1`). */
  holdForEditing(target: Target): void;
  /** Picks up the file held for the editor, converting again with the (edited) rules. */
  resume(): boolean;
  reset(): void;
}

export function toConvertError(e: unknown): ConvertError {
  if (e instanceof ApiError && (e.code === 'notFound' || e.status === 404)) return { kind: 'gone' };
  if (e instanceof ApiError && e.code === 'invalidRules') return { kind: 'invalidRules' };
  if (e instanceof RpcRemoteError && e.code === 'unreadable') return { kind: 'unreadable' };
  return toFlowError(e);
}

/** What the engine's error means for the user: the phase to show when a single conversion cannot run. */
function runFailure(error: RunError): FormatFailure {
  if (error.code === 'missingRequiredColumns') return { kind: 'missing', columns: error.missing ?? [] };
  if (error.code === 'noTable') return { kind: 'noTable' };
  if (error.code === 'sheetNotFound') return { kind: 'sheetNotFound' };
  return { kind: 'invalidRules' };
}

/** The plain-words reason one format failed (the results screen and the summary sheet). */
export function failureText(i18n: I18n, failure: FormatFailure): string {
  if (failure.kind === 'missing') return i18n.t('batch.reason.missing', { columns: failure.columns.join(', ') });
  return convertErrorText(i18n, failure);
}

/** Moves the job to its next conversion; false when it was the last. */
function advance(job: Job): boolean {
  if (job.index + 1 >= job.queue.length) return false;
  job.index++;
  return true;
}

export interface ConvertFlowOptions {
  /** Signed in: the signatures are loaded. */
  enabled: boolean;
  /** Only the formats' conversions of this format (`/convert?format=<id>`). */
  formatId: string | null;
  /** The tier's largest file. */
  maxBytes: number;
}

export function useConvertFlow({ enabled, formatId, maxBytes }: ConvertFlowOptions): UseConvertFlow {
  const { engine } = useServices();
  const api = useConvertApi();
  const i18n = useI18n();
  const i18nRef = useRef(i18n);
  i18nRef.current = i18n;
  const [sources, setSources] = useState<SourcesState>({ status: 'loading' });
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [file, setFile] = useState<File | null>(null);
  const [aliasNotSaved, setAliasNotSaved] = useState(false);
  const [packing, setPacking] = useState(false);
  const [packError, setPackError] = useState(false);

  const runRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const fileRef = useRef<File | null>(null);
  const rankedRef = useRef<ConversionMatch[]>([]);
  /** The run in progress (its queue, its results): the state that outlives one phase. */
  const jobRef = useRef<Job | null>(null);
  const phaseRef = useRef<Phase>(phase);
  phaseRef.current = phase;

  // The sources this page may use: every one that feeds a format, restricted to one format's conversion on `?format=`.
  const entries = useMemo(() => (sources.status === 'ready' ? scopeSources(sources.entries, formatId) : []), [sources, formatId]);
  const entriesRef = useRef(entries);
  entriesRef.current = entries;

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

  const begin = useCallback((): { run: number; signal: AbortSignal } => {
    abortRef.current?.abort();
    const abort = new AbortController();
    abortRef.current = abort;
    return { run: ++runRef.current, signal: abort.signal };
  }, []);

  const fail = useCallback((run: number, e: unknown) => {
    if (run !== runRef.current || isCancellation(e)) return;
    setPhase({ kind: 'error', error: toConvertError(e) });
  }, []);

  /** All the conversions of the job have been tried: one file is today's "done"; anything else is the results screen. */
  const showOutcome = useCallback((job: Job) => {
    convertSession.clear();
    jobRef.current = null;
    if (job.results.length === 1 && job.failed.length === 0) {
      const only = job.results[0] as RunResult;
      setPhase({ kind: 'done', target: only.target, finished: only.finished });
    } else {
      setPhase({ kind: 'results', source: job.source, results: [...job.results], failed: [...job.failed] });
    }
  }, []);

  /** A conversion wrote its file: keep it and report the counts (counts only). */
  const keep = useCallback(
    (job: Job, target: Target, out: Omit<Finished, 'fileName'>) => {
      job.results.push({ target, finished: { ...out, fileName: `${baseName(job.file.name)} (converted).${out.fileType}` } });
      // SPEC 14.1, 15: how many rows and how many were flagged - never a value, a header or a file name.
      void api.recordRun(target.conversionId, runCounts(out.summary, out.flags)).catch(() => undefined);
    },
    [api],
  );

  /**
   * Runs the conversion at `job.index`: reads the file with its rules and stops before the file is written when rows need the
   * user's eye (SPEC 8.15: every conversion of the queue has its OWN review). Says how it ended: a file was made, this one
   * failed among several (the others go on), the user is now needed (or a final message is showing), or a newer run took over.
   */
  const runOne = useCallback(
    async (job: Job, runId: number, signal: AbortSignal): Promise<'made' | 'skipped' | 'wait' | 'stale'> => {
      jobRef.current = job;
      const conv = job.queue[job.index] as SourceConversionRef;
      const several = job.queue.length > 1;
      /**
       * This conversion could not run: alone, that is the whole answer; among several, the others still go on and this one is
       * listed with why on the results screen (DECISION: one broken format must not cost the user the files of the others).
       */
      const failedHere = (failure: FormatFailure): 'skipped' | 'wait' => {
        if (several) {
          job.failed.push({ conversionId: conv.conversionId, formatName: conv.formatName, failure });
          return 'skipped';
        }
        jobRef.current = null;
        if (failure.kind === 'missing') setPhase({ kind: 'missing', source: job.source, missing: failure.columns });
        else setPhase({ kind: 'error', error: failure });
        return 'wait';
      };
      setPhase({ kind: 'running', target: null });
      try {
        let detail: ConversionDetail;
        try {
          detail = await api.conversion(conv.conversionId, signal);
        } catch (e) {
          if (runId !== runRef.current) return 'stale';
          const converted = toConvertError(e);
          if (several && converted.kind === 'gone') return failedHere(converted);
          throw e;
        }
        if (runId !== runRef.current) return 'stale';
        // DECISION (SPEC 8.15): the renames confirmed for this file are applied in memory to every conversion that runs; the
        // saved rules and the source are not touched here (a "remember" was saved once, on the source, before the runs).
        const target: Target = {
          conversionId: conv.conversionId,
          formatId: detail.formatId,
          formatName: conv.formatName,
          sourceName: detail.sourceName,
          rules: withAliases(detail.rules, job.mapping),
        };
        setPhase({ kind: 'running', target });
        const out = await engine.convertWithDecisions(
          { rules: target.rules, file: { name: job.file.name, bytes: await job.file.arrayBuffer() }, mode: 'review', previewRows: webConfig.convertPreviewRows },
          { signal },
        );
        if (runId !== runRef.current) return 'stale';
        if (!out.ok) return failedHere(runFailure(out.error));
        if (!out.written) {
          setPhase({
            kind: 'review',
            target,
            step: several ? { n: job.index + 1, total: job.queue.length } : null,
            flags: out.flags,
            summary: out.summary,
            rowInputs: out.rowInputs,
            rows: reviewRows(out.flags, out.summary),
            choices: {},
          });
          return 'wait';
        }
        keep(job, target, out);
        return 'made';
      } catch (e) {
        fail(runId, e);
        return 'wait';
      }
    },
    [api, engine, fail, keep],
  );

  /** Runs the queue from `job.index`, one conversion after another, until a review needs the user or there is nothing left. */
  const drive = useCallback(
    async (job: Job, runId: number, signal: AbortSignal): Promise<void> => {
      for (;;) {
        const end = await runOne(job, runId, signal);
        if (end === 'stale' || end === 'wait') return;
        if (!advance(job)) {
          showOutcome(job);
          return;
        }
      }
    },
    [runOne, showOutcome],
  );

  /** The queue is decided: run it from its first conversion. */
  const startJob = drive;

  /** The source is known and its structure is settled: one conversion runs at once; several ask which formats first. */
  const proceed = useCallback(
    (source: SignatureEntry, mapping: Record<string, string>, sourceFile: File, runId: number, signal: AbortSignal) => {
      if (source.conversions.length === 1) {
        void startJob({ file: sourceFile, source, mapping, queue: [...source.conversions], index: 0, results: [], failed: [] }, runId, signal);
        return;
      }
      setPhase({ kind: 'formats', source, mapping });
    },
    [startJob],
  );

  /**
   * A source was picked (by the matcher or by the user). Its structure is checked ONCE, here (SPEC 8.15): a required column that
   * is missing or renamed is dealt with before any format runs, and the step names every format it affects.
   *
   * DECISION: the structure step comes BEFORE "which formats?", and it is the source's, not a format's: a source's required
   * columns are those any of its conversions requires, so a column missing for one format stops all of them (even on
   * `?format=`, where the list of affected formats is just that page's). The user is asked once, the answer holds for every
   * format, and the message can name every format it touches, which per-format detection could not do before the user chose.
   */
  const selectSource = useCallback(
    (sourceId: string, match: ConversionMatch | null, sourceFile: File, runId: number, signal: AbortSignal) => {
      const source = entriesRef.current.find((e) => e.sourceId === sourceId);
      if (!source) {
        setPhase({ kind: 'error', error: { kind: 'gone' } });
        return;
      }
      if (match && match.missingRequired.length > 0) {
        // The source can't run without these columns (a score of 0.9 allows one to be missing).
        setPhase(match.extra.length > 0 ? { kind: 'mapping', source, match } : { kind: 'missing', source, missing: match.missingRequired });
        return;
      }
      proceed(source, {}, sourceFile, runId, signal);
    },
    [proceed],
  );

  const start = useCallback(
    (next: File) => {
      const { run: runId, signal } = begin();
      fileRef.current = next;
      jobRef.current = null;
      setFile(next);
      setAliasNotSaved(false);
      setPackError(false);
      if (next.size > maxBytes) {
        setPhase({ kind: 'error', error: { kind: 'fileTooLarge', fileName: next.name, bytes: next.size, maxBytes } });
        return;
      }
      setPhase({ kind: 'matching' });
      void (async () => {
        try {
          const out = await engine.matchFile({ file: { name: next.name, bytes: await next.arrayBuffer() }, signatures: entriesRef.current.map(signatureOf) }, { signal });
          if (runId !== runRef.current) return;
          if (!out.ok) {
            setPhase({ kind: 'error', error: { kind: out.reason } });
            return;
          }
          rankedRef.current = out.ranked;
          if (out.pick.kind === 'auto') selectSource(out.pick.match.id, out.pick.match, next, runId, signal);
          else if (out.pick.options.length === 0) setPhase({ kind: 'noMatch' });
          else setPhase({ kind: 'choose', options: out.pick.options });
        } catch (e) {
          fail(runId, e);
        }
      })();
    },
    [begin, engine, maxBytes, selectSource, fail],
  );

  const choose = useCallback(
    (sourceId: string) => {
      const f = fileRef.current;
      if (!f) return;
      const { run: runId, signal } = begin();
      selectSource(sourceId, rankedRef.current.find((m) => m.id === sourceId) ?? null, f, runId, signal);
    },
    [begin, selectSource],
  );

  const chooseFormats = useCallback(
    (conversionIds: readonly string[]) => {
      const current = phaseRef.current;
      const f = fileRef.current;
      if (current.kind !== 'formats' || !f) return;
      // In the source's own order, whatever order the boxes were ticked in.
      const queue = current.source.conversions.filter((c) => conversionIds.includes(c.conversionId));
      if (queue.length === 0) return;
      const { run: runId, signal } = begin();
      void startJob({ file: f, source: current.source, mapping: current.mapping, queue, index: 0, results: [], failed: [] }, runId, signal);
    },
    [begin, startJob],
  );

  const submitMapping = useCallback(
    (mapping: Record<string, string | null>, remember: boolean) => {
      const current = phaseRef.current;
      const f = fileRef.current;
      if (current.kind !== 'mapping' || !f) return;
      const { source } = current;
      const chosen: Record<string, string> = {};
      for (const [header, fileHeader] of Object.entries(mapping)) if (fileHeader) chosen[header] = fileHeader;
      const stillMissing = current.match.missingRequired.filter((h) => chosen[h] === undefined);
      if (stillMissing.length > 0) {
        setPhase({ kind: 'missing', source, missing: stillMissing });
        return;
      }
      const { run: runId, signal } = begin();
      setPhase({ kind: 'running', target: null });
      void (async () => {
        if (remember) {
          // SPEC 5 C, 8.15: a confirmed mapping is saved ONCE, as an alias on the SOURCE (so it holds for every format the
          // source feeds). A failure doesn't stop this file.
          let failed = false;
          for (const [header, alias] of Object.entries(chosen)) {
            try {
              await api.addAlias(source.sourceId, { header, alias });
            } catch {
              failed = true;
            }
          }
          if (runId !== runRef.current) return;
          setAliasNotSaved(failed);
          // The next file with this name should match with no questions: read the signatures again (the alias is in them now).
          if (!failed) {
            void api.signatures().then(
              (list) => setSources({ status: 'ready', entries: list }),
              () => undefined,
            );
          }
        }
        proceed(source, chosen, f, runId, signal);
      })();
    },
    [api, begin, proceed],
  );

  const setChoice = useCallback((rowNumber: number, choice: RowChoice | null) => {
    setPhase((p) => {
      if (p.kind !== 'review') return p;
      const choices = { ...p.choices };
      if (choice === null) delete choices[rowNumber];
      else choices[rowNumber] = choice;
      return { ...p, choices };
    });
  }, []);
  const keepAll = useCallback(() => setPhase((p) => (p.kind === 'review' ? { ...p, choices: applyToAll(p.rows, 'keep', p.choices) } : p)), []);
  const skipAll = useCallback(() => setPhase((p) => (p.kind === 'review' ? { ...p, choices: applyToAll(p.rows, 'skip', p.choices) } : p)), []);
  const clearChoices = useCallback(() => setPhase((p) => (p.kind === 'review' ? { ...p, choices: {} } : p)), []);

  const create = useCallback(() => {
    const current = phaseRef.current;
    const f = fileRef.current;
    const job = jobRef.current;
    if (current.kind !== 'review' || !f || !job) return;
    const { target } = current;
    const { run: runId, signal } = begin();
    setPhase({ kind: 'writing', target });
    void (async () => {
      try {
        const out = await engine.convertWithDecisions(
          {
            rules: target.rules,
            file: { name: f.name, bytes: await f.arrayBuffer() },
            mode: 'write',
            rowDecisions: toRowDecisions(current.choices),
            previewRows: webConfig.convertPreviewRows,
          },
          { signal },
        );
        if (runId !== runRef.current) return;
        if (!out.ok) setPhase({ kind: 'error', error: { kind: 'invalidRules' } });
        else if (out.written) {
          keep(job, target, out);
          if (advance(job)) await drive(job, runId, signal);
          else showOutcome(job);
        }
      } catch (e) {
        fail(runId, e);
      }
    })();
  }, [begin, engine, fail, keep, drive, showOutcome]);

  const download = useCallback(() => {
    const current = phaseRef.current;
    if (current.kind !== 'done') return;
    const { finished } = current;
    downloadBytes(finished.fileName, finished.bytes, outputMimeType(finished.fileType));
  }, []);

  const downloadOne = useCallback((conversionId: string) => {
    const current = phaseRef.current;
    if (current.kind !== 'results') return;
    const hit = current.results.find((r) => r.target.conversionId === conversionId);
    if (hit) downloadBytes(hit.finished.fileName, hit.finished.bytes, outputMimeType(hit.finished.fileType));
  }, []);

  const downloadAll = useCallback(() => {
    const current = phaseRef.current;
    const f = fileRef.current;
    if (current.kind !== 'results' || !f || current.results.length === 0) return;
    const { results, failed } = current;
    const { t, code, lang } = i18nRef.current;
    setPacking(true);
    setPackError(false);
    void (async () => {
      try {
        // DECISION (SPEC 8.15): the zip is the batch's (a folder per format, plus a small summary workbook). The summary has
        // one row per format, and the flag sheet names the format where a batch names the file (it is one file here).
        const flagCount = (r: RunResult): number => flaggedRowCount(r.finished.flags);
        const files: SummaryTable = {
          sheetName: t('batch.summary.sheet.files'),
          headers: (['file', 'format', 'source', 'status', 'rowsIn', 'rowsOut', 'flagged', 'note'] as const).map((k) => t(`batch.summary.col.${k}` as const)),
          rows: [
            ...results.map((r) => [f.name, r.target.formatName, r.target.sourceName, t(flagCount(r) > 0 ? 'batch.status.convertedFlags' : 'batch.status.converted'), r.finished.summary.rowsIn, r.finished.summary.rowsOut, flagCount(r), ''] as const),
            ...failed.map((x) => [f.name, x.formatName, current.source.name, t('batch.status.noMatch'), null, null, 0, failureText(i18nRef.current, x.failure).replace(/[⁦-⁩]/g, '')] as const),
          ].map((row) => [...row]),
        };
        const flags: SummaryTable = {
          sheetName: t('batch.summary.sheet.flags'),
          headers: (['format', 'row', 'column', 'value', 'message'] as const).map((k) => t(`batch.summary.col.${k}` as const)),
          rows: results.flatMap((r) =>
            r.finished.flags.map((fl) => [r.target.formatName, fl.rowNumber, columnLabel(r.target.rules, fl.column), fl.value, code({ kind: 'flag', code: fl.messageKey, ...(fl.params ? { params: fl.params } : {}) })]),
          ),
        };
        // The bytes are copied: sending them to the worker moves them, and the single downloads still need theirs.
        const outputs: BatchOutputFile[] = results.map((r) => ({ folder: r.target.formatName, fileName: r.finished.fileName, bytes: r.finished.bytes.slice(0) }));
        const out = await engine.batch({ outputs, summary: { files, flags, language: lang }, summaryFileName: t('conv.results.summaryFile') }, {});
        downloadBytes(`${baseName(f.name)} (converted).zip`, out.zip, 'application/zip');
      } catch (e) {
        if (!isCancellation(e)) setPackError(true);
      } finally {
        setPacking(false);
      }
    })();
  }, [engine]);

  const holdForEditing = useCallback((target: Target) => {
    const f = fileRef.current;
    const job = jobRef.current;
    if (!f) return;
    // DECISION (SPEC 8.15, "Change the rule" with several formats): the file, the queue and the results already made wait in
    // memory; coming back runs the conversion under review again with its edited rules and then goes on with the formats that
    // were still to come. (Only the one conversion's rules were edited, so nothing already made is redone.)
    convertSession.save({ file: f, conversionId: target.conversionId, formatId: target.formatId, ...(job ? { job: { ...job, results: [...job.results], failed: [...job.failed] } } : {}) });
  }, []);

  const resume = useCallback((): boolean => {
    const held = convertSession.peek();
    if (!held) return false;
    const { run: runId, signal } = begin();
    fileRef.current = held.file;
    setFile(held.file);
    let job = held.job;
    if (!job) {
      // A session without its run (nothing else was pending): the one conversion, in its source as the page lists it now.
      const listed = entriesRef.current.find((e) => e.conversions.some((c) => c.conversionId === held.conversionId));
      const conv = listed?.conversions.find((c) => c.conversionId === held.conversionId) ?? { conversionId: held.conversionId, formatId: held.formatId, formatName: '', status: 'verified' as const };
      const source: SignatureEntry = listed ? { ...listed, conversions: [conv] } : { sourceId: '', name: '', columns: [], conversions: [conv] };
      job = { file: held.file, source, mapping: {}, queue: [conv], index: 0, results: [], failed: [] };
    }
    void startJob(job, runId, signal);
    return true;
  }, [begin, startJob]);

  const reset = useCallback(() => {
    runRef.current++;
    abortRef.current?.abort();
    fileRef.current = null;
    rankedRef.current = [];
    jobRef.current = null;
    convertSession.clear();
    setFile(null);
    setAliasNotSaved(false);
    setPacking(false);
    setPackError(false);
    setPhase({ kind: 'idle' });
  }, []);

  return {
    sources,
    entries,
    phase,
    file,
    aliasNotSaved,
    packing,
    packError,
    start,
    choose,
    chooseFormats,
    submitMapping,
    setChoice,
    keepAll,
    skipAll,
    clearChoices,
    create,
    download,
    downloadOne,
    downloadAll,
    holdForEditing,
    resume,
    reset,
  };
}
