import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { connectDb, ensureIndexes, incrementCounter } from '../src/db.js';
import { loadEnv } from '../src/env.js';
import { dropTestDb } from './setup/testDbs.js';

// Only runs when a real MongoDB is available (the user provides MONGODB_URI later).
// Everything else in this package must boot and pass without a database.
// Its own throwaway database (never `MONGODB_DB`, which other files or the developer may be using), dropped at the end.
describe.skipIf(!process.env.MONGODB_URI)('MongoDB integration', () => {
  it('ensures indexes and increments a usage counter atomically', async () => {
    const env = loadEnv({ ...process.env, MONGODB_DB: `formatai_test_db_${randomUUID().slice(0, 8)}` });
    const appDb = await connectDb(env);
    expect(appDb).not.toBeNull();
    if (!appDb) return;

    try {
      await ensureIndexes(appDb);

      const key = `test:incrementCounter:${Date.now()}`;
      const first = await incrementCounter(appDb, key, 1);
      const second = await incrementCounter(appDb, key, 2, new Date(Date.now() + 60_000));

      expect(first).toBe(1);
      expect(second).toBe(3);

      const stored = await appDb.usageCounters.findOne({ key });
      expect(stored?.count).toBe(3);
      expect(stored?.expiresAt).toBeInstanceOf(Date);
    } finally {
      await dropTestDb(appDb);
    }
  });
});
