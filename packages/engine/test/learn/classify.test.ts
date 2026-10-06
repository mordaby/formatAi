// The column classification (owner, 2026-10-06; `learn/classify.ts`): one class per column - value shapes from validator.js, then the
// column's name, then the profile - is what masking reads, on every path. Plus the hook for an external classification (`columnHints`):
// it tightens freely, loosens a text column to a category only when code confirms it, and never loosens an identifier.
import type { ColumnClassHints, PayloadCell } from '@formatai/shared';
import { describe, expect, it } from 'vitest';
import type { PairAnalysis } from '../../src/learn/analyze';
import { classifyColumns, sentColumns } from '../../src/learn/classify';
import { createMasker } from '../../src/learn/mask';
import { buildPayload } from '../../src/learn/payload';
import { preflight } from '../../src/learn/preflight';
import { makeValidIsraeliId } from '../../src/values/israeliId';
import { analyzeOk, xlsx, type V } from './analyze/helpers';

const key = (seed: string): Uint8Array => new TextEncoder().encode(seed);
const N = 12;
const rowsOf = (n: number, f: (i: number) => V[]): V[][] => Array.from({ length: n }, (_, i) => f(i));
const NAMES = ['Dana Cohen', 'Yossi Levi', 'Michal Avraham', 'Avi Mizrahi', 'Ronit Peretz', 'Moshe Biton'];

/**
 * A pair whose output copies every input column as it is, plus a note column: `headers` over `cols` (one value per row and column). A
 * single column gets a line number beside it (a header row needs two cells).
 */
function copyPair(headers: string[], cols: ((i: number) => V)[], n = N, opts: { columnHints?: ColumnClassHints } = {}): PairAnalysis {
  if (cols.length === 1) return copyPair([...headers, 'Line'], [...cols, (i) => i + 1], n, opts);
  const input: V[][] = [headers, ...rowsOf(n, (i) => cols.map((c) => c(i)))];
  const output: V[][] = [[...headers, 'Note'], ...rowsOf(n, (i) => [...cols.map((c) => c(i)), i % 2 === 0 ? 'even' : 'odd'])];
  return analyzeOk(xlsx(input), xlsx(output), opts);
}

function payloadJson(a: PairAnalysis, seed: string): string {
  return JSON.stringify(buildPayload(a, preflight(a, 'paid'), { masker: createMasker(key(seed)) }).payload.samples);
}

/** The real values of `values` that show up in `json`. */
const leaked = (json: string, values: readonly PayloadCell[]): PayloadCell[] => values.filter((v) => json.includes(String(v)));

describe('step 1: value shapes from the library', () => {
  const id = (i: number): string => makeValidIsraeliId(String(31234500 + i * 1117).padStart(8, '0'));

  it('a column whose cells validate as one shape is an identifier, whatever its name', () => {
    const a = copyPair(
      ['A', 'B', 'C', 'D', 'E'],
      [
        (i) => `05${i % 10}-${String(1234567 + i * 31).slice(0, 7)}`.replace(/^057/, '052'),
        (i) => `user${i}@example.com`,
        (i) => (i === 3 ? '' : id(i)),
        () => 'IL62 0108 0000 0009 9999 999',
        () => '4111 1111 1111 1111',
      ],
    );
    expect(classifyColumns(a).detail.input).toEqual([
      { class: 'identifier', by: 'shape', shape: 'phone' },
      { class: 'identifier', by: 'shape', shape: 'email' },
      { class: 'identifier', by: 'shape', shape: 'israeliId' },
      { class: 'identifier', by: 'shape', shape: 'iban' },
      { class: 'identifier', by: 'shape', shape: 'card' },
    ]);
  });

  it('a ledger account number and a 9-digit code failing the check digit have no shape: the profile decides', () => {
    const ledger = (i: number): number => 61000100 + i * 100;
    const codes = Array.from({ length: 40 }, (_, k) => 123456700 + k).filter((c) => !makeValidIsraeliId(String(c).slice(0, 8)).endsWith(String(c).slice(8)));
    const a = copyPair(['Ledger', 'Code'], [ledger, (i) => String(codes[i]!)]);
    expect(classifyColumns(a).detail.input.map((c) => c.by)).toEqual(['profile', 'profile']);
  });

  it('a few shaped cells among many others are no identifier shape (a share of 0.8 of the non-empty cells)', () => {
    const a = copyPair(['Contact'], [(i) => (i < 6 ? `user${i}@example.com` : NAMES[i % NAMES.length]!)]);
    expect(classifyColumns(a).detail.input[0]).toEqual({ class: 'text', by: 'profile' });
  });
});

describe('step 2: the column name', () => {
  it('a price column of 1,250,000 values stays real (a measure), and so does a total of 8 digits the profile calls idLike', () => {
    const a = copyPair(['מחיר', 'Total'], [(i) => 1_250_000 + i * 1000, (i) => 12_500_000 + i * 7919]);
    expect(a.input.profile.map((p) => p.type)).toEqual(['integer', 'idLike']);
    expect(classifyColumns(a).input).toEqual(['measure', 'measure']);
    const json = payloadJson(a, 'price');
    expect(leaked(json, rowsOf(N, (i) => [1_250_000 + i * 1000]).flat())).toHaveLength(N);
    expect(leaked(json, rowsOf(N, (i) => [12_500_000 + i * 7919]).flat())).toHaveLength(N);
  });

  it('a repeating customer-number column named מספר לקוח is masked, numbers and all', () => {
    const customer = (i: number): number => 4_100_000 + (i % 3) * 7919; // 3 customers, 4 rows each
    const a = copyPair(['מספר לקוח', 'סכום'], [customer, (i) => 100 + i]);
    expect(a.input.profile[0]!.type).toBe('integer');
    expect(classifyColumns(a).detail.input[0]).toEqual({ class: 'identifier', by: 'name' });
    const json = payloadJson(a, 'customer');
    expect(leaked(json, [0, 1, 2].map(customer))).toEqual([]);
    expect(leaked(json, rowsOf(N, (i) => [100 + i]).flat())).toHaveLength(N); // the amount: real
  });

  // A documented limit (owner, 2026-10-06): nothing in the values or the name says it is an identifier, so it is a measure; the external
  // classification (the AI step reading the names, later) is what will catch it.
  it('an unnamed repeating integer column stays a measure, sent real', () => {
    const value = (i: number): number => 4_100_000 + (i % 3) * 7919;
    const a = copyPair(['Col'], [value]);
    expect(classifyColumns(a).detail.input[0]).toEqual({ class: 'measure', by: 'profile' });
    expect(leaked(payloadJson(a, 'unnamed'), [0, 1, 2].map(value))).toHaveLength(3);
  });

  it('a measure word wins over an identifier word in the same name; a date stays a date whatever its name', () => {
    const a = copyPair(['Account Balance', 'סכום חשבון', 'Policy start date'], [(i) => 1000 + i, (i) => 50 + i, (i) => ({ v: 45000 + i, isDate: true, z: 'dd/mm/yyyy' })]);
    expect(classifyColumns(a).input).toEqual(['measure', 'measure', 'date']);
  });

  it('an identifier word on a text column of codes makes it an identifier; a measure word does not loosen text', () => {
    const a = copyPair(['קוד לקוח', 'Amount'], [(i) => `C-${100 + (i % 4)}`, (i) => `about ${i} units`]);
    expect(classifyColumns(a).input).toEqual(['identifier', 'text']);
  });
});

describe('step 3: the profile type', () => {
  it('text -> text, numbers -> measure, dates -> date, idLike -> identifier, booleans -> category (sent real)', () => {
    const a = copyPair(
      ['Who', 'Qty', 'When', 'Code', 'Flag'],
      [(i) => NAMES[i % NAMES.length]!, (i) => i + 1, (i) => ({ v: 45000 + i, isDate: true, z: 'dd/mm/yyyy' }), (i) => `00${4100 + i}`, (i) => i % 2 === 0],
    );
    expect(classifyColumns(a).input).toEqual(['text', 'measure', 'date', 'identifier', 'category']);
  });
});

describe('a copy keeps one class', () => {
  it('an output column named as an identifier that copies an unnamed input column makes both identifiers (the same fake in `in` and `out`)', () => {
    const input: V[][] = [['Ref', 'Name'], ...rowsOf(N, (i) => [700100 + i * 7, NAMES[i % NAMES.length]!])];
    const output: V[][] = [['Customer No', 'Name'], ...rowsOf(N, (i) => [700100 + i * 7, NAMES[i % NAMES.length]!])];
    const a = analyzeOk(xlsx(input), xlsx(output));
    expect(classifyColumns(a).detail.input[0]).toEqual({ class: 'identifier', by: 'copy' });
    expect(classifyColumns(a).detail.output[0]).toEqual({ class: 'identifier', by: 'name' });
    const { payload } = buildPayload(a, preflight(a, 'paid'), { masker: createMasker(key('copy')) });
    for (const s of payload.samples) expect((s.out as PayloadCell[])[0]).toBe(s.in[0]);
    expect(leaked(JSON.stringify(payload.samples), rowsOf(N, (i) => [700100 + i * 7]).flat())).toEqual([]);
  });
});

describe('the hook for an external classification (columnHints)', () => {
  const STATUS = ['Open', 'Closed', 'Pending'];
  const status = (i: number): string => STATUS[i % 3]!;

  it('tightens freely: a measure becomes an identifier (masked); "person" and "text" mask a column sent real', () => {
    const a = copyPair(['Qty', 'Score', 'Total', 'Who'], [(i) => 300100 + i * 7, (i) => 500200 + i * 13, (i) => 900300 + i * 17, (i) => NAMES[i % NAMES.length]!], N, {
      columnHints: { Qty: 'identifier', Score: 'person', Total: 'text', Who: 'person' },
    });
    expect(classifyColumns(a).detail.input).toEqual([
      { class: 'identifier', by: 'hint' },
      { class: 'identifier', by: 'hint' },
      { class: 'identifier', by: 'hint' },
      { class: 'text', by: 'profile' },
    ]);
    expect(leaked(payloadJson(a, 'tighten'), rowsOf(N, (i) => [300100 + i * 7, 500200 + i * 13, 900300 + i * 17]).flat())).toEqual([]);
  });

  it('loosens a text column to a category (sent real) when code confirms: few values, each on 2 rows or more', () => {
    const a = copyPair(['Status'], [status], N, { columnHints: { status: 'category' } }); // (headers compared normalized)
    expect(classifyColumns(a).detail.input[0]).toEqual({ class: 'category', by: 'hint' });
    expect(leaked(payloadJson(a, 'category'), STATUS)).toEqual(STATUS);
    // Without the hint the same column is text, masked.
    expect(leaked(payloadJson(copyPair(['Status'], [status]), 'category'), STATUS)).toEqual([]);
  });

  it('does not loosen when code does not confirm: too many values, a value on one row, an identifier shape, an identifier or person name', () => {
    const hint = (h: string): ColumnClassHints => ({ [h]: 'category' });
    const many = copyPair(['Status'], [(i) => `S${i % 13}`], 26, { columnHints: hint('Status') });
    const once = copyPair(['Status'], [(i) => (i === 0 ? 'Rare' : status(i))], N, { columnHints: hint('Status') });
    const shaped = copyPair(['Status'], [(i) => (i % 3 === 0 ? 'desk@example.com' : status(i))], N, { columnHints: hint('Status') });
    const person = copyPair(['שם לקוח'], [status], N, { columnHints: hint('שם לקוח') });
    const named = copyPair(['Account'], [status], N, { columnHints: hint('Account') });
    expect([many, once, shaped].map((a) => classifyColumns(a).input[0])).toEqual(['text', 'text', 'text']);
    expect(classifyColumns(person).input[0]).toBe('text');
    expect(classifyColumns(named).input[0]).toBe('identifier');
  });

  it('never loosens an identifier, and "measure" / "date" never loosen a text column', () => {
    const a = copyPair(['מספר לקוח', 'Phone', 'Notes', 'Memo'], [(i) => 4_100_000 + (i % 3), (i) => `050-${1234500 + i}`, status, status], N, {
      columnHints: { 'מספר לקוח': 'category', Phone: 'measure', Notes: 'measure', Memo: 'date' },
    });
    expect(classifyColumns(a).input).toEqual(['identifier', 'identifier', 'text', 'text']);
  });
});

describe('"See what we send": per column, hidden or sent as it is', () => {
  it('masking on: identifiers and text hidden, measures and dates sent; masking off: everything sent', () => {
    const a = copyPair(['ת.ז', 'Name', 'Amount', 'Date'], [(i) => 312345000 + i, (i) => NAMES[i % NAMES.length]!, (i) => 10 + i, (i) => ({ v: 45000 + i, isDate: true, z: 'dd/mm/yyyy' })]);
    expect(sentColumns(a, true)).toEqual({
      input: [
        { header: 'ת.ז', hidden: true },
        { header: 'Name', hidden: true },
        { header: 'Amount', hidden: false },
        { header: 'Date', hidden: false },
      ],
      output: [
        { header: 'ת.ז', hidden: true },
        { header: 'Name', hidden: true },
        { header: 'Amount', hidden: false },
        { header: 'Date', hidden: false },
        { header: 'Note', hidden: true },
      ],
    });
    expect([...sentColumns(a, false).input, ...sentColumns(a, false).output].every((c) => !c.hidden)).toBe(true);
  });
});
