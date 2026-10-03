import type { Tier } from '@formatai/shared';
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { useServices } from '../services';
import { LearnFlow, type LearnFlowDeps, type LearnFlowState, type StartParams } from './learnFlow';

export interface UseLearnFlowOptions {
  /** Default 'anonymous'. */
  tier?: Tier;
  /** Read at the start of every learn (so a sign-in does not replace the flow and lose its result). Pass a stable function. Wins over `tier`. */
  getTier?: () => Tier;
  /** Resolves once who is signed in is known; awaited at the start of every learn (see `LearnFlowDeps.ready`). Pass a stable function. */
  ready?: () => Promise<void>;
  /** Whether the AI step is allowed for a learn that did not say; read after `ready`. Pass a stable function. */
  getAi?: () => 'allowed' | 'notAllowed';
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
  const getTier = options.getTier;
  const ready = options.ready;
  const getAi = options.getAi;
  const getTurnstileToken = options.getTurnstileToken;
  const beforeSend = options.beforeSend;

  const flow = useMemo(
    () => new LearnFlow({ engine, api, tier, ...(getTier ? { getTier } : {}), ...(ready ? { ready } : {}), ...(getAi ? { getAi } : {}), ...(getTurnstileToken ? { getTurnstileToken } : {}), ...(beforeSend ? { beforeSend } : {}) }),
    [engine, api, tier, getTier, ready, getAi, getTurnstileToken, beforeSend],
  );
  // Leaving the screen stops a run in progress (and restarts the worker, dropping its memory).
  useEffect(() => () => flow.cancel(), [flow]);

  const state = useSyncExternalStore(flow.subscribe, flow.getState, flow.getState);
  return useMemo(
    () => ({ state, start: (p) => flow.start(p), confirm: () => flow.confirm(), cancel: () => flow.cancel(), reset: () => flow.reset() }),
    [state, flow],
  );
}
