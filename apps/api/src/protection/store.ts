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
  /** What UTC day `day` (`yyyy-mm-dd`) has spent so far. */
  getSpend(day: string): Promise<DaySpend>;
  /** Atomically adds a call's cost to the day's total (and to the anonymous total when `anonymous`). */
  addSpend(day: string, usd: number, anonymous: boolean): Promise<void>;
  /** The owner's saved rules for a structure hash, or null (also null once older than `notBefore`). */
  getCachedRules(owner: string, key: string, notBefore: Date): Promise<unknown | null>;
  /** Saves (or replaces) the owner's rules for a structure hash. */
  putCachedRules(entry: CacheEntry): Promise<void>;
  /** SPEC 13 `llm_calls`. */
  insertLlmCalls(docs: LlmCallDoc[]): Promise<void>;
}

/** MongoDB-backed store. */
export function createMongoStore(appDb: AppDb): ProtectionStore {
  return {
    incrementCounter: (key, by, expiresAt) => incrementCounter(appDb, key, by, expiresAt),

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

    async insertLlmCalls(docs) {
      ledger.push(...docs);
    },
  };
}
