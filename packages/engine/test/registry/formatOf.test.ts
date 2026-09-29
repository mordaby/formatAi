// SPEC 8.12/21 (M0 amendment): "a pure function formatOf(rules) that extracts the
// format side (output, sort and group normalized to output headers, output
// validations)."
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { RulesSchema, type LearnResult } from '@formatai/shared';
import { formatOf } from '../../src/registry/formatOf';

const here = path.dirname(fileURLToPath(import.meta.url));
const goldenCasesDir = path.join(here, '..', 'golden', 'cases');

function readGolden(name: string) {
  const json = JSON.parse(fs.readFileSync(path.join(goldenCasesDir, name, 'rules.json'), 'utf8')) as unknown;
  return RulesSchema.parse(json);
}

describe('formatOf: he-commissions-report (sort, group, subtotal, grand total)', () => {
  const rules = readGolden('he-commissions-report');
  const format = formatOf(rules);

  it('strips columns[].from but keeps every other output field, with file defaulted', () => {
    expect(format.output.file).toEqual({ type: 'xlsx' });
    expect(format.output.columns).toEqual([
      { header: 'סוכן', width: 10 },
      { header: 'פוליסה', width: 12 },
      { header: 'מוצר' },
      { header: 'תאריך תחילה', format: 'DD/MM/YYYY' },
      { header: 'פרמיה', format: '#,##0.00' },
      { header: 'עמלה', format: '#,##0.00' },
    ]);
    expect(format.output.sheetName).toBe(rules.output.sheetName);
    expect(format.output.grandTotal).toEqual(rules.output.grandTotal); // kept verbatim (still id-based; see registry/formatOf.ts DECISION)
  });

  it('normalizes sort ids to output headers', () => {
    expect(format.layout.sort).toEqual([
      { header: 'סוכן', dir: 'asc' },
      { header: 'תאריך תחילה', dir: 'asc' },
    ]);
  });

  it('normalizes group.by and group.subtotal ids to output headers', () => {
    expect(format.layout.group).toEqual({
      by: 'סוכן',
      showDetailRows: true,
      subtotal: { labelHeader: 'פוליסה', label: 'סה"כ לסוכן', sums: ['פרמיה', 'עמלה'] },
      blankRowsAfter: 1,
    });
  });

  it('keeps only output (on: "output") validations - none here', () => {
    expect(format.outputValidations).toEqual([]);
  });
});

describe('formatOf: summary-by-agent (per-column agg, no detail rows)', () => {
  const format = formatOf(readGolden('summary-by-agent'));

  it('collects every output column agg into layout.group.agg, keyed by header', () => {
    expect(format.layout.group?.agg).toEqual({
      Agent: 'first',
      'First Client': 'first',
      Deals: 'count',
      'Total Amount': 'sum',
      'Max Amount': 'max',
    });
    expect(format.layout.group?.showDetailRows).toBe(false);
    expect(format.layout.group?.subtotal).toBeUndefined();
  });

  it('keeps agg on each FormatOutputColumn too', () => {
    expect(format.output.columns[0]).toEqual({ header: 'Agent', agg: 'first' });
  });
});

describe('formatOf: DECISION fallback when a sort/group id is not shown in any output column', () => {
  function makeRules(): LearnResult {
    return {
      schemaVersion: 1,
      input: {
        sheet: { pick: 'first' },
        headerRow: 'auto',
        columns: [
          { id: 'hidden', header: 'Hidden', type: 'text' },
          { id: 'shown', header: 'Shown', type: 'text' },
        ],
      },
      transform: { computed: [], valueMaps: [], sort: [{ column: 'hidden', dir: 'asc' }] },
      output: {
        sheetName: 'Out',
        direction: 'ltr',
        language: 'en',
        titleRows: [],
        columns: [{ header: 'Shown', from: 'shown' }],
      },
      validations: [],
      unsupported: [],
      assumptions: [],
    };
  }

  it('falls back to the raw id as the header, rather than throwing', () => {
    const format = formatOf(makeRules());
    expect(format.layout.sort).toEqual([{ header: 'hidden', dir: 'asc' }]);
  });
});

describe('formatOf: output validations only', () => {
  it('drops input validations and keeps output ones', () => {
    const rules: LearnResult = {
      schemaVersion: 1,
      input: { sheet: { pick: 'first' }, headerRow: 'auto', columns: [{ id: 'a', header: 'A', type: 'text' }] },
      transform: { computed: [], valueMaps: [], sort: [] },
      output: { sheetName: 'Out', direction: 'ltr', language: 'en', titleRows: [], columns: [{ header: 'A', from: 'a' }] },
      validations: [
        { column: 'a', rule: 'required', severity: 'flag' },
        { on: 'output', column: 'A', rule: 'required', severity: 'block' },
      ],
      unsupported: [],
      assumptions: [],
    };
    const format = formatOf(rules);
    expect(format.outputValidations).toEqual([{ on: 'output', column: 'A', rule: 'required', severity: 'block' }]);
  });
});
