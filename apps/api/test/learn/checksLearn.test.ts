// AI code checks (learn-v9, SPEC 21 v14; docs/proposals/ai-code-checks.md): `learn()` with prompt learn-v9 - one schema for every call
// ({ checks, rules }), a checks answer returned as it is (validated, capped, no repair), the step's content blocks (the payload, then one
// block per round, the newest cached), "answer with the rules now" after the last round, and a checks answer where the rules were due sent
// to repair like any schema problem.
import { formulaRulesToWire } from '@formatai/engine';
import {
  LEARN_SYSTEM_PROMPT_V7,
  LEARN_SYSTEM_PROMPT_V9,
  learnResultWireJsonSchema,
  learnStepWireJsonSchema,
  limits,
  RULES_NOW_INSTRUCTION_V9,
  REPAIR_INSTRUCTION_V9,
  toWire,
  type Check,
  type CheckRound,
  type LearnResult,
} from '@formatai/shared';
import { describe, expect, it } from 'vitest';
import { loadEnv } from '../../src/env.js';
import { learn, repairFromBrowser, type CompleteFn } from '../../src/learn/index.js';
import { createFakeProvider, type CompleteRequest, type FakeLlmProvider } from '../../src/llm/index.js';
import { basicPayload, correctRules, correctRulesWireJson, wrongRoundingRules } from './fixtures.js';

const env = loadEnv({ ...process.env, LLM_PROVIDER: 'fake' });
const completeOf = (fake: FakeLlmProvider): CompleteFn => (req: CompleteRequest) => fake.complete(req);

const CHECK: Check = { check: 'ranges', column: 'Total', by: 'in1' };
const asksChecks = (checks: unknown[]): unknown => ({ checks, rules: null });
const answersRules = (rules: unknown = correctRulesWireJson()): unknown => ({ checks: null, rules });

function round(n = 1): CheckRound {
  return { checks: [CHECK], answers: [{ rows: 2, noValue: 0, clean: true, runs: [{ from: 5, to: 10, value: 10 * n, rows: 2 }] }] };
}

describe('learn() with learn-v9: the first call may ask checks', () => {
  it('a checks answer is the outcome: validated and capped, no rules, no repair; the call is recorded as purpose check', async () => {
    const fake = createFakeProvider();
    fake.enqueue({ json: asksChecks([CHECK, { check: 'plot' }, CHECK, CHECK, CHECK, CHECK]) });
    const outcome = await learn(basicPayload(), { tier: 'paid', env, complete: completeOf(fake), prompt: 'learn-v9' });

    expect(outcome).toMatchObject({ rules: null, verified: false, problems: [] });
    expect(outcome.checks).toEqual([CHECK, CHECK, CHECK, CHECK]);
    expect(outcome.droppedChecks).toEqual(['check 2 was not run: not one of the checks (test, ranges, dependsOn, values, rows)', 'check 6 was not run: at most 4 checks a round']);
    expect(fake.calls).toHaveLength(1);
    const sent = fake.calls[0]!;
    expect(sent.system).toBe(LEARN_SYSTEM_PROMPT_V9);
    expect(sent.schema).toEqual(learnStepWireJsonSchema());
    expect(sent.purpose).toBe('learn');
    expect(sent.content).toEqual([{ text: JSON.stringify(basicPayload()), cache: true }]);
    expect(outcome.calls).toHaveLength(1);
    expect(outcome.calls[0]).toMatchObject({ purpose: 'check', outcome: 'checks', promptVersion: 'learn-v9', checks: { asked: 4, dropped: 2 } });
  });

  it('a rules answer goes on exactly as today (checks, repair): verified, purpose learn', async () => {
    const fake = createFakeProvider();
    fake.enqueue({ json: answersRules() });
    const outcome = await learn(basicPayload(), { tier: 'paid', env, complete: completeOf(fake), prompt: 'learn-v9' });
    expect(outcome.verified).toBe(true);
    expect(outcome.rules).toEqual(correctRules());
    expect(outcome.checks).toBeUndefined();
    expect(outcome.calls[0]).toMatchObject({ purpose: 'learn', outcome: 'verified' });
    expect(outcome.calls[0]!.checks).toBeUndefined();
  });

  it('an answer that is neither (both null, or no check) is a schema problem: the repair round answers with the rules', async () => {
    const fake = createFakeProvider();
    fake.enqueue({ json: { checks: [], rules: null } });
    fake.enqueue({ json: answersRules() });
    const outcome = await learn(basicPayload(), { tier: 'paid', env, complete: completeOf(fake), prompt: 'learn-v9' });
    expect(outcome.verified).toBe(true);
    expect(outcome.calls.map((c) => [c.purpose, c.outcome])).toEqual([
      ['learn', 'needsRepair'],
      ['repair', 'verified'],
    ]);
    const repair = fake.calls[1]!;
    expect(repair.schema).toEqual(learnStepWireJsonSchema());
    const block = JSON.parse(repair.content[1]!.text.split('\n')[0]!) as { previousRules: unknown; problems: { kind: string }[] };
    expect(block.previousRules).toBeNull();
    expect(block.problems[0]!.kind).toBe('schema');
    expect(repair.content[1]!.text.endsWith(REPAIR_INSTRUCTION_V9)).toBe(true);
  });
});

describe('learn() with learn-v9: a step carries every round so far', () => {
  it('the content blocks: the payload (cached), then one block per round, the newest cached; checks still allowed', async () => {
    const fake = createFakeProvider();
    fake.enqueue({ json: asksChecks([CHECK]) });
    const rounds = [round(1), { ...round(2), dropped: ['check 5 was not run: at most 4 checks a round'] }];
    const outcome = await learn(basicPayload(), { tier: 'paid', env, complete: completeOf(fake), prompt: 'learn-v9', rounds });
    expect(outcome.checks).toEqual([CHECK]);
    expect(fake.calls[0]!.content).toEqual([
      { text: JSON.stringify(basicPayload()), cache: true },
      { text: JSON.stringify({ round: 1, checks: rounds[0]!.checks, answers: rounds[0]!.answers }) },
      { text: JSON.stringify({ round: 2, checks: rounds[1]!.checks, answers: rounds[1]!.answers, dropped: rounds[1]!.dropped }), cache: true },
    ]);
  });

  it(`after the last round (${limits.learn.checks.maxRounds}) the call is told to answer with the rules; checks then are a schema problem -> repair`, async () => {
    const fake = createFakeProvider();
    fake.enqueue({ json: asksChecks([CHECK]) });
    fake.enqueue({ json: answersRules() });
    const rounds = Array.from({ length: limits.learn.checks.maxRounds }, (_, i) => round(i + 1));
    const outcome = await learn(basicPayload(), { tier: 'paid', env, complete: completeOf(fake), prompt: 'learn-v9', rounds });
    expect(outcome.checks).toBeUndefined();
    expect(outcome.verified).toBe(true);
    const first = fake.calls[0]!;
    expect(first.content).toHaveLength(1 + rounds.length + 1);
    expect(first.content[first.content.length - 1]).toEqual({ text: RULES_NOW_INSTRUCTION_V9 });
    expect(outcome.calls.map((c) => [c.purpose, c.outcome])).toEqual([
      ['learn', 'needsRepair'],
      ['repair', 'verified'],
    ]);
    // the repair carries the rounds too, then its block
    const repair = fake.calls[1]!;
    expect(repair.content.slice(0, 1 + rounds.length)).toEqual(first.content.slice(0, 1 + rounds.length));
    expect(JSON.parse(repair.content[1 + rounds.length]!.text.split('\n')[0]!).problems[0]).toMatchObject({ kind: 'schema', path: 'checks' });
  });

  it('rulesNow (the browser\'s fresh learn in a loop round): no checks - the first call is told to answer with the rules, checks then go to repair', async () => {
    const fake = createFakeProvider();
    fake.enqueue({ json: asksChecks([CHECK]) });
    fake.enqueue({ json: answersRules() });
    const outcome = await learn(basicPayload(), { tier: 'paid', env, complete: completeOf(fake), prompt: 'learn-v9', rulesNow: true });
    expect(outcome.checks).toBeUndefined();
    expect(outcome.verified).toBe(true);
    const first = fake.calls[0]!;
    expect(first.system).toBe(LEARN_SYSTEM_PROMPT_V9);
    expect(first.content).toEqual([{ text: JSON.stringify(basicPayload()), cache: true }, { text: RULES_NOW_INSTRUCTION_V9 }]);
    expect(outcome.calls.map((c) => [c.purpose, c.outcome])).toEqual([
      ['learn', 'needsRepair'],
      ['repair', 'verified'],
    ]);
    expect(JSON.parse(fake.calls[1]!.content[1]!.text.split('\n')[0]!).problems[0]).toMatchObject({ kind: 'schema', path: 'checks' });
  });

  it('rulesNow is ignored by a prompt version without checks (learn-v7: no extra block)', async () => {
    const fake = createFakeProvider();
    fake.enqueue({ json: correctRulesWireJson() });
    const outcome = await learn(basicPayload(), { tier: 'paid', env, complete: completeOf(fake), prompt: 'learn-v7', rulesNow: true });
    expect(outcome.verified).toBe(true);
    expect(fake.calls[0]!.system).toBe(LEARN_SYSTEM_PROMPT_V7);
    expect(fake.calls[0]!.content).toEqual([{ text: JSON.stringify(basicPayload()), cache: true }]);
  });

  it('the escalation gets the rounds and must answer with the rules', async () => {
    const fake = createFakeProvider();
    const wrong = toWire(formulaRulesToWire(wrongRoundingRules()) as unknown as LearnResult);
    fake.enqueue({ json: answersRules(wrong) });
    fake.enqueue({ json: answersRules(wrong) });
    fake.enqueue({ json: answersRules() });
    const rounds = [round(1)];
    const outcome = await learn(basicPayload(), { tier: 'paid', env, complete: completeOf(fake), prompt: 'learn-v9', rounds });
    expect(outcome.calls.map((c) => c.purpose)).toEqual(['learn', 'repair', 'escalation']);
    const escalation = fake.calls[2]!;
    expect(escalation.content).toEqual([...fake.calls[0]!.content, { text: RULES_NOW_INSTRUCTION_V9 }]);
    expect(outcome.verified).toBe(true);
  });

  it('a loop round (repairFromBrowser) answers with the rules: checks there are a schema problem', async () => {
    const fake = createFakeProvider();
    fake.enqueue({ json: asksChecks([CHECK]) });
    fake.enqueue({ json: answersRules() });
    const outcome = await repairFromBrowser(basicPayload(), wrongRoundingRules(), [], { tier: 'paid', env, complete: completeOf(fake), prompt: 'learn-v9' });
    expect(outcome.checks).toBeUndefined();
    expect(outcome.calls.map((c) => [c.purpose, c.outcome])).toEqual([
      ['repair', 'needsRepair'],
      ['repair', 'verified'],
    ]);
    expect(fake.calls[0]!.schema).toEqual(learnStepWireJsonSchema());
  });
});

// Logic first (docs/proposals/saved-format-contents.md section 4): the one round for a list may be answered with checks first under learn-v9.
describe('repairFromBrowser: a list\'s round may ask checks (learn-v9)', () => {
  const LIST = { kind: 'list' as const, out: 1, message: 'Column "Total" is a list of 30 fixed values, one per ID. Find the rule behind it from the other columns. Only if no rule exists - the value depends on each ID itself, or comes from outside the file - keep the list.' };
  const opts = (more: Record<string, unknown> = {}) => ({ tier: 'paid' as const, env, prompt: 'learn-v9' as const, ...more });

  it('checks asked while another call may follow: the outcome is the checks, no repair; the block ends with learn-v7\'s fix-only line', async () => {
    const fake = createFakeProvider();
    fake.enqueue({ json: asksChecks([CHECK]) });
    const outcome = await repairFromBrowser(basicPayload(), correctRules(), [LIST], opts({ complete: completeOf(fake), mayCheck: true }));
    expect(outcome).toMatchObject({ rules: null, verified: false, problems: [], checks: [CHECK] });
    expect(fake.calls).toHaveLength(1);
    expect(outcome.calls[0]).toMatchObject({ purpose: 'check', outcome: 'checks' });
    const [payloadBlock, repair] = fake.calls[0]!.content;
    expect(payloadBlock).toEqual({ text: JSON.stringify(basicPayload()), cache: true });
    expect(repair!.text.split('\n')[1]).toBe('Fix only what the problems require. Keep everything else identical.');
    expect(JSON.parse(repair!.text.split('\n')[0]!).problems).toEqual([LIST]);
  });

  it('the next call carries the rounds after the repair block, and the rules come', async () => {
    const fake = createFakeProvider();
    fake.enqueue({ json: answersRules() });
    const outcome = await repairFromBrowser(basicPayload(), correctRules(), [LIST], opts({ complete: completeOf(fake), mayCheck: true, rounds: [round(1)] }));
    expect(outcome.verified).toBe(true);
    const content = fake.calls[0]!.content;
    expect(content).toHaveLength(3);
    expect(JSON.parse(content[2]!.text)).toMatchObject({ round: 1, checks: [CHECK] });
    expect(content[2]!.cache).toBe(true);
  });

  it('the round\'s last call (no call may follow, or no round left) must answer with the rules: checks then go to repair', async () => {
    const fake = createFakeProvider();
    fake.enqueue({ json: asksChecks([CHECK]) });
    fake.enqueue({ json: answersRules() });
    const outcome = await repairFromBrowser(basicPayload(), correctRules(), [LIST], opts({ complete: completeOf(fake), mayCheck: false, rounds: [round(1)] }));
    expect(outcome.checks).toBeUndefined();
    expect(outcome.verified).toBe(true);
    expect(fake.calls[0]!.content.at(-1)).toEqual({ text: RULES_NOW_INSTRUCTION_V9 });
    expect(fake.calls[0]!.content[1]!.text.split('\n')[1]).toBe(REPAIR_INSTRUCTION_V9);
    // With no round yet and no call to follow: the version's own instruction says it ("answer with the rules"), no extra block.
    const once = createFakeProvider();
    once.enqueue({ json: answersRules() });
    await repairFromBrowser(basicPayload(), correctRules(), [LIST], opts({ complete: completeOf(once), mayCheck: false }));
    expect(once.calls[0]!.content).toHaveLength(2);
    expect(once.calls[0]!.content[1]!.text.split('\n')[1]).toBe(REPAIR_INSTRUCTION_V9);
  });

  it('never on another round, nor under a version without checks', async () => {
    const fake = createFakeProvider();
    fake.enqueue({ json: asksChecks([CHECK]) });
    fake.enqueue({ json: answersRules() });
    const outcome = await repairFromBrowser(basicPayload(), wrongRoundingRules(), [{ kind: 'layout', message: 'x' }], opts({ complete: completeOf(fake), mayCheck: true, rounds: [round(1)] }));
    expect(outcome.checks).toBeUndefined();
    expect(fake.calls[0]!.content).toHaveLength(2);
    const v7 = createFakeProvider();
    v7.enqueue({ json: correctRulesWireJson() });
    const plain = await repairFromBrowser(basicPayload(), correctRules(), [LIST], { tier: 'paid', env, complete: completeOf(v7), mayCheck: true, rounds: [round(1)] });
    expect(plain.verified).toBe(true);
    expect(v7.calls[0]!.content).toHaveLength(2);
    expect(plain.calls[0]!.problemCounts.list).toBe(0);
  });
});

describe('learn() without learn-v9 is unchanged', () => {
  it('learn-v7: its own schema, one payload block, rounds ignored', async () => {
    const fake = createFakeProvider();
    fake.enqueue({ json: correctRulesWireJson() });
    const outcome = await learn(basicPayload(), { tier: 'paid', env, complete: completeOf(fake), rounds: [round(1)] });
    expect(outcome.verified).toBe(true);
    expect(fake.calls[0]!.system).toBe(LEARN_SYSTEM_PROMPT_V7);
    expect(fake.calls[0]!.schema).toEqual(learnResultWireJsonSchema({ alternatives: false }));
    expect(fake.calls[0]!.content).toEqual([{ text: JSON.stringify(basicPayload()), cache: true }]);
  });
});
