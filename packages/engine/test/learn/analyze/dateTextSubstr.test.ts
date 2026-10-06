// A part of a date written as text is a whole day, month or year (found by the engine stress test, eval/STRESS.md). The month of
// "17/06/2026" as a number ("6") is the text's 5th character on every row of an example whose months are 1-9: the free engine wrote
// `substr(date, 5, 1)`, verified, and wrote "0" for October. A cut inside a run of digits of a text date is never a candidate; a whole
// part (the year) still is.
import { describe, expect, it } from 'vitest';
import { analyzeOk, delimited, findRel, type V } from './helpers';

const N = 12;
const dateText = (i: number): string => `${String(1 + ((i * 7) % 28)).padStart(2, '0')}/0${1 + (i % 9)}/${2024 + (i % 3)}`;

function pair(out: (i: number) => string) {
  const inRows: V[][] = [['Ref', 'Delivered'], ...Array.from({ length: N }, (_, i) => [`R${100 + i}`, dateText(i)])];
  const outRows: V[][] = [['Ref', 'Part'], ...Array.from({ length: N }, (_, i) => [`R${100 + i}`, out(i)])];
  return analyzeOk(delimited(inRows, 'csv'), delimited(outRows, 'csv'));
}

describe('substr on a date written as text: whole parts only', () => {
  it('the month without its zero (months 1-9 only) is not "the 5th character"', () => {
    const a = pair((i) => String(1 + (i % 9)));
    expect(findRel(a, 1, 'substr')).toBeUndefined();
  });

  it('the year is still a substr', () => {
    const a = pair((i) => String(2024 + (i % 3)));
    expect(findRel(a, 1, 'substr')).toMatchObject({ coverage: 1 });
  });
});
