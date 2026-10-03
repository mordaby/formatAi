// relationsToHints: every relation kind converts to its LEARN_PROMPT §3 Hint
// shape, analyze-only fields (normalize.case, concat.skipEmpty, mulConst/
// addConst.constText, matched/total/failCount) are stripped, `split` (no Hint
// equivalent) yields no hint, dropped-row hints (filter, dedupe) and expand
// hints (columnsToRows, splitCell, fixedFanOut) build correctly, and the
// widened `aggregate.fn` (SummaryAgg) comes through for a summary shape.
import { describe, expect, it } from 'vitest';
import type { ColumnHint, Hint } from '@formatai/shared';
import { relationsToHints } from '../../src/learn/hints';
import { preflight } from '../../src/learn/preflight';
import { formatYmd, serialToYmd } from '../../src/values/dates';
import { padLeft } from '../../src/values/text';
import { analyzeOk, dec, pick, rng, serial, xlsx, xround, type V } from './analyze/helpers';

function hintOut(hints: Hint[], out: number): Hint | undefined {
  return hints.find((h) => 'out' in h && h.out === out);
}

// ---------------------------------------------------------------------------
// One output column per relation kind (adapted from analyze/relations.test.ts's
// "one output column per relation type" fixture).
// ---------------------------------------------------------------------------

const FIRST = ['Dana', 'Omer', 'Lior', 'Noa'];
const LAST = ['Levi', 'Cohen', 'Mizrahi'];
const STATUS = ['active', 'closed', 'pending'];
const STATUS_CODE: Record<string, string> = { active: 'A', closed: 'C', pending: 'P' };

const IN_HEADERS = ['ID', 'Code', 'First', 'Last', 'Status', 'Qty', 'Price', 'Start', 'Ref'];
const OUT_HEADERS = ['Ref #', 'Name', 'STATUS', 'Status code', 'Prefix', 'Suffix', 'Total', 'With tax', 'Plus fee', 'Diff', 'Ratio', 'Sum3', 'Start text', 'Price text', 'Source', 'Copy ID', 'External'];

function pair(n: number) {
  const r = rng(11);
  const input: V[][] = [IN_HEADERS];
  const output: V[][] = [OUT_HEADERS];
  for (let i = 0; i < n; i++) {
    const id = 100 + i;
    const code = `${pick(r, ['AB', 'CD'])}-${1000 + i * 7}`;
    const first = pick(r, FIRST);
    const last = pick(r, LAST);
    const status = pick(r, STATUS);
    const qty = 1 + Math.floor(r() * 20);
    const price = xround(5 + r() * 4000, 2);
    const start = serial(2024, 1 + (i % 12), 1 + (i % 28));
    const ref = 40 + i * 37;
    input.push([id, code, first, last, status, qty, price, { v: start, isDate: true, z: 'dd/mm/yyyy' }, ref]);
    output.push([
      padLeft(String(ref), 6, '0'),
      `${first} ${last}`,
      status.toUpperCase(),
      STATUS_CODE[status]!,
      code.slice(0, 2),
      code.slice(-1),
      dec(qty).times(price).toNumber(),
      dec(price).times(1.17).toDecimalPlaces(2, 4).toNumber(),
      dec(price).plus(2.5).toNumber(),
      dec(price).minus(qty).toNumber(),
      dec(price).div(qty).toDecimalPlaces(2, 4).toNumber(),
      dec(id).plus(qty).plus(price).toNumber(),
      formatYmd(serialToYmd(start), 'YYYY-MM-DD', 'en'),
      dec(price).toFixed(2),
      'WEB',
      id,
      Math.floor(r() * 100000),
    ]);
  }
  return { input: xlsx(input), output: xlsx(output) };
}

describe('relationsToHints: one hint per relation kind', () => {
  const { input, output } = pair(40);
  const a = analyzeOk(input, output);
  const pf = preflight(a, 'registered');
  const hints = relationsToHints(a, pf);

  it('copy', () => {
    expect(hintOut(hints, 15)).toEqual({ rel: 'copy', in: [0], out: 15, coverage: 1 });
  });

  it('normalize strips "case"', () => {
    expect(hintOut(hints, 2)).toEqual({ rel: 'normalize', in: [4], out: 2, coverage: 1 });
  });

  it('padLeft', () => {
    expect(hintOut(hints, 0)).toEqual({ rel: 'padLeft', in: [8], length: 6, char: '0', out: 0, coverage: 1 });
  });

  it('substr (prefix and suffix)', () => {
    expect(hintOut(hints, 4)).toEqual({ rel: 'substr', in: [1], from: 'start', length: 2, out: 4, coverage: 1 });
    expect(hintOut(hints, 5)).toEqual({ rel: 'substr', in: [1], from: 'end', length: 1, out: 5, coverage: 1 });
  });

  it('concat strips "skipEmpty"', () => {
    expect(hintOut(hints, 1)).toEqual({ rel: 'concat', in: [2, 3], separator: ' ', out: 1, coverage: 1 });
  });

  it('valueMap with its pairs', () => {
    expect(hintOut(hints, 3)).toEqual({
      rel: 'valueMap',
      in: [4],
      pairs: [
        ['active', 'A'],
        ['closed', 'C'],
        ['pending', 'P'],
      ],
      out: 3,
      coverage: 1,
    });
  });

  it('constant', () => {
    expect(hintOut(hints, 14)).toEqual({ rel: 'constant', in: [], value: 'WEB', out: 14, coverage: 1 });
  });

  it('dateFormat', () => {
    expect(hintOut(hints, 12)).toEqual({ rel: 'dateFormat', in: [7], from: 'date', to: 'YYYY-MM-DD', out: 12, coverage: 1 });
  });

  it('mul of two columns (qty x price)', () => {
    expect(hintOut(hints, 6)).toEqual({ rel: 'mul', in: [5, 6], out: 6, coverage: 1 });
  });

  it('numberFormat (price rendered to a fixed 2 decimals)', () => {
    expect(hintOut(hints, 13)).toEqual({ rel: 'numberFormat', in: [6], format: '0.00', out: 13, coverage: 1 });
  });

  it('mulConst strips "constText"', () => {
    expect(hintOut(hints, 7)).toEqual({ rel: 'mulConst', in: [6], const: 1.17, round: 2, out: 7, coverage: 1 });
  });

  it('addConst (no rounding needed)', () => {
    expect(hintOut(hints, 8)).toEqual({ rel: 'addConst', in: [6], const: 2.5, out: 8, coverage: 1 });
  });

  it('sub and div', () => {
    expect(hintOut(hints, 9)).toEqual({ rel: 'sub', in: [6, 5], out: 9, coverage: 1 });
    expect(hintOut(hints, 10)).toEqual({ rel: 'div', in: [6, 5], round: 2, out: 10, coverage: 1 });
  });

  it('sum of three columns', () => {
    expect(hintOut(hints, 11)).toEqual({ rel: 'sum', in: [0, 5, 6], out: 11, coverage: 1 });
  });

  it('unknown (external) column gets no hint, and is NOT in skipColumns (the AI step tries it)', () => {
    expect(pf.skipColumns).toEqual([]);
    expect(hintOut(hints, 16)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// split: no Hint equivalent - the column simply gets no hint from it.
// ---------------------------------------------------------------------------

describe('relationsToHints: split has no Hint equivalent', () => {
  it('a column whose only coverage-1.0 relation is split gets no hint at all', () => {
    const input: V[][] = [['Code', 'X']];
    const output: V[][] = [['Part', 'X']];
    const parts = ['1', '22', '333', '4', '55555', '6', '77', '888', '9', '10'];
    parts.forEach((p, i) => {
      input.push([`AB${i}-${p}`, i]);
      output.push([p, i]);
    });
    const a = analyzeOk(xlsx(input), xlsx(output));
    const rel = a.columns[0]!.relations.find((r) => r.coverage === 1);
    expect(rel?.rel).toBe('split');

    const pf = preflight(a, 'registered');
    const hints = relationsToHints(a, pf);
    expect(hintOut(hints, 0)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Dropped rows: filter, dedupe.
// ---------------------------------------------------------------------------

const STATES = ['open', 'done', 'cancelled'];

describe('relationsToHints: dropped rows', () => {
  it('filter at coverage 1: kept/dropped values, no failingRows', () => {
    const input: V[][] = [['Ref', 'State', 'Amount']];
    const output: V[][] = [['Ref', 'Amount']];
    const r = rng(1);
    for (let i = 0; i < 30; i++) {
      const st = i < 3 ? STATES[i]! : pick(r, STATES);
      input.push([`K${i}`, st, 10 + i]);
      if (st !== 'cancelled') output.push([`K${i}`, 10 + i]);
    }
    const a = analyzeOk(xlsx(input), xlsx(output));
    const pf = preflight(a, 'registered');
    const hints = relationsToHints(a, pf);
    const filterHint = hints.find((h) => h.rel === 'filter');
    expect(filterHint).toMatchObject({ rel: 'filter', in: [1], droppedValues: ['cancelled'], coverage: 1 });
    expect(filterHint).not.toHaveProperty('failingRows');
  });

  it('filter below coverage 1: failingRows are the failing rows that are actually dropped', () => {
    const input: V[][] = [['Ref', 'State']];
    const output: V[][] = [['Ref']];
    for (let i = 0; i < 30; i++) {
      const st = STATES[i % 3]!;
      input.push([`K${i}`, st]);
      // Row 4 ("done") is dropped too, against the simple "not cancelled" rule.
      if (st !== 'cancelled' && i !== 4) output.push([`K${i}`]);
    }
    const a = analyzeOk(xlsx(input), xlsx(output), { minCoverage: 0.9 });
    const pf = preflight(a, 'registered');
    const hints = relationsToHints(a, pf);
    const filterHint = hints.find((h) => h.rel === 'filter')!;
    expect(filterHint.coverage).toBeCloseTo(29 / 30);
    expect((filterHint as { failingRows?: number[] }).failingRows).toEqual([4]);
  });

  it('dedupe: keys "all", keep first', () => {
    const base: [string, string, number][] = [
      ['A1', 'north', 10],
      ['B2', 'south', 20],
      ['C3', 'east', 30],
      ['D4', 'west', 40],
      ['E5', 'north', 50],
    ];
    const input: V[][] = [['Code', 'Zone', 'Qty'], ...base, base[1]!, base[3]!];
    const output: V[][] = [['Code', 'Zone', 'Qty'], ...base];
    const a = analyzeOk(xlsx(input), xlsx(output));
    const pf = preflight(a, 'registered');
    const hints = relationsToHints(a, pf);
    expect(hints.find((h) => h.rel === 'dedupe')).toEqual({ rel: 'dedupe', in: [0, 1, 2], keys: 'all', keep: 'first', coverage: 1 });
  });
});

// ---------------------------------------------------------------------------
// Expand: columnsToRows, splitCell, fixedFanOut (fixtures from analyze/shape.test.ts).
// ---------------------------------------------------------------------------

describe('relationsToHints: expand', () => {
  it('columnsToRows (skipping empty cells)', () => {
    const input: V[][] = [['Id', 'Owner', 'Jan', 'Feb', 'Mar']];
    const output: V[][] = [['Id', 'Owner', 'Month', 'Amount']];
    const r = rng(4);
    for (let i = 0; i < 12; i++) {
      const cells = [0, 1, 2].map(() => (r() < 0.25 ? null : 10 + Math.floor(r() * 90)));
      if (i === 5) cells.fill(null);
      input.push([i + 1, `owner ${i}`, ...cells]);
      ['Jan', 'Feb', 'Mar'].forEach((m, j) => {
        const v = cells[j];
        if (v !== null && v !== undefined) output.push([i + 1, `owner ${i}`, m, v]);
      });
    }
    const a = analyzeOk(xlsx(input), xlsx(output));
    const pf = preflight(a, 'registered');
    const hints = relationsToHints(a, pf);
    expect(hints.find((h) => h.rel === 'expand')).toEqual({
      rel: 'expand',
      mode: 'columnsToRows',
      in: [2, 3, 4],
      labelOut: 2,
      valueOut: 3,
      skipEmpty: true,
      coverage: 1,
    });
  });

  it('splitCell', () => {
    const input: V[][] = [['Team', 'Ref', 'Tags', 'Amount']];
    const output: V[][] = [['Team', 'Ref', 'Tag']];
    const tags = ['red', 'green', 'blue', 'amber'];
    const r = rng(6);
    for (let i = 0; i < 15; i++) {
      const n = 1 + Math.floor(r() * 3);
      const mine = tags.slice(0, n);
      input.push([`team ${i % 3}`, `R${i}`, mine.join('; '), 100 + i]);
      mine.forEach((t) => output.push([`team ${i % 3}`, `R${i}`, t]));
    }
    const a = analyzeOk(xlsx(input), xlsx(output));
    const pf = preflight(a, 'registered');
    const hints = relationsToHints(a, pf);
    expect(hints.find((h) => h.rel === 'expand')).toEqual({ rel: 'expand', mode: 'splitCell', in: [2], separator: ';', out: 2, coverage: 1 });
  });

  it('fixedFanOut, with the constant/mulConst hints per position', () => {
    const input: V[][] = [['Ref', 'Amount']];
    const output: V[][] = [['Ref', 'Side', 'Value']];
    for (let i = 0; i < 10; i++) {
      const amt = 50 + i * 7.5;
      input.push([`J${i}`, amt]);
      output.push([`J${i}`, 'debit', amt]);
      output.push([`J${i}`, 'credit', -amt]);
    }
    const a = analyzeOk(xlsx(input), xlsx(output));
    const pf = preflight(a, 'registered');
    const hints = relationsToHints(a, pf);
    const expandHint = hints.find((h) => h.rel === 'expand');
    if (expandHint?.rel !== 'expand' || expandHint.mode !== 'fixedFanOut') throw new Error('expected fixedFanOut hint');
    expect(expandHint.size).toBe(2);
    const positionHint = (cols: ColumnHint[], out: number): ColumnHint | undefined => cols.find((c) => c.out === out);
    expect(positionHint(expandHint.positions[0]!, 1)).toEqual({ rel: 'constant', in: [], value: 'debit', out: 1, coverage: 1 });
    expect(positionHint(expandHint.positions[1]!, 1)).toEqual({ rel: 'constant', in: [], value: 'credit', out: 1, coverage: 1 });
    expect(positionHint(expandHint.positions[0]!, 2)).toEqual({ rel: 'copy', in: [1], out: 2, coverage: 1 });
    expect(positionHint(expandHint.positions[1]!, 2)).toEqual({ rel: 'mulConst', in: [1], const: -1, out: 2, coverage: 1 });
  });
});

// ---------------------------------------------------------------------------
// aggregate: the widened fn set (SummaryAgg: sum/count/min/max/average/first/last).
// ---------------------------------------------------------------------------

describe('relationsToHints: aggregate (summary shape, widened fn set)', () => {
  it('an average aggregate hint comes through (beyond the old sum/count/min/max set)', () => {
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
    const pf = preflight(a, 'registered');
    const hints = relationsToHints(a, pf);
    expect(hintOut(hints, 5)).toEqual({ rel: 'aggregate', in: [2], fn: 'average', out: 5, coverage: 1 });
    expect(hintOut(hints, 1)).toMatchObject({ rel: 'aggregate', fn: 'count', out: 1, coverage: 1 });
  });
});
