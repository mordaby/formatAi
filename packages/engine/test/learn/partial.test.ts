// partialRules (SPEC 21 v5 item 1): the local partial result - rules for every column code explained,
// `from: null` for the rest (needs the AI step, or external data), verified on the solved columns only.
// Synthetic pairs (test/learn/v5fixtures.ts) and the eval cases that need the LLM.
import fs from 'node:fs';
import path from 'node:path';
import { checkRules } from '@formatai/shared';
import { describe, expect, it } from 'vitest';
import { typeCheck } from '../../src/check';
import { readWorkbook } from '../../src/io/read';
import { sniffDelimitedText } from '../../src/io/detectFileSpec';
import { analyzePair, type PairAnalysis } from '../../src/learn/analyze';
import { fastPath } from '../../src/learn/fastPath';
import { partialRules, type PartialRulesResult } from '../../src/learn/partial';
import { preflight, type PreflightResult } from '../../src/learn/preflight';
import { verifyAgainstExample } from '../../src/learn/verify';
import { runRules } from '../../src/pipeline';
import type { InputTable } from '../../src/types';
import { analyzeOk, xlsx, type V } from './analyze/helpers';
import { analyzeWithPreflight, columnsToRowsPair, externalOnlyPair, mixedPair, simplePair, sortedPair, splitCellPair, summaryPair, unrelatedPair } from './v5fixtures';

function partialOf(a: PairAnalysis, pf: PreflightResult): PartialRulesResult {
  const p = partialRules(a, pf);
  if ('reason' in p) throw new Error(`partialRules failed: ${p.reason}`);
  return p;
}

function tableOf(a: PairAnalysis): InputTable {
  return { sheetName: a.input.sheetName, direction: a.input.direction, headers: a.input.headers, rows: a.input.rows, rowNumbers: a.input.rowNumbers };
}

function verifyPartial(a: PairAnalysis, p: PartialRulesResult) {
  return verifyAgainstExample(p.rules, a, { onlyColumns: p.solvedColumns });
}

describe('partialRules: a plain pair with a column that needs the AI step and an external column', () => {
  const { a, pf } = analyzeWithPreflight(mixedPair());
  const p = partialOf(a, pf);

  it('builds the explained columns and lists the others by kind', () => {
    expect(p.solved).toEqual(['Item', 'Ref', 'Total']);
    expect(p.solvedColumns).toEqual([0, 1, 2]);
    expect(p.needsAi).toEqual(['Label']);
    expect(p.external).toEqual(['Warehouse']);
    expect(p.needsAiParts).toEqual([]);
    expect(p.rules.output.columns.map((c) => [c.header, c.from === null])).toEqual([
      ['Item', false],
      ['Ref', false],
      ['Total', false],
      ['Label', true],
      ['Warehouse', true],
    ]);
  });

  it('marks external columns as unsupported (externalData); the column that needs the AI step is not', () => {
    expect(p.rules.unsupported).toEqual([{ outputColumn: 'Warehouse', reasonCode: 'externalData' }]);
  });

  it('gives rules that check, type-check and run: solved columns reproduce the example, the others stay empty', () => {
    expect(checkRules(p.rules)).toEqual([]);
    expect(typeCheck(p.rules)).toEqual([]);
    const res = runRules(p.rules, tableOf(a));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const data = res.sheet.rows.filter((r) => r.kind === 'data');
    expect(data).toHaveLength(20);
    const example = a.output.dataRows.map((r) => a.output.sheet.rows[r]!);
    data.forEach((row, i) => {
      expect(row.cells.slice(0, 3).map((c) => c.v)).toEqual(example[i]!.slice(0, 3).map((c) => c?.v ?? null));
      expect(row.cells.slice(3).map((c) => c.v ?? null)).toEqual([null, null]);
    });
  });

  it('is verified on the solved columns only: all 20 rows match; the whole example does not', () => {
    const v = verifyPartial(a, p);
    expect(v).toMatchObject({ verified: true, matched: 20, total: 20, mismatches: [] });
    const whole = verifyAgainstExample(p.rules, a);
    expect(whole.verified).toBe(false);
    expect(whole.mismatches.some((m) => m.column === 'Label')).toBe(true);
    expect(whole.mismatches.some((m) => m.column === 'Warehouse')).toBe(true);
  });

  it('onlyColumns counts just the columns asked for: Label matches on 19 of 20 rows', () => {
    const v = verifyAgainstExample(p.rules, a, { onlyColumns: [3] });
    // The partial rules leave Label empty, so it mismatches everywhere it has a value.
    expect(v.verified).toBe(false);
    expect(v.total).toBe(20);
    expect(v.mismatches.every((m) => m.column === 'Label')).toBe(true);
    expect(v.mismatches).toHaveLength(20);
  });

  it('an empty onlyColumns list checks nothing: not verified, 0 of 0', () => {
    expect(verifyAgainstExample(p.rules, a, { onlyColumns: [] })).toMatchObject({ verified: false, matched: 0, total: 0, mismatches: [] });
  });

  it('is deterministic and does not modify the analysis', () => {
    expect(partialOf(a, pf)).toEqual(p);
  });
});

describe('partialRules: only an external column is left', () => {
  const { a, pf } = analyzeWithPreflight(externalOnlyPair());
  const p = partialOf(a, pf);

  it('has nothing for the AI step: no columns, no parts', () => {
    expect(p.solved).toEqual(['Item', 'Ref', 'Total']);
    expect(p.needsAi).toEqual([]);
    expect(p.external).toEqual(['Warehouse']);
    expect(p.needsAiParts).toEqual([]);
    expect(verifyPartial(a, p)).toMatchObject({ verified: true, matched: 20, total: 20 });
  });
});

describe('partialRules: when the strict fast path succeeds', () => {
  it('builds exactly the same rules', () => {
    const { a, pf } = analyzeWithPreflight(simplePair());
    const fp = fastPath(a, pf);
    if (!('rules' in fp)) throw new Error('fast path failed');
    const p = partialOf(a, pf);
    expect(p.rules).toEqual(fp.rules);
    expect(p.needsAi).toEqual([]);
    expect(p.external).toEqual([]);
    expect(p.needsAiParts).toEqual([]);
  });
});

describe('partialRules: rows that expand', () => {
  it('columns to rows: builds the expand from the pattern, and the created columns are solved', () => {
    const { a, pf } = analyzeWithPreflight(columnsToRowsPair());
    const p = partialOf(a, pf);
    expect(p.solved).toEqual(['Dept', 'Month', 'Amount']);
    expect(p.needsAiParts).toEqual([]);
    expect(p.rules.transform.expand).toMatchObject({ mode: 'columnsToRows', skipEmpty: true });
    expect(checkRules(p.rules)).toEqual([]);
    expect(typeCheck(p.rules)).toEqual([]);
    expect(verifyPartial(a, p)).toMatchObject({ verified: true, matched: 18, total: 18 });
  });

  it('columns to rows with a sort in the example: the sort is left for the AI step', () => {
    const { a, pf } = analyzeWithPreflight(columnsToRowsPair({ sorted: true }));
    const p = partialOf(a, pf);
    expect(p.solved).toEqual(['Dept', 'Month', 'Amount']);
    expect(p.needsAiParts).toEqual(['sort']);
    expect(p.rules.transform.sort).toEqual([]);
    expect(verifyPartial(a, p)).toMatchObject({ verified: true, matched: 18, total: 18 });
  });

  it('split cell: builds the expand and the part column', () => {
    const { a, pf } = analyzeWithPreflight(splitCellPair());
    const p = partialOf(a, pf);
    expect(p.solved).toEqual(['Ref', 'Tag']);
    expect(p.rules.transform.expand).toMatchObject({ mode: 'splitCell', separator: ';', trim: true });
    expect(checkRules(p.rules)).toEqual([]);
    expect(verifyPartial(a, p)).toMatchObject({ verified: true, matched: 11, total: 11 });
  });

  it('a summary is not built: every column needs the AI step, nothing is solved, and nothing is verified', () => {
    const { a, pf } = analyzeWithPreflight(summaryPair());
    const p = partialOf(a, pf);
    expect(p.solved).toEqual([]);
    expect(p.solvedColumns).toEqual([]);
    expect(p.needsAi).toEqual(['Group', 'Total']);
    expect(p.needsAiParts).toContain('rows');
    // still valid, runnable rules (the schema needs one input column)
    expect(checkRules(p.rules)).toEqual([]);
    expect(runRules(p.rules, tableOf(a)).ok).toBe(true);
    expect(verifyPartial(a, p)).toMatchObject({ verified: false, matched: 0, total: 0 });
  });
});

describe('partialRules: layout the code does not build', () => {
  it('leaves a detected sort to the AI step and lists it', () => {
    const { a, pf } = analyzeWithPreflight(sortedPair());
    const p = partialOf(a, pf);
    expect(p.needsAiParts).toEqual(['sort']);
    expect(p.solved).toEqual(['Item', 'Ref']);
    expect(p.rules.transform.sort).toEqual([]);
  });
});

describe('partialRules: a column the strict path would refuse does not spoil the others', () => {
  it('two paddings of one column to different lengths: the first is built, the second needs the AI step', () => {
    const input: V[][] = [['Code', 'Name']];
    const output: V[][] = [['Long', 'Longer', 'Name']];
    for (let i = 0; i < 15; i++) {
      const code = 3 + i * 7;
      input.push([code, `N${i}`]);
      output.push([String(code).padStart(6, '0'), String(code).padStart(8, '0'), `N${i}`]);
    }
    const a = analyzeOk(xlsx(input), xlsx(output));
    const pf = preflight(a, 'paid');
    expect(fastPath(a, pf)).toMatchObject({ reason: 'columnNotFullyExplained' });
    const p = partialOf(a, pf);
    expect(p.solved).toEqual(['Long', 'Name']);
    expect(p.needsAi).toEqual(['Longer']);
    expect(p.rules.input.columns.find((c) => c.id === 'code')?.padLeft).toBe(6);
    expect(checkRules(p.rules)).toEqual([]);
    expect(verifyPartial(a, p)).toMatchObject({ verified: true, matched: 15, total: 15 });
  });
});

describe('partialRules: refuses what pre-flight blocks', () => {
  it('returns { reason: blocked }', () => {
    const a = analyzeOk(xlsx(unrelatedPair().input), xlsx(unrelatedPair().output));
    const pf = preflight(a, 'paid');
    expect(pf.status).toBe('block');
    expect(partialRules(a, pf)).toEqual({ reason: 'blocked' });
  });
});

// ---------------------------------------------------------------------------
// The eval cases that need the LLM (eval/cases): the same checks on realistic files.
// ---------------------------------------------------------------------------

const casesDir = path.resolve(__dirname, '../../../../eval/cases');

async function loadCase(name: string): Promise<{ a: PairAnalysis; pf: PreflightResult }> {
  const dir = path.join(casesDir, name);
  const find = (base: string): string => fs.readdirSync(dir).find((e) => e.startsWith(`${base}.`))!;
  const inName = find('input');
  const outName = find('output');
  const inBytes = new Uint8Array(fs.readFileSync(path.join(dir, inName)));
  const outBytes = new Uint8Array(fs.readFileSync(path.join(dir, outName)));
  const inWb = await readWorkbook(inBytes, inName);
  const outWb = await readWorkbook(outBytes, outName);
  const sniff = outWb.fileType === 'csv' || outWb.fileType === 'txt' ? sniffDelimitedText(outBytes) : undefined;
  const a = analyzePair(inWb, outWb, sniff ? { outputSniff: sniff } : {});
  if (!a.ok) throw new Error(`analysis failed for ${name}`);
  return { a, pf: preflight(a, 'paid') };
}

describe('partialRules on the eval cases that need the AI step', () => {
  it('budget-columns-to-rows: every column is solved through the expand; the sort is left', async () => {
    const { a, pf } = await loadCase('budget-columns-to-rows');
    expect(fastPath(a, pf)).toMatchObject({ reason: 'rowsExpand' });
    const p = partialOf(a, pf);
    expect(p.solved).toEqual(['Department', 'Category', 'Month', 'Amount']);
    expect(p.needsAi).toEqual([]);
    expect(p.needsAiParts).toEqual(['sort']);
    expect(checkRules(p.rules)).toEqual([]);
    expect(verifyPartial(a, p)).toMatchObject({ verified: true, matched: 46, total: 46 });
  });

  it('expense-split-cell: the calculation on the split count is solved too', async () => {
    const { a, pf } = await loadCase('expense-split-cell');
    const p = partialOf(a, pf);
    expect(p.solved).toHaveLength(4);
    expect(p.rules.transform.expand).toMatchObject({ mode: 'splitCell' });
    expect(p.rules.transform.expand).toHaveProperty('countId');
    expect(verifyPartial(a, p)).toMatchObject({ verified: true, matched: 46, total: 46 });
  });

  it('purchase-orders-supplier-summary: a summary output - nothing solved, all five columns need the AI step', async () => {
    const { a, pf } = await loadCase('purchase-orders-supplier-summary');
    const p = partialOf(a, pf);
    expect(p.solved).toEqual([]);
    expect(p.needsAi).toEqual(['Supplier', 'Orders', 'Total Qty', 'Total Amount', 'Avg Order Value']);
    expect(p.needsAiParts).toEqual(['rows', 'sort', 'group', 'summaryRows']);
    expect(verifyPartial(a, p)).toMatchObject({ verified: false, total: 0 });
  });

  it('insurer-commission-control: all eight columns, the dedupe and the filter are built and verified; groups, totals, sort and the dated title are not', async () => {
    const { a, pf } = await loadCase('insurer-commission-control');
    const p = partialOf(a, pf);
    expect(p.solved).toHaveLength(8);
    expect(p.needsAi).toEqual([]);
    expect(p.needsAiParts).toEqual(['sort', 'group', 'summaryRows', 'dateTitle']);
    expect(p.rules.transform.dedupe).toBeDefined();
    expect(p.rules.input.rowFilters?.length).toBeGreaterThan(0);
    // A title with a date from the data is not written as a constant; constant ones stay.
    expect(p.rules.output.titleRows.every((t) => 'blank' in t || ('text' in t && t.text !== ''))).toBe(true);
    expect(checkRules(p.rules)).toEqual([]);
    expect(verifyPartial(a, p)).toMatchObject({ verified: true, matched: 29, total: 29 });
  });

  it('fulfillment-external-column: one external column, nothing left for the AI step', async () => {
    const { a, pf } = await loadCase('fulfillment-external-column');
    const p = partialOf(a, pf);
    expect(p.external).toEqual(['Assigned Warehouse']);
    expect(p.needsAi).toEqual([]);
    expect(p.needsAiParts).toEqual([]);
    expect(p.solved).toEqual(['PO No', 'Supplier', 'Item', 'Qty', 'Requested Date']);
    expect(p.rules.unsupported).toEqual([{ outputColumn: 'Assigned Warehouse', reasonCode: 'externalData' }]);
    expect(verifyPartial(a, p)).toMatchObject({ verified: true, matched: 20, total: 20 });
  });

  it('registry-supplier-a: a padded id column and a sort left for the AI step', async () => {
    const { a, pf } = await loadCase('registry-supplier-a');
    const p = partialOf(a, pf);
    expect(p.solved).toEqual(['Item Code', 'Description', 'Unit Price', 'Category']);
    expect(p.needsAiParts).toEqual(['sort']);
    expect(verifyPartial(a, p)).toMatchObject({ verified: true, matched: 18, total: 18 });
  });

  it('sales-pivot-blocked: blocked, so nothing is built', async () => {
    const { a, pf } = await loadCase('sales-pivot-blocked');
    expect(partialRules(a, pf)).toEqual({ reason: 'blocked' });
  });
});
