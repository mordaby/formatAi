// Found by the engine stress test (eval/STRESS.md): a 15,000-row file with long Hebrew notes took 15 s to learn, 9 of them in
// `normalizeCase` - the case change of a candidate "normalize" relation was worked out by normalizing every row of every text input
// column again, for every output column, even on rows whose texts differ beyond case (the memo of normalized texts overflowed and was
// cleared over and over). Rows are now skipped on the cached normalized texts first. Counted, not timed (CI load varies): the texts
// normalized grow with the columns, not with input columns times output columns.
import { describe, expect, it, vi } from 'vitest';
import { analyzePair } from '../../../src/learn/analyze';
import { pick, rng, xlsx, type V } from './helpers';

const counter = vi.hoisted(() => ({ calls: 0 }));
vi.mock('../../../src/values/text', async (importOriginal) => {
  const m = await importOriginal<typeof import('../../../src/values/text')>();
  return {
    ...m,
    normalizeText: (...args: Parameters<typeof m.normalizeText>) => {
      counter.calls++;
      return m.normalizeText(...args);
    },
  };
});

const ROWS = 5000;
const COLS = 8;
const WORDS = ['הזמנה', 'לקוח', 'משלוח', 'חשבונית', 'מחסן', 'דחוף', 'ספק', 'תשלום', 'החזרה', 'סניף', 'אושר', 'פגום', 'מלאי', 'צפון', 'דרום'];

describe('pair analysis: many long text columns', () => {
  it(`normalizes each text about once, not once per output column (${ROWS} rows, ${COLS} note columns in, ${COLS} unrelated out)`, () => {
    const r = rng(7);
    const note = (i: number, c: number): string => `${Array.from({ length: 14 }, () => pick(r, WORDS)).join(' ')} ${i}-${c}`;
    const input: V[][] = [['Id', ...Array.from({ length: COLS }, (_, c) => `Note ${c + 1}`)]];
    const output: V[][] = [['Id', ...Array.from({ length: COLS }, (_, c) => `Other ${c + 1}`)]];
    for (let i = 0; i < ROWS; i++) {
      input.push([`R${100000 + i}`, ...Array.from({ length: COLS }, (_, c) => note(i, c))]);
      output.push([`R${100000 + i}`, ...Array.from({ length: COLS }, (_, c) => note(i, c + COLS))]);
    }
    counter.calls = 0;
    const t0 = performance.now();
    const res = analyzePair(xlsx(input), xlsx(output));
    console.log(`[perf] long notes: ${ROWS} rows x ${COLS + 1} columns in ${(performance.now() - t0).toFixed(0)} ms, ${counter.calls} texts normalized`);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.columns.slice(1).every((c) => c.unknown)).toBe(true);
    // Each of the 2 x 8 x 5,000 note cells a few times at most (80,000 x 3); every input column for every output column was 640,000.
    expect(counter.calls).toBeLessThan(240_000);
  }, 120000);
});
