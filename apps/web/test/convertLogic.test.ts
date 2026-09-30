// The pure parts of convert: which rows need a look, the decisions the user's choices become, the counts a run reports.
import type { Flag, RunSummary } from '@formatai/engine';
import { describe, expect, it } from 'vitest';
import { applyToAll, columnLabel, fixFields, flaggedRowCount, mappingOptions, matchWords, reviewRows, runCounts, tally, toRowDecisions, withAliases } from '../src/pages/Convert/logic';
import { match, RULES } from './helpers/convertKit';

const flag = (rowNumber: number, column: string, extra: Partial<Flag> = {}): Flag => ({ rowNumber, column, rule: 'type', value: 'x', messageKey: 'flag.parseFailed.number', ...extra });
const summary = (over: Partial<RunSummary> = {}): RunSummary => ({ rowsIn: 10, rowsOut: 9, rowsFiltered: 0, duplicatesRemoved: [], duplicatesFlagged: 0, blockedRows: [], ...over });

describe('reviewRows', () => {
  it('groups flags by row in row order, leaves out accepted ones, and adds rows a check blocks', () => {
    const rows = reviewRows(
      [flag(7, 'c_qty'), flag(3, 'c_code'), flag(3, 'c_qty'), flag(5, 'c_price', { accepted: true })],
      summary({ blockedRows: [{ rowNumber: 9, rule: 'range', column: 'c_price' }] }),
    );
    expect(rows.map((r) => [r.rowNumber, r.flags.length, r.blocked?.column ?? null])).toEqual([
      [3, 2, null],
      [7, 1, null],
      [9, 0, 'c_price'],
    ]);
  });
});

describe('choices -> RowDecisions', () => {
  it('maps skip, keep and a one-off fix; an emptied field is an empty cell', () => {
    expect(
      toRowDecisions({
        3: { action: 'skip' },
        4: { action: 'keep' },
        5: { action: 'override', values: { c_qty: '7', c_price: '  ' } },
      }),
    ).toEqual({ 3: { action: 'skip' }, 4: { action: 'keep' }, 5: { action: 'override', values: { c_qty: '7', c_price: null } } });
  });

  it('bulk keep / skip covers every row but keeps a fix the user made by hand', () => {
    const rows = reviewRows([flag(3, 'c_qty'), flag(4, 'c_qty'), flag(5, 'c_qty')], summary());
    const fix = { action: 'override', values: { c_qty: '1' } } as const;
    expect(applyToAll(rows, 'keep', { 4: fix })).toEqual({ 3: { action: 'keep' }, 4: fix, 5: { action: 'keep' } });
    expect(applyToAll(rows, 'skip', { 3: { action: 'keep' } })).toEqual({ 3: { action: 'skip' }, 4: { action: 'skip' }, 5: { action: 'skip' } });
  });

  it('tallies what is decided and what is open', () => {
    const rows = reviewRows([flag(3, 'a'), flag(4, 'a'), flag(5, 'a'), flag(6, 'a')], summary());
    expect(tally(rows, { 3: { action: 'keep' }, 4: { action: 'skip' }, 5: { action: 'override', values: {} } })).toEqual({ keep: 1, skip: 1, fix: 1, open: 1 });
  });
});

describe('what the user sees', () => {
  it('names a column by the file header, else by the output column built from it', () => {
    expect(columnLabel(RULES, 'c_qty')).toBe('Qty');
    expect(columnLabel(RULES, 'Quantity')).toBe('Quantity');
    expect(columnLabel(RULES, 'nothing')).toBe('nothing');
  });

  it('offers the flagged input columns to fix, or the whole row when the flag is about something calculated', () => {
    const cells = [
      { columnId: 'c_code', header: 'Item Code', value: '1' },
      { columnId: 'c_qty', header: 'Qty', value: 'x' },
    ];
    const [flagged] = reviewRows([flag(3, 'c_qty')], summary());
    expect(fixFields(flagged!, cells).map((c) => c.columnId)).toEqual(['c_qty']);
    const [calc] = reviewRows([flag(3, 'p_total')], summary());
    expect(fixFields(calc!, cells).map((c) => c.columnId)).toEqual(['c_code', 'c_qty']);
  });

  it('says the score in words', () => {
    expect(matchWords(0.95)).toBe('conv.match.high');
    expect(matchWords(0.7)).toBe('conv.match.mid');
    expect(matchWords(0.4)).toBe('conv.match.low');
    expect(matchWords(0.1)).toBe('conv.match.faint');
  });
});

describe('counts of a finished run', () => {
  it('counts flagged ROWS the user has not accepted, and reports nothing else', () => {
    const flags = [flag(3, 'a'), flag(3, 'b'), flag(4, 'a', { accepted: true }), flag(6, 'a')];
    expect(flaggedRowCount(flags)).toBe(2);
    expect(runCounts(summary({ rowsIn: 8 }), flags)).toEqual({ rows: 8, flagged: 2 });
  });
});

describe('renamed columns', () => {
  it('adds a confirmed rename as an alias in a copy, and leaves the saved rules alone', () => {
    const next = withAliases(RULES, { Qty: 'Quantity' });
    expect(next.input.columns.find((c) => c.id === 'c_qty')?.aliases).toEqual(['Quantity']);
    expect(RULES.input.columns.find((c) => c.id === 'c_qty')?.aliases).toBeUndefined();
    expect(withAliases(next, { Qty: 'Quantity' }).input.columns.find((c) => c.id === 'c_qty')?.aliases).toEqual(['Quantity']);
  });

  it('offers the suggested headers first, then the other unknown ones', () => {
    const m = match({ id: 'x', missingRequired: ['Qty'], extra: ['Foo', 'Quantity', 'Bar'], renamedCandidates: [{ required: 'Qty', candidates: ['Quantity'] }] });
    expect(mappingOptions(m, 'Qty')).toEqual({ suggested: ['Quantity'], others: ['Foo', 'Bar'] });
  });
});
