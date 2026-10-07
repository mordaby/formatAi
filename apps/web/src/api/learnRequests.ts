// The JSON bodies of the learn calls (SPEC 5 A steps 5-6, 9.3, 21 v14), built in ONE place: the API client sends what these return, and
// "See what we send" (SPEC 15, `sentBody` in flow/learnFlow.ts) shows what they return for the same arguments - so what the panel shows and
// what leaves the browser can never drift apart. Pure functions, no network.
import type { CheckRound, LearnPayload, LearnRequest, LearnResult, RepairProblem, RepairRequest, Sample, StepRequest } from '@formatai/shared';

/** What a learn call carries besides the payload. */
export interface LearnRequestOptions {
  turnstileToken?: string | undefined;
  /** Skip the structure cache (the fresh learn that stands in for a round of the learning loop). */
  noCache?: boolean | undefined;
  /** learn-v9: the answer must be the rules, never checks (the same fresh learn). */
  rulesNow?: boolean | undefined;
}

/** What a repair call carries besides the payload, the rules and the problems. */
export interface RepairRequestOptions {
  /** Every row of the example the loop sent so far, masked. */
  rows?: Sample[] | undefined;
  /** The learn already had its one repair for a rule that copies rows. */
  overfitRepaired?: boolean | undefined;
  /** The round for a list (learn-v9), sent again with its rounds of AI code checks answered. */
  rounds?: CheckRound[] | undefined;
}

/** POST /api/learn. */
export function learnRequest(payload: LearnPayload, opts: LearnRequestOptions = {}): LearnRequest {
  return {
    payload,
    ...(opts.turnstileToken ? { turnstileToken: opts.turnstileToken } : {}),
    ...(opts.noCache ? { noCache: true } : {}),
    ...(opts.rulesNow ? { rulesNow: true } : {}),
  };
}

/** POST /api/learn/repair: one round of the learning loop. */
export function repairRequest(learnId: string, payload: LearnPayload, previousRules: LearnResult, problems: RepairProblem[], opts: RepairRequestOptions = {}): RepairRequest {
  return {
    payload,
    previousRules,
    problems,
    learnId,
    ...(opts.rows && opts.rows.length > 0 ? { rows: opts.rows } : {}),
    ...(opts.overfitRepaired ? { overfitRepaired: true } : {}),
    ...(opts.rounds && opts.rounds.length > 0 ? { rounds: opts.rounds } : {}),
  };
}

/** POST /api/learn/step: one step of AI code checks, every round so far. */
export function stepRequest(token: string, payload: LearnPayload, rounds: CheckRound[]): StepRequest {
  return { token, payload, rounds };
}
