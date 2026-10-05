// `input.columns[].readAs` (SPEC 8.4a): a text cell whose text is exactly a key is read as the value it names, before the column's type is
// read - the rule the Run screen's "Do this every time?" saves (SPEC 5 C, 21 v12). Exact text only, text cells only, empty means "read as empty".
import { describe, expect, it } from 'vitest';
import { runRules } from '../../src/pipeline';
import { col, dataRows, dateCell, expectOk, rules, runOk, table, values } from './helpers';

const headers = ['Ref', 'Amount'];

function amountRules(readAs?: Record<string, string>, type: 'decimal' | 'text' = 'decimal') {
  return rules({ columns: [col('ref'), col('amount', type, readAs ? { readAs } : {})] });
}

describe('readAs: the mapping is applied when the file is read', () => {
  it('a text read as "" is an empty cell: no flag, and an empty value in the output', () => {
    const t = table(headers, [['a', 'N/A'], ['b', '12.5'], ['c', 'N/A']]);
    const res = runOk(amountRules({ 'N/A': '' }), t);
    expect(res.flags).toEqual([]);
    expect(values(res.sheet)).toEqual([['a', null], ['b', 12.5], ['c', null]]);
  });

  it('without the mapping the same text is flagged as before (nothing changed for rules that have none)', () => {
    const res = runOk(amountRules(), table(headers, [['a', 'N/A'], ['b', '12.5']]));
    expect(res.flags.map((f) => [f.rowNumber, f.column, f.messageKey])).toEqual([[2, 'amount', 'flag.parseFailed.number']]);
    const empty = runOk(amountRules({}), table(headers, [['a', 'N/A']]));
    expect(empty.flags).toHaveLength(1);
  });

  it('a text read as a value is read by the column type like any cell', () => {
    const t = table(headers, [['a', 'n/a'], ['b', 'zero']]);
    const res = runOk(amountRules({ 'n/a': '0', zero: '0.0' }), t);
    expect(res.flags).toEqual([]);
    expect(values(res.sheet)).toEqual([['a', 0], ['b', 0]]);
  });

  it('a value that does not read as the type is flagged, with the value it was read as', () => {
    const res = runOk(amountRules({ 'N/A': 'none' }), table(headers, [['a', 'N/A']]));
    expect(res.flags.map((f) => [f.rowNumber, f.value, f.messageKey])).toEqual([[2, 'none', 'flag.parseFailed.number']]);
  });

  it('a text column: the text is replaced as written, and "" makes it empty', () => {
    const t = table(['Ref', 'Status'], [['a', 'unknown'], ['b', 'ok']]);
    const r = rules({ columns: [col('ref'), col('status', 'text', { readAs: { unknown: '' } })] });
    expect(values(runOk(r, t).sheet)).toEqual([['a', null], ['b', 'ok']]);
    const r2 = rules({ columns: [col('ref'), col('status', 'text', { readAs: { unknown: 'pending' } })] });
    expect(values(runOk(r2, t).sheet)).toEqual([['a', 'pending'], ['b', 'ok']]);
  });
});

describe('readAs: exact match only', () => {
  it('case, spacing and a longer text are not the key', () => {
    const t = table(headers, [['a', 'n/a'], ['b', 'N/A '], ['c', ' N/A'], ['d', 'N/A.'], ['e', 'N/A']]);
    const res = runOk(amountRules({ 'N/A': '' }), t);
    expect(res.flags.map((f) => f.rowNumber)).toEqual([2, 3, 4, 5]);
    expect(values(res.sheet).map((r) => r[1])).toEqual(['n/a', 'N/A ', ' N/A', 'N/A.', null]);
  });

  it('only the column it is on: the same text in another column is untouched', () => {
    const r = rules({ columns: [col('a', 'text', { readAs: { x: 'y' } }), col('b', 'text')] });
    expect(values(runOk(r, table(['a', 'b'], [['x', 'x']])).sheet)).toEqual([['y', 'x']]);
  });

  it('a number, a date or an empty cell is never matched, even when its text would be the key', () => {
    const r = rules({ columns: [col('ref'), col('amount', 'text', { readAs: { '5': 'five', '45293': 'serial' } })] });
    const t = table(headers, [['a', 5], ['b', '5'], ['c', null], ['d', dateCell(45293)]]);
    const rows = values(runOk(r, t).sheet);
    expect(rows[0]![1]).not.toBe('five'); // the number 5 is not the text "5"
    expect(rows[1]).toEqual(['b', 'five']);
    expect(rows[2]![1]).toBe(null);
    expect(rows[3]![1]).not.toBe('serial'); // a date cell is a serial number, not text
  });

  it('the mapping is not chained: the value it names is not looked up again', () => {
    const res = runOk(rules({ columns: [col('v', 'text', { readAs: { a: 'b', b: 'c' } })] }), table(['v'], [['a'], ['b']]));
    expect(values(res.sheet)).toEqual([['b'], ['c']]);
  });
});

describe('readAs and the rest of the run', () => {
  it("a per-run fix of that very cell wins over the mapping (the user's own value for this file)", () => {
    const t = table(headers, [['a', 'N/A'], ['b', 'N/A']]);
    const res = runRules(amountRules({ 'N/A': '' }), t, { rowDecisions: { 2: { action: 'override', values: { amount: '7' } } } });
    expectOk(res);
    expect(values(res.sheet)).toEqual([['a', 7], ['b', null]]);
    expect(res.flags).toEqual([]);
  });

  it('a row that is only empty after the mapping is a spacer row, as a row of empty cells always was', () => {
    const t = table(['Amount'], [['N/A'], ['3']]);
    const r = rules({ columns: [col('amount', 'decimal', { readAs: { 'N/A': '' } })] });
    const res = runOk(r, t);
    expect(res.summary.rowsIn).toBe(1);
    expect(dataRows(res.sheet)).toHaveLength(1);
  });

  it('a required check sees the mapped value: "N/A" read as empty on a required column is flagged as empty', () => {
    const r = rules({
      columns: [col('ref'), col('amount', 'decimal', { readAs: { 'N/A': '' } })],
      validations: [{ column: 'amount', rule: 'required', severity: 'flag' }],
    });
    const res = runOk(r, table(headers, [['a', 'N/A'], ['b', '4']]));
    expect(res.flags.map((f) => [f.rowNumber, f.rule, f.column])).toEqual([[2, 'required', 'amount']]);
  });

  it('duplicates are compared after the mapping', () => {
    const r = rules({
      columns: [col('k', 'text', { readAs: { A: 'a' } })],
      transform: { dedupe: { keys: ['k'], keep: 'first', action: 'remove' } },
    });
    const res = runOk(r, table(['k'], [['a'], ['A'], ['b']]));
    expect(res.summary.duplicatesRemoved).toEqual([{ rowNumber: 3, duplicateOf: 2 }]);
  });
});
