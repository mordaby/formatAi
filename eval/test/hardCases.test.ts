// The three hard cases for the learning-loop measurement (eval/cases/buildHard.ts): the data really has the shape the case is meant to have.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readWorkbook } from '@formatai/engine';
import { loadCase, type CaseDef, type CaseFile } from '../lib/caseLoader.js';

const CASES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'cases');

async function table(file: CaseFile): Promise<(string | number | boolean | null)[][]> {
  const wb = await readWorkbook(file.bytes, file.fileName);
  return wb.sheets[0]!.rows.slice(1).map((r) => r.map((c) => c?.v ?? null));
}

const load = (name: string): CaseDef => loadCase(path.join(CASES_DIR, name))!;

describe('orders-priority', () => {
  const c = load('orders-priority');

  it('is a hard case with a next-month pair and Priority from Status and Amount', async () => {
    expect(c.meta).toMatchObject({ difficulty: 'hard', expect: 'verified' });
    expect(c.next).toBeDefined();
    const input = await table(c.input);
    const output = await table(c.output);
    expect(input).toHaveLength(240);
    expect(output).toHaveLength(240);
    input.forEach((row, i) => {
      const [status, amount] = [row[4], row[3] as number];
      const expected = status === 'On hold' ? 'Blocked' : status === 'Open' ? (amount >= 5000 ? 'Urgent' : 'Normal') : 'Done';
      expect(output[i]![3], `row ${i}`).toBe(expected);
    });
  });

  it('has only 5 Urgent rows, away from the first rows, the empty-Customer rows and the min/max Amount rows; the largest Amount is not Urgent', async () => {
    const input = await table(c.input);
    const output = await table(c.output);
    const urgent = output.flatMap((r, i) => (r[3] === 'Urgent' ? [i] : []));
    const empty = input.flatMap((r, i) => (r[1] === '' || r[1] === null ? [i] : []));
    const amounts = input.map((r) => r[3] as number);
    const extremes = [amounts.indexOf(Math.min(...amounts)), amounts.indexOf(Math.max(...amounts))];
    expect(urgent).toHaveLength(5);
    expect(empty).toHaveLength(2);
    for (const i of urgent) {
      expect(i).toBeGreaterThan(30);
      expect(empty).not.toContain(i);
      expect(extremes).not.toContain(i);
    }
    expect(output[extremes[1]!]![3]).toBe('Done');
    expect(Math.min(...urgent.map((i) => input[i]![3] as number))).toBe(5000); // the boundary is in the example
    // an Open order below the threshold never gets near it
    expect(Math.max(...input.filter((r) => r[4] === 'Open' && (r[3] as number) < 5000).map((r) => r[3] as number))).toBeLessThanOrEqual(4800);
  });

  it('next month: 200 fresh rows, Urgent between 5000 and 6500, Normal up to 4800', async () => {
    const input = await table(c.next!.input);
    const output = await table(c.next!.output);
    expect(input).toHaveLength(200);
    const urgent = input.filter((_, i) => output[i]![3] === 'Urgent').map((r) => r[3] as number);
    const normal = input.filter((_, i) => output[i]![3] === 'Normal').map((r) => r[3] as number);
    expect(urgent.length).toBeGreaterThan(0);
    expect(Math.min(...urgent)).toBeGreaterThanOrEqual(5000);
    expect(Math.max(...urgent)).toBeLessThanOrEqual(6500);
    expect(Math.max(...normal)).toBeLessThanOrEqual(4800);
  });
});

describe('branch-lookup-50', () => {
  const c = load('branch-lookup-50');
  const countCodes = (rows: (string | number | boolean | null)[][]): number[] => {
    const counts = new Map<string, number>();
    for (const r of rows) counts.set(String(r[1]), (counts.get(String(r[1])) ?? 0) + 1);
    return [...counts.values()].sort((a, b) => a - b);
  };

  it('400 rows with 50 codes, every code at least twice, several only 2-3 times; the name is added after the code, "Online" for online sales', async () => {
    const input = await table(c.input);
    const output = await table(c.output);
    expect(input).toHaveLength(400);
    const counts = countCodes(input);
    expect(counts).toHaveLength(50);
    expect(counts[0]).toBeGreaterThanOrEqual(2);
    expect(counts.filter((n) => n <= 3).length).toBeGreaterThanOrEqual(5);
    // input: Sale ID, Branch Code, Channel, ...; output: Sale ID, Branch Code, Branch Name, ...
    const online = input.filter((r) => r[2] === 'Online').length;
    expect(online).toBeGreaterThan(20);
    expect(online).toBeLessThan(100);
    // in-store sales: one name per code, 50 distinct names, none of them readable from the code
    const store = output.filter((_, i) => input[i]![2] === 'Store');
    const names = new Map(store.map((r) => [String(r[1]), String(r[2])]));
    expect(names.size).toBe(50);
    expect(new Set(names.values()).size).toBe(50);
    expect(output.every((r, i) => r[0] === input[i]![0] && r[1] === input[i]![1] && r[2] === (input[i]![2] === 'Online' ? 'Online' : names.get(String(r[1]))))).toBe(true);
  });

  it('next month: the same 50 codes in a different mix', async () => {
    const input = await table(c.input);
    const next = await table(c.next!.input);
    expect(new Set(next.map((r) => r[1]))).toEqual(new Set(input.map((r) => r[1])));
    expect(countCodes(next)[0]).toBeGreaterThanOrEqual(2);
    const byCode = (rows: (string | number | boolean | null)[][]) => Object.fromEntries([...new Set(rows.map((r) => String(r[1])))].map((k) => [k, rows.filter((r) => r[1] === k).length]));
    expect(byCode(next)).not.toEqual(byCode(input));
  });
});

describe('discount-hand-edited', () => {
  const c = load('discount-hand-edited');
  const tenPercent = (amount: number): number => Math.round(amount * 10) / 100;

  it('says in meta what it is really after, and how many rows were edited', () => {
    expect(c.meta.expectNote).toMatch(/3 hand-edited rows/);
    expect(c.meta.handEditedRows).toBe(3);
    expect(c.next).toBeDefined();
  });

  it('150 rows: Discount is 10% of Amount, rounded to 2 decimals, except 3 rows edited by hand', async () => {
    const output = await table(c.output);
    expect(output).toHaveLength(150);
    const edited = output.flatMap((r, i) => (r[3] !== tenPercent(r[2] as number) ? [i] : []));
    expect(edited).toHaveLength(3);
    expect(edited[0]).toBeGreaterThan(30); // away from the first rows
  });

  it('next month: the clean rule, no edited row', async () => {
    const next = await table(c.next!.output);
    expect(next).toHaveLength(120);
    expect(next.every((r) => r[3] === tenPercent(r[2] as number))).toBe(true);
  });
});
