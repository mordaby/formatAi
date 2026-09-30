// preflight: every SPEC 6.3 block reason and 6.4 warn reason, plus the plain
// "ok" case. Built on real analyzePair results (the same fixtures style as
// test/learn/analyze/*), never hand-rolled PairAnalysis objects.
import { describe, expect, it } from 'vitest';
import { analyzePair } from '../../src/learn/analyze';
import { preflight } from '../../src/learn/preflight';
import { analyzeOk, rng, xlsx, type V } from './analyze/helpers';

describe('preflight: SPEC 6.3 blocks', () => {
  it('tableRejected: a 6.1 rejection on either file blocks, with no further analysis', () => {
    const empty = xlsx([]);
    const output = xlsx([
      ['A', 'B'],
      [1, 2],
      [3, 4],
    ]);
    const result = analyzePair(empty, output);
    expect(result.ok).toBe(false);
    const pf = preflight(result, 'registered');
    expect(pf.status).toBe('block');
    expect(pf.skipColumns).toEqual([]);
    expect(pf.issues).toContainEqual(expect.objectContaining({ code: 'tableRejected', severity: 'block' }));
    expect(pf.issues[0]!.params).toMatchObject({ side: 'input' });
  });

  it('rowExpansionUnsupported: families with no recognizable pattern', () => {
    const input: V[][] = [['Ref', 'Note']];
    const output: V[][] = [['Ref', 'Extra']];
    const r = rng(9);
    for (let i = 0; i < 12; i++) {
      input.push([`X${i}`, `note ${i}`]);
      const n = 1 + (i % 3);
      for (let j = 0; j < n; j++) output.push([`X${i}`, `extra ${Math.floor(r() * 1000)}`]);
    }
    const a = analyzeOk(xlsx(input), xlsx(output));
    expect(a.shape.kind).toBe('rowExpansion');
    const pf = preflight(a, 'registered');
    expect(pf.status).toBe('block');
    expect(pf.issues).toContainEqual({ code: 'rowExpansionUnsupported', severity: 'block' });
  });

  it('pivotDetected: output headers are values of one input column', () => {
    const input: V[][] = [['Rep', 'Region', 'Amount']];
    const output: V[][] = [['Rep', 'North', 'South', 'East', 'West']];
    const regions = ['North', 'South', 'East', 'West'];
    for (let i = 0; i < 5; i++) {
      const row: V[] = [`rep ${i}`];
      regions.forEach((reg, j) => {
        input.push([`rep ${i}`, reg, 10 * i + j]);
        row.push(10 * i + j);
      });
      output.push(row);
    }
    const a = analyzeOk(xlsx(input), xlsx(output));
    expect(a.shape.kind).toBe('pivot');
    const pf = preflight(a, 'registered');
    expect(pf.status).toBe('block');
    expect(pf.issues).toContainEqual({ code: 'pivotDetected', severity: 'block' });
  });

  it('noColumnTraced: no output column can be traced to the input at all', () => {
    const input: V[][] = [['A', 'B']];
    for (let i = 0; i < 5; i++) input.push([i, `x${i}`]);
    const output: V[][] = [['C', 'D', 'E']];
    for (let i = 0; i < 9; i++) output.push([`unrelated-${i}`, `nothing-${i}`, `else-${i}`]);
    const a = analyzeOk(xlsx(input), xlsx(output));
    expect(a.alignment.method).toBe('none');
    expect(a.columns.every((c) => c.unknown)).toBe(true);
    const pf = preflight(a, 'registered');
    expect(pf.status).toBe('block');
    expect(pf.issues).toContainEqual({ code: 'noColumnTraced', severity: 'block' });
  });

  it('identicalFiles: the two sheets hold exactly the same cells', () => {
    const rows: V[][] = [['A', 'B']];
    for (let i = 0; i < 5; i++) rows.push([i, `x${i}`]);
    const a = analyzeOk(xlsx(rows), xlsx(rows));
    expect(a.identical).toBe(true);
    const pf = preflight(a, 'registered');
    expect(pf.status).toBe('block');
    expect(pf.issues).toContainEqual({ code: 'identicalFiles', severity: 'block' });
  });

  it('overTierLimits: more rows than the tier allows', () => {
    const input: V[][] = [['A', 'B']];
    const output: V[][] = [['B', 'A']];
    for (let i = 0; i < 301; i++) {
      input.push([i, i * 2]);
      output.push([i * 2, i]);
    }
    const a = analyzeOk(xlsx(input), xlsx(output));
    // anonymous: maxRowsPerFile 300.
    const pf = preflight(a, 'anonymous');
    expect(pf.status).toBe('block');
    expect(pf.issues).toContainEqual(
      expect.objectContaining({ code: 'overTierLimits', severity: 'block', params: expect.objectContaining({ dimension: 'rows' }) }),
    );
    // The same data is fine on a tier with room.
    const pfPaid = preflight(a, 'paid');
    expect(pfPaid.issues.some((i) => i.code === 'overTierLimits')).toBe(false);
  });
});

describe('preflight: SPEC 6.4 warns', () => {
  it('unknownOutputColumns: some (not all) output columns are unknown -> skipColumns', () => {
    const input: V[][] = [['Id', 'Amount']];
    const output: V[][] = [['Id', 'Amount', 'Extra']];
    for (let i = 0; i < 10; i++) {
      input.push([i, 10 + i]);
      output.push([i, 10 + i, `mystery-${i * 3}`]);
    }
    const a = analyzeOk(xlsx(input), xlsx(output));
    const pf = preflight(a, 'registered');
    expect(pf.status).toBe('warn');
    expect(pf.skipColumns).toEqual([2]);
    expect(pf.issues).toContainEqual({ code: 'unknownOutputColumns', severity: 'warn', params: { count: 1 } });
  });

  it('rowsNotAligned: some output rows could not be matched to an input row', () => {
    const input: V[][] = [['Id', 'Amount']];
    const output: V[][] = [['Id', 'Amount']];
    for (let i = 0; i < 9; i++) {
      input.push([i, 10 + i]);
      output.push([i, 10 + i]);
    }
    // A tenth output row whose key never appears in the input at all.
    output.push([999, 999]);
    const a = analyzeOk(xlsx(input), xlsx(output));
    expect(a.alignment.unalignedOut.length).toBeGreaterThan(0);
    expect(a.columns.every((c) => !c.unknown)).toBe(true);
    const pf = preflight(a, 'registered');
    expect(pf.status).toBe('warn');
    expect(pf.issues).toContainEqual({ code: 'rowsNotAligned', severity: 'warn', params: { count: 1 } });
  });
});

describe('preflight: ok', () => {
  it('a clean rename/reorder pair has no issues at all', () => {
    const input: V[][] = [['Id', 'Amount']];
    const output: V[][] = [['Amount', 'Id']];
    for (let i = 0; i < 10; i++) {
      input.push([i, 10 + i]);
      output.push([10 + i, i]);
    }
    const a = analyzeOk(xlsx(input), xlsx(output));
    const pf = preflight(a, 'registered');
    expect(pf).toEqual({ status: 'ok', issues: [], skipColumns: [] });
  });
});
