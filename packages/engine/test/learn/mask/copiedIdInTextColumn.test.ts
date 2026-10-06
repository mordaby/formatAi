// Found by the engine stress test (eval/STRESS.md): an output column that copies an ID column is masked like it (maskTypes.ts) - but only
// when the profile typed it as a number. One that the profile calls text - a copy with a word on a row or two ("n/a"), or a header row
// read as data - kept `text`, and a number in a text column is sent real: the customer numbers went to the AI in the samples' `out`
// while their `in` was masked. Now an output column that copies an ID column is masked as `idLike` whatever its profile type, so `in`
// and `out` carry the same fake (words in it are still masked as words).
import { describe, expect, it } from 'vitest';
import { createMasker } from '../../../src/learn/mask';
import { maskTypes } from '../../../src/learn/maskTypes';
import { analyzeOk, xlsx, type V } from '../analyze/helpers';

const N = 20;
const CUSTOMERS = Array.from({ length: N }, (_, i) => 115046100 + i * 7919);

describe('an output column that copies an ID column is masked as an ID, whatever its profile type', () => {
  it('a copy with "n/a" on one row (profiled text): the numbers get the input\'s fakes', () => {
    const input: V[][] = [['City', 'Customer No'], ...CUSTOMERS.map((c, i) => [['Austin', 'Dallas', 'Denver'][i % 3]!, c])];
    const output: V[][] = [['Customer', 'City'], ...CUSTOMERS.map((c, i) => [i === 4 ? 'n/a' : c, ['Austin', 'Dallas', 'Denver'][i % 3]!])];
    const a = analyzeOk(xlsx(input), xlsx(output));
    expect(a.output.profile[0]!.type).toBe('text'); // the setup
    const types = maskTypes(a);
    expect(types.input[1]).toBe('idLike');
    expect(types.output[0]).toBe('idLike');
    const masker = createMasker(new TextEncoder().encode('copied-id'));
    const fakeIn = masker.maskCell(CUSTOMERS[0]!, types.input[1]!);
    expect(fakeIn).not.toBe(CUSTOMERS[0]);
    expect(masker.maskCell(CUSTOMERS[0]!, types.output[0]!)).toBe(fakeIn);
    expect(masker.maskCell('n/a', types.output[0]!)).toBe('n/a');
  });
});
