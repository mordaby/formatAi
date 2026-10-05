// "Finish with AI" as completion mode (LEARN_PROMPT "Completing a partial rules file"): the AI step produces only what is
// missing from the rules on screen and must leave everything else exactly as it is. This hook runs it (in the session's own
// `completion` flow, so the Result screen and its rules stay put) and decides what the answer is worth:
//
//   * it replaces the rules only when it passed BOTH checks - the fixed lock (nothing the user had was changed or dropped) and the full
//     verification against the example (a column the AI step reported as unsupported, left empty, does not count against it) - and
//     produced at least something of what was asked (an answer that gives up on every listed column is no completion);
//   * anything else leaves the rules exactly as they were and says so plainly;
//   * while it works, the fields it is asked for (and the shape of the columns) are read-only (`EditorStore.setLock`, see Workbench) and
//     the rest can be edited: the answer is MERGED with those edits (`mergeRules`, the rules as they were at the start being the common
//     ground). Only edits that collide with the answer keep it out.
import { isCompletable, type AiColumnNote, type AiStepPartCode, type LearnResult, type Rules } from '@formatai/shared';
import type { AmbiguousColumn, FillSummary, VerifyResult } from '@formatai/engine';
import type { LearnOutput, LoopRoundInfo } from '../../worker/engineApi';
import { useEffect, useRef, useState } from 'react';
import { useLearnSession } from '../../app/LearnSession';
import { mergeRules, type EditableRules, type EditorStore } from '../../editor';
import type { AiInfo } from '../../flow/learnFlow';
import type { FlowError } from '../../flow/errors';
import { isRunning } from '../learningSteps';

export type CompletionOutcome =
  /** `asked`: how many columns and layout parts it was asked for; `produced`: how many of them it made. `merged`: your edits made while it worked were merged into its answer. */
  | { kind: 'done'; asked: { columns: number; parts: number }; produced: { columns: number; parts: number }; merged: boolean }
  /**
   * The answer was not used: `lock` it changed something fixed, `mismatch` it did not match the example, `nothing` it produced nothing of what
   * was asked, `changed` the rules were edited meanwhile in a way that collides with the answer.
   */
  | { kind: 'kept'; why: 'lock' | 'mismatch' | 'nothing' | 'changed' }
  /** The readiness gate said the AI step cannot succeed for these files (what to fix is in `result.readiness`); nothing was used up. */
  | { kind: 'notReady'; result: LearnOutput }
  | { kind: 'error'; error: FlowError };

export interface CompletionPlanInput {
  fixedRules: LearnResult | Rules;
  columns: number[];
  parts: AiStepPartCode[];
}

export interface UseCompletion {
  /** The AI step is working on it. */
  running: boolean;
  /** While it runs a round of the learning loop: which one, of how many, and how many rows the rules got wrong it sends. */
  round: LoopRoundInfo | null;
  /** How many output columns the run in progress was asked for. */
  columnsAsked: number;
  /** What the last run was asked for (headers and parts); null before the first. While `running`, these are the fields the analysis works on. */
  asked: { columns: string[]; parts: AiStepPartCode[] } | null;
  /** What the last run came to (null: none yet, or one is running). */
  outcome: CompletionOutcome | null;
  /** Set once an answer has replaced the rules: the verification that let it, and the AI step's report (learn id, quota). */
  completed: { verification: VerifyResult; ai: AiInfo | undefined; filled: FillSummary | undefined; ambiguous: readonly AmbiguousColumn[] | undefined } | null;
  /** The failed-attempt cap on this example pair is reached: the AI step is not called for it any more. */
  exhausted: boolean;
  start(plan: CompletionPlanInput): void;
}

/**
 * `onNotes` (learn-v7): called with what the AI step noted about the columns it was asked for (its guess, whether a function request was
 * recorded) just before an applied answer replaces the rules - the screen keeps them in the session, never with the rules.
 */
export function useCompletion(store: EditorStore, exampleId: string | undefined, onNotes?: (askedHeaders: string[], notes: AiColumnNote[]) => void): UseCompletion {
  const session = useLearnSession();
  const state = session.completion.state;
  const [outcome, setOutcome] = useState<CompletionOutcome | null>(null);
  const [asked, setAsked] = useState<{ columns: string[]; parts: AiStepPartCode[] } | null>(null);
  const columnsAsked = asked?.columns.length ?? 0;
  const [done, setDone] = useState<{ result: object; verification: VerifyResult; ai: AiInfo | undefined; filled: FillSummary | undefined; ambiguous: readonly AmbiguousColumn[] | undefined } | null>(null);
  const revAtStart = useRef(0);
  const baseRules = useRef<EditableRules | null>(null);
  const handled = useRef<object | null>(null);

  useEffect(() => {
    if (state.status === 'done') {
      const res = state.result;
      if (handled.current === res) return; // (the outcome report folds into the same state: already dealt with)
      handled.current = res;
      const c = res.completion;
      if (!res.rules || !c || c.fixedProblems.length > 0) setOutcome({ kind: 'kept', why: 'lock' });
      else if (!c.matches) setOutcome({ kind: 'kept', why: 'mismatch' });
      else if (c.produced.columns + c.produced.parts === 0) setOutcome({ kind: 'kept', why: 'nothing' });
      else {
        // DECISION: replaced as a fresh start (`reset`), so this step is not in the undo history; what the user changed before stays marked
        // "edited" and what the AI step added does not. Edits made while it worked (other fields: the asked ones were read-only) are merged in.
        const s = store.getState();
        const edited = s.rev !== revAtStart.current;
        const next = edited && baseRules.current ? mergeRules<EditableRules>(baseRules.current, s.rules, res.rules) : edited ? null : res.rules;
        if (!next || (edited && !isCompletable(next))) setOutcome({ kind: 'kept', why: 'changed' });
        else {
          onNotes?.(
            c.columns.map((i) => res.rules!.output.columns[i]?.header ?? ''),
            res.aiNotes ?? [],
          );
          store.reset(next, { exceptions: s.exceptions, edited: [...s.edited] });
          if (res.verification) setDone({ result: res, verification: res.verification, ai: state.ai, filled: res.filled, ambiguous: res.ambiguous });
          const partsAsked = c.parts.length;
          setOutcome({ kind: 'done', asked: { columns: c.columns.length, parts: partsAsked }, produced: c.produced, merged: edited });
        }
      }
    } else if (state.status === 'error') {
      if (handled.current === state.error) return;
      handled.current = state.error;
      setOutcome({ kind: 'error', error: state.error });
    } else if (state.status === 'notReady') {
      if (handled.current === state.result) return;
      handled.current = state.result;
      setOutcome({ kind: 'notReady', result: state.result });
    } else if (state.status === 'blocked' || state.status === 'warn') {
      // (not expected: the files were analysed a moment ago, the same way) Never leave the flow waiting for an answer nobody can give here.
      if (handled.current === state) return;
      handled.current = state;
      session.completion.cancel();
      setOutcome({ kind: 'error', error: { kind: 'unexpected', message: state.status } });
    }
  }, [state, store, session.completion]);

  const start = (plan: CompletionPlanInput): void => {
    setOutcome(null);
    setAsked({ columns: plan.columns.map((i) => plan.fixedRules.output.columns[i]?.header ?? ''), parts: [...plan.parts] });
    revAtStart.current = store.getState().rev;
    baseRules.current = plan.fixedRules;
    session.completeWithAi({ ...plan, exampleId });
  };

  // The report of the run that applied (its counted/quota arrive a moment after the answer itself).
  const live = done && state.status === 'done' && state.result === done.result ? state.ai : undefined;
  const ai = done ? (live ?? done.ai) : undefined;
  const exhausted =
    (state.status === 'done' && state.ai?.exhausted === true) || (outcome?.kind === 'error' && outcome.error.kind === 'api' && outcome.error.code === 'aiAttemptsExhausted');

  return {
    running: isRunning(state),
    round: state.status === 'learning' && state.round ? state.round : null,
    columnsAsked,
    asked,
    outcome,
    completed: done ? { verification: done.verification, ai, filled: done.filled, ambiguous: done.ambiguous } : null,
    exhausted,
    start,
  };
}
