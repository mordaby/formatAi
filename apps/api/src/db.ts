import { limits, retentionSeconds } from '@formatai/shared';
import { MongoClient, type Collection, type Db, type Document, type UpdateFilter } from 'mongodb';
import type { Env } from './env.js';
import { counterExpiryOfKey } from './protection/expiry.js';
import type {
  AdminAuditDoc,
  BudgetDoc,
  EventDoc,
  FeedbackDoc,
  FunctionRequestDoc,
  ConversionDoc,
  FormatDoc,
  LeadDoc,
  LearnCacheDoc,
  LlmCallDoc,
  SessionDoc,
  SourceDoc,
  UsageCounterDoc,
  UserDoc,
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
  functionRequests: Collection<FunctionRequestDoc>;
  adminAudit: Collection<AdminAuditDoc>;
  leads: Collection<LeadDoc>;
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
    functionRequests: db.collection<FunctionRequestDoc>('function_requests'),
    adminAudit: db.collection<AdminAuditDoc>('admin_audit'),
    leads: db.collection<LeadDoc>('leads'),
    feedback: db.collection<FeedbackDoc>('feedback'),
  };
}

/** MongoDB's answer when an index of that name exists with other options (85 IndexOptionsConflict; 86 IndexKeySpecsConflict for safety). */
const INDEX_CONFLICT = new Set([85, 86]);

/**
 * Creates a TTL index (`expireAfterSeconds` on one date field), or, when an index of that name and key already exists with another expiry
 * or none (a deploy from before 2026-10-07 made `llm_calls_ts`, `events_ts`, `leads_createdAt` and `feedback_createdAt` without one), sets
 * its expiry in place with `collMod` - which since MongoDB 5.1 also turns a plain single-field index into a TTL one, with no rebuild. Safe
 * on every boot: once the index is right, `createIndex` finds the same index and does nothing. The TTL monitor then removes, about once a
 * minute, every document whose date is older than the expiry - the old ones included, as soon as the index has it.
 */
async function ensureTtlIndex<T extends Document>(
  appDb: AppDb,
  collection: Collection<T>,
  key: Record<string, 1 | -1>,
  name: string,
  expireAfterSeconds: number,
): Promise<void> {
  try {
    await collection.createIndex(key, { name, expireAfterSeconds });
  } catch (err) {
    const code = typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined;
    if (typeof code !== 'number' || !INDEX_CONFLICT.has(code)) throw err;
    await appDb.db.command({ collMod: collection.collectionName, index: { name, expireAfterSeconds } });
  }
}

/**
 * Creates every index listed in SPEC.md section 13. Safe to call on every boot (idempotent).
 *
 * Retention (owner decision 2026-10-07: the privacy page's promise is what the code does): `llm_calls`, `events`, `leads` and `feedback`
 * are TTL-expired by their own timestamp after `limits.retention` (the same numbers the page shows); `usage_counters` by their `expiresAt`
 * (the end of their period plus `limits.protection.counterGraceHours`); `learn_cache` after `limits.cache.ttlDays`; `sessions` at their
 * `expiresAt` (`limits.auth.sessionDays` after the last use). Every insert into the four record collections sets its timestamp as a Date,
 * so their TTL indexes cover the existing documents too; counters are the one place an old document may lack the field
 * (`backfillCounterExpiry`).
 */
export async function ensureIndexes(appDb: AppDb): Promise<void> {
  const { retention } = limits;
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
    ensureTtlIndex(appDb, appDb.events, { ts: 1 }, 'events_ts', retentionSeconds(retention.eventsMonths)),
    appDb.events.createIndex({ type: 1, ts: 1 }, { name: 'events_type_ts' }),
    appDb.events.createIndex({ userId: 1 }, { name: 'events_userId' }),
    appDb.events.createIndex({ anonId: 1 }, { name: 'events_anonId' }),
    ensureTtlIndex(appDb, appDb.llmCalls, { ts: 1 }, 'llm_calls_ts', retentionSeconds(retention.aiCallRecordsMonths)),
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
    // SPEC 13 / issue #40: one document per requested function (normalized name + signature); the admin lists the most asked-for first, per topic.
    appDb.functionRequests.createIndex({ key: 1 }, { unique: true, name: 'function_requests_key_unique' }),
    appDb.functionRequests.createIndex({ status: 1, distinctOwners: -1, count: -1 }, { name: 'function_requests_status_owners_count' }),
    appDb.functionRequests.createIndex({ topic: 1, distinctOwners: -1 }, { name: 'function_requests_topic_owners' }),
    // SPEC 13 / 14.2: the admin audit log is read newest first.
    appDb.adminAudit.createIndex({ ts: -1 }, { name: 'admin_audit_ts' }),
    // SPEC 13 (v13): public forms. `leads` holds both kinds (`lead`, `waitlist`); the admin lists the newest first, per kind.
    ensureTtlIndex(appDb, appDb.leads, { createdAt: -1 }, 'leads_createdAt', retentionSeconds(retention.formsMonths)),
    appDb.leads.createIndex({ kind: 1, createdAt: -1 }, { name: 'leads_kind_createdAt' }),
    ensureTtlIndex(appDb, appDb.feedback, { createdAt: -1 }, 'feedback_createdAt', retentionSeconds(retention.formsMonths)),
  ]);
}

/**
 * The one-time step for counters written before every counter had an expiry (owner decision 2026-10-07): until then the monthly AI-learn,
 * new-format and function-request counters (and a `lifetime` one) were written without `expiresAt`, and the TTL index skips a document
 * without it. Each such counter gets the expiry it would get today, read from its key (`counterExpiryOfKey`). Runs on every boot after
 * `ensureIndexes`: once every counter has an expiry it finds nothing and writes nothing. Returns how many it set.
 */
export async function backfillCounterExpiry(appDb: AppDb, now: Date = new Date()): Promise<number> {
  const bare = await appDb.usageCounters.find({ expiresAt: { $exists: false } }, { projection: { key: 1 } }).toArray();
  if (bare.length === 0) return 0;
  const res = await appDb.usageCounters.bulkWrite(
    bare.map((d) => ({
      updateOne: { filter: { _id: d._id, expiresAt: { $exists: false } }, update: { $set: { expiresAt: counterExpiryOfKey(d.key, now) } } },
    })),
    { ordered: false },
  );
  return res.modifiedCount;
}

/** How a counter write treats the expiry of a counter that exists already. */
export interface CounterWriteOptions {
  /** Keep the expiry the counter has (a take-back inside a window); `expiresAt` is used only when it has none. */
  keepExpiry?: boolean;
}

/**
 * Atomically increments a usage counter (SPEC 13: `usage_counters`), creating it if needed, and returns its new total.
 * Every counter carries `expiresAt` (owner decision 2026-10-07: the TTL index removes each one at the end of its period plus
 * `limits.protection.counterGraceHours`, or at the end of its own window): it is set on every write, or - with `keepExpiry` - kept,
 * and set only on a counter that has none.
 */
export async function incrementCounter(
  appDb: AppDb,
  key: string,
  by: number,
  expiresAt: Date,
  opts: CounterWriteOptions = {},
): Promise<number> {
  const update: UpdateFilter<UsageCounterDoc> | Document[] = opts.keepExpiry
    ? [{ $set: { count: { $add: [{ $ifNull: ['$count', 0] }, by] }, expiresAt: { $ifNull: ['$expiresAt', expiresAt] } } }]
    : { $inc: { count: by }, $set: { expiresAt } };

  const doc = await appDb.usageCounters.findOneAndUpdate({ key }, update, {
    upsert: true,
    returnDocument: 'after',
  });

  return doc?.count ?? by;
}
