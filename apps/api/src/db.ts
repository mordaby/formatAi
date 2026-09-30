import { limits } from '@formatai/shared';
import { MongoClient, type Collection, type Db, type UpdateFilter } from 'mongodb';
import type { Env } from './env.js';
import type {
  BudgetDoc,
  EventDoc,
  FeedbackDoc,
  ConversionDoc,
  FormatDoc,
  LeadDoc,
  LearnCacheDoc,
  LlmCallDoc,
  SessionDoc,
  SourceDoc,
  UsageCounterDoc,
  UserDoc,
  WaitlistDoc,
} from './models.js';

export interface AppDb {
  client: MongoClient;
  db: Db;
  users: Collection<UserDoc>;
  sessions: Collection<SessionDoc>;
  formats: Collection<FormatDoc>;
  conversions: Collection<ConversionDoc>;
  sources: Collection<SourceDoc>;
  events: Collection<EventDoc>;
  llmCalls: Collection<LlmCallDoc>;
  usageCounters: Collection<UsageCounterDoc>;
  budgets: Collection<BudgetDoc>;
  learnCache: Collection<LearnCacheDoc>;
  leads: Collection<LeadDoc>;
  waitlist: Collection<WaitlistDoc>;
  feedback: Collection<FeedbackDoc>;
}

/**
 * Connects to MongoDB, or returns null when MONGODB_URI is not configured.
 * The API must boot and serve /api/health without a database (M0).
 */
export async function connectDb(env: Env): Promise<AppDb | null> {
  if (!env.MONGODB_URI) {
    console.warn('MongoDB not configured');
    return null;
  }

  const client = new MongoClient(env.MONGODB_URI);
  await client.connect();
  const db = client.db(env.MONGODB_DB);

  return {
    client,
    db,
    users: db.collection<UserDoc>('users'),
    sessions: db.collection<SessionDoc>('sessions'),
    formats: db.collection<FormatDoc>('formats'),
    conversions: db.collection<ConversionDoc>('conversions'),
    sources: db.collection<SourceDoc>('sources'),
    events: db.collection<EventDoc>('events'),
    llmCalls: db.collection<LlmCallDoc>('llm_calls'),
    usageCounters: db.collection<UsageCounterDoc>('usage_counters'),
    budgets: db.collection<BudgetDoc>('budgets'),
    learnCache: db.collection<LearnCacheDoc>('learn_cache'),
    leads: db.collection<LeadDoc>('leads'),
    waitlist: db.collection<WaitlistDoc>('waitlist'),
    feedback: db.collection<FeedbackDoc>('feedback'),
  };
}

/** Creates every index listed in SPEC.md section 13. Safe to call on every boot (idempotent). */
export async function ensureIndexes(appDb: AppDb): Promise<void> {
  await Promise.all([
    appDb.users.createIndex(
      { 'identities.provider': 1, 'identities.subject': 1 },
      { unique: true, name: 'identities_provider_subject_unique' },
    ),
    // SPEC 12: sessions expire through their own `expiresAt`.
    appDb.sessions.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0, name: 'sessions_expiresAt_ttl' }),
    appDb.sessions.createIndex({ userId: 1 }, { name: 'sessions_userId' }),
    appDb.formats.createIndex({ ownerId: 1, createdAt: -1 }, { name: 'formats_ownerId_createdAt' }),
    appDb.conversions.createIndex({ ownerId: 1, formatId: 1 }, { name: 'conversions_ownerId_formatId' }),
    appDb.conversions.createIndex({ formatId: 1, createdAt: -1 }, { name: 'conversions_formatId_createdAt' }),
    // SPEC 8.15/13: a source's conversions, and the owner's sources; names are unique per owner, case-insensitively
    // (the `nameKey` field holds the normalized name).
    appDb.conversions.createIndex({ ownerId: 1, sourceId: 1 }, { name: 'conversions_ownerId_sourceId' }),
    appDb.sources.createIndex({ ownerId: 1, createdAt: -1 }, { name: 'sources_ownerId_createdAt' }),
    appDb.sources.createIndex({ ownerId: 1, nameKey: 1 }, { unique: true, name: 'sources_ownerId_nameKey_unique' }),
    appDb.events.createIndex({ ts: 1 }, { name: 'events_ts' }),
    appDb.events.createIndex({ type: 1, ts: 1 }, { name: 'events_type_ts' }),
    appDb.events.createIndex({ userId: 1 }, { name: 'events_userId' }),
    appDb.events.createIndex({ anonId: 1 }, { name: 'events_anonId' }),
    appDb.llmCalls.createIndex({ ts: 1 }, { name: 'llm_calls_ts' }),
    appDb.llmCalls.createIndex({ learnId: 1 }, { name: 'llm_calls_learnId' }),
    appDb.usageCounters.createIndex({ key: 1 }, { unique: true, name: 'usage_counters_key_unique' }),
    appDb.usageCounters.createIndex(
      { expiresAt: 1 },
      { expireAfterSeconds: 0, name: 'usage_counters_expiresAt_ttl' },
    ),
    appDb.budgets.createIndex({ day: 1 }, { unique: true, name: 'budgets_day_unique' }),
    // SPEC 9.5: one saved result per (owner, structure hash); TTL-expired by age (config limits.cache.ttlDays).
    appDb.learnCache.createIndex({ owner: 1, key: 1 }, { unique: true, name: 'learn_cache_owner_key_unique' }),
    appDb.learnCache.createIndex(
      { createdAt: 1 },
      { expireAfterSeconds: limits.cache.ttlDays * 24 * 60 * 60, name: 'learn_cache_createdAt_ttl' },
    ),
    appDb.leads.createIndex({ ts: 1 }, { name: 'leads_ts' }),
    appDb.waitlist.createIndex({ userId: 1 }, { name: 'waitlist_userId' }),
    appDb.feedback.createIndex({ ts: 1 }, { name: 'feedback_ts' }),
  ]);
}

/**
 * Atomically increments a usage counter (SPEC 13: `usage_counters`), creating it if needed.
 * Pass `expiresAt` for anon/ip keys (TTL-expired); omit it for user keys, which never expire.
 * Returns the counter's new total.
 */
export async function incrementCounter(
  appDb: AppDb,
  key: string,
  by: number,
  expiresAt?: Date,
): Promise<number> {
  const update: UpdateFilter<UsageCounterDoc> = expiresAt
    ? { $inc: { count: by }, $set: { expiresAt } }
    : { $inc: { count: by } };

  const doc = await appDb.usageCounters.findOneAndUpdate({ key }, update, {
    upsert: true,
    returnDocument: 'after',
  });

  return doc?.count ?? by;
}
