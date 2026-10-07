import { describe, expect, it } from 'vitest';
import type { LearnPayload, LearnResult } from '@formatai/shared';
import { buildSampleInputTable, runOnSamples } from '../../src/learn/index.js';
import { basicPayload, correctRules, externalColumnPayload, externalColumnRules, wrongRoundingRules } from './fixtures.js';

describe('runOnSamples', () => {
  it('reports no problems when the rules exactly reproduce every sample', () => {
    const problems = runOnSamples(correctRules(), basicPayload());
    expect(problems).toEqual([]);
  });

  it('an expected cell holding empty text matches the empty cell the rules write (they look the same in Excel)', () => {
    const payload = basicPayload({ samples: [{ in: ['', 7], out: ['', 14] }, { in: ['A2', 5], out: ['A2', 10] }] });
    expect(runOnSamples(correctRules(), payload)).toEqual([]);
  });

  it('reports diff problems for wrong values (wrong multiplier)', () => {
    const problems = runOnSamples(wrongRoundingRules(), basicPayload());
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.every((p) => p.kind === 'diff')).toBe(true);
    const diffs = problems.filter((p) => p.kind === 'diff');
    // sample 0: expected 20, actual 10 (Amount x 1); sample 1: expected 10, actual 5.
    expect(diffs).toContainEqual({ kind: 'diff', out: 1, sample: 0, expected: 20, actual: 10 });
    expect(diffs).toContainEqual({ kind: 'diff', out: 1, sample: 1, expected: 10, actual: 5 });
  });

  it('handles family samples (expand: columnsToRows), row by row in order', () => {
    const payload: LearnPayload = {
      ...basicPayload(),
      input: {
        ...basicPayload().input,
        columns: [
          { i: 0, header: 'ID', type: 'idLike' },
          { i: 1, header: 'Jan', type: 'decimal' },
          { i: 2, header: 'Feb', type: 'decimal' },
        ],
      },
      output: {
        ...basicPayload().output,
        columns: [
          { i: 0, header: 'ID', type: 'idLike' },
          { i: 1, header: 'Month', type: 'text' },
          { i: 2, header: 'Value', type: 'decimal' },
        ],
      },
      samples: [
        {
          in: ['A1', 10, 20],
          out: [
            ['A1', 'Jan', 10],
            ['A1', 'Feb', 20],
          ],
        },
      ],
    };
    const rules: LearnResult = {
      schemaVersion: 1,
      input: {
        sheet: { pick: 'first' },
        headerRow: 'auto',
        columns: [
          { id: 'id', header: 'ID', type: 'idLike' },
          { id: 'jan', header: 'Jan', type: 'decimal' },
          { id: 'feb', header: 'Feb', type: 'decimal' },
        ],
      },
      transform: {
        computed: [],
        valueMaps: [],
        sort: [],
        expand: {
          mode: 'columnsToRows',
          columns: ['jan', 'feb'],
          labelId: 'month',
          valueId: 'value',
          valueType: 'decimal',
          skipEmpty: false,
        },
      },
      output: {
        sheetName: 'Out',
        direction: 'ltr',
        language: 'en',
        titleRows: [],
        columns: [
          { header: 'ID', from: 'id' },
          { header: 'Month', from: 'month' },
          { header: 'Value', from: 'value' },
        ],
      },
      validations: [],
      unsupported: [],
      assumptions: [],
    };

    expect(runOnSamples(rules, payload)).toEqual([]);
  });

  it('flags a dropped row that the rules wrongly keep', () => {
    const payload: LearnPayload = {
      masking: false,
      input: {
        sheetName: 'Sheet1',
        direction: 'ltr',
        layout: { headerRow: 0, rowsAbove: 0, footerFirstCell: [] },
        columns: [
          { i: 0, header: 'ID', type: 'idLike' },
          { i: 1, header: 'Status', type: 'text' },
        ],
      },
      output: {
        file: { type: 'xlsx' },
        layout: {
          sheetName: 'Out',
          direction: 'ltr',
          language: 'en',
          titleRows: [],
          headerRow: 0,
          headerBold: false,
          summary: false,
          groupBy: null,
          summaryRows: [],
          sort: null,
        },
        columns: [
          { i: 0, header: 'ID', type: 'idLike' },
          { i: 1, header: 'Status', type: 'text' },
        ],
      },
      samples: [{ in: ['A1', 'Active'], out: ['A1', 'Active'] }],
      dropped: [['A2', 'Cancelled']],
      hints: [],
    };
    const rulesWithoutFilter: LearnResult = {
      schemaVersion: 1,
      input: {
        sheet: { pick: 'first' },
        headerRow: 'auto',
        columns: [
          { id: 'id', header: 'ID', type: 'idLike' },
          { id: 'status', header: 'Status', type: 'text' },
        ],
      },
      transform: { computed: [], valueMaps: [], sort: [] },
      output: {
        sheetName: 'Out',
        direction: 'ltr',
        language: 'en',
        titleRows: [],
        columns: [
          { header: 'ID', from: 'id' },
          { header: 'Status', from: 'status' },
        ],
      },
      validations: [],
      unsupported: [],
      assumptions: [],
    };

    const problems = runOnSamples(rulesWithoutFilter, payload);
    expect(problems.some((p) => p.kind === 'diff' && 'row' in p && p.row?.in[0] === 'A2')).toBe(true);
    // Prompt audit X1: `row.out` is the example's output for the row - nothing - and the row the rules made is `made`.
    expect(problems).toContainEqual({ kind: 'diff', out: 0, row: { in: ['A2', 'Cancelled'], out: [] }, made: ['A2', 'Cancelled'], expected: null, actual: 'A2' });

    const rulesWithFilter: LearnResult = {
      ...rulesWithoutFilter,
      input: {
        ...rulesWithoutFilter.input,
        rowFilters: [{ column: 'status', op: 'ne', value: 'Cancelled' }],
      },
    };
    expect(runOnSamples(rulesWithFilter, payload)).toEqual([]);
  });

  it('reports a rowCount problem when the total row count is wrong', () => {
    const payload: LearnPayload = {
      ...basicPayload(),
      samples: [
        { in: ['A1', 10], out: ['A1', 20] },
        { in: ['A2', 5], out: ['A2', 10] },
      ],
    };
    // Missing one sample's output entirely by filtering everything out.
    const rules: LearnResult = {
      ...correctRules(),
      input: { ...correctRules().input, rowFilters: [{ column: 'id', op: 'eq', value: 'NOBODY' }] },
    };
    const problems = runOnSamples(rules, payload);
    expect(problems).toContainEqual({ kind: 'rowCount', expected: 2, actual: 0 });
  });
});

describe('buildSampleInputTable', () => {
  it('orders headers by column position and includes sample + dropped rows', () => {
    const payload = basicPayload({ dropped: [['A3', 1]] });
    const table = buildSampleInputTable(payload);
    expect(table.headers).toEqual(['ID', 'Amount']);
    expect(table.rows).toHaveLength(3); // 2 samples + 1 dropped
    expect(table.rowNumbers).toEqual([1, 2, 3]);
    expect(table.rows[0]).toEqual([{ v: 'A1' }, { v: 10 }]);
    expect(table.rows[2]).toEqual([{ v: 'A3' }, { v: 1 }]);
  });

  it('converts an ISO date to an Excel serial with isDate:true when stats.serialDates is set', () => {
    const payload: LearnPayload = {
      ...basicPayload(),
      input: {
        ...basicPayload().input,
        columns: [
          { i: 0, header: 'ID', type: 'idLike' },
          { i: 1, header: 'When', type: 'date', stats: { serialDates: true } },
        ],
      },
      samples: [{ in: ['A1', '2024-03-15'], out: ['A1', '2024-03-15'] }],
    };
    const table = buildSampleInputTable(payload);
    const cell = table.rows[0]![1];
    expect(cell?.isDate).toBe(true);
    expect(typeof cell?.v).toBe('number');
  });

  it('leaves an ISO date as plain text when stats.serialDates is not set', () => {
    const payload: LearnPayload = {
      ...basicPayload(),
      input: {
        ...basicPayload().input,
        columns: [
          { i: 0, header: 'ID', type: 'idLike' },
          { i: 1, header: 'When', type: 'date' },
        ],
      },
      samples: [{ in: ['A1', '2024-03-15'], out: ['A1', '2024-03-15'] }],
    };
    const table = buildSampleInputTable(payload);
    expect(table.rows[0]![1]).toEqual({ v: '2024-03-15' });
  });

  it('API audit C3: has the listed columns only, each read at its position - a huge position builds no huge table', () => {
    const payload: LearnPayload = {
      ...basicPayload(),
      input: {
        ...basicPayload().input,
        columns: [
          { i: 4_294_967_294, header: 'Amount', type: 'decimal' },
          { i: 0, header: 'ID', type: 'idLike' },
        ],
      },
      samples: [{ in: ['A1', 10], out: ['A1', 20] }],
    };
    const started = Date.now();
    const table = buildSampleInputTable(payload);
    expect(Date.now() - started).toBeLessThan(100); // was minutes (or out of memory) at this position
    expect(table.headers).toEqual(['ID', 'Amount']);
    expect(table.rows[0]).toEqual([{ v: 'A1' }, null]);
  });

  it('a gap between positions is no column of its own (the rules find their columns by header)', () => {
    const payload: LearnPayload = {
      ...basicPayload(),
      input: {
        ...basicPayload().input,
        columns: [
          { i: 0, header: 'ID', type: 'idLike' },
          { i: 3, header: 'Amount', type: 'decimal' },
        ],
      },
      samples: [{ in: ['A1', 'x', 'y', 10], out: ['A1', 20] }, { in: ['A2', 'x', 'y', 5], out: ['A2', 10] }],
    };
    const table = buildSampleInputTable(payload);
    expect(table.headers).toEqual(['ID', 'Amount']);
    expect(table.rows[0]).toEqual([{ v: 'A1' }, { v: 10 }]);
    expect(runOnSamples(correctRules(), payload)).toEqual([]);
  });
});

describe('runOnSamples: a column reported as unsupported', () => {
  it('is not compared with the samples (it would differ on every row): from null + an unsupported entry, any reason code', () => {
    expect(runOnSamples(externalColumnRules(), externalColumnPayload())).toEqual([]);
    expect(runOnSamples(externalColumnRules('hiddenByMasking'), externalColumnPayload())).toEqual([]);
  });

  it('does not hide a real difference in another column', () => {
    const rules = externalColumnRules();
    const wrong: LearnResult = { ...rules, transform: { ...rules.transform, computed: [{ id: 'total', type: 'decimal', expr: { op: 'mul', args: [{ col: 'amount' }, { const: 1 }] } }] } };
    const problems = runOnSamples(wrong, externalColumnPayload());
    expect(problems).toContainEqual({ kind: 'diff', out: 1, sample: 0, expected: 20, actual: 10 });
    expect(problems.some((p) => p.kind === 'diff' && p.out === 2)).toBe(false);
  });

  it('is still compared when the answer does NOT report it (a column with no entry is a mismatch like any other)', () => {
    const noEntry: LearnResult = { ...externalColumnRules(), unsupported: [] };
    const problems = runOnSamples(noEntry, externalColumnPayload());
    expect(problems).toContainEqual({ kind: 'diff', out: 2, sample: 0, expected: 'North', actual: null });
  });
});

// The sample table holds only the sample rows: one row per group of a summary output, a few rows of the file. A column that reads OTHER rows
// can never match the example there, whatever the rules are - so the right rules must not be "diffed" (the repair call would be pushed away
// from them); the browser's full verification compares those columns on every row.
describe('runOnSamples: columns that read other rows are not compared with the samples', () => {
  const summaryPayload = (): LearnPayload => ({
    ...basicPayload(),
    input: {
      ...basicPayload().input,
      columns: [
        { i: 0, header: 'PO No', type: 'text' },
        { i: 1, header: 'Supplier', type: 'text' },
        { i: 2, header: 'Qty', type: 'integer' },
        { i: 3, header: 'Amount', type: 'decimal' },
      ],
    },
    output: {
      ...basicPayload().output,
      layout: { ...basicPayload().output.layout, summary: true, groupBy: { out: 0, blankRowsAfter: 0 } },
      columns: [
        { i: 0, header: 'Supplier', type: 'text' },
        { i: 1, header: 'Orders', type: 'integer' },
        { i: 2, header: 'Total Qty', type: 'integer' },
        { i: 3, header: 'Total Amount', type: 'decimal' },
        { i: 4, header: 'Avg Order Value', type: 'decimal' },
      ],
    },
    // the group's FIRST input row, and the group's row
    samples: [
      { in: ['PO-1', 'Acme', 40, 1529.98], out: ['Acme', 6, 185, 6035.63, 1005.94] },
      { in: ['PO-12', 'Globex', 9, 925.04], out: ['Globex', 4, 102, 4480.59, 1120.15] },
      { in: ['PO-7', 'Initech', 19, 1622.75], out: ['Initech', 5, 79, 6768.54, 1353.71] },
    ],
  });

  const summaryRules = (totalAmountAgg: 'sum' | 'first' = 'sum'): LearnResult => ({
    schemaVersion: 1,
    input: {
      sheet: { pick: 'first' },
      headerRow: 'auto',
      columns: [
        { id: 'poNo', header: 'PO No', type: 'text' },
        { id: 'supplier', header: 'Supplier', type: 'text' },
        { id: 'qty', header: 'Qty', type: 'integer' },
        { id: 'amount', header: 'Amount', type: 'decimal' },
      ],
    },
    transform: { computed: [], valueMaps: [], sort: [{ column: 'supplier', dir: 'asc' }], group: { by: 'supplier', showDetailRows: false } },
    output: {
      sheetName: 'Out',
      direction: 'ltr',
      language: 'en',
      titleRows: [],
      columns: [
        { header: 'Supplier', from: 'supplier', agg: 'first' },
        { header: 'Orders', from: 'poNo', agg: 'count' },
        { header: 'Total Qty', from: 'qty', agg: 'sum' },
        { header: 'Total Amount', from: 'amount', agg: totalAmountAgg },
        { header: 'Avg Order Value', from: 'amount', agg: 'average' },
      ],
    },
    validations: [],
    unsupported: [],
    assumptions: [],
  });

  it('a summary output: the sum, count and average over the one sample row of each group are not diffs (the right rules have no problem)', () => {
    expect(runOnSamples(summaryRules(), summaryPayload())).toEqual([]);
  });

  it('a summary output: a column that is only the first row\'s value (agg "first") is still compared - it is wrong here, and the sample says so', () => {
    const problems = runOnSamples(summaryRules('first'), summaryPayload());
    expect(problems).toContainEqual({ kind: 'diff', out: 3, sample: 0, expected: 6035.63, actual: 1529.98 });
    expect(problems.every((p) => p.kind === 'diff' && p.out === 3)).toBe(true);
  });

  const windowPayload = (): LearnPayload => ({
    ...basicPayload(),
    // rows 1 and 2 of the sample are far apart in the file: the running total over the file is not the one over the sample rows
    samples: [
      { in: ['A1', 10], out: ['A1', 10] },
      { in: ['A2', 5], out: ['A2', 40] },
    ],
  });

  const runningRules = (viaHelper = false): LearnResult => {
    const rules = correctRules();
    const running = { id: 'running', type: 'decimal' as const, expr: { op: 'window' as const, fn: 'runningSum' as const, arg: { col: 'amount' } } };
    const computed = viaHelper ? [running, { id: 'shown', type: 'decimal' as const, expr: { op: 'add' as const, args: [{ col: 'running' }, { const: 0 }] } }] : [running];
    return { ...rules, transform: { ...rules.transform, computed }, output: { ...rules.output, columns: [{ header: 'ID', from: 'id' }, { header: 'Total', from: viaHelper ? 'shown' : 'running' }] } };
  };

  it('a window function: the running total over the sample rows is not the one over the file, so that column is not a diff - directly or through another computed column', () => {
    expect(runOnSamples(runningRules(), windowPayload())).toEqual([]);
    expect(runOnSamples(runningRules(true), windowPayload())).toEqual([]);
  });

  it('every other column next to it is still compared', () => {
    const rules = runningRules();
    const wrongId: LearnResult = { ...rules, output: { ...rules.output, columns: [{ header: 'ID', from: 'amount' }, rules.output.columns[1]!] } };
    const problems = runOnSamples(wrongId, windowPayload());
    expect(problems.some((p) => p.kind === 'diff' && p.out === 0)).toBe(true);
    expect(problems.some((p) => p.kind === 'diff' && p.out === 1)).toBe(false);
  });

  it('a rowCount problem is not reported once the diff cap stopped the walk (the samples reached are not all of them)', () => {
    const samples = Array.from({ length: 12 }, (_, i) => ({ in: [`A${i}`, 10], out: [`A${i}`, 20] }));
    const problems = runOnSamples(wrongRoundingRules(), { ...basicPayload(), samples });
    expect(problems.filter((p) => p.kind === 'diff')).toHaveLength(10);
    expect(problems.some((p) => p.kind === 'rowCount')).toBe(false);
  });
});
