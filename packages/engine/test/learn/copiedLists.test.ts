// A list copied from the example is a question (owner amendment, 2026-10-06; `copiedLists`, `learn/oneTimers.ts`): a column whose lookup
// table or value map is keyed on a column that is different on every row the list applies to - code's fill completes it from every row, and
// it reproduces the example by construction, so the check on every row cannot tell a real mapping from a copy. "Owner: is this the rule?"
// Never for a key that repeats (a real mapping the example shows more than once), fewer than 6 entries, an amount (the guards'), or a list of
// the user's own rules (completion). The answers: "a rule" keeps the list (a new key is flagged at run time, as before); "a one-time edit"
// takes the column's rule out (`withoutCopiedList`, shared): "needs your input", its table gone, the rest verified.
import { describe, expect, it } from 'vitest';
import { columnsWithRule, withoutCopiedList, type Expr, type LearnResult } from '@formatai/shared';
import { fillParams } from '../../src/learn/fillParams';
import { copiedLists, oneTimeQuestions, type CopiedListQuestion } from '../../src/learn/oneTimers';
import { overfitFindings } from '../../src/learn/overfit';
import { verifyAgainstExample } from '../../src/learn/verify';
import { parseFormula } from '../../src/formula';
import { runRules } from '../../src/pipeline/runRules';
import type { InputTable } from '../../src/types';
import { analyzeOk, cell, xlsx, type V } from './analyze/helpers';

const f = (text: string): Expr => {
  const parsed = parseFormula(text, { allowWindows: true });
  if (!parsed.ok) throw new Error(`${text}: ${parsed.error.message}`);
  return parsed.expr;
};

// ---------------------------------------------------------------------------
// 24 accounts of 8 companies (3 each). Owner is one per company (a real mapping, its key repeats); Manager is drawn per row from 5 names
// that appear nowhere in the input (two accounts of one company have different managers).
// ---------------------------------------------------------------------------

const N = 24;
const COMPANIES = ['Acme', 'Globex', 'Initech', 'Umbrella', 'Hooli', 'Vandelay', 'Soylent', 'Wonka'];
const OWNERS = ['Ava', 'Ben', 'Cleo', 'Dan', 'Eli', 'Fay', 'Gus', 'Hana'];
const MANAGERS = ['Priya', 'Tobias', 'Amara', 'Mateo', 'Ingrid'];
const account = (i: number): string => `ACC-${1001 + i}`;
const company = (i: number): string => COMPANIES[i % 8]!;
const fee = (i: number): number => 100 + i * 7.5;
const manager = (i: number): string => MANAGERS[(i * 7 + 3) % 5]!;

function accountsPair(): { input: V[][]; output: V[][] } {
  const input: V[][] = [['Account', 'Company', 'Fee']];
  const output: V[][] = [['Account', 'Company', 'Owner', 'Manager']];
  for (let i = 0; i < N; i++) {
    input.push([account(i), company(i), fee(i)]);
    output.push([account(i), company(i), OWNERS[i % 8]!, manager(i)]);
  }
  return { input, output };
}
const PAIR = accountsPair();
const ACCOUNTS = analyzeOk(xlsx(PAIR.input), xlsx(PAIR.output));

/** The AI's answer: Owner and Manager looked up, each table with the two rows the sample showed (code's fill completes them). */
function accountsRules(managerExpr = 'lookup("managers", account, "manager")'): LearnResult {
  return {
    schemaVersion: 1,
    input: {
      sheet: { pick: 'first' },
      headerRow: 'auto',
      columns: [
        { id: 'account', header: 'Account', type: 'text' },
        { id: 'company', header: 'Company', type: 'text' },
        { id: 'fee', header: 'Fee', type: 'decimal' },
      ],
    },
    transform: {
      computed: [
        { id: 'owner', type: 'text', expr: f('lookup("owners", company, "owner")') },
        { id: 'manager', type: 'text', expr: f(managerExpr) },
      ],
      valueMaps: [],
      sort: [],
      tables: [
        { name: 'owners', columns: ['company', 'owner'], rows: [[company(0), OWNERS[0]!], [company(1), OWNERS[1]!]] },
        { name: 'managers', columns: ['account', 'manager'], rows: [[account(0), manager(0)], [account(1), manager(1)]] },
      ],
    },
    output: {
      sheetName: 'Sheet1',
      direction: 'ltr',
      language: 'en',
      titleRows: [],
      columns: [
        { header: 'Account', from: 'account' },
        { header: 'Company', from: 'company' },
        { header: 'Owner', from: 'owner' },
        { header: 'Manager', from: 'manager' },
      ],
    },
    validations: [],
    unsupported: [],
    assumptions: [],
  };
}

/** The answer as applied: code's fill completes both tables from every row (the flow does this before it asks). */
const filled = (r: LearnResult): LearnResult => fillParams(r, ACCOUNTS).rules;

const MANAGER_LIST: CopiedListQuestion = {
  kind: 'copiedList',
  out: 3,
  header: 'Manager',
  keyColumn: 'Account',
  entries: N,
  list: { kind: 'lookup', computed: 'manager', table: 'managers' },
};

describe('when a copied list is asked about', () => {
  it('a lookup keyed on a column that is different on every row, filled from every row: one question, no cell value, no one-row parts of its own', () => {
    const rules = filled(accountsRules());
    expect(rules.transform.tables?.find((t) => t.name === 'managers')?.rows).toHaveLength(N);
    expect(verifyAgainstExample(rules, ACCOUNTS).verified).toBe(true);
    // (Without the question its 24 entries are 24 one-row parts singled out by the account: handed off whole, and kept by every guard.)
    expect(overfitFindings(rules, { table: null })).toEqual([]);
    expect(oneTimeQuestions(rules, ACCOUNTS)).toEqual({ questions: [MANAGER_LIST], handedOff: [] });
  });

  it('NOT a lookup whose key repeats: Owner is one per company, shown three times each (a real mapping)', () => {
    const rules = filled(accountsRules());
    expect(rules.transform.tables?.find((t) => t.name === 'owners')?.rows).toHaveLength(8);
    expect(copiedLists(rules, ACCOUNTS).map((q) => q.header)).toEqual(['Manager']);
  });

  it('a value map on the key column is the same question', () => {
    const output: V[][] = PAIR.output.map((r) => [r[0]!, r[3]!]);
    output[0] = ['Ref', 'Manager'];
    const pair = analyzeOk(xlsx(PAIR.input), xlsx(output));
    const base = accountsRules();
    const map = Object.fromEntries(Array.from({ length: N }, (_, i) => [account(i), manager(i)]));
    const rules: LearnResult = {
      ...base,
      transform: { computed: [{ id: 'ref', type: 'text', expr: f('account') }], valueMaps: [{ column: 'account', map, onMissing: 'flag' }], sort: [] },
      output: { ...base.output, columns: [{ header: 'Ref', from: 'ref' }, { header: 'Manager', from: 'account' }] },
    };
    expect(verifyAgainstExample(rules, pair).verified).toBe(true);
    expect(copiedLists(rules, pair)).toEqual([{ kind: 'copiedList', out: 1, header: 'Manager', keyColumn: 'Account', entries: N, list: { kind: 'valueMap', column: 'account' } }]);
  });

  it('from 6 entries (the case list\'s threshold): a lookup the example applies to 5 rows is no question, to 6 rows it is', () => {
    // fee(0..4) < 135 <= fee(5) < 140: the branch takes 5 rows, then 6 (code fills the table from the rows where it is taken).
    const five = filled(accountsRules('if(fee < 135, lookup("managers", account, "manager"), "Team")'));
    expect(five.transform.tables?.find((t) => t.name === 'managers')?.rows).toHaveLength(5);
    expect(copiedLists(five, ACCOUNTS)).toEqual([]);
    const six = filled(accountsRules('if(fee < 140, lookup("managers", account, "manager"), "Team")'));
    expect(copiedLists(six, ACCOUNTS)).toEqual([{ ...MANAGER_LIST, entries: 6 }]);
    // The threshold is an option (default limits.learn.overfit.minCases).
    expect(copiedLists(filled(accountsRules()), ACCOUNTS, { minListEntries: N + 1 })).toEqual([]);
  });

  it('NOT a key that is an amount (the guards\' measureKey: one repair, then "needs your input")', () => {
    const rules = filled(accountsRules('lookup("managers", fee, "manager")'));
    expect(copiedLists(rules, ACCOUNTS)).toEqual([]);
    expect(overfitFindings(rules, { table: null }).map((x) => [x.kind, x.outputColumn])).toEqual([['measureKey', 'Manager']]);
  });

  it('completion mode: only the columns the AI step was asked for, and never a lookup of the user\'s own rules', () => {
    const rules = filled(accountsRules());
    expect(copiedLists(rules, ACCOUNTS, { columns: new Set(['Owner']) })).toEqual([]);
    expect(copiedLists(rules, ACCOUNTS, { columns: new Set(['Manager']) })).toEqual([MANAGER_LIST]);
    // The user's own table (the AI step's column looks it up), or their own computed column: theirs, not asked.
    const mine = accountsRules();
    const theirTable: LearnResult = { ...mine, transform: { ...mine.transform, computed: [mine.transform.computed[0]!], tables: [mine.transform.tables![1]!] } };
    expect(copiedLists(rules, ACCOUNTS, { columns: new Set(['Manager']), fixed: theirTable })).toEqual([]);
    const theirColumn: LearnResult = { ...mine, transform: { ...mine.transform, computed: [mine.transform.computed[1]!], tables: [] } };
    expect(copiedLists(rules, ACCOUNTS, { columns: new Set(['Manager']), fixed: theirColumn })).toEqual([]);
    // Their rules with neither: asked.
    const neither: LearnResult = { ...mine, transform: { ...mine.transform, computed: [mine.transform.computed[0]!], tables: [mine.transform.tables![0]!] } };
    expect(copiedLists(rules, ACCOUNTS, { columns: new Set(['Manager']), fixed: neither })).toEqual([MANAGER_LIST]);
  });
});

describe('the answers', () => {
  const next = (accounts: string[]): InputTable => ({
    sheetName: 'Sheet1',
    direction: 'ltr',
    headers: ['Account', 'Company', 'Fee'],
    rows: accounts.map((a, i) => [a, company(i), fee(i)].map((v) => cell(v as V))),
    rowNumbers: accounts.map((_, i) => i + 2),
  });

  it('"a one-time edit": the column needs your input (unsupported, overfit) and is left empty, its table goes, the rest is verified; nothing is asked again', () => {
    const rules = filled(accountsRules());
    const [q] = oneTimeQuestions(rules, ACCOUNTS).questions as CopiedListQuestion[];
    const answered = withoutCopiedList(rules, q!.header, q!.list)!;
    expect(answered.output.columns.find((c) => c.header === 'Manager')).toEqual({ header: 'Manager', from: null });
    expect(answered.unsupported).toEqual([{ outputColumn: 'Manager', reasonCode: 'overfit' }]);
    expect(answered.transform.computed.map((c) => c.id)).toEqual(['owner']);
    expect(answered.transform.tables?.map((t) => t.name)).toEqual(['owners']);
    expect(verifyAgainstExample(answered, ACCOUNTS, { onlyColumns: columnsWithRule(answered) }).verified).toBe(true);
    expect(oneTimeQuestions(answered, ACCOUNTS)).toEqual({ questions: [], handedOff: [] });
    // Next month: the column is empty, and nothing is flagged for it.
    const run = runRules(answered, next(['ACC-2001', account(0)]));
    if (!run.ok) throw new Error('run failed');
    expect(run.sheet.rows.filter((r) => r.kind === 'data').map((r) => r.cells[3]?.v ?? null)).toEqual([null, null]);
    expect(run.flags).toEqual([]);
    // Answered once, the list is not there any more.
    expect(withoutCopiedList(answered, q!.header, q!.list)).toBeNull();
  });

  it('"a rule": the list stays as it is - a known account gets its manager next month, a new one is flagged, as for any lookup', () => {
    const rules = filled(accountsRules());
    const run = runRules(rules, next(['ACC-2001', account(5)]));
    if (!run.ok) throw new Error('run failed');
    expect(run.sheet.rows.filter((r) => r.kind === 'data').map((r) => r.cells[3]?.v ?? null)).toEqual([null, manager(5)]);
    expect(run.flags.map((x) => [x.rowNumber, x.messageKey])).toEqual([[2, 'flag.lookupMissing']]);
  });
});
