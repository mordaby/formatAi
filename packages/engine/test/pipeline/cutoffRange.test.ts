// The cut-off check (SPEC 8.8, learning-loop proposal 3.4 / 7.1 item 3): a value strictly between the two edges the example left open
// is flagged; the edges themselves and everything outside are not. Numbers and dates. And the check is the conversion's own: it never
// becomes part of the source (SPEC 8.15), and the AI step's wire schema does not offer it.
import { checkRules, learnResultWireJsonSchema, ValidationSchema, type Validation } from '@formatai/shared';
import { describe, expect, it } from 'vitest';
import { sourceOf } from '../../src/registry/sourceOf';
import { typeCheck } from '../../src/check/typeCheck';
import { ymdToSerial } from '../../src/values/dates';
import { col, dateCell, rules, runOk, table } from './helpers';

const serial = (y: number, m: number, d: number) => ymdToSerial({ y, m, d });

describe('cutoffRange: the run-time flag', () => {
  it('flags a number strictly between the edges, with the edges and the value used as params', () => {
    const check: Validation = { column: 'amount', rule: 'cutoffRange', low: 4435, high: 5299, value: 5000, includes: 'high', severity: 'flag' };
    const res = runOk(rules({ columns: [col('amount', 'decimal')], validations: [check] }), table(['amount'], [[4435], [4436], [5000], [5298.99], [5299], [9000], [null]]));
    expect(res.flags.map((f) => [f.rowNumber, f.value, f.messageKey, f.params])).toEqual([
      [3, 4436, 'flag.validation.cutoffRange', { low: 4435, high: 5299, value: 5000 }],
      [4, 5000, 'flag.validation.cutoffRange', { low: 4435, high: 5299, value: 5000 }],
      [5, 5298.99, 'flag.validation.cutoffRange', { low: 4435, high: 5299, value: 5000 }],
    ]);
    expect(res.summary.blockedRows).toEqual([]);
  });

  it('flags a date strictly between two ISO edges', () => {
    const check: Validation = { column: 'd', rule: 'cutoffRange', low: '2026-03-10', high: '2026-03-20', value: '2026-03-15', includes: 'low', severity: 'flag' };
    const res = runOk(
      rules({ columns: [col('d', 'date')], validations: [check] }),
      table(['d'], [[dateCell(serial(2026, 3, 10))], [dateCell(serial(2026, 3, 11))], [dateCell(serial(2026, 3, 20))]]),
    );
    expect(res.flags.map((f) => f.rowNumber)).toEqual([3]);
  });
});

describe('cutoffRange: shape, references and types', () => {
  const base = rules({ columns: [col('amount', 'decimal'), col('d', 'date')] });
  const withCheck = (v: Validation) => ({ ...base, validations: [v] });

  it('is in the stored schema; the wire schema the AI step answers in does not offer it', () => {
    expect(ValidationSchema.safeParse({ column: 'amount', rule: 'cutoffRange', low: 1, high: 2, value: 2, includes: 'high', severity: 'flag' }).success).toBe(true);
    expect(JSON.stringify(learnResultWireJsonSchema())).not.toContain('cutoffRange');
  });

  it('checkRules: the edges in order, the value inside, numbers or dates but not both', () => {
    const ok = checkRules(withCheck({ column: 'amount', rule: 'cutoffRange', low: 10, high: 20, value: 20, includes: 'high', severity: 'flag' }));
    expect(ok).toEqual([]);
    const reversed = checkRules(withCheck({ column: 'amount', rule: 'cutoffRange', low: 20, high: 10, value: 15, includes: 'high', severity: 'flag' }));
    expect(reversed.map((p) => p.path)).toEqual(['validations[0].low']);
    // with `includes: 'low'` the cut-off may equal the low edge, not the high one
    const outside = checkRules(withCheck({ column: 'amount', rule: 'cutoffRange', low: 10, high: 20, value: 20, includes: 'low', severity: 'flag' }));
    expect(outside.map((p) => p.path)).toEqual(['validations[0].value']);
    const mixed = checkRules(withCheck({ column: 'amount', rule: 'cutoffRange', low: 10, high: '2026-01-01', value: 15, includes: 'high', severity: 'flag' }));
    expect(mixed).toHaveLength(1);
  });

  it('typeCheck: numbers on a numeric column, dates on a date column', () => {
    expect(typeCheck(withCheck({ column: 'amount', rule: 'cutoffRange', low: 10, high: 20, value: 15, includes: 'high', severity: 'flag' }))).toEqual([]);
    expect(typeCheck(withCheck({ column: 'd', rule: 'cutoffRange', low: 10, high: 20, value: 15, includes: 'high', severity: 'flag' }))).toHaveLength(1);
    expect(typeCheck(withCheck({ column: 'd', rule: 'cutoffRange', low: '2026-01-01', high: '2026-02-01', value: '2026-01-15', includes: 'high', severity: 'flag' }))).toEqual([]);
  });

  it('is never part of the source: it stays with the conversion (SPEC 8.15)', () => {
    const r = { ...base, validations: [{ column: 'amount', rule: 'range', min: 0, severity: 'flag' }, { column: 'amount', rule: 'cutoffRange', low: 10, high: 20, value: 15, includes: 'high', severity: 'flag' }] as Validation[] };
    expect(sourceOf(r).inputValidations.map((v) => v.rule)).toEqual(['range']);
  });
});
