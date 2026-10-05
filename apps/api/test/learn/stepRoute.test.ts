// AI code checks (learn-v9, SPEC 21 v14): POST /api/learn answering with checks, POST /api/learn/step (the signed token, the step counter,
// the rounds' shape and the payload byte cap, the quota counted once on success), who gets learn-v9 (LEARN_CHECKS off / admin / all), the
// ledger's `check` purpose, and the structure cache never storing a learn whose rounds are non-empty.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { LEARN_SYSTEM_PROMPT_V7, LEARN_SYSTEM_PROMPT_V9, limits, type Check, type CheckRound, type LearnPayload } from '@formatai/shared';
import { loadEnv } from '../../src/env.js';
import { createFakeProvider, type CompleteRequest, type FakeLlmProvider } from '../../src/llm/index.js';
import type { Identity } from '../../src/protection/identity.js';
import { createMemoryStore, type MemoryStore } from '../../src/protection/store.js';
import { buildServer } from '../../src/server.js';
import { basicPayload, correctRulesWireJson } from './fixtures.js';

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

const USER = '00000000000000000000000b';
const asUser =
  (isAdmin = false) =>
  (req: FastifyRequest): Identity => ({ kind: 'user', userId: USER, tier: 'registered', anonId: req.anonId, isAdmin });

const envWith = (learnChecks: string | undefined) =>
  loadEnv({ ...process.env, NODE_ENV: 'development', MONGODB_URI: '', LLM_PROVIDER: 'fake', TURNSTILE_SECRET_KEY: undefined, LEARN_CHECKS: learnChecks });

const CHECK: Check = { check: 'ranges', column: 'Total', by: 'in1' };
const ROUND = (n: number): CheckRound => ({ checks: [CHECK], answers: [{ rows: 2, noValue: 0, clean: true, runs: [{ from: 5, to: 10, value: 10 + n, rows: 2 }] }] });
const asksChecks = { json: { checks: [CHECK], rules: null } };
const answersRules = () => ({ json: { checks: null, rules: correctRulesWireJson() } });

interface Ctx {
  app: FastifyInstance;
  fake: FakeLlmProvider;
  store: MemoryStore;
}

async function start(learnChecks: string | undefined, admin = false): Promise<Ctx> {
  const fake = createFakeProvider();
  const store = createMemoryStore();
  app = await buildServer({ env: envWith(learnChecks), db: null, logger: false, store, identify: asUser(admin), complete: (req: CompleteRequest) => fake.complete(req) });
  return { app, fake, store };
}

const post = (a: FastifyInstance, url: string, body: unknown) => a.inject({ method: 'POST', url, payload: JSON.stringify(body), headers: { 'content-type': 'application/json' } });

describe('who gets learn-v9 (LEARN_CHECKS)', () => {
  it('off (the default): learn-v7, as before, and no step', async () => {
    const { app: a, fake } = await start(undefined);
    fake.enqueue({ json: correctRulesWireJson() });
    const res = await post(a, '/api/learn', { payload: basicPayload() });
    expect(res.statusCode).toBe(200);
    expect(fake.calls[0]!.system).toBe(LEARN_SYSTEM_PROMPT_V7);
    const step = await post(a, '/api/learn/step', { token: res.json().learnId, payload: basicPayload(), rounds: [ROUND(1)] });
    expect(step.statusCode).toBe(400);
    expect(step.json()).toEqual({ error: 'invalidRequest' });
  });

  it('admin: only an admin gets learn-v9', async () => {
    const user = await start('admin', false);
    user.fake.enqueue({ json: correctRulesWireJson() });
    await post(user.app, '/api/learn', { payload: basicPayload() });
    expect(user.fake.calls[0]!.system).toBe(LEARN_SYSTEM_PROMPT_V7);
    await app!.close();
    const admin = await start('admin', true);
    admin.fake.enqueue(answersRules());
    const res = await post(admin.app, '/api/learn', { payload: basicPayload() });
    expect(res.json().verified).toBe(true);
    expect(admin.fake.calls[0]!.system).toBe(LEARN_SYSTEM_PROMPT_V9);
  });

  it('all: everyone; a typo (any other value) is off here (and stops a production start)', async () => {
    const all = await start('all');
    all.fake.enqueue(answersRules());
    await post(all.app, '/api/learn', { payload: basicPayload() });
    expect(all.fake.calls[0]!.system).toBe(LEARN_SYSTEM_PROMPT_V9);
    await app!.close();
    const typo = await start('yes', true);
    typo.fake.enqueue({ json: correctRulesWireJson() });
    await post(typo.app, '/api/learn', { payload: basicPayload() });
    expect(typo.fake.calls[0]!.system).toBe(LEARN_SYSTEM_PROMPT_V7);
  });
});

describe('POST /api/learn answering with checks, then POST /api/learn/step', () => {
  it('checks: no rules, nothing counted, the learnId to step with; the step brings the rules and the learn counts once', async () => {
    const { app: a, fake, store } = await start('all');
    fake.enqueue(asksChecks);
    const first = await post(a, '/api/learn', { payload: basicPayload() });
    expect(first.statusCode).toBe(200);
    const body = first.json();
    expect(body).toMatchObject({ rules: null, checks: [CHECK], verified: false, problems: [], cached: false, counted: false, quota: { remaining: 3 } });
    expect(body.learnId).toEqual(expect.any(String));
    expect(store.ledger).toHaveLength(1);
    expect(store.ledger[0]).toMatchObject({ purpose: 'check', outcome: 'checks', promptVersion: 'learn-v9', checks: { asked: 1, dropped: 0 } });
    // nothing cached for a checks answer
    expect(store.cacheEntries.size).toBe(0);

    fake.enqueue(answersRules());
    const step = await post(a, '/api/learn/step', { token: body.learnId, payload: basicPayload(), rounds: [ROUND(1)] });
    expect(step.statusCode).toBe(200);
    expect(step.json()).toMatchObject({ verified: true, problems: [], counted: true, quota: { remaining: 2 } });
    expect(step.json().rules).toBeTruthy();
    expect(step.json().checks).toBeUndefined();
    // the step's call carried the payload and the round
    expect(fake.calls[1]!.content.map((c) => c.cache === true)).toEqual([true, true]);
    expect(JSON.parse(fake.calls[1]!.content[1]!.text)).toMatchObject({ round: 1, checks: [CHECK] });
    expect(store.ledger.map((d) => [d.purpose, d.outcome, d.learnId === store.ledger[0]!.learnId])).toEqual([
      ['check', 'checks', true],
      ['learn', 'verified', true],
    ]);
    // a learn whose rounds are non-empty is never stored in the structure cache
    expect(store.cacheEntries.size).toBe(0);
  });

  it('a step that asks more checks counts nothing either', async () => {
    const { app: a, fake } = await start('all');
    fake.enqueue(asksChecks);
    const { learnId } = (await post(a, '/api/learn', { payload: basicPayload() })).json();
    fake.enqueue(asksChecks);
    const step = await post(a, '/api/learn/step', { token: learnId, payload: basicPayload(), rounds: [ROUND(1)] });
    expect(step.json()).toMatchObject({ rules: null, checks: [CHECK], counted: false, quota: { remaining: 3 } });
  });

  it('the token must be a learn of this owner: a forged one is refused before any call', async () => {
    const { app: a, fake } = await start('all');
    const res = await post(a, '/api/learn/step', { token: 'nope', payload: basicPayload(), rounds: [ROUND(1)] });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'invalidLearnId' });
    expect(fake.calls).toHaveLength(0);
  });

  it(`at most ${limits.learn.checks.maxRounds} steps per learn; a step may not skip ahead`, async () => {
    const { app: a, fake } = await start('all');
    fake.enqueue(asksChecks);
    const { learnId } = (await post(a, '/api/learn', { payload: basicPayload() })).json();
    const skip = await post(a, '/api/learn/step', { token: learnId, payload: basicPayload(), rounds: [ROUND(1), ROUND(2)] });
    expect(skip.statusCode).toBe(400);
    expect(skip.json()).toEqual({ error: 'invalidRounds' });
    const rounds: CheckRound[] = [];
    for (let i = 1; i <= limits.learn.checks.maxRounds; i++) {
      rounds.push(ROUND(i));
      fake.enqueue(i < limits.learn.checks.maxRounds ? asksChecks : answersRules());
      const step = await post(a, '/api/learn/step', { token: learnId, payload: basicPayload(), rounds });
      expect(step.statusCode).toBe(200);
    }
    const calls = fake.calls.length;
    const over = await post(a, '/api/learn/step', { token: learnId, payload: basicPayload(), rounds });
    expect(over.statusCode).toBe(429);
    expect(over.json()).toEqual({ error: 'limitHit', limit: 'stepsPerLearn' });
    expect(fake.calls).toHaveLength(calls);
  });

  it('the rounds are validated: shape, count, and the payload byte cap on the whole body', async () => {
    const { app: a, fake } = await start('all');
    fake.enqueue(asksChecks);
    const { learnId } = (await post(a, '/api/learn', { payload: basicPayload() })).json();
    const bad = await post(a, '/api/learn/step', { token: learnId, payload: basicPayload(), rounds: [{ checks: [CHECK], answers: [] }] });
    expect(bad.json()).toEqual({ error: 'invalidRounds' });
    const none = await post(a, '/api/learn/step', { token: learnId, payload: basicPayload(), rounds: [] });
    expect(none.json()).toEqual({ error: 'invalidRounds' });
    // a payload near the byte cap: the same round no longer fits
    const near: LearnPayload = { ...basicPayload(), hints: [{ rel: 'note', text: 'x'.repeat(limits.payload.maxBytes - 1200) } as never] };
    const heavy: CheckRound = { checks: [{ ...CHECK, column: 'c'.repeat(200) }], answers: [{ error: 'e'.repeat(300) }], dropped: Array.from({ length: 4 }, () => 'd'.repeat(300)) };
    const big = await post(a, '/api/learn/step', { token: learnId, payload: near, rounds: [heavy] });
    expect(big.statusCode).toBe(400);
    expect(big.json()).toEqual({ error: 'invalidRounds' });
    expect(fake.calls).toHaveLength(1);
  });
});

describe('the learning loop of a learn-v9 learn', () => {
  it('its repairs are sent learn-v9 too (same system prompt and schema)', async () => {
    const { app: a, fake } = await start('all');
    fake.enqueue(answersRules());
    const { learnId, rules } = (await post(a, '/api/learn', { payload: basicPayload() })).json();
    fake.enqueue(answersRules());
    const repair = await post(a, '/api/learn/repair', { learnId, payload: basicPayload(), previousRules: rules, problems: [] });
    expect(repair.statusCode).toBe(200);
    expect(fake.calls[1]!.system).toBe(LEARN_SYSTEM_PROMPT_V9);
    expect(fake.calls[1]!.schema).toEqual(fake.calls[0]!.schema);
  });
});
