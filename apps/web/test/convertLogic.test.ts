// The pure parts of convert: which rows need a look, the decisions the user's choices become, the counts a run reports.
import type { Flag, RunSummary } from '@formatai/engine';
import { describe, expect, it } from 'vitest';
import { applyToAll, attentionOfGaps, attentionOfUnlike, baseName, canRunAnyway, columnLabel, fixFields, flaggedRowCount, mappingOptions, matchWords, newColumns, normalizeHeader, quoteNames, requiredAcross, reviewRows, runCounts, scopeSources, signatureOf, tally, toRowDecisions, withAliases } from '../src/pages/Convert/logic';
import { entry, match, RULES, sourceEntry } from './helpers/convertKit';

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

describe('sources and the formats they feed (SPEC 8.15)', () => {
  const two = sourceEntry({ sourceId: 's1', name: 'Supplier A', conversions: [{ conversionId: 'c1', formatId: 'F1', formatName: 'Load file' }, { conversionId: 'c2', formatId: 'F2', formatName: 'ERP load' }] });
  const bare = sourceEntry({ sourceId: 's2', name: 'New supplier', conversions: [] });

  it('a source with no conversion cannot run anything, so it is left out', () => {
    expect(scopeSources([two, bare], null).map((e) => e.sourceId)).toEqual(['s1']);
  });

  it('on ?format= only that format\'s conversion of a source is kept, and sources that do not feed it are dropped', () => {
    const other = entry({ conversionId: 'c9', sourceId: 's3', formatId: 'F3', formatName: 'Ledger' });
    const scoped = scopeSources([two, other], 'F2');
    expect(scoped.map((e) => [e.sourceId, e.conversions.map((c) => c.conversionId)])).toEqual([['s1', ['c2']]]);
    // The entry handed in is not changed.
    expect(two.conversions).toHaveLength(2);
  });

  it('gives the matcher one signature per SOURCE, keyed by the source id', () => {
    expect(signatureOf(two)).toEqual({ id: 's1', name: 'Supplier A', columns: two.columns });
  });

  it('names the output file after the input file, without its folder and extension', () => {
    expect(baseName('C:\\prices\\jan.2026.xlsx')).toBe('jan.2026');
    expect(baseName('prices/jan.csv')).toBe('jan');
    expect(baseName('jan')).toBe('jan');
    expect(baseName('.csv')).toBe('.csv');
  });
});

describe('a confirmed rename is keyed by the source\'s header', () => {
  it('finds a conversion\'s declared column by exact header first, then by the normalized header', () => {
    const rules = {
      ...RULES,
      input: { ...RULES.input, columns: [...RULES.input.columns.slice(0, 1), { id: 'c_qty', header: ' QTY ', type: 'integer' as const, required: true }] },
    };
    const next = withAliases(rules, { Qty: 'Quantity' });
    expect(next.input.columns.find((c) => c.id === 'c_qty')?.aliases).toEqual(['Quantity']);
    // An exact header wins over a normalized one: "Qty" is not treated as "QTY" when "Qty" itself is declared.
    const exact = withAliases(RULES, { Qty: 'Quantity', qty: 'Amount' });
    expect(exact.input.columns.find((c) => c.id === 'c_qty')?.aliases).toEqual(['Quantity']);
    // Columns the mapping does not name are left alone.
    expect(next.input.columns.find((c) => c.id === 'c_code')?.aliases).toBeUndefined();
  });

  it('with no rename there is nothing to copy', () => {
    expect(withAliases(RULES, {})).toBe(RULES);
  });

  it('compares headers after NFC, trimming and lower-casing', () => {
    expect(normalizeHeader('  Item CODE ')).toBe('item code');
    expect(normalizeHeader('Cafe\u0301')).toBe(normalizeHeader('Caf\u00e9'));
  });
});

describe('formats that need attention (SPEC 21 v12)', () => {
  it('what a file lacks becomes an attention note, with the required columns kept apart (no note when nothing is missing)', () => {
    expect(attentionOfGaps([])).toBeNull();
    expect(attentionOfGaps([{ header: 'Price', required: false }])).toEqual({ kind: 'missing', columns: ['Price'], required: [] });
    expect(attentionOfGaps([{ header: 'Qty', required: true }, { header: 'Price', required: false }])).toEqual({ kind: 'missing', columns: ['Qty', 'Price'], required: ['Qty'] });
  });

  it('"Run anyway" is offered unless a required column is missing; a values note can always be run anyway', () => {
    expect(canRunAnyway({ kind: 'missing', columns: ['Price'], required: [] })).toBe(true);
    expect(canRunAnyway({ kind: 'missing', columns: ['Qty', 'Price'], required: ['Qty'] })).toBe(false);
    expect(canRunAnyway({ kind: 'values', columns: [{ header: 'Qty', type: 'integer' }] })).toBe(true);
  });

  it('what a run says about unreadable values becomes a note naming the columns and their types (counts and names only)', () => {
    expect(attentionOfUnlike(undefined)).toBeNull();
    expect(attentionOfUnlike([])).toBeNull();
    expect(attentionOfUnlike([{ header: 'Qty', type: 'integer', id: 'c_qty', rows: 9 } as { header: string; type: 'integer' }])).toEqual({ kind: 'values', columns: [{ header: 'Qty', type: 'integer' }] });
  });

  it('the columns a missing-columns stop names are the required ones, once each, in the order found', () => {
    expect(
      requiredAcross([
        { kind: 'missing', columns: ['Qty', 'Price'], required: ['Qty'] },
        { kind: 'missing', columns: ['Code', 'Qty'], required: ['Code', 'Qty'] },
        { kind: 'values', columns: [{ header: 'Qty', type: 'integer' }] },
      ]),
    ).toEqual(['Qty', 'Code']);
  });

  it('quotes and isolates each name, so a Hebrew name in an English sentence (or the reverse) stays whole', () => {
    expect(quoteNames(['Qty', 'שם'])).toBe("'⁨Qty⁩', '⁨שם⁩'");
  });
});

describe('a new column in the file (SPEC 8.15)', () => {
  it('is a header the source does not know, that no confirmed rename used, and that nobody dismissed (compared like the engine: case, spacing)', () => {
    expect(newColumns(['Notes', 'Created by', 'Quantity'], { Qty: 'Quantity' }, [])).toEqual(['Notes', 'Created by']);
    expect(newColumns(['Notes', 'Created by'], {}, ['  notes ', 'Other'])).toEqual(['Created by']);
    expect(newColumns(['Notes'], {}, ['Notes'])).toEqual([]);
    expect(newColumns([], {}, [])).toEqual([]);
  });
});
