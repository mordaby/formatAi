import { describe, expect, it } from 'vitest';
import { readWorkbook } from '../../../src/io/read';
import { analyzePair } from '../../../src/learn/analyze';
import { padLeft } from '../../../src/values/text';
import { analyzeOk, best, dec, delimited, pick, rng, xlsx, type V } from './helpers';

describe('alignment: keys', () => {
  it('finds a single-column key after normalization (padded ids) and maps shuffled rows', () => {
    const input: V[][] = [['Code', 'Title', 'Weight']];
    const output: V[][] = [['Title', 'Code']];
    const r = rng(3);
    const rows: [number, string, number][] = [];
    for (let i = 0; i < 30; i++) rows.push([500 + i * 3, `title ${pick(r, ['north', 'south', 'east'])} ${i}`, 1 + (i % 4)]);
    for (const x of rows) input.push(x);
    // Output in reverse order, codes padded.
    for (const x of [...rows].reverse()) output.push([x[1], padLeft(String(x[0]), 8, '0')]);
    const a = analyzeOk(xlsx(input), xlsx(output));
    expect(a.alignment.method).toBe('key');
    expect(a.alignment.key).toMatchObject({ matchRate: 1, uniqueness: 1 });
    expect(a.alignment.rows[0]).toEqual({ out: 0, in: 29 });
    expect(a.alignment.rows[29]).toEqual({ out: 29, in: 0 });
    expect(best(a, 0)).toMatchObject({ rel: 'copy', in: [1] });
    expect(best(a, 1)).toMatchObject({ rel: 'padLeft', in: [0], length: 8 });
  });

  it('falls back to a 2-column key when no single column is unique', () => {
    const input: V[][] = [['Day', 'Product', 'Units']];
    const output: V[][] = [['Product', 'Day', 'Units x3']];
    const r = rng(8);
    const rows: [number, string, number][] = [];
    for (let d = 1; d <= 6; d++) for (const p of ['alpha', 'beta', 'gamma', 'delta']) rows.push([d, p, 1 + Math.floor(r() * 50)]);
    for (const x of rows) input.push(x);
    for (const x of rows) output.push([x[1], x[0], x[2] * 3]);
    const a = analyzeOk(xlsx(input), xlsx(output));
    expect(a.alignment.method).toBe('key');
    expect(a.alignment.key?.in).toEqual([0, 1]);
    expect(a.alignment.key?.out).toEqual([1, 0]);
    expect(a.alignment.rows).toHaveLength(24);
    expect(a.alignment.rows.every((x) => x.in === x.out)).toBe(true);
    expect(best(a, 2)).toMatchObject({ rel: 'mulConst', in: [2], const: 3, coverage: 1 });
  });

  it('lists output rows that match no input row, and input rows that were dropped', () => {
    const input: V[][] = [['Id', 'Name']];
    const output: V[][] = [['Id', 'Name']];
    for (let i = 1; i <= 10; i++) input.push([i, `n${i}`]);
    for (let i = 1; i <= 8; i++) output.push([i, `n${i}`]);
    output.push([99, 'stranger']);
    const a = analyzeOk(xlsx(input), xlsx(output));
    expect(a.alignment.unalignedOut).toEqual([8]);
    expect(a.alignment.droppedIn).toEqual([8, 9]);
  });

  it('aligns by position when nothing is copied and the row counts match', () => {
    const input: V[][] = [['Word', 'N']];
    const output: V[][] = [['Short', 'N x10']];
    const words = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel'];
    words.forEach((w, i) => {
      input.push([w, i + 1]);
      output.push([w.slice(0, 3), (i + 1) * 10]);
    });
    const a = analyzeOk(xlsx(input), xlsx(output));
    expect(a.alignment.method).toBe('position');
    expect(best(a, 0)).toMatchObject({ rel: 'substr', from: 'start', length: 3 });
    expect(best(a, 1)).toMatchObject({ rel: 'mulConst', const: 10 });
  });
});

describe('alignment: headerless delimited output', () => {
  it('aligns a tab-delimited load file with no header row by position', async () => {
    const input: V[][] = [['Item', 'Description', 'Price']];
    const lines: string[] = [];
    for (let i = 0; i < 12; i++) {
      const item = 70 + i * 13;
      const price = [12.5, 99.9, 7, 1450, 3.25, 18][i % 6]! + i;
      input.push([item, `desc ${i}`, price]);
      lines.push([padLeft(String(item), 6, '0'), `desc ${i}`, dec(price).times(1.17).toDecimalPlaces(2, 4).toFixed(2)].join('\t'));
    }
    const bytes = new TextEncoder().encode(lines.map((l) => `${l}\r\n`).join(''));
    const out = await readWorkbook(bytes, 'load.txt');
    const a = analyzeOk(xlsx(input), out);
    expect(a.output.headerless).toBe(true);
    expect(a.output.headerRow).toBe(-1);
    expect(a.output.headers).toEqual(['', '', '']);
    expect(a.output.file).toMatchObject({ type: 'txt', delimiter: '\t', header: false });
    expect(a.layout.file).toEqual(a.output.file);
    expect(a.output.dataRows).toHaveLength(12);
    expect(a.alignment.rows).toHaveLength(12);
    expect(best(a, 0)).toMatchObject({ rel: 'padLeft', in: [0], length: 6 });
    expect(best(a, 1)).toMatchObject({ rel: 'copy', in: [1] });
    // "1450 x 1.17" rendered with two decimals: both readings are reported.
    expect(a.columns[2]!.relations.map((r) => r.rel)).toContain('mulConst');
  });

  it('a csv whose first row repeats the input headers is read with its header', () => {
    const input: V[][] = [['name', 'city']];
    const output: (string | null)[][] = [['name', 'city']];
    for (const [n, c] of [['dana', 'haifa'], ['omer', 'eilat'], ['noa', 'acre'], ['tal', 'hadera']]) {
      input.push([n!, c!]);
      output.push([n!, c!]);
    }
    const a = analyzeOk(xlsx(input), delimited(output, 'csv'));
    expect(a.output.headerless).toBe(false);
    expect(a.output.file.header).toBe(true);
    expect(a.output.headers).toEqual(['name', 'city']);
  });
});

describe('identical files and rejections', () => {
  it('flags identical files', () => {
    const rows: V[][] = [['A', 'B']];
    for (let i = 0; i < 5; i++) rows.push([`a${i}`, i]);
    const a = analyzeOk(xlsx(rows), xlsx(rows));
    expect(a.identical).toBe(true);
    const b = analyzeOk(xlsx(rows), xlsx([...rows.slice(0, -1), ['a4', 5]]));
    expect(b.identical).toBe(false);
  });

  it('returns the table rejections of both sides', () => {
    const empty = xlsx([]);
    const res = analyzePair(empty, empty);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.issues.map((i) => `${i.side}:${i.code}`)).toEqual(['input:emptySheet', 'output:emptySheet']);
  });
});
