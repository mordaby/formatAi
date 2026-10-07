// "Same format" is decided by the output's structure only (owner decision 2026-10-07): headers in order, file kind, title rows (how many, not
// their text), summary rows and grouping. Everything else is the format lock's.
import { describe, expect, it } from 'vitest';
import type { Format } from '../src/format';
import { normalizeOutputHeader, outputStructureOf, sameOutputStructure } from '../src/formatMatch';

function format(over: { output?: Partial<Format['output']>; layout?: Format['layout']; outputValidations?: Format['outputValidations'] } = {}): Format {
  return {
    output: {
      file: { type: 'xlsx' },
      sheetName: 'Report',
      direction: 'ltr',
      language: 'en',
      titleRows: [],
      columns: [{ header: 'Order ID' }, { header: 'Customer' }, { header: 'Total', format: '#,##0.00' }],
      summaryRows: [],
      ...over.output,
    },
    layout: over.layout ?? { sort: [] },
    outputValidations: over.outputValidations ?? [],
  };
}

describe('normalizeOutputHeader', () => {
  it('trims and folds runs of whitespace, and nothing else', () => {
    expect(normalizeOutputHeader('  Order  ID\t')).toBe('Order ID');
    expect(normalizeOutputHeader('order id')).toBe('order id');
  });
});

describe('sameOutputStructure', () => {
  it('the same output is the same format', () => {
    expect(sameOutputStructure(format(), format())).toBe(true);
  });

  it('a renamed output column is not (headers are compared exactly, in order)', () => {
    const renamed = format({ output: { columns: [{ header: 'Order ID' }, { header: 'Client' }, { header: 'Total' }] } });
    expect(sameOutputStructure(format(), renamed)).toBe(false);
    const swapped = format({ output: { columns: [{ header: 'Customer' }, { header: 'Order ID' }, { header: 'Total' }] } });
    expect(sameOutputStructure(format(), swapped)).toBe(false);
    const cased = format({ output: { columns: [{ header: 'order id' }, { header: 'Customer' }, { header: 'Total' }] } });
    expect(sameOutputStructure(format(), cased)).toBe(false);
  });

  it('spaces around or inside a header do not count', () => {
    const spaced = format({ output: { columns: [{ header: ' Order  ID ' }, { header: 'Customer' }, { header: 'Total' }] } });
    expect(sameOutputStructure(format(), spaced)).toBe(true);
  });

  it('another file kind, or no header row, is not', () => {
    expect(sameOutputStructure(format(), format({ output: { file: { type: 'csv' } } }))).toBe(false);
    const headerless = format({ output: { file: { type: 'csv', header: false } } });
    expect(sameOutputStructure(headerless, headerless)).toBe(false);
    expect(outputStructureOf(headerless)).toBeNull();
  });

  it('the title text changes by month: still the same format; another number of title rows is not', () => {
    const march = format({ output: { titleRows: [{ text: 'Report for March' }, { blank: true }] } });
    const april = format({ output: { titleRows: [{ parts: [{ text: 'Report for ' }, { agg: 'max', column: 'date', format: 'MMMM' }] }, { blank: true }] } });
    expect(sameOutputStructure(march, april)).toBe(true);
    expect(sameOutputStructure(march, format({ output: { titleRows: [{ text: 'Report for March' }] } }))).toBe(false);
    expect(sameOutputStructure(march, format())).toBe(false);
  });

  it('summary rows: their columns and aggregates count, their label does not', () => {
    const total = format({ output: { summaryRows: [{ label: 'Total', cells: { Total: 'sum' } }] } });
    expect(sameOutputStructure(total, format({ output: { summaryRows: [{ label: 'Grand total', bold: true, cells: { Total: 'sum' } }] } }))).toBe(true);
    expect(sameOutputStructure(total, format({ output: { summaryRows: [{ label: 'Total', cells: { Total: 'average' } }] } }))).toBe(false);
    expect(sameOutputStructure(total, format({ output: { summaryRows: [{ label: 'Total', cells: { Customer: 'count' } }] } }))).toBe(false);
    expect(sameOutputStructure(total, format())).toBe(false);
  });

  it('grouping counts: by which column, with the detail rows or not, and the group summary rows', () => {
    const byCustomer = format({ layout: { sort: [], group: { by: 'Customer', showDetailRows: true, summaryRows: [{ cells: { Total: 'sum' } }] } } });
    expect(sameOutputStructure(byCustomer, format({ layout: { sort: [{ header: 'Total', dir: 'desc' }], group: { by: 'Customer', showDetailRows: true, blankRowsAfter: 1, summaryRows: [{ label: 'Subtotal', cells: { Total: 'sum' } }] } } }))).toBe(true);
    expect(sameOutputStructure(byCustomer, format())).toBe(false);
    expect(sameOutputStructure(byCustomer, format({ layout: { sort: [], group: { by: 'Order ID', showDetailRows: true, summaryRows: [{ cells: { Total: 'sum' } }] } } }))).toBe(false);
    expect(sameOutputStructure(byCustomer, format({ layout: { sort: [], group: { by: 'Customer', showDetailRows: false, summaryRows: [{ cells: { Total: 'sum' } }] } } }))).toBe(false);
  });

  it('what the format lock decides is not compared: number formats, widths, sheet, direction, sort, output checks', () => {
    const other = format({
      output: { sheetName: 'Other', direction: 'rtl', language: 'he', columns: [{ header: 'Order ID', width: 20 }, { header: 'Customer' }, { header: 'Total', format: '0' }] },
      layout: { sort: [{ header: 'Order ID', dir: 'asc' }] },
      outputValidations: [{ on: 'output', column: 'Total', rule: 'required', severity: 'flag' }],
    });
    expect(sameOutputStructure(format(), other)).toBe(true);
  });
});
