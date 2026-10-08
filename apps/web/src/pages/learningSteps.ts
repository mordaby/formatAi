// Which step of "learning" the flow is on, for the progress screen (SPEC 16.1 screen 3):
// Reading files -> Checking the files -> Learning the format -> Checking against your example.
// Steps that never happen (the local fast path has no "Learning") are never visited, so they
// are simply never shown.
import { useEffect, useState } from 'react';
import type { LearnFlowState } from '../flow/learnFlow';
import type { MessageKey } from '../i18n';
import type { CheckRoundInfo, LoopRoundInfo } from '../worker/engineApi';

export type StepKey = 'reading' | 'checking' | 'learning' | 'learningRepair' | 'verifying';

export const STEP_LABELS: Record<StepKey, MessageKey> = {
  reading: 'flow.reading',
  checking: 'flow.checking',
  learning: 'flow.learning',
  learningRepair: 'flow.learningRepair',
  verifying: 'flow.verifying',
};

export function stepKeyOf(state: LearnFlowState): StepKey | undefined {
  switch (state.status) {
    case 'reading':
      return 'reading';
    case 'checking':
      return 'checking';
    case 'learning':
      return state.attempt === 'repair' ? 'learningRepair' : 'learning';
    case 'verifying':
      return 'verifying';
    default:
      return undefined;
  }
}

/**
 * A round of the learning loop in words: "Checking every row of your example: sending 5 rows the rules got wrong (round 2 of 3)." The round for a
 * list says what it is for: "Looking for the rule behind a list of fixed values (round 2 of 3)."
 */
export function roundText(t: (key: MessageKey, params?: Record<string, string | number>) => string, round: LoopRoundInfo): string {
  if (round.list) return t('learning.round.list', { n: round.n, of: round.of });
  const key: MessageKey = round.rows === 0 ? 'learning.round.none' : round.rows === 1 ? 'learning.round.one' : 'learning.round.other';
  return t(key, { n: round.n, of: round.of, rows: round.rows });
}

/** A round of AI code checks in words: "The AI is checking an idea on your rows (round 1 of 3)." */
export function checkRoundText(t: (key: MessageKey, params?: Record<string, string | number>) => string, round: CheckRoundInfo): string {
  return t('learning.checks', { n: round.n, of: round.of });
}

/** The flow is busy with the files (as opposed to idle, or waiting for the user, or finished). */
export function isRunning(state: LearnFlowState): boolean {
  return stepKeyOf(state) !== undefined;
}

/** The steps visited so far, in order, ending with the current one. Empty while idle. */
export function useStepHistory(state: LearnFlowState): StepKey[] {
  const [history, setHistory] = useState<StepKey[]>([]);
  const key = stepKeyOf(state);
  const { status } = state;

  useEffect(() => {
    if (key) setHistory((h) => (key === 'reading' ? ['reading'] : h[h.length - 1] === key ? h : [...h, key]));
    else if (status === 'idle' || status === 'blocked' || status === 'error' || status === 'notReady' || status === 'known') setHistory([]);
  }, [key, status]);

  // The current step is on screen in the very render it begins, before the effect has run.
  if (key && history[history.length - 1] !== key) return key === 'reading' ? ['reading'] : [...history, key];
  return history;
}

/**
 * A learn that finishes in a blink should not flash a progress screen. The progress screen shows
 * only once the work has lasted `delayMs`; before that the form stays, with its button busy.
 * It stays visible across a pause for the user's go-ahead, and is dropped when the flow is idle again.
 */
export function useProgressVisible(state: LearnFlowState, delayMs = 250): boolean {
  const active = isRunning(state) || state.status === 'warn' || state.status === 'done';
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!active) {
      setVisible(false);
      return;
    }
    const timer = setTimeout(() => setVisible(true), delayMs);
    return () => clearTimeout(timer);
  }, [active, delayMs]);
  return visible;
}
