import { describe, expect, it } from 'vitest';
import { completionPlan, fixedColumnShare } from '../src/completion';

const rules = (froms: (string | null)[], external: string[] = []) =>
  ({
    output: { columns: froms.map((from, i) => ({ header: `C${i}`, from })) },
    unsupported: external.map((outputColumn) => ({ outputColumn, reasonCode: 'externalData' })),
  }) as never;

describe('fixedColumnShare (Finish with the AI step: complete vs full learn)', () => {
  it('counts columns that already have a rule', () => {
    expect(fixedColumnShare(rules(['a', 'b', null, null]))).toBe(0.5);
    expect(fixedColumnShare(rules([null, null, null, null, null]))).toBe(0);
  });
  it('counts a column no rule explains (external data, or one an answer reported as externalData) as one the AI step could fill', () => {
    expect(fixedColumnShare(rules(['a', null, null], ['C2']))).toBeCloseTo(1 / 3);
    expect(fixedColumnShare(rules(['a', 'b', 'c', null], ['C3']))).toBe(0.75);
  });
  it('is 1 when there are no columns', () => {
    expect(fixedColumnShare(rules([]))).toBe(1);
  });
});

describe('completionPlan (what the AI step is asked for)', () => {
  it('asks for EVERY column with no rule, whatever the unsupported list says (externalData included)', () => {
    expect(completionPlan(rules(['a', null, null, 'd'], ['C2'])).columns).toEqual([1, 2]);
    expect(completionPlan(rules(['a', 'b'])).columns).toEqual([]);
  });
});
