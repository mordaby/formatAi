import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { UserColumnChoices } from '@formatai/engine';
import { stripAiNotes, type AiStepPartCode, type LearnResult, type Rules, type Tier } from '@formatai/shared';
import { hasChoices } from '../flow/learnFlow';
import { useLearnFlow, type UseLearnFlow } from '../flow/useLearnFlow';
import { peekResultSession, seedResultSession } from '../pages/Result/session';
import { webConfig } from '../config';
import { useOnAi } from './aiReport';
import { useMe } from './Me';
import { fileOf, getPendingStore, keepPendingWithinTheHour, storeFile, type PendingLearn, type PendingResult } from './pendingLearn';
import { useSignIn } from './SignIn';

/**
 * Everything one visit to "teach a format" carries from screen to screen: the two example
 * files, the masking choice, and the learn flow itself. It lives above the routes so that going
 * from Home to the Result screen (and back) does not cancel or forget anything. The Result
 * screen reads `flow.state` (status 'done') and the example files from here.
 *
 * It also carries the learned rules across the trip to a sign-in provider and back (SPEC 5 E): just before the browser
 * leaves, what has been learned is kept in IndexedDB (never sent), and when the app starts again the local analysis is
 * re-run on the kept files and the kept edits are put back on top - so the Result screen comes back as it was. A visitor's
 * "Learn with AI" (Home, the 'ai' sign-in wall) is carried the same way: only the two files and the choice are kept, and after
 * the sign-in the learn starts by itself, the AI step following it.
 */
export interface LearnSession {
  flow: UseLearnFlow;
  input: File | null;
  output: File | null;
  /** SPEC 7.2: on by default. */
  masking: boolean;
  /**
   * "See what we send" (owner, 2026-10-07): the user's choice per column of these two files, hidden or sent as it is. For every request of
   * the learns of these files (the first call, repairs, checks, a completion); a new file (either side) starts again from none.
   */
  columnChoices: UserColumnChoices;
  setInput(file: File | null): void;
  setOutput(file: File | null): void;
  setMasking(masking: boolean): void;
  setColumnChoices(choices: UserColumnChoices): void;
  /** Home's "Learn with AI" chose the AI step for this learn: it starts by itself after the free result, only if fields are missing. Not remembered: the next learn asks again. */
  deepAnalysis: boolean;
  /**
   * Starts (or restarts) a learn from the two files in the session. No-op while a file is missing. EVERY learn is the free engine only
   * (owner decision: the AI step never runs unless the user chooses it - signed in or not); the learn waits until who is signed in is
   * known (`/api/me`) so its tier's limits are right. `opts.ai` says it outright (only "Finish with AI" as a whole learn does).
   * `opts.deep` sets `deepAnalysis` for this learn ("Learn with AI" true, "Learn the format" false); a retry leaves it as it was.
   */
  begin(opts?: { ai?: 'allowed' | 'notAllowed'; deep?: boolean }): void;
  /** The whole learn again, with the AI step allowed (signed in): "Finish with AI" when too little is solved to complete. It replaces the result on screen. */
  finishWithAi(): void;
  /**
   * "Finish with AI" (completion mode, LEARN_PROMPT "Completing a partial rules file"): the AI step produces only what is
   * missing from `fixedRules` (the rules as they are on screen). It runs in `completion`, a flow of its own, so the Result screen
   * and its rules stay as they are until an answer has passed the fixed lock and the verification.
   */
  completeWithAi(plan: { fixedRules: LearnResult | Rules; columns: number[]; parts: AiStepPartCode[]; exampleId: string | undefined }): void;
  /** The completion run's flow (idle until `completeWithAi`). */
  completion: UseLearnFlow;
  /** Forget the files and the result: back to an empty Home. */
  startOver(): void;
  /** A kept learn is being put back after a sign-in (the Result screen waits for it instead of going home). */
  restoring: boolean;
}

const LearnSessionContext = createContext<LearnSession | null>(null);

/** No choice made: every column as code decides. */
const NO_CHOICES: UserColumnChoices = {};

export function useLearnSession(): LearnSession {
  const ctx = useContext(LearnSessionContext);
  if (!ctx) throw new Error('useLearnSession must be used inside <LearnSessionProvider>');
  return ctx;
}

export function LearnSessionProvider({ children }: { children: ReactNode }) {
  const me = useMe();
  const signIn = useSignIn();
  const meRef = useRef(me);
  meRef.current = me;
  // Read at the start of every learn, so a sign-in never replaces the flow (and with it a result on screen). (The AI step never runs by
  // itself, whoever is signed in: a learn is the free engine unless it says otherwise - `StartParams.ai` - and the AI step is the user's
  // choice on the Result screen: "Finish with AI", or Home's "Learn with AI", which that screen acts on once the free result is in.)
  const getTier = useCallback((): Tier => meRef.current.tier, []);
  // ... and a learn started before that answer is waiting for it (it would otherwise run as a visitor's - tier, limits and all).
  const meAnswered = useRef<{ promise: Promise<void>; resolve(): void } | null>(null);
  if (meAnswered.current === null) {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => {
      resolve = r;
    });
    meAnswered.current = { promise, resolve };
  }
  useEffect(() => {
    if (me.status === 'ready') meAnswered.current!.resolve();
  }, [me.status]);
  const whenMeKnown = useCallback(
    () => Promise.race([meAnswered.current!.promise, new Promise<void>((resolve) => setTimeout(resolve, webConfig.meReadyTimeoutMs))]),
    [],
  );
  // No anti-bot widget here: the free learn never reaches the AI step (the one thing Turnstile guarded), so it asks for no token.
  // (The Turnstile code stays: the lead form will use it.)
  // What either flow learns about the AI step - what is left, a refusal - is told the app the one way (app/aiReport.ts).
  const onAi = useOnAi();
  const flow = useLearnFlow({ getTier, ready: whenMeKnown, onAi });
  const completion = useLearnFlow({ getTier, ready: whenMeKnown, onAi });
  const [input, setInput] = useState<File | null>(null);
  const [output, setOutput] = useState<File | null>(null);
  const [masking, setMasking] = useState(true);
  const [columnChoices, setColumnChoices] = useState<UserColumnChoices>(NO_CHOICES);
  const [deepAnalysis, setDeepAnalysis] = useState(false);
  const [restoring, setRestoring] = useState(true);
  // The latest of everything a callback below needs to read at the moment it runs (not when it was made).
  const latest = useRef({ input, output, masking, columnChoices, state: flow.state });
  latest.current = { input, output, masking, columnChoices, state: flow.state };
  // A new example (another file on either side) starts with no choice: the choices were for the columns of the files they were made on.
  const chooseInput = useCallback((file: File | null) => {
    setInput(file);
    setColumnChoices(NO_CHOICES);
  }, []);
  const chooseOutput = useCallback((file: File | null) => {
    setOutput(file);
    setColumnChoices(NO_CHOICES);
  }, []);


  const { start, cancel: reset } = flow;
  const { start: startCompletion, cancel: resetCompletion } = completion;
  const begin = useCallback(
    (opts?: { ai?: 'allowed' | 'notAllowed'; deep?: boolean }) => {
      if (!input || !output) return;
      if (opts?.deep !== undefined) setDeepAnalysis(opts.deep);
      // A new learn replaces the result: a "Finish with AI" still at work on the old one has nothing left to finish.
      resetCompletion();
      // (no `ai` given: the free engine only)
      void start({ input, output, masking, columnChoices, ...(opts?.ai ? { ai: opts.ai } : {}) });
    },
    [input, output, masking, columnChoices, start, resetCompletion],
  );
  const finishWithAi = useCallback(() => begin({ ai: 'allowed' }), [begin]);
  const completeWithAi = useCallback(
    (plan: { fixedRules: LearnResult | Rules; columns: number[]; parts: AiStepPartCode[]; exampleId: string | undefined }) => {
      if (!input || !output) return;
      // (a learn that was continued past "rows couldn't be aligned" is analysed the same way again)
      const main = latest.current.state;
      const tryAnyway = main.status === 'done' && main.tryAnyway === true;
      void startCompletion({
        input,
        output,
        masking,
        columnChoices,
        ai: 'allowed',
        ...(tryAnyway ? { tryAnyway: true } : {}),
        complete: { fixedRules: plan.fixedRules, columns: plan.columns, parts: plan.parts, exampleId: plan.exampleId },
      });
    },
    [input, output, masking, columnChoices, startCompletion],
  );
  const startOver = useCallback(() => {
    reset();
    resetCompletion();
    setInput(null);
    setOutput(null);
    setColumnChoices(NO_CHOICES);
    setDeepAnalysis(false);
  }, [reset, resetCompletion]);

  // ---- keeping what has been learned across the trip to the provider (SPEC 5 E) ----
  // ... for an hour at most, as the privacy page says: dropped on its hour while a tab is open, and at once on a page load past it.
  const withinTheHour = useRef<ReturnType<typeof keepPendingWithinTheHour> | null>(null);
  useEffect(() => {
    const hour = keepPendingWithinTheHour();
    withinTheHour.current = hour;
    return () => {
      hour.stop();
      withinTheHour.current = null;
    };
  }, []);
  useEffect(() => {
    signIn.setBeforeRedirect(async ({ reason }) => {
      const { input: i, output: o, masking: m, columnChoices: choices, state } = latest.current;
      // A visitor's "Learn with AI" (Home, the 'ai' wall): the learn they asked for is a new one from the two files, so nothing of an earlier
      // result is kept - only the files and the choice (the free engine runs again after the sign-in, and the AI step follows it).
      const aiLearn = reason === 'ai' && i !== null && o !== null;
      const tryAnyway = !aiLearn && state.status === 'done' && state.tryAnyway === true;
      const resultSession = !aiLearn && state.status === 'done' && state.result.rules ? peekResultSession(state.result) : undefined;
      if (!i && !o && !resultSession) return;
      let result: PendingResult | null = null;
      if (resultSession) {
        const editor = resultSession.store.getState();
        // SPEC 15: what is kept in IndexedDB never holds the AI's explanation or function request (they live beside the rules, in the session only).
        result = { name: resultSession.name, rules: stripAiNotes(editor.rules), edited: [...editor.edited], exceptions: editor.exceptions };
      }
      const record: PendingLearn = {
        version: 1,
        savedAt: Date.now(),
        path: window.location.pathname,
        input: i ? await storeFile(i) : null,
        output: o ? await storeFile(o) : null,
        masking: m,
        ...(hasChoices(choices) ? { columnChoices: choices } : {}),
        ...(tryAnyway ? { tryAnyway: true } : {}),
        ...(aiLearn ? { deepAnalysis: true } : {}),
        result,
      };
      await getPendingStore().save(record);
      // (a sign-in that does not leave after all - a blocked redirect - must not keep it past its hour either)
      withinTheHour.current?.check();
    });
    return () => signIn.setBeforeRedirect(null);
  }, [signIn]);

  // ---- putting it back when the app starts again ----
  const seed = useRef<PendingResult | null>(null);
  // A visitor's "Learn with AI" is being carried on (no edits to put back, only the learn to wait for).
  const resuming = useRef(false);
  const started = useRef(false);
  const meReady = me.status === 'ready';
  // (`start` changes with every state of the flow: read it when needed, so this effect runs once and is never cancelled by a click)
  const startRef = useRef(start);
  startRef.current = start;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  // DECISION: the kept copy is dropped once the restore has come to an end (the screen is back, or it could not be), not when it begins: a page that
  // reloads in the middle of it (the dev server, a crash, the user) must still find it.
  const restored = useCallback(() => {
    setRestoring(false);
    void getPendingStore().clear();
  }, []);
  useEffect(() => {
    if (!meReady || started.current) return;
    started.current = true;
    (async () => {
      const store = getPendingStore();
      const record = await Promise.race([store.load(), new Promise<null>((resolve) => setTimeout(() => resolve(null), webConfig.pendingLearn.loadTimeoutMs))]);
      if (!mounted.current) return;
      if (!record) {
        setRestoring(false);
        return;
      }
      const i = record.input ? fileOf(record.input) : null;
      const o = record.output ? fileOf(record.output) : null;
      setInput(i);
      setOutput(o);
      setMasking(record.masking);
      const choices = record.columnChoices ?? NO_CHOICES;
      setColumnChoices(choices);
      if (record.result && i && o) {
        seed.current = record.result;
        // The local analysis only: the AI step is the user's choice on the Result screen (never started here).
        void startRef.current({ input: i, output: o, masking: record.masking, columnChoices: choices, ai: 'notAllowed', ...(record.tryAnyway ? { tryAnyway: true } : {}) });
      } else if (record.deepAnalysis && i && o && meRef.current.user) {
        // "Learn with AI" from a visitor, now signed in: the learn they asked for starts by itself, and the Result screen goes on with the AI step
        // when fields are missing (`deepAnalysis`). Not signed in after all (declined, failed): the files are back and nothing starts.
        resuming.current = true;
        setDeepAnalysis(true);
        void startRef.current({ input: i, output: o, masking: record.masking, columnChoices: choices, ai: 'notAllowed' });
      } else {
        restored();
      }
    })().catch(() => restored());
  }, [meReady, restored]);

  // The restored learn finished: put the edits back on top of it, and let the Result screen show.
  const ranOnce = useRef(false);
  const status = flow.state.status;
  const doneResult = flow.state.status === 'done' ? flow.state.result : undefined;
  useEffect(() => {
    if (!restoring || (!seed.current && !resuming.current)) return;
    if (doneResult?.rules) {
      const kept = seed.current;
      seed.current = null;
      resuming.current = false;
      // The same local analysis gives the same rules, so the kept (edited) rules are what the screen starts from.
      if (kept) seedResultSession(doneResult, { name: kept.name, rules: kept.rules, edited: kept.edited, exceptions: kept.exceptions });
      restored();
    } else if (status === 'error' || status === 'blocked' || status === 'warn' || status === 'notReady') {
      seed.current = null; // the kept learn did not come back as a result: nothing to put on top
      resuming.current = false;
      restored();
    } else if (status === 'idle' && ranOnce.current) {
      seed.current = null; // cancelled meanwhile
      resuming.current = false;
      restored();
    } else if (status !== 'idle') {
      ranOnce.current = true;
    }
  }, [restoring, status, doneResult, restored]);

  const value = useMemo<LearnSession>(
    () => ({
      flow,
      completion,
      input,
      output,
      masking,
      columnChoices,
      deepAnalysis,
      setInput: chooseInput,
      setOutput: chooseOutput,
      setMasking,
      setColumnChoices,
      begin,
      finishWithAi,
      completeWithAi,
      startOver,
      restoring,
    }),
    [flow, completion, input, output, masking, columnChoices, deepAnalysis, chooseInput, chooseOutput, begin, finishWithAi, completeWithAi, startOver, restoring],
  );
  return <LearnSessionContext.Provider value={value}>{children}</LearnSessionContext.Provider>;
}
