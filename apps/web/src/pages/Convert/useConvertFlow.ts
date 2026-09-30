// Flow C as a small state machine (SPEC 5 C, 8.12, 21 v5 item 5). The file and its bytes stay on this computer: the
// worker reads the headers, matches them to the saved conversions' signatures, runs the rules and writes the file. What
// crosses the network is only a conversion's rules (in), a confirmed rename and the counts of a run (out).
//
//   idle -> matching -> (choose) -> running -> (mapping | missing) ...
//                                     running -> review -> writing -> done      (flagged rows: the user decides first)
//                                     running -> done                            (nothing to look at)
import type { ConversionMatch, Flag, RunSummary } from '@formatai/engine';
import type { Rules, SignatureEntry } from '@formatai/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError } from '../../api/http';
import { useConvertApi } from '../../api/convert';
import { webConfig } from '../../config';
import { downloadBytes, outputMimeType } from '../../flow/download';
import { isCancellation, toFlowError, type FlowError } from '../../flow/errors';
import { useServices } from '../../services';
import type { OutputSheet } from '@formatai/engine';
import type { RowInputCell, SignatureInput } from '../../worker/convertApi';
import { RpcRemoteError } from '../../worker/rpcClient';
import { applyToAll, reviewRows, runCounts, toRowDecisions, withAliases, type Choices, type ReviewRow, type RowChoice } from './logic';
import { convertSession } from './session';

/** Everything the run needs to know about the source it uses (rules included, with any confirmed rename already in). */
export interface Target {
  conversionId: string;
  formatId: string;
  formatName: string;
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

export type Phase =
  | { kind: 'idle' }
  | { kind: 'matching' }
  | { kind: 'choose'; options: ConversionMatch[] }
  | { kind: 'noMatch' }
  /** Required columns are missing but the file has columns nothing claimed: the user can say which is which. */
  | { kind: 'mapping'; target: Target; match: ConversionMatch }
  /** Required columns are missing and nothing can stand in for them: stop, and say exactly which. */
  | { kind: 'missing'; target: Target; missing: string[] }
  | { kind: 'running'; target: Target }
  | { kind: 'review'; target: Target; flags: Flag[]; summary: RunSummary; rowInputs: Record<number, RowInputCell[]>; rows: ReviewRow[]; choices: Choices }
  | { kind: 'writing'; target: Target }
  | { kind: 'done'; target: Target; finished: Finished }
  | { kind: 'error'; error: ConvertError };

export type SourcesState = { status: 'loading' } | { status: 'ready'; entries: SignatureEntry[] } | { status: 'error' };

export interface UseConvertFlow {
  sources: SourcesState;
  phase: Phase;
  file: File | null;
  /** A confirmed rename that could not be saved (the file was converted anyway). */
  aliasNotSaved: boolean;
  start(file: File): void;
  /** From "which source is this file?". */
  choose(conversionId: string): void;
  /** From the renamed-columns step: required header -> the file's header (null: "it's not in this file"). */
  submitMapping(mapping: Record<string, string | null>, remember: boolean): void;
  setChoice(rowNumber: number, choice: RowChoice | null): void;
  keepAll(): void;
  skipAll(): void;
  clearChoices(): void;
  /** "Create the file": converts with the decisions. */
  create(): void;
  download(): void;
  /** Keeps the file for the trip to the rules editor and back (`/convert?resume=1`). */
  holdForEditing(target: Target): void;
  /** Picks up the file held for the editor, converting again with the (edited) rules. */
  resume(): boolean;
  reset(): void;
}

function toSignature(e: SignatureEntry): SignatureInput {
  return { id: e.conversionId, name: e.sourceName, columns: e.columns };
}

export function toConvertError(e: unknown): ConvertError {
  if (e instanceof ApiError && (e.code === 'notFound' || e.status === 404)) return { kind: 'gone' };
  if (e instanceof ApiError && e.code === 'invalidRules') return { kind: 'invalidRules' };
  if (e instanceof RpcRemoteError && e.code === 'unreadable') return { kind: 'unreadable' };
  return toFlowError(e);
}

export interface ConvertFlowOptions {
  /** Signed in: the signatures are loaded. */
  enabled: boolean;
  /** Only the sources of this format (`/convert?format=<id>`). */
  formatId: string | null;
  /** The tier's largest file. */
  maxBytes: number;
}

export function useConvertFlow({ enabled, formatId, maxBytes }: ConvertFlowOptions): UseConvertFlow {
  const { engine } = useServices();
  const api = useConvertApi();
  const [sources, setSources] = useState<SourcesState>({ status: 'loading' });
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [file, setFile] = useState<File | null>(null);
  const [aliasNotSaved, setAliasNotSaved] = useState(false);

  const runRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const fileRef = useRef<File | null>(null);
  const rankedRef = useRef<ConversionMatch[]>([]);
  const phaseRef = useRef<Phase>(phase);
  phaseRef.current = phase;

  // The sources this page may use: all of the user's, or one format's.
  const entries = useMemo(() => (sources.status === 'ready' ? sources.entries.filter((e) => formatId === null || e.formatId === formatId) : []), [sources, formatId]);
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

  /** A run has finished with a written file: show it, and report the counts (counts only). */
  const finish = useCallback(
    (target: Target, sourceFile: File, out: { bytes: ArrayBuffer; fileType: 'xlsx' | 'csv' | 'txt'; flags: Flag[]; summary: RunSummary; preview: OutputSheet; totalRows: number }) => {
      const stem = sourceFile.name.split(/[/\\]/).pop() ?? sourceFile.name;
      const dot = stem.lastIndexOf('.');
      const base = (dot > 0 ? stem.slice(0, dot) : stem) || 'output';
      setPhase({ kind: 'done', target, finished: { ...out, fileName: `${base} (converted).${out.fileType}` } });
      convertSession.clear();
      // SPEC 14.1, 15: how many rows and how many were flagged - never a value, a header or a file name.
      void api.recordRun(target.conversionId, runCounts(out.summary, out.flags)).catch(() => undefined);
    },
    [api],
  );

  /** Reads the file with `target`'s rules, stopping before the file is written when rows need the user's eye. */
  const run = useCallback(
    async (target: Target, sourceFile: File, runId: number, signal: AbortSignal) => {
      setPhase({ kind: 'running', target });
      try {
        const out = await engine.convertWithDecisions(
          { rules: target.rules, file: { name: sourceFile.name, bytes: await sourceFile.arrayBuffer() }, mode: 'review', previewRows: webConfig.convertPreviewRows },
          { signal },
        );
        if (runId !== runRef.current) return;
        if (!out.ok) {
          const { error } = out;
          if (error.code === 'missingRequiredColumns') setPhase({ kind: 'missing', target, missing: error.missing ?? [] });
          else if (error.code === 'noTable') setPhase({ kind: 'error', error: { kind: 'noTable' } });
          else if (error.code === 'sheetNotFound') setPhase({ kind: 'error', error: { kind: 'sheetNotFound' } });
          else setPhase({ kind: 'error', error: { kind: 'invalidRules' } });
          return;
        }
        if (!out.written) {
          setPhase({ kind: 'review', target, flags: out.flags, summary: out.summary, rowInputs: out.rowInputs, rows: reviewRows(out.flags, out.summary), choices: {} });
          return;
        }
        finish(target, sourceFile, out);
      } catch (e) {
        fail(runId, e);
      }
    },
    [engine, finish, fail],
  );

  /** Fetches the source's rules and goes on: to the file's rename step, or straight to running it. */
  const prepare = useCallback(
    async (conversionId: string, match: ConversionMatch | null, sourceFile: File, runId: number, signal: AbortSignal) => {
      try {
        const detail = await api.conversion(conversionId, signal);
        if (runId !== runRef.current) return;
        const entry = entriesRef.current.find((e) => e.conversionId === conversionId);
        const target: Target = { conversionId, formatId: detail.formatId, formatName: entry?.formatName ?? '', sourceName: detail.sourceName, rules: detail.rules };
        if (match && match.missingRequired.length > 0) {
          // The conversion can't run without these columns (a score of 0.9 allows one to be missing).
          setPhase(match.extra.length > 0 ? { kind: 'mapping', target, match } : { kind: 'missing', target, missing: match.missingRequired });
          return;
        }
        await run(target, sourceFile, runId, signal);
      } catch (e) {
        fail(runId, e);
      }
    },
    [api, run, fail],
  );

  const start = useCallback(
    (next: File) => {
      const { run: runId, signal } = begin();
      fileRef.current = next;
      setFile(next);
      setAliasNotSaved(false);
      if (next.size > maxBytes) {
        setPhase({ kind: 'error', error: { kind: 'fileTooLarge', fileName: next.name, bytes: next.size, maxBytes } });
        return;
      }
      setPhase({ kind: 'matching' });
      void (async () => {
        try {
          const out = await engine.matchFile({ file: { name: next.name, bytes: await next.arrayBuffer() }, signatures: entriesRef.current.map(toSignature) }, { signal });
          if (runId !== runRef.current) return;
          if (!out.ok) {
            setPhase({ kind: 'error', error: { kind: out.reason } });
            return;
          }
          rankedRef.current = out.ranked;
          if (out.pick.kind === 'auto') await prepare(out.pick.match.id, out.pick.match, next, runId, signal);
          else if (out.pick.options.length === 0) setPhase({ kind: 'noMatch' });
          else setPhase({ kind: 'choose', options: out.pick.options });
        } catch (e) {
          fail(runId, e);
        }
      })();
    },
    [begin, engine, maxBytes, prepare, fail],
  );

  const choose = useCallback(
    (conversionId: string) => {
      const f = fileRef.current;
      if (!f) return;
      const { run: runId, signal } = begin();
      setPhase({ kind: 'matching' });
      void prepare(conversionId, rankedRef.current.find((m) => m.id === conversionId) ?? null, f, runId, signal);
    },
    [begin, prepare],
  );

  const submitMapping = useCallback(
    (mapping: Record<string, string | null>, remember: boolean) => {
      const current = phaseRef.current;
      const f = fileRef.current;
      if (current.kind !== 'mapping' || !f) return;
      const { target } = current;
      const chosen: Record<string, string> = {};
      for (const [header, fileHeader] of Object.entries(mapping)) if (fileHeader) chosen[header] = fileHeader;
      const stillMissing = current.match.missingRequired.filter((h) => chosen[h] === undefined);
      if (stillMissing.length > 0) {
        setPhase({ kind: 'missing', target, missing: stillMissing });
        return;
      }
      const { run: runId, signal } = begin();
      const withRename: Target = { ...target, rules: withAliases(target.rules, chosen) };
      setPhase({ kind: 'running', target: withRename });
      void (async () => {
        if (remember) {
          // SPEC 5 C: a confirmed mapping is saved as a new alias. A failure doesn't stop this file.
          let failed = false;
          for (const [header, alias] of Object.entries(chosen)) {
            try {
              await api.addAlias(target.conversionId, { header, alias });
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
        await run(withRename, f, runId, signal);
      })();
    },
    [api, begin, run],
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
    if (current.kind !== 'review' || !f) return;
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
        else if (out.written) finish(target, f, out);
      } catch (e) {
        fail(runId, e);
      }
    })();
  }, [begin, engine, finish, fail]);

  const download = useCallback(() => {
    const current = phaseRef.current;
    if (current.kind !== 'done') return;
    const { finished } = current;
    downloadBytes(finished.fileName, finished.bytes, outputMimeType(finished.fileType));
  }, []);

  const holdForEditing = useCallback((target: Target) => {
    const f = fileRef.current;
    if (f) convertSession.save({ file: f, conversionId: target.conversionId, formatId: target.formatId });
  }, []);

  const resume = useCallback((): boolean => {
    const held = convertSession.peek();
    if (!held) return false;
    const { run: runId, signal } = begin();
    fileRef.current = held.file;
    setFile(held.file);
    setPhase({ kind: 'matching' });
    void prepare(held.conversionId, null, held.file, runId, signal);
    return true;
  }, [begin, prepare]);

  const reset = useCallback(() => {
    runRef.current++;
    abortRef.current?.abort();
    fileRef.current = null;
    rankedRef.current = [];
    convertSession.clear();
    setFile(null);
    setAliasNotSaved(false);
    setPhase({ kind: 'idle' });
  }, []);

  return { sources, phase, file, aliasNotSaved, start, choose, submitMapping, setChoice, keepAll, skipAll, clearChoices, create, download, holdForEditing, resume, reset };
}
