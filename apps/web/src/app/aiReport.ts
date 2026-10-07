// What every flow that reaches the AI step tells the app (C10 of the 2026-10-07 audit): the one `onAi` the learn flows are given
// (`LearnFlowDeps.onAi`, from the learn session's two flows and Add a source's) and that the completion's outcome report uses too. It keeps
// what is left of the AI formats as the server last said it - after a learn, a round, a step, an outcome report, a refusal for the quota -
// and reads who is signed in again when the server says the session is gone, whichever flow found out.
import { useCallback, useRef } from 'react';
import { isAiQuotaHit, isSessionGone } from '../flow/errors';
import type { AiEvent } from '../flow/learnFlow';
import { useMe } from './Me';

/** A stable `onAi` for a flow (or a report): see the file header. */
export function useOnAi(): (event: AiEvent) => void {
  const me = useMe();
  const meRef = useRef(me);
  meRef.current = me;
  return useCallback((event: AiEvent) => {
    const { setQuota, refresh, quota } = meRef.current;
    if ('quota' in event) {
      setQuota(event.quota);
      return;
    }
    const { error } = event;
    // Refused for the quota: none are left (the period the server counted, or the one already known).
    if (isAiQuotaHit(error)) {
      const period = error.period ?? quota?.period;
      if (period) setQuota({ remaining: 0, period });
    }
    // A stale "signed in": read who is signed in again, so "Sign in" works.
    if (isSessionGone(error)) void refresh();
  }, []);
}
