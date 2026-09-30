// Per-run row decisions (SPEC 21 v5 item 5, issue #36): skip / keep / override, applied by runRules and
// convertFile without touching the rules, and listed in the run summary.
import type { LearnResult } from '@formatai/shared';
import { describe, expect, it } from 'vitest';
import { convertFile } from '../../src/convert';
import { writeXlsx } from '../../src/io/writeXlsx';
import { runRules } from '../../src/pipeline';
import type { OutRow, OutputSheet, RowDecisions } from '../../src/types';
import { col, dataRows, expectOk, rules, table, values } from './helpers';

// Input rows (Excel row numbers): 2 clean, 3 amount isn't a number, 4 status not allowed, 5 clean,
// 6 negative amount (a `block` validation), 7 clean.
const headers = ['Ref', 'AMT', 'Status'];
const rows: (string | number | null)[][] = [
  ['A1', 100, 'ok'],
  ['A2', 'oops', 'ok'],
  ['A3', 300, 'bad'],
  ['A4', 50, 'ok'],
  ['A5', -7, 'ok'],
  ['A6', 20, 'ok'],
];

function makeRules(): LearnResult {
  return rules({
    columns: [
      col('ref', 'text', { header: 'Ref' }),
      col('amount', 'decimal', { header: 'Amount', aliases: ['AMT'] }),
      col('status', 'text', { header: 'Status' }),
    ],
    validations: [
      { column: 'status', rule: 'oneOf', values: ['ok'], severity: 'flag' },
      { column: 'amount', rule: 'range', min: 0, severity: 'block' },
    ],
  });
}

function run(decisions?: RowDecisions, r: LearnResult = makeRules()) {
  const res = runRules(r, table(headers, rows), decisions !== undefined ? { rowDecisions: decisions } : {});
  expectOk(res);
  return res;
}

describe('row decisions: none given', () => {
  it('leaves the summary exactly as before (no new fields) and blocks the negative amount', () => {
    const res = run();
    expect(res.summary).toEqual({ rowsIn: 6, rowsOut: 5, rowsFiltered: 0, duplicatesRemoved: [], duplicatesFlagged: 0, blockedRows: [{ rowNumber: 6, rule: 'range', column: 'amount' }] });
    expect('skippedByUser' in res.summary).toBe(false);
    expect(res.flags.map((f) => [f.rowNumber, f.rule, f.accepted])).toEqual([
      [3, 'type', undefined],
      [4, 'oneOf', undefined],
    ]);
  });

  it('an empty decisions object lists nothing, but the lists are there', () => {
    const res = run({});
    expect(res.summary.skippedByUser).toEqual([]);
    expect(res.summary.editedByUser).toEqual([]);
    expect(res.summary.acceptedByUser).toEqual([]);
  });
});

describe('row decisions: skip', () => {
  it('removes the row (and its flags) and lists it; skipped rows still count in rowsIn', () => {
    const res = run({ 3: { action: 'skip' }, 4: { action: 'skip' } });
    expect(values(res.sheet).map((r) => r[0])).toEqual(['A1', 'A4', 'A6']);
    expect(res.flags).toEqual([]);
    expect(res.summary.skippedByUser).toEqual([{ rowNumber: 3 }, { rowNumber: 4 }]);
    // rowsIn = rowsOut + blocked + skipped
    expect(res.summary).toMatchObject({ rowsIn: 6, rowsOut: 3 });
    expect(res.summary.rowsIn).toBe(res.summary.rowsOut + res.summary.blockedRows.length + (res.summary.skippedByUser ?? []).length);
  });

  it('a skipped row is never the kept copy of a duplicate', () => {
    const r = makeRules();
    r.transform.dedupe = { keys: ['ref'], keep: 'first', action: 'remove' };
    const dup = table(headers, [
      ['D1', 10, 'ok'],
      ['D1', 11, 'ok'],
    ]);
    const plain = runRules(r, dup);
    expectOk(plain);
    expect(values(plain.sheet).map((v) => v[1])).toEqual([10]);
    const skipped = runRules(r, dup, { rowDecisions: { 2: { action: 'skip' } } });
    expectOk(skipped);
    expect(values(skipped.sheet).map((v) => v[1])).toEqual([11]);
    expect(skipped.summary.duplicatesRemoved).toEqual([]);
  });

  it('a row number the file does not have changes nothing and is not listed', () => {
    const res = run({ 99: { action: 'skip' } });
    expect(res.summary.skippedByUser).toEqual([]);
    expect(res.summary.rowsOut).toBe(5);
  });
});

describe('row decisions: override', () => {
  it('replaces the value before normalization: the row is re-run and its flag goes away', () => {
    const res = run({ 3: { action: 'override', values: { amount: 250 } } });
    expect(res.flags.map((f) => f.rowNumber)).toEqual([4]);
    expect(values(res.sheet).map((r) => r[1])).toEqual([100, 250, 300, 50, 20]);
    expect(res.summary.editedByUser).toEqual([{ rowNumber: 3, columns: ['amount'] }]);
  });

  it('addresses a column by id, by the rules header or by the file header; text is read by the column type', () => {
    const byId = run({ 3: { action: 'override', values: { amount: '12.5' } } });
    expect(values(byId.sheet)[1]![1]).toBe(12.5);
    const byRulesHeader = run({ 3: { action: 'override', values: { Amount: '12.5' } } });
    expect(values(byRulesHeader.sheet)[1]![1]).toBe(12.5);
    const byFileHeader = run({ 3: { action: 'override', values: { AMT: '12.5' } } });
    expect(values(byFileHeader.sheet)[1]![1]).toBe(12.5);
    expect(byFileHeader.summary.editedByUser).toEqual([{ rowNumber: 3, columns: ['amount'] }]);
  });

  it('a value that still does not fit is flagged again, like any file value', () => {
    const res = run({ 3: { action: 'override', values: { amount: 'still bad' } } });
    expect(res.flags.filter((f) => f.rowNumber === 3).map((f) => [f.rule, f.value])).toEqual([['type', 'still bad']]);
  });

  it('is validated after the change: an edit that breaks a block rule leaves the row out', () => {
    const res = run({ 3: { action: 'override', values: { amount: -1 } } });
    expect(res.summary.blockedRows.map((b) => b.rowNumber)).toEqual([3, 6]);
    expect(res.summary.editedByUser).toEqual([{ rowNumber: 3, columns: ['amount'] }]);
  });

  it('lists the changed columns in input order; unknown columns are ignored', () => {
    const res = run({ 4: { action: 'override', values: { Status: 'ok', nothing: 'x', amount: 301 } } });
    expect(res.summary.editedByUser).toEqual([{ rowNumber: 4, columns: ['amount', 'status'] }]);
    expect(res.flags.map((f) => f.rowNumber)).toEqual([3]);
    const none = run({ 4: { action: 'override', values: { nothing: 'x' } } });
    expect(none.summary.editedByUser).toEqual([]);
  });

  it('can empty a cell', () => {
    const res = run({ 3: { action: 'override', values: { amount: null } } });
    expect(values(res.sheet)[1]![1]).toBeNull();
    expect(res.flags.map((f) => f.rowNumber)).toEqual([4]);
  });
});

describe('row decisions: keep', () => {
  it('accepts the row flags: they stay listed with accepted true, and the cells are not highlighted', () => {
    const res = run({ 4: { action: 'keep' } });
    const flag = res.flags.find((f) => f.rowNumber === 4)!;
    expect(flag.accepted).toBe(true);
    expect(res.flags.find((f) => f.rowNumber === 3)!.accepted).toBeUndefined();
    const row = dataRows(res.sheet)[2]!;
    expect(row.cells.every((c) => c.flagged !== true)).toBe(true);
    // the other flagged row is still highlighted
    expect(dataRows(res.sheet)[1]!.cells.some((c) => c.flagged === true)).toBe(true);
    expect(res.summary.acceptedByUser).toEqual([{ rowNumber: 4, flags: 1 }]);
  });

  it('writes a row a block validation would leave out, and accepts that failure as a flag', () => {
    const res = run({ 6: { action: 'keep' } });
    expect(res.summary.blockedRows).toEqual([]);
    expect(values(res.sheet).map((r) => r[0])).toEqual(['A1', 'A2', 'A3', 'A4', 'A5', 'A6']);
    const flag = res.flags.find((f) => f.rowNumber === 6)!;
    expect(flag).toMatchObject({ rule: 'range', accepted: true, messageKey: 'flag.validation.range' });
    expect(res.summary.acceptedByUser).toEqual([{ rowNumber: 6, flags: 1 }]);
  });

  it('a row with nothing to accept is not listed', () => {
    const res = run({ 2: { action: 'keep' } });
    expect(res.summary.acceptedByUser).toEqual([]);
  });
});

describe('row decisions: several at once, determinism, and the rules stay untouched', () => {
  const decisions: RowDecisions = {
    3: { action: 'override', values: { amount: 250 } },
    4: { action: 'keep' },
    5: { action: 'skip' },
    6: { action: 'keep' },
  };

  it('applies each decision to its own row and lists them all', () => {
    const res = run(decisions);
    expect(values(res.sheet).map((r) => r[0])).toEqual(['A1', 'A2', 'A3', 'A5', 'A6']);
    expect(res.summary.skippedByUser).toEqual([{ rowNumber: 5 }]);
    expect(res.summary.editedByUser).toEqual([{ rowNumber: 3, columns: ['amount'] }]);
    expect(res.summary.acceptedByUser).toEqual([
      { rowNumber: 4, flags: 1 },
      { rowNumber: 6, flags: 1 },
    ]);
    expect(res.flags.map((f) => [f.rowNumber, f.accepted === true])).toEqual([
      [4, true],
      [6, true],
    ]);
  });

  it('gives the same result twice, and never modifies the rules or the decisions', () => {
    const r = makeRules();
    const before = structuredClone(r);
    const decisionsBefore = structuredClone(decisions);
    const a = run(decisions, r);
    const b = run(decisions, r);
    expect(a).toEqual(b);
    expect(r).toEqual(before);
    expect(decisions).toEqual(decisionsBefore);
  });

  it('ignores malformed decisions instead of failing', () => {
    const bad = { 0: { action: 'skip' }, 2: { action: 'explode' }, 3: null, 4: { action: 'override', values: 'x' }, abc: { action: 'skip' } } as unknown as RowDecisions;
    const res = run(bad);
    expect(res.summary.skippedByUser).toEqual([]);
    expect(res.summary.editedByUser).toEqual([]);
    expect(res.summary.rowsOut).toBe(5);
  });
});

describe('row decisions with rows that expand', () => {
  it('skips, edits and keeps a whole family: its rows share the input row number', () => {
    const r = rules({
      columns: [col('dept', 'text'), col('jan', 'decimal'), col('feb', 'decimal')],
      expand: { mode: 'columnsToRows', columns: ['jan', 'feb'], labelId: 'month', valueId: 'amount', valueType: 'decimal', skipEmpty: false },
      out: ['dept', 'month', 'amount'],
    });
    const t = table(['dept', 'jan', 'feb'], [
      ['A', 1, 2],
      ['B', 'x', 4],
      ['C', 5, 6],
    ]);
    const plain = runRules(r, t);
    expectOk(plain);
    expect(plain.flags.map((f) => f.rowNumber)).toEqual([3]);

    const skipped = runRules(r, t, { rowDecisions: { 3: { action: 'skip' } } });
    expectOk(skipped);
    expect(values(skipped.sheet).map((v) => v[0])).toEqual(['A', 'A', 'C', 'C']);
    expect(skipped.flags).toEqual([]);

    const edited = runRules(r, t, { rowDecisions: { 3: { action: 'override', values: { jan: 3 } } } });
    expectOk(edited);
    expect(values(edited.sheet).map((v) => v[2])).toEqual([1, 2, 3, 4, 5, 6]);
    expect(edited.flags).toEqual([]);

    const kept = runRules(r, t, { rowDecisions: { 3: { action: 'keep' } } });
    expectOk(kept);
    expect(kept.flags.map((f) => f.accepted)).toEqual([true]);
    expect(kept.summary.acceptedByUser).toEqual([{ rowNumber: 3, flags: 1 }]);
  });
});

describe('convertFile takes the same decisions', () => {
  async function xlsxBytes(): Promise<Uint8Array> {
    const sheet: OutputSheet = {
      name: 'Sheet1',
      direction: 'ltr',
      language: 'en',
      columns: headers.map((h) => ({ header: h })),
      rows: [
        { kind: 'header', cells: headers.map((h) => ({ v: h })) } as OutRow,
        ...rows.map((r): OutRow => ({ kind: 'data', cells: r.map((v) => ({ v })) })),
      ],
      merges: [],
    };
    return writeXlsx(sheet);
  }

  it('applies them and reports them; without them the summary has no lists', async () => {
    const bytes = await xlsxBytes();
    const plain = await convertFile(makeRules(), bytes, 'in.xlsx');
    expect(plain.ok).toBe(true);
    if (plain.ok) expect(plain.summary.skippedByUser).toBeUndefined();

    const res = await convertFile(makeRules(), bytes, 'in.xlsx', {
      rowDecisions: { 3: { action: 'skip' }, 4: { action: 'keep' }, 5: { action: 'override', values: { amount: 60 } } },
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.summary.skippedByUser).toEqual([{ rowNumber: 3 }]);
    expect(res.summary.editedByUser).toEqual([{ rowNumber: 5, columns: ['amount'] }]);
    expect(res.summary.acceptedByUser).toEqual([{ rowNumber: 4, flags: 1 }]);
    expect(res.flags.every((f) => f.fileName === 'in.xlsx')).toBe(true);
    expect(res.bytes.length).toBeGreaterThan(0);
  });
});
