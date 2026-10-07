// Engine audit (2026-10-07), fix 8: the verification paired rows by input row (`sourceRow`) and never compared their order, so rules with
// no sort passed against an example sorted descending. Now the order is compared where the example has one (`firstMisordered`): rows that
// look the same, and - when no sort explains the example's order - rows the rules' own sort keys tie, may come in any order.
import type { LearnResult, SortKey } from '@formatai/shared';
import { describe, expect, it } from 'vitest';
import { verifyAgainstExample } from '../../../src/learn/verify';
import { analyzeOk, xlsx, type V } from '../analyze/helpers';

const DEPTS = ['Sales', 'Ops', 'Legal'];
const N = 12;
const rows = Array.from({ length: N }, (_, i) => ({ ref: `R-${100 + i}`, dept: DEPTS[i % 3]!, amount: 50 + ((i * 37) % 400) }));
const input: V[][] = [['Ref', 'Dept', 'Amount'], ...rows.map((r) => [r.ref, r.dept, r.amount])];

function rulesSorted(sort: SortKey[]): LearnResult {
  return {
    schemaVersion: 1,
    input: { sheet: { pick: 'first' }, headerRow: 'auto', columns: [{ id: 'ref', header: 'Ref', type: 'text' }, { id: 'dept', header: 'Dept', type: 'text' }, { id: 'amount', header: 'Amount', type: 'integer' }] },
    transform: { computed: [], valueMaps: [], sort },
    output: { sheetName: 'Sheet1', direction: 'ltr', language: 'en', titleRows: [], columns: [{ header: 'Ref', from: 'ref' }, { header: 'Dept', from: 'dept' }, { header: 'Amount', from: 'amount' }] },
    validations: [],
    unsupported: [],
    assumptions: [],
  };
}

const codes = (r: LearnResult, a: ReturnType<typeof analyzeOk>): string[] => verifyAgainstExample(r, a).layoutIssues.map((i) => i.code);

describe('the row order is verified', () => {
  it('an example sorted by Amount, descending: rules with no sort are not verified; with the sort they are', () => {
    const sorted = [...rows].sort((x, y) => y.amount - x.amount);
    const a = analyzeOk(xlsx(input), xlsx([['Ref', 'Dept', 'Amount'], ...sorted.map((r) => [r.ref, r.dept, r.amount])]));
    expect(a.layout.sort).toEqual([{ out: 2, dir: 'desc' }]);
    const none = verifyAgainstExample(rulesSorted([]), a);
    expect(none.verified).toBe(false);
    expect(none.matched).toBe(N); // every row's cells match: only the order is wrong
    expect(none.layoutIssues.map((i) => i.code)).toEqual(['rowOrder']);
    expect(none.repairProblems.some((p) => p.kind === 'layout' && /order/.test(p.message))).toBe(true);
    expect(verifyAgainstExample(rulesSorted([{ column: 'amount', dir: 'desc' }]), a).verified).toBe(true);
  });

  it('a sort with ties in the input\'s order: the rules\' stable sort is verified, the wrong direction is not', () => {
    const sorted = [...rows].sort((x, y) => x.dept.localeCompare(y.dept)); // (stable: ties in the input's order)
    const a = analyzeOk(xlsx(input), xlsx([['Ref', 'Dept', 'Amount'], ...sorted.map((r) => [r.ref, r.dept, r.amount])]));
    expect(a.layout.sort).toEqual([{ out: 1, dir: 'asc' }]);
    expect(verifyAgainstExample(rulesSorted([{ column: 'dept', dir: 'asc' }]), a).verified).toBe(true);
    expect(codes(rulesSorted([{ column: 'dept', dir: 'desc' }]), a)).toEqual(['rowOrder']);
  });

  it('ties the example puts in no order code can see: the rules\' sort on that key is verified, no sort is not', () => {
    // Sorted by Dept, each Dept's rows in an order of no column (a tool's own tie order): no sort explains it.
    const sorted = [...rows].map((r, i) => ({ r, k: (i * 7) % 11 })).sort((x, y) => x.r.dept.localeCompare(y.r.dept) || x.k - y.k).map((x) => x.r);
    const a = analyzeOk(xlsx(input), xlsx([['Ref', 'Dept', 'Amount'], ...sorted.map((r) => [r.ref, r.dept, r.amount])]));
    expect(a.layout.sort).toBeNull();
    expect(a.layout.orderMatchesInput).toBe(false);
    expect(verifyAgainstExample(rulesSorted([{ column: 'dept', dir: 'asc' }]), a).verified).toBe(true);
    expect(codes(rulesSorted([]), a)).toEqual(['rowOrder']);
  });

  it('rows that look the same may come in any order; the input\'s order verifies as before', () => {
    const dup: V[][] = [['Name', 'Qty'], ['a', 1], ['b', 2], ['a', 1], ['c', 3], ['b', 2]];
    const a = analyzeOk(xlsx(dup), xlsx(dup));
    const r: LearnResult = { ...rulesSorted([]), input: { sheet: { pick: 'first' }, headerRow: 'auto', columns: [{ id: 'n', header: 'Name', type: 'text' }, { id: 'q', header: 'Qty', type: 'integer' }] }, output: { ...rulesSorted([]).output, columns: [{ header: 'Name', from: 'n' }, { header: 'Qty', from: 'q' }] } };
    expect(verifyAgainstExample(r, a).verified).toBe(true);
  });

  it('the local partial result (onlyColumns) does not build the order and is not judged on it', () => {
    const sorted = [...rows].sort((x, y) => y.amount - x.amount);
    const a = analyzeOk(xlsx(input), xlsx([['Ref', 'Dept', 'Amount'], ...sorted.map((r) => [r.ref, r.dept, r.amount])]));
    expect(verifyAgainstExample(rulesSorted([]), a, { onlyColumns: [0, 1, 2] }).verified).toBe(true);
  });
});
