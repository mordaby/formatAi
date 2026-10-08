// "Download the file" on the Result and Add-source screens: the example input converted with the rules as they are on screen, in the worker
// (no network), and the FULL file saved through the browser. Saving a format never does this: it is its own button.
import { useCallback, useState } from 'react';
import type { EditableRules } from '../../editor';
import { downloadBytes, outputFileName, outputFileType, outputMimeType } from '../../flow/download';
import { useServices, useTrack } from '../../services';
import type { EngineClient } from '../../worker/engineClient';

/** Converts the example input with `rules` in the worker (no network) and saves the FULL file through the browser. */
export async function convertAndDownload(engine: EngineClient, file: File, rules: EditableRules): Promise<void> {
  const out = await engine.convert({ rules, file: { name: file.name, bytes: await file.arrayBuffer() }, previewRows: 0 });
  if (!out.ok) throw new Error('the file could not be converted');
  downloadBytes(outputFileName(file.name, rules), out.bytes, outputMimeType(outputFileType(rules)));
}

export interface UseDownload {
  /** 'failed': the file could not be made (told once, until the next try). */
  status: 'idle' | 'busy' | 'failed';
  run(file: File, rules: EditableRules): void;
}

export function useDownload(): UseDownload {
  const { engine } = useServices();
  const track = useTrack();
  const [status, setStatus] = useState<UseDownload['status']>('idle');
  const run = useCallback(
    (file: File, rules: EditableRules): void => {
      setStatus('busy');
      convertAndDownload(engine, file, rules).then(
        () => {
          setStatus('idle');
          // SPEC 14.1 `download`: the learn screen's file was saved.
          track('download', { kind: 'learnResult' });
        },
        () => setStatus('failed'),
      );
    },
    [engine, track],
  );
  return { status, run };
}
