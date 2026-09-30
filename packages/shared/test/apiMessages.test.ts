import { describe, expect, it } from 'vitest';
import { API_ERROR_CODES, LIMIT_CODES, apiErrorMessages, limitMessages, limits } from '../src/index';

// SPEC 9.5/11: the API returns only stable codes; every one needs he + en UI text.
describe('API error codes and messages', () => {
  it('has non-empty he and en text for every API error code', () => {
    for (const code of API_ERROR_CODES) {
      expect(apiErrorMessages[code].en.length, code).toBeGreaterThan(0);
      expect(apiErrorMessages[code].he.length, code).toBeGreaterThan(0);
    }
    expect(Object.keys(apiErrorMessages).sort()).toEqual([...API_ERROR_CODES].sort());
  });

  it('has non-empty he and en text for every limit code', () => {
    for (const code of LIMIT_CODES) {
      expect(limitMessages[code].en.length, code).toBeGreaterThan(0);
      expect(limitMessages[code].he.length, code).toBeGreaterThan(0);
    }
    expect(Object.keys(limitMessages).sort()).toEqual([...LIMIT_CODES].sort());
  });

  it('includes the codes the M2 protections return', () => {
    for (const code of ['limitHit', 'anonBudgetExhausted', 'budgetExhausted', 'rateLimited', 'turnstileFailed']) {
      expect(API_ERROR_CODES).toContain(code);
    }
  });
});

describe('protection config (SPEC 8: limits live in config)', () => {
  it('defines positive protection and cache settings', () => {
    expect(limits.protection.anonLearnsPerIpPerDay).toBeGreaterThan(0);
    expect(limits.protection.learnRequestsPerIpPerMinute).toBeGreaterThan(0);
    expect(limits.protection.learnIdTtlMinutes).toBeGreaterThan(0);
    expect(limits.cache.ttlDays).toBeGreaterThan(0);
  });
});
