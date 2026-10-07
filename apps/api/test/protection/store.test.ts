// The store contract (SPEC 13): counters, budgets and the learn cache behave the same on the
// in-memory store and on real MongoDB; the Mongo-only part checks the indexes `ensureIndexes` makes.
import { randomUUID } from 'node:crypto';
import { limits } from '@formatai/shared';
import { describe, expect, it } from 'vitest';
import { connectDb, ensureIndexes } from '../../src/db.js';
import { loadEnv } from '../../src/env.js';
import { dropTestDb } from '../setup/testDbs.js';
import { memoryKit, mongoKit, mongoUri, useKit, type StoreHandle, type StoreKit } from './harness.js';

function defineStoreContract(kit: StoreKit): void {
  useKit(kit);
  const fresh = (): Promise<StoreHandle> => kit.make(() => new Date());
  const key = (): string => `test:${randomUUID()}`;

  it('increments counters atomically, in both directions, and returns the new total', async () => {
    const { store } = await fresh();
    const k = key();
    const expiresAt = new Date(Date.now() + 60_000);
    expect(await store.incrementCounter(k, 1, expiresAt)).toBe(1);
    expect(await store.incrementCounter(k, 2, expiresAt)).toBe(3);
    expect(await store.incrementCounter(k, -1, expiresAt)).toBe(2);

    const totals = await Promise.all(Array.from({ length: 25 }, () => store.incrementCounter(k, 1, expiresAt)));
    expect(new Set(totals).size).toBe(25); // no two callers ever saw the same total
    expect(Math.max(...totals)).toBe(27);
  });

  it('writes every counter with an expiry: set on each write, or kept by a take-back (owner decision 2026-10-07)', async () => {
    const handle = await fresh();
    const { store } = handle;
    const first = new Date(Date.now() + 60_000);
    const later = new Date(Date.now() + 120_000);
    const a = key();
    await store.incrementCounter(a, 1, first);
    expect(await handle.counterExpiry(a)).toEqual(first);
    expect(await store.incrementCounter(a, 1, later)).toBe(2);
    expect(await handle.counterExpiry(a)).toEqual(later); // a write moves it

    // keepExpiry (a take-back inside a window) leaves the expiry the counter has...
    expect(await store.incrementCounter(a, -1, first, { keepExpiry: true })).toBe(1);
    expect(await handle.counterExpiry(a)).toEqual(later);
    // ...and gives one to a counter that has none
    const b = key();
    expect(await store.incrementCounter(b, -1, first, { keepExpiry: true })).toBe(-1);
    expect(await handle.counterExpiry(b)).toEqual(first);

    const c = key();
    expect(await store.transitionCounter(c, 0, 1, first)).toBe(true);
    expect(await handle.counterExpiry(c)).toEqual(first);
    expect(await handle.countersWithoutExpiry()).toEqual([]);
  });

  it('reads a counter (0 when absent) without creating it', async () => {
    const { store } = await fresh();
    const k = key();
    expect(await store.getCounter(k)).toBe(0);
    await store.incrementCounter(k, 3, new Date(Date.now() + 60_000));
    expect(await store.getCounter(k)).toBe(3);
    expect(await store.getCounter(key())).toBe(0);
  });

  it('moves a state counter by compare-and-set, at most once per transition (SPEC 21 v5)', async () => {
    const { store } = await fresh();
    const k = key();
    const exp = new Date(Date.now() + 60_000);
    // An absent counter is state 0.
    expect(await store.transitionCounter(k, 1, 2, exp)).toBe(false);
    expect(await store.getCounter(k)).toBe(0);
    expect(await store.transitionCounter(k, 0, 1, exp)).toBe(true);
    expect(await store.getCounter(k)).toBe(1);
    expect(await store.transitionCounter(k, 0, 1, exp)).toBe(false); // already moved
    expect(await store.transitionCounter(k, 1, 2, new Date(Date.now() + 120_000))).toBe(true);
    expect(await store.transitionCounter(k, 1, 2, exp)).toBe(false);
    expect(await store.getCounter(k)).toBe(2);

    // Only one of many racing callers wins the same transition.
    const race = key();
    const wins = await Promise.all(Array.from({ length: 12 }, () => store.transitionCounter(race, 0, 1, exp)));
    expect(wins.filter(Boolean)).toHaveLength(1);
    expect(await store.getCounter(race)).toBe(1);
  });

  it('accumulates spend per day atomically', async () => {
    const { store } = await fresh();
    expect(await store.getSpend('2026-01-01')).toEqual({ spendUsd: 0 });

    await Promise.all(Array.from({ length: 20 }, () => store.addSpend('2026-01-01', 0.25)));
    const spend = await store.getSpend('2026-01-01');
    expect(spend.spendUsd).toBeCloseTo(5);
    expect(await store.getSpend('2026-01-02')).toEqual({ spendUsd: 0 });
  });

  it('saves and returns rules per (owner, key), replacing on a second save', async () => {
    const { store } = await fresh();
    const now = new Date();
    const notBefore = new Date(now.getTime() - 1000);
    expect(await store.getCachedRules('anon:a', 'k1', notBefore)).toBeNull();

    await store.putCachedRules({ owner: 'anon:a', key: 'k1', rules: { v: 1 }, promptVersion: 'p', createdAt: now });
    expect(await store.getCachedRules('anon:a', 'k1', notBefore)).toEqual({ v: 1 });
    // Same structure, other owner: nothing.
    expect(await store.getCachedRules('anon:b', 'k1', notBefore)).toBeNull();

    await store.putCachedRules({ owner: 'anon:a', key: 'k1', rules: { v: 2 }, promptVersion: 'p', createdAt: now });
    expect(await store.getCachedRules('anon:a', 'k1', notBefore)).toEqual({ v: 2 });
  });

  it('round-trips rules whose keys are user text, including dots and dollar signs', async () => {
    const { store } = await fresh();
    const now = new Date();
    const rules = { transform: { valueMaps: [{ map: { 'a.b': 'x', $set: 'y', '': 'z', 'שלום': 'hello' } }] } };
    await store.putCachedRules({ owner: 'anon:a', key: 'k', rules, promptVersion: 'p', createdAt: now });
    expect(await store.getCachedRules('anon:a', 'k', new Date(now.getTime() - 1000))).toEqual(rules);
  });

  it('removes the owner cached rules by structure-hash prefix, leaving other structures and owners alone', async () => {
    const { store } = await fresh();
    const now = new Date();
    const back = new Date(now.getTime() - 1000);
    for (const [owner, key] of [['user:a', 'abc123def'], ['user:a', 'abc999'], ['user:a', 'fff000'], ['user:b', 'abc123def']] as const) {
      await store.putCachedRules({ owner, key, rules: { v: key }, promptVersion: 'p', createdAt: now });
    }
    await store.deleteCachedRules('user:a', 'abc');
    expect(await store.getCachedRules('user:a', 'abc123def', back)).toBeNull();
    expect(await store.getCachedRules('user:a', 'abc999', back)).toBeNull();
    expect(await store.getCachedRules('user:a', 'fff000', back)).toEqual({ v: 'fff000' });
    expect(await store.getCachedRules('user:b', 'abc123def', back)).toEqual({ v: 'abc123def' });
    // Anything that is not hex deletes nothing (no pattern is ever built from it).
    await store.deleteCachedRules('user:a', '.*');
    expect(await store.getCachedRules('user:a', 'fff000', back)).toEqual({ v: 'fff000' });
  });

  it('does not return an entry older than the cut-off', async () => {
    const { store } = await fresh();
    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    await store.putCachedRules({ owner: 'anon:a', key: 'k', rules: { v: 1 }, promptVersion: 'p', createdAt: old });
    const cutoff = new Date(Date.now() - limits.cache.ttlDays * 24 * 60 * 60 * 1000);
    expect(await store.getCachedRules('anon:a', 'k', cutoff)).toBeNull();
  });
}

describe('protection store contract (in-memory)', () => {
  defineStoreContract(memoryKit);
});

describe.skipIf(!mongoUri)('protection store contract (MongoDB)', () => {
  defineStoreContract(mongoKit());
});

describe.skipIf(!mongoUri)('MongoDB indexes for the protections (SPEC 13)', () => {
  it('creates the learn_cache unique (owner, key) index and the age TTL index', async () => {
    const dbName = `formatai_test_${randomUUID().slice(0, 8)}`;
    const appDb = await connectDb(loadEnv({ ...process.env, MONGODB_URI: mongoUri, MONGODB_DB: dbName }));
    expect(appDb).not.toBeNull();
    if (!appDb) return;
    try {
      await ensureIndexes(appDb);
      await ensureIndexes(appDb); // idempotent

      const indexes = await appDb.learnCache.indexes();
      const unique = indexes.find((i) => i.name === 'learn_cache_owner_key_unique');
      expect(unique?.unique).toBe(true);
      expect(unique?.key).toEqual({ owner: 1, key: 1 });
      const ttl = indexes.find((i) => i.name === 'learn_cache_createdAt_ttl');
      expect(ttl?.expireAfterSeconds).toBe(limits.cache.ttlDays * 24 * 60 * 60);

      const doc = { owner: 'anon:a', key: 'k', rules: '{}', promptVersion: 'p', createdAt: new Date() };
      await appDb.learnCache.insertOne({ ...doc });
      await expect(appDb.learnCache.insertOne({ ...doc })).rejects.toThrow(/duplicate key/);
    } finally {
      await dropTestDb(appDb);
    }
  });
});
