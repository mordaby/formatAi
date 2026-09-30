// SPEC 8.12/21 (M0 amendment): "a pure function formatOf(rules) that extracts the
// format side (output, sort and group normalized to output headers, output
// validations)."
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { RulesSchema, type LearnResult, type Rules } from '@formatai/shared';
import { checkFormatLock } from '../../src/registry/checkFormatLock';
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
    // v4: the deprecated, id-based grandTotal is normalized into a header-keyed
    // summaryRows entry (SPEC 8.12/21 v4).
    expect(format.output.summaryRows).toEqual([
      { label: 'סה"כ', labelColumn: 'פוליסה', cells: { פרמיה: 'sum', עמלה: 'sum' } },
    ]);
  });

  it('normalizes sort ids to output headers', () => {
    expect(format.layout.sort).toEqual([
      { header: 'סוכן', dir: 'asc' },
      { header: 'תאריך תחילה', dir: 'asc' },
    ]);
  });

  it('normalizes group.by and the deprecated group.subtotal to header-keyed summaryRows', () => {
    expect(format.layout.group).toEqual({
      by: 'סוכן',
      showDetailRows: true,
      summaryRows: [{ label: 'סה"כ לסוכן', labelColumn: 'פוליסה', cells: { פרמיה: 'sum', עמלה: 'sum' } }],
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
    expect(format.layout.group?.summaryRows).toEqual([]);
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

describe('formatOf: SPEC 21 v4 - an old-style and a new-style conversion of the same format compare equal', () => {
  it('replacing group.subtotal/output.grandTotal with equivalent summaryRows produces the identical Format', () => {
    const oldStyle = readGolden('he-commissions-report');
    const newStyle: Rules = structuredClone(oldStyle);
    delete newStyle.output.grandTotal;
    newStyle.output.summaryRows = [{ label: 'סה"כ', labelColumn: 'פוליסה', cells: { פרמיה: 'sum', עמלה: 'sum' } }];
    const group = newStyle.transform.group;
    if (!group) throw new Error('expected he-commissions-report to declare a group');
    delete group.subtotal;
    group.summaryRows = [{ label: 'סה"כ לסוכן', labelColumn: 'פוליסה', cells: { פרמיה: 'sum', עמלה: 'sum' } }];

    const oldFormat = formatOf(oldStyle);
    const newFormat = formatOf(newStyle);
    expect(newFormat).toEqual(oldFormat);

    // The format lock (SPEC 8.12) sees them as the same format in both directions.
    expect(checkFormatLock(oldStyle, newFormat)).toEqual([]);
    expect(checkFormatLock(newStyle, oldFormat)).toEqual([]);
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
