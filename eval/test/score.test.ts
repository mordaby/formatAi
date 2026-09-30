import { describe, expect, it } from 'vitest';
import type { LearnFromExamplesResult } from '@formatai/engine';
import type { CaseMeta } from '../lib/caseLoader.js';
import { classify, classificationLabel, expectationMet } from '../lib/score.js';

function stages(overrides: Partial<LearnFromExamplesResult['stages']> = {}): LearnFromExamplesResult['stages'] {
  return {
    preflight: 'ok',
    fastPathTried: false,
    fastPathSucceeded: false,
    llmCalled: false,
    verifiedFirstCall: false,
    browserRepairUsed: false,
    verifiedAfterRepair: false,
    ...overrides,
  };
}

function blockedResult(reason: string): LearnFromExamplesResult {
  return {
    path: 'blocked',
    preflight: { status: 'block', issues: [{ code: reason as never, severity: 'block' }], skipColumns: [] },
    rules: null,
    verification: null,
    assumptions: [],
    unsupported: [],
    calls: [],
    stages: stages({ preflight: 'block' }),
  };
}

function verifiedResult(): LearnFromExamplesResult {
  return {
    path: 'local',
    preflight: { status: 'ok', issues: [], skipColumns: [] },
    rules: { output: {} } as never,
    verification: { verified: true, matched: 5, total: 5, mismatches: [], layoutProblems: [],
    layoutIssues: [], repairProblems: [] },
    assumptions: [],
    unsupported: [],
    calls: [],
    stages: stages({ fastPathTried: true, fastPathSucceeded: true, verifiedFirstCall: true, verifiedAfterRepair: true }),
  };
}

function unsupportedResult(codes: string[]): LearnFromExamplesResult {
  return {
    path: 'llm',
    preflight: { status: 'ok', issues: [], skipColumns: [] },
    rules: { output: {} } as never,
    verification: { verified: false, matched: 4, total: 5, mismatches: [], layoutProblems: [],
    layoutIssues: [], repairProblems: [] },
    assumptions: [],
    unsupported: codes.map((reasonCode) => ({ outputColumn: 'x', reasonCode: reasonCode as never })),
    calls: [],
    stages: stages({ llmCalled: true }),
  };
}

function skipColumnResult(): LearnFromExamplesResult {
  return {
    path: 'llm',
    preflight: { status: 'warn', issues: [{ code: 'unknownOutputColumns' as never, severity: 'warn' }], skipColumns: [3] },
    rules: { output: {} } as never,
    verification: { verified: true, matched: 5, total: 5, mismatches: [], layoutProblems: [],
    layoutIssues: [], repairProblems: [] },
    assumptions: [],
    unsupported: [], // LEARN_PROMPT: skipColumns are never restated in unsupported
    calls: [],
    stages: stages({ llmCalled: true, verifiedFirstCall: true, verifiedAfterRepair: true }),
  };
}

function notVerifiedResult(): LearnFromExamplesResult {
  return {
    path: 'llm',
    preflight: { status: 'ok', issues: [], skipColumns: [] },
    rules: { output: {} } as never,
    verification: { verified: false, matched: 3, total: 5, mismatches: [], layoutProblems: [],
    layoutIssues: [], repairProblems: [] },
    assumptions: [],
    unsupported: [],
    calls: [],
    stages: stages({ llmCalled: true }),
  };
}

function failedResult(): LearnFromExamplesResult {
  return {
    path: 'llm',
    preflight: { status: 'ok', issues: [], skipColumns: [] },
    rules: null,
    verification: null,
    assumptions: [],
    unsupported: [],
    calls: [],
    stages: stages({ llmCalled: true }),
  };
}

describe('classify', () => {
  it('classifies a pre-flight block', () => {
    expect(classify(blockedResult('pivotDetected'))).toEqual({ kind: 'blocked', reason: 'pivotDetected' });
  });
  it('classifies a verified result', () => {
    expect(classify(verifiedResult())).toEqual({ kind: 'verified' });
  });
  it('classifies an unsupported column', () => {
    expect(classify(unsupportedResult(['externalData']))).toEqual({ kind: 'unsupported', codes: ['externalData'] });
  });
  it('classifies rules that never verified and declared nothing unsupported', () => {
    expect(classify(notVerifiedResult())).toEqual({ kind: 'notVerified' });
  });
  it('classifies a total LLM failure (no usable rules)', () => {
    expect(classify(failedResult())).toEqual({ kind: 'failed' });
  });
});

describe('classificationLabel', () => {
  it('renders each classification kind as a stable string', () => {
    expect(classificationLabel({ kind: 'verified' })).toBe('verified');
    expect(classificationLabel({ kind: 'blocked', reason: 'identicalFiles' })).toBe('blocked:identicalFiles');
    expect(classificationLabel({ kind: 'unsupported', codes: ['externalData', 'pivot'] })).toBe('unsupported:externalData+pivot');
    expect(classificationLabel({ kind: 'notVerified' })).toBe('notVerified');
    expect(classificationLabel({ kind: 'failed' })).toBe('failed');
  });
});

const metaVerified: CaseMeta = { difficulty: 'easy', domain: 'x', features: [], expect: 'verified' };
const metaUnsupported: CaseMeta = { difficulty: 'medium', domain: 'x', features: [], expect: 'unsupported:externalData' };
const metaBlocked: CaseMeta = { difficulty: 'hard', domain: 'x', features: [], expect: 'blocked:pivotDetected' };
const metaMaskingPair: CaseMeta = {
  difficulty: 'medium',
  domain: 'x',
  features: [],
  expect: { masking_on: 'unsupported:hiddenByMasking', masking_off: 'verified' },
};

describe('expectationMet: "verified"', () => {
  it('is met by a verified result', () => {
    expect(expectationMet(metaVerified, false, verifiedResult(), classify(verifiedResult()))).toBe(true);
  });
  it('is not met by anything else', () => {
    const r = notVerifiedResult();
    expect(expectationMet(metaVerified, false, r, classify(r))).toBe(false);
  });
});

describe('expectationMet: "blocked:<reason>"', () => {
  it('is met only by a block with the exact matching reason', () => {
    const r = blockedResult('pivotDetected');
    expect(expectationMet(metaBlocked, false, r, classify(r))).toBe(true);
  });
  it('is not met by a block with a different reason', () => {
    const r = blockedResult('identicalFiles');
    expect(expectationMet(metaBlocked, false, r, classify(r))).toBe(false);
  });
});

describe('expectationMet: "unsupported:<code>"', () => {
  it('is met when the code appears in rules.unsupported', () => {
    const r = unsupportedResult(['externalData']);
    expect(expectationMet(metaUnsupported, false, r, classify(r))).toBe(true);
  });
  it('is met when the column was a preflight skipColumn instead (never restated in unsupported)', () => {
    const r = skipColumnResult();
    expect(expectationMet(metaUnsupported, false, r, classify(r))).toBe(true);
  });
  it('is not met when neither unsupported nor skipColumns mention it', () => {
    const r = verifiedResult();
    expect(expectationMet(metaUnsupported, false, r, classify(r))).toBe(false);
  });
  it('is not met by a different unsupported code', () => {
    const r = unsupportedResult(['pivot']);
    expect(expectationMet(metaUnsupported, false, r, classify(r))).toBe(false);
  });
});

describe('expectationMet: the masking_on/masking_off object form', () => {
  it('picks masking_on when the run masked, masking_off otherwise', () => {
    const onResult = unsupportedResult(['hiddenByMasking']);
    expect(expectationMet(metaMaskingPair, true, onResult, classify(onResult))).toBe(true);
    expect(expectationMet(metaMaskingPair, false, onResult, classify(onResult))).toBe(false);

    const offResult = verifiedResult();
    expect(expectationMet(metaMaskingPair, false, offResult, classify(offResult))).toBe(true);
    expect(expectationMet(metaMaskingPair, true, offResult, classify(offResult))).toBe(false);
  });
});
