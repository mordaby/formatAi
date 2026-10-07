// A one-time edit or a rule? (SPEC 21 v12 item 20, `learn/oneTimers.ts`): how many rows of the example each part of a rule explains - a
// branch, a value of a list, a lookup row, a value-map entry - and which parts are a question for the user: one row, singled out by its ID,
// an exact amount or date no other row has, or its position; never a categorical value that merely appears once, never more than the
// questions a learn may ask (a column with more is handed to the overfitting guards). On a synthetic order list with one row edited by hand,
// on the real answers of the learn-v8 / learn-v8.1 measurement for discount-hand-edited, and on every kept rules file of that measurement.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { limits, type Expr, type LearnResult } from '@formatai/shared';
import { readWorkbook } from '../../src/io/read';
import { sniffDelimitedText } from '../../src/io/detectFileSpec';
import { analyzePair, type PairAnalysis } from '../../src/learn/analyze';
import { fillParams } from '../../src/learn/fillParams';
import { oneTimeCheck, oneTimeQuestions, partSupport, questionedPositions, type PartSupport } from '../../src/learn/oneTimers';
import { overfitFindings } from '../../src/learn/overfit';
import { parseFormula } from '../../src/formula';
import { runRules } from '../../src/pipeline/runRules';
import type { InputTable } from '../../src/types';
import { analyzeOk, cell, date, xlsx, type V } from './analyze/helpers';

const f = (text: string): Expr => {
  const parsed = parseFormula(text, { allowWindows: true });
  if (!parsed.ok) throw new Error(`${text}: ${parsed.error.message}`);
  return parsed.expr;
};

// ---------------------------------------------------------------------------
// A synthetic order list: 24 orders, Discount 10% of Amount for an open order, 0 for a done or cancelled one; "Cancelled" is on ONE row;
// row 11 (ORD-1009, an open order) was edited by hand to 0. Code: the status as one letter (a value map).
// ---------------------------------------------------------------------------

const N = 24;
const HAND = 9;
const statusOf = (i: number): string => (i === 5 ? 'Cancelled' : i % 3 === 1 ? 'Done' : 'Open');
const amountOf = (i: number): number => 1000.5 + i * 37;
const tenth = (x: number): number => Math.round(x * 10) / 100;
const CODE: Record<string, string> = { Open: 'O', Done: 'D', Cancelled: 'C' };
/** The example's own row of order i (row 1 is the header). */
const rowOf = (i: number): number => i + 2;

function ordersPair(): { input: V[][]; output: V[][] } {
  const input: V[][] = [['Order', 'Status', 'Amount', 'Day']];
  const output: V[][] = [['Order', 'Discount', 'Code']];
  for (let i = 0; i < N; i++) {
    const status = statusOf(i);
    input.push([`ORD-${1000 + i}`, status, amountOf(i), date(2026, 3, 1 + i)]);
    output.push([`ORD-${1000 + i}`, status !== 'Open' || i === HAND ? 0 : tenth(amountOf(i)), CODE[status]!]);
  }
  return { input, output };
}

const PAIR = ordersPair();
const ORDERS: PairAnalysis = analyzeOk(xlsx(PAIR.input), xlsx(PAIR.output));
const REST = 'if(oneOf(status, "Done", "Cancelled"), 0, round(amount * 0.1, 2))';
/** The Code column's value map (left out unless a test asks for it: a check reads Status after it, the Discount rule before). */
const STATUS_CODE = { column: 'status', map: CODE, onMissing: 'flag' as const };

function ordersRules(discount: string, extra: Partial<LearnResult['transform']> = {}): LearnResult {
  return {
    schemaVersion: 1,
    input: {
      sheet: { pick: 'first' },
      headerRow: 'auto',
      columns: [
        { id: 'order', header: 'Order', type: 'text' },
        { id: 'status', header: 'Status', type: 'text' },
        { id: 'amount', header: 'Amount', type: 'decimal' },
        { id: 'day', header: 'Day', type: 'date' },
      ],
    },
    transform: { computed: [{ id: 'discount', type: 'decimal', expr: f(discount) }], valueMaps: [], sort: [], ...extra },
    output: {
      sheetName: 'Sheet1',
      direction: 'ltr',
      language: 'en',
      titleRows: [],
      columns: [
        { header: 'Order', from: 'order' },
        { header: 'Discount', from: 'discount' },
        { header: 'Code', from: 'status' },
      ],
    },
    validations: [],
    unsupported: [],
    assumptions: [],
  };
}

const counts = (s: readonly PartSupport[]): unknown[] =>
  s.map((x) => {
    const p = x.part;
    const what = p.kind === 'branch' ? JSON.stringify(p.when) : p.kind === 'listValue' ? p.value : p.kind === 'lookupEntry' ? p.key : p.from;
    return [x.header, p.kind, what, x.taken, x.support, x.by ?? null];
  });

describe('support counts: how many rows of the example each part explains', () => {
  const done = 8; // i = 1, 4, ... 22
  const open = N - done - 1;

  it('each branch of an if chain: the rows where it is taken AND the output matches', () => {
    const s = partSupport(ordersRules('if(status = "Done", 0, if(status = "Cancelled", 0, round(amount * 0.1, 2)))'), ORDERS);
    expect(counts(s.filter((x) => x.header === 'Discount'))).toEqual([
      ['Discount', 'branch', JSON.stringify(f('status = "Done"')), done, done, null],
      ['Discount', 'branch', JSON.stringify(f('status = "Cancelled"')), 1, 1, null],
    ]);
  });

  it('each value of a value list in a condition; each case of a switch', () => {
    const list = partSupport(ordersRules(REST), ORDERS).filter((x) => x.header === 'Discount');
    expect(counts(list)).toEqual([
      ['Discount', 'branch', JSON.stringify(f('oneOf(status, "Done", "Cancelled")')), done + 1, done + 1, null],
      ['Discount', 'listValue', 'Done', done, done, null],
      ['Discount', 'listValue', 'Cancelled', 1, 1, null],
    ]);
    const sw = partSupport(ordersRules('switch(status = "Done", 0, status = "Open", round(amount * 0.1, 2), 0)'), ORDERS).filter((x) => x.header === 'Discount');
    // The open orders: taken on every one, wrong on the hand-edited row.
    expect(counts(sw).map((c) => (c as unknown[]).slice(3, 5))).toEqual([
      [done, done],
      [open, open - 1],
    ]);
  });

  it('each lookup row (the rows whose key it is, its branch taken) and each value-map entry', () => {
    const tables = [{ name: 'rates', columns: ['status', 'rate'], rows: [['Open', 0.1], ['Done', 0], ['Cancelled', 0]] }];
    const s = partSupport(ordersRules('round(amount * lookup("rates", status, "rate"), 2)', { tables, valueMaps: [STATUS_CODE] }), ORDERS);
    expect(counts(s)).toEqual([
      ['Discount', 'lookupEntry', 'Open', open, open - 1, null],
      ['Discount', 'lookupEntry', 'Done', done, done, null],
      ['Discount', 'lookupEntry', 'Cancelled', 1, 1, null],
      ['Code', 'valueMapEntry', 'Open', open, open, null],
      ['Code', 'valueMapEntry', 'Done', done, done, null],
      ['Code', 'valueMapEntry', 'Cancelled', 1, 1, null],
    ]);
  });

  it('a summary output (one row per group) is not counted', () => {
    const r = ordersRules(REST);
    expect(partSupport({ ...r, transform: { ...r.transform, group: { by: 'status', showDetailRows: false } } }, ORDERS)).toEqual([]);
  });
});

describe('when to ask', () => {
  const ask = (discount: string, opts = {}) => oneTimeQuestions(ordersRules(discount), ORDERS, opts);

  it('the unique ID: "Row 11: Discount is 0 instead of the rest of the rule", with that row\'s values and the check "Not sure" adds', () => {
    const q = ask(`if(order = "ORD-1009", 0, ${REST})`);
    expect(q.handedOff).toEqual([]);
    expect(q.questions).toEqual([
      {
        out: 1,
        header: 'Discount',
        part: { kind: 'branch', computed: 'discount', when: f('order = "ORD-1009"'), then: f('0') },
        row: rowOf(HAND),
        inputRow: rowOf(HAND),
        by: 'id',
        byColumn: 'Order',
        key: 'ORD-1009',
        value: 0,
        rest: tenth(amountOf(HAND)),
        check: { column: 'discount', rule: 'sameAs', expr: f(REST), severity: 'flag', oneTime: true },
      },
    ]);
  });

  it('the unique amount, and the unique date', () => {
    expect(ask(`if(amount = ${amountOf(HAND)}, 0, ${REST})`).questions.map((q) => [q.by, q.byColumn, q.key, q.row])).toEqual([['amount', 'Amount', amountOf(HAND), rowOf(HAND)]]);
    expect(ask(`if(day = date("2026-03-10"), 0, ${REST})`).questions.map((q) => [q.by, q.byColumn, q.key, q.row])).toEqual([['date', 'Day', '2026-03-10', rowOf(HAND)]]);
    // In a list of the order IDs too (each value its own part).
    expect(ask(`if(oneOf(order, "ORD-1009", "ORD-1001"), 0, ${REST})`).questions.map((q) => [q.part.kind, q.by, q.row])).toEqual([['listValue', 'id', rowOf(HAND)]]);
  });

  it('the row-position branch (whatever the condition holds besides)', () => {
    const q = ask(`if(rowNumber() = ${HAND + 1}, 0, ${REST})`).questions;
    expect(q.map((x) => [x.by, x.row, x.value, x.rest])).toEqual([['position', rowOf(HAND), 0, tenth(amountOf(HAND))]]);
    expect(ask(`if(and(rowNumber() = ${HAND + 1}, status = "Open"), 0, ${REST})`).questions.map((x) => x.by)).toEqual(['position']);
    // A list of row positions: each value its own part - one question per row: the branch when it applies to that row alone (no row 99
    // here), the value when the branch applies to other rows too.
    expect(ask(`if(oneOf(rowNumber(), ${HAND + 1}, 99), 0, ${REST})`).questions.map((x) => [x.part.kind, x.by, x.row])).toEqual([['branch', 'position', rowOf(HAND)]]);
    expect(ask(`if(oneOf(rowNumber(), ${HAND + 1}, 2), 0, ${REST})`).questions.map((x) => [x.part.kind, x.by, x.row])).toEqual([['listValue', 'position', rowOf(HAND)]]);
  });

  it('NOT a categorical value that merely appears once (Status "Cancelled"), in a branch, a list, a lookup or a value map; NOT a threshold that picks one row', () => {
    expect(ask('if(status = "Cancelled", 0, if(status = "Done", 0, round(amount * 0.1, 2)))').questions).toEqual([]);
    expect(ask(REST).questions).toEqual([]);
    const tables = [{ name: 'rates', columns: ['status', 'rate'], rows: [['Open', 0.1], ['Done', 0], ['Cancelled', 0]] }];
    expect(oneTimeQuestions(ordersRules('round(amount * lookup("rates", status, "rate"), 2)', { tables, valueMaps: [STATUS_CODE] }), ORDERS).questions).toEqual([]);
    expect(ask(`if(amount > ${amountOf(N - 2)}, 0, ${REST})`).questions).toEqual([]);
  });

  it('NOT an exact amount another row has too, and NOT a part whose row the rest of the rule gives the same value', () => {
    // Two branches that explain the same row: the second one takes over when the first is out, so neither changes anything alone.
    const twice = `if(order = "ORD-1009", 0, if(amount = ${amountOf(HAND)}, 0, ${REST}))`;
    expect(ask(twice).questions).toEqual([]);
    // An open order's own 10%, written out for its ID.
    expect(ask(`if(order = "ORD-1003", ${tenth(amountOf(3))}, ${REST})`).questions).toEqual([]);
  });

  it(`at most ${limits.learn.oneTimer.maxQuestions} per learn: a column with more single-row parts is handed off whole (no question)`, () => {
    const many = `switch(order = "ORD-1009", 0, order = "ORD-1003", ${tenth(amountOf(3))}, order = "ORD-1006", ${tenth(amountOf(6))}, order = "ORD-1012", ${tenth(amountOf(12))}, ${REST})`;
    expect(ask(many)).toEqual({ questions: [], handedOff: [{ header: 'Discount', parts: 4 }] });
    // The budget is per learn: with room for none, the one question is handed off too.
    expect(ask(`if(order = "ORD-1009", 0, ${REST})`, { maxQuestions: 0 })).toEqual({ questions: [], handedOff: [{ header: 'Discount', parts: 1 }] });
    // Completion mode: only the columns the AI step was asked for.
    expect(ask(`if(order = "ORD-1009", 0, ${REST})`, { columns: new Set(['Code']) }).questions).toEqual([]);
  });
});

describe('"Not sure": the check flags a later row the part applies to', () => {
  it('the row-position branch: next month\'s 10th row is flagged, in the check\'s own words; every other row passes', () => {
    const rules = ordersRules(`if(rowNumber() = ${HAND + 1}, 0, ${REST})`);
    const [q] = oneTimeQuestions(rules, ORDERS).questions;
    expect(q?.check).toEqual({ column: 'discount', rule: 'sameAs', expr: f(REST), severity: 'flag', oneTime: true });
    const next: InputTable = {
      sheetName: 'Sheet1',
      direction: 'ltr',
      headers: ['Order', 'Status', 'Amount', 'Day'],
      rows: Array.from({ length: 12 }, (_, i) => [`ORD-${2000 + i}`, 'Open', 500.5 + i, date(2026, 4, 1 + i)].map((v) => cell(v as V))),
      rowNumbers: Array.from({ length: 12 }, (_, i) => i + 2),
    };
    const run = runRules({ ...rules, validations: [q!.check!] }, next);
    if (!run.ok) throw new Error('run failed');
    const flags = run.flags.filter((x) => x.rule === 'sameAs');
    expect(flags.map((x) => [x.rowNumber, x.messageKey, x.params?.other])).toEqual([[HAND + 2, 'flag.validation.sameAs.oneTime', String(tenth(500.5 + HAND))]]);
  });

  it('a lookup row: the table without it, said in one expression; a value-map entry has no check', () => {
    const tables = [{ name: 'byOrder', columns: ['order', 'discount'], rows: [['ORD-1009', 0]] }];
    const rules = ordersRules(`coalesce(lookup("byOrder", order, "discount"), ${REST})`, { tables });
    const [q] = oneTimeQuestions(rules, ORDERS).questions;
    expect(q?.part).toEqual({ kind: 'lookupEntry', table: 'byOrder', key: 'ORD-1009' });
    expect(q?.check?.rule === 'sameAs' && q.check.expr).toEqual(f(`coalesce(if(order = "ORD-1009", null, lookup("byOrder", order, "discount")), ${REST})`));
    expect(oneTimeCheck(rules, { part: { kind: 'valueMapEntry', column: 'status', from: 'Open' } })).toBeNull();
  });

  it('no check when the rest of the rule reads other rows (an across-row function runs only in a computed column), or a column a value map changes', () => {
    const part = { kind: 'branch' as const, computed: 'discount', when: f('order = "ORD-1009"'), then: f('0') };
    expect(oneTimeCheck(ordersRules('if(order = "ORD-1009", 0, round(runningSum(amount) * 0, 2))'), { part, computed: 'discount' })).toBeNull();
    // (A check reads Status after its value map, the rule before it: the two would differ on every row.)
    expect(oneTimeCheck(ordersRules(`if(order = "ORD-1009", 0, ${REST})`, { valueMaps: [STATUS_CODE] }), { part, computed: 'discount' })).toBeNull();
    expect(oneTimeCheck(ordersRules(`if(order = "ORD-1009", 0, ${REST})`), { part, computed: 'discount' })).not.toBeNull();
  });
});

describe('the guards: a row-position branch that is asked about is the user\'s question, not a repair', () => {
  it('one position branch the question explains: waived; four (more than are asked): the guard stands', () => {
    const one = ordersRules(`if(rowNumber() = ${HAND + 1}, 0, ${REST})`);
    expect(overfitFindings(one, { table: null }).map((x) => x.kind)).toEqual(['position']);
    expect([...questionedPositions(one, ORDERS, overfitFindings(one, { table: null }))]).toEqual(['Discount']);
    const four = ordersRules(`switch(rowNumber() = ${HAND + 1}, 0, rowNumber() = 4, ${tenth(amountOf(3))}, rowNumber() = 7, ${tenth(amountOf(6))}, rowNumber() = 13, ${tenth(amountOf(12))}, ${REST})`);
    expect([...questionedPositions(four, ORDERS, overfitFindings(four, { table: null }))]).toEqual([]);
  });

  it('a position condition that is not one row\'s part (rowNumber() <= 3) stays the guard\'s', () => {
    const top = ordersRules(`if(rowNumber() <= 3, 0, ${REST})`);
    expect([...questionedPositions(top, ORDERS, overfitFindings(top, { table: null }))]).toEqual([]);
  });

  it('the finding says whether the position names exact rows (rowExact): only those are left to the browser by the API', () => {
    const exact = (discount: string): boolean | undefined => overfitFindings(ordersRules(discount), { table: null })[0]?.rowExact;
    expect(exact(`if(rowNumber() = ${HAND + 1}, 0, ${REST})`)).toBe(true);
    expect(exact(`if(oneOf(rowNumber(), 3, ${HAND + 1}), 0, ${REST})`)).toBe(true);
    expect(exact(`if(rowNumber() <= 3, 0, ${REST})`)).toBeUndefined();
    expect(exact(`if(rowNumber() <> 1, ${REST}, 0)`)).toBeUndefined();
    expect(exact(`if(rowNumber() = 1, 0, if(rowNumber() > 20, 1, ${REST}))`)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The real answers of the measurement (eval/reports, read-only; `fixtures/keptRules.json`, `fixtures/learnV81Discount.json`)
// ---------------------------------------------------------------------------

const CASES = path.resolve(__dirname, '../../../../eval/cases');
const KEPT = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'keptRules.json'), 'utf8')) as { case: string; sources: string[]; rules: LearnResult }[];
const keptFrom = (source: string): LearnResult => KEPT.find((k) => k.sources.includes(source))!.rules;
const analyses = new Map<string, PairAnalysis>();
async function caseAnalysis(name: string): Promise<PairAnalysis> {
  const known = analyses.get(name);
  if (known) return known;
  const dir = path.join(CASES, name);
  const find = (base: string): string => fs.readdirSync(dir).find((e) => e.startsWith(`${base}.`))!;
  const [inName, outName] = [find('input'), find('output')];
  const outBytes = new Uint8Array(fs.readFileSync(path.join(dir, outName)));
  const outWb = await readWorkbook(outBytes, outName);
  const sniff = outWb.fileType === 'csv' || outWb.fileType === 'txt' ? sniffDelimitedText(outBytes) : undefined;
  const a = analyzePair(await readWorkbook(new Uint8Array(fs.readFileSync(path.join(dir, inName))), inName), outWb, sniff ? { outputSniff: sniff } : {});
  if (!a.ok) throw new Error(`${name}: analysis failed`);
  analyses.set(name, a);
  return a;
}

describe('discount-hand-edited: the answers learn-v8 and learn-v8.1 wrote for its three hand-edited rows (54, 99, 133)', () => {
  it('learn-v8, completion: if(rowNumber() = 1, 0, ...) explains no row of the full example (its row 1 is not a hand-edited one): no question, the guard stands', async () => {
    const a = await caseAnalysis('discount-hand-edited');
    const rules = keptFrom('cmp-learn-v8-complete/discount-hand-edited.complete');
    expect(counts(partSupport(rules, a))).toEqual([['Discount', 'branch', JSON.stringify(f('rowNumber() = 1')), 1, 0, null]]);
    expect(oneTimeQuestions(rules, a)).toEqual({ questions: [], handedOff: [] });
    expect([...questionedPositions(rules, a, overfitFindings(rules, { table: null }))]).toEqual([]);
  });

  it('learn-v8, whole learn: the customer-name branches are no question - a customer and a threshold are a plausible rule, and "Gringotts" applies to three rows', async () => {
    const a = await caseAnalysis('discount-hand-edited');
    const rules = keptFrom('cmp-learn-v8-full/discount-hand-edited.full');
    expect(counts(partSupport(rules, a))).toEqual([
      ['Discount', 'branch', JSON.stringify(f('and(customerName = "Soylent Co", amount > 2500)')), 1, 1, null],
      ['Discount', 'branch', JSON.stringify(f('customerName = "Gringotts Ltd"')), 3, 1, null],
    ]);
    expect(oneTimeQuestions(rules, a).questions).toEqual([]);
  });

  it('learn-v8.1: the table of amounts, filled from every row, is 150 one-row parts - handed to the guard (measureKey), never 150 questions', async () => {
    const a = await caseAnalysis('discount-hand-edited');
    const v81 = (JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'learnV81Discount.json'), 'utf8')) as { rules: LearnResult }).rules;
    const s = partSupport(v81, a);
    expect(s).toHaveLength(150);
    expect(s.every((x) => x.part.kind === 'lookupEntry' && x.taken === 1 && x.support === 1 && x.by === 'amount')).toBe(true);
    expect(oneTimeQuestions(v81, a)).toEqual({ questions: [], handedOff: [{ header: 'Discount', parts: 150 }] });
    expect(overfitFindings(v81, { table: null }).map((x) => x.kind)).toEqual(['measureKey']);
  });

  it('an answer that names the three rows by their Order ID (as a loop round might): three questions, each with the row\'s values', async () => {
    const a = await caseAnalysis('discount-hand-edited');
    const reference = keptFrom('cmp-learn-v8-complete/discount-hand-edited.complete');
    const formula = 'switch(orderId = "ORD-03053", 0, orderId = "ORD-03098", 170.02, orderId = "ORD-03132", 25, round(amount * 0.1, 2))';
    const rules = fillParams({ ...reference, transform: { ...reference.transform, computed: [{ id: 'discount', type: 'decimal', expr: f(formula) }] } }, a).rules;
    const q = oneTimeQuestions(rules, a);
    expect(q.questions.map((x) => [x.row, x.by, x.byColumn, x.value, x.rest])).toEqual([
      [54, 'id', 'Order ID', 0, 252.61],
      [99, 'id', 'Order ID', 170.02, 113.35],
      [133, 'id', 'Order ID', 25, 110.95],
    ]);
  });
});

describe('every kept rules file of the measurement (learn-v7 and learn-v8, both modes, the noE1 arm, the MVP runs)', () => {
  it('asks no one-row question on any of them, and two lists: questions stay rare', async () => {
    const asked: string[] = [];
    const lists: unknown[] = [];
    for (const k of KEPT) {
      const q = oneTimeQuestions(k.rules, await caseAnalysis(k.case));
      if (q.questions.some((x) => x.kind !== 'copiedList')) asked.push(k.sources[0]!);
      for (const x of q.questions) if (x.kind === 'copiedList') lists.push([k.sources[0], x.header, x.keyColumn, x.entries, x.list.kind]);
    }
    expect(asked).toEqual([]);
    // (owner amendment, 2026-10-06) learn-v8's SKU column written as a table of the example's 27 codes, each with its padding (100 ->
    // 000100), keyed on the SKU - different on every row. Next month's file has the same SKUs, so it passes there too: code cannot tell a
    // real list from a copy, and asks.
    // (docs/proposals/saved-format-contents.md section 3) And every kept answer of branch-lookup-50: its branch table, 50 fixed values keyed
    // on the branch code - more than a small vocabulary's 12, nobody can deduce them, and a saved format keeps them: a list, asked at Save.
    const branches = (source: string): unknown[] => [source, 'Branch Name', 'Branch Code', 50, 'lookup'];
    // (Engine audit, 2026-10-07: a key is judged by the input columns its value is made of. learn-v8's full-mode answers keyed the same table
    // on the branch code joined with the channel - 89 fixed values, a list like the others - which the plain-column rule let through.)
    const joined = (source: string): unknown[] => [source, 'Branch Name', 'Branch Code + Channel', 89, 'lookup'];
    expect(lists).toEqual([
      branches('cmp-learn-v7/branch-lookup-50.complete'),
      branches('cmp-learn-v7/branch-lookup-50.full'),
      joined('cmp-learn-v8-full/branch-lookup-50.full'),
      ['cmp-learn-v8-full/stock-count-warehouse-report.full', 'מקט', 'מקט', 27, 'lookup'],
      branches('cmp-learn-v8-complete/branch-lookup-50.complete'),
      branches('cmp-learn-v8-noE1/branch-lookup-50.complete'),
      joined('cmp-learn-v8-noE1/branch-lookup-50.full'),
      branches('mvp-2026-10-04/branch-lookup-50.complete'),
      branches('mvp-2026-10-04/branch-lookup-50.full'),
    ]);
  }, 120_000);
});
