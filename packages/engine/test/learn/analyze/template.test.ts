// The `template` relation (SPEC 6.2 step 4): output text = fixed text + input values (+ fixed text ...), e.g.
// `12345:"Cohen"` from ID and Name. Deliberately light (limits.learn.template): 1-2 input columns, short
// literals, coverage exactly 1, tried only when nothing simpler explains the column, and never reported when
// more than one template fits (the column then goes to the AI step).
import { limits } from '@formatai/shared';
import { describe, expect, it } from 'vitest';
import { analyzeOk, findRel, type V } from './helpers';
import { xlsx } from './helpers';

const NAMES = ['Cohen', 'Levi', 'Mizrahi', 'שרה כהן', 'דוד לוי', 'Bar', 'Katz', 'נועה', 'Peretz', 'Avraham'];

function pair(inHeaders: string[], inRows: V[][], outHeaders: string[], outRows: V[][]) {
  return analyzeOk(xlsx([inHeaders, ...inRows]), xlsx([outHeaders, ...outRows]));
}

/** ids with leading zeros as text, names in English and Hebrew. */
function idNameRows(n: number): V[][] {
  const rows: V[][] = [];
  for (let i = 0; i < n; i++) rows.push([String(i * 37 + 5).padStart(5, '0'), NAMES[i % NAMES.length]!, `n${i}`]);
  return rows;
}

const IN = ['ID', 'Name', 'Note'];

describe('template relation: what it finds', () => {
  it('<id>:"<name>" with Hebrew and English names and ids with leading zeros', () => {
    const rows = idNameRows(12);
    const a = pair(IN, rows, ['ID', 'Label'], rows.map((r) => [r[0]!, `${r[0]}:"${r[1]}"`]));
    expect(a.columns[1]!.relations).toHaveLength(1);
    expect(findRel(a, 1, 'template')).toMatchObject({
      rel: 'template',
      in: [0, 1],
      parts: [{ in: 0 }, ':"', { in: 1 }, '"'],
      coverage: 1,
      failCount: 0,
    });
  });

  it('needs no output column that is one of the two inputs: the rows are matched by another column', () => {
    const rows = idNameRows(9);
    const a = pair(IN, rows, ['Label', 'Note'], rows.map((r) => [`${r[0]}:"${r[1]}"`, r[2]!]));
    expect(a.alignment.key?.in).toEqual([2]);
    expect(findRel(a, 0, 'template')).toMatchObject({ in: [0, 1], parts: [{ in: 0 }, ':"', { in: 1 }, '"'], coverage: 1 });
  });

  it('a prefix only: INV-<n>', () => {
    const rows: V[][] = [];
    for (let i = 0; i < 10; i++) rows.push([1001 + i * 13, `x${i}`]);
    const a = pair(['N', 'Other'], rows, ['N', 'Doc'], rows.map((r) => [r[0]!, `INV-${r[0]}`]));
    expect(findRel(a, 1, 'template')).toMatchObject({ in: [0], parts: ['INV-', { in: 0 }], coverage: 1 });
  });

  it('a suffix only: <n> ILS', () => {
    const rows: V[][] = [];
    for (let i = 0; i < 10; i++) rows.push([`k${i}`, 7 + i * 31]);
    const a = pair(['K', 'N'], rows, ['K', 'Amount'], rows.map((r) => [r[0]!, `${r[1]} ILS`]));
    expect(findRel(a, 1, 'template')).toMatchObject({ in: [1], parts: [{ in: 1 }, ' ILS'], coverage: 1 });
  });

  it('a prefix, a separator and a suffix around two columns', () => {
    const rows = idNameRows(10);
    const a = pair(IN, rows, ['ID', 'Label'], rows.map((r) => [r[0]!, `[${r[0]}] ${r[1]}.`]));
    expect(findRel(a, 1, 'template')).toMatchObject({ in: [0, 1], parts: ['[', { in: 0 }, '] ', { in: 1 }, '.'], coverage: 1 });
  });

  it('the same column twice counts as two columns', () => {
    const rows: V[][] = [];
    for (let i = 0; i < 10; i++) rows.push([`A${i * 3 + 1}`, i]);
    const a = pair(['Code', 'Seq'], rows, ['Code', 'Twice'], rows.map((r) => [r[0]!, `${r[0]}#${r[0]}`]));
    expect(findRel(a, 1, 'template')).toMatchObject({ in: [0], parts: [{ in: 0 }, '#', { in: 0 }], coverage: 1 });
  });

  it('values with no separator between two columns and fixed text around them', () => {
    const rows: V[][] = [];
    for (let i = 0; i < 10; i++) rows.push([`P${i * 7}`, 100 + i * 9]);
    const a = pair(['A', 'B'], rows, ['A', 'Code'], rows.map((r) => [r[0]!, `<${r[0]}${r[1]}>`]));
    expect(findRel(a, 1, 'template')).toMatchObject({ in: [0, 1], parts: ['<', { in: 0 }, { in: 1 }, '>'], coverage: 1 });
  });
});

describe('template relation: what it leaves alone', () => {
  it('leaves simpler relations to their own stages: a whole-word concat is still a concat, no template', () => {
    const rows: V[][] = [];
    for (let i = 0; i < 10; i++) rows.push([`k${i}`, NAMES[i % NAMES.length]!, `L${i * 5}`]);
    const a = pair(['K', 'First', 'Last'], rows, ['K', 'Full'], rows.map((r) => [r[0]!, `${r[1]} ${r[2]}`]));
    expect(findRel(a, 1, 'concat')).toMatchObject({ coverage: 1 });
    expect(findRel(a, 1, 'template')).toBeUndefined();
  });

  it('does not report three columns', () => {
    const rows: V[][] = [];
    for (let i = 0; i < 10; i++) rows.push([`k${i}`, `A${i * 3}`, `B${i * 5 + 1}`, `C${i * 7 + 2}`]);
    const a = pair(['K', 'A', 'B', 'C'], rows, ['K', 'Out'], rows.map((r) => [r[0]!, `(${r[1]}) ${r[2]}/${r[3]}`]));
    expect(a.columns[1]!.relations).toEqual([]);
  });

  it('does not report a literal longer than the limit', () => {
    const max = limits.learn.template.maxLiteralChars;
    const text = 'abcdefghijklmnop'; // not one repeated character, which would read as padding
    const long = text.slice(0, max + 1);
    const rows: V[][] = [];
    for (let i = 0; i < 10; i++) rows.push([`k${i}`, 100 + i * 17]);
    const a = pair(['K', 'N'], rows, ['K', 'Out'], rows.map((r) => [r[0]!, `${long}${r[1]}`]));
    expect(findRel(a, 1, 'template')).toBeUndefined();
    const ok = pair(['K', 'N'], rows, ['K', 'Out'], rows.map((r) => [r[0]!, `${text.slice(0, max)}${r[1]}`]));
    expect(findRel(ok, 1, 'template')).toMatchObject({ coverage: 1 });
  });

  it('does not report literals that are each short but too long together', () => {
    const { maxLiteralChars, maxTotalLiteralChars } = limits.learn.template;
    expect(maxTotalLiteralChars).toBeGreaterThan(maxLiteralChars);
    const rows: V[][] = [];
    for (let i = 0; i < 10; i++) rows.push([`k${i}`, 100 + i * 17]);
    const pre = 'abcdefghij'.slice(0, maxLiteralChars);
    const suf = 'klmnopqrstuv'.slice(0, maxTotalLiteralChars - maxLiteralChars + 1);
    const a = pair(['K', 'N'], rows, ['K', 'Out'], rows.map((r) => [r[0]!, `${pre}${r[1]}${suf}`]));
    expect(findRel(a, 1, 'template')).toBeUndefined();
  });

  it('does not report a template whose fixed text differs on one row (coverage below 1 is never reported)', () => {
    const rows: V[][] = [];
    for (let i = 0; i < 20; i++) rows.push([`k${i}`, 10 + i * 3]);
    const outRows = rows.map((r, i) => [r[0]!, i === 13 ? `${r[1]} USD` : `${r[1]} ILS`]);
    const a = pair(['K', 'N'], rows, ['K', 'Amount'], outRows);
    expect(findRel(a, 1, 'template')).toBeUndefined();
    expect(a.columns[1]!.relations.filter((r) => r.rel === 'template')).toEqual([]);
  });

  it('reports none when two templates fit every row (a column equal to another one)', () => {
    const rows = idNameRows(10).map((r) => [...r, r[1]!]); // Copy = Name
    const a = pair(['ID', 'Name', 'Note', 'Copy'], rows, ['ID', 'Label'], rows.map((r) => [r[0]!, `${r[0]}:"${r[1]}"`]));
    expect(a.columns[1]!.relations.filter((r) => r.rel === 'template')).toEqual([]);
  });

  it('reports none when a constant column and fixed text are both readings (a Year column that never changes)', () => {
    const rows: V[][] = [];
    for (let i = 0; i < 10; i++) rows.push([`k${i}`, 100 + i * 17, 2024]);
    const a = pair(['K', 'N', 'Year'], rows, ['K', 'Ref'], rows.map((r) => [r[0]!, `${r[1]}-${r[2]}`]));
    expect(a.columns[1]!.relations.filter((r) => r.rel === 'template')).toEqual([]);
  });

  it('does not report a column whose output cells are blank on some rows', () => {
    const rows: V[][] = [];
    for (let i = 0; i < 10; i++) rows.push([`k${i}`, 100 + i * 17]);
    const a = pair(['K', 'N'], rows, ['K', 'Out'], rows.map((r, i) => [r[0]!, i === 4 ? null : `no.${r[1]}`]));
    expect(findRel(a, 1, 'template')).toBeUndefined();
  });

  it('does not report numbers written as numbers (a template writes text)', () => {
    const rows: V[][] = [];
    for (let i = 0; i < 10; i++) rows.push([`k${i}`, 100 + i * 17]);
    const a = pair(['K', 'N'], rows, ['K', 'Out'], rows.map((r) => [r[0]!, Number(r[1]) + 1]));
    expect(findRel(a, 1, 'template')).toBeUndefined();
  });
});
