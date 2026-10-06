// A list copied from the example is a question, where the browser judges (owner amendment, 2026-10-06): on the real eval case
// external-agent-column (Account Manager is one of 8 names drawn at random per row, from nowhere in the input), the answer both prompt
// versions wrote in the end-to-end run of 2026-10-06 - `lookup("accountManagers", account, "manager")` - is filled by code from all 40 rows
// and verified, because a copied list always reproduces the example it was copied from. `learnFromExamples` now returns the question with it.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { columnsWithRule, withoutCopiedList, type LearnResult } from '@formatai/shared';
import { learnFromExamples, type LearnCallResult } from '../../src/learn/flow';
import { verifyAgainstExample } from '../../src/learn/verify';
import type { PairAnalysis } from '../../src/learn/analyze';
import type { CopiedListQuestion } from '../../src/learn/oneTimers';

const DIR = path.resolve(__dirname, '../../../../eval/cases/external-agent-column');
const file = (name: string): { bytes: Uint8Array; name: string } => ({ bytes: new Uint8Array(fs.readFileSync(path.join(DIR, name))), name });

/** The five copies, and Account Manager looked up by Account in a table the AI step left for code to fill. */
const answer: LearnResult = {
  schemaVersion: 1,
  input: {
    sheet: { pick: 'first' },
    headerRow: 'auto',
    columns: [
      { id: 'account', header: 'Account', type: 'idLike' },
      { id: 'company', header: 'Company', type: 'text' },
      { id: 'region', header: 'Region', type: 'text' },
      { id: 'plan', header: 'Plan', type: 'text' },
      { id: 'monthlyFee', header: 'Monthly Fee', type: 'integer' },
    ],
  },
  transform: {
    computed: [{ id: 'accountManager', type: 'text', expr: { op: 'lookup', table: 'accountManagers', key: { col: 'account' }, return: 'manager', onMissing: 'flag' } }],
    valueMaps: [],
    sort: [],
    tables: [{ name: 'accountManagers', columns: ['account', 'manager'], rows: [] }],
  },
  output: {
    sheetName: 'Accounts with manager',
    direction: 'ltr',
    language: 'en',
    titleRows: [],
    columns: [
      { header: 'Account', from: 'account' },
      { header: 'Company', from: 'company' },
      { header: 'Region', from: 'region' },
      { header: 'Plan', from: 'plan' },
      { header: 'Monthly Fee', from: 'monthlyFee' },
      { header: 'Account Manager', from: 'accountManager' },
    ],
  },
  validations: [],
  unsupported: [],
  assumptions: [],
};

const ai = {
  callLearn: async (): Promise<LearnCallResult> => ({ rules: answer, problems: [], calls: ['learn'] }),
  callRepair: async (): Promise<LearnCallResult> => ({ rules: answer, problems: [], calls: ['repair'] }),
};

describe('external-agent-column: a lookup of the 40 accounts', () => {
  it('is filled from every row and verified - and asked about: "Account Manager: is this the rule?"', async () => {
    let analysis: PairAnalysis | undefined;
    const result = await learnFromExamples({ input: file('input.xlsx'), output: file('output.xlsx'), masking: false, tier: 'paid', ...ai, onAnalysis: (a) => (analysis = a) });
    expect(result.stages.verifiedFirstCall).toBe(true);
    expect(result.filled?.filled).toEqual([{ kind: 'lookup', count: 40 }]);
    // No guard finds it (an account is no amount), and its 40 entries are no one-row questions of their own.
    expect(result.unsupported).toEqual([]);
    expect(result.oneTimers).toEqual({
      questions: [{ kind: 'copiedList', out: 5, header: 'Account Manager', keyColumn: 'Account', entries: 40, list: { kind: 'lookup', computed: 'accountManager', table: 'accountManagers' } }],
      handedOff: [],
    });

    // "A one-time edit": Account Manager needs your input, the five copies are verified on every row.
    const q = result.oneTimers!.questions[0] as CopiedListQuestion;
    const answered = withoutCopiedList(result.rules!, q.header, q.list)!;
    expect(answered.unsupported).toEqual([{ outputColumn: 'Account Manager', reasonCode: 'overfit' }]);
    expect([answered.transform.computed, answered.transform.tables]).toEqual([[], []]);
    expect(verifyAgainstExample(answered, analysis!, { onlyColumns: columnsWithRule(answered) }).verified).toBe(true);
  });

  it('completion mode: asked when Account Manager is the column the AI step was asked for; never about the user\'s own columns', async () => {
    const fixedRules: LearnResult = {
      ...answer,
      transform: { ...answer.transform, computed: [], tables: [] },
      output: { ...answer.output, columns: answer.output.columns.map((c) => (c.header === 'Account Manager' ? { ...c, from: null } : c)) },
    };
    const result = await learnFromExamples({
      input: file('input.xlsx'),
      output: file('output.xlsx'),
      masking: false,
      tier: 'paid',
      ...ai,
      complete: { fixedRules, columns: [5], parts: [] },
    });
    expect(result.completion).toMatchObject({ fixedProblems: [], matches: true });
    expect(result.oneTimers?.questions.map((x) => [x.kind, x.header])).toEqual([['copiedList', 'Account Manager']]);
  });
});
