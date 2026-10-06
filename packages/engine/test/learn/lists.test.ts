// A list of fixed values (docs/proposals/saved-format-contents.md section 3; `copiedLists`, `learn/oneTimers.ts`): an output column whose value
// comes from a lookup, a value map or a chain of cases with fixed values keyed on an input column - whatever the shape, whether the key repeats
// or not - is a list: nobody can deduce it, and a saved format would keep it. NOT a list: a small vocabulary (at most 12 entries, each giving
// its value to at least 2 rows, keyed on a column that is not an identifier), and fewer than 6 entries (the one-time questions' ground).
import { describe, expect, it } from 'vitest';
import { limits, type Expr, type LearnResult } from '@formatai/shared';
import { fillParams } from '../../src/learn/fillParams';
import { copiedLists, listRetryProblems, oneTimeQuestions } from '../../src/learn/oneTimers';
import { inputMaskType } from '../../src/learn/maskTypes';
import { verifyAgainstExample } from '../../src/learn/verify';
import { parseFormula } from '../../src/formula';
import type { PairAnalysis } from '../../src/learn/analyze';
import { analyzeOk, xlsx, type V } from './analyze/helpers';

const f = (text: string): Expr => {
  const parsed = parseFormula(text, { allowWindows: true });
  if (!parsed.ok) throw new Error(`${text}: ${parsed.error.message}`);
  return parsed.expr;
};

const CATEGORIES = ['Electronics', 'Clothes', 'Garden', 'Toys', 'Books'];
/** A product's category: fixed per product, from no rule (a scrambled pick). */
const category = (p: number): string => CATEGORIES[(p * 7 + 3) % CATEGORIES.length]!;
const code = (p: number): string => `P-${String(p + 1).padStart(3, '0')}`;

/**
 * Orders of products: `uses[p]` rows of product p (an order number unique per row, the product code, a quantity), and the output its category.
 * `key` says how the product is written: a text code ("P-001"), or an account-like number with its zeros ("000101": an ID column).
 */
function catalog(uses: readonly number[], key: 'code' | 'zeros' = 'code'): { analysis: PairAnalysis; keyOf: (p: number) => string } {
  const keyOf = (p: number): string => (key === 'code' ? code(p) : String(101 + p).padStart(6, '0'));
  const input: V[][] = [['Order', 'Product', 'Qty']];
  const output: V[][] = [['Order', 'Product', 'Category']];
  let n = 0;
  uses.forEach((times, p) => {
    for (let t = 0; t < times; t++) {
      n++;
      input.push([`ORD-${1000 + n}`, keyOf(p), (n % 9) + 1]);
      output.push([`ORD-${1000 + n}`, keyOf(p), category(p)]);
    }
  });
  return { analysis: analyzeOk(xlsx(input), xlsx(output)), keyOf };
}

function rules(categoryExpr: string, extra: Partial<LearnResult['transform']> = {}): LearnResult {
  return {
    schemaVersion: 1,
    input: {
      sheet: { pick: 'first' },
      headerRow: 'auto',
      columns: [
        { id: 'order', header: 'Order', type: 'text' },
        { id: 'product', header: 'Product', type: 'text' },
        { id: 'qty', header: 'Qty', type: 'integer' },
      ],
    },
    transform: { computed: [{ id: 'category', type: 'text', expr: f(categoryExpr) }], valueMaps: [], sort: [], tables: [{ name: 'categories', columns: ['product', 'category'], rows: [] }], ...extra },
    output: {
      sheetName: 'Sheet1',
      direction: 'ltr',
      language: 'en',
      titleRows: [],
      columns: [
        { header: 'Order', from: 'order' },
        { header: 'Product', from: 'product' },
        { header: 'Category', from: 'category' },
      ],
    },
    validations: [],
    unsupported: [],
    assumptions: [],
  };
}

/** The AI's lookup by product, filled by code from every row (as the flow does before it asks). */
const lookupRules = (analysis: PairAnalysis): LearnResult => fillParams(rules('lookup("categories", product, "category")'), analysis).rules;
const LOOKUP = { kind: 'lookup', computed: 'category', table: 'categories' } as const;
const times = (n: number, k: number): number[] => Array.from({ length: n }, () => k);

describe('the shapes of a list', () => {
  it('a lookup whose key repeats (a catalog: 20 products, 2 orders each) is a list - the copied list of #55 is only one case of it', () => {
    const { analysis } = catalog(times(20, 2));
    const r = lookupRules(analysis);
    expect(verifyAgainstExample(r, analysis).verified).toBe(true);
    expect(copiedLists(r, analysis)).toEqual([{ kind: 'copiedList', out: 2, header: 'Category', keyColumn: 'Product', entries: 20, list: LOOKUP }]);
    // One question for the column; its entries are no one-row parts of their own.
    expect(oneTimeQuestions(r, analysis).questions.map((q) => q.kind)).toEqual(['copiedList']);
  });

  it('a value map on the key column is the same list', () => {
    // The output shows the category where the product was: the value map turns each code into its category.
    const input: V[][] = [['Order', 'Product', 'Qty']];
    const output: V[][] = [['Order', 'Category']];
    let n = 0;
    for (let p = 0; p < 20; p++) {
      for (let t = 0; t < 2; t++) {
        n++;
        input.push([`ORD-${1000 + n}`, code(p), 1]);
        output.push([`ORD-${1000 + n}`, category(p)]);
      }
    }
    const analysis = analyzeOk(xlsx(input), xlsx(output));
    const map = Object.fromEntries(Array.from({ length: 20 }, (_, p) => [code(p), category(p)]));
    const base = rules('product', { computed: [], tables: [], valueMaps: [{ column: 'product', map, onMissing: 'flag' }] });
    const r: LearnResult = { ...base, output: { ...base.output, columns: [{ header: 'Order', from: 'order' }, { header: 'Category', from: 'product' }] } };
    expect(verifyAgainstExample(r, analysis).verified).toBe(true);
    expect(copiedLists(r, analysis)).toEqual([{ kind: 'copiedList', out: 1, header: 'Category', keyColumn: 'Product', entries: 20, list: { kind: 'valueMap', column: 'product' } }]);
  });

  it('a chain of cases grouped by label (oneOf groups) and one value per case are the same list written out', () => {
    const { analysis, keyOf } = catalog(times(20, 2));
    const groups = CATEGORIES.map((c) => Array.from({ length: 20 }, (_, p) => p).filter((p) => category(p) === c));
    const last = groups.pop()!;
    const byLabel = `switch(${groups.map((g, i) => `oneOf(product, ${g.map((p) => `"${keyOf(p)}"`).join(', ')}), "${CATEGORIES[i]}"`).join(', ')}, "${category(last[0]!)}")`;
    const grouped = rules(byLabel);
    expect(verifyAgainstExample(grouped, analysis).verified).toBe(true);
    const named = 20 - last.length;
    expect(copiedLists(grouped, analysis)).toEqual([{ kind: 'copiedList', out: 2, header: 'Category', keyColumn: 'Product', entries: named, list: { kind: 'cases', computed: 'category', column: 'product' } }]);
    const onePerCase = `switch(${Array.from({ length: 19 }, (_, p) => `product = "${keyOf(p)}", "${category(p)}"`).join(', ')}, "${category(19)}")`;
    expect(copiedLists(rules(onePerCase), analysis).map((q) => [q.entries, q.list.kind])).toEqual([[19, 'cases']]);
  });

  it('NOT logic: a chain whose cases are conditions on an amount, a constant label for rows a range picks, a rule in the else', () => {
    const { analysis } = catalog(times(20, 2));
    expect(copiedLists(rules('if(qty > 5, "Bulk", "Single")'), analysis)).toEqual([]);
    expect(copiedLists(rules('switch(qty < 3, "A", qty < 6, "B", "C")'), analysis)).toEqual([]);
    const withRule = `switch(${Array.from({ length: 8 }, (_, p) => `product = "${code(p)}", "${category(p)}"`).join(', ')}, upper(product))`;
    expect(copiedLists(rules(withRule), analysis)).toEqual([]);
  });
});

describe('a small vocabulary is not a list (at most 12 entries, each used by at least 2 rows, not keyed on an identifier)', () => {
  it('12 entries of 2 rows each: silent; 13: a list', () => {
    expect(limits.learn.lists).toEqual({ minEntries: 6, vocabulary: { maxEntries: 12, minRowsPerEntry: 2 } });
    const twelve = catalog(times(12, 2)).analysis;
    expect(copiedLists(lookupRules(twelve), twelve)).toEqual([]);
    const thirteen = catalog(times(13, 2)).analysis;
    expect(copiedLists(lookupRules(thirteen), thirteen).map((q) => q.entries)).toEqual([13]);
  });

  it('12 entries with one used by a single row: a list', () => {
    const { analysis } = catalog([...times(11, 2), 1]);
    expect(copiedLists(lookupRules(analysis), analysis).map((q) => q.entries)).toEqual([12]);
  });

  it('keyed on an identifier column (#56: digit codes with their zeros), 8 entries of 3 rows each: a list', () => {
    const ids = catalog(times(8, 3), 'zeros');
    expect(inputMaskType(ids.analysis, 1)).toBe('idLike');
    expect(copiedLists(lookupRules(ids.analysis), ids.analysis).map((q) => [q.keyColumn, q.entries])).toEqual([['Product', 8]]);
    // The same 8 entries keyed on a text code: a vocabulary.
    const codes = catalog(times(8, 3));
    expect(inputMaskType(codes.analysis, 1)).toBe('text');
    expect(copiedLists(lookupRules(codes.analysis), codes.analysis)).toEqual([]);
  });

  it('fewer than 6 entries is never a list, whatever its rows (the one-time questions stay as they are)', () => {
    const { analysis } = catalog([1, 1, 1, 1, 1]);
    expect(copiedLists(lookupRules(analysis), analysis)).toEqual([]);
    const six = catalog(times(6, 1)).analysis;
    expect(copiedLists(lookupRules(six), six).map((q) => q.entries)).toEqual([6]);
  });
});

describe('listRetryProblems: the one round\'s message', () => {
  it('names the column, the count and the key column - no value', () => {
    const { analysis } = catalog(times(20, 2));
    const r = lookupRules(analysis);
    const problems = listRetryProblems(copiedLists(r, analysis), r);
    expect(problems).toEqual([
      {
        kind: 'list',
        out: 2,
        message:
          'Column "Category" is a list of 20 fixed values, one per Product. Find the rule behind it from the other columns. Only if no rule exists - the value depends on each Product itself, or comes from outside the file - keep the list.',
      },
    ]);
    const text = JSON.stringify(problems);
    for (const c of CATEGORIES) expect(text).not.toContain(c);
    expect(text).not.toContain('P-0');
  });
});
