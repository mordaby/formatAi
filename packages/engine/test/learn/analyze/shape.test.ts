import { describe, expect, it } from 'vitest';
import { analyzeOk, best, dec, findRel, pick, rng, xlsx, type V } from './helpers';

describe('families', () => {
  it('columns to rows (skipping empty cells), with a relation on the created value column', () => {
    const input: V[][] = [['Id', 'Owner', 'Jan', 'Feb', 'Mar']];
    const output: V[][] = [['Id', 'Owner', 'Month', 'Amount', 'Amount +10%']];
    const r = rng(4);
    for (let i = 0; i < 12; i++) {
      const cells = [0, 1, 2].map(() => (r() < 0.25 ? null : 10 + Math.floor(r() * 90)));
      if (i === 5) cells.fill(null); // produces no output row at all
      input.push([i + 1, `owner ${i}`, ...cells]);
      ['Jan', 'Feb', 'Mar'].forEach((m, j) => {
        const v = cells[j];
        if (v !== null && v !== undefined) output.push([i + 1, `owner ${i}`, m, v, dec(v).times(1.1).toNumber()]);
      });
    }
    const a = analyzeOk(xlsx(input), xlsx(output));
    expect(a.shape.kind).toBe('families');
    if (a.shape.kind !== 'families') return;
    expect(a.shape.pattern).toEqual({ mode: 'columnsToRows', in: [2, 3, 4], labelOut: 2, valueOut: 3, skipEmpty: true });
    expect(a.shape.created).toEqual([
      { index: 5, kind: 'label' },
      { index: 6, kind: 'value' },
    ]);
    expect(a.dropped.explainedByExpand).toEqual([5]);
    expect(a.dropped.rows).toEqual([]);
    expect(best(a, 2)).toMatchObject({ rel: 'copy', in: [5] });
    expect(best(a, 3)).toMatchObject({ rel: 'copy', in: [6] });
    expect(best(a, 4)).toMatchObject({ rel: 'mulConst', in: [6], const: 1.1 });
  });

  it('split cell, with part index/count and amount / count', () => {
    const input: V[][] = [['Team', 'Ref', 'Tags', 'Amount']];
    const output: V[][] = [['Team', 'Ref', 'Tag', 'Part', 'Parts', 'Share']];
    const tags = ['red', 'green', 'blue', 'amber'];
    const r = rng(6);
    for (let i = 0; i < 15; i++) {
      const n = 1 + Math.floor(r() * 3);
      const mine = tags.slice(0, n);
      const amount = 100 + i * 10;
      input.push([`team ${i % 3}`, `R${i}`, mine.join('; '), amount]);
      mine.forEach((t, j) => output.push([`team ${i % 3}`, `R${i}`, t, j + 1, n, dec(amount).div(n).toDecimalPlaces(2, 4).toNumber()]));
    }
    const a = analyzeOk(xlsx(input), xlsx(output));
    expect(a.shape.kind).toBe('families');
    if (a.shape.kind !== 'families') return;
    expect(a.shape.pattern).toMatchObject({ mode: 'splitCell', in: [2], separator: ';', out: 2 });
    expect(a.shape.created.map((c) => c.kind)).toEqual(['part', 'position', 'count']);
    expect(best(a, 2)).toMatchObject({ rel: 'copy', in: [4] });
    expect(best(a, 3)).toMatchObject({ rel: 'copy', in: [5] });
    expect(best(a, 4)).toMatchObject({ rel: 'copy', in: [6] });
    expect(best(a, 5)).toMatchObject({ rel: 'div', in: [3, 6], round: 2, coverage: 1 });
  });

  it('fixed fan-out with a pattern per position', () => {
    const input: V[][] = [['Ref', 'Amount']];
    const output: V[][] = [['Ref', 'Side', 'Value']];
    for (let i = 0; i < 10; i++) {
      const amt = 50 + i * 7.5;
      input.push([`J${i}`, amt]);
      output.push([`J${i}`, 'debit', amt]);
      output.push([`J${i}`, 'credit', -amt]);
    }
    const a = analyzeOk(xlsx(input), xlsx(output));
    expect(a.shape.kind).toBe('families');
    if (a.shape.kind !== 'families' || a.shape.pattern.mode !== 'fixedFanOut') throw new Error('expected fixedFanOut');
    expect(a.shape.pattern.size).toBe(2);
    const [p1, p2] = a.shape.pattern.positions as [typeof a.columns, typeof a.columns];
    expect(p1[1]!.relations[0]).toMatchObject({ rel: 'constant', value: 'debit', coverage: 1 });
    expect(p2[1]!.relations[0]).toMatchObject({ rel: 'constant', value: 'credit', coverage: 1 });
    expect(p1[2]!.relations[0]).toMatchObject({ rel: 'copy', in: [1] });
    expect(p2[2]!.relations[0]).toMatchObject({ rel: 'mulConst', in: [1], const: -1 });
    // Failing lists in positions use global aligned-row indices.
    expect(p2[2]!.relations[0]!.total).toBe(10);
    // The side column is a value map of the position column at the top level.
    expect(findRel(a, 1, 'valueMap')).toMatchObject({ in: [2], pairs: [['1', 'debit'], ['2', 'credit']] });
  });

  it('row expansion with no pattern', () => {
    const input: V[][] = [['Ref', 'Note']];
    const output: V[][] = [['Ref', 'Extra']];
    const r = rng(9);
    for (let i = 0; i < 12; i++) {
      input.push([`X${i}`, `note ${i}`]);
      const n = 1 + (i % 3);
      for (let j = 0; j < n; j++) output.push([`X${i}`, `extra ${Math.floor(r() * 1000)}`]);
    }
    const a = analyzeOk(xlsx(input), xlsx(output));
    expect(a.shape).toMatchObject({ kind: 'rowExpansion', sizes: [1, 3] });
  });
});

describe('pivot and summary', () => {
  it('pivot: output headers are values of an input column', () => {
    const input: V[][] = [['Rep', 'Region', 'Amount']];
    const output: V[][] = [['Rep', 'North', 'South', 'East', 'West']];
    const regions = ['North', 'South', 'East', 'West'];
    for (let i = 0; i < 5; i++) {
      const row: V[] = [`rep ${i}`];
      regions.forEach((reg, j) => {
        input.push([`rep ${i}`, reg, 10 * i + j]);
        row.push(10 * i + j);
      });
      output.push(row);
    }
    const a = analyzeOk(xlsx(input), xlsx(output));
    expect(a.pivot).toEqual({ in: 1, outColumns: [1, 2, 3, 4] });
    expect(a.shape).toMatchObject({ kind: 'pivot', in: 1, outColumns: [1, 2, 3, 4] });
  });

  it('summary: one row per distinct value, with aggregates verified on every group', () => {
    const input: V[][] = [['Category', 'Item', 'Qty', 'Price']];
    const output: V[][] = [['Category', 'Items', 'Total qty', 'Top price', 'Low price', 'Avg qty']];
    const r = rng(12);
    const cats = ['tools', 'paint', 'garden', 'lamps', 'rugs'];
    const byCat = new Map<string, { qty: number[]; price: number[] }>();
    for (let i = 0; i < 40; i++) {
      const c = cats[i < 5 ? i : Math.floor(r() * cats.length)]!;
      const qty = 1 + Math.floor(r() * 9);
      const price = Math.round((2 + r() * 300) * 100) / 100;
      input.push([c, `item ${i}`, qty, price]);
      const e = byCat.get(c) ?? { qty: [], price: [] };
      e.qty.push(qty);
      e.price.push(price);
      byCat.set(c, e);
    }
    for (const [c, e] of byCat) {
      const avg = e.qty.reduce((s, x) => s.plus(x), dec(0)).div(e.qty.length).toDecimalPlaces(2, 4).toNumber();
      output.push([c, e.qty.length, e.qty.reduce((s, x) => s + x, 0), Math.max(...e.price), Math.min(...e.price), avg]);
    }
    const a = analyzeOk(xlsx(input), xlsx(output));
    expect(a.alignment.method).toBe('group');
    expect(a.shape).toMatchObject({ kind: 'summary', groupIn: 0, groupOut: 0 });
    expect(a.layout.summary).toBe(true);
    expect(a.layout.groupBy).toMatchObject({ out: 0 });
    expect(best(a, 0)).toMatchObject({ rel: 'copy', in: [0], coverage: 1 });
    expect(best(a, 1)).toMatchObject({ rel: 'aggregate', fn: 'count', coverage: 1 });
    expect(best(a, 2)).toMatchObject({ rel: 'aggregate', in: [2], fn: 'sum', coverage: 1 });
    expect(best(a, 3)).toMatchObject({ rel: 'aggregate', in: [3], fn: 'max', coverage: 1 });
    expect(best(a, 4)).toMatchObject({ rel: 'aggregate', in: [3], fn: 'min', coverage: 1 });
    expect(best(a, 5)).toMatchObject({ rel: 'aggregate', in: [2], fn: 'average', coverage: 1 });
    expect(a.dropped.rows).toEqual([]);
  });
});

describe('domain-neutral mix', () => {
  it('works the same on unrelated synthetic data', () => {
    const r = rng(21);
    const input: V[][] = [['Station', 'Reading', 'Unit']];
    const output: V[][] = [['Station', 'Reading (x1000)', 'Unit']];
    for (let i = 0; i < 25; i++) {
      const reading = Math.round(r() * 5000) / 1000;
      const unit = pick(r, ['kPa', 'bar']);
      input.push([`ST-${100 + i}`, reading, unit]);
      output.push([`ST-${100 + i}`, dec(reading).times(1000).toNumber(), unit]);
    }
    const a = analyzeOk(xlsx(input), xlsx(output));
    expect(best(a, 1)).toMatchObject({ rel: 'mulConst', const: 1000 });
    expect(best(a, 2)).toMatchObject({ rel: 'copy', in: [2] });
  });
});
