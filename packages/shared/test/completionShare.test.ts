import { describe, expect, it } from 'vitest';
import { fixedColumnShare } from '../src/completion';

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
  it('ignores columns no rule can fill (skipColumns, external data)', () => {
    expect(fixedColumnShare(rules(['a', null, null], ['C2']), { skipColumns: [1] })).toBe(1);
  });
  it('is 1 when nothing can be counted', () => {
    expect(fixedColumnShare(rules([null], ['C0']))).toBe(1);
  });
});
