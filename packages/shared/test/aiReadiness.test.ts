import { describe, expect, it } from 'vitest';
import { AI_READINESS_ISSUE_CODES, AI_STEP_PART_CODES, aiReadinessMessages, aiStepPartMessages, limits } from '../src/index';

// SPEC 21 v5 items 1 and 4: the codes the engine's readiness gate and partial result return; the engine
// returns codes with params, and this dictionary is the only source of the words.
const HEBREW = /[א-ת]/;

/** The params each code carries (see the comment on `aiReadinessMessages`); a message may use only these. */
const PARAMS: Record<(typeof AI_READINESS_ISSUE_CODES)[number], string[]> = {
  noRowsMatched: [],
  inputColumnsTooMany: ['count', 'limit'],
  outputColumnsTooMany: ['count', 'limit'],
  payloadTooLarge: ['kb', 'limitKb'],
};

function placeholders(text: string): string[] {
  return [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!);
}

describe('AI readiness codes and messages', () => {
  it('has a message for exactly the codes the gate can return', () => {
    expect(Object.keys(aiReadinessMessages).sort()).toEqual([...AI_READINESS_ISSUE_CODES].sort());
    expect(Object.keys(PARAMS).sort()).toEqual([...AI_READINESS_ISSUE_CODES].sort());
  });

  it('has clear he and en text for every code: Hebrew in he, none in en', () => {
    for (const code of AI_READINESS_ISSUE_CODES) {
      const m = aiReadinessMessages[code];
      expect(m.en.length, code).toBeGreaterThan(30);
      expect(m.he.length, code).toBeGreaterThan(30);
      expect(HEBREW.test(m.he), `${code} he`).toBe(true);
      expect(HEBREW.test(m.en), `${code} en`).toBe(false);
    }
  });

  it('every placeholder is a param the code carries, in both languages, and both languages use the same ones', () => {
    for (const code of AI_READINESS_ISSUE_CODES) {
      const m = aiReadinessMessages[code];
      expect(placeholders(m.en).sort(), `${code} en`).toEqual(placeholders(m.he).sort());
      for (const p of placeholders(m.en)) expect(PARAMS[code], `${code}: {${p}}`).toContain(p);
    }
  });

  it('says what to fix: the blocking messages are actionable ("try again")', () => {
    for (const code of ['noRowsMatched', 'inputColumnsTooMany', 'outputColumnsTooMany', 'payloadTooLarge'] as const) {
      expect(aiReadinessMessages[code].en, code).toMatch(/try again/i);
    }
  });

  it('has a he and en message for every part the local result can leave to the AI step', () => {
    expect(Object.keys(aiStepPartMessages).sort()).toEqual([...AI_STEP_PART_CODES].sort());
    for (const code of AI_STEP_PART_CODES) {
      expect(aiStepPartMessages[code].en.length, code).toBeGreaterThan(5);
      expect(HEBREW.test(aiStepPartMessages[code].he), code).toBe(true);
    }
  });
});

describe('matching config (SPEC 8.12, DECISION 10)', () => {
  const m = limits.matching;

  it('auto-picks at 0.9 with a 0.1 margin', () => {
    expect(m.autoScore).toBe(0.9);
    expect(m.autoMargin).toBe(0.1);
  });

  it('the extra-column penalty is small: a file with every required column can still be picked automatically', () => {
    expect(m.extraColumnPenalty).toBeGreaterThan(0);
    expect(m.maxExtraPenalty).toBeGreaterThanOrEqual(m.extraColumnPenalty);
    expect(1 - m.maxExtraPenalty).toBeGreaterThanOrEqual(m.autoScore);
  });

  it('offers the top 3, and some renamed-column candidates above a minimum similarity', () => {
    expect(m.maxSuggestions).toBe(3);
    expect(m.maxRenamedCandidates).toBeGreaterThan(0);
    expect(m.minRenamedSimilarity).toBeGreaterThan(0);
    expect(m.minRenamedSimilarity).toBeLessThan(1);
  });
});
