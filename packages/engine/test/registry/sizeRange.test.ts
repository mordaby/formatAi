// "Same name, different size" (SPEC 5 C, 8.15, owner decision 2026-10-08): the size range of a number column from an example input, and the check of a
// file against it. Synthetic, domain-neutral rules and numbers; the outputs are decade exponents - never a value.
import Decimal from 'decimal.js';
import { limits, type LearnResult } from '@formatai/shared';
import { describe, expect, it } from 'vitest';
import { readWorkbook } from '../../src/io/read';
import { runRules } from '../../src/pipeline';
import { fileSizeGaps, isFarFromRange, magnitudesOf, medianDecadeOf, sizeGapsOf, sizeRangeOfMagnitudes, sizeRangesOf, withSizeRanges } from '../../src/registry';
import { col, rules, table } from '../pipeline/helpers';

const dec = (...n: number[]): Decimal[] => n.map((x) => new Decimal(x)).sort((a, b) => a.cmp(b));

/** Total (a number, read), Count (a number, read), Note (text) and Spare (a number nothing reads). */
function base(extra: { total?: Partial<LearnResult['input']['columns'][number]>; readAs?: Record<string, string> } = {}): LearnResult {
  return rules({
    columns: [
      col('total', 'decimal', { ...(extra.readAs ? { readAs: extra.readAs } : {}), ...extra.total }),
      col('count', 'integer'),
      col('note', 'text'),
      col('spare', 'decimal'),
    ],
    out: ['total', 'count', 'note'],
  });
}
const HEADERS = ['total', 'count', 'note', 'spare'];
const rowsOf = (totals: (number | string | null)[]): (number | string | null)[][] => totals.map((t, i) => [t, i + 1, 'x', 9999]);

describe('decades', () => {
  it('are floor(log10 |v|), exactly, around every power of ten', () => {
    const decade = (v: number) => sizeRangeOfMagnitudes(dec(v, v, v));
    expect(decade(0.05)).toEqual({ lo: -2, hi: -2 });
    expect(decade(0.5)).toEqual({ lo: -1, hi: -1 });
    expect(decade(1)).toEqual({ lo: 0, hi: 0 });
    expect(decade(9.99)).toEqual({ lo: 0, hi: 0 });
    expect(decade(10)).toEqual({ lo: 1, hi: 1 });
    expect(decade(999)).toEqual({ lo: 2, hi: 2 });
    expect(decade(1000)).toEqual({ lo: 3, hi: 3 });
    expect(decade(12_345_678)).toEqual({ lo: 7, hi: 7 });
  });

  it('are clamped to the bounds the schema accepts', () => {
    expect(sizeRangeOfMagnitudes(dec(1e-20, 1e-20, 1e-20))).toEqual({ lo: limits.matching.sizeMinExponent, hi: limits.matching.sizeMinExponent });
    expect(sizeRangeOfMagnitudes(dec(1e30, 1e30, 1e30))).toEqual({ lo: limits.matching.sizeMaxExponent, hi: limits.matching.sizeMaxExponent });
  });
});

describe('the range of an example (percentiles, nearest rank)', () => {
  it('is the decade of the 10th and the 90th percentile', () => {
    // 10 values in the units and 10 in the thousands: the 10th percentile is the 2nd value (5), the 90th the 18th (5000).
    const values = dec(...Array.from({ length: 10 }, () => 5), ...Array.from({ length: 10 }, () => 5000));
    expect(sizeRangeOfMagnitudes(values)).toEqual({ lo: 0, hi: 3 });
  });

  it('does not let one huge total or a few tiny typos stretch it', () => {
    const body = Array.from({ length: 18 }, (_, i) => 2000 + i * 100);
    expect(sizeRangeOfMagnitudes(dec(0.001, ...body, 90_000_000))).toEqual({ lo: 3, hi: 3 });
  });

  it('with three values is their decades; fewer than three claims nothing', () => {
    expect(sizeRangeOfMagnitudes(dec(4, 40, 4000))).toEqual({ lo: 0, hi: 3 });
    expect(sizeRangeOfMagnitudes(dec(4, 40))).toBeNull();
    expect(sizeRangeOfMagnitudes([])).toBeNull();
    expect(limits.matching.sizeMinValues).toBe(3);
  });
});

describe('what counts as a value (read the way a run reads it)', () => {
  const t = (cells: (number | string | null)[]) => table(HEADERS, rowsOf(cells));
  const read = (cells: (number | string | null)[], column = base().input.columns[0]!) => magnitudesOf(column, 0, t(cells), 'he').map(String);

  it('is the absolute value: a negative total is as big as a positive one', () => {
    expect(read([-1200, 3400, -56_000])).toEqual(['1200', '3400', '56000']);
  });

  it('leaves out zeros, empty cells and text that is not a number', () => {
    expect(read([0, null, 'abc', '', 7, '0.00', '1,500'])).toEqual(['7', '1500']);
  });

  it('reads text numbers like a run does (thousands separators, a minus sign)', () => {
    expect(read(['1,234.5', '-2,000', '30'])).toEqual(['30', '1234.5', '2000']);
  });

  it('applies the column\'s readAs first, exactly as a run does: "N/A" read as empty is no value, "none" read as 0 is a zero', () => {
    const column = base({ readAs: { 'N/A': '', none: '0', many: '1,000' } }).input.columns[0]!;
    expect(read(['N/A', 'none', 'many', 'n/a', 50], column)).toEqual(['50', '1000']);
  });

  it('a column the file does not have has no values', () => {
    expect(magnitudesOf(base().input.columns[0]!, -1, t([1, 2, 3]), 'he')).toEqual([]);
  });

  it('agrees with a run: whatever the run flags as not a number is not counted', () => {
    const r = base();
    const tbl = t([10, 'oops', 20, 'N/A', 30]);
    const res = runRules(r, tbl);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const flagged = res.flags.filter((f) => f.column === 'total').map((f) => f.rowNumber);
    expect(flagged).toEqual([3, 5]);
    expect(read([10, 'oops', 20, 'N/A', 30])).toEqual(['10', '20', '30']);
  });
});

describe('the median and "far" (the boundary examples)', () => {
  it('the median is the middle value; with an even count the mean of the two in the middle', () => {
    expect(medianDecadeOf(dec(1, 5, 900))).toBe(0);
    expect(medianDecadeOf(dec(5, 50, 500, 5000))).toBe(2); // (50 + 500) / 2 = 275
    expect(medianDecadeOf(dec(5, 6))).toBeNull();
  });

  it('saved thousands to tens of thousands (3..4), one decade of margin', () => {
    const saved = { lo: 3, hi: 4 };
    const far = (median: number) => isFarFromRange(saved, medianDecadeOf(dec(median, median, median))!);
    expect(far(12)).toBe(true); // tens: two decades under the thousands
    expect(far(99)).toBe(true); // < 10^(3-1)
    expect(far(100)).toBe(false); // exactly 10^(3-1): inside the margin
    expect(far(300)).toBe(false);
    expect(far(5000)).toBe(false);
    expect(far(500_000)).toBe(false); // < 10^(4+1+1)
    expect(far(999_999)).toBe(false);
    expect(far(1_000_000)).toBe(true); // >= 10^(4+1+1)
    expect(far(40_000_000)).toBe(true);
    expect(limits.matching.sizeMarginDecades).toBe(1);
  });
});

describe('sizeRangesOf / withSizeRanges: the end of a learn', () => {
  const example = table(HEADERS, [
    [1200, 3, 'a', 8],
    [3400, 5, 'b', 8],
    [25_000, 9, 'c', 8],
    [41_000, 12, 'd', 8],
  ]);

  it('gives each number column the rules USE its range; text and columns nothing reads get none', () => {
    expect(sizeRangesOf(base(), example)).toEqual({ total: { lo: 3, hi: 4 }, count: { lo: 0, hi: 1 } });
  });

  it('a column with fewer than three non-zero values gets none', () => {
    const few = table(HEADERS, [[0, 0, 'a', 1], [5000, 0, 'b', 1], [null, 2, 'c', 1], [0, 3, 'd', 1]]);
    expect(sizeRangesOf(base(), few)).toEqual({});
  });

  it('writes the ranges into the rules, nothing else, and leaves the input alone', () => {
    const r = base();
    const frozen = JSON.stringify(r);
    const out = withSizeRanges(r, example);
    expect(JSON.stringify(r)).toBe(frozen);
    expect(out.input.columns.map((c) => [c.id, c.range])).toEqual([
      ['total', { lo: 3, hi: 4 }],
      ['count', { lo: 0, hi: 1 }],
      ['note', undefined],
      ['spare', undefined],
    ]);
    expect({ ...out, input: { ...out.input, columns: out.input.columns.map(({ range: _r, ...c }) => c) } }).toEqual(r);
  });

  it('is the same object when nothing changes, and replaces a stale range', () => {
    const once = withSizeRanges(base(), example);
    expect(withSizeRanges(once, example)).toBe(once);
    const stale = withSizeRanges(base({ total: { range: { lo: 0, hi: 0 } } }), example);
    expect(stale.input.columns[0]!.range).toEqual({ lo: 3, hi: 4 });
  });

  it('takes a range off a column that is not a used number any more', () => {
    const r = rules({ columns: [col('total', 'text', { range: { lo: 1, hi: 2 } }), col('spare', 'decimal', { range: { lo: 1, hi: 2 } })], out: ['total'] });
    const out = withSizeRanges(r, table(['total', 'spare'], [['a', 5], ['b', 6], ['c', 7]]));
    expect(out.input.columns.some((c) => c.range !== undefined)).toBe(false);
  });
});

describe('sizeGapsOf: a file against the saved ranges', () => {
  const saved = (range?: { lo: number; hi: number }) => base({ total: range ? { range } : {} });
  const file = (totals: (number | string | null)[]) => table(HEADERS, rowsOf(totals));

  it('flags a column whose median is far from what the format was learned on, with the sizes (no value)', () => {
    const gaps = sizeGapsOf(saved({ lo: 3, hi: 4 }), file([12, 30, 7, 41, 9]));
    expect(gaps).toEqual([{ id: 'total', header: 'total', saved: { lo: 3, hi: 4 }, file: { lo: 0, hi: 1 }, median: 1 }]);
    expect(Object.values(gaps[0]!).flatMap((v) => (typeof v === 'object' ? Object.values(v) : [v])).every((v) => typeof v === 'number' || v === 'total')).toBe(true);
  });

  it('does not flag a file inside the margin: 300 and 500,000 against thousands to tens of thousands', () => {
    expect(sizeGapsOf(saved({ lo: 3, hi: 4 }), file([300, 300, 300]))).toEqual([]);
    expect(sizeGapsOf(saved({ lo: 3, hi: 4 }), file([500_000, 500_000, 500_000]))).toEqual([]);
    expect(sizeGapsOf(saved({ lo: 3, hi: 4 }), file([2000, 15_000, 33_000, 8000]))).toEqual([]);
  });

  it('flags too-big files the same way', () => {
    expect(sizeGapsOf(saved({ lo: 3, hi: 4 }), file([2_000_000, 3_000_000, 9_000_000])).map((g) => g.id)).toEqual(['total']);
  });

  it('the MEDIAN decides: a few tiny or huge values around a normal month do not', () => {
    expect(sizeGapsOf(saved({ lo: 3, hi: 4 }), file([2, 4000, 5000, 6000, 7000, 8_000_000]))).toEqual([]);
    expect(sizeGapsOf(saved({ lo: 3, hi: 4 }), file([2, 3, 4, 5, 6000, 7000]))).toHaveLength(1);
  });

  it('claims nothing from fewer than three non-zero values in the file', () => {
    expect(sizeGapsOf(saved({ lo: 3, hi: 4 }), file([5, 6, 0, null, 0]))).toEqual([]);
  });

  it('claims nothing for rules with no range (old stored rules), a column the file lacks, or a column nothing reads', () => {
    expect(sizeGapsOf(saved(), file([1, 2, 3]))).toEqual([]);
    const lacking = table(['count', 'note'], [[1, 'a'], [2, 'b'], [3, 'c']]);
    expect(sizeGapsOf(saved({ lo: 3, hi: 4 }), lacking)).toEqual([]);
    const spare = base();
    spare.input.columns[3] = { ...spare.input.columns[3]!, range: { lo: 8, hi: 9 } };
    expect(sizeGapsOf(spare, file([1, 2, 3]))).toEqual([]);
  });

  it('finds the column the way a run does: by alias too', () => {
    const r = saved({ lo: 3, hi: 4 });
    r.input.columns[0] = { ...r.input.columns[0]!, header: 'Total', aliases: ['Sum'] };
    const aliased = table(['Sum', 'count', 'note', 'spare'], rowsOf([12, 13, 14]));
    expect(sizeGapsOf(r, aliased).map((g) => g.header)).toEqual(['Total']);
  });
});

describe('fileSizeGaps: one file, several formats', () => {
  const csv = 'total,count,note,spare\n12,1,x,9\n30,2,x,9\n7,3,x,9\n41,4,x,9\n';
  const open = () => readWorkbook(new TextEncoder().encode(csv), 'f.csv');

  it('answers per rules, in order; rules with no range claim nothing', async () => {
    const wb = await open();
    const learnedBig = base({ total: { range: { lo: 3, hi: 4 } } });
    const learnedSmall = base({ total: { range: { lo: 0, hi: 1 } } });
    const old = base();
    const out = fileSizeGaps(wb, [learnedBig, learnedSmall, old]);
    expect(out.map((gaps) => gaps.map((g) => g.id))).toEqual([['total'], [], []]);
    expect(out[0]![0]).toMatchObject({ saved: { lo: 3, hi: 4 }, file: { lo: 0, hi: 1 }, median: 1 });
  });

  it('gives what sizeGapsOf gives on the table a run reads (one reading)', async () => {
    const wb = await open();
    const r = base({ total: { range: { lo: 3, hi: 4 } } });
    const tbl = table(['total', 'count', 'note', 'spare'], [[12, 1, 'x', 9], [30, 2, 'x', 9], [7, 3, 'x', 9], [41, 4, 'x', 9]]);
    expect(fileSizeGaps(wb, [r])[0]).toEqual(sizeGapsOf(r, tbl));
  });

  it('a sheet the rules cannot be read from claims nothing', async () => {
    const wb = await open();
    const r = base({ total: { range: { lo: 3, hi: 4 } } });
    r.input.sheet = { pick: 'name', name: 'Nope' };
    expect(fileSizeGaps(wb, [r])).toEqual([[]]);
  });
});
