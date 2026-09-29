import { describe, expect, it } from 'vitest';
import { analyzeOk, pick, rng, xlsx, type V } from './helpers';

const STATES = ['open', 'done', 'cancelled'];

describe('dropped rows: filters', () => {
  it('a set of values', () => {
    const input: V[][] = [['Ref', 'State', 'Amount']];
    const output: V[][] = [['Ref', 'Amount']];
    const r = rng(1);
    const dropped: number[] = [];
    for (let i = 0; i < 30; i++) {
      const st = i < 3 ? STATES[i]! : pick(r, STATES);
      input.push([`K${i}`, st, 10 + i]);
      if (st === 'cancelled') dropped.push(i);
      else output.push([`K${i}`, 10 + i]);
    }
    const a = analyzeOk(xlsx(input), xlsx(output));
    expect(a.dropped.rows).toEqual(dropped);
    expect(a.dropped.dedupe).toBeNull();
    expect(a.dropped.filters[0]).toMatchObject({ rel: 'filter', in: [1], droppedValues: ['cancelled'], coverage: 1, failing: [] });
    expect(a.dropped.filters[0]!.keptValues?.sort()).toEqual(['done', 'open']);
    expect(a.dropped.unexplained).toEqual([]);
  });

  it('emptiness', () => {
    const input: V[][] = [['Name', 'Contact', 'Score']];
    const output: V[][] = [['Name', 'Contact']];
    for (let i = 0; i < 20; i++) {
      const contact = i % 4 === 1 ? null : `c${i}@example.test`;
      input.push([`name ${i}`, contact, (i * 7) % 11]);
      if (contact !== null) output.push([`name ${i}`, contact]);
    }
    const a = analyzeOk(xlsx(input), xlsx(output));
    expect(a.dropped.filters[0]).toMatchObject({ in: [1], droppedWhen: { op: 'isEmpty' }, coverage: 1 });
  });

  it('a numeric threshold (reported on the round side of the gap)', () => {
    const input: V[][] = [['Lot', 'Weight']];
    const output: V[][] = [['Lot', 'Weight']];
    const r = rng(2);
    for (let i = 0; i < 40; i++) {
      const w = Math.round(r() * 200 * 10) / 10;
      input.push([`L${i}`, w]);
      if (w >= 100) output.push([`L${i}`, w]);
    }
    // Make sure the smallest kept weight is exactly 100 and a dropped one is close below.
    input.push(['L-edge', 100]);
    output.push(['L-edge', 100]);
    input.push(['L-under', 99.9]);
    const a = analyzeOk(xlsx(input), xlsx(output));
    expect(a.dropped.filters.find((f) => f.droppedWhen?.op === 'lt')).toMatchObject({
      in: [1],
      droppedWhen: { op: 'lt', value: 100 },
      coverage: 1,
    });
  });

  it('a date threshold', () => {
    const input: V[][] = [['Doc', 'Posted']];
    const output: V[][] = [['Doc']];
    for (let i = 0; i < 20; i++) {
      const day = 1 + i;
      input.push([`D${i}`, `${String(day).padStart(2, '0')}/03/2024`]);
      if (day > 10) output.push([`D${i}`]);
    }
    const a = analyzeOk(xlsx(input), xlsx(output));
    expect(a.dropped.filters.find((f) => f.in[0] === 1)).toMatchObject({ droppedWhen: { op: 'lt', value: '2024-03-11' }, coverage: 1 });
  });

  it('partial filter: coverage and failing rows', () => {
    const input: V[][] = [['Ref', 'State']];
    const output: V[][] = [['Ref']];
    for (let i = 0; i < 30; i++) {
      const st = STATES[i % 3]!;
      input.push([`K${i}`, st]);
      // Row 4 ("done") is dropped too, against the rule.
      if (st !== 'cancelled' && i !== 4) output.push([`K${i}`]);
    }
    const a = analyzeOk(xlsx(input), xlsx(output), { minCoverage: 0.9 });
    const f = a.dropped.filters[0]!;
    expect(f).toMatchObject({ in: [1], droppedValues: ['cancelled'], failing: [4], failCount: 1 });
    expect(f.coverage).toBeCloseTo(29 / 30);
    expect(a.dropped.unexplained).toEqual([4]);
  });
});

describe('dropped rows: dedupe', () => {
  function rows(): [string, string, number][] {
    return [
      ['A1', 'north', 10],
      ['B2', 'south', 20],
      ['C3', 'east', 30],
      ['D4', 'west', 40],
      ['E5', 'north', 50],
    ];
  }

  it('copies on every column, keep first', () => {
    const base = rows();
    const input: V[][] = [['Code', 'Zone', 'Qty'], ...base, base[1]!, base[3]!];
    const output: V[][] = [['Code', 'Zone', 'Qty'], ...base];
    const a = analyzeOk(xlsx(input), xlsx(output));
    expect(a.dropped.rows).toEqual([5, 6]);
    expect(a.dropped.dedupe).toMatchObject({ keys: 'all', keep: 'first', coverage: 1 });
    expect(a.dropped.dedupe?.duplicates).toEqual([
      { row: 5, of: 1 },
      { row: 6, of: 3 },
    ]);
    expect(a.dropped.filters).toEqual([]);
    expect(a.dropped.unexplained).toEqual([]);
  });

  it('copies on every column, keep last', () => {
    const base = rows();
    // B2 appears first at row 0 and again at row 3; the output keeps the later copy.
    const input: V[][] = [['Code', 'Zone', 'Qty'], base[1]!, base[0]!, base[2]!, base[1]!, base[3]!, base[4]!];
    const output: V[][] = [['Code', 'Zone', 'Qty'], base[0]!, base[2]!, base[1]!, base[3]!, base[4]!];
    const a = analyzeOk(xlsx(input), xlsx(output));
    expect(a.dropped.rows).toEqual([0]);
    expect(a.dropped.dedupe).toMatchObject({ keys: 'all', keep: 'last', duplicates: [{ row: 0, of: 3 }] });
  });

  it('copies on a key column (other columns differ), keep first and keep last', () => {
    const base = rows();
    const input: V[][] = [['Code', 'Zone', 'Qty'], ...base, ['B2', 'south', 99], ['E5', 'north', 77]];
    const keepFirst: V[][] = [['Code', 'Zone', 'Qty'], ...base];
    const a = analyzeOk(xlsx(input), xlsx(keepFirst));
    expect(a.dropped.dedupe).toMatchObject({ keys: [0], keep: 'first', coverage: 1 });

    const keepLast: V[][] = [['Code', 'Zone', 'Qty'], base[0]!, base[2]!, base[3]!, ['B2', 'south', 99], ['E5', 'north', 77]];
    const b = analyzeOk(xlsx(input), xlsx(keepLast));
    expect(b.dropped.rows).toEqual([1, 4]);
    expect(b.dropped.dedupe).toMatchObject({ keys: [0], keep: 'last', coverage: 1 });
    expect(b.dropped.dedupe?.duplicates).toEqual([
      { row: 1, of: 5 },
      { row: 4, of: 6 },
    ]);
  });

  it('dedupe and a filter together', () => {
    const base = rows();
    const input: V[][] = [['Code', 'Zone', 'Qty'], ...base, base[2]!, ['F6', 'void', 60], ['G7', 'void', 70]];
    const output: V[][] = [['Code', 'Zone', 'Qty'], ...base];
    const a = analyzeOk(xlsx(input), xlsx(output));
    expect(a.dropped.dedupe).toMatchObject({ keys: 'all', duplicates: [{ row: 5, of: 2 }] });
    expect(a.dropped.filters[0]).toMatchObject({ in: [1], droppedValues: ['void'], coverage: 1 });
    expect(a.dropped.unexplained).toEqual([]);
  });
});
