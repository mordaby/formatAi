// SPEC 6.2 "Speed on large files": candidate relations are tested on a seeded
// random 2,000 aligned rows first, then the survivors are confirmed on all rows.
// Target: a 20,000-row pair with 15 columns in < 3 s in Node. The assertion is
// generous so CI isn't flaky; the actual time is printed.
import { describe, expect, it } from 'vitest';
import { analyzePair } from '../../../src/learn/analyze';
import type { AnalysisProgress } from '../../../src/learn/analyze';
import { formatYmd, serialToYmd } from '../../../src/values/dates';
import { padLeft } from '../../../src/values/text';
import { analyzeOk, best, dec, pick, rng, serial, xlsx, type V } from './helpers';

const ROWS = 20000;
const CATS = ['north', 'south', 'east', 'west', 'central', 'coast', 'hills', 'valley'];
const STATUS = ['open', 'done', 'void'];
const MAP: Record<string, string> = { open: 'O', done: 'D' };

function bigPair() {
  const r = rng(2024);
  const input: V[][] = [
    ['Id', 'Code', 'Name', 'Area', 'Status', 'Qty', 'Price', 'Rate', 'Start', 'Due', 'Ref', 'Note', 'Fee', 'Tax', 'Batch'],
  ];
  const output: V[][] = [
    ['Ref', 'Label', 'AREA', 'St', 'Id', 'Gross', 'Total', 'Start', 'Due', 'Prefix', 'Source', 'All in', 'Fee+1', 'Price text', 'Ext'],
  ];
  for (let i = 0; i < ROWS; i++) {
    const code = `${pick(r, ['AB', 'CD', 'EF', 'GH'])}-${10000 + i}`;
    const name = `name${i % 997}`;
    const area = pick(r, CATS);
    const status = pick(r, STATUS);
    const qty = 1 + Math.floor(r() * 50);
    const price = Math.round((1 + r() * 900) * 100) / 100;
    const rate = pick(r, [0.1, 0.17, 0.2]);
    const s = serial(2024, 1 + (i % 12), 1 + (i % 28));
    const dueD = 1 + ((i * 7) % 28);
    const dueM = 1 + ((i * 5) % 12);
    const due = `${String(dueD).padStart(2, '0')}/${String(dueM).padStart(2, '0')}/2025`;
    const ref = 100 + i * 3;
    const fee = Math.round(r() * 500) / 10;
    const tax = Math.round(r() * 300) / 10;
    input.push([i + 1, code, name, area, status, qty, price, rate, { v: s, isDate: true, z: 'dd/mm/yyyy' }, due, ref, `note ${i}`, fee, tax, `b${i % 40}`]);
    if (status === 'void') continue;
    output.push([
      padLeft(String(ref), 8, '0'),
      `${name} ${code}`,
      area.toUpperCase(),
      MAP[status]!,
      i + 1,
      dec(price).times(1.17).toDecimalPlaces(2, 4).toNumber(),
      dec(qty).times(price).toNumber(),
      formatYmd(serialToYmd(s), 'DD/MM/YYYY', 'en'),
      { v: serial(2025, dueM, dueD), isDate: true, z: 'dd/mm/yyyy' },
      code.slice(0, 2),
      'IMPORT',
      dec(price).plus(fee).plus(tax).toNumber(),
      dec(fee).plus(1).toNumber(),
      dec(price).toFixed(2),
      Math.floor(r() * 1e6),
    ]);
  }
  return { input: xlsx(input), output: xlsx(output) };
}

describe('pair analysis performance', () => {
  it(`analyzes a ${ROWS}-row, 15-column pair quickly, with progress`, () => {
    const { input, output } = bigPair();
    const progress: AnalysisProgress[] = [];
    const t0 = performance.now();
    const res = analyzePair(input, output, { onProgress: (p) => progress.push(p) });
    const ms = performance.now() - t0;
    console.log(`[perf] pair analysis: ${ROWS} rows x 15 columns in ${ms.toFixed(0)} ms`);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const a = res;
    expect(a.sample.size).toBe(2000);
    expect(a.alignment.rows.length).toBe(a.output.dataRows.length);
    expect(best(a, 0)).toMatchObject({ rel: 'padLeft', in: [10], length: 8, coverage: 1 });
    expect(best(a, 1)).toMatchObject({ rel: 'concat', in: [2, 1], separator: ' ', coverage: 1 });
    expect(best(a, 2)).toMatchObject({ rel: 'normalize', in: [3], case: 'upper', coverage: 1 });
    expect(best(a, 3)).toMatchObject({ rel: 'valueMap', in: [4], coverage: 1 });
    expect(best(a, 4)).toMatchObject({ rel: 'copy', in: [0], coverage: 1 });
    expect(best(a, 5)).toMatchObject({ rel: 'mulConst', in: [6], const: 1.17, round: 2, coverage: 1 });
    expect(best(a, 6)).toMatchObject({ rel: 'mul', in: [5, 6], coverage: 1 });
    expect(best(a, 7)).toMatchObject({ rel: 'dateFormat', in: [8], from: 'date', to: 'DD/MM/YYYY', coverage: 1 });
    expect(best(a, 8)).toMatchObject({ rel: 'dateFormat', in: [9], from: 'DD/MM/YYYY', coverage: 1 });
    expect(best(a, 9)).toMatchObject({ rel: 'substr', in: [1], from: 'start', length: 2, coverage: 1 });
    expect(best(a, 10)).toMatchObject({ rel: 'constant', value: 'IMPORT', coverage: 1 });
    expect(best(a, 11)).toMatchObject({ rel: 'sum', in: [6, 12, 13], coverage: 1 });
    expect(best(a, 12)).toMatchObject({ rel: 'addConst', in: [12], const: 1, coverage: 1 });
    expect(best(a, 13)).toMatchObject({ rel: 'numberFormat', in: [6], format: '0.00', coverage: 1 });
    expect(a.columns[14]!.unknown).toBe(true);
    expect(a.dropped.filters[0]).toMatchObject({ in: [4], droppedValues: ['void'], coverage: 1 });
    expect(progress[0]).toEqual({ stage: 'tables', fraction: 0 });
    expect(progress[progress.length - 1]).toEqual({ stage: 'done', fraction: 1 });
    expect(progress.every((p, i) => i === 0 || p.fraction >= progress[i - 1]!.fraction)).toBe(true);
    expect(ms).toBeLessThan(15000);
  }, 60000);
});

describe('determinism', () => {
  it('the same pair and seed give the same analysis; the sample depends on the seed', () => {
    const input: V[][] = [['K', 'A', 'B']];
    const output: V[][] = [['K', 'A x2', 'B']];
    const r = rng(77);
    for (let i = 0; i < 300; i++) {
      const a = Math.round(r() * 1000) / 10;
      input.push([`k${i}`, a, `b${i % 7}`]);
      output.push([`k${i}`, dec(a).times(2).toNumber(), `b${i % 7}`]);
    }
    const x = analyzeOk(xlsx(input), xlsx(output), { sampleSize: 50, seed: 5 });
    const y = analyzeOk(xlsx(input), xlsx(output), { sampleSize: 50, seed: 5 });
    expect(JSON.stringify(x)).toBe(JSON.stringify(y));
    expect(x.sample).toEqual({ size: 50, seed: 5 });
    expect(best(x, 1)).toMatchObject({ rel: 'mulConst', const: 2, coverage: 1 });
  });
});
