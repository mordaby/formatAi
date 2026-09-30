import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useLearnFlow, type UseLearnFlow } from '../flow/useLearnFlow';
import { peekResultSession, seedResultSession } from '../pages/Result/session';
import { webConfig } from '../config';
import { useMe } from './Me';
import { fileOf, getPendingStore, storeFile, type PendingLearn, type PendingResult } from './pendingLearn';
import { useSignIn } from './SignIn';
import type { Tier } from '@formatai/shared';

/**
 * Everything one visit to "teach a format" carries from screen to screen: the two example
 * files, the masking choice, and the learn flow itself. It lives above the routes so that going
 * from Home to the Result screen (and back) does not cancel or forget anything. The Result
 * screen reads `flow.state` (status 'done') and the example files from here.
 *
 * It also carries the learned rules across the trip to a sign-in provider and back (SPEC 5 E): just before the browser
 * leaves, what has been learned is kept in IndexedDB (never sent), and when the app starts again the local analysis is
 * re-run on the kept files and the kept edits are put back on top - so the Result screen comes back as it was.
 */
export interface LearnSession {
  flow: UseLearnFlow;
  input: File | null;
  output: File | null;
  /** SPEC 7.2: on by default. */
  masking: boolean;
  setInput(file: File | null): void;
  setOutput(file: File | null): void;
  setMasking(masking: boolean): void;
  /**
   * Starts (or restarts) a learn from the two files in the session. No-op while a file is missing. A signed-in user gets the
   * AI step when the fast path is not enough; a visitor gets the local result (SPEC 21 v5 item 1).
   */
  begin(opts?: { ai?: 'allowed' | 'notAllowed' }): void;
  /** "Finish with the AI step": the same learn, with the AI step allowed (signed in). */
  finishWithAi(): void;
  /** Forget the files and the result: back to an empty Home. */
  startOver(): void;
  /** A kept learn is being put back after a sign-in (the Result screen waits for it instead of going home). */
  restoring: boolean;
}

const LearnSessionContext = createContext<LearnSession | null>(null);

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
  // Read at the start of every learn, so a sign-in never replaces the flow (and with it a result on screen).
  const getTier = useCallback((): Tier => meRef.current.tier, []);
  // No anti-bot widget here: a visitor never reaches the AI step (the one thing Turnstile guarded), so the learn asks for no token.
  // (The Turnstile code stays: the lead form will use it.)
  const flow = useLearnFlow({ getTier });
  const [input, setInput] = useState<File | null>(null);
  const [output, setOutput] = useState<File | null>(null);
  const [masking, setMasking] = useState(true);
  const [restoring, setRestoring] = useState(true);

  const { start, reset } = flow;
  const begin = useCallback(
    (opts?: { ai?: 'allowed' | 'notAllowed' }) => {
      if (!input || !output) return;
      const ai = opts?.ai ?? (meRef.current.user ? 'allowed' : 'notAllowed');
      void start({ input, output, masking, ai });
    },
    [input, output, masking, start],
  );
  const finishWithAi = useCallback(() => begin({ ai: 'allowed' }), [begin]);
  const startOver = useCallback(() => {
    reset();
    setInput(null);
    setOutput(null);
  }, [reset]);

  // ---- keeping what has been learned across the trip to the provider (SPEC 5 E) ----
  const latest = useRef({ input, output, masking, state: flow.state });
  latest.current = { input, output, masking, state: flow.state };
  useEffect(() => {
    signIn.setBeforeRedirect(async () => {
      const { input: i, output: o, masking: m, state } = latest.current;
      const resultSession = state.status === 'done' && state.result.rules ? peekResultSession(state.result) : undefined;
      if (!i && !o && !resultSession) return;
      let result: PendingResult | null = null;
      if (resultSession) {
        const editor = resultSession.store.getState();
        result = { name: resultSession.name, rules: editor.rules, edited: [...editor.edited], exceptions: editor.exceptions };
      }
      const record: PendingLearn = {
        version: 1,
        savedAt: Date.now(),
        path: window.location.pathname,
        input: i ? await storeFile(i) : null,
        output: o ? await storeFile(o) : null,
        masking: m,
        result,
      };
      await getPendingStore().save(record);
    });
    return () => signIn.setBeforeRedirect(null);
  }, [signIn]);

  // ---- putting it back when the app starts again ----
  const seed = useRef<PendingResult | null>(null);
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
      await store.clear(); // used once
      const i = record.input ? fileOf(record.input) : null;
      const o = record.output ? fileOf(record.output) : null;
      setInput(i);
      setOutput(o);
      setMasking(record.masking);
      if (record.result && i && o) {
        seed.current = record.result;
        // The local analysis only: the AI step is the user's next click ("Finish with the AI step"), never automatic.
        void startRef.current({ input: i, output: o, masking: record.masking, ai: 'notAllowed' });
      } else {
        setRestoring(false);
      }
    })().catch(() => setRestoring(false));
  }, [meReady]);

  // The restored learn finished: put the edits back on top of it, and let the Result screen show.
  const ranOnce = useRef(false);
  const status = flow.state.status;
  const doneResult = flow.state.status === 'done' ? flow.state.result : undefined;
  useEffect(() => {
    if (!restoring || !seed.current) return;
    if (doneResult?.rules) {
      const kept = seed.current;
      seed.current = null;
      // The same local analysis gives the same rules, so the kept (edited) rules are what the screen starts from.
      seedResultSession(doneResult, { name: kept.name, rules: kept.rules, edited: kept.edited, exceptions: kept.exceptions });
      setRestoring(false);
    } else if (status === 'error' || status === 'blocked' || status === 'warn' || status === 'notReady') {
      seed.current = null; // the kept learn did not come back as a result: nothing to put on top
      setRestoring(false);
    } else if (status === 'idle' && ranOnce.current) {
      seed.current = null; // cancelled meanwhile
      setRestoring(false);
    } else if (status !== 'idle') {
      ranOnce.current = true;
    }
  }, [restoring, status, doneResult]);

  // The API says the session is gone (a stale "signed in"): read who is signed in again, so "Sign in" works.
  const flowError = flow.state.status === 'error' ? flow.state.error : undefined;
  const sessionGone = flowError?.kind === 'api' && (flowError.code === 'signInForAi' || flowError.code === 'signInRequired');
  const { refresh } = me;
  useEffect(() => {
    if (sessionGone) void refresh();
  }, [sessionGone, refresh]);

  // What is left of the AI learns, as the learn reported it.
  const quota = flow.state.status === 'done' ? flow.state.ai?.quota : undefined;
  const { setQuota } = me;
  useEffect(() => {
    if (quota) setQuota(quota);
  }, [quota, setQuota]);

  const value = useMemo<LearnSession>(
    () => ({ flow, input, output, masking, setInput, setOutput, setMasking, begin, finishWithAi, startOver, restoring }),
    [flow, input, output, masking, begin, finishWithAi, startOver, restoring],
  );
  return <LearnSessionContext.Provider value={value}>{children}</LearnSessionContext.Provider>;
}
