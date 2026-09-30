// verifyAgainstExample (SPEC 5 A step 6, 9.2 layer 8, 8.11): runs a candidate rules
// file on the full real input and diffs the result against the full real example
// output - data rows and layout (titles, header, summary rows, blank rows, file type).
import { describe, expect, it } from 'vitest';
import type { LearnResult } from '@formatai/shared';
import { analyzePair, type PairAnalysis } from '../../src/learn/analyze';
import { createMasker } from '../../src/learn/mask';
import { fastPath } from '../../src/learn/fastPath';
import { preflight } from '../../src/learn/preflight';
import { verifyAgainstExample } from '../../src/learn/verify';
import { delimited, xlsx, type V } from './analyze/helpers';

function analyzeOkResult(inHeaders: string[], inRows: V[][], outHeaders: string[], outRows: V[][]): PairAnalysis {
  const a = analyzePair(xlsx([inHeaders, ...inRows]), xlsx([outHeaders, ...outRows]));
  if (!a.ok) throw new Error(`analysis failed: ${JSON.stringify(a.issues)}`);
  return a;
}

/** A simple rename+reorder pair, verified via the fast path - used as the "correct
 * rules" baseline that several tests then deliberately break. */
function simplePair(): { a: PairAnalysis; rules: LearnResult } {
  const inHeaders = ['Customer ID', 'Customer Name'];
  const inRows: V[][] = [
    [1, 'Dana'],
    [2, 'Yossi'],
    [3, 'Noa'],
    [4, 'Omer'],
    [5, 'Maya'],
  ];
  const outHeaders = ['Name', 'ID'];
  const outRows: V[][] = inRows.map((r) => [r[1]!, r[0]!]);
  const a = analyzeOkResult(inHeaders, inRows, outHeaders, outRows);
  const pf = preflight(a, 'registered');
  const fp = fastPath(a, pf);
  if (!('rules' in fp)) throw new Error(`fastPath failed: ${JSON.stringify(fp)}`);
  return { a, rules: fp.rules };
}

describe('verifyAgainstExample: a correct rules file', () => {
  it('verifies, with matched === total and no mismatches/problems', () => {
    const { a, rules } = simplePair();
    const v = verifyAgainstExample(rules, a);
    expect(v.verified).toBe(true);
    expect(v.total).toBe(5);
    expect(v.matched).toBe(5);
    expect(v.mismatches).toEqual([]);
    expect(v.layoutProblems).toEqual([]);
    expect(v.repairProblems).toEqual([]);
  });
});

describe('verifyAgainstExample: a wrong constant', () => {
  it('reports one mismatch per bad cell, with the example row number and header', () => {
    const { a, rules } = simplePair();
    // Break the "ID" column into a constant, so every row mismatches on that column.
    const broken: LearnResult = {
      ...rules,
      output: {
        ...rules.output,
        columns: rules.output.columns.map((c) => (c.header === 'ID' ? { header: 'ID', from: null } : c)),
      },
    };
    const v = verifyAgainstExample(broken, a);
    expect(v.verified).toBe(false);
    expect(v.total).toBe(5);
    expect(v.matched).toBe(0);
    expect(v.mismatches).toHaveLength(5);
    for (const m of v.mismatches) {
      expect(m.column).toBe('ID');
      expect(typeof m.exampleRow).toBe('number');
    }
    // exampleRow is the 1-based Excel row of the output sheet: header is row 1, so
    // the first data row is row 2.
    expect(v.mismatches.map((m) => m.exampleRow).sort((x, y) => x - y)).toEqual([2, 3, 4, 5, 6]);
    // Capped at 10, but there are only 5 mismatches here, so all become diff problems.
    const diffs = v.repairProblems.filter((p) => p.kind === 'diff');
    expect(diffs).toHaveLength(5);
  });

  it('masks the failing row in repairProblems but never in the UI-facing mismatches', () => {
    const { a, rules } = simplePair();
    const broken: LearnResult = {
      ...rules,
      output: { ...rules.output, columns: rules.output.columns.map((c) => (c.header === 'Name' ? { header: 'Name', from: null } : c)) },
    };
    const masker = createMasker(new TextEncoder().encode('test-key'));
    const v = verifyAgainstExample(broken, a, { masker });
    expect(v.mismatches[0]!.expected).toBe('Dana'); // never masked
    const diff = v.repairProblems.find((p) => p.kind === 'diff') as Extract<(typeof v.repairProblems)[number], { kind: 'diff' }>;
    expect(diff.row).toBeDefined();
    // The masked row must not contain the real name anywhere.
    expect(JSON.stringify(diff.row)).not.toContain('Dana');
  });
});

describe('verifyAgainstExample: exceptions (SPEC 8.11 "fixed by hand")', () => {
  it('excludes an excepted row from the count and from mismatches', () => {
    const { a, rules } = simplePair();
    const broken: LearnResult = {
      ...rules,
      output: {
        ...rules.output,
        columns: rules.output.columns.map((c) => (c.header === 'ID' ? { header: 'ID', from: null } : c)),
      },
    };
    // Row 2 (first data row) marked as fixed by hand.
    const v = verifyAgainstExample(broken, a, { exceptions: [2] });
    expect(v.total).toBe(4);
    expect(v.mismatches.some((m) => m.exampleRow === 2)).toBe(false);
    expect(v.mismatches).toHaveLength(4);
  });

  it('excepting every mismatched row makes the rules verified again', () => {
    const { a, rules } = simplePair();
    const broken: LearnResult = {
      ...rules,
      output: { ...rules.output, columns: rules.output.columns.map((c) => (c.header === 'ID' ? { header: 'ID', from: null } : c)) },
    };
    const v = verifyAgainstExample(broken, a, { exceptions: [2, 3, 4, 5, 6] });
    expect(v.total).toBe(0);
    expect(v.matched).toBe(0);
    expect(v.mismatches).toEqual([]);
    // Nothing left to compare (every data row is excepted) and the layout is
    // untouched, so this now counts as verified - exactly SPEC 8.11's point.
    expect(v.verified).toBe(true);
  });
});

describe('verifyAgainstExample: dropped rows must stay dropped', () => {
  it('flags a row the rules keep although the example dropped it', () => {
    const inHeaders = ['ID', 'Status'];
    const inRows: V[][] = [
      [1, 'active'],
      [2, 'cancelled'],
      [3, 'active'],
      [4, 'active'],
      [5, 'cancelled'],
      [6, 'active'],
    ];
    const outHeaders = ['ID'];
    const outRows: V[][] = inRows.filter((r) => r[1] === 'active').map((r) => [r[0]!]);
    const a = analyzeOkResult(inHeaders, inRows, outHeaders, outRows);
    const pf = preflight(a, 'registered');
    const fp = fastPath(a, pf);
    if (!('rules' in fp)) throw new Error(`fastPath failed: ${JSON.stringify(fp)}`);
    // Drop the filter, so row 2 ("cancelled") is wrongly kept.
    const noFilter: LearnResult = { ...fp.rules, input: { ...fp.rules.input, rowFilters: [] } };
    const v = verifyAgainstExample(noFilter, a);
    expect(v.verified).toBe(false);
    expect(v.repairProblems.some((p) => p.kind === 'diff')).toBe(true);
    expect(v.repairProblems.some((p) => p.kind === 'rowCount')).toBe(true);
  });
});

describe('verifyAgainstExample: layout', () => {
  it('flags a wrong title and reports it as a layout problem', () => {
    const inHeaders = ['ID', 'Name'];
    const inRows: V[][] = [
      [1, 'Dana'],
      [2, 'Yossi'],
      [3, 'Noa'],
    ];
    const outHeaders = ['Name', 'ID'];
    const outRows: V[][] = inRows.map((r) => [r[1]!, r[0]!]);
    const a = analyzeOkResult(inHeaders, inRows, outHeaders, outRows);
    const pf = preflight(a, 'registered');
    const fp = fastPath(a, pf);
    if (!('rules' in fp)) throw new Error(`fastPath failed: ${JSON.stringify(fp)}`);
    const withWrongTitle: LearnResult = { ...fp.rules, output: { ...fp.rules.output, titleRows: [{ text: 'Wrong Title' }] } };
    const v = verifyAgainstExample(withWrongTitle, a);
    expect(v.verified).toBe(false);
    expect(v.layoutProblems.length).toBeGreaterThan(0);
    // Every layout problem has a code beside its message, in the same order (a UI reads the code, never the English).
    expect(v.layoutIssues.map((i) => i.message)).toEqual(v.layoutProblems);
    expect(v.layoutIssues.length).toBe(v.layoutProblems.length);
    expect(v.repairProblems.some((p) => p.kind === 'layout')).toBe(true);
    // Data rows are unaffected by the title mismatch.
    expect(v.matched).toBe(v.total);
  });

  it('flags a wrong output file type', () => {
    const inHeaders = ['ID', 'Name'];
    const inRows: V[][] = [
      [1, 'Dana'],
      [2, 'Yossi'],
      [3, 'Noa'],
    ];
    const outHeaders = ['Name', 'ID'];
    const outRows: V[][] = inRows.map((r) => [r[1]!, r[0]!]);
    const a = analyzeOkResult(inHeaders, inRows, outHeaders, outRows);
    const pf = preflight(a, 'registered');
    const fp = fastPath(a, pf);
    if (!('rules' in fp)) throw new Error(`fastPath failed: ${JSON.stringify(fp)}`);
    const withCsv: LearnResult = { ...fp.rules, output: { ...fp.rules.output, file: { type: 'csv' } } };
    const v = verifyAgainstExample(withCsv, a);
    expect(v.verified).toBe(false);
    expect(v.layoutProblems.some((m) => m.includes('file'))).toBe(true);
    expect(v.layoutIssues.map((i) => i.code)).toContain('fileSettings');
  });
});

describe('verifyAgainstExample: numeric values stored as text (csv/txt example outputs)', () => {
  it('a real "12" text cell matches the engine\'s number 12 for a declared numeric column', () => {
    // csv/txt cells are always strings (RawCell doc), so the example output's own
    // numeric column reads back as text even though the rules correctly declare it
    // numeric and the engine writes a real number.
    const inHeaders = ['ID', 'Amount'];
    const inRows: V[][] = [
      [101, 12],
      [102, 18],
      [103, 10],
      [104, 25],
    ];
    const outHeaders = ['Amount', 'ID'];
    const outRows = inRows.map((r) => [r[1]!, r[0]!]);
    const outputWb = delimited([outHeaders, ...outRows], 'csv');
    const a = analyzePair(xlsx([inHeaders, ...inRows]), outputWb);
    if (!a.ok) throw new Error(`analysis failed: ${JSON.stringify(a.issues)}`);
    const pf = preflight(a, 'registered');
    const fp = fastPath(a, pf);
    if (!('rules' in fp)) throw new Error(`fastPath failed: ${JSON.stringify(fp)}`);
    const v = verifyAgainstExample(fp.rules, a);
    expect(v.verified).toBe(true);
    expect(v.mismatches).toEqual([]);
  });

  it('still catches a genuine mismatch on a numeric-as-text column', () => {
    const inHeaders = ['ID', 'Amount'];
    const inRows: V[][] = [
      [101, 12],
      [102, 18],
      [103, 10],
      [104, 25],
    ];
    const outHeaders = ['ID', 'Amount'];
    const outputWb = delimited([outHeaders, [101, 12], [102, 999], [103, 10], [104, 25]], 'csv');
    const a = analyzePair(xlsx([inHeaders, ...inRows]), outputWb);
    if (!a.ok) throw new Error(`analysis failed: ${JSON.stringify(a.issues)}`);
    const pf = preflight(a, 'registered');
    const fp = fastPath(a, pf);
    // Not every input reaches the fast path here (coverage < 1 for Amount); build the
    // rules straight from the input instead, mirroring what fastPath would produce.
    const rules: LearnResult = 'rules' in fp
      ? fp.rules
      : {
          schemaVersion: 1,
          input: { sheet: { pick: 'first' }, headerRow: 'auto', columns: [{ id: 'id', header: 'ID', type: 'integer' }, { id: 'amount', header: 'Amount', type: 'integer' }] },
          transform: { computed: [], valueMaps: [], sort: [] },
          output: { sheetName: 'out', direction: 'ltr', language: 'en', titleRows: [], columns: [{ header: 'ID', from: 'id' }, { header: 'Amount', from: 'amount' }] },
          validations: [],
          unsupported: [],
          assumptions: [],
        };
    const v = verifyAgainstExample(rules, a);
    expect(v.verified).toBe(false);
    expect(v.mismatches).toHaveLength(1);
    expect(v.mismatches[0]).toMatchObject({ column: 'Amount' });
  });
});

describe('verifyAgainstExample: a headerless example output (SPEC 8.13)', () => {
  it('does not flag the engine\'s own internal header row as an extra layout row', () => {
    const inHeaders = ['ID', 'Name'];
    const inRows: V[][] = [
      [101, 'Dana'],
      [102, 'Yossi'],
      [103, 'Noa'],
      [104, 'Omer'],
    ];
    // No header line at all: the first row is already data.
    const outputWb = delimited(inRows, 'txt');
    const a = analyzePair(xlsx([inHeaders, ...inRows]), outputWb);
    if (!a.ok) throw new Error(`analysis failed: ${JSON.stringify(a.issues)}`);
    expect(a.output.headerless).toBe(true);
    const pf = preflight(a, 'registered');
    const fp = fastPath(a, pf);
    if (!('rules' in fp)) throw new Error(`fastPath failed: ${JSON.stringify(fp)}`);
    const v = verifyAgainstExample(fp.rules, a);
    expect(v.layoutProblems).toEqual([]);
    expect(v.verified).toBe(true);
  });
});

describe('verifyAgainstExample: rules that fail to run at all', () => {
  it('reports a reference problem when a required input column is missing from the rules', () => {
    const { a, rules } = simplePair();
    const broken: LearnResult = {
      ...rules,
      input: { ...rules.input, columns: rules.input.columns.map((c) => ({ ...c, header: 'Nonexistent Header' })) },
    };
    const v = verifyAgainstExample(broken, a);
    expect(v.verified).toBe(false);
    expect(v.total).toBe(0);
    expect(v.repairProblems.some((p) => p.kind === 'reference')).toBe(true);
  });
});
