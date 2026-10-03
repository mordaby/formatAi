// Saving from the Result screen (SPEC 5 A step 8, A2, 8.11 "Saving", 11): one small state machine for "keep it on the server,
// then hand the user the full file". What is saved (a new format, a new source, new rules for a source) is the caller's
// `persist` function; this file owns the busy state, the way failures are told, and the download.
import type { AiLearnPeriod, ApiProblem, LimitCode } from '@formatai/shared';
import { useCallback, useRef, useState } from 'react';
import { ApiError, type ApiFailureCode } from '../../api';
import type { EditableRules } from '../../editor';
import { downloadBytes, outputFileName, outputFileType, outputMimeType } from '../../flow/download';
import { useServices } from '../../services';
import type { EngineClient } from '../../worker/engineClient';

export type SaveFailure =
  | {
      kind: 'api';
      code: ApiFailureCode;
      limit?: LimitCode | undefined;
      period?: AiLearnPeriod | undefined;
      counted?: boolean | undefined;
      problems?: ApiProblem[] | undefined;
    }
  /** The rules were saved, but the file could not be made. */
  | { kind: 'download' };

export type SaveState<T = unknown> =
  | { status: 'idle' }
  | { status: 'saving' }
  | { status: 'saved'; value: T; downloaded: boolean }
  | { status: 'error'; error: SaveFailure };

export function toSaveFailure(e: unknown): SaveFailure {
  if (e instanceof ApiError) return { kind: 'api', code: e.code, limit: e.limit, period: e.period, counted: e.counted, problems: e.problems };
  return { kind: 'api', code: 'unknown' };
}

/** Converts the example input with `rules` in the worker (no network) and saves the FULL file through the browser. */
export async function convertAndDownload(engine: EngineClient, file: File, rules: EditableRules): Promise<void> {
  const out = await engine.convert({ rules, file: { name: file.name, bytes: await file.arrayBuffer() }, previewRows: 0 });
  if (!out.ok) throw new Error('the file could not be converted');
  downloadBytes(outputFileName(file.name, rules), out.bytes, outputMimeType(outputFileType(rules)));
}

export interface SaveRunOptions<T> {
  /** Writes to the server. A rejection is told to the user as it is (a limit, a mismatch, a name in use...). */
  persist(): Promise<T>;
  /** After a successful `persist`: e.g. tell the server the learn was saved with accepted differences. Never blocks or fails the save. */
  afterSaved?(value: T): void;
  /** The example input and the rules to convert it with: the FULL converted file is then downloaded. */
  download?: { file: File; rules: EditableRules } | undefined;
}

export interface UseSave<T> {
  state: SaveState<T>;
  run(options: SaveRunOptions<T>): Promise<void>;
  reset(): void;
}

export function useSave<T = unknown>(): UseSave<T> {
  const { engine } = useServices();
  const [state, setState] = useState<SaveState<T>>({ status: 'idle' });
  const busy = useRef(false);

  const run = useCallback(
    async (options: SaveRunOptions<T>) => {
      if (busy.current) return;
      busy.current = true;
      setState({ status: 'saving' });
      try {
        let value: T;
        try {
          value = await options.persist();
        } catch (e) {
          setState({ status: 'error', error: toSaveFailure(e) });
          return;
        }
        try {
          options.afterSaved?.(value);
        } catch {
          // best effort
        }
        if (options.download) {
          try {
            await convertAndDownload(engine, options.download.file, options.download.rules);
          } catch {
            setState({ status: 'error', error: { kind: 'download' } });
            return;
          }
        }
        setState({ status: 'saved', value, downloaded: options.download !== undefined });
      } finally {
        busy.current = false;
      }
    },
    [engine],
  );

  const reset = useCallback(() => setState({ status: 'idle' }), []);
  return { state, run, reset };
}
