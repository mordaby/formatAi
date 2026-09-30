// SPEC 9.5 budgets: a daily anonymous budget and a daily overall budget, in USD from config
// (`limits.budgets`). The overall budget is the kill switch; the anonymous one only pauses
// anonymous learning ("Sign in to keep going"). Pure math; storage is in `store.ts`.
import { limits } from '@formatai/shared';

/** What one UTC day has spent so far. */
export interface DaySpend {
  spendUsd: number;
  anonSpendUsd: number;
}

export type BudgetVerdict = 'ok' | 'anonBudgetExhausted' | 'budgetExhausted';

/** The HTTP status each verdict is answered with. */
export const BUDGET_STATUS = { anonBudgetExhausted: 429, budgetExhausted: 503 } as const;

/**
 * A budget is exhausted once the day's spend has reached it. The overall budget is checked first:
 * when the kill switch is thrown, everyone is refused, signed in or not. A cost is known only after
 * a call returns, so concurrent learns can overshoot by the cost of the calls already in flight.
 */
export function checkBudgets(
  spend: DaySpend,
  anonymous: boolean,
  budgets: { dailyAnonUsd: number; dailyOverallUsd: number } = limits.budgets,
): BudgetVerdict {
  if (spend.spendUsd >= budgets.dailyOverallUsd) return 'budgetExhausted';
  if (anonymous && spend.anonSpendUsd >= budgets.dailyAnonUsd) return 'anonBudgetExhausted';
  return 'ok';
}

/** The cost of every call one learn made. Subscription/claude-cli calls report 0. */
export function totalCostUsd(calls: readonly { costUsd: number }[]): number {
  let total = 0;
  for (const c of calls) {
    if (Number.isFinite(c.costUsd) && c.costUsd > 0) total += c.costUsd;
  }
  return total;
}
