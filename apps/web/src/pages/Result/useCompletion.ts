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
//     ground). Only edits that collide with the answer keep it out;
//   * it reports how the run ended (`/outcome`) only once it has decided: `verified` for an answer it applied, `failed` for one it did not use
//     (whatever the reason) - an answer that never reached the rules is never counted as one that did.
//
// What it keeps about a run (what was asked, the rules and the editor's revision at the start, whether the answer has been dealt with, what
// it came to, the applied answer's verification and report) lives in the result's session (`ResultSession.completion`), like the edits: the
// flow itself lives in the session too, so leaving the screen while it works - or after - and coming back must find all of it as it was.
import { isCompletable, type AiColumnNote, type AiStepPartCode, type LearnResult, type Rules } from '@formatai/shared';
import type { AmbiguousColumn, FillSummary, OneTimeQuestion, VerifyResult } from '@formatai/engine';
import type { CheckRoundInfo, LearnOutput, LoopRoundInfo } from '../../worker/engineApi';
import { useEffect, useReducer, useRef } from 'react';
import { useOnAi } from '../../app/aiReport';
import { useLearnSession } from '../../app/LearnSession';
import { useServices } from '../../services';
import { mergeRules, type EditableRules } from '../../editor';
import type { AiInfo, LearnFlowState } from '../../flow/learnFlow';
import type { FlowError } from '../../flow/errors';
import { isRunning } from '../learningSteps';
import type { ResultSession } from './session';

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

/** An applied answer: the verification that let it replace the rules, the AI step's report, and what the screen asks about it. */
export interface CompletedRun {
  verification: VerifyResult;
  ai: AiInfo | undefined;
  filled: FillSummary | undefined;
  ambiguous: readonly AmbiguousColumn[] | undefined;
  oneTimers: readonly OneTimeQuestion[] | undefined;
}

/** What a result's session keeps about its "Finish with AI" (`ResultSession.completion`): it survives leaving the screen. */
export interface CompletionRecord {
  /** A run this result started whose answer (or error, or refusal) has not been dealt with yet. */
  pending: boolean;
  /** The completion flow's state when the run was started: never taken for its answer. */
  since: LearnFlowState;
  /** The editor's revision when it started: a different one means the user edited meanwhile. */
  revAtStart: number;
  /** The rules as they were when it started: the common ground of the merge. */
  baseRules: EditableRules;
  /** What it was asked for (headers and parts). */
  asked: { columns: string[]; parts: AiStepPartCode[] };
  outcome: CompletionOutcome | null;
  /** What the AI step reported for the last run, and then the answer to its outcome report (what counted, what is left, the failed attempts). */
  ai: AiInfo | undefined;
  done: CompletedRun | null;
}

export interface UseCompletion {
  /** The AI step is working on it. */
  running: boolean;
  /** While it runs a round of the learning loop: which one, of how many, and how many rows the rules got wrong it sends. */
  round: LoopRoundInfo | null;
  /** While the AI step checks ideas on the rows before it answers (AI code checks): which round, of how many at most. */
  checkRound: CheckRoundInfo | null;
  /** How many output columns the run in progress was asked for. */
  columnsAsked: number;
  /** What the last run was asked for (headers and parts); null before the first. While `running`, these are the fields the analysis works on. */
  asked: { columns: string[]; parts: AiStepPartCode[] } | null;
  /** What the last run came to (null: none yet, or one is running). */
  outcome: CompletionOutcome | null;
  /** Set once an answer has replaced the rules: the verification that let it, and the AI step's report (learn id, quota). */
  completed: { verification: VerifyResult; ai: AiInfo | undefined; filled: FillSummary | undefined; ambiguous: readonly AmbiguousColumn[] | undefined; oneTimers: readonly OneTimeQuestion[] | undefined } | null;
  /** The failed-attempt cap on this example pair is reached: the AI step is not called for it any more. */
  exhausted: boolean;
  start(plan: CompletionPlanInput): void;
}

/**
 * `kept`: the result's session - its editor, and where what this hook keeps about a run lives. `onNotes` (learn-v7): called with what the AI
 * step noted about the columns it was asked for (its guess, whether a function request was recorded) just before an applied answer replaces
 * the rules - the screen keeps them in the session, never with the rules.
 */
export function useCompletion(kept: ResultSession, exampleId: string | undefined, onNotes?: (askedHeaders: string[], notes: AiColumnNote[]) => void): UseCompletion {
  const session = useLearnSession();
  const { api } = useServices();
  const onAi = useOnAi();
  const store = kept.store;
  const state = session.completion.state;
  // (the record is the session's, a plain object: a change to it re-renders this screen)
  const [, changed] = useReducer((n: number) => n + 1, 0);
  const notesRef = useRef(onNotes);
  notesRef.current = onNotes;

  useEffect(() => {
    const rec = kept.completion;
    // Only a run THIS result started, and only once: the flow is shared, and its last state stays after the run (and after leaving).
    if (!rec?.pending || state === rec.since) return;
    const ai = state.status === 'done' ? state.ai : undefined;
    const settle = (outcome: CompletionOutcome | null, done: CompletedRun | null = rec.done): void => {
      kept.completion = { ...rec, pending: false, outcome, ai, done };
      changed();
      // SPEC 21 v5 item 3, AFTER the decision: an answer that is used is verified, one that is not - the lock, the match, nothing produced, or
      // edits it collides with - failed (it is not counted as an AI format that worked).
      if (outcome && (outcome.kind === 'done' || outcome.kind === 'kept') && ai?.learnId && state.status === 'done' && state.result.path === 'llm') {
        void report(ai.learnId, outcome.kind === 'done' ? 'verified' : 'failed');
      }
    };
    /** The outcome report; its answer (what counted, what is left) is folded into the record - and into the applied answer's report. */
    const report = async (learnId: string, verdict: 'verified' | 'failed'): Promise<void> => {
      let res;
      try {
        res = await api.registry.learnOutcome(learnId, verdict);
      } catch {
        return; // nothing to tell: the server keeps its own count
      }
      // (what is left, as the server says it now: shown whether or not the answer was used)
      onAi({ quota: res.quota });
      const now = kept.completion;
      if (!now || now.ai?.learnId !== learnId) return;
      const next: AiInfo = { ...now.ai, counted: res.counted, failedAttempts: res.failedAttempts, quota: res.quota, exhausted: res.exhausted };
      kept.completion = { ...now, ai: next, done: now.done && now.done.ai?.learnId === learnId ? { ...now.done, ai: next } : now.done };
      changed();
    };
    if (state.status === 'done') {
      const res = state.result;
      const c = res.completion;
      if (!res.rules || !c || c.fixedProblems.length > 0) settle({ kind: 'kept', why: 'lock' });
      else if (!c.matches) settle({ kind: 'kept', why: 'mismatch' });
      else if (c.produced.columns + c.produced.parts === 0) settle({ kind: 'kept', why: 'nothing' });
      else {
        // DECISION: replaced as a fresh start (`reset`), so this step is not in the undo history; what the user changed before stays marked
        // "edited" and what the AI step added does not. Edits made while it worked (other fields: the asked ones were read-only) are merged in.
        const s = store.getState();
        const edited = s.rev !== rec.revAtStart;
        const next = edited ? mergeRules<EditableRules>(rec.baseRules, s.rules, res.rules) : res.rules;
        if (!next || (edited && !isCompletable(next))) settle({ kind: 'kept', why: 'changed' });
        else {
          notesRef.current?.(
            c.columns.map((i) => res.rules!.output.columns[i]?.header ?? ''),
            res.aiNotes ?? [],
          );
          store.reset(next, { exceptions: s.exceptions, oneTime: s.oneTime, edited: [...s.edited] });
          const done: CompletedRun | null = res.verification
            ? { verification: res.verification, ai, filled: res.filled, ambiguous: res.ambiguous, oneTimers: res.oneTimers?.questions }
            : null;
          settle({ kind: 'done', asked: { columns: c.columns.length, parts: c.parts.length }, produced: c.produced, merged: edited }, done);
        }
      }
    } else if (state.status === 'error') {
      settle({ kind: 'error', error: state.error });
    } else if (state.status === 'notReady') {
      settle({ kind: 'notReady', result: state.result });
    } else if (state.status === 'blocked' || state.status === 'warn') {
      // (not expected: the files were analysed a moment ago, the same way) Never leave the flow waiting for an answer nobody can give here.
      session.completion.cancel();
      settle({ kind: 'error', error: { kind: 'unexpected', message: state.status } });
    } else if (state.status === 'idle') {
      settle(null); // cancelled meanwhile (a new learn, Start over): nothing came of it
    }
  }, [state, kept, store, session.completion, api, onAi]);

  const start = (plan: CompletionPlanInput): void => {
    const prev = kept.completion;
    kept.completion = {
      pending: true,
      since: session.completion.state,
      revAtStart: store.getState().rev,
      baseRules: plan.fixedRules,
      asked: { columns: plan.columns.map((i) => plan.fixedRules.output.columns[i]?.header ?? ''), parts: [...plan.parts] },
      outcome: null,
      ai: undefined,
      done: prev?.done ?? null,
    };
    changed();
    session.completeWithAi({ ...plan, exampleId });
  };

  const rec = kept.completion;
  const done = rec?.done ?? null;
  const outcome = rec?.outcome ?? null;
  const ours = rec?.pending === true && state !== rec.since;
  const exhausted = rec?.ai?.exhausted === true || (outcome?.kind === 'error' && outcome.error.kind === 'api' && outcome.error.code === 'aiAttemptsExhausted');

  return {
    running: ours && isRunning(state),
    round: ours && state.status === 'learning' && state.round ? state.round : null,
    checkRound: ours && state.status === 'learning' && state.checkRound ? state.checkRound : null,
    columnsAsked: rec?.asked.columns.length ?? 0,
    asked: rec?.asked ?? null,
    outcome,
    completed: done ? { verification: done.verification, ai: done.ai, filled: done.filled, ambiguous: done.ambiguous, oneTimers: done.oneTimers } : null,
    exhausted,
    start,
  };
}
