// Fixes found by the rule catalogue (eval/catalogue): what the strict fast path builds must be what the
// example shows and what next month's file needs, and "verified" must be literally true. Each block pins one
// root cause with its own small, domain-neutral data: a row filter that keeps what the analysis dropped, value
// maps on one column overwriting each other, a verification that read "₪1,234.50" as 1234.5, a constant that
// is a rounded reciprocal (x * 0.854701 for x / 1.17), and a `split` with no rule form.
import type { LearnResult, RowFilter } from '@formatai/shared';
import { checkRules } from '@formatai/shared';
import { describe, expect, it } from 'vitest';
import { typeCheck } from '../../src/check';
import { analyzePair, type FilterRelation, type PairAnalysis } from '../../src/learn/analyze';
import { buildRowFilter, fastPath, type FastPathResult } from '../../src/learn/fastPath';
import { preflight } from '../../src/learn/preflight';
import { partialRules } from '../../src/learn/partial';
import { verifyAgainstExample } from '../../src/learn/verify';
import { runOk, table, values, type CellInput } from '../pipeline/helpers';
import { date, delimited, xlsx, type V } from './analyze/helpers';
import type { RawWorkbook } from '../../src/types';

function cellV(v: V): string | number | boolean | null {
  return v !== null && typeof v === 'object' ? v.v : v;
}

interface Built {
  a: PairAnalysis;
  result: FastPathResult;
}

function build(inHeaders: string[], inRows: V[][], outHeaders: string[], outRows: V[][], outputWb?: RawWorkbook): Built {
  const a = analyzePair(xlsx([inHeaders, ...inRows]), outputWb ?? xlsx([outHeaders, ...outRows]));
  if (!a.ok) throw new Error(`analysis failed: ${JSON.stringify(a.issues)}`);
  return { a, result: fastPath(a, preflight(a, 'registered')) };
}

/** The fast path must succeed, type-check, verify against the example and reproduce it when run. */
function built(inHeaders: string[], inRows: V[][], outHeaders: string[], outRows: V[][], outputWb?: RawWorkbook): { a: PairAnalysis; rules: LearnResult } {
  const { a, result } = build(inHeaders, inRows, outHeaders, outRows, outputWb);
  if (!('rules' in result)) throw new Error(`fastPath failed: ${JSON.stringify(result)}`);
  expect(checkRules(result.rules), 'checkRules').toEqual([]);
  expect(typeCheck(result.rules), 'typeCheck').toEqual([]);
  const v = verifyAgainstExample(result.rules, a);
  expect(v.mismatches, 'verification mismatches').toEqual([]);
  expect(v.verified, 'verified').toBe(true);
  return { a, rules: result.rules };
}

function convert(rules: LearnResult, headers: string[], rows: V[][]): (string | number | boolean | null)[][] {
  return values(runOk(rules, table(headers, rows as CellInput[][])).sheet);
}

// ---------------------------------------------------------------------------
// 1. A row filter keeps what its condition holds for; the analysis reports what it DROPS.
// ---------------------------------------------------------------------------

describe('row filters: the keep condition is the complement of the dropped one', () => {
  const droppedWhen = (op: NonNullable<FilterRelation['droppedWhen']>['op'], value?: number): FilterRelation => ({
    rel: 'filter',
    in: [0],
    droppedWhen: value === undefined ? { op } : { op, value },
    coverage: 1,
    failing: [],
    failCount: 0,
  });

  it.each([
    ['gt', 'lte'],
    ['gte', 'lt'],
    ['lt', 'gte'],
    ['lte', 'gt'],
  ] as const)('dropped when %s X: keep %s X', (dropped, keep) => {
    expect(buildRowFilter(droppedWhen(dropped, 100), 'amount', [])).toEqual<RowFilter>({ column: 'amount', op: keep, value: 100 });
  });

  it('dropped when empty: keep notEmpty (and the other way round)', () => {
    expect(buildRowFilter(droppedWhen('isEmpty'), 'email', [])).toEqual<RowFilter>({ column: 'email', op: 'notEmpty' });
    expect(buildRowFilter(droppedWhen('notEmpty'), 'email', [])).toEqual<RowFilter>({ column: 'email', op: 'isEmpty' });
  });

  const amounts = [25.5, 140.25, 99.4, 310, 60, 187.8, 104.2, 12, 255.5, 78.9, 399, 120.1, 45.3, 160];
  const lines = amounts.map((_, i) => `L${String(i + 1).padStart(3, '0')}`);

  it('a threshold: rows under 100 are dropped, so the rule keeps the rows of 100 or more - on the example and on next month', () => {
    const inRows: V[][] = amounts.map((x, i) => [lines[i]!, x]);
    const outRows = inRows.filter((r) => (r[1] as number) >= 100);
    const { a, rules } = built(['Line', 'Amount'], inRows, ['Line', 'Amount'], outRows);
    expect(a.dropped.filters[0]).toMatchObject({ droppedWhen: { op: 'lt', value: 100 } });
    expect(rules.input.rowFilters).toEqual([{ column: expect.any(String), op: 'gte', value: 100 }]);
    // Where in the gap the line was drawn is not forced by the data.
    expect(rules.assumptions).toEqual([{ reasonCode: 'filterGuessed' }]);
    expect(convert(rules, ['Line', 'Amount'], [['N1', 99.99], ['N2', 100], ['N3', 250], ['N4', 3]])).toEqual([
      ['N2', 100],
      ['N3', 250],
    ]);
  });

  it('an upper threshold: rows above 1000 are dropped, so the rule keeps 1000 or less', () => {
    const big = [120, 640, 1480, 900, 1032, 310, 986, 2200, 75, 540, 1250, 410];
    const inRows: V[][] = big.map((x, i) => [`R${i + 1}`, x]);
    const outRows = inRows.filter((r) => (r[1] as number) <= 1000);
    const { rules } = built(['Ref', 'Amount'], inRows, ['Ref', 'Amount'], outRows);
    expect(rules.input.rowFilters).toEqual([{ column: expect.any(String), op: 'lte', value: 1000 }]);
  });

  it('empty cells: rows without an email are dropped, so the rule keeps the rows that have one', () => {
    const emails = ['a@x.test', '', 'c@x.test', '', 'e@x.test', 'f@x.test', '', 'h@x.test'];
    const inRows: V[][] = emails.map((e, i) => [`C${i + 1}`, e === '' ? null : e]);
    const outRows = inRows.filter((r) => r[1] !== null);
    const { rules } = built(['Customer', 'Email'], inRows, ['Customer', 'Email'], outRows);
    expect(rules.input.rowFilters).toEqual([{ column: expect.any(String), op: 'notEmpty' }]);
    expect(convert(rules, ['Customer', 'Email'], [['N1', 'n@x.test'], ['N2', null]])).toEqual([['N1', 'n@x.test']]);
  });

  it('a threshold on a column with empty cells is left to the AI step (the complement would drop the empty rows the example kept)', () => {
    const inRows: V[][] = amounts.map((x, i) => [lines[i]!, i === 3 ? null : x]);
    const outRows = inRows.filter((r) => r[1] === null || (r[1] as number) >= 100);
    const { result } = build(['Line', 'Amount'], inRows, ['Line', 'Amount'], outRows);
    expect(result).toEqual({ reason: 'droppedRowsUnexplained', params: { part: 'filterKeepsEmpty' } });
  });
});

describe('dropped rows: a threshold sits on the roundest number of the gap', () => {
  it('100 between the largest dropped (99.4) and the smallest kept (104.2) value', () => {
    const inRows: V[][] = [[99.4], [104.2], [60], [310], [150], [20], [187.5], [105]].map((r, i) => [`K${i}`, r[0]!]);
    const outRows = inRows.filter((r) => (r[1] as number) >= 100);
    const a = analyzePair(xlsx([['Key', 'Value'], ...inRows]), xlsx([['Key', 'Value'], ...outRows]));
    if (!a.ok) throw new Error('analysis failed');
    expect(a.dropped.filters[0]).toMatchObject({ droppedWhen: { op: 'lt', value: 100 }, coverage: 1 });
  });
});

// ---------------------------------------------------------------------------
// 2. Value maps: one column can feed several outputs.
// ---------------------------------------------------------------------------

describe('value maps never overwrite each other or a plain copy', () => {
  const codes = ['A', 'B', 'C', 'A', 'B', 'C', 'A', 'C', 'B', 'A', 'C', 'B'];
  const region: Record<string, string> = { A: 'North', B: 'South', C: 'East' };
  const kind: Record<string, string> = { A: 'Hardware', B: 'Software', C: 'Services' };
  const inRows: V[][] = codes.map((c, i) => [`L${i + 1}`, c]);
  const nextRows: V[][] = [['N1', 'C'], ['N2', 'A']];

  it('two outputs that are both a map of the same column each get their own', () => {
    const outRows = inRows.map((r) => [r[0]!, kind[r[1] as string]!, region[r[1] as string]!]);
    const { rules } = built(['Line', 'Code'], inRows, ['Line', 'Kind', 'Region'], outRows);
    const maps = rules.transform.valueMaps;
    expect(maps).toHaveLength(2);
    expect(new Set(maps.map((m) => m.column)).size).toBe(2);
    expect(convert(rules, ['Line', 'Code'], nextRows)).toEqual([
      ['N1', 'Services', 'East'],
      ['N2', 'Hardware', 'North'],
    ]);
  });

  it('a plain copy of the column next to a map of it stays a copy (the map is on a computed copy)', () => {
    const outRows = inRows.map((r) => [r[0]!, r[1]!, region[r[1] as string]!]);
    const { rules } = built(['Line', 'Code'], inRows, ['Line', 'Code', 'Region'], outRows);
    const map = rules.transform.valueMaps[0]!;
    expect(rules.input.columns.map((c) => c.id)).not.toContain(map.column);
    expect(convert(rules, ['Line', 'Code'], nextRows)).toEqual([
      ['N1', 'C', 'East'],
      ['N2', 'A', 'North'],
    ]);
  });

  it('... in either order of the output columns', () => {
    const outRows = inRows.map((r) => [r[0]!, region[r[1] as string]!, r[1]!]);
    const { rules } = built(['Line', 'Code'], inRows, ['Line', 'Region', 'Code'], outRows);
    expect(convert(rules, ['Line', 'Code'], nextRows)).toEqual([
      ['N1', 'East', 'C'],
      ['N2', 'North', 'A'],
    ]);
  });

  it('a lone map on a text column keeps the learned shape: the map sits right on the input column', () => {
    const outRows = inRows.map((r) => [r[0]!, region[r[1] as string]!]);
    const { rules } = built(['Line', 'Code'], inRows, ['Line', 'Region'], outRows);
    expect(rules.transform.valueMaps).toHaveLength(1);
    expect(rules.input.columns.map((c) => c.id)).toContain(rules.transform.valueMaps[0]!.column);
    expect(rules.transform.computed).toEqual([]);
  });

  it('a number-typed code column is mapped through a copy, so its own checks still see the numbers', () => {
    const statuses = [1, 2, 3, 1, 2, 3, 1, 3, 2, 1];
    const label: Record<number, string> = { 1: 'Open', 2: 'Closed', 3: 'Hold' };
    const rows: V[][] = statuses.map((s, i) => [`T${i + 1}`, s]);
    const outRows = rows.map((r) => [r[0]!, label[r[1] as number]!]);
    const { rules } = built(['Ticket', 'Status'], rows, ['Ticket', 'Label'], outRows);
    const map = rules.transform.valueMaps[0]!;
    expect(rules.input.columns.map((c) => c.id)).not.toContain(map.column);
    const ran = runOk(rules, table(['Ticket', 'Status'], [['N1', 2], ['N2', 3]]));
    expect(values(ran.sheet)).toEqual([['N1', 'Closed'], ['N2', 'Hold']]);
    expect(ran.flags).toEqual([]);
  });

  it('a map that would have to write numbers (rates, group totals) is left to the AI step', () => {
    const rate: Record<string, number> = { A: 0.1, B: 0.2, C: 0.17 };
    const outRows = inRows.map((r) => [r[0]!, rate[r[1] as string]!]);
    const { result } = build(['Line', 'Code'], inRows, ['Line', 'Rate'], outRows);
    expect(result).toMatchObject({ reason: 'thinEvidence', params: { relation: 'valueMap' } });
  });
});

// ---------------------------------------------------------------------------
// 3. Verification compares what the user sees.
// ---------------------------------------------------------------------------

describe('verifyAgainstExample compares text as text, numbers as numbers, dates as dates', () => {
  const amounts = [1234.5, 18000.25, 4100, 2087.2, 6400.75, 1999, 25000, 3333.33];
  const inRows: V[][] = amounts.map((x, i) => [`I${i + 1}`, x]);
  const fmt = (x: number): string => x.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  it('the ₪ of a currency text counts: the rule that drops it is not verified, the one that writes it is', () => {
    const outRows = inRows.map((r) => [r[0]!, `₪${fmt(r[1] as number)}`]);
    const { a, rules } = built(['Invoice', 'Amount'], inRows, ['Invoice', 'Amount'], outRows);
    expect(rules.transform.computed[0]!.expr).toMatchObject({ op: 'concat' });

    const withoutSymbol: LearnResult = {
      ...rules,
      transform: { ...rules.transform, computed: [{ ...rules.transform.computed[0]!, expr: { op: 'toText', arg: { col: rules.input.columns[1]!.id }, format: '#,##0.00' } }] },
    };
    const v = verifyAgainstExample(withoutSymbol, a);
    expect(v.verified).toBe(false);
    expect(v.matched).toBe(0);
    expect(v.mismatches[0]).toMatchObject({ column: 'Amount', expected: '₪1,234.50', actual: '1,234.50' });
  });

  it('a number is not the text that reads like it, in either direction (xlsx)', () => {
    // The example holds the number 12; a rule that writes the text "12" shows something else to the user.
    const numbers: V[][] = [['Qty', 'Ref'], [12, 'R1'], [18, 'R2'], [10, 'R3'], [25, 'R4']];
    const a = analyzePair(xlsx([['Ref', 'Qty'], ['R1', 12], ['R2', 18], ['R3', 10], ['R4', 25]]), xlsx(numbers));
    if (!a.ok) throw new Error('analysis failed');
    const base = fastPath(a, preflight(a, 'registered'));
    if (!('rules' in base)) throw new Error('fastPath failed');
    expect(verifyAgainstExample(base.rules, a).verified).toBe(true);
    const qty = base.rules.input.columns[1]!.id;
    const asText: LearnResult = {
      ...base.rules,
      transform: { ...base.rules.transform, computed: [{ id: 'qtyText', type: 'text', expr: { op: 'toText', arg: { col: qty } } }] },
      output: { ...base.rules.output, columns: base.rules.output.columns.map((c) => (c.header === 'Qty' ? { ...c, from: 'qtyText' } : c)) },
    };
    const v = verifyAgainstExample(asText, a);
    expect(v.verified).toBe(false);
    expect(v.mismatches[0]).toMatchObject({ column: 'Qty', expected: 12, actual: '12' });

    // And the other way round: the example holds the TEXT "12", the rule writes the number.
    const texts: V[][] = [['Qty', 'Ref'], ['12', 'R1'], ['18', 'R2'], ['10', 'R3'], ['25', 'R4']];
    const b = analyzePair(xlsx([['Ref', 'Qty'], ['R1', 12], ['R2', 18], ['R3', 10], ['R4', 25]]), xlsx(texts));
    if (!b.ok) throw new Error('analysis failed');
    const verdict = verifyAgainstExample(base.rules, b);
    expect(verdict.verified).toBe(false);
    expect(verdict.mismatches[0]).toMatchObject({ expected: '12', actual: 12 });
  });

  it('a text that reads like a date is not a date', () => {
    const dates = [date(2024, 1, 15), date(2024, 2, 20), date(2024, 3, 5), date(2024, 4, 10), date(2024, 5, 25)];
    const iso = ['2024-01-15', '2024-02-20', '2024-03-05', '2024-04-10', '2024-05-25'];
    const rows: V[][] = dates.map((d, i) => [`D${i + 1}`, d]);
    const outRows = iso.map((t, i) => [`D${i + 1}`, t]);
    const { a, rules } = built(['Doc', 'Posted'], rows, ['Doc', 'Posted'], outRows);
    expect(rules.transform.computed[0]!.expr).toMatchObject({ op: 'dateFormat' });
    // The rule that copies the real date shows a date where the example has text.
    const copy: LearnResult = {
      ...rules,
      transform: { ...rules.transform, computed: [] },
      output: { ...rules.output, columns: rules.output.columns.map((c) => (c.header === 'Posted' ? { ...c, from: rules.input.columns[1]!.id } : c)) },
    };
    expect(verifyAgainstExample(copy, a).verified).toBe(false);
  });

  it('csv/txt examples keep their cells as text: a plain number string matches the number the writer writes, nothing more', () => {
    const inCsv: V[][] = [['ID', 'Amount'], [101, 12], [102, 18], [103, 10], [104, 25]];
    const swap = (rows: V[][]): V[][] => rows.map((r) => [r[1]!, r[0]!]);
    const ok = analyzePair(xlsx(inCsv), delimited(swap(inCsv), 'csv'));
    if (!ok.ok) throw new Error('analysis failed');
    const base = fastPath(ok, preflight(ok, 'registered'));
    if (!('rules' in base)) throw new Error('fastPath failed');
    expect(verifyAgainstExample(base.rules, ok).verified).toBe(true);

    // "1,000.00" is not what the writer writes for the number 1000: it is a different text.
    const grouped = analyzePair(xlsx(inCsv), delimited([['Amount', 'ID'], ['12.00', 101], ['18.00', 102], ['10.00', 103], ['1,000.00', 104]], 'csv'));
    if (!grouped.ok) throw new Error('analysis failed');
    const v = verifyAgainstExample(base.rules, grouped);
    expect(v.verified).toBe(false);
    expect(v.mismatches.map((m) => m.expected)).toEqual(['1,000.00']);
  });
});

// ---------------------------------------------------------------------------
// 4. Constants: the roundest reading, and no fact from a rounded approximation.
// ---------------------------------------------------------------------------

describe('constants of a calculation', () => {
  const grosses = [117, 234, 58.5, 1170, 99.99, 2345.67, 640, 12.34, 8765.4, 305, 77.7, 4500];
  const round2 = (x: number): number => Math.round(x * 100 + 1e-9) / 100;

  it('"net = gross / 1.17" is divided, not multiplied by 0.854701 (which drifts on next month\'s values)', () => {
    const inRows: V[][] = grosses.map((g, i) => [`I${i + 1}`, g]);
    const outRows = inRows.map((r) => [r[0]!, round2((r[1] as number) / 1.17)]);
    const { a, rules } = built(['Invoice', 'Gross'], inRows, ['Invoice', 'Net'], outRows);
    expect(a.columns[1]!.relations[0]).toMatchObject({ rel: 'mulConst', divisor: 1.17, divisorText: '1.17' });
    expect(rules.transform.computed[0]!.expr).toEqual({ op: 'round', digits: 2, arg: { op: 'div', args: [{ col: expect.any(String) }, { const: 1.17 }] } });
    const next = [31337.31, 5, 17.55, 99999.99, 702.0];
    expect(convert(rules, ['Invoice', 'Gross'], next.map((g, i) => [`N${i}`, g]))).toEqual(next.map((g, i) => [`N${i}`, round2(g / 1.17)]));
  });

  it('a factor stays a factor when it is the round one ("net * 1.17")', () => {
    const inRows: V[][] = grosses.map((g, i) => [`I${i + 1}`, g]);
    const outRows = inRows.map((r) => [r[0]!, round2((r[1] as number) * 1.17)]);
    const { a, rules } = built(['Invoice', 'Net'], inRows, ['Invoice', 'Gross'], outRows);
    expect(a.columns[1]!.relations[0]).toMatchObject({ rel: 'mulConst', const: 1.17 });
    expect(a.columns[1]!.relations[0]).not.toHaveProperty('divisor');
    expect(rules.transform.computed[0]!.expr).toMatchObject({ op: 'round', arg: { op: 'mul' } });
  });

  it('a constant of many digits that only fits after rounding is thin evidence (the AI step decides), not a fact', () => {
    const inRows: V[][] = grosses.map((g, i) => [`I${i + 1}`, g]);
    const outRows = inRows.map((r) => [r[0]!, round2((r[1] as number) * 0.837291)]);
    const { a, result } = build(['Invoice', 'Gross'], inRows, ['Invoice', 'Net'], outRows);
    expect(a.columns[1]!.relations[0]).toMatchObject({ rel: 'mulConst', const: 0.837291, round: 2, coverage: 1 });
    expect(result).toMatchObject({ reason: 'thinEvidence', params: { relation: 'mulConst' } });
  });
});

// ---------------------------------------------------------------------------
// 5. A currency symbol is joined on: toText never writes a quoted text of its format.
// ---------------------------------------------------------------------------

describe('number formats with fixed text', () => {
  const amounts = [1234.5, 18000.25, 4100, 2087.2, 6400.75, 1999, 25000, 3333.33];
  const fmt = (x: number): string => x.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  it('a symbol behind the amount: concat(toText(x, "#,##0.00"), " ₪")', () => {
    const inRows: V[][] = amounts.map((x, i) => [`I${i + 1}`, x]);
    const outRows = inRows.map((r) => [r[0]!, `${fmt(r[1] as number)} ₪`]);
    const { rules } = built(['Invoice', 'Amount'], inRows, ['Invoice', 'Amount'], outRows);
    expect(rules.transform.computed[0]!.expr).toMatchObject({ op: 'concat', args: [{ op: 'toText', format: '#,##0.00' }, { const: ' ₪' }] });
  });

  it('a symbol in front of negative amounts is left to the AI step (the join would write ₪-5.00, not -₪5.00)', () => {
    const withNegative = [...amounts, -1500];
    const inRows: V[][] = withNegative.map((x, i) => [`I${i + 1}`, x]);
    const outRows = inRows.map((r) => [r[0]!, (r[1] as number) < 0 ? `-₪${fmt(-(r[1] as number))}` : `₪${fmt(r[1] as number)}`]);
    const { result } = build(['Invoice', 'Amount'], inRows, ['Invoice', 'Amount'], outRows);
    expect(result).toMatchObject({ reason: 'columnNotFullyExplained' });
  });

  it('a symbol with an empty amount is left to the AI step (an empty cell would still get the symbol)', () => {
    const inRows: V[][] = amounts.map((x, i) => [`I${i + 1}`, i === 2 ? null : x]);
    const outRows = inRows.map((r) => [r[0]!, r[1] === null ? null : `₪${fmt(r[1] as number)}`]);
    const { result } = build(['Invoice', 'Amount'], inRows, ['Invoice', 'Amount'], outRows);
    expect(result).toMatchObject({ reason: 'columnNotFullyExplained' });
  });
});

// ---------------------------------------------------------------------------
// 6. A whole part of a text: split(x, separator, n).
// ---------------------------------------------------------------------------

describe('split has a rule form', () => {
  const refs = ['INVOICE-1042-A', 'CRD-77', 'PAYMENT-5', 'REF-300-B-2', 'CREDIT-1209', 'INV-88-C', 'PAY-9', 'ADJUST-4'];
  const part = (t: string, i: number, sep: string): string => {
    const parts = t.split(sep);
    return (i > 0 ? parts[i - 1] : parts[parts.length + i]) ?? '';
  };

  it('the first part before a separator', () => {
    const inRows: V[][] = refs.map((t, i) => [`R${i + 1}`, t]);
    const outRows = inRows.map((r) => [r[0]!, part(r[1] as string, 1, '-')]);
    const { rules } = built(['Line', 'Reference'], inRows, ['Line', 'Type'], outRows);
    expect(rules.transform.computed[0]!.expr).toEqual({ op: 'split', arg: { col: expect.any(String) }, separator: '-', index: 1 });
    expect(convert(rules, ['Line', 'Reference'], [['N1', 'CREDIT-5-X'], ['N2', 'PAY-1']])).toEqual([['N1', 'CREDIT'], ['N2', 'PAY']]);
  });

  it('the last part, counted from the end, when the texts have different numbers of parts', () => {
    const inRows: V[][] = refs.map((t, i) => [`R${i + 1}`, t]);
    const outRows = inRows.map((r) => [r[0]!, part(r[1] as string, -1, '-')]);
    const { rules } = built(['Line', 'Reference'], inRows, ['Line', 'Tail'], outRows);
    expect(rules.transform.computed[0]!.expr).toEqual({ op: 'split', arg: { col: expect.any(String) }, separator: '-', index: -1 });
  });

  it('a part with spaces around it is trimmed', () => {
    const lists = ['Cohen/ Dana Maria', 'Levi/ Yossi/ Jr', 'Mizrahi/ Noa Ruth', 'Peretz/ Omer/ Sr', 'Katz/ Maya', 'Azulay/ Ben Aaron'];
    const inRows: V[][] = lists.map((t, i) => [`P${i + 1}`, t]);
    const outRows = inRows.map((r) => [r[0]!, part(r[1] as string, -1, '/').trim()]);
    const { rules } = built(['Id', 'Name'], inRows, ['Id', 'Last'], outRows);
    expect(rules.transform.computed[0]!.expr).toMatchObject({ op: 'trim', arg: { op: 'split', separator: '/', index: -1 } });
  });

  it('the strict rules still apply: the separator must cut at least 3 different texts', () => {
    const texts = ['X-1', 'Y-2', 'X-1', 'Y-2', 'X-1', 'Y-2', 'X-1', 'Y-2'];
    const inRows: V[][] = texts.map((t, i) => [`R${i + 1}`, t]);
    const outRows = inRows.map((r) => [r[0]!, part(r[1] as string, 1, '-')]);
    const { result } = build(['Line', 'Reference'], inRows, ['Line', 'Type'], outRows);
    expect(result).toMatchObject({ reason: 'thinEvidence' });
  });

  it('the strict rules still apply: "the last word" and "the 2nd word" cannot be told apart when every text has 2 words', () => {
    const names = ['Dana Cohen', 'Yossi Levi', 'Noa Mizrahi', 'Omer Peretz', 'Maya Katz', 'Ben Azulay'];
    const inRows: V[][] = names.map((t, i) => [`P${i + 1}`, t]);
    const outRows = inRows.map((r) => [r[0]!, part(r[1] as string, -1, ' ')]);
    const { result } = build(['Id', 'Full name'], inRows, ['Id', 'Family'], outRows);
    expect(result).toMatchObject({ reason: 'ambiguousColumn' });
  });

  it('the local partial result builds it too', () => {
    const inRows: V[][] = refs.map((t, i) => [`R${i + 1}`, t]);
    const outRows = inRows.map((r) => [r[0]!, part(r[1] as string, 1, '-'), `x${(r[0] as string).length}${r[0] as string}`.toUpperCase().split('').reverse().join('')]);
    const a = analyzePair(xlsx([['Line', 'Reference'], ...inRows]), xlsx([['Line', 'Type', 'Mark'], ...outRows]));
    if (!a.ok) throw new Error('analysis failed');
    const partial = partialRules(a, preflight(a, 'registered'));
    if (!('rules' in partial)) throw new Error('partial failed');
    expect(partial.solved).toContain('Type');
  });
});

// ---------------------------------------------------------------------------
// 7. A text that differs from its source in more than whitespace is not a "normalize".
// ---------------------------------------------------------------------------

describe('normalize only holds where the text is exactly what trim (and one case change) writes', () => {
  const names = ['dana cohen', 'yossi levi', 'noa mizrahi', 'omer peretz', 'maya katz', 'ben azulay'];
  const proper = (t: string): string => t.replace(/\b\w/g, (c) => c.toUpperCase());

  it('a proper case is not trim(x)', () => {
    const inRows: V[][] = names.map((t, i) => [`P${i + 1}`, t]);
    const outRows = inRows.map((r) => [r[0]!, proper(r[1] as string)]);
    const { a, result } = build(['Id', 'Name'], inRows, ['Id', 'Name'], outRows);
    expect(a.columns[1]!.relations.some((r) => r.rel === 'normalize' && r.coverage === 1)).toBe(false);
    expect(result).toMatchObject({ reason: 'columnNotFullyExplained' });
  });

  it('upper case still is', () => {
    const inRows: V[][] = names.map((t, i) => [`P${i + 1}`, t]);
    const outRows = inRows.map((r) => [r[0]!, (r[1] as string).toUpperCase()]);
    const { rules } = built(['Id', 'Name'], inRows, ['Id', 'Name'], outRows);
    expect(rules.transform.computed[0]!.expr).toMatchObject({ op: 'upper' });
    expect(cellV('x')).toBe('x');
  });
});
