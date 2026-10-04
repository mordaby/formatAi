// Completion mode: what an answer changed or dropped of the rules it had to keep is put back by code (`restoreFixed`), so the fixed lock
// holds again - and what the answer was asked for stays as it built it. What code does not put back is left for the lock to report.
import type { Expr, LearnResult } from '@formatai/shared';
import { describe, expect, it } from 'vitest';
import { checkFixedLock, restoreFixed, type FixedLockOptions } from '../../src/registry';

/** What the user has: two built columns, a filter, a check, a title, and two columns with no rule (one external data). */
function fixedRules(): LearnResult {
  return {
    schemaVersion: 1,
    input: {
      sheet: { pick: 'first' },
      headerRow: 'auto',
      columns: [
        { id: 'id', header: 'ID', type: 'idLike', required: true },
        { id: 'amount', header: 'Amount', type: 'decimal' },
        { id: 'status', header: 'Status', type: 'text' },
      ],
      rowFilters: [{ column: 'status', op: 'ne', value: 'void' }],
    },
    transform: {
      computed: [{ id: 'gross', type: 'decimal', expr: { op: 'mul', args: [{ col: 'amount' }, { const: 1.17 }] } }],
      valueMaps: [{ column: 'status', map: { o: 'Open' }, onMissing: 'keep' }],
      sort: [{ column: 'id', dir: 'asc' }],
    },
    output: {
      sheetName: 'Out',
      direction: 'ltr',
      language: 'en',
      titleRows: [{ text: 'Report' }],
      columns: [
        { header: 'ID', from: 'id' },
        { header: 'Gross', from: 'gross', format: '#,##0.00', width: 12 },
        { header: 'Label', from: null },
        { header: 'Note', from: null },
      ],
      headerStyle: { bold: true },
    },
    validations: [{ column: 'amount', rule: 'range', min: 0, severity: 'flag' }],
    unsupported: [{ outputColumn: 'Note', reasonCode: 'externalData' }],
    assumptions: [],
  };
}

const LABEL_EXPR: Expr = { op: 'if', cond: { op: 'gt', args: [{ col: 'amount' }, { const: 100 }] }, then: { const: 'Big' }, else: { const: 'Small' } };
const LISTED: FixedLockOptions = { columns: [2], parts: [] };

/** The answer that does what was asked: a computed column for `Label` (listed), everything else untouched. */
function goodAnswer(): LearnResult {
  const f = fixedRules();
  return {
    ...f,
    transform: { ...f.transform, computed: [...f.transform.computed, { id: 'label', type: 'text', expr: LABEL_EXPR }] },
    output: { ...f.output, columns: f.output.columns.map((c) => (c.header === 'Label' ? { header: 'Label', from: 'label' } : c)) },
  };
}

const restored = (answer: LearnResult, opts: FixedLockOptions = LISTED): LearnResult => restoreFixed(answer, fixedRules(), opts);

describe('restoreFixed', () => {
  it('leaves an answer that kept everything as it is', () => {
    expect(restored(goodAnswer())).toEqual(goodAnswer());
  });

  it('puts back a changed or dropped fixed element, and keeps what the answer was asked for', () => {
    const a = goodAnswer();
    const broken: LearnResult = {
      ...a,
      input: { ...a.input, columns: a.input.columns.filter((c) => c.id !== 'status').map((c) => (c.id === 'amount' ? { ...c, type: 'integer' } : c)), rowFilters: [] },
      transform: { ...a.transform, computed: a.transform.computed.filter((c) => c.id !== 'gross'), sort: [] },
      output: {
        ...a.output,
        sheetName: 'Other',
        titleRows: [],
        headerStyle: { bold: false },
        columns: a.output.columns.map((c) => (c.header === 'ID' ? { ...c, from: 'amount' } : c.header === 'Gross' ? { ...c, width: 30 } : c)),
      },
      validations: [],
      unsupported: [],
    };
    expect(checkFixedLock(broken, fixedRules(), LISTED).length).toBeGreaterThan(5);
    const r = restored(broken);
    expect(checkFixedLock(r, fixedRules(), LISTED)).toEqual([]);
    expect(r.output.columns.find((c) => c.header === 'Label')!.from).toBe('label');
    expect(r.transform.computed.map((c) => c.id)).toEqual(['gross', 'label']); // fixed ones first: every reference before its use
  });

  it('a column that was not asked for keeps its fixed "unsupported" status: the answer\'s entry for it goes, its entry for an asked-for column stays', () => {
    const a = goodAnswer();
    const r = restored({ ...a, output: { ...a.output, columns: a.output.columns.map((c) => (c.header === 'ID' || c.header === 'Label' ? { ...c, from: null } : c)) }, unsupported: [{ outputColumn: 'ID', reasonCode: 'other' }, { outputColumn: 'Label', reasonCode: 'ambiguous' }] });
    expect(r.unsupported).toEqual([{ outputColumn: 'Label', reasonCode: 'ambiguous' }, { outputColumn: 'Note', reasonCode: 'externalData' }]);
    expect(r.output.columns.map((c) => c.from)).toEqual(['id', 'gross', null, null]);
    expect(checkFixedLock(r, fixedRules(), LISTED)).toEqual([]);
  });

  it('a value map the answer wrote on a column a fixed value map maps is replaced by the fixed one', () => {
    const a = goodAnswer();
    const r = restored({ ...a, transform: { ...a.transform, valueMaps: [{ column: 'status', map: { o: 'Changed' }, onMissing: 'flag' }] } });
    expect(r.transform.valueMaps).toEqual(fixedRules().transform.valueMaps);
  });

  it('does not touch a NEW value map on a column a fixed output column reads: the lock still reports it', () => {
    const a = goodAnswer();
    const r = restored({ ...a, transform: { ...a.transform, valueMaps: [...a.transform.valueMaps, { column: 'id', map: { '1': 'One' }, onMissing: 'keep' }] } });
    expect(checkFixedLock(r, fixedRules(), LISTED).map((p) => p.path)).toEqual(['transform.valueMaps[1]']);
  });

  it('rebuilds the output columns from the fixed ones when the count changed; the asked-for column keeps its rule', () => {
    const a = goodAnswer();
    const r = restored({ ...a, output: { ...a.output, columns: a.output.columns.filter((c) => c.header !== 'Note') } });
    expect(r.output.columns.map((c) => [c.header, c.from])).toEqual([['ID', 'id'], ['Gross', 'gross'], ['Label', 'label'], ['Note', null]]);
    expect(checkFixedLock(r, fixedRules(), LISTED)).toEqual([]);
  });

  it('a part that was asked for keeps what the answer built, plus the fixed element it dropped', () => {
    const a = goodAnswer();
    const opts: FixedLockOptions = { columns: [2], parts: ['sort', 'droppedRows'] };
    const answer: LearnResult = {
      ...a,
      input: { ...a.input, rowFilters: [{ column: 'amount', op: 'gt', value: 0 }] },
      transform: { ...a.transform, sort: [{ column: 'amount', dir: 'desc' }] },
    };
    const r = restored(answer, opts);
    expect(r.transform.sort).toEqual([{ column: 'amount', dir: 'desc' }, { column: 'id', dir: 'asc' }]);
    expect(r.input.rowFilters).toEqual([{ column: 'amount', op: 'gt', value: 0 }, { column: 'status', op: 'ne', value: 'void' }]);
    expect(checkFixedLock(r, fixedRules(), opts)).toEqual([]);
  });

  it('a part that was not asked for is the fixed one, whole: an added sort key or filter is taken out', () => {
    const a = goodAnswer();
    const r = restored({ ...a, transform: { ...a.transform, sort: [...a.transform.sort, { column: 'amount', dir: 'desc' }] } });
    expect(r.transform.sort).toEqual(fixedRules().transform.sort);
  });
});
