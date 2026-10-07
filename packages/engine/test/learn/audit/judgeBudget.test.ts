// Engine audit (2026-10-07), fix 12: code's work on an AI answer - the fill from every row, the guards, the full verification - runs the
// rules on every row of the example, round after round, at up to 100,000 rows on the paid tier, with no bound. Now each judged answer has
// a time budget (`limits.learn.judge.timeBudgetMs`, read between steps): past it the fill stops, and the learn ends with the best answer
// so far (`timeBudget`, loop end `timeBudget`) - verified only when every row matches.
import type { Expr, LearnResult } from '@formatai/shared';
import { limits } from '@formatai/shared';
import { describe, expect, it } from 'vitest';
import { parseFormula } from '../../../src/formula';
import { fillParams } from '../../../src/learn/fillParams';
import { learnFromExamples, type LearnCallResult } from '../../../src/learn/flow';
import { analyzeOk, xlsx, type V } from '../analyze/helpers';
import { xlsxBytesOf } from '../v5fixtures';

const f = (text: string): Expr => {
  const p = parseFormula(text, { allowWindows: true });
  if (!p.ok) throw new Error(`${text}: ${p.error.message}`);
  return p.expr;
};

const COMPANIES = ['Acme', 'Globex', 'Initech', 'Umbrella', 'Hooli', 'Vandelay', 'Soylent', 'Wonka'];
const OWNERS = ['Ava', 'Ben', 'Cleo', 'Dan', 'Eli', 'Fay', 'Gus', 'Hana'];
const N = 24;
const input: V[][] = [['Account', 'Company'], ...Array.from({ length: N }, (_, i) => [`ACC-${1001 + i}`, COMPANIES[i % 8]!])];
// (Desk: values from nowhere in the input - the AI step reports it unsupported; it keeps the fast path from finishing the learn.)
const output: V[][] = [['Account', 'Owner', 'Desk'], ...Array.from({ length: N }, (_, i) => [`ACC-${1001 + i}`, OWNERS[i % 8]!, `D${(i * 37) % 97}`])];

/** The AI's answer: Owner looked up by company, with the two rows its samples showed - code's fill completes the table from every row. */
const ANSWER: LearnResult = {
  schemaVersion: 1,
  input: { sheet: { pick: 'first' }, headerRow: 'auto', columns: [{ id: 'account', header: 'Account', type: 'text' }, { id: 'company', header: 'Company', type: 'text' }] },
  transform: {
    computed: [{ id: 'owner', type: 'text', expr: f('lookup("owners", company, "owner")') }],
    valueMaps: [],
    sort: [],
    tables: [{ name: 'owners', columns: ['company', 'owner'], rows: [[COMPANIES[0]!, OWNERS[0]!], [COMPANIES[1]!, OWNERS[1]!]] }],
  },
  output: { sheetName: 'Sheet1', direction: 'ltr', language: 'en', titleRows: [], columns: [{ header: 'Account', from: 'account' }, { header: 'Owner', from: 'owner' }, { header: 'Desk', from: null }] },
  validations: [],
  unsupported: [{ outputColumn: 'Desk', reasonCode: 'externalData' }],
  assumptions: [],
};

async function learn(over: { judgeBudgetMs?: number; now?: () => number }) {
  const repairs: number[] = [];
  const r = await learnFromExamples({
    input: { bytes: await xlsxBytesOf(input), name: 'in.xlsx' },
    output: { bytes: await xlsxBytesOf(output), name: 'out.xlsx' },
    masking: false,
    tier: 'paid',
    callLearn: async (): Promise<LearnCallResult> => ({ rules: ANSWER, problems: [], calls: [] }),
    callRepair: async (_p, _prev, problems): Promise<LearnCallResult> => {
      repairs.push(problems.length);
      return { rules: ANSWER, problems: [], calls: [] };
    },
    ...over,
  });
  return { r, repairs };
}

describe('the time budget of one judged answer', () => {
  it('the setting', () => {
    expect(limits.learn.judge.timeBudgetMs).toBe(20_000);
  });

  it('fillParams: past its deadline nothing more is filled, and it says so', () => {
    const a = analyzeOk(xlsx(input), xlsx(output));
    const full = fillParams(ANSWER, a);
    expect(full.filled).toEqual([{ kind: 'lookup', count: 6 }]);
    expect(full.stopped).toBeUndefined();
    let t = 0;
    const cut = fillParams(ANSWER, a, { deadline: 10, now: () => (t += 100) });
    expect(cut.stopped).toBe(true);
    expect(cut.filled).toEqual([]);
    expect(cut.rules).toEqual(ANSWER);
  });

  it('within the budget: the table is filled and the learn verifies, as before', async () => {
    const { r, repairs } = await learn({});
    expect(r.stages.verifiedAfterRepair).toBe(true);
    expect(r.timeBudget).toBeUndefined();
    expect(r.loop?.end).toBe('verified');
    expect(repairs).toEqual([]);
  });

  it('past the budget: no repair round, the best answer so far, not verified - and the result says what was skipped', async () => {
    let t = 0;
    const { r, repairs } = await learn({ judgeBudgetMs: 500, now: () => (t += 1000) });
    expect(repairs).toEqual([]); // (without the budget the unfilled table would be sent back for a round)
    expect(r.path).toBe('llm');
    expect(r.rules?.transform.tables?.[0]?.rows).toHaveLength(2); // as the AI wrote it
    expect(r.stages.verifiedAfterRepair).toBe(false);
    expect(r.loop).toEqual({ rounds: 0, rowsSent: 0, end: 'timeBudget' });
    expect(r.timeBudget).toMatchObject({ budgetMs: 500, skipped: ['fill', 'rounds'] });
    expect(r.filled?.stopped).toBe(true);
    expect(r.verification?.verified).toBe(false);
  });

  it('without the budget the same answer gets a round (the control)', async () => {
    // A budget no clock reaches, and a fill that cannot fill (an answer whose table is keyed on the wrong column).
    const wrong: LearnResult = { ...ANSWER, transform: { ...ANSWER.transform, computed: [{ id: 'owner', type: 'text', expr: f('lookup("owners", account, "owner")') }] } };
    const repairs: number[] = [];
    await learnFromExamples({
      input: { bytes: await xlsxBytesOf(input), name: 'in.xlsx' },
      output: { bytes: await xlsxBytesOf(output), name: 'out.xlsx' },
      masking: false,
      tier: 'paid',
      callLearn: async (): Promise<LearnCallResult> => ({ rules: wrong, problems: [], calls: [] }),
      callRepair: async (_p, _prev, problems): Promise<LearnCallResult> => {
        repairs.push(problems.length);
        return { rules: null, problems: [], calls: [] };
      },
    });
    expect(repairs.length).toBeGreaterThan(0);
  });
});
