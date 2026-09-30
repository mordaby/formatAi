// A rules file for the editor tests: a small orders report, domain-neutral. Not imported by the app.
import type { Rules } from '@formatai/shared';

export function ordersRules(): Rules {
  return {
    schemaVersion: 1,
    name: 'Orders report',
    input: {
      sheet: { pick: 'first' },
      headerRow: 'auto',
      columns: [
        { id: 'sku', header: 'Item', type: 'idLike', padLeft: 6, required: true },
        { id: 'supplier', header: 'Supplier', type: 'text' },
        { id: 'qty', header: 'Qty', type: 'integer', required: true },
        { id: 'price', header: 'Unit price', type: 'decimal', required: true },
        { id: 'status', header: 'Status', type: 'text' },
        { id: 'shipped', header: 'Shipped', type: 'date', inputFormats: ['DD/MM/YYYY', 'excelSerial'] },
        { id: 'note', header: 'Note', type: 'text' },
      ],
      rowFilters: [
        { column: 'status', op: 'ne', value: 'cancelled' },
        { column: 'qty', op: 'gt', value: 0 },
      ],
    },
    transform: {
      computed: [
        { id: 'total', type: 'decimal', expr: { op: 'round', digits: 2, arg: { op: 'mul', args: [{ col: 'qty' }, { col: 'price' }] } } },
      ],
      valueMaps: [{ column: 'supplier', map: { Acme: 'ACM', Borealis: 'BOR' }, onMissing: 'keep' }],
      sort: [{ column: 'sku', dir: 'asc' }],
    },
    output: {
      file: { type: 'xlsx' },
      sheetName: 'Orders',
      direction: 'ltr',
      language: 'en',
      titleRows: [{ text: 'Orders report', bold: true }, { blank: true }],
      columns: [
        { header: 'Item', from: 'sku', width: 12 },
        { header: 'Supplier', from: 'supplier' },
        { header: 'Qty', from: 'qty' },
        { header: 'Total', from: 'total', format: '#,##0.00' },
        { header: 'Shipped', from: 'shipped', format: 'DD/MM/YYYY' },
        { header: 'Remarks', from: null },
      ],
      headerStyle: { bold: true },
      summaryRows: [{ label: 'Total', labelColumn: 'Item', bold: true, cells: { Qty: 'sum', Total: 'sum' } }],
    },
    validations: [
      { column: 'qty', rule: 'range', min: 0, severity: 'flag' },
      { on: 'output', column: 'Total', rule: 'range', min: 0, severity: 'flag' },
    ],
    unsupported: [{ outputColumn: 'Remarks', reasonCode: 'externalData' }],
    assumptions: [{ outputColumn: 'Total', reasonCode: 'roundingGuessed' }],
    meta: { source: 'examplePair', status: 'verified' },
  };
}

/** The same file, written the way a stored v1-v3 rules file was: the deprecated `grandTotal` and group `subtotal`. */
export function legacyTotalsRules(): Rules {
  const r = ordersRules();
  const { summaryRows: _summaryRows, ...output } = r.output;
  void _summaryRows;
  return {
    ...r,
    transform: { ...r.transform, group: { by: 'supplier', showDetailRows: true, subtotal: { labelColumn: 'sku', label: 'Subtotal', sum: ['qty', 'total'] } } },
    output: { ...output, grandTotal: { labelColumn: 'sku', label: 'Total', sum: ['qty', 'total'] } },
  };
}
