// Engine audit (2026-10-07), fix 11: the list question (`copiedLists`) and the overfitting guard (`measureKey`) both needed a PLAIN input
// column as the key, so `lookup(t, trim(account), ...)` escaped both; and a value map on a decimal or currency column was caught by neither
// (the lists leave an amount key to the guards, the guard looked at lookups only). Now the key is judged by the input columns its value is
// made of (`keyColumnsOf`), and the guard finds a value map keyed on an amount. The two mechanisms stay separate.
import { describe, expect, it } from 'vitest';
import type { Expr, LearnResult } from '@formatai/shared';
import { parseFormula } from '../../../src/formula';
import { fillParams } from '../../../src/learn/fillParams';
import { copiedLists } from '../../../src/learn/oneTimers';
import { keyColumnsOf, overfitFindings, overfitProblems, withOverfitFallback } from '../../../src/learn/overfit';
import { analyzeOk, xlsx, type V } from '../analyze/helpers';

const f = (text: string): Expr => {
  const parsed = parseFormula(text, { allowWindows: true });
  if (!parsed.ok) throw new Error(`${text}: ${parsed.error.message}`);
  return parsed.expr;
};

// 24 accounts; Manager is drawn per row from names the input does not have: a list copied from the example, keyed on Account.
const N = 24;
const MANAGERS = ['Priya', 'Tobias', 'Amara', 'Mateo', 'Ingrid'];
const account = (i: number): string => `ACC-${1001 + i}`;
const manager = (i: number): string => MANAGERS[(i * 7 + 3) % 5]!;
const fee = (i: number): number => 100 + i * 7.5;
const input: V[][] = [['Account', 'Fee'], ...Array.from({ length: N }, (_, i) => [account(i), fee(i)])];
const output: V[][] = [['Account', 'Manager'], ...Array.from({ length: N }, (_, i) => [account(i), manager(i)])];
const ACCOUNTS = analyzeOk(xlsx(input), xlsx(output));

function rules(computed: { id: string; type: 'text' | 'decimal'; expr: string }[], managerFrom: string, more: Partial<LearnResult['transform']> = {}): LearnResult {
  return {
    schemaVersion: 1,
    input: { sheet: { pick: 'first' }, headerRow: 'auto', columns: [{ id: 'account', header: 'Account', type: 'text' }, { id: 'fee', header: 'Fee', type: 'decimal' }] },
    transform: { computed: computed.map((c) => ({ ...c, expr: f(c.expr) })), valueMaps: [], sort: [], ...more },
    output: { sheetName: 'Sheet1', direction: 'ltr', language: 'en', titleRows: [], columns: [{ header: 'Account', from: 'account' }, { header: 'Manager', from: managerFrom }] },
    validations: [],
    unsupported: [],
    assumptions: [],
  };
}
const TABLE = { name: 'managers', columns: ['account', 'manager'], rows: [[account(0), manager(0)]] };
const label = (r: LearnResult): string[] => overfitFindings(r, { table: null }).map((x) => `${x.kind}:${x.outputColumn}`);

describe('keyColumnsOf: the input columns a key is made of', () => {
  const r = rules([{ id: 'acct', type: 'text', expr: 'trim(account)' }], 'acct');
  it('through functions of the value and computed columns; not through a condition', () => {
    expect(keyColumnsOf(r, f('trim(upper(account))'))).toEqual({ inputs: ['account'], via: [] });
    expect(keyColumnsOf(r, { col: 'acct' })).toEqual({ inputs: ['account'], via: ['acct'] });
    expect(keyColumnsOf(r, f('round(fee, 0)')).inputs).toEqual(['fee']);
    expect(keyColumnsOf(r, f('if(fee > 100, "big", "small")')).inputs).toEqual([]);
  });
});

describe('the list question: a key worked out by an expression', () => {
  it('lookup(t, trim(account), ...), filled from every row, is asked about - keyed on Account', () => {
    const filled = fillParams(rules([{ id: 'mgr', type: 'text', expr: 'lookup("managers", trim(account), "manager")' }], 'mgr', { tables: [TABLE] }), ACCOUNTS).rules;
    expect(filled.transform.tables?.[0]?.rows).toHaveLength(N);
    expect(copiedLists(filled, ACCOUNTS)).toEqual([{ kind: 'copiedList', out: 1, header: 'Manager', keyColumn: 'Account', entries: N, list: { kind: 'lookup', computed: 'mgr', table: 'managers' } }]);
  });

  it('a value map on a computed copy of Account is asked about too', () => {
    const map = Object.fromEntries(Array.from({ length: N }, (_, i) => [account(i), manager(i)]));
    const r = rules([{ id: 'acct', type: 'text', expr: 'trim(account)' }], 'acct', { valueMaps: [{ column: 'acct', map, onMissing: 'flag' }] });
    expect(copiedLists(r, ACCOUNTS).map((q) => [q.header, q.keyColumn, q.entries])).toEqual([['Manager', 'Account', N]]);
  });
});

describe('the measureKey guard: an amount, however the key reads it, in a lookup or a value map', () => {
  it('a lookup keyed on a function of an amount, or on a computed amount', () => {
    expect(label(rules([{ id: 'v', type: 'text', expr: 'lookup("t", round(fee, 0), "v")' }], 'v', { tables: [TABLE] }))).toEqual(['measureKey:Manager']);
    expect(label(rules([{ id: 'f2', type: 'decimal', expr: 'fee * 1' }, { id: 'v', type: 'text', expr: 'lookup("t", f2, "v")' }], 'v', { tables: [TABLE] }))).toEqual(['measureKey:Manager']);
    // (a key that only TESTS the amount is a category: no finding)
    expect(label(rules([{ id: 'v', type: 'text', expr: 'lookup("t", if(fee > 150, "high", "low"), "v")' }], 'v', { tables: [TABLE] }))).toEqual([]);
  });

  it('a value map on an amount column, or on a computed column made of one: found, with its own message; one on text is not', () => {
    const amounts = Object.fromEntries(Array.from({ length: N }, (_, i) => [String(fee(i)), manager(i)]));
    const onFee = rules([], 'fee', { valueMaps: [{ column: 'fee', map: amounts, onMissing: 'flag' }] });
    const findings = overfitFindings(onFee, { table: null });
    expect(findings).toEqual([{ kind: 'measureKey', outputColumn: 'Manager', out: 1, id: 'fee', valueMap: true }]);
    expect(overfitProblems(findings)[0]?.message).toContain('it maps amounts to values one by one');
    const onCopy = rules([{ id: 'fee2', type: 'text', expr: 'toText(fee)' }], 'fee2', { valueMaps: [{ column: 'fee2', map: amounts, onMissing: 'flag' }] });
    expect(label(onCopy)).toEqual(['measureKey:Manager']);
    const onText = rules([], 'account', { valueMaps: [{ column: 'account', map: { [account(0)]: 'x' }, onMissing: 'keep' }] });
    expect(label(onText)).toEqual([]);
  });

  it('the fallback takes the column out and the map of amounts with it', () => {
    const amounts = Object.fromEntries(Array.from({ length: N }, (_, i) => [String(fee(i)), manager(i)]));
    const onFee = rules([], 'fee', { valueMaps: [{ column: 'fee', map: amounts, onMissing: 'flag' }] });
    const back = withOverfitFallback(onFee, overfitFindings(onFee, { table: null }));
    expect(back.output.columns[1]).toEqual({ header: 'Manager', from: null });
    expect(back.unsupported).toEqual([{ outputColumn: 'Manager', reasonCode: 'overfit' }]);
    expect(back.transform.valueMaps).toEqual([]);
  });
});
