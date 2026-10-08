// The size range of a number column (SPEC 5 C, 8.15, 2026-10-08): the schema (optional, two bounded integers), the union a new version keeps, and
// the widening "Run anyway" asks for (it can only grow).
import { describe, expect, it } from 'vitest';
import { limits } from '../src/config/limits';
import { InputColumnSchema, RulesSchema, type InputColumn, type LearnResult, type Rules } from '../src/rules/schema';
import { WidenRangesBodySchema, isNumberColumnType, keepWiderRanges, rangeCovers, unionRange, widenRanges, withoutRanges } from '../src/sizeRange';

function rules(columns: InputColumn[]): Rules {
  return {
    schemaVersion: 1,
    input: { sheet: { pick: 'first' }, headerRow: 'auto', columns },
    transform: { computed: [], valueMaps: [], sort: [] },
    output: { sheetName: 'Out', direction: 'ltr', language: 'en', titleRows: [], columns: columns.map((c) => ({ header: c.header, from: c.id })) },
    validations: [],
    unsupported: [],
    assumptions: [],
    name: 'R',
    meta: { source: 'examplePair', status: 'verified' },
  };
}

const total = (range?: { lo: number; hi: number }): InputColumn => ({ id: 'total', header: 'Total', type: 'decimal', ...(range ? { range } : {}) });
const note: InputColumn = { id: 'note', header: 'Note', type: 'text' };
const rangeOf = (r: Rules, id = 'total') => r.input.columns.find((c) => c.id === id)?.range;

describe('the schema', () => {
  it('range is optional: old rules without one load unchanged', () => {
    expect(InputColumnSchema.safeParse({ id: 'a', header: 'A', type: 'decimal' }).success).toBe(true);
    expect(RulesSchema.safeParse(rules([total()])).success).toBe(true);
  });

  it('takes two integers, lo not above hi, inside the bounds', () => {
    const ok = (range: unknown) => InputColumnSchema.safeParse({ id: 'a', header: 'A', type: 'decimal', range }).success;
    expect(ok({ lo: 3, hi: 4 })).toBe(true);
    expect(ok({ lo: 3, hi: 3 })).toBe(true);
    expect(ok({ lo: limits.matching.sizeMinExponent, hi: limits.matching.sizeMaxExponent })).toBe(true);
    expect(ok({ lo: 4, hi: 3 })).toBe(false);
    expect(ok({ lo: limits.matching.sizeMinExponent - 1, hi: 0 })).toBe(false);
    expect(ok({ lo: 0, hi: limits.matching.sizeMaxExponent + 1 })).toBe(false);
    expect(ok({ lo: 1.5, hi: 3 })).toBe(false);
    expect(ok({ lo: 3 })).toBe(false);
    expect(ok({ lo: 3, hi: 4, min: 5 })).toBe(false); // nothing but the two integers: no value, no min or max
    expect(ok('thousands')).toBe(false);
  });
});

describe('number types', () => {
  it('are integer, decimal, currency and percent only', () => {
    expect((['integer', 'decimal', 'currency', 'percent'] as const).every((t) => isNumberColumnType(t))).toBe(true);
    expect((['text', 'date', 'boolean', 'idLike'] as const).some((t) => isNumberColumnType(t))).toBe(false);
  });
});

describe('union and cover', () => {
  it('takes the lowest lo and the highest hi', () => {
    expect(unionRange({ lo: 3, hi: 4 }, { lo: 1, hi: 2 })).toEqual({ lo: 1, hi: 4 });
    expect(unionRange({ lo: 3, hi: 4 }, { lo: 3, hi: 6 })).toEqual({ lo: 3, hi: 6 });
    expect(rangeCovers({ lo: 1, hi: 4 }, { lo: 2, hi: 3 })).toBe(true);
    expect(rangeCovers({ lo: 1, hi: 4 }, { lo: 0, hi: 3 })).toBe(false);
  });
});

describe('a new version keeps the wider range (keepWiderRanges)', () => {
  it('both have one: the union', () => {
    const next = keepWiderRanges(rules([total({ lo: 3, hi: 4 })]), rules([total({ lo: 2, hi: 3 })]));
    expect(rangeOf(next)).toEqual({ lo: 2, hi: 4 });
  });

  it('only the previous has one (too few values this time): it is kept', () => {
    expect(rangeOf(keepWiderRanges(rules([total({ lo: 3, hi: 4 })]), rules([total()])))).toEqual({ lo: 3, hi: 4 });
  });

  it('only the new one has one, or there is no previous version: the new one stands', () => {
    expect(rangeOf(keepWiderRanges(rules([total()]), rules([total({ lo: 1, hi: 2 })])))).toEqual({ lo: 1, hi: 2 });
    expect(rangeOf(keepWiderRanges(null, rules([total({ lo: 1, hi: 2 })])))).toEqual({ lo: 1, hi: 2 });
  });

  it('is by column id, and a column that is no longer a number has none', () => {
    const prev = rules([total({ lo: 3, hi: 4 }), { id: 'qty', header: 'Qty', type: 'integer', range: { lo: 0, hi: 1 } }]);
    const next = rules([{ ...total({ lo: 0, hi: 0 }), type: 'text' }, { id: 'amount', header: 'Qty', type: 'integer', range: { lo: 5, hi: 6 } }]);
    const out = keepWiderRanges(prev, next);
    expect(rangeOf(out)).toBeUndefined(); // text now
    expect(rangeOf(out, 'amount')).toEqual({ lo: 5, hi: 6 }); // another id: not the previous qty's
  });

  it('returns the same object when nothing changes, and never mutates its inputs', () => {
    const prev = rules([total({ lo: 3, hi: 4 })]);
    const next = rules([total({ lo: 2, hi: 5 })]);
    const frozen = JSON.stringify([prev, next]);
    expect(keepWiderRanges(prev, next)).toBe(next);
    const narrower = rules([total({ lo: 3, hi: 4 })]);
    expect(keepWiderRanges(prev, narrower)).toBe(narrower);
    keepWiderRanges(prev, rules([total({ lo: 1, hi: 1 })]));
    expect(JSON.stringify([prev, next])).toBe(frozen);
  });
});

describe('widening (Run anyway)', () => {
  it("grows the saved range to include the file's", () => {
    const { rules: out, widened } = widenRanges(rules([total({ lo: 3, hi: 4 })]), { total: { lo: 1, hi: 2 } });
    expect(rangeOf(out)).toEqual({ lo: 1, hi: 4 });
    expect(widened).toEqual(['total']);
  });

  it('can never narrow: a range inside the saved one changes nothing', () => {
    const start = rules([total({ lo: 3, hi: 4 })]);
    const { rules: out, widened } = widenRanges(start, { total: { lo: 3, hi: 3 } });
    expect(out).toBe(start);
    expect(widened).toEqual([]);
  });

  it('ignores an unknown id, a column that is not a number, and a column that has no range', () => {
    const start = rules([total(), note]);
    const { rules: out, widened } = widenRanges(start, { nope: { lo: 0, hi: 1 }, note: { lo: 0, hi: 1 }, total: { lo: 0, hi: 1 }, constructor: { lo: 0, hi: 1 } });
    expect(out).toBe(start);
    expect(widened).toEqual([]);
  });

  it('never mutates the rules it is given', () => {
    const start = rules([total({ lo: 3, hi: 4 })]);
    const frozen = JSON.stringify(start);
    widenRanges(start, { total: { lo: 0, hi: 9 } });
    expect(JSON.stringify(start)).toBe(frozen);
  });
});

describe('withoutRanges', () => {
  it('takes every range out and nothing else', () => {
    const start = rules([total({ lo: 3, hi: 4 }), note]);
    const out = withoutRanges<LearnResult>(start);
    expect(out.input.columns).toEqual([{ id: 'total', header: 'Total', type: 'decimal' }, note]);
    const none = rules([note]);
    expect(withoutRanges(none)).toBe(none);
  });
});

describe("the widen route's body", () => {
  it('is a map of column id to a bounded range, and nothing else', () => {
    const ok = (b: unknown) => WidenRangesBodySchema.safeParse(b).success;
    expect(ok({ columns: { total: { lo: 1, hi: 2 } } })).toBe(true);
    expect(ok({ columns: {} })).toBe(true);
    expect(ok({ columns: { total: { lo: 9, hi: 2 } } })).toBe(false);
    expect(ok({ columns: { total: { lo: 0, hi: 99 } } })).toBe(false);
    expect(ok({ columns: { total: { lo: 0, hi: 1, median: 5 } } })).toBe(false);
    expect(ok({ columns: { total: { lo: 0, hi: 1 } }, extra: 1 })).toBe(false);
    expect(ok({})).toBe(false);
  });
});
