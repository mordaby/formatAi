import { useEffect, useState } from 'react';
import { useServices } from '../services';
import type { DropZoneInfo } from '../ui';

/**
 * Asks the engine worker how big a dropped file is (rows, columns), so the drop zone can show it.
 * `undefined` while there is no file. A file that cannot be opened is `unreadable`; any other
 * trouble (the worker restarting, say) just leaves the counts out rather than blocking the user.
 */
export function useFileInfo(file: File | null, side: 'input' | 'output'): DropZoneInfo | undefined {
  const { engine } = useServices();
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
      if (alive) setEntry({ file, info });
    })();
    return () => {
      alive = false;
    };
  }, [engine, file, side]);

  if (!file) return undefined;
  return entry?.file === file ? entry.info : { status: 'reading' };
}
