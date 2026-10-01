import { describe, expect, it } from 'vitest';
import type { LearnPayload, LearnResult } from '@formatai/shared';
import { buildSampleInputTable, runOnSamples } from '../../src/learn/index.js';
import { basicPayload, correctRules, externalColumnPayload, externalColumnRules, wrongRoundingRules } from './fixtures.js';

describe('runOnSamples', () => {
  it('reports no problems when the rules exactly reproduce every sample', () => {
    const problems = runOnSamples(correctRules(), basicPayload());
    expect(problems).toEqual([]);
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
