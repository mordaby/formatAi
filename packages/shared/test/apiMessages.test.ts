import { describe, expect, it } from 'vitest';
import {
  API_ERROR_CODES,
  LIMIT_CODES,
  aiAttemptsExhaustedMessages,
  aiLearnsLimitMessages,
  apiErrorMessages,
  limitMessages,
  limits,
  tiers,
} from '../src/index';

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

  it('includes the codes the M2 protections and the M3 AI quota / registry return', () => {
    for (const code of [
      'limitHit',
      'anonBudgetExhausted',
      'budgetExhausted',
      'rateLimited',
      'turnstileFailed',
      'signInForAi',
      'aiAttemptsExhausted',
      'signInRequired',
      'notFound',
      'invalidRules',
      'formatMismatch',
    ]) {
      expect(API_ERROR_CODES).toContain(code);
    }
    for (const limit of ['aiLearns', 'savedFormats', 'newFormatsPerMonth', 'sourcesPerFormat', 'rulesPerFormat']) {
      expect(LIMIT_CODES).toContain(limit);
    }
  });

  it('has he and en text for the AI-learn period and failed-attempt variants (SPEC 21 v5)', () => {
    for (const period of ['lifetime', 'month', 'day'] as const) {
      expect(aiLearnsLimitMessages[period].en.length, period).toBeGreaterThan(0);
      expect(aiLearnsLimitMessages[period].he.length, period).toBeGreaterThan(0);
    }
    for (const k of ['counted', 'notCounted'] as const) {
      expect(aiAttemptsExhaustedMessages[k].en.length, k).toBeGreaterThan(0);
      expect(aiAttemptsExhaustedMessages[k].he.length, k).toBeGreaterThan(0);
    }
    expect(aiAttemptsExhaustedMessages.notCounted.en).toBe(apiErrorMessages.aiAttemptsExhausted.en);
  });
});

describe('AI learn quota config (SPEC 11, 21 v5)', () => {
  it('gives anonymous none, registered 500 a month and paid 500 a month (owner decision 2026-10-06: the beta)', () => {
    expect(tiers.anonymous.aiLearns).toEqual({ count: 0, period: 'lifetime' });
    expect(tiers.registered.aiLearns).toEqual({ count: 500, period: 'month' });
    expect(tiers.paid.aiLearns).toEqual({ count: 500, period: 'month' });
    // paid is never below registered
    expect(tiers.paid.aiLearns.count).toBeGreaterThanOrEqual(tiers.registered.aiLearns.count);
    for (const t of Object.values(tiers)) {
      expect(['lifetime', 'month', 'day', 'unlimited']).toContain(t.aiLearns.period);
    }
  });

  it('caps failed attempts on one example pair in config', () => {
    expect(limits.learn.maxFailedAiAttempts).toBe(3);
    expect(limits.learn.failedAttemptsWindowHours).toBeGreaterThan(0);
  });
});

describe('protection config (SPEC 8: limits live in config)', () => {
  it('defines positive protection and cache settings', () => {
    expect(limits.protection.learnRequestsPerIpPerMinute).toBeGreaterThan(0);
    expect(limits.protection.learnIdTtlMinutes).toBeGreaterThan(0);
    expect(limits.cache.ttlDays).toBeGreaterThan(0);
  });
});
