import { MongoClient, type Collection, type Db, type UpdateFilter } from 'mongodb';
import type { Env } from './env.js';
import type {
  BudgetDoc,
  EventDoc,
  FeedbackDoc,
  FormatDoc,
  LeadDoc,
  LlmCallDoc,
  UsageCounterDoc,
  UserDoc,
  WaitlistDoc,
} from './models.js';

export interface AppDb {
  client: MongoClient;
  db: Db;
  users: Collection<UserDoc>;
  formats: Collection<FormatDoc>;
  events: Collection<EventDoc>;
  llmCalls: Collection<LlmCallDoc>;
  usageCounters: Collection<UsageCounterDoc>;
  budgets: Collection<BudgetDoc>;
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
    formats: db.collection<FormatDoc>('formats'),
    events: db.collection<EventDoc>('events'),
    llmCalls: db.collection<LlmCallDoc>('llm_calls'),
    usageCounters: db.collection<UsageCounterDoc>('usage_counters'),
    budgets: db.collection<BudgetDoc>('budgets'),
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
    appDb.formats.createIndex({ ownerId: 1, createdAt: -1 }, { name: 'formats_ownerId_createdAt' }),
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
