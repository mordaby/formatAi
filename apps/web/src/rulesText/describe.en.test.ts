import type { Expr, LearnResult } from '@formatai/shared';
import { describe, expect, it } from 'vitest';
import { describeRules } from './describe';
import { col, lineTexts, num, rules, str, withColumn, type Patch } from './fixtures';
import type { RulesMapModel } from './types';

const en = (r: LearnResult): RulesMapModel => describeRules(r, { lang: 'en' });

/** The sentence of one line. */
function line(model: RulesMapModel, id: string): string {
  const found = lineTexts(model).find(([lineId]) => lineId === id);
  if (!found) throw new Error(`no line ${id} in ${JSON.stringify(lineTexts(model))}`);
  return found[1];
}

/** The sentence of the one calculated column made by `withColumn`. */
const calc = (expr: Expr, header = 'Result', patch: Patch = {}): string => line(en(withColumn(header, expr, patch)), `col:${header}`);

const mul = (...args: Expr[]): Expr => ({ op: 'mul', args });

describe('sections', () => {
  it('always has rows, columns, layout and checks, in that order, with plain titles', () => {
    const model = en(rules());
    expect(model.sections.map((s) => [s.id, s.title])).toEqual([
      ['rows', 'Rows'],
      ['columns', 'Columns'],
      ['layout', 'Layout'],
      ['checks', 'Checks'],
    ]);
  });

  it('adds Functions and tables only when the rules define some', () => {
    const model = en(rules({ transform: { tables: [{ name: 't', columns: ['k', 'v'], rows: [['a', 1]] }] } }));
    expect(model.sections.at(-1)).toMatchObject({ id: 'functions', title: 'Functions and tables' });
  });
});

describe('columns', () => {
  it('copies a column', () => {
    expect(line(en(rules()), 'col:Name')).toBe('Name ← Name');
  });

  it('shows the input header, never the internal id', () => {
    const model = en(rules({ output: { columns: [{ header: 'Vendor', from: 'c_supplier' }] } }));
    expect(line(model, 'col:Vendor')).toBe('Vendor ← Supplier');
  });

  it('writes a padded copy', () => {
    expect(line(en(rules({ output: { columns: [{ header: 'Code', from: 'c_code' }] } })), 'col:Code')).toBe(
      'Code ← Code, padded to 9 digits',
    );
  });

  it('shows a date format only for dates', () => {
    const model = en(
      rules({
        output: {
          columns: [
            { header: 'When', from: 'c_date', format: 'DD/MM/YYYY' },
            { header: 'Cost', from: 'c_cost', format: '#,##0.00' },
          ],
        },
      }),
    );
    expect(line(model, 'col:When')).toBe('When ← Date, shown as DD/MM/YYYY');
    expect(line(model, 'col:Cost')).toBe('Cost ← Cost');
  });

  it('writes a fixed value', () => {
    expect(calc(str('ILS'), 'Currency')).toBe("Currency ← fixed value 'ILS'");
    expect(calc(num(0), 'Zero')).toBe('Zero ← fixed value 0');
    expect(calc({ const: null }, 'Nothing')).toBe('Nothing ← left empty');
  });

  it('translates values with a value map', () => {
    const map = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`g${i}`, `G${i}`]));
    const model = en(
      rules({
        transform: { valueMaps: [{ column: 'c_group', map, onMissing: 'flag' }] },
        output: { columns: [{ header: 'Category', from: 'c_group' }] },
      }),
    );
    expect(line(model, 'col:Category')).toBe('Category ← translated from Group (12 values; new values are flagged)');
  });

  it('says when unmapped values stay as they are, and counts one value', () => {
    const model = en(
      rules({
        transform: { valueMaps: [{ column: 'c_group', map: { a: 'A' }, onMissing: 'keep' }] },
        output: { columns: [{ header: 'Category', from: 'c_group' }] },
      }),
    );
    expect(line(model, 'col:Category')).toBe('Category ← translated from Group (1 value; new values stay as they are)');
  });

  it('adds "then translated" after a calculation', () => {
    const model = en(
      rules({
        transform: {
          computed: [{ id: 'p_x', type: 'text', expr: { op: 'upper', arg: col('c_group') } }],
          valueMaps: [{ column: 'p_x', map: { A: '1', B: '2' }, onMissing: 'flag' }],
        },
        output: { columns: [{ header: 'Kind', from: 'p_x' }] },
      }),
    );
    expect(line(model, 'col:Kind')).toBe('Kind ← Group, in capital letters, then translated (2 values; new values are flagged)');
  });

  it('leaves a column with no source empty and asks for input', () => {
    const model = en(rules({ output: { columns: [{ header: 'Fulfillment', from: null }] }, unsupported: [{ outputColumn: 'Fulfillment', reasonCode: 'externalData' }] }));
    expect(line(model, 'col:Fulfillment')).toBe('Fulfillment ← left empty (needs your input)');
  });

  it('keeps duplicate headers apart', () => {
    const model = en(rules({ output: { columns: [{ header: 'A', from: 'c_name' }, { header: 'A', from: 'c_code' }] } }));
    const ids = model.sections[1]!.lines.map((l) => l.id);
    expect(new Set(ids).size).toBe(2);
    expect(ids[0]).toBe('col:A');
  });
});

describe('calculations', () => {
  it('writes arithmetic with × ÷ + − and rounding', () => {
    expect(calc({ op: 'round', digits: 2, arg: mul(col('c_cost'), num(1.18)) }, 'Price')).toBe('Price ← Cost × 1.18, rounded to 2 decimals');
    expect(calc({ op: 'add', args: [col('c_cost'), col('c_amount')] })).toBe('Result ← Cost + Amount');
    expect(calc({ op: 'sub', args: [col('c_cost'), col('c_amount')] })).toBe('Result ← Cost − Amount');
    expect(calc({ op: 'div', args: [col('c_amount'), col('c_cost')] })).toBe('Result ← Amount ÷ Cost');
  });

  it('keeps parentheses where the order matters', () => {
    expect(calc(mul({ op: 'add', args: [col('c_cost'), col('c_amount')] }, num(2)))).toBe('Result ← (Cost + Amount) × 2');
  });

  it('describes other roundings', () => {
    expect(calc({ op: 'round', digits: 0, arg: col('c_cost') })).toBe('Result ← Cost, rounded to a whole number');
    expect(calc({ op: 'round', digits: 1, arg: col('c_cost') })).toBe('Result ← Cost, rounded to 1 decimal');
    expect(calc({ op: 'round', digits: -2, arg: col('c_cost') })).toBe('Result ← Cost, rounded to the nearest 100');
  });

  it('describes padding', () => {
    expect(calc({ op: 'padLeft', arg: col('c_order'), length: 9, char: '0' })).toBe('Result ← Order number, padded to 9 digits');
    expect(calc({ op: 'padLeft', arg: col('c_order'), length: 5, char: 'x' })).toBe("Result ← Order number, padded to 5 characters with 'x'");
  });

  it('describes parts of text', () => {
    expect(calc({ op: 'substr', arg: col('c_code'), start: 1, length: 3 })).toBe('Result ← the first 3 characters of Code');
    expect(calc({ op: 'substr', arg: col('c_code'), start: 1, length: 1 })).toBe('Result ← the first character of Code');
    expect(calc({ op: 'substr', arg: col('c_code'), start: -2, length: 2 })).toBe('Result ← the last 2 characters of Code');
    expect(calc({ op: 'substr', arg: col('c_code'), start: 2, length: 3 })).toBe('Result ← 3 characters of Code, starting at position 2');
  });

  it('describes joined text', () => {
    expect(calc({ op: 'concat', args: [col('c_code'), str(' - '), col('c_name')] })).toBe("Result ← Code joined with Name, separated by ' - '");
    expect(calc({ op: 'concat', args: [col('c_code'), str(' '), col('c_name')] })).toBe('Result ← Code joined with Name, separated by a space');
    expect(calc({ op: 'concat', args: [col('c_code'), str('-'), col('c_name'), str('-'), col('c_group')] })).toBe(
      "Result ← Code joined with Name and Group, separated by '-'",
    );
    expect(calc({ op: 'concat', args: [col('c_name'), col('c_code')] })).toBe('Result ← Name joined with Code');
    expect(calc({ op: 'concat', args: [str('A-'), col('c_code')] })).toBe("Result ← text made of 'A-' and Code");
  });

  it('describes cleaning', () => {
    expect(calc({ op: 'trim', arg: col('c_name') })).toBe('Result ← Name, with extra spaces removed');
    expect(calc({ op: 'lower', arg: col('c_name') })).toBe('Result ← Name, in lower case');
    expect(
      calc({ op: 'replaceText', arg: { op: 'replaceText', arg: col('c_name'), find: '-', with: '' }, find: ' ', with: '' }),
    ).toBe("Result ← Name with '-' and ' ' removed");
    expect(calc({ op: 'replaceText', arg: col('c_name'), find: 'a', with: 'b' })).toBe("Result ← Name with 'a' replaced by 'b'");
  });

  it('describes conditions', () => {
    expect(
      calc({ op: 'if', cond: { op: 'eq', args: [col('c_status'), str('VIP')] }, then: mul(col('c_cost'), num(0.9)), else: col('c_cost') }),
    ).toBe("Result ← Cost × 0.9 if Status is 'VIP', otherwise Cost");
    expect(
      calc({
        op: 'switch',
        cases: [
          { when: { op: 'gte', args: [col('c_amount'), num(10000)] }, then: str('VIP') },
          { when: { op: 'gte', args: [col('c_amount'), num(1000)] }, then: str('Regular') },
        ],
        else: str('Low'),
      }),
    ).toBe("Result ← 'VIP' if Amount is at least 10000; 'Regular' if Amount is at least 1000; otherwise 'Low'");
    expect(calc({ op: 'coalesce', args: [col('c_name'), col('c_group')] })).toBe('Result ← the first non-empty of Name and Group');
  });

  it('describes dates', () => {
    expect(calc({ op: 'datePart', arg: col('c_date'), part: 'month' })).toBe('Result ← the month of Date');
    expect(calc({ op: 'dateFormat', arg: col('c_date'), format: 'MMMM YYYY' })).toBe('Result ← Date written as MMMM YYYY');
    expect(calc({ op: 'dateAdd', arg: col('c_date'), days: 30 })).toBe('Result ← Date plus 30 days');
    expect(calc({ op: 'dateAdd', arg: col('c_date'), months: -1 })).toBe('Result ← Date minus 1 month');
    expect(calc({ op: 'dateDiff', args: [col('c_date'), col('c_date')], unit: 'days' })).toBe('Result ← the number of days between Date and Date');
    expect(calc({ op: 'endOfMonth', arg: col('c_date') })).toBe('Result ← the last day of the month of Date');
  });

  it('describes splitting text and lookups', () => {
    expect(calc({ op: 'split', arg: col('c_name'), separator: '-', index: 2 })).toBe("Result ← part 2 of Name, split at '-'");
    expect(calc({ op: 'split', arg: col('c_name'), separator: '-', index: -1 })).toBe("Result ← the last part of Name, split at '-'");
    const model = en(
      withColumn('Rate', { op: 'lookup', table: 'rates', key: col('c_code'), return: 'rate', onMissing: 'empty' }, {
        transform: { tables: [{ name: 'rates', columns: ['code', 'rate'], rows: [['A', 1]] }] },
      }),
    );
    expect(line(model, 'col:Rate')).toBe("Rate ← rate from the table 'rates', found by Code (missing keys are left empty)");
  });

  it('falls back to formula text with names in place of ids', () => {
    const model = en(
      withColumn('Fee', { op: 'call', fn: 'pct', args: [col('c_cost'), num(0.06)] }, {
        transform: {
          functions: [{ name: 'pct', params: [{ name: 'base', type: 'decimal' }, { name: 'rate', type: 'decimal' }], returns: 'decimal', body: { op: 'round', digits: 2, arg: mul({ param: 'base' }, { param: 'rate' }) } }],
        },
      }),
    );
    expect(line(model, 'col:Fee')).toBe('Fee ← pct(Cost, 0.06)');
    const parts = model.sections[1]!.lines[0]!.parts;
    expect(parts.find((p) => p.kind === 'formula')).toMatchObject({ kind: 'formula', text: 'pct(Cost, 0.06)' });
  });

  it('writes a helper column that no output column shows inline', () => {
    const model = en(
      rules({
        transform: {
          computed: [
            { id: 'p_tax', type: 'decimal', expr: mul(col('c_cost'), num(0.17)) },
            { id: 'p_total', type: 'decimal', expr: { op: 'add', args: [col('c_cost'), col('p_tax')] } },
          ],
        },
        output: { columns: [{ header: 'Total', from: 'p_total' }] },
      }),
    );
    expect(line(model, 'col:Total')).toBe('Total ← Cost + Cost × 0.17');
  });
});

describe('rows', () => {
  const f = (filters: NonNullable<LearnResult['input']['rowFilters']>): RulesMapModel => en(rules({ input: { rowFilters: filters } }));

  it('writes filters as sentences', () => {
    const model = f([
      { column: 'c_status', op: 'ne', value: 'Discontinued' },
      { column: 'c_amount', op: 'gt', value: 0 },
      { column: 'c_status', op: 'oneOf', value: ['A', 'B', 'C'] },
      { column: 'c_name', op: 'isEmpty' },
      { expr: { op: 'and', args: [{ op: 'ne', args: [col('c_status'), str('X')] }, { op: 'gt', args: [col('c_amount'), num(0)] }] } },
    ]);
    expect(line(model, 'filter:0')).toBe("Keep rows where Status is not 'Discontinued'");
    expect(line(model, 'filter:1')).toBe('Keep rows where Amount is greater than 0');
    expect(line(model, 'filter:2')).toBe("Keep rows where Status is one of 'A', 'B' or 'C'");
    expect(line(model, 'filter:3')).toBe('Keep rows where Name is empty');
    expect(line(model, 'filter:4')).toBe("Keep rows where Status is not 'X' and Amount is greater than 0");
  });

  it('describes duplicates in every combination', () => {
    const d = (keys: string[] | 'all', keep: 'first' | 'last', action: 'remove' | 'flag'): string =>
      line(en(rules({ transform: { dedupe: { keys, keep, action } } })), 'dedupe');
    expect(d(['c_order'], 'first', 'remove')).toBe('Rows with the same Order number: keep the first, remove the others');
    expect(d(['c_order'], 'last', 'remove')).toBe('Rows with the same Order number: keep the last, remove the earlier ones');
    expect(d(['c_order', 'c_supplier'], 'first', 'flag')).toBe(
      'Rows with the same Order number and Supplier: keep the first, flag the others as duplicates',
    );
    expect(d('all', 'last', 'flag')).toBe('Rows that are identical in every column: keep the last, flag the earlier ones as duplicates');
  });

  it('describes columns to rows', () => {
    const model = en(
      rules({
        transform: { expand: { mode: 'columnsToRows', columns: ['c_jan', 'c_feb'], labelId: 'x_month', valueId: 'x_amount', valueType: 'decimal', skipEmpty: true } },
        output: { columns: [{ header: 'Month', from: 'x_month' }, { header: 'Value', from: 'x_amount' }] },
      }),
    );
    expect(line(model, 'expand')).toBe('Turn Jan and Feb into separate rows: the column name goes in Month and its value in Value (empty cells are skipped)');
    expect(line(model, 'col:Month')).toBe('Month ← the name of the column the value came from (Jan and Feb)');
    expect(line(model, 'col:Value')).toBe('Value ← the value from that column');
  });

  it('describes splitting a cell into rows', () => {
    const model = en(
      rules({
        transform: { expand: { mode: 'splitCell', column: 'c_tags', separator: ';', trim: true, partId: 'x_tag', indexId: 'x_i', countId: 'x_n', skipEmpty: true } },
        output: { columns: [{ header: 'Tag', from: 'x_tag' }, { header: 'No.', from: 'x_i' }, { header: 'Of', from: 'x_n' }] },
      }),
    );
    expect(line(model, 'expand')).toBe(
      "Split Tags at ';' into separate rows: each part goes in Tag; the part number goes in No.; the number of parts goes in Of (spaces around each part are removed; empty parts are skipped)",
    );
    expect(line(model, 'col:Tag')).toBe('Tag ← each part of Tags');
  });

  it('describes a fixed fan-out', () => {
    const model = en(
      rules({
        transform: {
          expand: {
            mode: 'fixedFanOut',
            rows: [
              { set: { x_side: str('Debit'), x_value: col('c_amount') } },
              { set: { x_side: str('Credit'), x_value: { op: 'neg', arg: col('c_amount') } } },
            ],
          },
        },
        output: { columns: [{ header: 'Side', from: 'x_side' }, { header: 'Value', from: 'x_value' }] },
      }),
    );
    expect(line(model, 'expand')).toBe("Every row becomes 2 rows (row 1: Side = 'Debit', Value = Amount; row 2: Side = 'Credit', Value = −Amount)");
    expect(line(model, 'col:Side')).toBe("Side ← in new row 1: 'Debit'; in new row 2: 'Credit'");
  });

  it('describes how the input is read', () => {
    const model = en(
      rules({ input: { sheet: { pick: 'name', name: 'Data' }, headerRow: 2, stopAt: { when: 'firstCellMatches', values: ['Total', 'Sum'] } } }),
    );
    expect(line(model, 'input:sheet')).toBe("Read the sheet 'Data'");
    expect(line(model, 'input:headerRow')).toBe('The header is on row 3');
    expect(line(model, 'input:stopAt')).toBe("Stop reading at the first row that starts with 'Total' or 'Sum'");
    expect(line(en(rules({ input: { sheet: { pick: 'index', index: 1 } } })), 'input:sheet')).toBe('Read sheet number 2');
  });
});

describe('layout', () => {
  const layoutRules = (patch: Patch = {}): LearnResult =>
    rules({
      ...patch,
      output: {
        columns: [
          { header: 'Supplier', from: 'c_supplier' },
          { header: 'Date', from: 'c_date' },
          { header: 'Items', from: 'c_items' },
          { header: 'Amount', from: 'c_amount' },
        ],
        ...patch.output,
      },
    });

  it('sorts, with a plain word for descending order', () => {
    const sort = (dir: 'asc' | 'desc', column: string): string =>
      line(en(layoutRules({ transform: { sort: [{ column: 'c_supplier', dir: 'asc' }, { column, dir }] } })), 'sort');
    expect(sort('desc', 'c_date')).toBe('Sorted by Supplier, then Date (newest first)');
    expect(sort('desc', 'c_amount')).toBe('Sorted by Supplier, then Amount (largest first)');
    expect(sort('desc', 'c_items')).toBe('Sorted by Supplier, then Items (Z to A)');
    expect(sort('asc', 'c_date')).toBe('Sorted by Supplier, then Date');
  });

  it('uses the result\'s own name for the columns it sorts and groups by', () => {
    const model = en(
      rules({
        transform: { sort: [{ column: 'c_supplier', dir: 'asc' }] },
        output: { columns: [{ header: 'Vendor', from: 'c_supplier' }] },
      }),
    );
    expect(line(model, 'sort')).toBe('Sorted by Vendor');
  });

  it('describes groups and their summary rows', () => {
    const model = en(
      layoutRules({
        transform: {
          group: {
            by: 'c_supplier',
            showDetailRows: true,
            blankRowsAfter: 2,
            summaryRows: [{ label: 'Total', labelColumn: 'Date', cells: { Items: 'count', Amount: 'sum' } }],
          },
        },
        output: { summaryRows: [{ label: 'Grand total', bold: true, cells: { Amount: 'sum' } }, { cells: { Amount: 'average' } }] },
      }),
    );
    expect(line(model, 'group')).toBe('Group rows by Supplier (every row is shown)');
    expect(line(model, 'summary:group:0')).toBe("After each Supplier: a row 'Total' with the count of Items and the sum of Amount");
    expect(line(model, 'blank:group')).toBe('Leave 2 blank rows after each Supplier');
    expect(line(model, 'summary:end:0')).toBe("At the end: a row 'Grand total' with the sum of Amount, in bold");
    expect(line(model, 'summary:end:1')).toBe('At the end: a row with the average of Amount');
  });

  it('describes a one-row-per-group output', () => {
    const model = en(
      rules({
        transform: { group: { by: 'c_supplier', showDetailRows: false } },
        output: {
          columns: [
            { header: 'Supplier', from: 'c_supplier', agg: 'first' },
            { header: 'Orders', from: 'c_order', agg: 'count' },
            { header: 'Total', from: 'c_amount', agg: 'sum' },
          ],
        },
      }),
    );
    expect(line(model, 'group')).toBe('One row for each Supplier; the detail rows are not shown');
    expect(line(model, 'col:Supplier')).toBe('Supplier ← Supplier');
    expect(line(model, 'col:Orders')).toBe('Orders ← Order number, counted for each Supplier');
    expect(line(model, 'col:Total')).toBe('Total ← Amount, summed for each Supplier');
  });

  it('still reads the older grand total and subtotal fields', () => {
    const model = en(
      layoutRules({
        transform: { group: { by: 'c_supplier', showDetailRows: true, subtotal: { labelColumn: 'c_items', label: 'Subtotal', sum: ['c_amount'] } } },
        output: { grandTotal: { labelColumn: 'c_items', label: 'Total', sum: ['c_amount'] } },
      }),
    );
    expect(line(model, 'summary:group:0')).toBe("After each Supplier: a row 'Subtotal' with the sum of Amount");
    expect(line(model, 'summary:end:0')).toBe("At the end: a row 'Total' with the sum of Amount");
  });

  it('describes titles', () => {
    const model = en(
      layoutRules({
        output: {
          titleRows: [
            { text: 'Monthly report', bold: true },
            { parts: [{ text: 'Report for ' }, { agg: 'max', column: 'c_date', format: 'MMMM YYYY' }] },
            { parts: [{ text: 'From ' }, { agg: 'min', column: 'c_date', format: 'DD/MM/YYYY' }] },
            { blank: true },
          ],
        },
      }),
    );
    expect(line(model, 'title:0')).toBe("Title: 'Monthly report', in bold");
    expect(line(model, 'title:1')).toBe("Title: 'Report for ' + the month of the latest Date (MMMM YYYY)");
    expect(line(model, 'title:2')).toBe("Title: 'From ' + the earliest Date (DD/MM/YYYY)");
    expect(line(model, 'title:3')).toBe('A blank row');
  });

  it('describes the output file', () => {
    const file = (f: NonNullable<LearnResult['output']['file']>): string => line(en(rules({ output: { file: f } })), 'file');
    expect(line(en(rules({ output: { direction: 'rtl', sheetName: 'Sales' } })), 'file')).toBe("Excel file, sheet 'Sales', right-to-left");
    expect(file({ type: 'txt', delimiter: '\t', header: false, encoding: 'windows1255' })).toBe('Tab-separated text file, no header row, Windows-1255');
    expect(file({ type: 'csv' })).toBe('Comma-separated text file (CSV), with a header row, UTF-8 with BOM');
    expect(file({ type: 'csv', delimiter: ';', encoding: 'utf8', quote: 'all' })).toBe(
      'Semicolon-separated text file, with a header row, UTF-8, every value in quotes',
    );
    expect(file({ type: 'txt', delimiter: '|', quote: 'none' })).toBe('Pipe-separated text file, with a header row, UTF-8 with BOM, no quotes');
  });
});

describe('checks', () => {
  const v = (validation: LearnResult['validations'][number]): string => line(en(rules({ validations: [validation] })), 'check:0');

  it('describes every kind of check', () => {
    expect(v({ column: 'c_order', rule: 'israeliIdChecksum', severity: 'flag' })).toBe('Check: Order number is a valid Israeli ID number (flag)');
    expect(v({ column: 'c_name', rule: 'required', severity: 'block' })).toBe('Check: Name is not empty (leave out)');
    expect(v({ column: 'c_amount', rule: 'range', min: 0, severity: 'flag' })).toBe('Check: Amount is at least 0 (flag)');
    expect(v({ column: 'c_amount', rule: 'range', min: 0, max: 100, severity: 'flag' })).toBe('Check: Amount is between 0 and 100 (flag)');
    expect(v({ column: 'c_amount', rule: 'range', max: 5, severity: 'flag' })).toBe('Check: Amount is at most 5 (flag)');
    expect(v({ column: 'c_code', rule: 'lengthEquals', length: 9, severity: 'flag' })).toBe('Check: Code is exactly 9 characters long (flag)');
    expect(v({ column: 'c_status', rule: 'oneOf', values: ['A', 'B'], severity: 'flag' })).toBe("Check: Status is one of 'A' or 'B' (flag)");
    expect(v({ column: 'c_order', rule: 'unique', severity: 'flag' })).toBe('Check: Order number has no repeated values (flag)');
    expect(v({ column: 'c_date', rule: 'dateRange', from: '2024-01-01', to: '2024-12-31', severity: 'flag' })).toBe(
      'Check: Date is a date from 01/01/2024 to 31/12/2024 (flag)',
    );
  });

  it('names an output check by its output header', () => {
    expect(v({ on: 'output', column: 'Item Code', rule: 'required', severity: 'flag' })).toBe('Check: Item Code is not empty (flag)');
  });

  it('shortens a long list of allowed values', () => {
    const values = Array.from({ length: 9 }, (_, i) => `v${i}`);
    expect(v({ column: 'c_status', rule: 'oneOf', values, severity: 'flag' })).toBe(
      "Check: Status is one of 'v0', 'v1', 'v2', 'v3', 'v4', 'v5', … and 3 more (flag)",
    );
  });
});

describe('functions and tables', () => {
  it('writes a function with its signature', () => {
    const model = en(
      rules({
        transform: {
          functions: [{ name: 'pct', params: [{ name: 'base', type: 'decimal' }, { name: 'rate', type: 'decimal' }], returns: 'decimal', body: { op: 'round', digits: 2, arg: mul({ param: 'base' }, { param: 'rate' }) } }],
        },
      }),
    );
    expect(line(model, 'fn:pct')).toBe('pct(base, rate) = round(base × rate, 2)');
    expect(model.sections.at(-1)!.lines[0]!.target).toEqual({ kind: 'function', index: 0, name: 'pct' });
  });

  it('writes a table with its key and returned columns', () => {
    const rows = Array.from({ length: 12 }, (_, i) => [`k${i}`, 'x', i]);
    const model = en(rules({ transform: { tables: [{ name: 'rates', columns: ['code', 'category', 'rate'], rows }] } }));
    expect(line(model, 'table:rates')).toBe("Table 'rates': 12 entries, look up by code to get category and rate");
  });
});

describe('targets', () => {
  it('points every line at what the editor should open', () => {
    const model = en(
      rules({
        input: { rowFilters: [{ column: 'c_status', op: 'isEmpty' }] },
        transform: { dedupe: { keys: 'all', keep: 'first', action: 'remove' }, sort: [{ column: 'c_name', dir: 'asc' }] },
        output: { titleRows: [{ blank: true }] },
        validations: [{ column: 'c_name', rule: 'required', severity: 'flag' }],
      }),
    );
    const targets = Object.fromEntries(model.sections.flatMap((s) => s.lines.map((l) => [l.id, l.target])));
    expect(targets).toMatchObject({
      'filter:0': { kind: 'filter', index: 0 },
      dedupe: { kind: 'dedupe' },
      'col:Name': { kind: 'column', index: 0, header: 'Name' },
      'title:0': { kind: 'title', index: 0 },
      sort: { kind: 'sort' },
      file: { kind: 'file' },
      'check:0': { kind: 'validation', index: 0 },
    });
  });
});
