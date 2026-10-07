import { limits } from '@formatai/shared';
import { describe, expect, it } from 'vitest';
import { checkBudgets, totalCostUsd } from '../../src/protection/budget.js';

const budgets = { dailyOverallUsd: 50 };

describe('checkBudgets (SPEC 9.5)', () => {
  it('is ok while the day has budget', () => {
    expect(checkBudgets({ spendUsd: 0 }, budgets)).toBe('ok');
    expect(checkBudgets({ spendUsd: 49.99 }, budgets)).toBe('ok');
  });

  it('is the kill switch for everyone once the overall budget is spent', () => {
    expect(checkBudgets({ spendUsd: 50 }, budgets)).toBe('budgetExhausted');
    expect(checkBudgets({ spendUsd: 60 }, budgets)).toBe('budgetExhausted');
  });

  it('reads the budget from config by default - there is no anonymous one any more (API audit 2026-10-07)', () => {
    expect(checkBudgets({ spendUsd: limits.budgets.dailyOverallUsd })).toBe('budgetExhausted');
    expect(Object.keys(limits.budgets)).toEqual(['dailyOverallUsd']);
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
