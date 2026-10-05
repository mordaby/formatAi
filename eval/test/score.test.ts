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

/** The AI step reported `codes` as unsupported, and everything it produced matches the example (the learn is checked on the columns that have a rule). */
function unsupportedResult(codes: string[]): LearnFromExamplesResult {
  return {
    path: 'llm',
    preflight: { status: 'ok', issues: [], skipColumns: [] },
    rules: { output: {} } as never,
    verification: { verified: true, matched: 5, total: 5, mismatches: [], layoutProblems: [],
    layoutIssues: [], repairProblems: [] },
    assumptions: [],
    unsupported: codes.map((reasonCode) => ({ outputColumn: 'x', reasonCode: reasonCode as never })),
    calls: [],
    stages: stages({ llmCalled: true }),
  };
}

/** An old-style run: the column was routed to skipColumns by pre-flight and the LLM never reported it (no longer how an external column is handled). */
function skipColumnResult(): LearnFromExamplesResult {
  return {
    path: 'llm',
    preflight: { status: 'warn', issues: [{ code: 'unknownOutputColumns' as never, severity: 'warn' }], skipColumns: [3] },
    rules: { output: {} } as never,
    verification: { verified: true, matched: 5, total: 5, mismatches: [], layoutProblems: [],
    layoutIssues: [], repairProblems: [] },
    assumptions: [],
    unsupported: [],
    calls: [],
    stages: stages({ llmCalled: true, verifiedFirstCall: true, verifiedAfterRepair: true }),
  };
}

/** The AI step's own report for an external column: the LLM was asked (nothing in skipColumns) and answered unsupported externalData. */
function reportedExternalResult(): LearnFromExamplesResult {
  return {
    path: 'llm',
    preflight: { status: 'ok', issues: [{ code: 'unknownOutputColumns' as never, severity: 'info' }], skipColumns: [] },
    rules: { output: {} } as never,
    verification: { verified: true, matched: 5, total: 5, mismatches: [], layoutProblems: [], layoutIssues: [], repairProblems: [] },
    assumptions: [],
    unsupported: [{ outputColumn: 'Assigned Warehouse', reasonCode: 'externalData' }],
    calls: [],
    stages: stages({ llmCalled: true, verifiedFirstCall: true, verifiedAfterRepair: true }),
  };
}

/** Reported as unsupported, but a column it DID produce does not match the example: the rest does not verify. */
function reportedExternalButWrongResult(): LearnFromExamplesResult {
  return {
    ...reportedExternalResult(),
    verification: { verified: false, matched: 3, total: 5, mismatches: [{ exampleRow: 2, column: 'Qty', expected: 1, actual: 2 }], layoutProblems: [], layoutIssues: [], repairProblems: [] },
    stages: stages({ llmCalled: true }),
  };
}

/** Every column reported as unsupported: nothing was produced, so nothing was checked (0 of 0, never verified). */
function allUnsupportedResult(): LearnFromExamplesResult {
  return {
    ...reportedExternalResult(),
    verification: { verified: false, matched: 0, total: 0, mismatches: [], layoutProblems: [], layoutIssues: [], repairProblems: [] },
    unsupported: [
      { outputColumn: 'Assigned Warehouse', reasonCode: 'externalData' },
      { outputColumn: 'Qty', reasonCode: 'externalData' },
    ],
  };
}

/** Completion mode: the AI step answered the listed column as unsupported externalData; the lock held and the rest matches. */
function completionExternalResult(over: Partial<NonNullable<LearnFromExamplesResult['completion']>> = {}): LearnFromExamplesResult {
  return {
    ...reportedExternalResult(),
    // (the full verification still differs on the column that has no rule: the completion verdict is what counts)
    verification: { verified: false, matched: 0, total: 5, mismatches: [], layoutProblems: [], layoutIssues: [], repairProblems: [] },
    completion: { columns: [2], parts: [], fixedProblems: [], matches: true, produced: { columns: 0, parts: 0 }, ...over },
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
  it('classifies an unsupported column (the learn verified on what it produced)', () => {
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
  it('is met when the LLM reports the column as unsupported externalData (it no longer comes from skipColumns: the LLM was asked about it)', () => {
    const r = reportedExternalResult();
    expect(r.preflight.skipColumns).toEqual([]);
    expect(expectationMet(metaUnsupported, false, r, classify(r))).toBe(true);
  });
  it('is NOT met when a column the AI step did produce does not match the example, however it reported the external one', () => {
    const r = reportedExternalButWrongResult();
    expect(classify(r)).toEqual({ kind: 'unsupported', codes: ['externalData'] });
    expect(expectationMet(metaUnsupported, false, r, classify(r))).toBe(false);
  });
  it('is NOT met when EVERY column is reported unsupported: no value was produced', () => {
    const r = allUnsupportedResult();
    expect(expectationMet(metaUnsupported, false, r, classify(r))).toBe(false);
  });
  it('completion mode: met when the column is answered unsupported externalData, the lock held and the rest matches', () => {
    const r = completionExternalResult();
    expect(expectationMet(metaUnsupported, false, r, classify(r))).toBe(true);
  });
  it('completion mode: not met when the lock was broken, or the rest does not match', () => {
    for (const over of [{ fixedProblems: [{ path: 'output.columns[0].from', message: 'changed' }] }, { matches: false }]) {
      const r = completionExternalResult(over as never);
      expect(expectationMet(metaUnsupported, false, r, classify(r))).toBe(false);
    }
  });
  it('is NOT met by a skipColumns list alone: only the AI step\'s own report counts', () => {
    const r = skipColumnResult();
    expect(expectationMet(metaUnsupported, false, r, classify(r))).toBe(false);
  });
  it('is not met when unsupported does not mention it', () => {
    const r = verifiedResult();
    expect(expectationMet(metaUnsupported, false, r, classify(r))).toBe(false);
  });
  it('is not met by a different unsupported code', () => {
    const r = unsupportedResult(['pivot']);
    expect(expectationMet(metaUnsupported, false, r, classify(r))).toBe(false);
  });
  it('a column the case\'s own answer took out ("a one-time edit" to its copied list, reported overfit by code) is the expected report; the guards\' overfit is not', () => {
    const r: LearnFromExamplesResult = { ...reportedExternalResult(), unsupported: [{ outputColumn: 'Assigned Warehouse', reasonCode: 'overfit' }] };
    expect(classificationLabel(classify(r))).toBe('unsupported:overfit');
    expect(expectationMet(metaUnsupported, false, r, classify(r), ['Assigned Warehouse'])).toBe(true);
    expect(expectationMet(metaUnsupported, false, r, classify(r))).toBe(false);
    expect(expectationMet(metaUnsupported, false, r, classify(r), ['Qty'])).toBe(false);
    // ... and the rest must still match.
    const wrong: LearnFromExamplesResult = { ...reportedExternalButWrongResult(), unsupported: r.unsupported };
    expect(expectationMet(metaUnsupported, false, wrong, classify(wrong), ['Assigned Warehouse'])).toBe(false);
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
