// A one-time edit or a rule? where the browser judges (SPEC 21 v12 item 20): `learnFromExamples` returns, with an AI answer, the parts of the
// kept rules that explain one row of the example only (`oneTimers`), for the Result screen to ask about - and a row-position branch that is
// such a part is the user's question, not the overfitting guard's repair. More single-row parts than are asked stay the guard's. On the real
// eval case discount-hand-edited (rows 54, 99 and 133 edited by hand).
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { LearnPayload, LearnResult, RepairProblem, Rules } from '@formatai/shared';
import { learnFromExamples, type LearnCallResult } from '../../src/learn/flow';
import { learnResultOf } from '../../src/learn/complete';
import { parseFormula } from '../../src/formula';

const DIR = path.resolve(__dirname, '../../../../eval/cases/discount-hand-edited');
const file = (name: string): { bytes: Uint8Array; name: string } => ({ bytes: new Uint8Array(fs.readFileSync(path.join(DIR, name))), name });
const reference = learnResultOf(JSON.parse(fs.readFileSync(path.join(DIR, 'reference.rules.json'), 'utf8')) as Rules);

function discountAnswer(formula: string): LearnResult {
  const parsed = parseFormula(formula, { allowWindows: true });
  if (!parsed.ok) throw new Error(parsed.error.message);
  return { ...reference, transform: { ...reference.transform, computed: reference.transform.computed.map((c) => (c.id === 'discount' ? { ...c, expr: parsed.expr } : c)) } };
}

/** The AI step: `first`, then `repairs` in order (the last one again); every round's problems are kept. */
function aiStep(first: LearnResult, repairs: LearnResult[]) {
  const rounds: RepairProblem[][] = [];
  return {
    rounds,
    callLearn: async (_payload: LearnPayload): Promise<LearnCallResult> => ({ rules: first, problems: [], calls: ['learn'] }),
    callRepair: async (_payload: LearnPayload, _previous: LearnResult, problems: RepairProblem[]): Promise<LearnCallResult> => {
      rounds.push(problems);
      return { rules: repairs[Math.min(rounds.length - 1, repairs.length - 1)]!, problems: [], calls: [`repair${rounds.length}`] };
    },
  };
}

const run = (ai: ReturnType<typeof aiStep>) => learnFromExamples({ input: file('input.xlsx'), output: file('output.xlsx'), masking: false, tier: 'paid', callLearn: ai.callLearn, callRepair: ai.callRepair });

const TENTH = 'round(amount * 0.1, 2)';

describe('discount-hand-edited: a part that explains one row is a question', () => {
  it('the row-position branch for row 54: no overfit repair, the rule kept as it is, and the question with the row\'s values', async () => {
    const answer = discountAnswer(`if(rowNumber() = 53, 0, ${TENTH})`);
    const ai = aiStep(answer, [answer]);
    const result = await run(ai);
    // The loop still sends the two rows the rule gets wrong (99, 133), but never an overfit problem.
    expect(ai.rounds.length).toBeGreaterThan(0);
    expect(ai.rounds.flat().some((p) => p.kind === 'overfit')).toBe(false);
    expect(result.unsupported).toEqual([]);
    expect(result.rules?.transform.computed.find((c) => c.id === 'discount')?.expr).toEqual(answer.transform.computed[0]!.expr);
    expect(result.oneTimers?.questions.map((q) => [q.header, q.row, q.by, q.value, q.rest])).toEqual([['Discount', 54, 'position', 0, 252.61]]);
    expect(result.oneTimers?.questions[0]?.check).toMatchObject({ column: 'discount', rule: 'sameAs', oneTime: true });
  });

  it('an answer that names all three rows by Order ID: verified on the first call, three questions (the most a learn asks)', async () => {
    const answer = discountAnswer(`switch(orderId = "ORD-03053", 0, orderId = "ORD-03098", 170.02, orderId = "ORD-03132", 25, ${TENTH})`);
    const result = await run(aiStep(answer, [answer]));
    expect(result.stages.verifiedFirstCall).toBe(true);
    expect(result.oneTimers).toEqual({ questions: expect.any(Array), handedOff: [] });
    expect(result.oneTimers!.questions.map((q) => [q.row, q.by, q.byColumn])).toEqual([
      [54, 'id', 'Order ID'],
      [99, 'id', 'Order ID'],
      [133, 'id', 'Order ID'],
    ]);
  });

  it('four row-position branches (more than are asked): handed to the guard - one repair, then "needs your input"; no question', async () => {
    const answer = discountAnswer(`switch(rowNumber() = 53, 0, rowNumber() = 98, 170.02, rowNumber() = 132, 25, rowNumber() = 1, 130.9, ${TENTH})`);
    const ai = aiStep(answer, [answer]);
    const result = await run(ai);
    expect(ai.rounds[0]!.filter((p) => p.kind === 'overfit')).toHaveLength(1);
    expect(result.unsupported).toEqual([{ outputColumn: 'Discount', reasonCode: 'overfit' }]);
    expect(result.oneTimers).toBeUndefined();
  });

  it('the honest rule (the three rows wrong) asks nothing: the rows go to the "rows that don\'t follow" panel as before', async () => {
    const result = await run(aiStep(reference, [reference]));
    expect(result.oneTimers).toBeUndefined();
    expect(result.verification?.verified).toBe(false);
  });
});
