import type { Tier } from '@formatai/shared';
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { useServices } from '../services';
import { LearnFlow, type LearnFlowDeps, type LearnFlowState, type StartParams } from './learnFlow';

export interface UseLearnFlowOptions {
  /** Default 'anonymous' (sign-in arrives in M3). */
  tier?: Tier;
  getTurnstileToken?: () => Promise<string | undefined>;
  /** See `LearnFlowDeps.beforeSend`. Pass a stable function (it is a dependency of the flow instance). */
  beforeSend?: LearnFlowDeps['beforeSend'];
}

export interface UseLearnFlow {
  state: LearnFlowState;
  start(params: StartParams): Promise<void>;
  /** Continue past a warning (SPEC 6.4). */
  confirm(): void;
  cancel(): void;
  reset(): void;
}

/**
 * Headless learn flow: idle -> reading -> checking -> learning -> verifying -> done |
 * blocked | warn | error, with real progress from the worker. Renders nothing; the UI
 * reads `state` and calls `start` / `confirm` / `cancel`. See ./learnFlow.ts.
 */
export function useLearnFlow(options: UseLearnFlowOptions = {}): UseLearnFlow {
  const { engine, api } = useServices();
  const tier = options.tier ?? 'anonymous';
  const getTurnstileToken = options.getTurnstileToken;
  const beforeSend = options.beforeSend;

  const flow = useMemo(
    () => new LearnFlow({ engine, api, tier, ...(getTurnstileToken ? { getTurnstileToken } : {}), ...(beforeSend ? { beforeSend } : {}) }),
    [engine, api, tier, getTurnstileToken, beforeSend],
  );
  // Leaving the screen stops a run in progress (and restarts the worker, dropping its memory).
  useEffect(() => () => flow.cancel(), [flow]);

  const state = useSyncExternalStore(flow.subscribe, flow.getState, flow.getState);
  return useMemo(
    () => ({ state, start: (p) => flow.start(p), confirm: () => flow.confirm(), cancel: () => flow.cancel(), reset: () => flow.reset() }),
    [state, flow],
  );
}
