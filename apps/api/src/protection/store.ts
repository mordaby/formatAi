// Everything the protections persist (SPEC 13): usage counters, daily budgets, the learn cache and
// the `llm_calls` ledger - behind one small interface, so the route logic is the same against real
// MongoDB and against the in-memory store used by tests and by dev runs with no database.
import type { AppDb } from '../db.js';
import { incrementCounter } from '../db.js';
import type { LearnCacheDoc, LlmCallDoc } from '../models.js';
import type { DaySpend } from './budget.js';

/** A cache write: `rules` is the rules object (stored as a JSON string, see `LearnCacheDoc`). */
export type CacheEntry = Omit<LearnCacheDoc, '_id' | 'rules'> & { rules: unknown };

function parseRules(json: string | undefined): unknown | null {
  if (json === undefined) return null;
  try {
    return JSON.parse(json) as unknown;
  } catch {
    return null;
  }
}

export interface ProtectionStore {
  /** Atomically adds `by` (may be negative) to a usage counter, creating it; returns the new total.
   * Pass `expiresAt` for anon/ip/repair keys (TTL-expired); omit it for user keys. */
  incrementCounter(key: string, by: number, expiresAt?: Date): Promise<number>;
  /** A usage counter's current value (0 when absent or expired). */
  getCounter(key: string): Promise<number>;
  /** Atomically moves a counter that holds a small state number from `from` to `to` (an absent counter is
   * 0), refreshing `expiresAt` when given. True when it was in `from` and now is in `to`; false when another
   * request got there first - which is what makes a state change happen at most once (SPEC 21 v5). */
  transitionCounter(key: string, from: number, to: number, expiresAt?: Date): Promise<boolean>;
  /** What UTC day `day` (`yyyy-mm-dd`) has spent so far. */
  getSpend(day: string): Promise<DaySpend>;
  /** Atomically adds a call's cost to the day's total (and to the anonymous total when `anonymous`). */
  addSpend(day: string, usd: number, anonymous: boolean): Promise<void>;
  /** The owner's saved rules for a structure hash, or null (also null once older than `notBefore`). */
  getCachedRules(owner: string, key: string, notBefore: Date): Promise<unknown | null>;
  /** Saves (or replaces) the owner's rules for a structure hash. */
  putCachedRules(entry: CacheEntry): Promise<void>;
  /** Removes the owner's saved rules whose structure hash starts with `keyPrefix` (lowercase hex): a result the
   * browser found wrong must not be served again from the cache (SPEC 21 v5, `failed` outcome). */
  deleteCachedRules(owner: string, keyPrefix: string): Promise<void>;
  /** SPEC 13 `llm_calls`. */
  insertLlmCalls(docs: LlmCallDoc[]): Promise<void>;
}

/** MongoDB-backed store. */
export function createMongoStore(appDb: AppDb): ProtectionStore {
  return {
    incrementCounter: (key, by, expiresAt) => incrementCounter(appDb, key, by, expiresAt),

    async getCounter(key) {
      const doc = await appDb.usageCounters.findOne({ key });
      if (!doc) return 0;
      // The TTL index removes expired counters only every minute or so; the check here is exact.
      if (doc.expiresAt && doc.expiresAt.getTime() <= Date.now()) return 0;
      return doc.count;
    },

    async transitionCounter(key, from, to, expiresAt) {
      const set = expiresAt ? { count: to, expiresAt } : { count: to };
      try {
        // Upsert only makes sense from 0 (an absent counter); from any other state a miss means "not in `from`".
        const res = await appDb.usageCounters.updateOne({ key, count: from }, { $set: set }, { upsert: from === 0 });
        return res.modifiedCount + res.upsertedCount > 0;
      } catch (err) {
        // The counter exists in another state: the upsert's insert hits the unique `key` index.
        if (typeof err === 'object' && err !== null && (err as { code?: number }).code === 11000) return false;
        throw err;
      }
    },

    async getSpend(day) {
      const doc = await appDb.budgets.findOne({ day });
      return { spendUsd: doc?.spendUsd ?? 0, anonSpendUsd: doc?.anonSpendUsd ?? 0 };
    },

    async addSpend(day, usd, anonymous) {
      await appDb.budgets.updateOne(
        { day },
        { $inc: { spendUsd: usd, anonSpendUsd: anonymous ? usd : 0 } },
        { upsert: true },
      );
    },

    async getCachedRules(owner, key, notBefore) {
      // The TTL index removes old entries only every minute or so; the age check is exact.
      const doc = await appDb.learnCache.findOne({ owner, key, createdAt: { $gte: notBefore } });
      return parseRules(doc?.rules);
    },

    async putCachedRules(entry) {
      await appDb.learnCache.updateOne(
        { owner: entry.owner, key: entry.key },
        { $set: { rules: JSON.stringify(entry.rules), promptVersion: entry.promptVersion, createdAt: entry.createdAt } },
        { upsert: true },
      );
    },

    async deleteCachedRules(owner, keyPrefix) {
      if (!/^[0-9a-f]{1,64}$/.test(keyPrefix)) return; // never build a pattern from anything but hex
      await appDb.learnCache.deleteMany({ owner, key: { $regex: `^${keyPrefix}` } });
    },

    async insertLlmCalls(docs) {
      if (docs.length === 0) return;
      await appDb.llmCalls.insertMany(docs);
    },
  };
}

/** In-memory store: same semantics as the Mongo one (TTLs included), lost on restart. Tests and
 * dev without MONGODB_URI only - production requires a database (see `createProtection`). */
export interface MemoryStore extends ProtectionStore {
  /** Every ledger document written, for assertions. */
  readonly ledger: LlmCallDoc[];
  /** Current value of a usage counter (0 when absent or expired), for assertions. */
  counter(key: string): number;
  readonly cacheEntries: Map<string, LearnCacheDoc>;
  readonly spend: Map<string, DaySpend>;
}

export function createMemoryStore(now: () => Date = () => new Date()): MemoryStore {
  const counters = new Map<string, { count: number; expiresAt?: Date }>();
  const spend = new Map<string, DaySpend>();
  const cacheEntries = new Map<string, LearnCacheDoc>();
  const ledger: LlmCallDoc[] = [];

  const live = (key: string): { count: number; expiresAt?: Date } | undefined => {
    const c = counters.get(key);
    if (c?.expiresAt && c.expiresAt.getTime() <= now().getTime()) {
      counters.delete(key);
      return undefined;
    }
    return c;
  };

  return {
    ledger,
    cacheEntries,
    spend,
    counter: (key) => live(key)?.count ?? 0,

    async getCounter(key) {
      return live(key)?.count ?? 0;
    },

    async transitionCounter(key, from, to, expiresAt) {
      const c = live(key) ?? { count: 0 };
      if (c.count !== from) return false;
      c.count = to;
      if (expiresAt) c.expiresAt = expiresAt;
      counters.set(key, c);
      return true;
    },

    async incrementCounter(key, by, expiresAt) {
      const c = live(key) ?? { count: 0 };
      c.count += by;
      if (expiresAt) c.expiresAt = expiresAt;
      counters.set(key, c);
      return c.count;
    },

    async getSpend(day) {
      return { ...(spend.get(day) ?? { spendUsd: 0, anonSpendUsd: 0 }) };
    },

    async addSpend(day, usd, anonymous) {
      const s = spend.get(day) ?? { spendUsd: 0, anonSpendUsd: 0 };
      s.spendUsd += usd;
      if (anonymous) s.anonSpendUsd += usd;
      spend.set(day, s);
    },

    async getCachedRules(owner, key, notBefore) {
      const doc = cacheEntries.get(`${owner}\u0000${key}`);
      return doc && doc.createdAt.getTime() >= notBefore.getTime() ? parseRules(doc.rules) : null;
    },

    async putCachedRules(entry) {
      cacheEntries.set(`${entry.owner}\u0000${entry.key}`, { ...entry, rules: JSON.stringify(entry.rules) });
    },

    async deleteCachedRules(owner, keyPrefix) {
      for (const [k, doc] of cacheEntries) {
        if (doc.owner === owner && doc.key.startsWith(keyPrefix)) cacheEntries.delete(k);
      }
    },

    async insertLlmCalls(docs) {
      ledger.push(...docs);
    },
  };
}
