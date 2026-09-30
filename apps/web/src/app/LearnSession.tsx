import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { useLearnFlow, type UseLearnFlow } from '../flow/useLearnFlow';
import { useTurnstile } from './Turnstile';

/**
 * Everything one visit to "teach a format" carries from screen to screen: the two example
 * files, the masking choice, and the learn flow itself. It lives above the routes so that going
 * from Home to the Result screen (and back) does not cancel or forget anything. The Result
 * screen reads `flow.state` (status 'done') and the example files from here.
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
  /** Starts (or restarts) a learn from the two files in the session. No-op while a file is missing. */
  begin(): void;
  /** Forget the files and the result: back to an empty Home. */
  startOver(): void;
}

const LearnSessionContext = createContext<LearnSession | null>(null);

export function useLearnSession(): LearnSession {
  const ctx = useContext(LearnSessionContext);
  if (!ctx) throw new Error('useLearnSession must be used inside <LearnSessionProvider>');
  return ctx;
}

export function LearnSessionProvider({ children }: { children: ReactNode }) {
  const { getToken } = useTurnstile();
  const flow = useLearnFlow({ getTurnstileToken: getToken });
  const [input, setInput] = useState<File | null>(null);
  const [output, setOutput] = useState<File | null>(null);
  const [masking, setMasking] = useState(true);

  const { start, reset } = flow;
  const begin = useCallback(() => {
    if (input && output) void start({ input, output, masking });
  }, [input, output, masking, start]);
  const startOver = useCallback(() => {
    reset();
    setInput(null);
    setOutput(null);
  }, [reset]);

  const value = useMemo<LearnSession>(
    () => ({ flow, input, output, masking, setInput, setOutput, setMasking, begin, startOver }),
    [flow, input, output, masking, begin, startOver],
  );
  return <LearnSessionContext.Provider value={value}>{children}</LearnSessionContext.Provider>;
}
