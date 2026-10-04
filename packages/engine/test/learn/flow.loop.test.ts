// learnFromExamples with the learning loop: after the full verification the browser sends rows the rules got wrong, round after round,
// while the number of wrong rows keeps going down - at most 3 rounds - and keeps the best answer. The fake `callLearn` / `callRepair` play
// the AI step: each answer is the priority rules with some cut-off (5,000 is right).
import type { LearnPayload, LearnResult, RepairProblem } from '@formatai/shared';
import { describe, expect, it } from 'vitest';
import { learnFromExamples, type LearnCallResult } from '../../src/learn/flow';
import type { LoopRound } from '../../src/learn/loop';
import { priorityPair, priorityRules, wrongWithCutoff } from './loopFixtures';
import { xlsxBytesOf, type Pair } from './v5fixtures';

async function bytes(pair: Pair) {
  return { input: { bytes: await xlsxBytesOf(pair.input), name: 'in.xlsx' }, output: { bytes: await xlsxBytesOf(pair.output), name: 'out.xlsx' } };
}

interface Round {
  problems: RepairProblem[];
  round: LoopRound;
  previous: LearnResult;
}

/** The AI step: the first answer with cut-off `first`, then each repair with the next cut-off of `repairs` (null: nothing usable). */
function aiStep(first: number, repairs: (number | null)[]) {
  const payloads: LearnPayload[] = [];
  const rounds: Round[] = [];
  return {
    payloads,
    rounds,
    callLearn: async (payload: LearnPayload): Promise<LearnCallResult> => {
      payloads.push(payload);
      return { rules: priorityRules(first), problems: [], calls: ['learn'] };
    },
    callRepair: async (_payload: LearnPayload, previous: LearnResult, problems: RepairProblem[], round: LoopRound): Promise<LearnCallResult> => {
      rounds.push({ problems, round, previous });
      const cut = repairs[rounds.length - 1];
      return { rules: cut === null || cut === undefined ? null : priorityRules(cut), problems: [], calls: [`repair${rounds.length}`] };
    },
  };
}

async function run(pair: Pair, ai: ReturnType<typeof aiStep>, masking = false) {
  return learnFromExamples({
    ...(await bytes(pair)),
    masking,
    ...(masking ? { key: new TextEncoder().encode('flow-loop') } : {}),
    tier: 'paid',
    callLearn: ai.callLearn,
    callRepair: ai.callRepair,
  });
}

const cutOf = (rules: LearnResult | null): unknown => (JSON.stringify(rules).match(/"gte","args":\[\{"col":"amount"\},\{"const":(\d+)\}/) ?? [])[1];

describe('learnFromExamples: the learning loop', () => {
  it('verifies in round 2: each round sends new wrong rows, the request carries every row sent so far', async () => {
    const pair = priorityPair();
    const ai = aiStep(9400, [8000, 5000]);
    const r = await run(pair, ai);
    expect(r.path).toBe('llm');
    expect(r.loop).toEqual({ rounds: 2, rowsSent: ai.rounds[1]!.round.rows.length, end: 'verified' });
    expect(r.stages).toMatchObject({ verifiedFirstCall: false, browserRepairUsed: true, verifiedAfterRepair: true });
    expect(r.verification?.verified).toBe(true);
    expect(cutOf(r.rules)).toBe('5000');
    expect(r.calls).toEqual(['learn', 'repair1', 'repair2']);

    const [one, two] = ai.rounds as [Round, Round];
    expect(one.round).toMatchObject({ round: 1, maxRounds: 3, newRows: 8 });
    expect(one.round.rows).toHaveLength(8);
    expect(two.round.round).toBe(2);
    expect(two.round.rows.slice(0, 8)).toEqual(one.round.rows); // accumulated: round 1's rows, then round 2's
    expect(two.round.rows.length).toBe(8 + two.round.newRows);
    expect(cutOf(two.previous)).toBe('8000'); // the repair works on the best answer so far
    // Every diff carries its row; never more than 10.
    for (const { problems } of ai.rounds) {
      const diffs = problems.filter((p) => p.kind === 'diff');
      expect(diffs.length).toBeLessThanOrEqual(10);
      expect(diffs.every((d) => d.kind === 'diff' && d.row !== undefined)).toBe(true);
    }
    // The rows sent are rows the rules got wrong, none of them a sample of the payload.
    const wrong = new Set(wrongWithCutoff(pair, 9400));
    const sampleOrders = new Set(ai.payloads[0]!.samples.map((s) => s.in[0]));
    for (const row of two.round.rows) {
      expect(sampleOrders.has(row.in[0])).toBe(false);
      expect(wrong.has(Number(String(row.in[0]).slice(4)) - 1000)).toBe(true);
    }
  });

  it('stops on no progress: a round that is not better ends the loop, and the best answer so far is kept', async () => {
    const pair = priorityPair();
    const ai = aiStep(8000, [9400]);
    const r = await run(pair, ai);
    expect(ai.rounds).toHaveLength(1);
    expect(r.loop).toMatchObject({ rounds: 1, end: 'noProgress' });
    expect(cutOf(r.rules)).toBe('8000');
    expect(r.stages).toMatchObject({ browserRepairUsed: true, verifiedAfterRepair: false });
    expect(r.verification?.mismatches.length).toBe(wrongWithCutoff(pair, 8000).length);
  });

  it('stops on no progress when a round brings nothing usable back', async () => {
    const ai = aiStep(8000, [null]);
    const r = await run(priorityPair(), ai);
    expect(r.loop).toMatchObject({ rounds: 1, end: 'noProgress' });
    expect(cutOf(r.rules)).toBe('8000');
  });

  it('stops after 3 rounds (the round cap), keeping the best of them', async () => {
    const ai = aiStep(9400, [8500, 7500, 6500, 5000]);
    const r = await run(priorityPair(), ai);
    expect(ai.rounds).toHaveLength(3);
    expect(r.loop).toMatchObject({ rounds: 3, end: 'roundCap' });
    expect(cutOf(r.rules)).toBe('6500');
    expect(r.loop!.rowsSent).toBeLessThanOrEqual(24);
  });

  it('with masking on, the rows and problems of every round leave masked', async () => {
    const pair = priorityPair();
    const ai = aiStep(9400, [8000, 5000]);
    const r = await run(pair, ai, true);
    expect(r.loop?.end).toBe('verified');
    const sent = JSON.stringify(ai.rounds.map((x) => [x.problems, x.round.rows]));
    for (const name of new Set(pair.input.slice(1).map((row) => row[1] as string))) expect(sent).not.toContain(name);
  });

  it('a first answer that verifies makes no round', async () => {
    const ai = aiStep(5000, []);
    const r = await run(priorityPair(), ai);
    expect(ai.rounds).toHaveLength(0);
    expect(r.loop).toEqual({ rounds: 0, rowsSent: 0, end: 'verified' });
    expect(r.stages).toMatchObject({ verifiedFirstCall: true, browserRepairUsed: false, verifiedAfterRepair: true });
  });

  it('without a repair call to make, no round is made (the round cap is 0)', async () => {
    const pair = priorityPair();
    const r = await learnFromExamples({ ...(await bytes(pair)), masking: false, tier: 'paid', callLearn: aiStep(8000, []).callLearn });
    expect(r.loop).toEqual({ rounds: 0, rowsSent: 0, end: 'roundCap' });
  });
});
