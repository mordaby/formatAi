// The overfitting guards on the API (SPEC 9.2 layer 6, 21 v12 item 19): a rule that copies particular rows of the example - here the shape
// learn-v8 wrote for a hand-edited row, `if(rowNumber() = 1, 0, ...)` - becomes ONE `overfit` repair problem per learn; an answer that still
// has it after that repair gets the column reported as unsupported by code (reason `overfit`), never counted as verified; both are counted
// in the call records. The guards themselves are tested in packages/engine/test/learn/overfit.test.ts.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { completePayloadOf, formulaRulesToWire, parseFormula } from '@formatai/engine';
import { toWire, type Expr, type LearnPayload, type LearnResult, type RepairBlock } from '@formatai/shared';
import { loadEnv } from '../../src/env.js';
import { createFakeProvider, type CompleteRequest, type FakeLlmProvider } from '../../src/llm/index.js';
import { learn, repairFromBrowser, runChecks, type CompleteFn } from '../../src/learn/index.js';
import { overfitLint } from '../../src/learn/overfitLint.js';
import type { Identity } from '../../src/protection/identity.js';
import { createMemoryStore } from '../../src/protection/store.js';
import { buildServer } from '../../src/server.js';
import { basicPayload, correctRules } from './fixtures.js';

const env = loadEnv({ ...process.env, LLM_PROVIDER: 'fake' });

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});
const fakeCompleteFn = (fake: FakeLlmProvider): CompleteFn => (req: CompleteRequest) => fake.complete(req);
const wire = (rules: LearnResult): unknown => toWire(formulaRulesToWire(rules) as unknown as LearnResult);
const f = (text: string): Expr => {
  const parsed = parseFormula(text, { allowWindows: true });
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.expr;
};

/** Order ID, Amount -> Order ID, Discount: 10% of the amount, except the first row, which was edited by hand to 0. */
function discountPayload(): LearnPayload {
  const p = basicPayload();
  return {
    ...p,
    input: { ...p.input, columns: [{ i: 0, header: 'Order ID', type: 'idLike' }, { i: 1, header: 'Amount', type: 'decimal' }] },
    output: { ...p.output, columns: [{ i: 0, header: 'Order ID', type: 'idLike' }, { i: 1, header: 'Discount', type: 'decimal' }] },
    samples: [
      { in: ['SO-1', 3200], out: ['SO-1', 0] },
      { in: ['SO-2', 450], out: ['SO-2', 45] },
      { in: ['SO-3', 1200], out: ['SO-3', 120] },
      { in: ['SO-4', 80], out: ['SO-4', 8] },
    ],
  };
}

function discountRules(formula: string): LearnResult {
  return {
    ...correctRules(),
    input: { sheet: { pick: 'first' }, headerRow: 'auto', columns: [{ id: 'orderId', header: 'Order ID', type: 'idLike' }, { id: 'amount', header: 'Amount', type: 'decimal' }] },
    transform: { computed: [{ id: 'discount', type: 'decimal', expr: f(formula) }], valueMaps: [], sort: [] },
    output: { sheetName: 'Out', direction: 'ltr', language: 'en', titleRows: [], columns: [{ header: 'Order ID', from: 'orderId' }, { header: 'Discount', from: 'discount' }] },
  };
}

/** The learn-v8 answer: the hand-edited row fitted by its position. (Over the sample rows a window column is never compared, so nothing else
 * would ever have caught it here.) */
const BY_POSITION = 'if(rowNumber() = 1, 0, round(amount * 0.1, 2))';
/** The honest rule: wrong on the hand-edited row, right on every other. */
const HONEST = 'round(amount * 0.1, 2)';

describe('runChecks: layer 6a, the overfitting guards', () => {
  it('repair (the default): one overfit problem for the column, in plain words', () => {
    const { problems, rules, overfitFallbacks } = runChecks(wire(discountRules(BY_POSITION)), discountPayload(), { tier: 'registered' });
    expect(problems).toEqual([
      {
        kind: 'overfit',
        out: 1,
        message: 'Column "Discount": this rule copies particular rows of the example (it compares a row position (rowNumber or rank) with a constant); write a rule that holds for any row, or report the column as unsupported.',
      },
    ]);
    expect(rules?.output.columns[1]).toEqual({ header: 'Discount', from: 'discount' });
    expect(overfitFallbacks).toBe(0);
  });

  it('fallBack: the column is reported as unsupported by code, its rule taken out, and the rest checked as usual', () => {
    const { problems, rules, overfitFallbacks } = runChecks(wire(discountRules(BY_POSITION)), discountPayload(), { tier: 'registered', overfit: 'fallBack' });
    expect(problems).toEqual([]);
    expect(rules?.output.columns).toEqual([{ header: 'Order ID', from: 'orderId' }, { header: 'Discount', from: null }]);
    expect(rules?.unsupported).toEqual([{ outputColumn: 'Discount', reasonCode: 'overfit' }]);
    expect(rules?.transform.computed).toEqual([]);
    expect(overfitFallbacks).toBe(1);
  });

  it('a column code reported (reason overfit) is never sent back as "unsupported despite evidence", even with a hint for it', () => {
    const p: LearnPayload = { ...discountPayload(), hints: [{ out: 1, rel: 'mulConst', in: [1], const: 0.1, round: 2, coverage: 0.75, failsOn: [0] }] };
    const { problems } = runChecks(wire(discountRules(BY_POSITION)), p, { tier: 'registered', overfit: 'fallBack' });
    expect(problems).toEqual([]);
  });

  it('completion mode: only the columns the AI step was asked for - a fixed column of the user\'s own is never a finding', () => {
    const fixed = discountRules('if(rowNumber() = 1, 0, round(amount * 0.1, 2))');
    const fixedRules: LearnResult = { ...fixed, transform: { ...fixed.transform, computed: [{ id: 'firstId', type: 'text', expr: f('if(rowNumber() = 1, orderId, orderId)') }] }, output: { ...fixed.output, columns: [{ header: 'Order ID', from: 'firstId' }, { header: 'Discount', from: null }] } };
    const payload = { ...discountPayload(), complete: completePayloadOf({ fixedRules, columns: [1], parts: [] }) };
    const answer: LearnResult = { ...fixedRules, transform: { ...fixedRules.transform, computed: [...fixedRules.transform.computed, { id: 'discount', type: 'decimal', expr: f(HONEST) }] }, output: { ...fixedRules.output, columns: [fixedRules.output.columns[0]!, { header: 'Discount', from: 'discount' }] } };
    const { problems } = runChecks(wire(answer), payload, { tier: 'registered' });
    expect(problems.map((p) => p.kind)).toEqual(['diff']); // the hand-edited row, nothing about the user's own position rule
  });
});

describe('layer 6b, the overfitting lint: a cut-off constant is never a "Please check" line', () => {
  it('a correct threshold rule whose cut-off equals an amount of one sample row is not flagged (the false positive the lint gave in the browser)', () => {
    const p: LearnPayload = {
      ...discountPayload(),
      output: { ...discountPayload().output, columns: [{ i: 0, header: 'Order ID', type: 'idLike' }, { i: 1, header: 'Priority', type: 'text' }] },
      samples: [
        { in: ['SO-1', 5000], out: ['SO-1', 'Urgent'] },
        { in: ['SO-2', 450], out: ['SO-2', 'Normal'] },
        { in: ['SO-3', 7200], out: ['SO-3', 'Urgent'] },
      ],
    };
    const rules = discountRules('if(amount >= 5000, "Urgent", "Normal")');
    rules.transform.computed[0]!.type = 'text';
    rules.output.columns[1] = { header: 'Priority', from: 'discount' };
    expect(overfitLint(rules, p)).toEqual([]);
    // A filter cut-off neither; an equality with a one-row value still is (it stays a "Please check" line, never a repair).
    expect(overfitLint({ ...rules, input: { ...rules.input, rowFilters: [{ column: 'amount', op: 'gte', value: 5000 }] } }, p)).toEqual([]);
    expect(overfitLint(discountRules('if(orderId = "SO-2", 0, round(amount * 0.1, 2))'), p)).toEqual([{ reasonCode: 'overfitSuspected', outputColumn: 'Discount' }]);
  });

  it('a "Please check" line the answer already carries is not added twice', () => {
    const rules = { ...discountRules('if(orderId = "SO-2", 0, round(amount * 0.1, 2))'), assumptions: [{ reasonCode: 'overfitSuspected' as const, outputColumn: 'Discount' }] };
    const checked = runChecks(wire(rules), discountPayload(), { tier: 'registered' });
    expect(checked.rules?.assumptions).toEqual([{ reasonCode: 'overfitSuspected', outputColumn: 'Discount' }]);
  });
});

/** The repair block a call sent (its second content block, before the instruction line). */
function repairBlockOf(fake: FakeLlmProvider, call: number): RepairBlock {
  const text = fake.calls[call]!.content[1]!.text;
  return JSON.parse(text.slice(0, text.lastIndexOf('\n'))) as RepairBlock;
}

describe('learn(): one repair for a rule that copies rows, then the honest fallback', () => {
  it('the repair asks once; an answer that still copies rows gets the column reported as unsupported (not verified by a copy), and no further call', async () => {
    const fake = createFakeProvider();
    fake.enqueue({ json: wire(discountRules(BY_POSITION)) });
    fake.enqueue({ json: wire(discountRules(BY_POSITION)) });
    const outcome = await learn(discountPayload(), { tier: 'registered', env, complete: fakeCompleteFn(fake) });

    expect(fake.calls).toHaveLength(2);
    expect(repairBlockOf(fake, 1).problems.map((p) => p.kind)).toEqual(['overfit']);
    expect(outcome.calls.map((c) => [c.purpose, c.outcome, c.problemCounts.overfit, c.problemCounts.overfitFallback])).toEqual([
      ['learn', 'needsRepair', 1, 0],
      ['repair', 'verified', 0, 1],
    ]);
    expect(outcome.rules?.output.columns[1]).toEqual({ header: 'Discount', from: null });
    expect(outcome.rules?.unsupported).toEqual([{ outputColumn: 'Discount', reasonCode: 'overfit' }]);
    expect(outcome.overfitRepaired).toBe(true);
  });

  it('a repaired answer with the honest rule is kept, although the hand-edited row now differs (fewer problems never beat it)', async () => {
    const fake = createFakeProvider();
    fake.enqueue({ json: wire(discountRules(BY_POSITION)) });
    fake.enqueue({ json: wire(discountRules(HONEST)) });
    const outcome = await learn(discountPayload(), { tier: 'registered', env, complete: fakeCompleteFn(fake), noEscalation: true });

    expect(outcome.rules?.transform.computed[0]!.expr).toEqual(f(HONEST));
    expect(outcome.problems.map((p) => p.kind)).toEqual(['diff']);
    expect(outcome.verified).toBe(false);
    expect(outcome.overfitRepaired).toBe(true);
  });

  it('the escalation of a learn that had the repair falls back at once (it gets no repair of its own)', async () => {
    // The repair still copies rows AND gets Order ID wrong: after its fallback a diff is left, so the escalation runs.
    const wrongId = discountRules(BY_POSITION);
    wrongId.transform.computed.push({ id: 'oid', type: 'text', expr: f('concat(orderId, "x")') });
    wrongId.output.columns[0] = { header: 'Order ID', from: 'oid' };
    const fake = createFakeProvider();
    fake.enqueue({ json: wire(discountRules(BY_POSITION)) });
    fake.enqueue({ json: wire(wrongId) });
    fake.enqueue({ json: wire(discountRules(BY_POSITION)) });
    const outcome = await learn(discountPayload(), { tier: 'registered', env, complete: fakeCompleteFn(fake) });

    expect(outcome.calls.map((c) => [c.purpose, c.problemCounts.overfit, c.problemCounts.overfitFallback])).toEqual([
      ['learn', 1, 0],
      ['repair', 0, 1],
      ['escalation', 0, 1],
    ]);
    expect(fake.calls[2]!.content).toHaveLength(1); // a fresh call, no repair block
    expect(outcome.problems).toEqual([]);
    expect(outcome.rules?.output.columns).toEqual([{ header: 'Order ID', from: 'orderId' }, { header: 'Discount', from: null }]);
  });

  it('a learn whose one repair was already made (overfitRepaired) falls back at once: one call, verified, counted', async () => {
    const fake = createFakeProvider();
    fake.enqueue({ json: wire(discountRules(BY_POSITION)) });
    const outcome = await learn(discountPayload(), { tier: 'registered', env, complete: fakeCompleteFn(fake), overfitRepaired: true });
    expect(fake.calls).toHaveLength(1);
    expect(outcome.verified).toBe(true);
    expect(outcome.rules?.unsupported).toEqual([{ outputColumn: 'Discount', reasonCode: 'overfit' }]);
    expect(outcome.calls[0]!.problemCounts).toMatchObject({ overfit: 0, overfitFallback: 1 });
  });
});

describe('repairFromBrowser(): a loop round', () => {
  it('a round that carries the overfit problem is the learn\'s one repair: its answer falls back, and the outcome says the repair was made', async () => {
    const fake = createFakeProvider();
    fake.enqueue({ json: wire(discountRules(BY_POSITION)) });
    const problem = runChecks(wire(discountRules(BY_POSITION)), discountPayload(), { tier: 'registered' }).problems;
    const outcome = await repairFromBrowser(discountPayload(), discountRules(BY_POSITION), problem, { tier: 'registered', env, complete: fakeCompleteFn(fake) });
    expect(fake.calls).toHaveLength(1);
    expect(outcome.rules?.unsupported).toEqual([{ outputColumn: 'Discount', reasonCode: 'overfit' }]);
    expect(outcome.overfitRepaired).toBe(true);
  });

  it('a round of a learn that already had it (RepairRequest.overfitRepaired) never asks again', async () => {
    const fake = createFakeProvider();
    fake.enqueue({ json: wire(discountRules(BY_POSITION)) });
    const outcome = await repairFromBrowser(discountPayload(), discountRules(HONEST), [], { tier: 'registered', env, complete: fakeCompleteFn(fake), overfitRepaired: true });
    expect(fake.calls).toHaveLength(1);
    expect(outcome.problems).toEqual([]);
    expect(outcome.rules?.unsupported).toEqual([{ outputColumn: 'Discount', reasonCode: 'overfit' }]);
  });

  it('the routes: POST /api/learn answers overfitRepaired; POST /api/learn/repair with it falls back at once', async () => {
    const asUser = (req: FastifyRequest): Identity => ({ kind: 'user', userId: '00000000000000000000000a', tier: 'registered', anonId: req.anonId });
    const fake = createFakeProvider();
    for (let i = 0; i < 3; i++) fake.enqueue({ json: wire(discountRules(BY_POSITION)) });
    app = await buildServer({
      env: loadEnv({ ...process.env, NODE_ENV: 'development', MONGODB_URI: '', LLM_PROVIDER: 'fake', TURNSTILE_SECRET_KEY: undefined }),
      db: null,
      logger: false,
      store: createMemoryStore(),
      identify: asUser,
      complete: (req: CompleteRequest) => fake.complete(req),
    });
    const post = (url: string, body: unknown) => app!.inject({ method: 'POST', url, payload: JSON.stringify(body), headers: { 'content-type': 'application/json' } });

    const learned = (await post('/api/learn', { payload: discountPayload() })).json();
    expect(learned).toMatchObject({ verified: true, overfitRepaired: true });
    expect(learned.rules.unsupported).toEqual([{ outputColumn: 'Discount', reasonCode: 'overfit' }]);

    const round = (await post('/api/learn/repair', { payload: discountPayload(), previousRules: discountRules(HONEST), problems: [], learnId: learned.learnId, overfitRepaired: true })).json();
    expect(fake.calls).toHaveLength(3);
    expect(round).toMatchObject({ verified: true, overfitRepaired: true, problems: [] });
    expect(round.rules.unsupported).toEqual([{ outputColumn: 'Discount', reasonCode: 'overfit' }]);
  });

  it('a round with no overfit problem, for a learn that never had the repair, may still ask for it', async () => {
    const fake = createFakeProvider();
    fake.enqueue({ json: wire(discountRules(BY_POSITION)) });
    fake.enqueue({ json: wire(discountRules(HONEST)) });
    const outcome = await repairFromBrowser(discountPayload(), discountRules(HONEST), [], { tier: 'registered', env, complete: fakeCompleteFn(fake) });
    expect(repairBlockOf(fake, 1).problems.map((p) => p.kind)).toEqual(['overfit']);
    expect(outcome.overfitRepaired).toBe(true);
    expect(outcome.rules?.transform.computed[0]!.expr).toEqual(f(HONEST));
  });
});
