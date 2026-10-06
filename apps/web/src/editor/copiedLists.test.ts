// A list copied from the example, asked at Save only (owner decision 2026-10-06, `copiedLists.ts`): which lists a save asks about, and the
// rules "Save without" stores.
import type { CopiedListQuestion, OneTimeQuestion } from '@formatai/engine';
import type { Expr, LearnResult } from '@formatai/shared';
import { describe, expect, it } from 'vitest';
import { copiedListsOf, listsToConfirm, withoutCopiedLists } from './copiedLists';

const lookup = (table: string, ret: string): Expr => ({ op: 'lookup', table, key: { col: 'orderId' }, return: ret, onMissing: 'flag' });
const table = (name: string, ret: string) => ({ name, columns: ['orderId', ret], rows: [['ORD-1', 5], ['ORD-2', 7]] as [string, number][] });

const listed: LearnResult = {
  schemaVersion: 1,
  input: { sheet: { pick: 'first' }, headerRow: 'auto', columns: [{ id: 'orderId', header: 'Order ID', type: 'text' }] },
  transform: {
    computed: [
      { id: 'discount', type: 'decimal', expr: lookup('discounts', 'discount') },
      { id: 'bonus', type: 'decimal', expr: lookup('bonuses', 'bonus') },
    ],
    valueMaps: [],
    sort: [],
    tables: [table('discounts', 'discount'), table('bonuses', 'bonus')],
  },
  output: {
    sheetName: 'S',
    direction: 'ltr',
    language: 'en',
    titleRows: [],
    columns: [
      { header: 'Order ID', from: 'orderId' },
      { header: 'Discount', from: 'discount' },
      { header: 'Bonus', from: 'bonus' },
    ],
  },
  validations: [],
  unsupported: [],
  assumptions: [],
};

const discount: CopiedListQuestion = { kind: 'copiedList', out: 1, header: 'Discount', keyColumn: 'Order ID', entries: 2, list: { kind: 'lookup', computed: 'discount', table: 'discounts' } };
const bonus: CopiedListQuestion = { kind: 'copiedList', out: 2, header: 'Bonus', keyColumn: 'Order ID', entries: 2, list: { kind: 'lookup', computed: 'bonus', table: 'bonuses' } };
const row: OneTimeQuestion = {
  out: 1,
  header: 'Discount',
  part: { kind: 'branch', computed: 'discount', when: { const: true }, then: { const: 0 } },
  row: 4,
  inputRow: 4,
  by: 'position',
  value: 0,
  rest: 5,
  check: null,
};

describe('the lists a save asks about', () => {
  it('a learn\'s copied lists, one per column (a completion\'s answer first); its row questions are not among them', () => {
    expect(copiedListsOf([bonus], [row, discount, { ...bonus, entries: 9 }])).toEqual([bonus, discount]);
    expect(copiedListsOf(undefined, [row])).toEqual([]);
  });

  it('those the rules still take a column\'s value from, in output order', () => {
    expect(listsToConfirm(listed, [bonus, discount])).toEqual([discount, bonus]);
    expect(listsToConfirm(withoutCopiedLists(listed, [discount]), [discount, bonus])).toEqual([bonus]);
    const filled = { ...listed, output: { ...listed.output, columns: listed.output.columns.map((c) => (c.header === 'Bonus' ? { ...c, from: 'orderId' } : c)) } };
    expect(listsToConfirm(filled, [discount, bonus])).toEqual([discount]);
    expect(listsToConfirm(listed, [])).toEqual([]);
  });

  it('not a list the server already holds (an earlier save stored it, after asking)', () => {
    expect(listsToConfirm(listed, [discount, bonus], listed)).toEqual([]);
    expect(listsToConfirm(listed, [discount, bonus], withoutCopiedLists(listed, [bonus]))).toEqual([bonus]);
  });
});

describe('"Save without them"', () => {
  it('each column needs your input and its copied values are gone; the rest stays', () => {
    const out = withoutCopiedLists(listed, [discount, bonus]);
    expect(out.output.columns).toEqual([{ header: 'Order ID', from: 'orderId' }, { header: 'Discount', from: null }, { header: 'Bonus', from: null }]);
    expect(out.unsupported).toEqual([
      { outputColumn: 'Discount', reasonCode: 'overfit' },
      { outputColumn: 'Bonus', reasonCode: 'overfit' },
    ]);
    expect([out.transform.computed, out.transform.tables]).toEqual([[], []]);
    expect(JSON.stringify(out)).not.toContain('ORD-');
  });

  it('a list the rules no longer hold is skipped; none at all leaves the rules as they are', () => {
    const once = withoutCopiedLists(listed, [discount]);
    expect(withoutCopiedLists(once, [discount])).toBe(once);
    expect(withoutCopiedLists(listed, [])).toBe(listed);
  });
});
