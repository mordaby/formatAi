// A copy writes what the example shows (found by the engine stress test, eval/STRESS.md). The pair analysis takes a number and text that
// reads as the same number for one value (a csv export's "9455433" is the workbook's 9455433), but the rule writes its input column's
// DECLARED type: a column of long numbers (8+ digits) or of same-length digit text is declared `idLike`, which the engine writes as text,
// and a number column is written as numbers. Built as a plain copy, such a column never matched an example output that holds the other
// kind - the fast path returned rules that do not verify, and the local partial result listed the column as solved while every cell of it
// differed. The copy now converts to the kind the example's output holds.
import { checkRules } from '@formatai/shared';
import { describe, expect, it } from 'vitest';
import { typeCheck } from '../../src/check';
import { analyzePair } from '../../src/learn/analyze';
import { fastPath } from '../../src/learn/fastPath';
import { partialRules } from '../../src/learn/partial';
import { preflight } from '../../src/learn/preflight';
import { verifyAgainstExample } from '../../src/learn/verify';
import type { RawWorkbook } from '../../src/types';
import { delimited, xlsx, type V } from './analyze/helpers';

function learnLocal(input: RawWorkbook, output: RawWorkbook) {
  const a = analyzePair(input, output);
  if (!a.ok) throw new Error(`analysis failed: ${JSON.stringify(a.issues)}`);
  const pf = preflight(a, 'paid');
  const fp = fastPath(a, pf);
  if (!('rules' in fp)) throw new Error(`fastPath refused: ${JSON.stringify(fp)}`);
  expect(checkRules(fp.rules)).toEqual([]);
  expect(typeCheck(fp.rules)).toEqual([]);
  return { a, pf, rules: fp.rules };
}

const NAMES = ['Alpha', 'Bravo', 'Cedar', 'Delta', 'Ember', 'Falcon', 'Granite', 'Harbor'];

describe('fastPath: a copy writes the kind of value the example output holds', () => {
  it('9-digit order numbers (read as an ID) copied to an output of numbers: numbers, verified', () => {
    const rows: V[][] = NAMES.map((n, i) => [n, 663294308 + i * 1013]);
    const input = xlsx([['Name', 'Order No'], ...rows]);
    const output = xlsx([['Order No', 'Name'], ...rows.map(([n, id]) => [id!, n!])]);
    const { a, rules } = learnLocal(input, output);
    expect(a.input.profile[1]!.type).toBe('idLike');
    expect(verifyAgainstExample(rules, a).verified).toBe(true);
  });

  it('same-length digit text of a csv (read as an ID) copied to a workbook of numbers: numbers, verified', () => {
    const rows: V[][] = NAMES.map((n, i) => [n, String(9455433 + i * 77)]);
    const input = delimited([['Name', 'Customer No'], ...rows], 'csv');
    const output = xlsx([['Customer No', 'Name'], ...rows.map(([n, id]) => [Number(id), n!])]);
    const { a, rules } = learnLocal(input, output);
    expect(a.input.profile[1]!.type).toBe('idLike');
    expect(verifyAgainstExample(rules, a).verified).toBe(true);
  });

  it('a number column copied to an output of the same digits as text: text, verified', () => {
    const rows: V[][] = NAMES.map((n, i) => [n, 40 + i * 13]);
    const input = xlsx([['Name', 'Qty'], ...rows]);
    const output = xlsx([['Qty', 'Name'], ...rows.map(([n, q]) => [String(q), n!])]);
    const { a, rules } = learnLocal(input, output);
    expect(a.input.profile[1]!.type).toBe('integer');
    expect(verifyAgainstExample(rules, a).verified).toBe(true);
  });

  it('the local partial result builds the same converting copy (the column it lists as solved matches)', () => {
    const rows: V[][] = NAMES.map((n, i) => [n, 663294308 + i * 1013]);
    const input = xlsx([['Name', 'Order No'], ...rows]);
    // `Note` comes from nowhere: the partial result builds the rest and lists it as needing the AI step.
    const output = xlsx([['Order No', 'Name', 'Note'], ...rows.map(([n, id], i) => [id!, n!, `W${(i * 7919) % 97}x`])]);
    const a = analyzePair(input, output);
    if (!a.ok) throw new Error('analysis failed');
    const p = partialRules(a, preflight(a, 'paid'));
    if ('reason' in p) throw new Error(`partial refused: ${p.reason}`);
    expect(p.solvedColumns).toEqual([0, 1]);
    expect(verifyAgainstExample(p.rules, a, { onlyColumns: p.solvedColumns }).verified).toBe(true);
  });

  it('a copy whose input and output hold the same kind stays a plain copy (no conversion added)', () => {
    const rows: V[][] = NAMES.map((n, i) => [n, 663294308 + i * 1013]);
    const input = xlsx([['Name', 'Order No'], ...rows]);
    const output = xlsx([['Order No', 'Name'], ...rows.map(([n, id]) => [String(id), n!])]);
    const { a, rules } = learnLocal(input, output);
    expect(rules.transform.computed).toEqual([]);
    expect(verifyAgainstExample(rules, a).verified).toBe(true);
  });
});
