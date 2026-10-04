// The constant guard (SPEC 6.2 step 4, 6.5): a column that holds ONE value on every row is accepted as a constant only when the
// input cannot write that value as well. A "03/2026" in every row of a March file is the month of the data as likely as a fixed
// label, and a constant is wrong next month: the column is not built locally, it goes to the AI step with the input column that can
// write it named. A real label, or a fixed value no input column can write, is still built locally. Synthetic, domain-neutral data.
import { describe, expect, it } from 'vitest';
import { isDerivedColumn, isExternalColumn, type PairAnalysis } from '../../../src/learn/analyze';
import { completionPlan } from '../../../src/learn/complete';
import { fastPath } from '../../../src/learn/fastPath';
import { relationsToHints } from '../../../src/learn/hints';
import { partialRules, type PartialRulesResult } from '../../../src/learn/partial';
import { preflight } from '../../../src/learn/preflight';
import { analyzeOk, date, findRel, xlsx, type V } from './helpers';

const N = 24;

/** The i-th March 2026 date written the way a different person typed it: a real date, day/month text, ISO text, a Hebrew month name. */
function marchDate(i: number, mixed: boolean): V {
  const d = 1 + ((i * 5) % 28);
  const dd = String(d).padStart(2, '0');
  if (!mixed) return date(2026, 3, d);
  switch (i % 4) {
    case 0:
      return date(2026, 3, d);
    case 1:
      return `${dd}/03/2026`;
    case 2:
      return `2026-03-${dd}`;
    default:
      return `${d} במרץ 2026`;
  }
}

interface Options {
  /** How the `When` input column is written. */
  mixed?: boolean;
  /** Rows (0-based) whose `When` cell is empty. */
  emptyWhen?: number[];
}

/** Input: Ref, Item, When (March 2026 dates), Group ("North" on every row), Code ("REF-nnnn"). Output: Ref, Item, then `extra`. */
function pairWith(extra: { header: string; value: V }, opts: Options = {}): { input: V[][]; output: V[][] } {
  const input: V[][] = [['Ref', 'Item', 'When', 'Group', 'Code']];
  const output: V[][] = [['Ref', 'Item', extra.header]];
  for (let i = 0; i < N; i++) {
    const ref = `R-${1000 + i * 7}`;
    const item = `Item ${String.fromCharCode(65 + (i % 26))}${i}`;
    input.push([ref, item, opts.emptyWhen?.includes(i) ? null : marchDate(i, opts.mixed ?? false), 'North', `REF-${String(7 + i * 13).padStart(4, '0')}`]);
    output.push([ref, item, extra.value]);
  }
  return { input, output };
}

function analyze(pair: { input: V[][]; output: V[][] }): { a: PairAnalysis; pf: ReturnType<typeof preflight> } {
  const a = analyzeOk(xlsx(pair.input), xlsx(pair.output));
  return { a, pf: preflight(a, 'paid') };
}

function partialOf(a: PairAnalysis, pf: ReturnType<typeof preflight>): PartialRulesResult {
  const p = partialRules(a, pf);
  if ('reason' in p) throw new Error(`partialRules failed: ${p.reason}`);
  return p;
}

/** The three results the owner wants to agree: the analysis, the strict fast path, and the partial result with its completion plan. */
function expectNotBuilt(pair: { input: V[][]; output: V[][] }, header: string) {
  const { a, pf } = analyze(pair);
  const out = a.columns.findIndex((c) => c.header === header);
  const ca = a.columns[out]!;
  expect(findRel(a, out, 'constant')).toBeUndefined();
  expect(ca.derivableConstant).toBeDefined();
  expect(fastPath(a, pf)).toEqual({ reason: 'ambiguousColumn', params: { column: out } });
  const p = partialOf(a, pf);
  expect(p.solved).toEqual(['Ref', 'Item']);
  expect(p.needsAi).toEqual([header]);
  expect(p.external).toEqual([]);
  expect(p.rules.output.columns.find((c) => c.header === header)!.from).toBeNull();
  expect(completionPlan(p.rules).columns).toEqual([out]);
  return { a, pf, ca, out };
}

describe('a month or year of the data is not a constant', () => {
  it('a month label over a column that mixes date formats (real dates, day/month text, ISO text, Hebrew month names)', () => {
    const { a, pf, ca, out } = expectNotBuilt(pairWith({ header: 'Period', value: '03/2026' }, { mixed: true }), 'Period');
    // No relation reads such a column as a date, so nothing explains Period: it depends on the date column (a hint), it is not "another source".
    expect(ca.relations).toEqual([]);
    expect(ca.derivableConstant).toEqual([2]);
    expect(ca.derived).toMatchObject({ kind: 'category', in: [2] });
    expect(isDerivedColumn(ca)).toBe(true);
    expect(isExternalColumn(ca)).toBe(false);
    expect(relationsToHints(a, pf).find((h) => 'out' in h && h.out === out)).toEqual({ rel: 'dependsOn', in: [2], out, coverage: 1 });
  });

  it('a month label over a clean date column: the date format fits too, and nothing is built', () => {
    const { a, pf, ca, out } = expectNotBuilt(pairWith({ header: 'Period', value: '03/2026' }), 'Period');
    expect(ca.derivableConstant).toEqual([2]);
    expect(findRel(a, out, 'dateFormat')).toMatchObject({ in: [2], to: 'MM/YYYY', coverage: 1 });
    expect(relationsToHints(a, pf).find((h) => 'out' in h && h.out === out)).toMatchObject({ rel: 'dateFormat', in: [2], to: 'MM/YYYY' });
  });

  it('other renderings of the month or the year: yyyy-mm, the month name, the year (text or number)', () => {
    for (const [header, value] of [['Month', '2026-03'], ['Name', 'March'], ['Year', 2026], ['Year text', '2026']] as const) {
      const { a, pf } = analyze(pairWith({ header, value }, { mixed: true }));
      expect(a.columns[2]!.derivableConstant, header).toEqual([2]);
      expect(fastPath(a, pf), header).toEqual({ reason: 'ambiguousColumn', params: { column: 2 } });
    }
  });
});

describe('a value the input holds as it is is not a constant either', () => {
  it('a copy: the input column holds the same value on every row', () => {
    const { a, ca, out } = expectNotBuilt(pairWith({ header: 'Area', value: 'North' }), 'Area');
    expect(ca.derivableConstant).toEqual([3]);
    // It stays ambiguous as before (a copy and a constant fit): the hint the AI step gets is the copy.
    expect(findRel(a, out, 'copy')).toMatchObject({ in: [3], coverage: 1 });
  });

  it('a fixed part of an input text: the prefix every code starts with', () => {
    const { a, ca, out } = expectNotBuilt(pairWith({ header: 'Kind', value: 'REF' }), 'Kind');
    expect(ca.derivableConstant).toEqual([4]);
    expect(findRel(a, out, 'substr')).toMatchObject({ in: [4], from: 'start', length: 3 });
  });
});

describe('a real constant is still built locally', () => {
  it('a label no input column can write', () => {
    const { a, pf } = analyze(pairWith({ header: 'Source', value: 'Import' }, { mixed: true }));
    const out = a.columns.findIndex((c) => c.header === 'Source');
    expect(a.columns[out]!.derivableConstant).toBeUndefined();
    expect(findRel(a, out, 'constant')).toMatchObject({ value: 'Import', coverage: 1 });
    const p = partialOf(a, pf);
    expect(p.solved).toEqual(['Ref', 'Item', 'Source']);
    expect(p.needsAi).toEqual([]);
    const fp = fastPath(a, pf);
    expect('rules' in fp).toBe(true);
    if ('rules' in fp) expect(fp.rules.transform.computed.find((c) => c.id === 'source')?.expr).toEqual({ const: 'Import' });
  });

  it('a fixed number that is no part of any date', () => {
    const { a, pf } = analyze(pairWith({ header: 'Version', value: 7 }, { mixed: true }));
    expect(a.columns[2]!.derivableConstant).toBeUndefined();
    expect('rules' in fastPath(a, pf)).toBe(true);
  });

  it('a "month" the dates do not give: the label says another month', () => {
    const { a, pf } = analyze(pairWith({ header: 'Period', value: '09/2025' }, { mixed: true }));
    expect(a.columns[2]!.derivableConstant).toBeUndefined();
    expect('rules' in fastPath(a, pf)).toBe(true);
  });

  it('on EVERY row only: one row without a date cannot write the value, so the example needs the constant', () => {
    const { a, pf } = analyze(pairWith({ header: 'Period', value: '03/2026' }, { mixed: true, emptyWhen: [3] }));
    expect(a.columns[2]!.derivableConstant).toBeUndefined();
    expect(findRel(a, 2, 'constant')).toMatchObject({ value: '03/2026', coverage: 1 });
    expect('rules' in fastPath(a, pf)).toBe(true);
  });
});
