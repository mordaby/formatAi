import { randomUUID } from 'node:crypto';
import { limits, retentionSeconds } from '@formatai/shared';
import { describe, expect, it } from 'vitest';
import { backfillCounterExpiry, connectDb, ensureIndexes, incrementCounter, type AppDb } from '../src/db.js';
import { loadEnv } from '../src/env.js';
import { counterExpiryOfKey } from '../src/protection/keys.js';
import { dropTestDb } from './setup/testDbs.js';

// Only runs when a real MongoDB is available (the user provides MONGODB_URI later).
// Everything else in this package must boot and pass without a database.
// Each test has its own throwaway database (never `MONGODB_DB`, which other files or the developer may be using), dropped at the end.
async function withDb(run: (appDb: AppDb) => Promise<void>): Promise<void> {
  const env = loadEnv({ ...process.env, MONGODB_DB: `formatai_test_db_${randomUUID().slice(0, 8)}` });
  const appDb = await connectDb(env);
  expect(appDb).not.toBeNull();
  if (!appDb) return;
  try {
    await run(appDb);
  } finally {
    await dropTestDb(appDb);
  }
}

const DAY_S = 24 * 60 * 60;

/** The record collections the privacy page gives a retention period (owner decision 2026-10-07), with the index and the period. */
const RECORD_TTLS = [
  { collection: 'llm_calls', index: 'llm_calls_ts', field: 'ts', months: limits.retention.aiCallRecordsMonths },
  { collection: 'events', index: 'events_ts', field: 'ts', months: limits.retention.eventsMonths },
  { collection: 'leads', index: 'leads_createdAt', field: 'createdAt', months: limits.retention.formsMonths },
  { collection: 'feedback', index: 'feedback_createdAt', field: 'createdAt', months: limits.retention.formsMonths },
] as const;

describe.skipIf(!process.env.MONGODB_URI)('MongoDB integration', () => {
  it('ensures indexes and increments a usage counter atomically', async () => {
    await withDb(async (appDb) => {
      await ensureIndexes(appDb);

      const key = `test:incrementCounter:${Date.now()}`;
      const first = await incrementCounter(appDb, key, 1, new Date(Date.now() + 30_000));
      const second = await incrementCounter(appDb, key, 2, new Date(Date.now() + 60_000));

      expect(first).toBe(1);
      expect(second).toBe(3);

      const stored = await appDb.usageCounters.findOne({ key });
      expect(stored?.count).toBe(3);
      expect(stored?.expiresAt).toBeInstanceOf(Date);
    });
  });

  it('TTL-expires every record the privacy page gives a period, by its own timestamp, after the config number of days', async () => {
    await withDb(async (appDb) => {
      await ensureIndexes(appDb);
      await ensureIndexes(appDb); // idempotent
      for (const t of RECORD_TTLS) {
        const index = (await appDb.db.collection(t.collection).indexes()).find((i) => i.name === t.index);
        expect(index?.key, t.index).toHaveProperty(t.field);
        expect(Object.keys(index?.key ?? {}), t.index).toHaveLength(1);
        expect(index?.expireAfterSeconds, t.index).toBe(retentionSeconds(t.months));
        // "up to N months": a record goes before the page's limit, never after (a month counted as 30 days)
        expect(index?.expireAfterSeconds, t.index).toBeLessThanOrEqual(t.months * 31 * DAY_S);
        expect(index?.expireAfterSeconds, t.index).toBeGreaterThanOrEqual(t.months * 28 * DAY_S);
      }
      // ...and the others the page names: counters at their own `expiresAt`, the rules cache, sessions.
      const counters = (await appDb.usageCounters.indexes()).find((i) => i.name === 'usage_counters_expiresAt_ttl');
      expect(counters?.expireAfterSeconds).toBe(0);
      const cache = (await appDb.learnCache.indexes()).find((i) => i.name === 'learn_cache_createdAt_ttl');
      expect(cache?.expireAfterSeconds).toBe(limits.cache.ttlDays * DAY_S);
      const sessions = (await appDb.sessions.indexes()).find((i) => i.name === 'sessions_expiresAt_ttl');
      expect(sessions?.expireAfterSeconds).toBe(0);
    });
  });

  it('turns the plain indexes an older deploy made into TTL ones, and moves an expiry the config changed (no rebuild, no error)', async () => {
    await withDb(async (appDb) => {
      // What a deploy from before 2026-10-07 left: the same names and keys, no expiry.
      await appDb.llmCalls.createIndex({ ts: 1 }, { name: 'llm_calls_ts' });
      await appDb.events.createIndex({ ts: 1 }, { name: 'events_ts' });
      await appDb.leads.createIndex({ createdAt: -1 }, { name: 'leads_createdAt' });
      // ...and one whose expiry is not the config's any more.
      await appDb.feedback.createIndex({ createdAt: -1 }, { name: 'feedback_createdAt', expireAfterSeconds: 60 });

      await ensureIndexes(appDb);
      await ensureIndexes(appDb);
      for (const t of RECORD_TTLS) {
        const index = (await appDb.db.collection(t.collection).indexes()).find((i) => i.name === t.index);
        expect(index?.expireAfterSeconds, t.index).toBe(retentionSeconds(t.months));
      }
    });
  });

  it('gives every counter written before 2026-10-07 without an expiry the one its key implies, once (backfillCounterExpiry)', async () => {
    await withDb(async (appDb) => {
      await ensureIndexes(appDb);
      const now = new Date('2026-10-07T09:00:00.000Z');
      const kept = new Date('2026-10-09T00:00:00.000Z');
      await appDb.usageCounters.insertMany([
        { key: 'user:u1:aiLearns:2026-10', count: 2 },
        { key: 'user:u1:newFormats:2026-09', count: 1 },
        { key: 'fnreq:recorded:2026-10', count: 4 },
        { key: 'user:u2:aiLearns', count: 1 },
        { key: 'aiFail:user:u1:abc', count: 1 },
        { key: 'ip:h:contact:2026-10-06', count: 3, expiresAt: kept },
      ]);

      expect(await backfillCounterExpiry(appDb, now)).toBe(5);
      const docs = await appDb.usageCounters.find({}).toArray();
      for (const d of docs) {
        expect(d.expiresAt, d.key).toBeInstanceOf(Date);
        if (d.key !== 'ip:h:contact:2026-10-06') expect(d.expiresAt, d.key).toEqual(counterExpiryOfKey(d.key, now));
      }
      expect(docs.find((d) => d.key === 'ip:h:contact:2026-10-06')?.expiresAt).toEqual(kept); // one that had an expiry keeps it
      expect(docs.find((d) => d.key === 'user:u1:aiLearns:2026-10')?.expiresAt?.toISOString()).toBe('2026-11-03T00:00:00.000Z');
      expect(docs.map((d) => d.count).sort()).toEqual([1, 1, 1, 2, 3, 4]); // counts untouched

      expect(await backfillCounterExpiry(appDb, now)).toBe(0); // nothing left: a no-op on the next boot
    });
  });
});
