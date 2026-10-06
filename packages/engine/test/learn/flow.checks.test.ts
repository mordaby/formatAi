// learnFromExamples with AI code checks (learn-v9, docs/proposals/ai-code-checks.md): when the AI step answers with checks, the flow answers
// them on every row (masked, within the row limit) and makes the next step with every round so far, until the rules come - at most
// `limits.learn.checks.maxRounds` rounds. From the rules on nothing changes; without checks nothing changes at all.
import type { Check, CheckRound, LearnPayload, LearnResult, RangesAnswer, RowsAnswer } from '@formatai/shared';
import { limits, payloadRowCount } from '@formatai/shared';
import { describe, expect, it } from 'vitest';
import { learnFromExamples, type LearnCallResult } from '../../src/learn/flow';
import type { LoopRound } from '../../src/learn/loop';
import { classPair, classRules } from './checksFixtures';
import { priorityPair, priorityRules } from './loopFixtures';
import { xlsxBytesOf, type Pair } from './v5fixtures';

async function bytes(pair: Pair) {
  return { input: { bytes: await xlsxBytesOf(pair.input), name: 'in.xlsx' }, output: { bytes: await xlsxBytesOf(pair.output), name: 'out.xlsx' } };
}

const RANGES: Check = { check: 'ranges', column: 'Class', by: 'Total' };

/** The AI step: the first answer asks `first`; each step answers with the next of `steps` (checks, or rules). */
function aiStep(first: Check[], steps: (Check[] | LearnResult)[], extra: Partial<LearnCallResult<string>> = {}) {
  const payloads: LearnPayload[] = [];
  const stepCalls: { payload: LearnPayload; rounds: CheckRound[] }[] = [];
  const repairs: LoopRound[] = [];
  return {
    payloads,
    stepCalls,
    repairs,
    callLearn: async (payload: LearnPayload): Promise<LearnCallResult<string>> => {
      payloads.push(payload);
      return { rules: null, checks: first, problems: [], calls: ['learn'], ...extra };
    },
    callStep: async (payload: LearnPayload, rounds: CheckRound[]): Promise<LearnCallResult<string>> => {
      stepCalls.push({ payload, rounds });
      const next = steps[stepCalls.length - 1];
      const call = `step${stepCalls.length}`;
      if (next === undefined) return { rules: null, problems: [], calls: [call] };
      return Array.isArray(next) ? { rules: null, checks: next, problems: [], calls: [call] } : { rules: next, problems: [], calls: [call] };
    },
    callRepair: async (_p: LearnPayload, previous: LearnResult, _problems: unknown, round: LoopRound): Promise<LearnCallResult<string>> => {
      repairs.push(round);
      return { rules: previous, problems: [], calls: [`repair${repairs.length}`] };
    },
  };
}

describe('learnFromExamples: AI code checks', () => {
  it('checks -> step -> rules: the answers go with the step, then everything runs as before (verified)', async () => {
    const ai = aiStep([RANGES], [classRules()]);
    const r = await learnFromExamples({ ...(await bytes(classPair())), masking: false, tier: 'paid', callLearn: ai.callLearn, callStep: ai.callStep, callRepair: ai.callRepair });
    expect(r.path).toBe('llm');
    expect(r.calls).toEqual(['learn', 'step1']);
    expect(r.verification?.verified).toBe(true);
    expect(r.stages).toMatchObject({ llmCalled: true, verifiedFirstCall: true, verifiedAfterRepair: true });
    expect(r.checks).toEqual({ rounds: 1, asked: 1, rowsShown: 0, dropped: 0, errors: 0 });
    // the step got the learn's own payload and the one round: the checks as asked, code's answers
    expect(ai.stepCalls).toHaveLength(1);
    expect(ai.stepCalls[0]!.payload).toBe(ai.payloads[0]);
    const [round] = ai.stepCalls[0]!.rounds as [CheckRound];
    expect(round.checks).toEqual([RANGES]);
    const answer = round.answers[0] as RangesAnswer;
    expect(answer.clean && answer.runs.map((x) => x.value)).toEqual(['Small', 'Medium', 'Big']);
    expect(round.dropped).toBeUndefined();
  });

  it('every round so far goes with each step; the API\'s dropped lines go with their round', async () => {
    const second: Check[] = [{ check: 'values', column: 'Class' }];
    const ai = aiStep([RANGES], [second, classRules()], { droppedChecks: ['check 5 was not run: at most 4 checks a round'] });
    const r = await learnFromExamples({ ...(await bytes(classPair())), masking: false, tier: 'paid', callLearn: ai.callLearn, callStep: ai.callStep });
    expect(r.calls).toEqual(['learn', 'step1', 'step2']);
    expect(ai.stepCalls.map((s) => s.rounds.length)).toEqual([1, 2]);
    expect(ai.stepCalls[1]!.rounds[0]).toEqual(ai.stepCalls[0]!.rounds[0]);
    expect(ai.stepCalls[0]!.rounds[0]!.dropped).toEqual(['check 5 was not run: at most 4 checks a round']);
    expect(ai.stepCalls[1]!.rounds[1]!.checks).toEqual(second);
    expect(r.checks).toMatchObject({ rounds: 2, asked: 2, dropped: 1 });
    expect(r.verification?.verified).toBe(true);
  });

  it(`stops after ${limits.learn.checks.maxRounds} rounds: an AI step that keeps asking has no rules`, async () => {
    const ai = aiStep([RANGES], [[RANGES], [RANGES], [RANGES], [RANGES]]);
    const r = await learnFromExamples({ ...(await bytes(classPair())), masking: false, tier: 'paid', callLearn: ai.callLearn, callStep: ai.callStep });
    expect(ai.stepCalls).toHaveLength(limits.learn.checks.maxRounds);
    expect(r.path).toBe('llm');
    expect(r.rules).toBeNull();
    expect(r.calls).toEqual(['learn', 'step1', 'step2', 'step3']);
    expect(r.checks?.rounds).toBe(limits.learn.checks.maxRounds);
  });

  it('without callStep a checks answer is no answer (no rules), and nothing is asked', async () => {
    const ai = aiStep([RANGES], [classRules()]);
    const r = await learnFromExamples({ ...(await bytes(classPair())), masking: false, tier: 'paid', callLearn: ai.callLearn });
    expect(r.rules).toBeNull();
    expect(ai.stepCalls).toEqual([]);
    expect(r.checks).toBeUndefined();
  });

  it('without checks, a learn with callStep is exactly the learn without it', async () => {
    const files = await bytes(classPair());
    const rules = classRules({ low: 1200 });
    const callLearn = async (): Promise<LearnCallResult<string>> => ({ rules, problems: [], calls: ['learn'] });
    const callRepair = async (_p: LearnPayload, previous: LearnResult): Promise<LearnCallResult<string>> => ({ rules: previous, problems: [], calls: ['repair'] });
    let stepped = 0;
    const callStep = async (): Promise<LearnCallResult<string>> => {
      stepped++;
      return { rules: null, problems: [], calls: [] };
    };
    const without = await learnFromExamples({ ...files, masking: true, key: new TextEncoder().encode('k'), tier: 'paid', callLearn, callRepair });
    const withStep = await learnFromExamples({ ...files, masking: true, key: new TextEncoder().encode('k'), tier: 'paid', callLearn, callRepair, callStep });
    expect(stepped).toBe(0);
    expect(withStep).toEqual(without);
    expect('checks' in withStep).toBe(false);
  });

  it('masking on: what the step sends is masked like the samples', async () => {
    const pair = classPair();
    const ai = aiStep([{ check: 'dependsOn', column: 'Class', on: ['Customer'] }, { check: 'rows', where: 'in2 > 15', limit: 3 }], [classRules()]);
    const r = await learnFromExamples({ ...(await bytes(pair)), masking: true, key: new TextEncoder().encode('flow-checks'), tier: 'paid', callLearn: ai.callLearn, callStep: ai.callStep });
    expect(r.verification?.verified).toBe(true);
    const sent = JSON.stringify(ai.stepCalls[0]!.rounds);
    for (const real of ['Dana Levi', 'Yossi Cohen', 'Noa Peretz', '"Small"', '"Medium"', '"Big"', 'Bolt']) expect(sent).not.toContain(real);
    expect((ai.stepCalls[0]!.rounds[0]!.answers[1] as RowsAnswer).rows.length).toBe(3);
    // rows the checks showed are counted
    expect(r.checks!.rowsShown).toBeGreaterThan(0);
  });

  it('rows the checks showed count toward the learn\'s row limit, and the learning loop never sends them again', async () => {
    const pair = priorityPair();
    // the checks show 5 open orders; the answer (a wrong cut-off code does not fill) makes the loop run
    const ai = aiStep([{ check: 'rows', where: 'and(in2 = "Open", in3 > 1000, in3 < 8000)', limit: 5 }], [priorityRules(9400, true)]);
    const r = await learnFromExamples({ ...(await bytes(pair)), masking: false, tier: 'paid', callLearn: ai.callLearn, callStep: ai.callStep, callRepair: ai.callRepair });
    const shown = (ai.stepCalls[0]!.rounds[0]!.answers[0] as RowsAnswer).rows.map((row) => row.in[0]);
    expect(shown).toHaveLength(5);
    // (a row the payload already sends is shown again without counting)
    const inSamples = new Set(ai.payloads[0]!.samples.map((sample) => sample.in[0]));
    const fresh = shown.filter((order) => !inSamples.has(order));
    expect(fresh.length).toBeGreaterThan(0);
    expect(r.checks?.rowsShown).toBe(fresh.length);
    expect(ai.repairs.length).toBeGreaterThan(0);
    const looped = ai.repairs.flatMap((round) => round.rows.map((row) => row.in[0]));
    for (const order of shown) expect(looped).not.toContain(order);
    const payloadRows = payloadRowCount(ai.payloads[0]!);
    expect(payloadRows + fresh.length + r.loop!.rowsSent).toBeLessThanOrEqual(limits.learn.loop.maxRowsTotal);
  });
});
