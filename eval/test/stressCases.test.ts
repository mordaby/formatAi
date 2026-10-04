// The six stress cases (eval/cases/buildStress.ts): the data really has the shape each case is meant to have, and the outputs say what the
// case's note says. Every number below is counted from the files, never copied from the generator.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isValidIsraeliId, readWorkbook, ymdToSerial } from '@formatai/engine';
import type { RawSheet } from '@formatai/engine';
import { loadCase, loadCases, type CaseDef, type CaseFile } from '../lib/caseLoader.js';

const CASES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'cases');

type V = string | number | boolean | null;

async function sheetOf(file: CaseFile): Promise<RawSheet> {
  return (await readWorkbook(file.bytes, file.fileName)).sheets[0]!;
}
/** Every row of the first sheet, values only. */
async function grid(file: CaseFile): Promise<V[][]> {
  return (await sheetOf(file)).rows.map((r) => r.map((c) => c?.v ?? null));
}
/** The rows under the header row (the first row), values only. */
async function table(file: CaseFile): Promise<V[][]> {
  return (await grid(file)).slice(1);
}
/** `true` per cell that is a real Excel date, for the rows under the header. */
async function dateCells(file: CaseFile): Promise<boolean[][]> {
  return (await sheetOf(file)).rows.slice(1).map((r) => r.map((c) => c?.isDate === true));
}

const load = (name: string): CaseDef => loadCase(path.join(CASES_DIR, name))!;
const serial = (y: number, m: number, d: number): number => ymdToSerial({ y, m, d });
const cents = (v: V | undefined): number => Math.round((v as number) * 100);
const counts = <T>(xs: T[]): Map<T, number> => xs.reduce((m, x) => m.set(x, (m.get(x) ?? 0) + 1), new Map<T, number>());

const STRESS = ['broken-values', 'running-balance', 'cancel-and-dedupe', 'messy-layout-he', 'dates-mixed-formats', 'region-report-subtotals'];

describe('the six stress cases', () => {
  it('are stress cases with a verified expectation, a note in words, a next-month pair and reference rules', () => {
    const found = loadCases(CASES_DIR, STRESS.join(',')).filter((c) => STRESS.includes(c.name));
    expect(found.map((c) => c.name).sort()).toEqual([...STRESS].sort());
    for (const c of found) {
      expect(c.meta, c.name).toMatchObject({ difficulty: 'stress', expect: 'verified' });
      expect(c.meta.expectNote?.length ?? 0, c.name).toBeGreaterThan(80);
      expect(c.meta.features.length, c.name).toBeGreaterThan(3);
      expect(c.next, c.name).toBeDefined();
      expect(c.referenceRules, c.name).toBeDefined();
    }
  });
});

describe('broken-values', () => {
  const c = load('broken-values');
  const COLS = { id: 0, customer: 1, amount: 2, date: 3, status: 4 };

  it('example input: 120 rows with the broken cells the case promises, the rest clean', async () => {
    const input = await table(c.input);
    const isDate = await dateCells(c.input);
    expect(input).toHaveLength(120);
    expect(input.filter((r) => r[COLS.customer] === null)).toHaveLength(2);
    expect(input.filter((r) => typeof r[COLS.customer] === 'string' && r[COLS.customer] !== (r[COLS.customer] as string).trim())).toHaveLength(3);
    const amounts = input.map((r) => r[COLS.amount]);
    expect(amounts.filter((a) => a === 'N/A')).toHaveLength(1);
    expect(amounts.filter((a) => a === null)).toHaveLength(1);
    expect(amounts.filter((a) => a === '1,250.00 ₪')).toHaveLength(1);
    expect(amounts.filter((a) => typeof a === 'number')).toHaveLength(117);
    const dates = input.map((r) => r[COLS.date]);
    expect(dates.filter((d) => d === '31/02/2026')).toHaveLength(1);
    expect(dates.filter((d) => d === '2026-03-05')).toHaveLength(1);
    expect(isDate.filter((r) => r[COLS.date])).toHaveLength(118);
    // exactly one row is a copy of another row
    const keys = counts(input.map((r) => JSON.stringify(r)));
    expect([...keys.values()].filter((n) => n > 1)).toEqual([2]);
  });

  it('example output: names trimmed, amounts numbers (the unreadable and the empty ones empty), dates real, the duplicate still there', async () => {
    const input = await table(c.input);
    const output = await table(c.output);
    expect(output).toHaveLength(120);
    expect((await grid(c.output))[0]).toEqual(['Order', 'Customer', 'Amount', 'Order Date', 'Status']);
    input.forEach((row, i) => {
      const out = output[i]!;
      expect(out[COLS.id], `row ${i}`).toBe(row[COLS.id]);
      expect(out[COLS.customer], `row ${i}`).toBe(typeof row[COLS.customer] === 'string' ? (row[COLS.customer] as string).trim() : null);
      const amount = row[COLS.amount];
      expect(out[COLS.amount], `row ${i}`).toBe(typeof amount === 'number' ? amount : amount === '1,250.00 ₪' ? 1250 : null);
      const date = row[COLS.date];
      expect(out[COLS.date], `row ${i}`).toBe(date === '31/02/2026' ? null : date === '2026-03-05' ? serial(2026, 3, 5) : date);
      expect(out[COLS.status], `row ${i}`).toBe(row[COLS.status]);
    });
    expect(output.filter((r) => r[COLS.amount] === null)).toHaveLength(2);
    expect(output.filter((r) => r[COLS.date] === null)).toHaveLength(1);
  });

  it('next month: 100 rows with new kinds of broken cells, which the rules leave empty (a negative amount stays)', async () => {
    const input = await table(c.next!.input);
    const output = await table(c.next!.output);
    expect(input).toHaveLength(100);
    const amounts = input.map((r) => r[COLS.amount]);
    expect(amounts).toContain('—');
    expect(amounts).toContain('1.250,00');
    expect(amounts).toContain(-50);
    expect(input.map((r) => r[COLS.date])).toContain('12/13/2026');
    const onlyId = input.flatMap((r, i) => (r[COLS.id] !== null && r.slice(1).every((v) => v === null) ? [i] : []));
    expect(onlyId).toHaveLength(1);
    expect(output[onlyId[0]!]).toEqual([input[onlyId[0]!]![COLS.id], null, null, null, null]);
    input.forEach((row, i) => {
      const out = output[i]!;
      if (['—', '1.250,00'].includes(row[COLS.amount] as string)) expect(out[COLS.amount], `row ${i}`).toBeNull();
      if (row[COLS.date] === '12/13/2026') expect(out[COLS.date], `row ${i}`).toBeNull();
      if (row[COLS.amount] === -50) expect(out[COLS.amount]).toBe(-50);
    });
  });
});

describe('running-balance', () => {
  const c = load('running-balance');
  // Account, Date, Description, Debit, Credit  ->  the same + Balance
  const check = async (file: { input: CaseFile; output: CaseFile }, expectedRows: number) => {
    const input = await table(file.input);
    const output = await table(file.output);
    expect(input).toHaveLength(expectedRows);
    expect(output).toHaveLength(expectedRows);
    expect((await grid(file.output))[0]).toEqual(['Account', 'Date', 'Description', 'Debit', 'Credit', 'Balance']);
    // sorted by Account, then Date
    for (let i = 1; i < output.length; i++) {
      const [a, b] = [output[i - 1]!, output[i]!];
      expect(String(a[0]) < String(b[0]) || (a[0] === b[0] && (a[1] as number) <= (b[1] as number)), `row ${i}`).toBe(true);
    }
    // the balance: per account, in date order (ties in file order), credit minus debit, from 0
    const net = (r: V[]): number => cents(r[4] ?? 0) - cents(r[3] ?? 0);
    const accounts = [...new Set(input.map((r) => r[0] as string))].sort();
    expect(accounts).toHaveLength(4);
    let at = 0;
    for (const account of accounts) {
      const mine = input.filter((r) => r[0] === account).map((r, i) => ({ r, i }));
      mine.sort((x, y) => (x.r[1] as number) - (y.r[1] as number) || x.i - y.i);
      let balance = 0;
      for (const { r } of mine) {
        balance += net(r);
        const out = output[at++]!;
        expect(out.slice(0, 5), `${account} row ${at}`).toEqual(r);
        expect(cents(out[5]), `${account} row ${at}`).toBe(balance);
      }
    }
    return { input, output };
  };

  it('150 ledger rows over 4 accounts, NOT in date order; the balance is the running sum per account in date order, rows sorted by Account then Date', async () => {
    const { input } = await check(c, 150);
    expect(input.some((r, i) => i > 0 && (r[1] as number) < (input[i - 1]![1] as number))).toBe(true);
    // ties: the same account on the same date more than once (file order decides)
    const ties = [...counts(input.map((r) => `${r[0]}|${r[1]}`)).values()].filter((n) => n > 1);
    expect(ties.length).toBeGreaterThan(10);
    // every row has a debit or a credit, never both
    expect(input.every((r) => (r[3] === null) !== (r[4] === null))).toBe(true);
  });

  it('next month: a fresh month, every account starts from 0 again', async () => {
    const { input, output } = await check(c.next!, 130);
    const firstOf = (account: string): V[] => output.find((r) => r[0] === account)!;
    for (const account of new Set(input.map((r) => r[0]))) {
      const first = firstOf(account as string);
      expect(cents(first[5]), String(account)).toBe(cents(first[4] ?? 0) - cents(first[3] ?? 0));
    }
    // another month than the example's
    expect(Math.min(...input.map((r) => r[1] as number))).toBeGreaterThanOrEqual(serial(2026, 2, 1));
  });
});

describe('cancel-and-dedupe', () => {
  const c = load('cancel-and-dedupe');
  // Order ID, Customer, Amount, Status, Updated At
  const check = async (file: { input: CaseFile; output: CaseFile }) => {
    const input = await table(file.input);
    const output = await table(file.output);
    const ids = counts(input.map((r) => r[0] as string));
    const cancelled = input.filter((r) => r[3] === 'Cancelled');
    // the file is in Updated At order, oldest first (so the last row of an order is its latest)
    input.forEach((r, i) => i > 0 && expect(r[4] as number).toBeGreaterThanOrEqual(input[i - 1]![4] as number));
    // no cancelled order is also repeated
    for (const r of cancelled) expect(ids.get(r[0] as string), String(r[0])).toBe(1);
    expect(output.some((r) => r[3] === 'Cancelled')).toBe(false);
    // sorted by Order ID, each order once, exactly the non-cancelled orders
    const expectedIds = [...ids.keys()].filter((id) => !cancelled.some((r) => r[0] === id)).sort();
    expect(output.map((r) => r[0])).toEqual(expectedIds);
    // of a repeated order, the row with the latest Updated At
    for (const out of output) {
      const versions = input.filter((r) => r[0] === out[0]);
      const latest = versions.reduce((a, b) => ((b[4] as number) > (a[4] as number) ? b : a));
      expect(out, String(out[0])).toEqual(latest);
      if (versions.length > 1) expect(new Set(versions.map((v) => v[4])).size, String(out[0])).toBe(versions.length);
    }
    return { input, output, ids, cancelled };
  };

  it('200 rows: 15 Cancelled, 10 orders twice with different Updated At; cancelled rows dropped, the latest version kept, sorted by Order ID', async () => {
    const { input, output, ids, cancelled } = await check(c);
    expect(input).toHaveLength(200);
    expect(cancelled).toHaveLength(15);
    expect([...counts([...ids.values()]).entries()].sort()).toEqual([[1, 180], [2, 10]]);
    expect(output).toHaveLength(175);
  });

  it('next month: a different mix (more cancelled, fewer repeated, one order three times)', async () => {
    const example = await check(c);
    const { input, output, ids, cancelled } = await check(c.next!);
    expect(input.length).not.toBe(example.input.length);
    expect(cancelled.length).toBeGreaterThan(example.cancelled.length);
    expect([...counts([...ids.values()]).entries()].sort()).toEqual([[1, 162], [2, 7], [3, 1]]);
    expect(output).toHaveLength(170 - cancelled.length);
  });
});

describe('messy-layout-he', () => {
  const c = load('messy-layout-he');
  const HEADER = ['ת.ז.', 'שם', 'קוד פנימי', 'סכום'];

  const checkInput = async (file: CaseFile, rowsExpected: number) => {
    const sheet = await sheetOf(file);
    const rows = sheet.rows.map((r) => r.map((cell) => cell?.v ?? null));
    expect(sheet.rightToLeft).toBe(true);
    // 3 title lines (a merged title, a production-date line, a blank line), the header on row 4, a hidden column, a footer row
    expect(rows[0]![0]).toBe('דוח מכירות');
    expect(sheet.merges).toContainEqual({ s: { r: 0, c: 0 }, e: { r: 0, c: 3 } });
    expect(String(rows[1]![0])).toMatch(/^תאריך הפקה: \d\d\/\d\d\/\d{4}$/);
    expect(rows[2]!.every((v) => v === null)).toBe(true);
    expect(rows[3]).toEqual(HEADER);
    expect(sheet.hiddenCols).toEqual([2]);
    const data = rows.slice(4, -1);
    expect(data).toHaveLength(rowsExpected);
    const footer = rows[rows.length - 1]!;
    expect(footer[0]).toBe('סה"כ');
    expect(cents(footer[3])).toBe(data.reduce((s, r) => s + cents(r[3]), 0));
    // ID numbers are numbers, every one a valid Israeli ID once the zeros are back, and some lost their zero(s)
    expect(data.every((r) => typeof r[0] === 'number' && isValidIsraeliId(String(r[0])))).toBe(true);
    const lost = data.filter((r) => (r[0] as number) < 100000000);
    expect(lost.length).toBeGreaterThanOrEqual(Math.floor(rowsExpected / 8));
    expect(data.some((r) => (r[0] as number) < 10000000)).toBe(true);
    return data;
  };
  const checkOutput = async (file: CaseFile, data: V[][]) => {
    const out = await grid(file);
    expect(out[0]).toEqual(['ת.ז.', 'שם', 'סכום', 'מע"מ']);
    expect(out).toHaveLength(data.length + 1); // no title lines, no footer
    data.forEach((r, i) => {
      const row = out[i + 1]!;
      expect(row[0], `row ${i}`).toBe(String(r[0]).padStart(9, '0'));
      expect(row[1]).toBe(r[1]);
      expect(row[2]).toBe(r[3]);
      expect(cents(row[3]), `row ${i}`).toBe(Math.round((cents(r[3]) * 18) / 100)); // round(amount x 0.18, 2)
    });
  };

  it('example: a messy sheet in; a clean table with 9-digit text IDs and a VAT column out', async () => {
    const data = await checkInput(c.input, 40);
    await checkOutput(c.output, data);
  });

  it('next month: the same layout with new rows', async () => {
    const example = await checkInput(c.input, 40);
    const data = await checkInput(c.next!.input, 34);
    expect(data.map((r) => r[0])).not.toEqual(example.slice(0, 34).map((r) => r[0]));
    await checkOutput(c.next!.output, data);
  });
});

describe('dates-mixed-formats', () => {
  const c = load('dates-mixed-formats');
  const HE_MONTH = /^(\d{1,2}) ב(מרץ|אפריל) 2026$/;
  /** What a person reads from the input's Date cell (day/month for text, as in Israel). */
  const readDate = (v: V | undefined, isDate: boolean): { y: number; m: number; d: number; kind: string } => {
    if (isDate) {
      const days = Math.round(v as number) - serial(2026, 1, 1);
      const dt = new Date(Date.UTC(2026, 0, 1 + days));
      return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate(), kind: 'excel' };
    }
    const s = String(v);
    let m = /^(\d\d)\/(\d\d)\/(\d{4})$/.exec(s);
    if (m) return { y: Number(m[3]), m: Number(m[2]), d: Number(m[1]), kind: 'dayMonthText' };
    m = /^(\d{4})-(\d\d)-(\d\d)$/.exec(s);
    if (m) return { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]), kind: 'isoText' };
    m = HE_MONTH.exec(s);
    if (m) return { y: 2026, m: m[2] === 'מרץ' ? 3 : 4, d: Number(m[1]), kind: 'hebrewText' };
    throw new Error(`unreadable date in the fixture: ${s}`);
  };
  const check = async (file: { input: CaseFile; output: CaseFile }, rowsExpected: number, month: number) => {
    const input = await table(file.input);
    const isDate = await dateCells(file.input);
    const output = await table(file.output);
    expect(input).toHaveLength(rowsExpected);
    expect(output).toHaveLength(rowsExpected);
    expect((await grid(file.output))[0]).toEqual(['Reference', 'Customer', 'Date', 'Period', 'Amount']);
    const kinds: string[] = [];
    input.forEach((row, i) => {
      const read = readDate(row[2], isDate[i]![2]!);
      kinds.push(read.kind);
      const p2 = (n: number): string => String(n).padStart(2, '0');
      expect(read.m, `row ${i}`).toBe(month);
      expect(output[i]![2], `row ${i}`).toBe(`${read.y}-${p2(read.m)}-${p2(read.d)}`);
      expect(output[i]![3], `row ${i}`).toBe(`${p2(month)}/2026`);
      // Amount: text with thousands separators in, a number out
      expect(typeof row[3]).toBe('string');
      expect(row[3]).toMatch(/^\d{1,3}(,\d{3})*\.\d\d$/);
      expect(output[i]![4], `row ${i}`).toBe(Number((row[3] as string).replace(/,/g, '')));
    });
    return { input, kinds };
  };

  it('example: 60 rows, four ways of writing the date; every day/month text is ambiguous (both parts 12 or less)', async () => {
    const { input, kinds } = await check(c, 60, 3);
    expect([...counts(kinds).entries()].sort()).toEqual([['dayMonthText', 18], ['excel', 18], ['hebrewText', 12], ['isoText', 12]]);
    for (const row of input) {
      const m = /^(\d\d)\/(\d\d)\/2026$/.exec(String(row[2]));
      if (m) expect(Math.max(Number(m[1]), Number(m[2]))).toBeLessThanOrEqual(12);
    }
  });

  it('next month: April, and "13/04/2026" shows that the order is day/month', async () => {
    const { input, kinds } = await check(c.next!, 50, 4);
    expect(input.map((r) => r[2])).toContain('13/04/2026');
    expect(new Set(kinds)).toEqual(new Set(['dayMonthText', 'excel', 'hebrewText', 'isoText']));
  });
});

describe('region-report-subtotals', () => {
  const c = load('region-report-subtotals');
  const check = async (file: { input: CaseFile; output: CaseFile }, rowsExpected: number, title: string) => {
    const input = await table(file.input);
    const out = await grid(file.output);
    expect(input).toHaveLength(rowsExpected);
    // title from the data's dates, English headers, no Date column
    expect(out[0]![0]).toBe(title);
    expect(out[1]).toEqual(['Region', 'Sales rep', 'Amount']);
    // regions in order, each: rows by Amount descending, a summary row (count of rows, sum), a blank row; then a grand total
    const regions = [...new Set(input.map((r) => r[0] as string))].sort();
    let at = 2;
    for (const region of regions) {
      const mine = input.filter((r) => r[0] === region);
      const detail = out.slice(at, at + mine.length);
      expect(detail.map((r) => cents(r[2])), region).toEqual(mine.map((r) => cents(r[2])).sort((a, b) => b - a));
      expect(detail.every((r) => r[0] === region)).toBe(true);
      // every row keeps its rep with its amount
      expect(counts(detail.map((r) => `${r[1]}|${cents(r[2])}`))).toEqual(counts(mine.map((r) => `${r[1]}|${cents(r[2])}`)));
      const summary = out[at + mine.length]!;
      expect(summary[0], region).toBe('Region total');
      expect(summary[1], region).toBe(mine.length);
      expect(cents(summary[2]), region).toBe(mine.reduce((s, r) => s + cents(r[2]), 0));
      expect(out[at + mine.length + 1]!.every((v) => v === null), region).toBe(true);
      at += mine.length + 2;
    }
    const grand = out[at]!;
    expect(out).toHaveLength(at + 1);
    expect(grand[0]).toBe('Grand total');
    expect(grand[1]).toBe(rowsExpected);
    expect(cents(grand[2])).toBe(input.reduce((s, r) => s + cents(r[2]), 0));
    return input;
  };

  it('80 flat rows become a report: title, sorted regions, a summary row and a blank row per region, a grand total', async () => {
    const input = await check(c, 80, 'Sales by region - March 2026');
    expect(new Set(input.map((r) => r[0])).size).toBe(4);
    // the file is not grouped by region
    expect(input.some((r, i) => i > 0 && r[0] !== input[i - 1]![0])).toBe(true);
  });

  it('next month: April, so the title says April 2026', async () => {
    await check(c.next!, 90, 'Sales by region - April 2026');
  });
});
