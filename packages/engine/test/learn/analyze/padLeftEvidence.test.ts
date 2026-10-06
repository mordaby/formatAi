// "Pad to a length" needs an example that shows a length (found by the engine stress test, eval/STRESS.md). When every input text has
// the same length, padding it to a fixed length with "X" and putting a fixed "X" in front write the same output - but not next month,
// when a shorter code comes ("XXREF/3780"). A letter (or any character but "0") pads only when the example pads by different amounts;
// zeros keep padding an ID to its length, the usual meaning of leading zeros.
import { describe, expect, it } from 'vitest';
import { fastPath } from '../../../src/learn/fastPath';
import { preflight } from '../../../src/learn/preflight';
import { analyzeOk, findRel, xlsx, type V } from './helpers';

const N = 12;

function pair(input: string[], output: string[]) {
  const inRows: V[][] = [['Ref', 'Code'], ...input.map((c, i) => [`R${100 + i}`, c])];
  const outRows: V[][] = [['Ref', 'Out'], ...output.map((c, i) => [`R${100 + i}`, c])];
  return analyzeOk(xlsx(inRows), xlsx(outRows));
}

describe('padLeft: the example must show the length it pads to', () => {
  it('codes of one length, a fixed "X" in front: a template, never "pad with X to 10"', () => {
    const codes = Array.from({ length: N }, (_, i) => `REF/${String(10000 + i * 7919).slice(0, 5)}`);
    const a = pair(codes, codes.map((c) => `X${c}`));
    expect(findRel(a, 1, 'padLeft')).toBeUndefined();
    const fp = fastPath(a, preflight(a, 'paid'));
    if (!('rules' in fp)) throw new Error(`fastPath refused: ${JSON.stringify(fp)}`);
    const computed = fp.rules.transform.computed.find((c) => c.id === fp.rules.output.columns[1]!.from);
    expect(computed?.expr).toMatchObject({ op: 'concat' });
  });

  it('codes of several lengths padded with "*" to one length: padLeft', () => {
    const codes = Array.from({ length: N }, (_, i) => String(7 + i * 131).slice(0, 1 + (i % 4)));
    const a = pair(codes, codes.map((c) => c.padStart(6, '*')));
    expect(findRel(a, 1, 'padLeft')).toMatchObject({ length: 6, char: '*', coverage: 1 });
  });

  it('IDs of one length padded with zeros: still padLeft (leading zeros pad an ID to its length)', () => {
    const ids = Array.from({ length: N }, (_, i) => String(123456 + i * 7919).slice(0, 6));
    const a = pair(ids, ids.map((c) => c.padStart(9, '0')));
    expect(findRel(a, 1, 'padLeft')).toMatchObject({ length: 9, char: '0', coverage: 1 });
  });
});
