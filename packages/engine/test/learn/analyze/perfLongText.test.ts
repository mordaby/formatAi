// Found by the engine stress test (eval/STRESS.md): a 15,000-row file with long Hebrew notes took 15 s to learn, 9 of them in
// `normalizeCase` - the case change of a candidate "normalize" relation was worked out by normalizing every row of every text input
// column again, for every output column, even on rows whose texts differ beyond case. Rows are now skipped on the cached normalized
// texts first. The assertion is generous so CI isn't flaky; the actual time is printed.
import { describe, expect, it } from 'vitest';
import { analyzePair } from '../../../src/learn/analyze';
import { pick, rng, xlsx, type V } from './helpers';

const ROWS = 15000;
const WORDS = ['הזמנה', 'לקוח', 'משלוח', 'חשבונית', 'מחסן', 'דחוף', 'ספק', 'תשלום', 'החזרה', 'סניף', 'אושר', 'פגום', 'מלאי', 'צפון', 'דרום'];

describe('pair analysis performance: many long text columns', () => {
  it(`analyzes ${ROWS} rows of long notes (8 text columns in, 8 unrelated text columns out) quickly`, () => {
    const r = rng(7);
    const note = (i: number, c: number): string => `${Array.from({ length: 14 }, () => pick(r, WORDS)).join(' ')} ${i}-${c}`;
    const input: V[][] = [['Id', ...Array.from({ length: 8 }, (_, c) => `Note ${c + 1}`)]];
    const output: V[][] = [['Id', ...Array.from({ length: 8 }, (_, c) => `Other ${c + 1}`)]];
    for (let i = 0; i < ROWS; i++) {
      input.push([`R${100000 + i}`, ...Array.from({ length: 8 }, (_, c) => note(i, c))]);
      output.push([`R${100000 + i}`, ...Array.from({ length: 8 }, (_, c) => note(i, c + 8))]);
    }
    const t0 = performance.now();
    const res = analyzePair(xlsx(input), xlsx(output));
    const ms = performance.now() - t0;
    console.log(`[perf] long notes: ${ROWS} rows x 9 columns in ${ms.toFixed(0)} ms`);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.columns.slice(1).every((c) => c.unknown)).toBe(true);
    expect(ms).toBeLessThan(6000); // ~2 s; 8+ s before
  }, 120000);
});
