// "Try it on another file" as a small state machine (SPEC 5 A step 7, 21 v11): the rules on the Result screen - edits included, saved or
// not - run on ONE more file, in the worker, exactly as a saved conversion would (Convert's run: rows, flagged rows, the review of
// flagged rows BEFORE the file is written, missing required columns). Nothing is saved and nothing goes over the network: there is no
// API call here at all, only the worker.
//
//   idle -> running -> (missing | error)                 the rules cannot run on this file
//                   -> done                              nothing needed a look: the file is written
//                   -> review -> writing -> done         flagged rows are decided first (per row: fix, skip, keep)
import type { Flag, RunSummary } from '@formatai/engine';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { EditableRules } from '../../editor';
import { downloadBytes, outputFileName, outputMimeType } from '../../flow/download';
import { isCancellation } from '../../flow/errors';
import { useServices, useTrack } from '../../services';
import type { RowInputCell } from '../../worker/convertApi';
import { applyToAll, reviewRows, toRowDecisions, withChoice, type Choices, type ReviewRow, type RowChoice } from '../Convert/logic';
import { runFailure, toConvertError, type ConvertError, type Finished } from '../Convert/useConvertFlow';

export type TryPhase =
  | { kind: 'idle' }
  | { kind: 'running' }
  /** The rules the run used are kept with it: the review and the report name columns from them, whatever is edited meanwhile. */
  | { kind: 'review'; rules: EditableRules; flags: Flag[]; summary: RunSummary; rowInputs: Record<number, RowInputCell[]>; rows: ReviewRow[]; choices: Choices }
  | { kind: 'writing'; rules: EditableRules }
  | { kind: 'done'; rules: EditableRules; finished: Finished }
  /** Required columns are missing from this file: the exact headers. */
  | { kind: 'missing'; missing: string[] }
  | { kind: 'error'; error: ConvertError };

export interface UseTryFile {
  phase: TryPhase;
  file: File | null;
  /** Runs `rules` on `file` (read in the worker). Another call replaces the run, the file and whatever was decided. */
  start(file: File, rules: EditableRules): void;
  setChoice(rowNumber: number, choice: RowChoice | null): void;
  keepAll(): void;
  skipAll(): void;
  clearChoices(): void;
  /** "Create the file": runs again with the decisions and writes it. */
  create(): void;
  /** Saves the file made through the browser's download (nothing is uploaded). */
  download(): void;
  reset(): void;
}

export interface TryFileOptions {
  /** The tier's largest file. */
  maxBytes: number;
  /** Output rows kept for the on-screen preview (the tier decides how many are shown). */
  previewRows: number;
}

export function useTryFile({ maxBytes, previewRows }: TryFileOptions): UseTryFile {
  const { engine } = useServices();
  const track = useTrack();
  const [phase, setPhase] = useState<TryPhase>({ kind: 'idle' });
  const [file, setFile] = useState<File | null>(null);
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const fileRef = useRef<File | null>(null);
  const runRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

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

  const start = useCallback(
    (next: File, rules: EditableRules) => {
      const { run, signal } = begin();
      fileRef.current = next;
      setFile(next);
      if (next.size > maxBytes) {
        setPhase({ kind: 'error', error: { kind: 'fileTooLarge', fileName: next.name, bytes: next.size, maxBytes } });
        return;
      }
      setPhase({ kind: 'running' });
      void (async () => {
        try {
          const out = await engine.convertWithDecisions({ rules, file: { name: next.name, bytes: await next.arrayBuffer() }, mode: 'review', previewRows }, { signal });
          if (run !== runRef.current) return;
          if (!out.ok) {
            const failure = runFailure(out.error);
            setPhase(failure.kind === 'missing' ? { kind: 'missing', missing: failure.columns } : { kind: 'error', error: failure });
          } else if (!out.written) {
            setPhase({ kind: 'review', rules, flags: out.flags, summary: out.summary, rowInputs: out.rowInputs, rows: reviewRows(out.flags, out.summary), choices: {} });
          } else {
            setPhase({ kind: 'done', rules, finished: { fileName: outputFileName(next.name, rules), bytes: out.bytes, fileType: out.fileType, flags: out.flags, summary: out.summary, preview: out.preview, totalRows: out.totalRows } });
          }
        } catch (e) {
          fail(run, e);
        }
      })();
    },
    [begin, engine, fail, maxBytes, previewRows],
  );

  const setChoice = useCallback((rowNumber: number, choice: RowChoice | null) => {
    setPhase((p) => (p.kind === 'review' ? { ...p, choices: withChoice(p.choices, rowNumber, choice) } : p));
  }, []);
  const keepAll = useCallback(() => setPhase((p) => (p.kind === 'review' ? { ...p, choices: applyToAll(p.rows, 'keep', p.choices) } : p)), []);
  const skipAll = useCallback(() => setPhase((p) => (p.kind === 'review' ? { ...p, choices: applyToAll(p.rows, 'skip', p.choices) } : p)), []);
  const clearChoices = useCallback(() => setPhase((p) => (p.kind === 'review' ? { ...p, choices: {} } : p)), []);

  const create = useCallback(() => {
    const current = phaseRef.current;
    const f = fileRef.current;
    if (current.kind !== 'review' || !f) return;
    const { rules } = current;
    const { run, signal } = begin();
    setPhase({ kind: 'writing', rules });
    void (async () => {
      try {
        const out = await engine.convertWithDecisions(
          { rules, file: { name: f.name, bytes: await f.arrayBuffer() }, mode: 'write', rowDecisions: toRowDecisions(current.choices), previewRows },
          { signal },
        );
        if (run !== runRef.current) return;
        if (!out.ok) setPhase({ kind: 'error', error: { kind: 'invalidRules' } });
        else if (out.written) {
          setPhase({ kind: 'done', rules, finished: { fileName: outputFileName(f.name, rules), bytes: out.bytes, fileType: out.fileType, flags: out.flags, summary: out.summary, preview: out.preview, totalRows: out.totalRows } });
        }
      } catch (e) {
        fail(run, e);
      }
    })();
  }, [begin, engine, fail, previewRows]);

  const download = useCallback(() => {
    const current = phaseRef.current;
    if (current.kind !== 'done') return;
    const { finished } = current;
    downloadBytes(finished.fileName, finished.bytes, outputMimeType(finished.fileType));
    // SPEC 14.1 `download`: this is the learn screen's own file (the rules not saved yet).
    track('download', { kind: 'learnResult' });
  }, [track]);

  const reset = useCallback(() => {
    runRef.current++;
    abortRef.current?.abort();
    fileRef.current = null;
    setFile(null);
    setPhase({ kind: 'idle' });
  }, []);

  return { phase, file, start, setChoice, keepAll, skipAll, clearChoices, create, download, reset };
}
