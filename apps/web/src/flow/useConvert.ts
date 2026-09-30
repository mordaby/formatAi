import type { LearnResult, Rules } from '@formatai/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { webConfig } from '../config';
import { useServices } from '../services';
import type { ConvertOutput } from '../worker/engineApi';
import { downloadBytes, outputFileName, outputMimeType } from './download';
import { isCancellation, toFlowError, type FlowError } from './errors';
import type { FileLike } from './learnFlow';

type Converted = Extract<ConvertOutput, { ok: true }>;

export type ConvertState =
  | { status: 'idle' }
  | { status: 'running' }
  | { status: 'done'; result: Converted; fileName: string }
  /** The rules ran but the file didn't fit them (missing required columns, no table...). */
  | { status: 'rejected'; error: Extract<ConvertOutput, { ok: false }>['error'] }
  | { status: 'error'; error: FlowError };

export interface UseConvert {
  state: ConvertState;
  convert(rules: LearnResult | Rules, file: FileLike): Promise<void>;
  /** Saves the last converted file through the browser's download. */
  download(): void;
  reset(): void;
}

/** Flow C (SPEC 5): apply saved/learned rules to a file, in the worker. No network, no LLM. */
export function useConvert(): UseConvert {
  const { engine } = useServices();
  const [state, setState] = useState<ConvertState>({ status: 'idle' });
  const abortRef = useRef<AbortController | null>(null);
  const runRef = useRef(0);

  useEffect(() => () => abortRef.current?.abort(), []);

  const convert = useCallback(
    async (rules: LearnResult | Rules, file: FileLike) => {
      abortRef.current?.abort();
      const abort = new AbortController();
      abortRef.current = abort;
      const run = ++runRef.current;
      setState({ status: 'running' });
      try {
        if (file.size > webConfig.maxFileBytes) {
          setState({ status: 'error', error: { kind: 'fileTooLarge', fileName: file.name, bytes: file.size, maxBytes: webConfig.maxFileBytes } });
          return;
        }
        const out = await engine.convert(
          { rules, file: { name: file.name, bytes: await file.arrayBuffer() }, previewRows: webConfig.convertPreviewRows },
          { signal: abort.signal },
        );
        if (run !== runRef.current) return;
        if (out.ok) setState({ status: 'done', result: out, fileName: outputFileName(file.name, rules) });
        else setState({ status: 'rejected', error: out.error });
      } catch (e) {
        if (run !== runRef.current || isCancellation(e)) return;
        setState({ status: 'error', error: toFlowError(e) });
      }
    },
    [engine],
  );

  const download = useCallback(() => {
    if (state.status !== 'done') return;
    downloadBytes(state.fileName, state.result.bytes, outputMimeType(state.result.preview.file?.type));
  }, [state]);

  const reset = useCallback(() => {
    runRef.current++;
    abortRef.current?.abort();
    setState({ status: 'idle' });
  }, []);

  return { state, convert, download, reset };
}
