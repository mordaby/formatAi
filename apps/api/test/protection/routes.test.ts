// The API protections end to end (fastify inject): anonId cookie, Turnstile, per-tier learn limits,
// repair-once, budgets, the owner-scoped structure cache, the per-IP rate limit and production mode.
// Every suite runs against the in-memory store, and against a real local MongoDB when MONGODB_URI is set.
import { limits, tiers } from '@formatai/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { dayKey } from '../../src/protection/keys.js';
import { basicPayload, wrongRoundingWireJson } from '../learn/fixtures.js';
import {
  anonCookie,
  createHarness,
  makeComplete,
  makeTurnstileFetch,
  memoryKit,
  mongoKit,
  mongoUri,
  nextIp,
  rulesWithTextConstantWireJson,
  useKit,
  type Harness,
  type StoreKit,
} from './harness.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function defineProtectionSuite(kit: StoreKit): void {
  useKit(kit);

  let harness: Harness | undefined;
  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });

  async function setup(opts: Parameters<typeof createHarness>[1] = {}): Promise<Harness> {
    harness = await createHarness(kit, opts);
    return harness;
  }

  // ---------- GET /api/session and the anonId cookie ----------

  describe('anonId cookie and GET /api/session (SPEC 12)', () => {
    it('sets a random httpOnly, SameSite=Lax first-party cookie on first contact', async () => {
      const h = await setup();
      const res = await h.get('/api/session');

      expect(res.statusCode).toBe(200);
      const raw = String(res.headers['set-cookie']);
      expect(raw).toMatch(/^anonId=[A-Za-z0-9_-]{16,64};/);
      expect(raw).toMatch(/HttpOnly/i);
      expect(raw).toMatch(/SameSite=Lax/i);
      expect(raw).toMatch(/Path=\//);
      expect(raw).toMatch(/Max-Age=\d+/);
      expect(raw).not.toMatch(/Secure/i); // development: plain http is fine
    });

    it('returns no user data: the free tier, its limits, and the Turnstile site key when configured', async () => {
      const h = await setup({ env: { VITE_TURNSTILE_SITE_KEY: 'site-key-123' } });
      const res = await h.get('/api/session');
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.json()).toEqual({
        anonId: true,
        tier: 'free',
        limits: JSON.parse(JSON.stringify(tiers.anonymous)),
        turnstileSiteKey: 'site-key-123',
      });
    });

    it('omits turnstileSiteKey when none is configured, and prefers TURNSTILE_SITE_KEY over the Vite one', async () => {
      const none = await setup();
      expect((await none.get('/api/session')).json()).not.toHaveProperty('turnstileSiteKey');
      await none.close();

      const both = await setup({ env: { TURNSTILE_SITE_KEY: 'api-key', VITE_TURNSTILE_SITE_KEY: 'vite-key' } });
      expect((await both.get('/api/session')).json().turnstileSiteKey).toBe('api-key');
    });

    it('sets the cookie only once: a visitor who sends it back is not given a new one', async () => {
      const h = await setup();
      const first = await h.get('/api/session');
      const cookie = anonCookie(first);

      const second = await h.get('/api/session', { cookie });
      expect(second.headers['set-cookie']).toBeUndefined();
      expect(second.json().anonId).toBe(true);
    });

    it('replaces a malformed cookie instead of trusting it (no key injection through the anonId)', async () => {
      const h = await setup();
      const res = await h.get('/api/session', { cookie: 'anonId=evil:2026-01-01' });
      expect(String(res.headers['set-cookie'])).toMatch(/^anonId=[A-Za-z0-9_-]{16,64};/);
    });

    it('gives different visitors different ids', async () => {
      const h = await setup();
      const a = anonCookie(await h.get('/api/session'));
      const b = anonCookie(await h.get('/api/session'));
      expect(a).not.toBe(b);
    });

    it('does not hand the health check a cookie', async () => {
      const h = await setup();
      const res = await h.get('/api/health');
      expect(res.statusCode).toBe(200);
      expect(res.headers['set-cookie']).toBeUndefined();
    });

    it("counts a visitor's learns under their anonId: the same cookie shares one daily counter", async () => {
      const llm = makeComplete();
      const h = await setup({ complete: llm.fn });
      const cookie = anonCookie(await h.get('/api/session'));
      const id = cookie.slice('anonId='.length);

      await h.learn({ noCache: true }, { cookie });
      expect(await h.handle.counter(`anon:${id}:${dayKey(h.clock.current)}`)).toBe(1);
    });
  });

  // ---------- Turnstile ----------

  describe('Turnstile (SPEC 9.5)', () => {
    it('requires a token for anonymous learns when a secret is configured', async () => {
      const llm = makeComplete();
      const ts = makeTurnstileFetch(['good']);
      const h = await setup({ env: { TURNSTILE_SECRET_KEY: 'secret' }, complete: llm.fn, fetch: ts.fn });

      const res = await h.learn({ turnstileToken: undefined });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: 'turnstileFailed' });
      expect(llm.calls).toHaveLength(0);
      expect(ts.calls).toHaveLength(0);
    });

    it('rejects a token Cloudflare refuses, and never counts that as a learn', async () => {
      const llm = makeComplete();
      const ts = makeTurnstileFetch(['good']);
      const h = await setup({ env: { TURNSTILE_SECRET_KEY: 'secret' }, complete: llm.fn, fetch: ts.fn });
      const cookie = anonCookie(await h.get('/api/session'));

      const res = await h.learn({ turnstileToken: 'forged' }, { cookie });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: 'turnstileFailed' });
      expect(llm.calls).toHaveLength(0);
      expect(await h.handle.counter(`anon:${cookie.slice(7)}:${dayKey(h.clock.current)}`)).toBe(0);
    });

    it('accepts a valid token and verifies it server-side against the siteverify endpoint', async () => {
      const llm = makeComplete();
      const ts = makeTurnstileFetch(['good']);
      const h = await setup({ env: { TURNSTILE_SECRET_KEY: 'secret' }, complete: llm.fn, fetch: ts.fn });

      const res = await h.learn({ turnstileToken: 'good' }, { ip: '203.0.113.9' });
      expect(res.statusCode).toBe(200);
      expect(res.json().verified).toBe(true);
      expect(ts.calls).toHaveLength(1);
      expect(ts.calls[0]!.url).toMatch(/challenges\.cloudflare\.com\/turnstile\/v0\/siteverify$/);
      expect(ts.calls[0]!.body.get('secret')).toBe('secret');
      expect(ts.calls[0]!.body.get('remoteip')).toBe('203.0.113.9');
    });

    it('is skipped (with a warning) when the secret is unset and NODE_ENV is not production', async () => {
      const llm = makeComplete();
      const h = await setup({ complete: llm.fn });
      const res = await h.learn({ turnstileToken: undefined });
      expect(res.statusCode).toBe(200);
      expect(llm.calls).toHaveLength(1);
    });

    it('is checked after the body shape (a malformed request never costs a siteverify call)', async () => {
      const ts = makeTurnstileFetch(['good']);
      const h = await setup({ env: { TURNSTILE_SECRET_KEY: 'secret' }, fetch: ts.fn });
      const res = await h.learn({ payload: { not: 'a payload' } });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: 'invalidPayload' });
      expect(ts.calls).toHaveLength(0);
    });

    it('is also required for a cache hit', async () => {
      const llm = makeComplete();
      const ts = makeTurnstileFetch(['good']);
      const h = await setup({ env: { TURNSTILE_SECRET_KEY: 'secret' }, complete: llm.fn, fetch: ts.fn });
      const cookie = anonCookie(await h.get('/api/session'));
      expect((await h.learn({}, { cookie })).statusCode).toBe(200);

      const again = await h.learn({ turnstileToken: 'forged' }, { cookie });
      expect(again.statusCode).toBe(403);
    });
  });

  // ---------- learn limits ----------

  describe('server-side learn limits (SPEC 11, 9.5)', () => {
    it('allows 2 learns per day per anonId, then 429 limitHit learnsPerDay - before the LLM is called', async () => {
      const llm = makeComplete();
      const h = await setup({ complete: llm.fn });
      const cookie = anonCookie(await h.get('/api/session'));
      const id = cookie.slice('anonId='.length);

      // Different IPs each time: only the anonId limit can be what stops the third.
      expect((await h.learn({ noCache: true }, { cookie })).statusCode).toBe(200);
      expect((await h.learn({ noCache: true }, { cookie })).statusCode).toBe(200);
      const third = await h.learn({ noCache: true }, { cookie });

      expect(third.statusCode).toBe(429);
      expect(third.json()).toEqual({ error: 'limitHit', limit: 'learnsPerDay' });
      expect(llm.calls).toHaveLength(2);
      // The refused attempt recorded nothing (events come in M4) and left the counter at 2.
      expect(await h.handle.counter(`anon:${id}:${dayKey(h.clock.current)}`)).toBe(2);
      expect(await h.handle.ledger()).toHaveLength(2);
    });

    it('allows 2 learns per IP per day across different anonIds, then 429', async () => {
      const llm = makeComplete();
      const h = await setup({ complete: llm.fn });
      const ip = '203.0.113.50';

      // No cookie sent: every request is a brand-new anonymous visitor on the same IP.
      expect((await h.learn({}, { ip })).statusCode).toBe(200);
      expect((await h.learn({}, { ip })).statusCode).toBe(200);
      const third = await h.learn({}, { ip });

      expect(third.statusCode).toBe(429);
      expect(third.json()).toEqual({ error: 'limitHit', limit: 'learnsPerDay' });
      expect(llm.calls).toHaveLength(2);
      // The counter is keyed by a hash, never by the address itself.
      const day = dayKey(h.clock.current);
      expect(await h.handle.counter(`ip:203.0.113.50:${day}`)).toBe(0);
    });

    it('treats every address in one IPv6 /64 as one IP', async () => {
      const llm = makeComplete();
      const h = await setup({ complete: llm.fn });
      expect((await h.learn({}, { ip: '2001:db8:1:1::1' })).statusCode).toBe(200);
      expect((await h.learn({}, { ip: '2001:db8:1:1::2' })).statusCode).toBe(200);
      expect((await h.learn({}, { ip: '2001:db8:1:1:ffff::3' })).statusCode).toBe(429);
    });

    it('starts a new count on the next UTC day', async () => {
      const llm = makeComplete();
      const h = await setup({ complete: llm.fn });
      const cookie = anonCookie(await h.get('/api/session'));
      const ip = nextIp();
      await h.learn({ noCache: true }, { cookie, ip });
      await h.learn({ noCache: true }, { cookie, ip });
      expect((await h.learn({ noCache: true }, { cookie, ip })).statusCode).toBe(429);

      h.clock.current = new Date(h.clock.current.getTime() + DAY_MS);
      expect((await h.learn({ noCache: true }, { cookie, ip })).statusCode).toBe(200);
    });

    it('never lets concurrent learns slip past the limit', async () => {
      const llm = makeComplete();
      const h = await setup({ complete: llm.fn });
      const cookie = anonCookie(await h.get('/api/session'));

      const results = await Promise.all(
        Array.from({ length: 6 }, () => h.learn({ noCache: true }, { cookie })),
      );
      const statuses = results.map((r) => r.statusCode).sort();
      expect(statuses.filter((s) => s === 200)).toHaveLength(2);
      expect(statuses.filter((s) => s === 429)).toHaveLength(4);
      expect(llm.calls).toHaveLength(2);
    });

    it('does not count a malformed request as a learn', async () => {
      const llm = makeComplete();
      const h = await setup({ complete: llm.fn });
      const cookie = anonCookie(await h.get('/api/session'));
      for (let i = 0; i < 4; i++) {
        expect((await h.learn({ payload: { not: 'a payload' } }, { cookie })).statusCode).toBe(400);
      }
      expect((await h.learn({ noCache: true }, { cookie })).statusCode).toBe(200);
    });

    it('counts a learn however many LLM calls it took (repair + escalation are one learn)', async () => {
      // Wrong rules every time: first try, server repair, then escalation = 3 calls, one learn.
      const llm = makeComplete({ json: wrongRoundingWireJson() });
      const h = await setup({ complete: llm.fn });
      const cookie = anonCookie(await h.get('/api/session'));
      const res = await h.learn({ noCache: true }, { cookie });

      expect(res.statusCode).toBe(200);
      expect(res.json().verified).toBe(false);
      expect(llm.calls.length).toBeGreaterThan(1);
      expect(await h.handle.counter(`anon:${cookie.slice(7)}:${dayKey(h.clock.current)}`)).toBe(1);
    });
  });

  // ---------- repair ----------

  describe('POST /api/learn/repair (SPEC 9.3: at most one, and not a new learn)', () => {
    async function learned(h: Harness, cookie: string) {
      const res = await h.learn({ noCache: true }, { cookie });
      expect(res.statusCode).toBe(200);
      return res.json() as { rules: unknown; learnId: string };
    }
    const repairBody = (rules: unknown, learnId: unknown) => ({
      payload: basicPayload(),
      previousRules: rules,
      problems: [],
      learnId,
    });

    it('issues a learnId and allows exactly one repair per learn', async () => {
      const llm = makeComplete();
      const h = await setup({ complete: llm.fn });
      const cookie = anonCookie(await h.get('/api/session'));
      const { rules, learnId } = await learned(h, cookie);
      expect(learnId).toEqual(expect.any(String));
      const callsAfterLearn = llm.calls.length;

      const first = await h.post('/api/learn/repair', repairBody(rules, learnId), { cookie });
      expect(first.statusCode).toBe(200);
      expect(first.json().verified).toBe(true);
      expect(llm.calls).toHaveLength(callsAfterLearn + 1);

      const second = await h.post('/api/learn/repair', repairBody(rules, learnId), { cookie });
      expect(second.statusCode).toBe(429);
      expect(second.json()).toEqual({ error: 'limitHit', limit: 'repairsPerLearn' });
      expect(llm.calls).toHaveLength(callsAfterLearn + 1);
    });

    it('is not counted as a new learn, and is allowed even once the daily learn limit is spent', async () => {
      const llm = makeComplete();
      const h = await setup({ complete: llm.fn });
      const cookie = anonCookie(await h.get('/api/session'));
      const day = dayKey(h.clock.current);
      const key = `anon:${cookie.slice(7)}:${day}`;

      await learned(h, cookie);
      const { rules, learnId } = await learned(h, cookie);
      expect(await h.handle.counter(key)).toBe(2);

      const repair = await h.post('/api/learn/repair', repairBody(rules, learnId), { cookie });
      expect(repair.statusCode).toBe(200);
      expect(await h.handle.counter(key)).toBe(2);
    });

    it('writes the repair to the ledger under the same learnId as its learn', async () => {
      const llm = makeComplete();
      const h = await setup({ complete: llm.fn });
      const cookie = anonCookie(await h.get('/api/session'));
      const { rules, learnId } = await learned(h, cookie);
      await h.post('/api/learn/repair', repairBody(rules, learnId), { cookie });

      const ledger = await h.handle.ledger();
      expect(ledger.map((d) => d.purpose)).toEqual(['learn', 'repair']);
      expect(new Set(ledger.map((d) => d.learnId)).size).toBe(1);
      expect(learnId.startsWith(ledger[0]!.learnId)).toBe(true);
    });

    it('requires a valid learnId issued to the same visitor', async () => {
      const llm = makeComplete();
      const h = await setup({ complete: llm.fn });
      const cookie = anonCookie(await h.get('/api/session'));
      const { rules, learnId } = await learned(h, cookie);
      const before = llm.calls.length;

      const other = anonCookie(await h.get('/api/session'));
      for (const [id, who] of [
        [undefined, cookie],
        ['not-a-learn-id', cookie],
        [`${learnId}x`, cookie],
        [learnId, other], // someone else's learnId
      ] as const) {
        const res = await h.post('/api/learn/repair', repairBody(rules, id), { cookie: who });
        expect(res.statusCode).toBe(400);
        expect(res.json()).toEqual({ error: 'invalidLearnId' });
      }
      expect(llm.calls).toHaveLength(before);
    });

    it('rejects an expired learnId', async () => {
      const h = await setup({ complete: makeComplete().fn });
      const cookie = anonCookie(await h.get('/api/session'));
      const { rules, learnId } = await learned(h, cookie);
      h.clock.current = new Date(h.clock.current.getTime() + (limits.protection.learnIdTtlMinutes + 1) * 60_000);
      const res = await h.post('/api/learn/repair', repairBody(rules, learnId), { cookie });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: 'invalidLearnId' });
    });

    it('still validates the body shape first', async () => {
      const h = await setup({ complete: makeComplete().fn });
      const cookie = anonCookie(await h.get('/api/session'));
      const bad = (body: Record<string, unknown>) => h.post('/api/learn/repair', body, { cookie });
      const ok = { payload: basicPayload(), previousRules: {}, problems: [], learnId: 'x' };
      expect((await bad({ ...ok, payload: 1 })).json()).toEqual({ error: 'invalidPayload' });
      expect((await bad(ok)).json()).toEqual({ error: 'invalidPreviousRules' });
    });

    it('lets only one of several concurrent repairs through', async () => {
      const llm = makeComplete();
      const h = await setup({ complete: llm.fn });
      const cookie = anonCookie(await h.get('/api/session'));
      const { rules, learnId } = await learned(h, cookie);
      const results = await Promise.all(
        Array.from({ length: 4 }, () => h.post('/api/learn/repair', repairBody(rules, learnId), { cookie })),
      );
      expect(results.filter((r) => r.statusCode === 200)).toHaveLength(1);
      expect(results.filter((r) => r.statusCode === 429)).toHaveLength(3);
    });
  });

  // ---------- budgets ----------

  describe('budgets (SPEC 9.5)', () => {
    it('accumulates each call\'s cost into the day\'s budget, overall and anonymous', async () => {
      const llm = makeComplete({ costUsd: 0.5 });
      const h = await setup({ complete: llm.fn });
      await h.learn();
      await h.learn();

      const spend = await h.handle.store.getSpend(dayKey(h.clock.current));
      expect(spend.spendUsd).toBeCloseTo(1);
      expect(spend.anonSpendUsd).toBeCloseTo(1);
      const ledger = await h.handle.ledger();
      expect(ledger.map((d) => d.costUsd)).toEqual([0.5, 0.5]);
    });

    it('counts a subscription (cost 0) learn against the learn limit but not the budget', async () => {
      const llm = makeComplete({ costUsd: 0 });
      const h = await setup({ complete: llm.fn });
      const cookie = anonCookie(await h.get('/api/session'));
      await h.learn({ noCache: true }, { cookie });

      const day = dayKey(h.clock.current);
      expect(await h.handle.store.getSpend(day)).toEqual({ spendUsd: 0, anonSpendUsd: 0 });
      expect(await h.handle.counter(`anon:${cookie.slice(7)}:${day}`)).toBe(1);
    });

    it('pauses anonymous learning with 429 anonBudgetExhausted once the anonymous budget is spent', async () => {
      const llm = makeComplete();
      const h = await setup({ complete: llm.fn });
      const day = dayKey(h.clock.current);
      await h.handle.store.addSpend(day, limits.budgets.dailyAnonUsd, true);
      const cookie = anonCookie(await h.get('/api/session'));

      const res = await h.learn({ noCache: true }, { cookie });
      expect(res.statusCode).toBe(429);
      expect(res.json()).toEqual({ error: 'anonBudgetExhausted' });
      expect(llm.calls).toHaveLength(0);
      // Refused before the limits: it did not use up one of the day's learns.
      expect(await h.handle.counter(`anon:${cookie.slice(7)}:${day}`)).toBe(0);
    });

    it('stays open while the anonymous budget has room', async () => {
      const llm = makeComplete();
      const h = await setup({ complete: llm.fn });
      await h.handle.store.addSpend(dayKey(h.clock.current), limits.budgets.dailyAnonUsd - 0.01, true);
      expect((await h.learn()).statusCode).toBe(200);
    });

    it('is the kill switch: 503 budgetExhausted once the overall budget is spent', async () => {
      const llm = makeComplete();
      const h = await setup({ complete: llm.fn });
      const day = dayKey(h.clock.current);
      await h.handle.store.addSpend(day, limits.budgets.dailyOverallUsd, false);

      const res = await h.learn({ noCache: true });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toEqual({ error: 'budgetExhausted' });
      expect(llm.calls).toHaveLength(0);
    });

    it('stops repairs too', async () => {
      const llm = makeComplete();
      const h = await setup({ complete: llm.fn });
      const cookie = anonCookie(await h.get('/api/session'));
      const learn = (await h.learn({ noCache: true }, { cookie })).json();
      const before = llm.calls.length;
      await h.handle.store.addSpend(dayKey(h.clock.current), limits.budgets.dailyOverallUsd, false);

      const res = await h.post(
        '/api/learn/repair',
        { payload: basicPayload(), previousRules: learn.rules, problems: [], learnId: learn.learnId },
        { cookie },
      );
      expect(res.statusCode).toBe(503);
      expect(res.json()).toEqual({ error: 'budgetExhausted' });
      expect(llm.calls).toHaveLength(before);
    });

    it('starts a fresh budget on the next UTC day', async () => {
      const h = await setup({ complete: makeComplete().fn });
      await h.handle.store.addSpend(dayKey(h.clock.current), limits.budgets.dailyOverallUsd, false);
      expect((await h.learn({ noCache: true })).statusCode).toBe(503);
      h.clock.current = new Date(h.clock.current.getTime() + DAY_MS);
      expect((await h.learn({ noCache: true })).statusCode).toBe(200);
    });

    it('does not stop a cache hit: it costs no LLM call', async () => {
      const llm = makeComplete();
      const h = await setup({ complete: llm.fn });
      const cookie = anonCookie(await h.get('/api/session'));
      expect((await h.learn({}, { cookie })).statusCode).toBe(200);

      await h.handle.store.addSpend(dayKey(h.clock.current), limits.budgets.dailyOverallUsd, false);
      const hit = await h.learn({}, { cookie });
      expect(hit.statusCode).toBe(200);
      expect(hit.json().cached).toBe(true);
    });
  });

  // ---------- cache ----------

  describe('structure cache (SPEC 9.5)', () => {
    it('returns the same owner\'s saved rules for the same structure - no LLM call, no learn counted', async () => {
      const llm = makeComplete();
      const h = await setup({ complete: llm.fn });
      const cookie = anonCookie(await h.get('/api/session'));
      const key = `anon:${cookie.slice(7)}:${dayKey(h.clock.current)}`;

      const first = (await h.learn({}, { cookie })).json();
      expect(first.cached).toBe(false);
      expect(await h.handle.counter(key)).toBe(1);
      expect(await h.handle.cacheEntryCount()).toBe(1);

      const hit = await h.learn({}, { cookie });
      expect(hit.statusCode).toBe(200);
      const body = hit.json();
      expect(body).toMatchObject({ verified: true, cached: true, problems: [] });
      expect(body.rules).toEqual(first.rules);
      expect(body.learnId).toBeUndefined();
      expect(llm.calls).toHaveLength(1);
      expect(await h.handle.counter(key)).toBe(1);
    });

    it('ignores the data: same structure, different sample rows is still a hit', async () => {
      const llm = makeComplete();
      const h = await setup({ complete: llm.fn });
      const cookie = anonCookie(await h.get('/api/session'));
      await h.learn({}, { cookie });

      const other = basicPayload();
      other.samples = [{ in: ['Z1', 100], out: ['Z1', 200] }];
      const hit = await h.learn({ payload: other }, { cookie });
      expect(hit.json().cached).toBe(true);
      expect(llm.calls).toHaveLength(1);
    });

    it('records a cacheHit ledger entry: no model, no tokens, no cost', async () => {
      const h = await setup({ complete: makeComplete({ costUsd: 0.5 }).fn });
      const cookie = anonCookie(await h.get('/api/session'));
      await h.learn({}, { cookie });
      await h.learn({}, { cookie });

      const ledger = await h.handle.ledger();
      expect(ledger).toHaveLength(2);
      expect(ledger[1]).toMatchObject({
        outcome: 'cacheHit',
        cacheHit: true,
        costUsd: 0,
        tokensIn: 0,
        tokensOut: 0,
        model: 'cache',
        anonId: cookie.slice(7),
      });
      expect(ledger[0]).toMatchObject({ outcome: 'verified', cacheHit: false });
      // A hit spends nothing.
      expect((await h.handle.store.getSpend(dayKey(h.clock.current))).spendUsd).toBeCloseTo(0.5);
    });

    it('NEVER returns one owner\'s rules to another owner, even for an identical structure', async () => {
      const llm = makeComplete();
      const h = await setup({ complete: llm.fn });
      const alice = anonCookie(await h.get('/api/session'));
      const bob = anonCookie(await h.get('/api/session'));

      await h.learn({}, { cookie: alice });
      const bobs = await h.learn({}, { cookie: bob });

      expect(bobs.statusCode).toBe(200);
      expect(bobs.json().cached).toBe(false);
      expect(llm.calls).toHaveLength(2);
      // Bob's learn was a real, counted learn of his own.
      expect(await h.handle.counter(`anon:${bob.slice(7)}:${dayKey(h.clock.current)}`)).toBe(1);
      expect(await h.handle.cacheEntryCount()).toBe(2);
    });

    it('does not cache a result that failed the checks', async () => {
      const llm = makeComplete({ json: wrongRoundingWireJson() });
      const h = await setup({ complete: llm.fn });
      const cookie = anonCookie(await h.get('/api/session'));
      expect((await h.learn({}, { cookie })).json().verified).toBe(false);
      expect(await h.handle.cacheEntryCount()).toBe(0);
    });

    it('lets the browser insist on a fresh learn with noCache (which does count)', async () => {
      const llm = makeComplete();
      const h = await setup({ complete: llm.fn });
      const cookie = anonCookie(await h.get('/api/session'));
      await h.learn({}, { cookie });
      const fresh = await h.learn({ noCache: true }, { cookie });
      expect(fresh.json().cached).toBe(false);
      expect(llm.calls).toHaveLength(2);
      expect(await h.handle.counter(`anon:${cookie.slice(7)}:${dayKey(h.clock.current)}`)).toBe(2);
    });

    it('expires entries after the configured TTL', async () => {
      const llm = makeComplete();
      const h = await setup({ complete: llm.fn });
      const cookie = anonCookie(await h.get('/api/session'));
      await h.learn({}, { cookie });

      h.clock.current = new Date(h.clock.current.getTime() + (limits.cache.ttlDays + 1) * DAY_MS);
      const after = await h.learn({}, { cookie });
      expect(after.json().cached).toBe(false);
      expect(llm.calls).toHaveLength(2);
    });

    it('keeps the cache separate per masking mode', async () => {
      const llm = makeComplete();
      const h = await setup({ complete: llm.fn });
      const cookie = anonCookie(await h.get('/api/session'));
      await h.learn({ payload: basicPayload({ masking: false }) }, { cookie });
      const masked = await h.learn({ payload: basicPayload({ masking: true }) }, { cookie });
      expect(masked.json().cached).toBe(false);
    });

    describe('masking rule (masked constants belong to an earlier session\'s key)', () => {
      it('masking ON + rules without text constants: cached and served', async () => {
        const llm = makeComplete();
        const h = await setup({ complete: llm.fn });
        const cookie = anonCookie(await h.get('/api/session'));
        const payload = basicPayload({ masking: true });
        await h.learn({ payload }, { cookie });
        expect((await h.learn({ payload }, { cookie })).json().cached).toBe(true);
        expect(llm.calls).toHaveLength(1);
      });

      it('masking ON + rules WITH text constants: not stored, so never served (a miss every time)', async () => {
        const llm = makeComplete({ json: rulesWithTextConstantWireJson() });
        const h = await setup({ complete: llm.fn });
        const cookie = anonCookie(await h.get('/api/session'));
        const payload = basicPayload({ masking: true });

        const first = (await h.learn({ payload }, { cookie })).json();
        expect(first.verified).toBe(true);
        expect(await h.handle.cacheEntryCount()).toBe(0);
        const second = (await h.learn({ payload }, { cookie })).json();
        expect(second.cached).toBe(false);
        expect(llm.calls).toHaveLength(2);
      });

      it('masking OFF + rules with text constants: cached and served (the constants are real)', async () => {
        const llm = makeComplete({ json: rulesWithTextConstantWireJson() });
        const h = await setup({ complete: llm.fn });
        const cookie = anonCookie(await h.get('/api/session'));
        const payload = basicPayload({ masking: false });

        expect((await h.learn({ payload }, { cookie })).json().verified).toBe(true);
        expect(await h.handle.cacheEntryCount()).toBe(1);
        const hit = (await h.learn({ payload }, { cookie })).json();
        expect(hit.cached).toBe(true);
        expect(hit.rules.validations[0].values).toEqual(['A1', 'A2']);
        expect(llm.calls).toHaveLength(1);
      });
    });

    it('replaces the entry with the repaired rules', async () => {
      const llm = makeComplete();
      const h = await setup({ complete: llm.fn });
      const cookie = anonCookie(await h.get('/api/session'));
      const first = (await h.learn({}, { cookie })).json();
      const repair = await h.post(
        '/api/learn/repair',
        { payload: basicPayload(), previousRules: first.rules, problems: [], learnId: first.learnId },
        { cookie },
      );
      expect(repair.statusCode).toBe(200);
      expect(await h.handle.cacheEntryCount()).toBe(1);
    });
  });

  // ---------- rate limit ----------

  describe('per-IP request rate limit (SPEC 9.5)', () => {
    it('answers 429 rateLimited with Retry-After past the per-minute allowance, before parsing the body', async () => {
      const h = await setup();
      const ip = '203.0.113.77';
      const max = limits.protection.learnRequestsPerIpPerMinute;
      for (let i = 0; i < max; i++) {
        expect((await h.post('/api/learn', { payload: 1 }, { ip })).statusCode).toBe(400);
      }
      const over = await h.post('/api/learn', { payload: 1 }, { ip });
      expect(over.statusCode).toBe(429);
      expect(over.json()).toEqual({ error: 'rateLimited' });
      expect(Number(over.headers['retry-after'])).toBeGreaterThan(0);

      // Another IP is unaffected, and the window ends.
      expect((await h.post('/api/learn', { payload: 1 }, { ip: nextIp() })).statusCode).toBe(400);
      h.clock.current = new Date(h.clock.current.getTime() + limits.protection.rateLimitWindowMs);
      expect((await h.post('/api/learn', { payload: 1 }, { ip })).statusCode).toBe(400);
    });

    it('covers /api/learn/repair too, on the same per-IP allowance', async () => {
      const h = await setup();
      const ip = '203.0.113.78';
      for (let i = 0; i < limits.protection.learnRequestsPerIpPerMinute; i++) {
        await h.post('/api/learn', { payload: 1 }, { ip });
      }
      const res = await h.post('/api/learn/repair', { payload: 1 }, { ip });
      expect(res.statusCode).toBe(429);
      expect(res.json()).toEqual({ error: 'rateLimited' });
    });

    it('leaves /api/session and /api/health alone', async () => {
      const h = await setup();
      const ip = '203.0.113.79';
      for (let i = 0; i < limits.protection.learnRequestsPerIpPerMinute + 5; i++) {
        expect((await h.get('/api/session', { ip })).statusCode).toBe(200);
      }
    });
  });

  // ---------- failure modes ----------

  describe('failure modes', () => {
    it('fails closed and never leaks the error message when the store is down', async () => {
      const llm = makeComplete();
      const h = await setup({ complete: llm.fn });
      const store = h.handle.store;
      const original = store.incrementCounter;
      store.incrementCounter = async () => {
        throw new Error('secret connection string mongodb://user:pw@host');
      };

      const res = await h.learn({ noCache: true });
      store.incrementCounter = original;
      expect(res.statusCode).toBe(500);
      expect(res.json()).toEqual({ error: 'internal' });
      expect(res.body).not.toContain('mongodb://');
      expect(llm.calls).toHaveLength(0);
    });

    it('still returns the rules when recording the ledger fails after the LLM call', async () => {
      const llm = makeComplete();
      const h = await setup({ complete: llm.fn });
      h.handle.store.insertLlmCalls = async () => {
        throw new Error('ledger down');
      };
      const res = await h.learn({ noCache: true });
      expect(res.statusCode).toBe(200);
      expect(res.json().verified).toBe(true);
    });
  });

  // ---------- ledger ----------

  describe('ledger', () => {
    it('attaches the anonId and a learnId to llm_calls, and stores no payload content', async () => {
      const h = await setup({ complete: makeComplete({ costUsd: 0.1 }).fn });
      const cookie = anonCookie(await h.get('/api/session'));
      const payload = basicPayload();
      payload.samples = [{ in: ['ZQXJcell', 10], out: ['ZQXJcell', 20] }];
      const res = await h.learn({ payload, noCache: true }, { cookie });

      const [doc] = await h.handle.ledger();
      expect(doc).toMatchObject({
        anonId: cookie.slice(7),
        purpose: 'learn',
        outcome: 'verified',
        cacheHit: false,
        costUsd: 0.1,
        masking: false,
      });
      expect(res.json().learnId.startsWith(doc!.learnId)).toBe(true);
      const text = JSON.stringify(doc);
      expect(text).not.toContain('ZQXJcell');
      expect(text).not.toContain('Amount');
    });
  });
}

describe('API protections (in-memory store)', () => {
  defineProtectionSuite(memoryKit);
});

describe.skipIf(!mongoUri)('API protections (MongoDB)', () => {
  defineProtectionSuite(mongoKit());
});
