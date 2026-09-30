import { limits } from '@formatai/shared';
import { describe, expect, it } from 'vitest';
import { checkBudgets, totalCostUsd } from '../../src/protection/budget.js';

const budgets = { dailyAnonUsd: 5, dailyOverallUsd: 50 };

describe('checkBudgets (SPEC 9.5)', () => {
  it('is ok while both budgets have room', () => {
    expect(checkBudgets({ spendUsd: 0, anonSpendUsd: 0 }, true, budgets)).toBe('ok');
    expect(checkBudgets({ spendUsd: 4.99, anonSpendUsd: 4.99 }, true, budgets)).toBe('ok');
  });

  it('pauses anonymous learning once the anonymous budget is spent, but not signed-in users', () => {
    const spend = { spendUsd: 5, anonSpendUsd: 5 };
    expect(checkBudgets(spend, true, budgets)).toBe('anonBudgetExhausted');
    expect(checkBudgets(spend, false, budgets)).toBe('ok');
  });

  it('is the kill switch for everyone once the overall budget is spent', () => {
    const spend = { spendUsd: 50, anonSpendUsd: 1 };
    expect(checkBudgets(spend, true, budgets)).toBe('budgetExhausted');
    expect(checkBudgets(spend, false, budgets)).toBe('budgetExhausted');
  });

  it('reports the overall budget first when both are spent', () => {
    expect(checkBudgets({ spendUsd: 60, anonSpendUsd: 6 }, true, budgets)).toBe('budgetExhausted');
  });

  it('reads the budgets from config by default', () => {
    const anonSpent = { spendUsd: limits.budgets.dailyAnonUsd, anonSpendUsd: limits.budgets.dailyAnonUsd };
    expect(checkBudgets(anonSpent, true)).toBe('anonBudgetExhausted');
    expect(checkBudgets({ spendUsd: limits.budgets.dailyOverallUsd, anonSpendUsd: 0 }, false)).toBe('budgetExhausted');
  });
});

describe('totalCostUsd', () => {
  it('sums every call and counts subscription (0) calls as nothing', () => {
    expect(totalCostUsd([{ costUsd: 0.5 }, { costUsd: 0.25 }, { costUsd: 0 }])).toBeCloseTo(0.75);
    expect(totalCostUsd([])).toBe(0);
  });

  it('ignores negative and non-finite costs', () => {
    expect(totalCostUsd([{ costUsd: -1 }, { costUsd: Number.NaN }, { costUsd: 2 }])).toBe(2);
  });
});
