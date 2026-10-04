import { describe, expect, it } from 'vitest';
import { LEARN_SYSTEM_PROMPT, limits, models, REPAIR_INSTRUCTION } from '@formatai/shared';
import { loadEnv } from '../../src/env.js';
import { createFakeProvider, type CompleteRequest, type FakeLlmProvider } from '../../src/llm/index.js';
import { learn, repairFromBrowser, type CompleteFn } from '../../src/learn/index.js';
import {
  allUnsupportedWireJson,
  basicPayload,
  correctRules,
  correctRulesWireJson,
  derivableColumnPayload,
  derivableColumnWireJson,
  externalColumnPayload,
  externalColumnRules,
  externalColumnWireJson,
  gaveUpOnDerivableWireJson,
  schemaBrokenRulesJson,
  wrongRoundingRules,
  wrongRoundingWireJson,
} from './fixtures.js';
import { formulaRulesToWire } from '@formatai/engine';
import { toWire } from '@formatai/shared';

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

describe('learn() with the fake provider: the current prompt (learn-v8), the wire schema and the notes round trip', () => {
  const request = { name: 'lookupStorageSite', purpose: 'Finds the storage site of an item from a table kept elsewhere.', args: [{ name: 'item', type: 'text' as const }], returns: 'text' as const };

  it('sends the current prompt and a wire schema that carries functionRequest and explanation, and returns both on the answer', async () => {
    const fake = createFakeProvider();
    const noted = { ...externalColumnRules(), unsupported: [{ outputColumn: 'Warehouse', reasonCode: 'externalData' as const, functionRequest: request, explanation: 'Looks like the storage site of the item.' }] };
    const { toWire } = await import('@formatai/shared');
    const { formulaRulesToWire } = await import('@formatai/engine');
    fake.enqueue({ json: toWire(formulaRulesToWire(noted) as never) });

    const outcome = await learn(externalColumnPayload(), { tier: 'registered', env, complete: fakeCompleteFn(fake) });

    expect(outcome.verified).toBe(true);
    expect(outcome.rules?.unsupported).toEqual(noted.unsupported);
    const sent = fake.calls[0]!;
    expect(sent.system).toBe(LEARN_SYSTEM_PROMPT);
    expect(sent.system).toContain('functionRequest');
    expect(sent.system).toContain('runningSum(x)');
    const unsupportedItem = (sent.schema as { properties: { unsupported: { items: { properties: Record<string, unknown> } } } }).properties.unsupported.items;
    expect(Object.keys(unsupportedItem.properties).sort()).toEqual(['explanation', 'functionRequest', 'outputColumn', 'reasonCode']);
    expect(outcome.calls[0]).toMatchObject({ promptVersion: 'learn-v8' });
    // the ledger record is counts only: nothing of the notes
    expect(JSON.stringify(outcome.calls)).not.toMatch(/storage site|lookupStorageSite|explanation/);
  });

  it('a window function in the answer round-trips like any other formula (the prompt documents it)', async () => {
    const fake = createFakeProvider();
    const rules = correctRules();
    const withWindow = {
      ...rules,
      transform: { ...rules.transform, computed: [...rules.transform.computed, { id: 'running', type: 'decimal' as const, expr: { op: 'window' as const, fn: 'runningSum' as const, arg: { col: 'amount' } } }] },
    };
    const { toWire } = await import('@formatai/shared');
    const { formulaRulesToWire } = await import('@formatai/engine');
    const wire = toWire(formulaRulesToWire(withWindow) as never) as unknown as { transform: { computed: { expr: string }[] } };
    expect(wire.transform.computed.at(-1)!.expr).toBe('runningSum(amount)');
    fake.enqueue({ json: wire });
    const outcome = await learn(basicPayload(), { tier: 'registered', env, complete: fakeCompleteFn(fake) });
    expect(outcome.problems).toEqual([]);
    expect(outcome.rules?.transform.computed.at(-1)?.expr).toMatchObject({ op: 'window', fn: 'runningSum' });
  });
});

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
    expect(learnCall!.system).toBe(LEARN_SYSTEM_PROMPT);
    expect(repairCall!.system).toBe(LEARN_SYSTEM_PROMPT);

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

describe('learn(): an honest "cannot produce this column"', () => {
  it('verifies on the first call: the column reported as unsupported is not compared, so there is nothing to repair or escalate (exactly 1 call)', async () => {
    const fake = createFakeProvider();
    fake.enqueue({ json: externalColumnWireJson() });

    const outcome = await learn(externalColumnPayload(), { tier: 'registered', env, complete: fakeCompleteFn(fake) });

    expect(fake.calls).toHaveLength(1);
    expect(outcome.calls.map((c) => c.purpose)).toEqual(['learn']);
    expect(outcome.calls[0]).toMatchObject({ outcome: 'verified' });
    expect(outcome.verified).toBe(true);
    expect(outcome.problems).toEqual([]);
    expect(outcome.rules).toEqual(externalColumnRules());
  });

  it('every column unsupported is no verified learn: it is repaired once and escalated like any failing attempt, and ends not verified', async () => {
    const fake = createFakeProvider();
    fake.enqueue({ json: allUnsupportedWireJson() }); // learn
    fake.enqueue({ json: allUnsupportedWireJson() }); // repair
    fake.enqueue({ json: allUnsupportedWireJson() }); // escalation

    const outcome = await learn(externalColumnPayload(), { tier: 'registered', env, complete: fakeCompleteFn(fake) });

    expect(outcome.calls.map((c) => c.purpose)).toEqual(['learn', 'repair', 'escalation']);
    expect(outcome.verified).toBe(false);
    expect(outcome.problems.every((p) => p.kind === 'reference')).toBe(true);
  });
});

describe('learn(): an unsupported column the app found a relation for', () => {
  it('is repaired once: the repair call carries the problem, and the answer that writes the rule verifies (2 calls, no escalation)', async () => {
    const fake = createFakeProvider();
    fake.enqueue({ json: gaveUpOnDerivableWireJson() }); // learn: gives up on Warehouse
    fake.enqueue({ json: derivableColumnWireJson() }); // repair: writes the rule

    const outcome = await learn(derivableColumnPayload(), { tier: 'registered', env, complete: fakeCompleteFn(fake) });

    expect(outcome.calls.map((c) => c.purpose)).toEqual(['learn', 'repair']);
    expect(outcome.calls[0]).toMatchObject({ outcome: 'needsRepair' });
    expect(outcome.calls[0]!.problemCounts.unsupportedDespiteEvidence).toBe(1);
    expect(outcome.calls[1]!.problemCounts.unsupportedDespiteEvidence).toBe(0);
    expect(outcome.verified).toBe(true);
    expect(outcome.rules?.unsupported).toEqual([]);
    const repairText = fake.calls[1]!.content[1]!.text;
    expect(repairText).toContain('"kind":"unsupportedDespiteEvidence"');
    expect(repairText).toContain('the app found it is built from \\"Site\\" (copy); write a rule for it.');
  });

  it('a model that stands by "unsupported" is repaired once, escalated once, and ends not verified - the rules it gave are still returned (the browser decides)', async () => {
    const fake = createFakeProvider();
    for (let i = 0; i < 3; i++) fake.enqueue({ json: gaveUpOnDerivableWireJson() });

    const outcome = await learn(derivableColumnPayload(), { tier: 'registered', env, complete: fakeCompleteFn(fake) });

    expect(outcome.calls.map((c) => c.purpose)).toEqual(['learn', 'repair', 'escalation']);
    expect(outcome.verified).toBe(false);
    expect(outcome.problems.map((p) => p.kind)).toEqual(['unsupportedDespiteEvidence']);
    expect(outcome.rules?.unsupported).toEqual([{ outputColumn: 'Warehouse', reasonCode: 'externalData' }]);
  });

  it('a column with no hint is still accepted on the first call (nothing to repair)', async () => {
    const fake = createFakeProvider();
    fake.enqueue({ json: externalColumnWireJson() });
    const outcome = await learn(externalColumnPayload(), { tier: 'registered', env, complete: fakeCompleteFn(fake) });
    expect(fake.calls).toHaveLength(1);
    expect(outcome.verified).toBe(true);
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

describe('repairFromBrowser(): one round of the learning loop', () => {
  /** Rows of the example the browser sent (Total = Amount x 2), and one the first answer below gets wrong. */
  const rows = [
    { in: ['B1', 3], out: ['B1', 6] },
    { in: ['B2', 4], out: ['B2', 8] },
  ];
  /** Right on the samples (10 -> 20, 5 -> 10) but not on B1/B2: Total = Amount + 10. */
  const plusTen = (): unknown => {
    const rules = correctRules();
    return toWire(formulaRulesToWire({ ...rules, transform: { ...rules.transform, computed: [{ id: 'total', type: 'decimal', expr: { op: 'add', args: [{ col: 'amount' }, { const: 10 }] } }] } }) as never);
  };
  const browserProblems = [{ kind: 'diff' as const, out: 1, row: { in: ['B1', 3], out: ['B1', 6] }, expected: 6, actual: 3 }];

  it('checks the answer on the samples PLUS every row sent: right on the samples, wrong on a row, it is repaired - and the repair is told the row itself', async () => {
    const fake = createFakeProvider();
    fake.enqueue({ json: plusTen() });
    fake.enqueue({ json: correctRulesWireJson() });
    const outcome = await repairFromBrowser(basicPayload(), wrongRoundingRules(), browserProblems, { tier: 'registered', env, complete: fakeCompleteFn(fake), rows });

    expect(outcome.calls.map((c) => c.purpose)).toEqual(['repair', 'repair']);
    expect(outcome.verified).toBe(true);
    expect(outcome.rules).toEqual(correctRules());
    // the server's own repair names the rows (the model's payload block never had them), never a sample index past the payload's
    const serverRepair = fake.calls[1]!.content[1]!.text;
    expect(serverRepair).toContain('"row":{"in":["B1",3],"out":["B1",6]}');
    expect(serverRepair).not.toMatch(/"sample":[2-9]/);
  });

  it('a row the example dropped (no output rows) that the answer still makes a row for is a problem naming that row', async () => {
    const fake = createFakeProvider();
    fake.enqueue({ json: correctRulesWireJson() });
    fake.enqueue({ json: correctRulesWireJson() });
    const outcome = await repairFromBrowser(basicPayload(), wrongRoundingRules(), browserProblems, { tier: 'registered', env, complete: fakeCompleteFn(fake), rows: [{ in: ['VOID', 1], out: [] }] });
    expect(outcome.verified).toBe(false);
    // (`row.out` is the example's output for it - nothing - and what the rules made is `made`: prompt audit X1)
    expect(outcome.problems).toContainEqual({ kind: 'diff', out: 0, expected: null, actual: 'VOID', row: { in: ['VOID', 1], out: [] }, made: ['VOID', 2] });
  });

  it('sends the first payload as it was (its cached prefix still hits) and the browser\'s problems in the repair block', async () => {
    const fake = createFakeProvider();
    fake.enqueue({ json: correctRulesWireJson() });
    await repairFromBrowser(basicPayload(), wrongRoundingRules(), browserProblems, { tier: 'registered', env, complete: fakeCompleteFn(fake), rows });
    const [payloadBlock, repairBlock] = fake.calls[0]!.content as [{ text: string; cache?: boolean }, { text: string }];
    expect(JSON.parse(payloadBlock.text)).toEqual(basicPayload());
    expect(payloadBlock.cache).toBe(true);
    expect(repairBlock.text).toContain('"kind":"diff"');
    expect(repairBlock.text).toContain(REPAIR_INSTRUCTION);
  });

  it('gets the same server repair round as the first call for its own check problems (a formula error), and never escalates', async () => {
    const fake = createFakeProvider();
    const broken = correctRulesWireJson() as { transform: { computed: { expr: string }[] } };
    const badFormula = structuredClone(broken);
    badFormula.transform.computed[0]!.expr = 'amount * (2';
    fake.enqueue({ json: badFormula });
    fake.enqueue({ json: badFormula });
    const outcome = await repairFromBrowser(basicPayload(), wrongRoundingRules(), browserProblems, { tier: 'registered', env, complete: fakeCompleteFn(fake), rows });
    expect(outcome.calls.map((c) => c.purpose)).toEqual(['repair', ...Array(limits.llm.serverRepairRounds).fill('repair')]);
    expect(new Set(outcome.calls.map((c) => c.model)).size).toBe(1); // the first-try model throughout: no escalation
    expect(outcome.verified).toBe(false);
    expect(outcome.problems[0]).toMatchObject({ kind: 'formula' });
  });

  it('keeps the best of the round\'s attempts', async () => {
    const fake = createFakeProvider();
    fake.enqueue({ json: correctRulesWireJson() });
    fake.enqueue({ json: plusTen() });
    const outcome = await withServerRepairRounds(1, () =>
      repairFromBrowser(basicPayload(), wrongRoundingRules(), browserProblems, { tier: 'registered', env, complete: fakeCompleteFn(fake), rows: [...rows, { in: ['B3', 1], out: ['B3', 3] }] }),
    );
    // x2 gets only B3 wrong (a row no rule of this file fits); the server repair's answer (+10) gets all three rows wrong: the first is kept
    expect(outcome.calls).toHaveLength(2);
    expect(outcome.verified).toBe(false);
    expect(outcome.rules).toEqual(correctRules());
  });
});
