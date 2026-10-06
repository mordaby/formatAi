// The overfitting guards (SPEC 9.2 layer 6, 21 v12 item 19; `learn/overfit.ts`): a condition on a row's position, and a long case list that
// copies the example's answers. True positives are the real answers of the learn-v8 measurement (2026-10-05); the false-positive check runs
// the guards over EVERY kept rules file of that measurement (`fixtures/keptRules.json`: learn-v7 and learn-v8, both modes, the noE1 arm and
// the earlier MVP runs - 96 files, 90 distinct), each on its own eval case, the way the browser sees it (every row of the example) and the
// way the server does (the payload's sample rows).
import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { limits, type Expr, type LearnResult } from '@formatai/shared';
import { readWorkbook } from '../../src/io/read';
import { sniffDelimitedText } from '../../src/io/detectFileSpec';
import { analyzePair, type PairAnalysis } from '../../src/learn/analyze';
import { overfitFindings, overfitProblems, withOverfitFallback, type OverfitFinding } from '../../src/learn/overfit';
import { preflight } from '../../src/learn/preflight';
import { aiReadiness } from '../../src/learn/readiness';
import { exampleTable } from '../../src/learn/verify';
import { parseFormula } from '../../src/formula';
import type { InputTable } from '../../src/types';

interface Kept {
  case: string;
  sources: string[];
  rules: LearnResult;
}
const KEPT = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'keptRules.json'), 'utf8')) as Kept[];
const CASES = path.resolve(__dirname, '../../../../eval/cases');

interface Views {
  analysis: PairAnalysis;
  /** Every row of the example (the browser). */
  all: InputTable;
  /** The payload's sample rows (the server's view, unmasked). */
  samples: InputTable;
}

const views = new Map<string, Views>();
async function viewsOf(name: string): Promise<Views> {
  const known = views.get(name);
  if (known) return known;
  const dir = path.join(CASES, name);
  const find = (base: string): string => fs.readdirSync(dir).find((e) => e.startsWith(`${base}.`))!;
  const inName = find('input');
  const outName = find('output');
  const outBytes = new Uint8Array(fs.readFileSync(path.join(dir, outName)));
  const outWb = await readWorkbook(outBytes, outName);
  const sniff = outWb.fileType === 'csv' || outWb.fileType === 'txt' ? sniffDelimitedText(outBytes) : undefined;
  const analysis = analyzePair(await readWorkbook(new Uint8Array(fs.readFileSync(path.join(dir, inName))), inName), outWb, sniff ? { outputSniff: sniff } : {});
  if (!analysis.ok) throw new Error(`${name}: analysis failed`);
  const all = exampleTable(analysis);
  const built = aiReadiness(analysis, preflight(analysis, 'paid'), {}).built;
  const rows = built ? built.sampleRows.map((s) => s.in) : [];
  const samples: InputTable = { ...all, rows: rows.map((i) => all.rows[i]!), rowNumbers: rows.map((i) => all.rowNumbers[i]!) };
  const v = { analysis, all, samples };
  views.set(name, v);
  return v;
}

const keptFrom = (source: string): Kept => {
  const k = KEPT.find((x) => x.sources.includes(source));
  if (!k) throw new Error(`no kept rules from ${source}`);
  return k;
};
const label = (fs: readonly OverfitFinding[]): string[] => fs.map((f) => `${f.kind}:${f.outputColumn}`);
const f = (text: string): Expr => {
  const parsed = parseFormula(text, { allowWindows: true });
  if (!parsed.ok) throw new Error(`${text}: ${parsed.error.message}`);
  return parsed.expr;
};

/** A small rules file: input columns Customer, Supplier, Item, Qty, Amount; output Value from `value`, plus Customer. */
function rulesWith(value: string, extra: { id: string; expr: string; type?: string }[] = []): LearnResult {
  return {
    schemaVersion: 1,
    input: {
      sheet: { pick: 'first' },
      headerRow: 'auto',
      columns: [
        { id: 'customer', header: 'Customer', type: 'text' },
        { id: 'supplier', header: 'Supplier', type: 'text' },
        { id: 'item', header: 'Item', type: 'text' },
        { id: 'qty', header: 'Qty', type: 'integer' },
        { id: 'amount', header: 'Amount', type: 'decimal' },
      ],
    },
    transform: {
      computed: [...extra.map((c) => ({ id: c.id, type: (c.type ?? 'integer') as 'integer', expr: f(c.expr) })), { id: 'value', type: 'text', expr: f(value) }],
      valueMaps: [],
      sort: [],
    },
    output: { sheetName: 'Out', direction: 'ltr', language: 'en', titleRows: [], columns: [{ header: 'Customer', from: 'customer' }, { header: 'Value', from: 'value' }] },
    validations: [],
    unsupported: [],
    assumptions: [],
  };
}

/** An input table for `rulesWith`: one row per [customer, supplier, item, qty, amount]. */
function table(rows: (string | number)[][]): InputTable {
  return {
    sheetName: 'In',
    direction: 'ltr',
    headers: ['Customer', 'Supplier', 'Item', 'Qty', 'Amount'],
    rows: rows.map((r) => r.map((v) => ({ v }))),
    rowNumbers: rows.map((_, i) => i + 2),
  };
}

const SUPPLIERS = ['North', 'Global', 'Acme'];
const ITEMS = ['Bolt', 'Nut', 'Panel', 'Motor'];
/** 24 rows: every supplier x item twice, quantities 1..24, amounts 100..2400. */
const GRID = table(Array.from({ length: 24 }, (_, i) => [`C${i % 5}`, SUPPLIERS[i % 3]!, ITEMS[i % 4]!, i + 1, (i + 1) * 100]));

describe('position: a condition that compares a row position of the whole file with a constant', () => {
  it('finds the real learn-v8 answer for discount-hand-edited (complete mode): if(rowNumber() = 1, 0, ...), on every view', async () => {
    const { rules } = keptFrom('cmp-learn-v8-complete/discount-hand-edited.complete');
    const v = await viewsOf('discount-hand-edited');
    expect(label(overfitFindings(rules, { table: v.all }))).toEqual(['position:Discount']);
    expect(label(overfitFindings(rules, { table: v.samples }))).toEqual(['position:Discount']);
    // A position needs no row: it is found whatever rows there are.
    expect(label(overfitFindings(rules, { table: null }))).toEqual(['position:Discount']);
    // The noE1 arm wrote the same.
    expect(label(overfitFindings(keptFrom('cmp-learn-v8-noE1/discount-hand-edited.complete').rules, { table: v.all }))).toEqual(['position:Discount']);
  });

  it('every comparison with a constant, either side, through a helper column, and oneOf; rank too', () => {
    for (const value of ['if(rowNumber() = 1, "first", "rest")', 'if(3 >= rowNumber(), "top", "rest")', 'if(oneOf(rowNumber(), 1, 2), "a", "b")', 'if(rank(order: amount desc) <= 3, "top", "rest")']) {
      expect(label(overfitFindings(rulesWith(value), { table: null })), value).toEqual(['position:Value']);
    }
    const viaHelper = rulesWith('if(n = 1, "first", "rest")', [{ id: 'n', expr: 'rowNumber()' }]);
    expect(label(overfitFindings(viaHelper, { table: null }))).toEqual(['position:Value']);
  });

  it('allows a row number as a column\'s value, a position within a group, and a comparison with another column', () => {
    expect(overfitFindings(rulesWith('toText(rowNumber())'), { table: GRID })).toEqual([]);
    expect(overfitFindings(rulesWith('if(rowNumber(by: customer) = 1, customer, "")'), { table: GRID })).toEqual([]);
    expect(overfitFindings(rulesWith('if(rank(order: amount desc, by: supplier) = 1, "best", "")'), { table: GRID })).toEqual([]);
    expect(overfitFindings(rulesWith('if(rowNumber() = qty, "same", "")'), { table: GRID })).toEqual([]);
  });
});

describe('caseList: a long chain of cases, each giving a constant to one or two rows picked by input values', () => {
  it('finds the real learn-v8 answer for fulfillment-external-column (complete mode): 13 cases of supplier + item (+ qty ranges)', async () => {
    const { rules } = keptFrom('cmp-learn-v8-complete/fulfillment-external-column.complete');
    const v = await viewsOf('fulfillment-external-column');
    expect(overfitFindings(rules, { table: v.all })).toEqual([{ kind: 'caseList', outputColumn: 'Assigned Warehouse', out: 5, id: 'assignedWarehouse', cases: 13 }]);
    expect(label(overfitFindings(rules, { table: v.samples }))).toEqual(['caseList:Assigned Warehouse']);
    // No rows to count: never reported.
    expect(overfitFindings(rules, { table: null })).toEqual([]);
  });

  const sixCombos = 'switch(and(supplier = "North", item = "Bolt"), "W1", and(supplier = "Global", item = "Nut"), "W2", and(supplier = "Acme", item = "Panel"), "W3", and(supplier = "North", item = "Motor"), "W4", and(supplier = "Global", item = "Bolt"), "W5", and(supplier = "Acme", item = "Nut"), "W6", "W0")';

  it(`finds ${limits.learn.overfit.minCases} cases on two columns when each picks at most ${limits.learn.overfit.maxRowsPerCase} rows, also with ifs around the switch`, () => {
    expect(label(overfitFindings(rulesWith(sixCombos), { table: GRID }))).toEqual(['caseList:Value']);
    // (Six nested ifs are past the nesting limit the checks enforce; a chain the limit allows mixes ifs and a switch.)
    const nested = 'if(and(supplier = "North", item = "Bolt"), "W1", if(and(supplier = "Global", item = "Nut"), "W2", switch(and(supplier = "Acme", item = "Panel"), "W3", and(supplier = "North", item = "Motor"), "W4", and(supplier = "Global", item = "Bolt"), "W5", and(supplier = "Acme", item = "Nut"), "W6", "W0")))';
    expect(label(overfitFindings(rulesWith(nested), { table: GRID }))).toEqual(['caseList:Value']);
  });

  it('not when a case picks more rows than that (a real mapping), nor with one case fewer', () => {
    const wide = table([...GRID.rows.map((r) => r.map((c) => c!.v as string | number)), ...GRID.rows.map((r) => r.map((c) => c!.v as string | number))]);
    expect(overfitFindings(rulesWith(sixCombos), { table: wide })).toEqual([]);
    const five = 'switch(and(supplier = "North", item = "Bolt"), "W1", and(supplier = "Global", item = "Nut"), "W2", and(supplier = "Acme", item = "Panel"), "W3", and(supplier = "North", item = "Motor"), "W4", and(supplier = "Global", item = "Bolt"), "W5", "W0")';
    expect(overfitFindings(rulesWith(five), { table: GRID })).toEqual([]);
  });

  it('not a band table or a value map written out on one column, however long', () => {
    const bands = 'switch(amount < 300, "A", amount < 600, "B", amount < 900, "C", amount < 1200, "D", amount < 1500, "E", amount < 1800, "F", "G")';
    expect(overfitFindings(rulesWith(bands), { table: GRID })).toEqual([]);
    const map = 'switch(customer = "C0", "x", customer = "C1", "y", customer = "C2", "z", customer = "C3", "w", customer = "C4", "v", customer = "C5", "u", "t")';
    expect(overfitFindings(rulesWith(map), { table: GRID })).toEqual([]);
  });

  it('not when a case gives a formula, or picks rows by something other than equalities and ranges', () => {
    const formula = sixCombos.replace('"W1"', 'concat(item, "-1")');
    expect(overfitFindings(rulesWith(formula), { table: GRID })).toEqual([]);
    const text = sixCombos.replace('item = "Bolt"), "W1"', 'startsWith(item, "Bo")), "W1"');
    expect(overfitFindings(rulesWith(text), { table: GRID })).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Atoms, not cases (owner amendment, 2026-10-06): gpt-5's escalation on the owner's 100-row file wrote a class by total as
  // switch(or(id = ..., 20 IDs), "Small", or(... 11 IDs), "Big", or(3 IDs), "Medium", id = ..., ... 5 single IDs, qty = 24, "Big",
  // oneOf(qty, 1, 4, 5, 10), "Small", "Medium") - each case picks many rows, so the per-case count let it through. Synthetic IDs here.
  // -------------------------------------------------------------------------

  /** 48 rows, one person each (a column unique per row), supplier x item four times, quantities 1..48. */
  const PEOPLE = table(Array.from({ length: 48 }, (_, i) => [`P-${100 + i}`, SUPPLIERS[i % 3]!, ITEMS[i % 4]!, i + 1, (i + 1) * 100]));
  const ids = (from: number, to: number): string => Array.from({ length: to - from }, (_, k) => `customer = "P-${100 + from + k}"`).join(', ');
  const MEMORIZED = `switch(or(${ids(0, 20)}), "Small", or(${ids(20, 31)}), "Big", or(${ids(31, 34)}), "Medium", ${[34, 35, 36, 37, 38].map((i) => `customer = "P-${100 + i}", "Medium"`).join(', ')}, qty = 24, "Big", oneOf(qty, 1, 4, 5, 10), "Small", "Medium")`;

  it('counts atoms: the memorized class list (or-lists of IDs, single IDs, quantities) is found, and says how many values it names', () => {
    const rules = rulesWith(MEMORIZED);
    expect(overfitFindings(rules, { table: PEOPLE })).toEqual([{ kind: 'caseList', outputColumn: 'Value', out: 1, id: 'value', cases: 10, atoms: 39 }]);
    expect(overfitProblems(overfitFindings(rules, { table: PEOPLE }))[0]!.message).toBe(
      'Column "Value": this rule copies particular rows of the example (it is a list of 10 cases whose conditions name 39 values one by one, each picking one or two rows; a real mapping is a value map or a lookup table); write a rule that holds for any row, or report the column as unsupported.',
    );
    // The fallback takes the IDs out with the rule: nothing of them is left to be saved.
    const fallback = withOverfitFallback(rules, overfitFindings(rules, { table: PEOPLE }));
    expect(fallback.unsupported).toEqual([{ outputColumn: 'Value', reasonCode: 'overfit' }]);
    expect(JSON.stringify(fallback)).not.toContain('P-1');
  });

  it('a case list the cases already show (every case on a row or two) has no atom count: the server can judge it too', () => {
    expect(overfitFindings(rulesWith(sixCombos), { table: GRID })[0]).not.toHaveProperty('atoms');
  });

  it('NOT a real rule whose or-lists each pick many rows', () => {
    const lists = 'switch(oneOf(supplier, "North", "Global"), "A", oneOf(item, "Bolt", "Nut", "Panel"), "B", or(supplier = "Acme", item = "Motor"), "C", "D")';
    expect(overfitFindings(rulesWith(lists), { table: PEOPLE })).toEqual([]);
  });

  it(`NOT 3 special IDs beside a rule (fewer than ${limits.learn.overfit.minCases} atoms)`, () => {
    expect(overfitFindings(rulesWith(`switch(oneOf(customer, "P-100", "P-101", "P-102"), "Big", qty > 40, "Big", "Small")`), { table: PEOPLE })).toEqual([]);
  });

  it('only when the atoms that pin rows are at least half of all the atoms (a real rule may list a rare value or two)', () => {
    const wide = 'oneOf(item, "Bolt", "Nut", "Panel", "Motor"), "B", oneOf(supplier, "North", "Global", "Acme"), "C"';
    expect(overfitFindings(rulesWith(`switch(or(${ids(0, 6)}), "A", ${wide}, "D")`), { table: PEOPLE })).toEqual([]);
    expect(label(overfitFindings(rulesWith(`switch(or(${ids(0, 7)}), "A", ${wide}, "D")`), { table: PEOPLE }))).toEqual(['caseList:Value']);
  });

  it('never a correct threshold rule or a status rule (the false positive the old lint gave in the browser)', async () => {
    expect(overfitFindings(rulesWith('if(amount >= 5000, "Urgent", "Normal")'), { table: GRID })).toEqual([]);
    const { rules } = keptFrom('cmp-learn-v8-full/orders-priority.full');
    const v = await viewsOf('orders-priority');
    expect(overfitFindings(rules, { table: v.all })).toEqual([]);
    expect(overfitFindings(rules, { table: v.samples })).toEqual([]);
  });
});

describe('measureKey: a lookup keyed on an amount', () => {
  const V81 = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'learnV81Discount.json'), 'utf8')) as { rules: LearnResult };

  it('finds the real learn-v8.1 answer for discount-hand-edited: coalesce(lookup("discountTable", amount, ...), round(amount * 0.1, 2))', async () => {
    const v = await viewsOf('discount-hand-edited');
    expect(label(overfitFindings(V81.rules, { table: v.all }))).toEqual(['measureKey:Discount']);
    expect(label(overfitFindings(V81.rules, { table: null }))).toEqual(['measureKey:Discount']);
    expect(overfitProblems(overfitFindings(V81.rules, { table: null }))[0]).toMatchObject({ kind: 'overfit', message: expect.stringContaining('it looks values up by an amount') });
  });

  it('the fallback takes the table of amounts out with the rule', () => {
    const fallback = withOverfitFallback(V81.rules, overfitFindings(V81.rules, { table: null }));
    expect(V81.rules.transform.tables?.map((t) => t.name)).toEqual(['discountTable']);
    expect(fallback.transform.tables).toEqual([]);
    expect(fallback.transform.computed).toEqual([]);
    expect(fallback.unsupported).toEqual([{ outputColumn: 'Discount', reasonCode: 'overfit' }]);
  });

  it('not a lookup keyed on a code or a category (text, an integer code); one keyed on a decimal amount is', () => {
    const tables = [{ name: 't', columns: ['k', 'v'], rows: [[1, 'a']] }];
    const withTable = (r: LearnResult): LearnResult => ({ ...r, transform: { ...r.transform, tables } });
    expect(overfitFindings(withTable(rulesWith('toText(lookup("t", item, "v"))')), { table: null })).toEqual([]);
    expect(overfitFindings(withTable(rulesWith('toText(lookup("t", qty, "v"))')), { table: null })).toEqual([]);
    expect(label(overfitFindings(withTable(rulesWith('toText(lookup("t", amount, "v"))')), { table: null }))).toEqual(['measureKey:Value']);
  });
});

describe('every kept rules file of the measurement (learn-v7 and learn-v8, both modes, the noE1 arm, the MVP runs)', () => {
  const found: Record<string, string[]> = {};
  beforeAll(async () => {
    for (const k of KEPT) {
      const v = await viewsOf(k.case);
      const all = label(overfitFindings(k.rules, { table: v.all }));
      const samples = label(overfitFindings(k.rules, { table: v.samples }));
      expect(samples, `${k.sources[0]}: the server and the browser disagree`).toEqual(all);
      if (all.length > 0) for (const s of k.sources) found[s] = all;
    }
  }, 120_000);

  it(`reads the whole corpus (${KEPT.length} distinct kept rules files)`, () => {
    expect(KEPT.length).toBe(90);
    expect(KEPT.reduce((n, k) => n + k.sources.length, 0)).toBe(96);
  });

  it('finds exactly the memorized warehouse list and the row-position discount, nothing else: no false positive', () => {
    expect(found).toEqual({
      'cmp-learn-v8-complete/fulfillment-external-column.complete': ['caseList:Assigned Warehouse'],
      'cmp-learn-v8-complete/discount-hand-edited.complete': ['position:Discount'],
      'cmp-learn-v8-noE1/discount-hand-edited.complete': ['position:Discount'],
    });
  });

  it('DECISION: not the two learn-v8 answers only the old lint\'s noisy kinds caught - a customer-name branch (full mode, notVerified anyway) and a lookup keyed on two columns (a lookup is the form a real mapping takes; a new key is flagged at run time)', () => {
    for (const source of ['cmp-learn-v8-full/discount-hand-edited.full', 'cmp-learn-v8-full/branch-lookup-50.full']) {
      expect(found[source], source).toBeUndefined();
    }
  });
});

describe('what a finding becomes', () => {
  it('one overfit problem per column, in plain words, naming no value of any row', () => {
    const problems = overfitProblems([
      { kind: 'caseList', outputColumn: 'Assigned Warehouse', out: 4, id: 'w', cases: 13 },
      { kind: 'position', outputColumn: 'Assigned Warehouse', out: 4, id: 'w' },
      { kind: 'position', outputColumn: 'Discount', out: 3, id: 'discount' },
    ]);
    expect(problems).toEqual([
      {
        kind: 'overfit',
        out: 4,
        message:
          'Column "Assigned Warehouse": this rule copies particular rows of the example (it is a list of 13 cases, each giving a constant to one or two rows; a real mapping is a value map or a lookup table; it compares a row position (rowNumber or rank) with a constant); write a rule that holds for any row, or report the column as unsupported.',
      },
      {
        kind: 'overfit',
        out: 3,
        message: 'Column "Discount": this rule copies particular rows of the example (it compares a row position (rowNumber or rank) with a constant); write a rule that holds for any row, or report the column as unsupported.',
      },
    ]);
  });

  it('the honest fallback: the column is reported unsupported by code (reason overfit), its rule taken out, everything else kept', async () => {
    const { rules } = keptFrom('cmp-learn-v8-complete/fulfillment-external-column.complete');
    const v = await viewsOf('fulfillment-external-column');
    const fallback = withOverfitFallback(rules, overfitFindings(rules, { table: v.all }));
    expect(fallback.output.columns.map((c) => [c.header, c.from])).toEqual(rules.output.columns.map((c) => [c.header, c.header === 'Assigned Warehouse' ? null : c.from]));
    expect(fallback.unsupported).toEqual([{ outputColumn: 'Assigned Warehouse', reasonCode: 'overfit' }]);
    expect(fallback.transform.computed.map((c) => c.id)).toEqual(rules.transform.computed.map((c) => c.id).filter((id) => id !== 'assignedWarehouse'));
    expect(overfitFindings(fallback, { table: v.all })).toEqual([]);
    expect(withOverfitFallback(rules, [])).toBe(rules);
  });

  it('a helper column something else still reads stays; one only the dropped rule read goes with it', () => {
    const rules = rulesWith('if(n = 1, "first", "rest")', [{ id: 'n', expr: 'rowNumber()' }]);
    const gone = withOverfitFallback(rules, overfitFindings(rules, { table: null }));
    expect(gone.transform.computed.map((c) => c.id)).toEqual([]);
    const kept = { ...rules, output: { ...rules.output, columns: [...rules.output.columns, { header: 'Line', from: 'n' }] } };
    const fallback = withOverfitFallback(kept, overfitFindings(kept, { table: null }));
    expect(fallback.transform.computed.map((c) => c.id)).toEqual(['n']);
    expect(fallback.output.columns.map((c) => c.from)).toEqual(['customer', null, 'n']);
  });
});
