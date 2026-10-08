import { capCount, capSmall, fileTypeOfName } from '@formatai/shared';
import { useEffect, useState } from 'react';
import { useServices, useTrack } from '../services';
import type { DropZoneInfo } from '../ui';

/**
 * Asks the engine worker how big a dropped file is (rows, columns), so the drop zone can show it.
 * `undefined` while there is no file. A file that cannot be opened is `unreadable`; any other
 * trouble (the worker restarting, say) just leaves the counts out rather than blocking the user.
 */
export function useFileInfo(file: File | null, side: 'input' | 'output'): DropZoneInfo | undefined {
  const { engine } = useServices();
  const track = useTrack();
  const [entry, setEntry] = useState<{ file: File; info: DropZoneInfo } | null>(null);

  useEffect(() => {
    if (!file) {
      setEntry(null);
      return;
    }
    let alive = true;
    setEntry({ file, info: { status: 'reading' } });
    (async () => {
      let info: DropZoneInfo;
      try {
        const bytes = await file.arrayBuffer();
        const out = await engine.inspect({ file: { name: file.name, bytes }, side });
        info = out.readable ? { status: 'ready', rows: out.rows, columns: out.columns } : { status: 'unreadable' };
      } catch {
        info = { status: 'ready', rows: null, columns: null };
      }
      if (!alive) return;
      setEntry({ file, info });
      // SPEC 14.1: a file was dropped - which side, its type (the extension only) and how big it is; or why it could not be read. Never its name.
      if (info.status === 'unreadable') track('file_rejected', { reason: 'unreadable' });
      else {
        const fileType = fileTypeOfName(file.name);
        if (fileType) track('file_uploaded', { role: side, fileType, ...(info.status === 'ready' && info.rows !== null ? { rows: capCount(info.rows) } : {}), ...(info.status === 'ready' && info.columns !== null ? { cols: capSmall(info.columns) } : {}) });
      }
    })();
    return () => {
      alive = false;
    };
  }, [engine, file, side, track]);

  if (!file) return undefined;
  return entry?.file === file ? entry.info : { status: 'reading' };
}
