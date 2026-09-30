// Runs the current rules on the example INPUT file (in the worker, like every conversion) to find what a real run would
// flag (SPEC 8.9): parse failures, duplicates, values missing from a translation, checks that fail. It waits until the
// live check has settled, so an edit costs one check and then one run, never both at once.
import type { Flag, RunSummary } from '@formatai/engine';
import { useEffect, useRef } from 'react';
import type { EditableRules } from '../../editor';
import type { FileLike } from '../../flow/learnFlow';
import { useConvert } from '../../flow/useConvert';

/** Wait this long after the last change (and after the check settled) before running again. */
const RUN_DELAY_MS = 350;

export interface RunFlags {
  flags: readonly Flag[];
  summary: RunSummary | undefined;
  running: boolean;
}

const NONE: readonly Flag[] = [];

export function useRunFlags(options: { rules: EditableRules; rev: number; file: FileLike | null; ready: boolean }): RunFlags {
  const { rules, rev, file, ready } = options;
  const { state, convert } = useConvert();

  useEffect(() => {
    if (!ready || !file) return;
    const timer = setTimeout(() => void convert(rules, file), RUN_DELAY_MS);
    return () => clearTimeout(timer);
    // `rules` follows `rev`; `file` is the session's example input.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rev, ready, file, convert]);

  // While a new run is going, the last answer stays on screen (no flicker); a run that failed has no flags.
  const last = useRef<Pick<RunFlags, 'flags' | 'summary'>>({ flags: NONE, summary: undefined });
  if (state.status === 'done') last.current = { flags: state.result.flags, summary: state.result.summary };
  else if (state.status !== 'running') last.current = { flags: NONE, summary: undefined };
  return { ...last.current, running: state.status === 'running' };
}
