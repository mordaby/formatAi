import { describe, expect, it } from 'vitest';
import { LEARN_SYSTEM_PROMPT_V4, limits, models, REPAIR_INSTRUCTION } from '@formatai/shared';
import { loadEnv } from '../../src/env.js';
import { createFakeProvider, type CompleteRequest, type FakeLlmProvider } from '../../src/llm/index.js';
import { learn, repairFromBrowser, type CompleteFn } from '../../src/learn/index.js';
import {
  basicPayload,
  correctRules,
  correctRulesWireJson,
  schemaBrokenRulesJson,
  wrongRoundingWireJson,
} from './fixtures.js';

const env = loadEnv({ ...process.env, LLM_PROVIDER: 'fake' });

function fakeCompleteFn(fake: FakeLlmProvider): CompleteFn {
  return (req: CompleteRequest) => fake.complete(req);
}

/** Temporarily overrides `limits.llm.serverRepairRounds` for one (async) test body.
 * `limits` is a plain (not frozen) exported object, so this is a direct, restored
 * mutation rather than a mocking framework - there is no env/config override for this
 * value (only the model registry has one, SPEC 9.4/9.6). */
async function withServerRepairRounds<T>(rounds: number, fn: () => Promise<T>): Promise<T> {
  const mutable = limits.llm as { serverRepairRounds: number };
  const original = mutable.serverRepairRounds;
  mutable.serverRepairRounds = rounds;
  try {
    return await fn();
  } finally {
    mutable.serverRepairRounds = original;
  }
}

describe('learn()', () => {
  it('verifies on the first call when the model gets it right immediately', async () => {
    const fake = createFakeProvider();
    fake.enqueue({ json: correctRulesWireJson() });

    const outcome = await learn(basicPayload(), { tier: 'registered', env, complete: fakeCompleteFn(fake) });

    expect(outcome.verified).toBe(true);
    expect(outcome.problems).toEqual([]);
    expect(outcome.rules).toEqual(correctRules());
    expect(outcome.calls).toHaveLength(1);
    expect(outcome.calls[0]).toMatchObject({ purpose: 'learn', outcome: 'verified', model: models.fake.firstTry });
  });

  it('repairs a schema failure (unknown op) and verifies on the repair call', async () => {
    const fake = createFakeProvider();
    fake.enqueue({ json: schemaBrokenRulesJson() });
    fake.enqueue({ json: correctRulesWireJson() });

    const outcome = await learn(basicPayload(), { tier: 'registered', env, complete: fakeCompleteFn(fake) });

    expect(outcome.verified).toBe(true);
    expect(outcome.rules).toEqual(correctRules());
    expect(outcome.calls.map((c) => c.purpose)).toEqual(['learn', 'repair']);
    expect(outcome.calls[0]!.outcome).toBe('needsRepair');
    expect(outcome.calls[1]!.outcome).toBe('verified');
  });

  it('repairs a diff failure (wrong rounding) and verifies on the repair call', async () => {
    const fake = createFakeProvider();
    fake.enqueue({ json: wrongRoundingWireJson() });
    fake.enqueue({ json: correctRulesWireJson() });

    const outcome = await learn(basicPayload(), { tier: 'registered', env, complete: fakeCompleteFn(fake) });

    expect(outcome.verified).toBe(true);
    expect(outcome.rules).toEqual(correctRules());
    expect(outcome.calls.map((c) => c.purpose)).toEqual(['learn', 'repair']);
  });

  it('escalates to the escalation model when the repair round still fails, and can still verify there', async () => {
    const fake = createFakeProvider();
    fake.enqueue({ json: wrongRoundingWireJson() }); // learn
    fake.enqueue({ json: wrongRoundingWireJson() }); // repair (still wrong)
    fake.enqueue({ json: correctRulesWireJson() }); // escalation (fresh, correct)

    const outcome = await learn(basicPayload(), { tier: 'registered', env, complete: fakeCompleteFn(fake) });

    expect(outcome.calls.map((c) => c.purpose)).toEqual(['learn', 'repair', 'escalation']);
    const escalationCall = outcome.calls[2]!;
    expect(escalationCall.model).toBe(models.fake.escalation);
    expect(outcome.verified).toBe(true);
    expect(outcome.rules).toEqual(correctRules());
  });

  it('the escalation attempt gets no repair round of its own, even when it still fails', async () => {
    const fake = createFakeProvider();
    fake.enqueue({ json: wrongRoundingWireJson() }); // learn
    fake.enqueue({ json: wrongRoundingWireJson() }); // repair
    fake.enqueue({ json: wrongRoundingWireJson() }); // escalation (still wrong)

    const outcome = await learn(basicPayload(), { tier: 'registered', env, complete: fakeCompleteFn(fake) });

    expect(outcome.calls.map((c) => c.purpose)).toEqual(['learn', 'repair', 'escalation']);
    expect(outcome.verified).toBe(false);
    expect(outcome.problems.length).toBeGreaterThan(0);
  });

  it('respects a repair-round cap of 0: goes straight from the first try to escalation', async () => {
    await withServerRepairRounds(0, async () => {
      const fake = createFakeProvider();
      fake.enqueue({ json: wrongRoundingWireJson() }); // learn (fails)
      fake.enqueue({ json: correctRulesWireJson() }); // escalation

      const outcome = await learn(basicPayload(), { tier: 'registered', env, complete: fakeCompleteFn(fake) });

      expect(outcome.calls.map((c) => c.purpose)).toEqual(['learn', 'escalation']);
      expect(outcome.verified).toBe(true);
    });
  });

  it('respects a repair-round cap of 1: exactly one repair call before escalation', async () => {
    await withServerRepairRounds(1, async () => {
      const fake = createFakeProvider();
      fake.enqueue({ json: wrongRoundingWireJson() }); // learn
      fake.enqueue({ json: wrongRoundingWireJson() }); // repair (round 1 of 1)
      fake.enqueue({ json: correctRulesWireJson() }); // escalation

      const outcome = await learn(basicPayload(), { tier: 'registered', env, complete: fakeCompleteFn(fake) });

      expect(outcome.calls.map((c) => c.purpose)).toEqual(['learn', 'repair', 'escalation']);
    });
  });

  it('makes exactly one stateless user message per call, with no growing history', async () => {
    const fake = createFakeProvider();
    fake.enqueue({ json: schemaBrokenRulesJson() });
    fake.enqueue({ json: correctRulesWireJson() });

    await learn(basicPayload(), { tier: 'registered', env, complete: fakeCompleteFn(fake) });

    expect(fake.calls).toHaveLength(2);
    const [learnCall, repairCall] = fake.calls;

    // Every call uses the identical, unchanging system prompt (SPEC 9.1) - no
    // conversation history is ever built up.
    expect(learnCall!.system).toBe(LEARN_SYSTEM_PROMPT_V4);
    expect(repairCall!.system).toBe(LEARN_SYSTEM_PROMPT_V4);

    // The learn call: exactly one content block, the cached payload.
    expect(learnCall!.content).toHaveLength(1);
    expect(learnCall!.content[0]!.cache).toBe(true);

    // The repair call: exactly two content blocks - the SAME cached payload block,
    // then the repair block (LEARN_PROMPT §4).
    expect(repairCall!.content).toHaveLength(2);
    expect(repairCall!.content[0]).toEqual(learnCall!.content[0]);
    expect(repairCall!.content[1]!.cache).toBeUndefined();
    expect(repairCall!.content[1]!.text).toContain('"mode":"repair"');
    expect(repairCall!.content[1]!.text.endsWith(REPAIR_INSTRUCTION)).toBe(true);
  });
});

describe('repairFromBrowser()', () => {
  it('makes exactly one repair call and returns its result', async () => {
    const fake = createFakeProvider();
    fake.enqueue({ json: correctRulesWireJson() });

    const outcome = await repairFromBrowser(
      basicPayload(),
      { ...correctRules(), transform: { ...correctRules().transform, computed: [] } },
      [{ kind: 'diff', out: 1, sample: 0, expected: 20, actual: 10 }],
      { tier: 'registered', env, complete: fakeCompleteFn(fake) },
    );

    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]!.content).toHaveLength(2);
    expect(outcome.calls).toHaveLength(1);
    expect(outcome.calls[0]!.purpose).toBe('repair');
    expect(outcome.verified).toBe(true);
    expect(outcome.rules).toEqual(correctRules());
  });
});
