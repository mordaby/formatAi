// A date copied as it is keeps the example's text form (found by the engine stress test, eval/STRESS.md). A column of date TEXT
// ("2024-09-28") copied unchanged into the output is declared a date (so the rules can read it), and the engine writes a date with its
// column's format - or with its default "28/09/2024" when the column has none. A csv/txt file has no formats, so the copy wrote the
// default, which the verification, comparing a date by its ISO form, took for a match; into a workbook it wrote a real date where the
// example holds text.
import { describe, expect, it } from 'vitest';
import { analyzePair } from '../../src/learn/analyze';
import { fastPath } from '../../src/learn/fastPath';
import { partialRules } from '../../src/learn/partial';
import { preflight } from '../../src/learn/preflight';
import { exampleTable, verifyAgainstExample } from '../../src/learn/verify';
import { runRules } from '../../src/pipeline';
import type { OutCell, RawWorkbook } from '../../src/types';
import { delimited, xlsx, type V } from './analyze/helpers';

const DAYS: [number, number, number][] = [
  [2024, 9, 28],
  [2025, 1, 3],
  [2026, 12, 31],
  [2024, 2, 29],
  [2025, 7, 14],
  [2026, 3, 1],
];
const p2 = (n: number): string => String(n).padStart(2, '0');
type Fmt = (y: number, m: number, d: number) => string;
const FORMS: [string, Fmt][] = [
  ['ISO', (y, m, d) => `${y}-${p2(m)}-${p2(d)}`],
  ['day first, dots', (y, m, d) => `${p2(d)}.${p2(m)}.${y}`],
  ['day first, slashes (the default)', (y, m, d) => `${p2(d)}/${p2(m)}/${y}`],
];

function pair(text: Fmt, out: 'csv' | 'xlsx', withExternal = false) {
  const inRows: V[][] = DAYS.map(([y, m, d], i) => [`R${100 + i}`, text(y, m, d)]);
  // (Reordered: an output identical to the input is blocked.)
  const outRows: V[][] = DAYS.map(([y, m, d], i) => [text(y, m, d), `R${100 + i}`, ...(withExternal ? [`W${(i * 37) % 11}z`] : [])]);
  const headers = ['Paid', 'Ref', ...(withExternal ? ['Note'] : [])];
  const output: RawWorkbook = out === 'csv' ? delimited([headers, ...outRows], 'csv') : xlsx([headers, ...outRows]);
  const a = analyzePair(xlsx([['Ref', 'Paid'], ...inRows]), output);
  if (!a.ok) throw new Error(`analysis failed: ${JSON.stringify(a.issues)}`);
  return a;
}

const shown = (c: OutCell | undefined): unknown => (c?.isDate ? c.text : c?.v);

describe('fastPath: date text copied as it is keeps the example\'s text form', () => {
  for (const out of ['csv', 'xlsx'] as const) {
    for (const [name, text] of FORMS) {
      it(`${out}, ${name}: the rules write the example's text, and verify`, () => {
        const a = pair(text, out);
        expect(a.input.profile[1]!.type).toBe('date');
        const fp = fastPath(a, preflight(a, 'paid'));
        if (!('rules' in fp)) throw new Error(`fastPath refused: ${JSON.stringify(fp)}`);
        const run = runRules(fp.rules, exampleTable(a), {});
        if (!run.ok) throw new Error(`run failed: ${JSON.stringify(run.error)}`);
        const written = run.sheet.rows.filter((r) => r.kind === 'data').map((r) => shown(r.cells[0]));
        expect(written).toEqual(DAYS.map(([y, m, d]) => text(y, m, d)));
        if (out === 'xlsx') expect(run.sheet.rows.filter((r) => r.kind === 'data').every((r) => r.cells[0]?.isDate !== true)).toBe(true);
        expect(verifyAgainstExample(fp.rules, a).verified).toBe(true);
      });
    }
  }

  it('the local partial result builds the column the same way', () => {
    const a = pair(FORMS[0]![1], 'csv', true);
    const p = partialRules(a, preflight(a, 'paid'));
    if ('reason' in p) throw new Error(`partial refused: ${p.reason}`);
    expect(p.solvedColumns).toEqual([0, 1]);
    expect(verifyAgainstExample(p.rules, a, { onlyColumns: p.solvedColumns }).verified).toBe(true);
  });
});
