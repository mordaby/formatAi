// Completion mode on the API (LEARN_PROMPT "Completing a partial rules file"): the fixed lock inside the code checks (SPEC 9.2), the repair
// call that carries its findings, and the endpoint's rules for such a payload (validated, never cached).
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { completePayloadOf, formulaRulesToWire } from '@formatai/engine';
import { toWire, type LearnPayload, type LearnResult } from '@formatai/shared';
import { loadEnv } from '../../src/env.js';
import { learn, readCompleteFixed, runChecks, type CompleteFn } from '../../src/learn/index.js';
import { createFakeProvider, type CompleteRequest } from '../../src/llm/index.js';
import type { Identity } from '../../src/protection/identity.js';
import { createMemoryStore } from '../../src/protection/store.js';
import { buildServer } from '../../src/server.js';
import { basicPayload, correctRules, correctRulesWireJson } from './fixtures.js';

const env = loadEnv({ ...process.env, LLM_PROVIDER: 'fake' });

/** What the user has: ID is built, Total (output column 1) has no rule yet. */
function fixedRules(): LearnResult {
  const rules = correctRules();
  return {
    ...rules,
    transform: { ...rules.transform, computed: [] },
    output: { ...rules.output, columns: [rules.output.columns[0]!, { header: 'Total', from: null }] },
  };
}

function completePayload(over: Partial<LearnPayload> = {}): LearnPayload {
  return basicPayload({ complete: completePayloadOf({ fixedRules: fixedRules(), columns: [1], parts: [] }), ...over });
}

const wire = (rules: LearnResult): unknown => toWire(formulaRulesToWire(rules) as unknown as LearnResult);

describe('runChecks: the fixed lock (completion mode)', () => {
  it('an answer that only produces the listed column is clean, and runs on the samples', () => {
    const { problems, rules } = runChecks(correctRulesWireJson(), completePayload(), { tier: 'registered' });
    expect(problems).toEqual([]);
    expect(rules).toEqual(correctRules());
  });

  it('a changed fixed element is a fixedMismatch with a path and a message (and nothing else is reported for it)', () => {
    const answer = correctRules();
    answer.output.columns = [{ header: 'ID', from: 'id', format: '@' }, answer.output.columns[1]!];
    const { problems } = runChecks(wire(answer), completePayload(), { tier: 'registered' });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ kind: 'fixedMismatch', path: 'output.columns[0].format' });
  });

  it('a missing fixed input column, and a fixed element that is gone', () => {
    const answer = correctRules();
    answer.input.columns = [answer.input.columns[1]!];
    answer.output.columns = [{ header: 'ID', from: null }, answer.output.columns[1]!];
    answer.unsupported = [{ outputColumn: 'ID', reasonCode: 'other' }];
    const { problems } = runChecks(wire(answer), completePayload(), { tier: 'registered' });
    const fixed = problems.filter((p) => p.kind === 'fixedMismatch').map((p) => (p as { path: string }).path);
    expect(fixed).toEqual(expect.arrayContaining(['input.columns', 'output.columns[0].from']));
  });

  it('a listed column with no from and no unsupported entry: the fixed lock says so precisely, and the generic reference problem does not repeat it', () => {
    const { problems } = runChecks(wire(fixedRules()), completePayload(), { tier: 'registered' });
    expect(problems).toContainEqual(expect.objectContaining({ kind: 'fixedMismatch', path: 'output.columns[1].from' }));
    expect(problems.some((p) => p.kind === 'reference')).toBe(false);
  });

  it('every listed column reported as unsupported (and no listed part built) produced nothing: that is no completion', () => {
    const answer = fixedRules();
    answer.unsupported = [{ outputColumn: 'Total', reasonCode: 'ambiguous' }];
    const { problems } = runChecks(wire(answer), completePayload(), { tier: 'registered' });
    expect(problems).toEqual([expect.objectContaining({ kind: 'fixedMismatch', path: 'output.columns', message: expect.stringContaining('nothing that complete lists was produced') })]);
  });

  it('a listed column reported as unsupported is fine (and not compared with the samples) when something else that was listed is produced', () => {
    const answer = fixedRules();
    answer.unsupported = [{ outputColumn: 'Total', reasonCode: 'ambiguous' }];
    answer.transform.sort = [{ column: 'id', dir: 'asc' }];
    const payload = basicPayload({ complete: completePayloadOf({ fixedRules: fixedRules(), columns: [1], parts: ['sort'] }) });
    expect(runChecks(wire(answer), payload, { tier: 'registered' }).problems).toEqual([]);
  });

  it('only the listed columns are compared with the samples: the user-made rules may depart from the example', () => {
    const fixed = fixedRules();
    fixed.transform.valueMaps = [{ column: 'id', map: { A1: 'Z1', A2: 'Z2' }, onMissing: 'keep' }];
    const payload = basicPayload({ complete: completePayloadOf({ fixedRules: fixed, columns: [1], parts: [] }) });
    const answer = { ...correctRules(), transform: { ...correctRules().transform, valueMaps: fixed.transform.valueMaps } };
    expect(runChecks(wire(answer), payload, { tier: 'registered' }).problems).toEqual([]);
    // ... the very same answer in a plain learn is judged against every column
    const plain = runChecks(wire(answer), basicPayload(), { tier: 'registered' }).problems;
    expect(plain.some((p) => p.kind === 'diff' && p.out === 0)).toBe(true);
    // ... and a wrong listed column is still caught
    const wrong = { ...answer, transform: { ...answer.transform, computed: [{ id: 'total', type: 'decimal' as const, expr: { op: 'mul' as const, args: [{ col: 'amount' }, { const: 3 }] } }] } };
    expect(runChecks(wire(wrong), payload, { tier: 'registered' }).problems.some((p) => p.kind === 'diff' && p.out === 1)).toBe(true);
  });

  it('external columns (skipColumns) are not compared with the samples in completion mode', () => {
    const fixed = fixedRules();
    fixed.unsupported = [{ outputColumn: 'Total', reasonCode: 'externalData' }];
    const payload = basicPayload({ skipColumns: [1], complete: completePayloadOf({ fixedRules: fixed, columns: [], parts: ['sort'] }) });
    const answer = { ...fixed, transform: { ...fixed.transform, sort: [{ column: 'id', dir: 'asc' as const }] } };
    expect(runChecks(wire(answer), payload, { tier: 'registered' }).problems).toEqual([]);
  });

  it('a layout part that was not listed may not be added; a listed one may', () => {
    const answer = correctRules();
    answer.transform.sort = [{ column: 'id', dir: 'asc' }];
    expect(runChecks(wire(answer), completePayload(), { tier: 'registered' }).problems).toEqual([expect.objectContaining({ kind: 'fixedMismatch', path: 'transform.sort' })]);
    const listed = basicPayload({ complete: completePayloadOf({ fixedRules: fixedRules(), columns: [1], parts: ['sort'] }) });
    expect(runChecks(wire(answer), listed, { tier: 'registered' }).problems).toEqual([]);
  });

  it('a plain learn (no complete) is checked exactly as before', () => {
    const answer = correctRules();
    answer.output.columns = [{ header: 'ID', from: 'amount' }, answer.output.columns[1]!];
    const { problems } = runChecks(wire(answer), basicPayload(), { tier: 'registered' });
    expect(problems.some((p) => p.kind === 'fixedMismatch')).toBe(false);
  });
});

describe('readCompleteFixed', () => {
  it('reads complete.fixed back into the rules it was made from', () => {
    const payload = completePayload();
    expect(readCompleteFixed(payload.complete!)).toEqual(fixedRules());
  });

  it('is null for something that is not a rules file, or has a formula that does not parse', () => {
    expect(readCompleteFixed({ fixed: { nope: true } })).toBeNull();
    const bad = completePayload();
    (bad.complete!.fixed as { transform: { computed: unknown[] } }).transform.computed = [{ id: 'x', type: 'decimal', expr: 'round(' }];
    expect(readCompleteFixed(bad.complete!)).toBeNull();
  });
});

describe('learn() in completion mode', () => {
  it('a fixedMismatch is repaired like any other problem: the repair block carries it, and the repaired answer verifies', async () => {
    const fake = createFakeProvider();
    const broken = correctRules();
    broken.output.columns = [{ header: 'ID', from: 'amount' }, broken.output.columns[1]!];
    fake.enqueue({ json: wire(broken) });
    fake.enqueue({ json: correctRulesWireJson() });
    const completeFn: CompleteFn = (req: CompleteRequest) => fake.complete(req);

    const outcome = await learn(completePayload(), { tier: 'registered', env, complete: completeFn });

    expect(outcome.verified).toBe(true);
    expect(outcome.calls.map((c) => c.purpose)).toEqual(['learn', 'repair']);
    expect(outcome.calls[0]).toMatchObject({ outcome: 'needsRepair', problemCounts: expect.objectContaining({ fixedMismatch: 1 }) });
    // The first block is the payload, with complete.fixed in it; the second says what to fix.
    const repairCall = fake.calls[1]!;
    expect(repairCall.content[0]!.text).toContain('"complete"');
    expect(repairCall.content[1]!.text).toContain('"kind":"fixedMismatch"');
    expect(repairCall.content[1]!.text).toContain('output.columns[0].from');
  });
});

describe('POST /api/learn with a complete payload', () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  const USER = '00000000000000000000000a';
  const asUser = (req: FastifyRequest): Identity => ({ kind: 'user', userId: USER, tier: 'registered', anonId: req.anonId });
  const devEnv = () => loadEnv({ ...process.env, NODE_ENV: 'development', MONGODB_URI: '', LLM_PROVIDER: 'fake', TURNSTILE_SECRET_KEY: undefined });
  const post = (payload: unknown) =>
    app!.inject({ method: 'POST', url: '/api/learn', payload: JSON.stringify({ payload }), headers: { 'content-type': 'application/json' } });

  it('refuses a complete.fixed that is not a rules file (400), and a bad column list', async () => {
    app = await buildServer({ env: devEnv(), db: null, logger: false, identify: asUser });
    const bad = completePayload();
    (bad.complete as { fixed: unknown }).fixed = { schemaVersion: 1 };
    const res = await post(bad);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'invalidPayload' });

    const negative = completePayload();
    negative.complete!.columns = [-1];
    expect((await post(negative)).statusCode).toBe(400);
    const unknownPart = completePayload();
    (unknownPart.complete!.parts as string[]).push('everything');
    expect((await post(unknownPart)).statusCode).toBe(400);
  });

  it('never touches the structure cache: neither served from it nor written to it', async () => {
    const fake = createFakeProvider();
    fake.enqueue({ json: correctRulesWireJson() }); // the completion
    fake.enqueue({ json: correctRulesWireJson() }); // a plain learn of the same structure afterwards
    fake.enqueue({ json: correctRulesWireJson() }); // the completion again
    const store = createMemoryStore();
    app = await buildServer({ env: devEnv(), db: null, logger: false, store, identify: asUser, complete: (req: CompleteRequest) => fake.complete(req) });

    const first = await post(completePayload());
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ verified: true, cached: false });
    // A plain learn of the same example structure finds nothing saved by the completion: it makes its own call.
    const plain = await post(basicPayload());
    expect(plain.json()).toMatchObject({ verified: true, cached: false });
    expect(fake.calls).toHaveLength(2);
    // ... and a second completion is not served from the plain learn's entry either.
    const again = await post(completePayload());
    expect(again.json()).toMatchObject({ verified: true, cached: false });
    expect(fake.calls).toHaveLength(3);
    // The ledger has a real call for each (no cache hit anywhere).
    expect(store.ledger.map((d) => d.cacheHit)).toEqual([false, false, false]);
  });

  it('counts like any other learn: the quota unit is used when the answer verifies', async () => {
    const fake = createFakeProvider();
    fake.enqueue({ json: correctRulesWireJson() });
    app = await buildServer({ env: devEnv(), db: null, logger: false, store: createMemoryStore(), identify: asUser, complete: (req: CompleteRequest) => fake.complete(req) });
    const res = await post(completePayload());
    expect(res.json()).toMatchObject({ verified: true, counted: true, quota: { remaining: 2, period: 'month' } });
  });
});
