// Engine audit (2026-10-07), fix 7: when the AI step reported a column as unsupported, `verifyAnswer` (flow.ts) verified with `onlyColumns`,
// which also turned off the row count and the title / header / blank / summary rows checks: rules missing the title, the blank and the
// "Total" rows were `verified`. Now the unsupported columns' cells are skipped (`skipColumns`) and every row-count and layout check is kept.
import type { LearnResult } from '@formatai/shared';
import { describe, expect, it } from 'vitest';
import { learnFromExamples, type LearnCallResult } from '../../../src/learn/flow';
import { verifyAgainstExample } from '../../../src/learn/verify';
import { analyzeOk, xlsx, type V } from '../analyze/helpers';
import { xlsxBytesOf } from '../v5fixtures';

const N = 12;
const refs = Array.from({ length: N }, (_, i) => `R-${1000 + i * 7}`);
const qty = Array.from({ length: N }, (_, i) => 1 + ((i * 3) % 9));
const price = Array.from({ length: N }, (_, i) => 5 + ((i * 13) % 40));
const totals = qty.map((q, i) => q * price[i]!);
const input: V[][] = [['Ref', 'Qty', 'Price'], ...refs.map((r, i) => [r, qty[i]!, price[i]!])];
const dataRows: V[][] = refs.map((r, i) => [r, totals[i]!, `W${100 + ((i * 37) % 800)}`]);
const output: V[][] = [['Monthly report'], [], ['Ref', 'Total', 'Warehouse'], ...dataRows, ['Total', totals.reduce((a, b) => a + b, 0), null]];

/** The answer: Ref and Total right, Warehouse honestly unsupported - and no title, blank or "Total" row. */
const ANSWER: LearnResult = {
  schemaVersion: 1,
  input: { sheet: { pick: 'first' }, headerRow: 'auto', columns: [{ id: 'ref', header: 'Ref', type: 'text' }, { id: 'qty', header: 'Qty', type: 'integer' }, { id: 'price', header: 'Price', type: 'integer' }] },
  transform: { computed: [{ id: 'total', type: 'integer', expr: { op: 'mul', args: [{ col: 'qty' }, { col: 'price' }] } }], valueMaps: [], sort: [] },
  output: { sheetName: 'Sheet1', direction: 'ltr', language: 'en', titleRows: [], columns: [{ header: 'Ref', from: 'ref' }, { header: 'Total', from: 'total' }, { header: 'Warehouse', from: null }] },
  validations: [],
  unsupported: [{ outputColumn: 'Warehouse', reasonCode: 'externalData' }],
  assumptions: [],
};

describe('skipColumns: the cells of the columns with no rule, nothing else', () => {
  const a = analyzeOk(xlsx(input), xlsx(output));

  it('the setup: a title row, a blank row and a "Total" row', () => {
    expect(a.layout.titleRows.length).toBeGreaterThan(0);
    expect(a.layout.summaryRows.length).toBe(1);
  });

  it('onlyColumns (the partial result) skips the layout; skipColumns keeps it', () => {
    expect(verifyAgainstExample(ANSWER, a, { onlyColumns: [0, 1] }).verified).toBe(true);
    const v = verifyAgainstExample(ANSWER, a, { skipColumns: [2] });
    expect(v.verified).toBe(false);
    expect(v.matched).toBe(N);
    expect(v.mismatches).toEqual([]);
    expect(v.layoutIssues.map((i) => i.code)).toEqual(expect.arrayContaining(['titleRow', 'summaryRow']));
  });

  it('with the layout built, skipping the unsupported column verifies (its summary cell is skipped too)', () => {
    const full: LearnResult = { ...ANSWER, output: { ...ANSWER.output, titleRows: [{ text: 'Monthly report' }, { blank: true }], summaryRows: [{ label: 'Total', labelColumn: 'Ref', cells: { Total: 'sum' } }] } };
    expect(verifyAgainstExample(full, a, { skipColumns: [2] }).verified).toBe(true);
  });

  it('every column skipped compares nothing: not verified', () => {
    expect(verifyAgainstExample(ANSWER, a, { skipColumns: [0, 1, 2] }).verified).toBe(false);
  });
});

describe('the learn: an answer with an unsupported column is checked on the whole layout', () => {
  it('rules missing the title, blank and "Total" rows are not verified (they were)', async () => {
    const files = { input: { bytes: await xlsxBytesOf(input), name: 'in.xlsx' }, output: { bytes: await xlsxBytesOf(output), name: 'out.xlsx' } };
    const r = await learnFromExamples({ ...files, masking: false, tier: 'paid', callLearn: async (): Promise<LearnCallResult> => ({ rules: ANSWER, problems: [], calls: [] }) });
    expect(r.path).toBe('llm');
    expect(r.stages.verifiedFirstCall).toBe(false);
    expect(r.verification?.verified).toBe(false);
    expect(r.verification?.layoutIssues.map((i) => i.code)).toEqual(expect.arrayContaining(['titleRow', 'summaryRow']));
  });
});
