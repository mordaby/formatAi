// Users in the admin view (SPEC 11, 13, 14.2): find a user, see the tier, how many AI learns this period has used and how many formats they
// have, and set the tier (registered <-> paid: anonymous has no user) and `limitOverrides`. There is no way to delete a user in the MVP.
import { limits, tiers, type AdminUserRow, type AuthProviderId } from '@formatai/shared';
import type { Filter, ObjectId } from 'mongodb';
import type { AppDb } from '../db.js';
import type { UserDoc } from '../models.js';
import { aiLearnsKey } from '../protection/keys.js';

type StoredUser = UserDoc & { _id: ObjectId };

/** The email shown for a user: a verified one when there is one. */
export function primaryEmail(user: Pick<UserDoc, 'identities'>): string | undefined {
  return (user.identities.find((i) => i.emailVerified && i.email) ?? user.identities.find((i) => i.email))?.email;
}

/** Text typed into a search box is text, never a pattern. */
const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The filter of "search by email or name": a case-insensitive substring of any email on the account, or of the name. */
export function userSearchFilter(q: string): Filter<UserDoc> {
  const text = q.trim().slice(0, limits.admin.maxSearchChars);
  if (text === '') return {};
  const re = new RegExp(escapeRegExp(text), 'i');
  return { $or: [{ 'identities.email': re }, { name: re }] };
}

/** The users of one page (newest first) with their numbers. */
export async function listUsers(
  db: AppDb,
  now: Date,
  opts: { q: string; page: number; pageSize: number },
): Promise<{ users: AdminUserRow[]; total: number }> {
  const filter = userSearchFilter(opts.q);
  const [total, found] = await Promise.all([
    db.users.countDocuments(filter),
    db.users
      .find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .skip((opts.page - 1) * opts.pageSize)
      .limit(opts.pageSize)
      .toArray(),
  ]);
  return { users: await presentUsers(db, found as StoredUser[], now), total };
}

/** What the effective AI-learn limit is: the admin's override when there is one, else the tier's (`null`: unlimited). */
function aiLimit(user: StoredUser): number | null {
  const quota = tiers[user.tier].aiLearns;
  if (quota.period === 'unlimited') return null;
  return user.limitOverrides?.aiLearns ?? user.limitOverrides?.learnsToLlm ?? quota.count;
}

export async function presentUsers(db: AppDb, users: readonly StoredUser[], now: Date): Promise<AdminUserRow[]> {
  if (users.length === 0) return [];
  const ids = users.map((u) => u._id);
  const keys = users.flatMap((u) => {
    const { period } = tiers[u.tier].aiLearns;
    return period === 'unlimited' ? [] : [aiLearnsKey(u._id.toHexString(), period, now)];
  });
  const [counters, formatCounts] = await Promise.all([
    keys.length === 0 ? [] : db.usageCounters.find({ key: { $in: keys } }).toArray(),
    db.formats.aggregate<{ _id: ObjectId; n: number }>([{ $match: { ownerId: { $in: ids } } }, { $group: { _id: '$ownerId', n: { $sum: 1 } } }]).toArray(),
  ]);
  const used = new Map(counters.map((c) => [c.key, c.count] as const));
  const formats = new Map(formatCounts.map((f) => [f._id.toHexString(), f.n] as const));

  return users.map((u) => {
    const { period } = tiers[u.tier].aiLearns;
    const emails = [...new Set([...u.identities.filter((i) => i.emailVerified && i.email), ...u.identities.filter((i) => i.email)].map((i) => i.email))];
    return {
      id: u._id.toHexString(),
      name: u.name ?? null,
      emails,
      providers: [...new Set(u.identities.map((i) => i.provider))] as AuthProviderId[],
      tier: u.tier,
      createdAt: u.createdAt.toISOString(),
      lastSeenAt: u.lastSeenAt.toISOString(),
      aiLearns: { used: period === 'unlimited' ? null : Math.max(0, used.get(aiLearnsKey(u._id.toHexString(), period, now)) ?? 0), limit: aiLimit(u), period },
      formats: formats.get(u._id.toHexString()) ?? 0,
      limitOverrides: { ...(u.limitOverrides ?? {}) },
    };
  });
}

// ---------------------------------------------------------------- the change an admin may make

export interface UserUpdate {
  tier?: 'registered' | 'paid';
  /** The user's whole override map afterwards (`null`: none). */
  limitOverrides?: Record<string, number> | null;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * A request body checked: only `tier` (`registered` or `paid`) and `limitOverrides` (null, or whole numbers for the keys in
 * `limits.admin.overrideKeys`, at most `limits.admin.maxOverride`). Anything else - another field, another tier, a fraction - is refused.
 */
export function parseUserUpdate(body: unknown): UserUpdate | null {
  if (!isPlainObject(body)) return null;
  const keys = Object.keys(body);
  if (keys.length === 0 || keys.some((k) => k !== 'tier' && k !== 'limitOverrides')) return null;
  const update: UserUpdate = {};

  if ('tier' in body) {
    if (body.tier !== 'registered' && body.tier !== 'paid') return null;
    update.tier = body.tier;
  }
  if ('limitOverrides' in body) {
    const raw = body.limitOverrides;
    if (raw === null) {
      update.limitOverrides = null;
    } else if (isPlainObject(raw)) {
      const allowed: readonly string[] = limits.admin.overrideKeys;
      const next: Record<string, number> = {};
      for (const [key, value] of Object.entries(raw)) {
        if (!allowed.includes(key)) return null;
        if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > limits.admin.maxOverride) return null;
        next[key] = value;
      }
      update.limitOverrides = Object.keys(next).length === 0 ? null : next;
    } else {
      return null;
    }
  }
  return update;
}

export function sameOverrides(a: Record<string, number> | undefined, b: Record<string, number> | undefined): boolean {
  const x = Object.entries(a ?? {}).sort(([p], [q]) => p.localeCompare(q));
  const y = Object.entries(b ?? {}).sort(([p], [q]) => p.localeCompare(q));
  return x.length === y.length && x.every(([k, v], i) => k === y[i]![0] && v === y[i]![1]);
}
