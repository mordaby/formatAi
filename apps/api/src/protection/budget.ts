// SPEC 9.5 budgets: a daily overall budget, in USD from config (`limits.budgets`) - the kill switch. Pure math; storage is in
// `store.ts`. (API audit 2026-10-07: the daily ANONYMOUS budget is gone with the anonymous AI step - only signed-in users reach the AI,
// SPEC 21 v5 - and with it `anonBudgetExhausted` and the anonymous part of a day's spend.)
import { limits } from '@formatai/shared';

/** What one UTC day has spent so far. */
export interface DaySpend {
  spendUsd: number;
}

export type BudgetVerdict = 'ok' | 'budgetExhausted';

/** The HTTP status each verdict is answered with. */
export const BUDGET_STATUS = { budgetExhausted: 503 } as const;

/**
 * The budget is exhausted once the day's spend has reached it: the kill switch, everyone is refused. A cost is known only after a call
 * returns, so concurrent learns can overshoot by the cost of the calls already in flight.
 */
export function checkBudgets(spend: DaySpend, budgets: { dailyOverallUsd: number } = limits.budgets): BudgetVerdict {
  return spend.spendUsd >= budgets.dailyOverallUsd ? 'budgetExhausted' : 'ok';
}

/** The cost of every call one learn made. Subscription/claude-cli calls report 0. */
export function totalCostUsd(calls: readonly { costUsd: number }[]): number {
  let total = 0;
  for (const c of calls) {
    if (Number.isFinite(c.costUsd) && c.costUsd > 0) total += c.costUsd;
  }
  return total;
}
