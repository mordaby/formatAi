// React wrapper over `LiveCheckScheduler` (see liveCheckScheduler.ts): feeds it every revision of the rules,
// and turns what it knows into the Save button's status.
import type { Format, SourceStructure, Tier } from '@formatai/shared';
import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import type { LiveCheckResult } from '../worker/editorApi';
import { explainStaticProblems, type ExplainedProblem } from './explain';
import { LiveCheckScheduler, type CheckEngine, type LiveCheckState } from './liveCheckScheduler';
import { computeSaveStatus, type SaveStatus } from './saveStatus';
import type { EditorState } from './types';

export interface UseLiveCheckOptions {
  engine: CheckEngine;
  /** From the learn (`LearnOutput.exampleId`) or `loadExample`. Undefined: no example, only the static checks run. */
  exampleId: string | undefined;
  editor: EditorState;
  tier: Tier;
  /** Set when the conversion belongs to a format: turns on the format lock (SPEC 8.12). */
  format?: Format;
  /** Set when the conversion is about to join an existing source the user chose: turns on the source lock (SPEC 8.15). */
  source?: SourceStructure;
  /** SPEC 21 v5 item 1: the local partial result checks only these output columns (positions in the CURRENT rules). Pass a stable array. */
  onlyColumns?: number[];
  debounceMs?: number;
}

export interface UseLiveCheck {
  state: LiveCheckState;
  /** The newest edit has not been checked yet (or the check is running): the shown result is for older rules. */
  stale: boolean;
  /** "Apply": check every row (above 5,000 example rows the live check sees a subset). Resolves with the result. */
  apply(): Promise<LiveCheckResult | null>;
  /** The Save button: verified, "Save with N differences", or blocked by these problems. */
  saveStatus: SaveStatus;
  /** Static-check problems for the current rules, in plain words, tied to lines of the rules map. */
  problems: ExplainedProblem[];
}

export function useLiveCheck(options: UseLiveCheckOptions): UseLiveCheck {
  const { engine, exampleId, editor, tier, debounceMs, onlyColumns } = options;
  const format = useStable(options.format);
  const source = useStable(options.source);
  const scheduler = useMemo(
    () => new LiveCheckScheduler({ engine, exampleId, tier, format, source, ...(debounceMs === undefined ? {} : { debounceMs }) }),
    [engine, exampleId, tier, format, source, debounceMs],
  );
  const state = useSyncExternalStore(scheduler.subscribe, scheduler.getState, scheduler.getState);

  // A cleaned-up effect that runs again (React strict mode) starts the same scheduler again.
  useEffect(() => {
    scheduler.start();
    return () => scheduler.dispose();
  }, [scheduler]);

  // Every revision of the rules or exceptions is one update; the first one runs at once.
  useEffect(() => {
    scheduler.update(
      { rules: editor.rules, exceptions: editor.exceptions, rev: editor.rev, ...(editor.oneTime.length > 0 ? { oneTime: editor.oneTime } : {}), ...(onlyColumns ? { onlyColumns } : {}) },
      { immediate: scheduler.getState().latestRev === null },
    );
  }, [scheduler, editor.rev, editor.rules, editor.exceptions, editor.oneTime, onlyColumns]);

  return useMemo(() => {
    const staticCurrent = state.staticRev === editor.rev ? state.staticProblems : null;
    const fullCurrent = state.fullRev === editor.rev ? state.full : null;
    const saveStatus = computeSaveStatus({
      rules: editor.rules,
      staticProblems: staticCurrent,
      hasExample: exampleId !== undefined && state.status !== 'noExample',
      fullCheck: fullCurrent,
      checkError: state.status === 'error' ? state.error : null,
      ...(onlyColumns ? { excludedColumns: editor.rules.output.columns.length - onlyColumns.length, comparedColumns: onlyColumns.length } : {}),
    });
    const problems = staticCurrent ? explainStaticProblems(editor.rules, staticCurrent) : [];
    return {
      state,
      // Without an example only the static checks run, so that is what can be out of date.
      stale: (exampleId === undefined || state.status === 'noExample' ? state.staticRev : state.liveRev) !== editor.rev,
      apply: () => scheduler.apply(),
      saveStatus,
      problems,
    };
  }, [state, editor.rev, editor.rules, exampleId, scheduler, onlyColumns]);
}

/** A format (or source) object that is equal by content keeps its identity, so passing a fresh one each render does not restart the checks. */
function useStable<T extends object>(value: T | undefined): T | undefined {
  const key = value === undefined ? '' : JSON.stringify(value);
  const last = useRef<{ key: string; value: T | undefined }>({ key, value });
  if (last.current.key !== key) last.current = { key, value };
  return last.current.value;
}
