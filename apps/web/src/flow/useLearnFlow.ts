import type { Tier } from '@formatai/shared';
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { useServices } from '../services';
import { LearnFlow, type LearnFlowDeps, type LearnFlowState, type StartParams } from './learnFlow';

export interface UseLearnFlowOptions {
  /** Read at the start of every learn (so a sign-in does not replace the flow and lose its result). Pass a stable function. Default: anonymous. */
  getTier?: () => Tier;
  /** Resolves once who is signed in is known; awaited at the start of every learn (see `LearnFlowDeps.ready`). Pass a stable function. */
  ready?: () => Promise<void>;
  /** See `LearnFlowDeps.beforeSend`. Pass a stable function (it is a dependency of the flow instance). */
  beforeSend?: LearnFlowDeps['beforeSend'];
  /** See `LearnFlowDeps.onAi` (app/aiReport.ts `useOnAi`). Pass a stable function. */
  onAi?: LearnFlowDeps['onAi'];
}

export interface UseLearnFlow {
  state: LearnFlowState;
  start(params: StartParams): Promise<void>;
  /** Continue past a warning (SPEC 6.4). */
  confirm(): void;
  /** Stop what is running and go back to idle (also: forget a result or an error). */
  cancel(): void;
}

/**
 * Headless learn flow: idle -> reading -> checking -> learning -> verifying -> done |
 * blocked | warn | error, with real progress from the worker. Renders nothing; the UI
 * reads `state` and calls `start` / `confirm` / `cancel`. See ./learnFlow.ts.
 */
export function useLearnFlow(options: UseLearnFlowOptions = {}): UseLearnFlow {
  const { engine, api } = useServices();
  const getTier = options.getTier;
  const ready = options.ready;
  const beforeSend = options.beforeSend;
  const onAi = options.onAi;

  const flow = useMemo(
    () =>
      new LearnFlow({
        engine,
        api,
        tier: 'anonymous',
        ...(getTier ? { getTier } : {}),
        ...(ready ? { ready } : {}),
        ...(beforeSend ? { beforeSend } : {}),
        ...(onAi ? { onAi } : {}),
      }),
    [engine, api, getTier, ready, beforeSend, onAi],
  );
  // Leaving the screen stops a run in progress (the worker drops the call; it keeps what it holds for other screens).
  useEffect(() => () => flow.cancel(), [flow]);

  const state = useSyncExternalStore(flow.subscribe, flow.getState, flow.getState);
  return useMemo(
    () => ({ state, start: (p) => flow.start(p), confirm: () => flow.confirm(), cancel: () => flow.cancel() }),
    [state, flow],
  );
}
