// SPEC 21 "M0 amendments for v3": schema-level tests for output.file (8.13),
// validations[].on (8.8), the rowFilters {expr} variant (8.3), transform.functions
// and transform.tables (8.14), and the new meta fields/status (8.12, 13). Every new
// field is optional so a bare-minimum v1-shaped LearnResult still parses unchanged.
import { describe, expect, it } from 'vitest';
import {
  LearnResultSchema,
  OutputFileSchema,
  RowFilterSchema,
  RulesFunctionSchema,
  RulesMetaSchema,
  RulesSchema,
  RulesTableSchema,
  ValidationSchema,
} from '../src/rules/schema';

function minimalLearnResult(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    input: {
      sheet: { pick: 'first' },
      headerRow: 'auto',
      columns: [{ id: 'a', header: 'A', type: 'text' }],
    },
    transform: { computed: [], valueMaps: [], sort: [] },
    output: {
      sheetName: 'Sheet1',
      direction: 'ltr',
      language: 'en',
      titleRows: [],
      columns: [{ header: 'A', from: 'a' }],
    },
    validations: [],
    unsupported: [],
    assumptions: [],
    ...overrides,
  };
}

describe('output.file (SPEC 8.13)', () => {
  it('is absent by default and the LearnResult still parses (v1 compatibility)', () => {
    const result = LearnResultSchema.safeParse(minimalLearnResult());
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.output.file).toBeUndefined();
  });

  it('parses every file type with delimiter/header/encoding/quote', () => {
    expect(OutputFileSchema.safeParse({ type: 'xlsx' }).success).toBe(true);
    expect(
      OutputFileSchema.safeParse({
        type: 'txt',
        delimiter: '\t',
        header: false,
        encoding: 'windows1255',
        quote: 'none',
      }).success,
    ).toBe(true);
    expect(
      OutputFileSchema.safeParse({ type: 'csv', delimiter: ',', encoding: 'utf8bom' }).success,
    ).toBe(true);
  });

  it('rejects an unknown file type or delimiter', () => {
    expect(OutputFileSchema.safeParse({ type: 'pdf' }).success).toBe(false);
    expect(OutputFileSchema.safeParse({ type: 'csv', delimiter: ':' }).success).toBe(false);
  });
});

describe('validations[].on (SPEC 8.8)', () => {
  it('defaults to absent (input) and still parses', () => {
    const result = ValidationSchema.safeParse({
      column: 'amount',
      rule: 'range',
      min: 0,
      severity: 'flag',
    });
    expect(result.success).toBe(true);
  });

  it('parses on: "output" naming an output header', () => {
    const result = ValidationSchema.safeParse({
      on: 'output',
      column: 'סכום כולל',
      rule: 'range',
      min: 0,
      severity: 'flag',
    });
    expect(result.success).toBe(true);
  });

  it('rejects a bad "on" value', () => {
    expect(
      ValidationSchema.safeParse({
        on: 'both',
        column: 'a',
        rule: 'required',
        severity: 'flag',
      }).success,
    ).toBe(false);
  });
});

describe('input.rowFilters {expr} variant (SPEC 8.3)', () => {
  it('parses the existing simple {column, op, value} shape', () => {
    expect(RowFilterSchema.safeParse({ column: 'status', op: 'ne', value: 'x' }).success).toBe(
      true,
    );
  });

  it('parses an {expr} row filter with a condition tree', () => {
    const result = RowFilterSchema.safeParse({
      expr: {
        op: 'and',
        args: [
          { op: 'notEmpty', arg: { col: 'status' } },
          { op: 'gt', args: [{ col: 'amount' }, { const: 0 }] },
        ],
      },
    });
    expect(result.success, JSON.stringify(!result.success && result.error.issues)).toBe(true);
  });

  it('rejects a rowFilter with neither column/op nor expr', () => {
    expect(RowFilterSchema.safeParse({ value: 'x' }).success).toBe(false);
  });
});

describe('transform.functions / transform.tables (SPEC 8.14)', () => {
  it('are absent by default and a v1-shaped LearnResult still parses', () => {
    const result = LearnResultSchema.safeParse(minimalLearnResult());
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.transform.functions).toBeUndefined();
      expect(result.data.transform.tables).toBeUndefined();
    }
  });

  it('parses a function using params, a constant and no col', () => {
    const result = RulesFunctionSchema.safeParse({
      name: 'netOf',
      params: [
        { name: 'gross', type: 'decimal' },
        { name: 'rate', type: 'decimal' },
      ],
      returns: 'decimal',
      body: {
        op: 'round',
        digits: 2,
        arg: {
          op: 'div',
          args: [{ param: 'gross' }, { op: 'add', args: [{ const: 1 }, { param: 'rate' }] }],
        },
      },
    });
    expect(result.success, JSON.stringify(!result.success && result.error.issues)).toBe(true);
  });

  it('rejects a function param/return with a currency-style ColumnType (not a ValueType)', () => {
    expect(
      RulesFunctionSchema.safeParse({
        name: 'f',
        params: [{ name: 'x', type: 'currency' }],
        returns: 'decimal',
        body: { param: 'x' },
      }).success,
    ).toBe(false);
  });

  it('parses a table with a unique first-column key', () => {
    const result = RulesTableSchema.safeParse({
      name: 'rates',
      columns: ['code', 'rate'],
      rows: [
        ['A', 0.1],
        ['B', 0.2],
      ],
    });
    expect(result.success).toBe(true);
  });

  it('rejects a table row that is not an array of primitives', () => {
    expect(
      RulesTableSchema.safeParse({
        name: 'rates',
        columns: ['code'],
        rows: [{ code: 'A' }],
      }).success,
    ).toBe(false);
  });
});

describe('meta fields (SPEC 8.12/13)', () => {
  it('accepts formatId, sourceName and status "needsReview"', () => {
    const result = RulesMetaSchema.safeParse({
      formatId: 'fmt_1',
      sourceName: 'Supplier A',
      source: 'examplePair',
      status: 'needsReview',
    });
    expect(result.success, JSON.stringify(!result.success && result.error.issues)).toBe(true);
  });

  it('still parses a v1-shaped meta with neither field', () => {
    const result = RulesMetaSchema.safeParse({ source: 'examplePair', status: 'verified' });
    expect(result.success).toBe(true);
  });
});

describe('RulesSchema end-to-end with every v3 addition at once', () => {
  it('parses a rules file combining output.file, on:"output", functions, tables and meta.formatId', () => {
    const rules = {
      ...minimalLearnResult({
        input: {
          sheet: { pick: 'first' },
          headerRow: 'auto',
          columns: [
            { id: 'code', header: 'Code', type: 'text' },
            { id: 'amount', header: 'Amount', type: 'decimal' },
          ],
        },
        transform: {
          computed: [
            {
              id: 'rate',
              type: 'decimal',
              expr: {
                op: 'lookup',
                table: 'rates',
                key: { col: 'code' },
                return: 'rate',
                onMissing: 'flag',
              },
            },
          ],
          valueMaps: [],
          sort: [],
          functions: [],
          tables: [
            {
              name: 'rates',
              columns: ['code', 'rate'],
              rows: [
                ['A', 0.1],
                ['B', 0.2],
              ],
            },
          ],
        },
        output: {
          file: { type: 'csv', delimiter: ',', header: true, encoding: 'utf8' },
          sheetName: 'Sheet1',
          direction: 'ltr',
          language: 'en',
          titleRows: [],
          columns: [
            { header: 'Code', from: 'code' },
            { header: 'Rate', from: 'rate' },
          ],
        },
        validations: [{ on: 'output', column: 'Rate', rule: 'range', min: 0, severity: 'flag' }],
      }),
      name: 'Combined v3 example',
      meta: { formatId: 'fmt_9', sourceName: 'Source X', source: 'examplePair', status: 'draft' },
    };
    const result = RulesSchema.safeParse(rules);
    expect(result.success, JSON.stringify(!result.success && result.error.issues, null, 2)).toBe(
      true,
    );
  });
});
