// The marker of an open question about a column's rule (SPEC 8.8 `sameAs`, 21 v12 item 17): "Not sure yet" keeps the first rule, and this
// check flags a run-time row where the other rule the example fits gives a different value. The check is the conversion's own (never part
// of the source), type-checked and reference-checked like any expression, and what it reads counts as a use of those input columns.
import { checkRules, type Validation } from '@formatai/shared';
import { describe, expect, it } from 'vitest';
import { inputColumnsUsed } from '../../src/registry/inputColumnsUsed';
import { sourceOf } from '../../src/registry/sourceOf';
import { typeCheck } from '../../src/check/typeCheck';
import { col, rules, runOk, table, values } from './helpers';

/** Priority: the rule the rules use is a cut-off at 5000; the other rule the example fits is a cut-off at 4500. */
function priorityRules(check: Validation[] = []) {
  return rules({
    columns: [col('amount', 'decimal'), col('code', 'text')],
    transform: { computed: [{ id: 'priority', type: 'text', expr: { op: 'if', cond: { op: 'gte', args: [{ col: 'amount' }, { const: 5000 }] }, then: { const: 'Urgent' }, else: { const: 'Normal' } } }] },
    out: [{ header: 'Priority', from: 'priority' }, 'code'],
    validations: check,
  });
}
const other = { op: 'if', cond: { op: 'gte', args: [{ col: 'amount' }, { const: 4500 }] }, then: { const: 'Urgent' }, else: { const: 'Normal' } } as const;
const marker: Validation = { column: 'priority', rule: 'sameAs', expr: other as unknown as Extract<Validation, { rule: 'sameAs' }>['expr'], severity: 'flag' };

describe('sameAs: the run-time flag of an unanswered question', () => {
  it('flags only a row where the other rule gives a different value, naming what it gives; the output itself is the first rule', () => {
    const res = runOk(priorityRules([marker]), table(['amount', 'code'], [[100, 'a'], [4700, 'b'], [5200, 'c'], [4499.99, 'd']]));
    expect(values(res.sheet)).toEqual([
      ['Normal', 'a'],
      ['Normal', 'b'],
      ['Urgent', 'c'],
      ['Normal', 'd'],
    ]);
    expect(res.flags.map((f) => [f.rowNumber, f.column, f.value, f.messageKey, f.params])).toEqual([[3, 'priority', 'Normal', 'flag.validation.sameAs', { other: 'Urgent' }]]);
    expect(res.summary.blockedRows).toEqual([]);
  });

  it('compares as the column type: 12 and 12.0 are the same number; an empty value differs from a value; two empty values are the same', () => {
    const r = rules({
      columns: [col('a', 'decimal'), col('b', 'decimal')],
      transform: { computed: [{ id: 'sum', type: 'decimal', expr: { op: 'add', args: [{ col: 'a' }, { col: 'b' }] } }] },
      out: [{ header: 'Sum', from: 'sum' }],
      validations: [{ column: 'sum', rule: 'sameAs', expr: { op: 'mul', args: [{ col: 'a' }, { const: 2 }] }, severity: 'flag' }],
    });
    const res = runOk(r, table(['a', 'b'], [[6, 6], [6, 6.0], [5, 1], [null, null]]));
    expect(res.flags.map((f) => f.rowNumber)).toEqual([4]);
  });

  it('a row where the other rule cannot be worked out (division by zero) passes: there is nothing to compare', () => {
    const r = rules({
      columns: [col('a', 'decimal'), col('b', 'decimal')],
      out: ['a'],
      validations: [{ column: 'a', rule: 'sameAs', expr: { op: 'div', args: [{ col: 'a' }, { col: 'b' }] }, severity: 'flag' }],
    });
    const res = runOk(r, table(['a', 'b'], [[4, 0], [4, 1], [4, 2]]));
    expect(res.flags.map((f) => f.rowNumber)).toEqual([4]);
  });
});

describe('sameAs: shape, references, types and the source', () => {
  it('checkRules and typeCheck read its expression like any other', () => {
    expect(checkRules(priorityRules([marker]))).toEqual([]);
    expect(typeCheck(priorityRules([marker]))).toEqual([]);
    expect(checkRules(priorityRules([{ ...marker, expr: { col: 'gone' } }])).map((p) => p.path)).toEqual(['validations[0].expr']);
    const bad = typeCheck(priorityRules([{ ...marker, expr: { op: 'add', args: [{ col: 'code' }, { const: 1 }] } }]));
    expect(bad.map((p) => p.path.startsWith('validations[0].expr'))).toContain(true);
  });

  it('is never part of the source (SPEC 8.15): it is about one of this conversion columns; what it reads is a use of the input column', () => {
    const r = { ...priorityRules([marker, { column: 'amount', rule: 'range', min: 0, severity: 'flag' }]) };
    expect(sourceOf(r).inputValidations.map((v) => v.rule)).toEqual(['range']);
    const reads = rules({ columns: [col('amount', 'decimal'), col('code', 'text')], out: ['code'], validations: [{ column: 'code', rule: 'sameAs', expr: { col: 'amount' }, severity: 'flag' }] });
    expect(inputColumnsUsed(reads)).toEqual(['amount', 'code']);
  });
});
