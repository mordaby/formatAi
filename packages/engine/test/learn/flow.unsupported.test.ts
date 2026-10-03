// Policy (owner, 2026-10-01; SPEC 4/8.10): a partial, correct rules file beats a complete, wrong one, and an unsupported column is "needs your input",
// not an error. When the AI step honestly answers that a column cannot be produced (`from: null` plus an `unsupported` entry, typically
// `externalData`), the browser's full verification checks the columns that have a rule and nothing else:
//   - everything produced matches -> `verified` (so the learn counts as one successful AI learn), and the unsupported list is on the result;
//   - a produced column that does not match is still a mismatch (and is what a repair would be asked to fix);
//   - nothing produced at all checks nothing: never verified, and no repair call (there is nothing in the example to point at).
import type { LearnPayload, LearnResult, RepairProblem } from '@formatai/shared';
import { describe, expect, it } from 'vitest';
import { learnFromExamples, type LearnCallResult, type LearnFromExamplesOptions } from '../../src/learn/flow';
import { externalOnlyPair, type Pair, xlsxBytesOf } from './v5fixtures';

async function bytes(pair: Pair) {
  return { input: { bytes: await xlsxBytesOf(pair.input), name: 'in.xlsx' }, output: { bytes: await xlsxBytesOf(pair.output), name: 'out.xlsx' } };
}

/** The local partial rules of the pair: Item, Ref and Total built, Warehouse (external data) with no rule. */
async function localRules(pair: Pair): Promise<LearnResult> {
  const r = await learnFromExamples({ ...(await bytes(pair)), masking: false, tier: 'paid', ai: 'notAllowed', callLearn: async () => { throw new Error('no AI step here'); } });
  if (r.path !== 'partial' || !r.rules) throw new Error(`expected a partial result, got ${r.path}`);
  return r.rules;
}

const external = (header = 'Warehouse') => ({ outputColumn: header, reasonCode: 'externalData' as const });

/** The honest answer: what code built, plus Warehouse reported as unsupported externalData. */
const honest = (rules: LearnResult): LearnResult => ({ ...rules, unsupported: [external()] });

interface Spy {
  payloads: LearnPayload[];
  repairs: RepairProblem[][];
  callLearn: LearnFromExamplesOptions['callLearn'];
  callRepair: NonNullable<LearnFromExamplesOptions['callRepair']>;
}

function spy(answer: LearnResult, repaired: LearnResult | null = null): Spy {
  const payloads: LearnPayload[] = [];
  const repairs: RepairProblem[][] = [];
  return {
    payloads,
    repairs,
    callLearn: async (payload): Promise<LearnCallResult> => {
      payloads.push(payload);
      return { rules: answer, problems: [], calls: [] };
    },
    callRepair: async (_payload, _previous, problems): Promise<LearnCallResult> => {
      repairs.push(problems);
      return { rules: repaired, problems: [], calls: [] };
    },
  };
}

async function learn(pair: Pair, s: Spy, masking: boolean) {
  return learnFromExamples({
    ...(await bytes(pair)),
    masking,
    ...(masking ? { key: new TextEncoder().encode('unsupported-test') } : {}),
    tier: 'paid',
    callLearn: s.callLearn,
    callRepair: s.callRepair,
  });
}

describe('learnFromExamples: a column the AI step reports as unsupported', () => {
  it.each([false, true])('is not compared with the example: everything produced matches, so the learn is verified (masking %s), with the unsupported list on the result', async (masking) => {
    const pair = externalOnlyPair();
    const s = spy(honest(await localRules(pair)));
    const res = await learn(pair, s, masking);

    expect(s.payloads).toHaveLength(1);
    expect(s.payloads[0]!.skipColumns).toBeUndefined(); // the AI step was asked about it like any other column
    expect(res.path).toBe('llm');
    expect(res.verification).toMatchObject({ verified: true, matched: 20, total: 20, mismatches: [], repairProblems: [] });
    expect(res.stages).toMatchObject({ llmCalled: true, verifiedFirstCall: true, verifiedAfterRepair: true, browserRepairUsed: false });
    expect(s.repairs).toEqual([]);
    expect(res.unsupported).toEqual([external()]);
    expect(res.rules?.output.columns.map((c) => [c.header, c.from === null])).toEqual([['Item', false], ['Ref', false], ['Total', false], ['Warehouse', true]]);
  });

  it('still counts a produced column that does not match: not verified, and the repair call carries that difference only (never the unsupported column)', async () => {
    const pair = externalOnlyPair();
    const good = honest(await localRules(pair));
    // Total now copies Item: wrong on every row.
    const itemFrom = good.output.columns.find((c) => c.header === 'Item')!.from;
    const wrong: LearnResult = { ...good, output: { ...good.output, columns: good.output.columns.map((c) => (c.header === 'Total' ? { ...c, from: itemFrom } : c)) } };
    const s = spy(wrong, good);
    const res = await learn(pair, s, false);

    expect(s.repairs).toHaveLength(1);
    const diffs = s.repairs[0]!.filter((p) => p.kind === 'diff');
    expect(diffs.length).toBeGreaterThan(0);
    expect(diffs.every((p) => p.kind === 'diff' && p.out === 2)).toBe(true); // Total only; Warehouse (3) is never a diff
    expect(res.stages).toMatchObject({ verifiedFirstCall: false, browserRepairUsed: true, verifiedAfterRepair: true });
    expect(res.verification?.verified).toBe(true);
  });

  it('every column reported as unsupported produced nothing: never verified (0 of 0 rows); the only thing to ask a repair about is the columns the analysis had explained (never a diff)', async () => {
    const pair = externalOnlyPair();
    const good = await localRules(pair);
    const nothing: LearnResult = {
      ...good,
      transform: { ...good.transform, computed: [] },
      output: { ...good.output, columns: good.output.columns.map((c) => ({ header: c.header, from: null })) },
      unsupported: good.output.columns.map((c) => external(c.header)),
    };
    const s = spy(nothing);
    const res = await learn(pair, s, false);

    expect(res.path).toBe('llm');
    expect(res.verification).toMatchObject({ verified: false, matched: 0, total: 0 });
    expect(res.stages).toMatchObject({ verifiedFirstCall: false, verifiedAfterRepair: false, browserRepairUsed: true });
    // Item, Ref and Total have a hint (copy, copy, Qty x Price); Warehouse has none and stays an honest unsupported
    expect(s.repairs).toHaveLength(1);
    expect(s.repairs[0]!.map((p) => [p.kind, p.kind === 'unsupportedDespiteEvidence' ? p.out : -1])).toEqual([['unsupportedDespiteEvidence', 0], ['unsupportedDespiteEvidence', 1], ['unsupportedDespiteEvidence', 2]]);
    expect(res.unsupported).toHaveLength(4);
  });

  it('a result with no column left out is verified exactly as before: the whole file, layout rows included', async () => {
    const pair = externalOnlyPair();
    const rules = await localRules(pair);
    // Warehouse got a rule (a wrong one: a copy of Ref): the full verification runs and says so.
    const refFrom = rules.output.columns.find((c) => c.header === 'Ref')!.from;
    const filled: LearnResult = { ...rules, output: { ...rules.output, columns: rules.output.columns.map((c) => (c.header === 'Warehouse' ? { ...c, from: refFrom } : c)) } };
    const res = await learn(pair, spy(filled), false);
    expect(res.verification?.verified).toBe(false);
    expect(res.verification?.mismatches.every((m) => m.column === 'Warehouse')).toBe(true);
  });
});

// The one exception to "an honest unsupported is not a mismatch": the pair analysis HAD found how the column is built (the payload carries a
// hint for it). Giving up on it is a problem for the repair round - the browser's own repair call, besides the API's server round.
describe('learnFromExamples: a column the AI step gives up on although the analysis explained it', () => {
  /** What code built, with Total (a hint: Qty x Price) given up as unsupported, and Warehouse (no hint) too. */
  const gaveUpOnTotal = (rules: LearnResult): LearnResult => ({
    ...rules,
    output: { ...rules.output, columns: rules.output.columns.map((c) => (c.header === 'Total' ? { header: 'Total', from: null } : c)) },
    unsupported: [external('Total'), external()],
  });

  it.each([false, true])('is one repair call that names the column, its input columns and the hint kind - nothing else, no value (masking %s)', async (masking) => {
    const pair = externalOnlyPair();
    const good = honest(await localRules(pair));
    const s = spy(gaveUpOnTotal(good), good);
    const res = await learn(pair, s, masking);

    expect(s.repairs).toHaveLength(1);
    expect(s.repairs[0]).toEqual([
      { kind: 'unsupportedDespiteEvidence', out: 2, message: 'Column "Total": the app found it is built from "Qty", "Price" (mul); write a rule for it.' },
    ]);
    expect(res.stages).toMatchObject({ verifiedFirstCall: false, browserRepairUsed: true, verifiedAfterRepair: true });
    expect(res.verification).toMatchObject({ verified: true, matched: 20, total: 20 });
    expect(res.unsupported).toEqual([external()]); // Warehouse has no hint: still an honest unsupported, never asked about
  });

  it('a model that stands by "unsupported" after that round is accepted: the column stays "needs your input" and the produced columns are verified', async () => {
    const pair = externalOnlyPair();
    const answer = gaveUpOnTotal(honest(await localRules(pair)));
    const s = spy(answer, answer);
    const res = await learn(pair, s, false);

    expect(s.repairs).toHaveLength(1);
    expect(res.stages).toMatchObject({ verifiedFirstCall: false, browserRepairUsed: true, verifiedAfterRepair: true });
    expect(res.unsupported.map((u) => u.outputColumn)).toEqual(['Total', 'Warehouse']);
  });

  it('a repair that writes a rule for it is checked like any column: a wrong one is a mismatch', async () => {
    const pair = externalOnlyPair();
    const good = honest(await localRules(pair));
    const itemFrom = good.output.columns.find((c) => c.header === 'Item')!.from;
    const wrong: LearnResult = { ...good, output: { ...good.output, columns: good.output.columns.map((c) => (c.header === 'Total' ? { ...c, from: itemFrom } : c)) }, unsupported: [external()] };
    const res = await learn(pair, spy(gaveUpOnTotal(good), wrong), false);
    expect(res.stages).toMatchObject({ browserRepairUsed: true, verifiedAfterRepair: false });
    expect(res.verification?.mismatches.every((m) => m.column === 'Total')).toBe(true);
  });

  it('without a repair call to make (callRepair not given) nothing is asked: the answer is returned as it is', async () => {
    const pair = externalOnlyPair();
    const answer = gaveUpOnTotal(honest(await localRules(pair)));
    const s = spy(answer);
    const res = await learnFromExamples({ ...(await bytes(pair)), masking: false, tier: 'paid', callLearn: s.callLearn });
    expect(res.stages).toMatchObject({ verifiedFirstCall: false, browserRepairUsed: false });
    expect(res.unsupported.map((u) => u.outputColumn)).toEqual(['Total', 'Warehouse']);
  });
});
