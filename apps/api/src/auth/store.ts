// Everything sign-in persists (SPEC 13 `users`, `sessions`, and the anonymous-visitor attach) behind one small
// interface, so the routes are the same against real MongoDB and against the in-memory store used by tests
// and by dev runs with no database (same pattern as `protection/store.ts`).
import { limits } from '@formatai/shared';
import { MongoServerError, ObjectId, type Filter } from 'mongodb';
import type { AppDb } from '../db.js';
import type { EventDoc, UserDoc, UserIdentity } from '../models.js';
import type { ProviderIdentity } from './providers.js';

export type StoredUser = UserDoc & { _id: ObjectId };

export interface StoredSession {
  userId: ObjectId;
  lastSeenAt: Date;
  expiresAt: Date;
}

export type AddIdentityResult = 'ok' | 'providerLinked' | 'identityInUse';

export interface AuthStore {
  /**
   * The user with this identity: provider + subject (+ tenant for Microsoft) and NOTHING else - never the email.
   */
  findUserByIdentity(identity: UserIdentity): Promise<StoredUser | null>;
  getUser(id: ObjectId): Promise<StoredUser | null>;
  /** Inserts the user; null when a concurrent sign-in created the same identity first (it is unique). */
  createUser(user: UserDoc): Promise<StoredUser | null>;
  /** After a sign-in: current email / verified flag of that identity, name and avatar when the user has none, `lastSeenAt`. */
  refreshUser(user: StoredUser, identity: ProviderIdentity, now: Date): Promise<void>;
  /**
   * Adds a second provider's identity. `providerLinked`: the user already has an identity of that provider;
   * `identityInUse`: that identity belongs to another user.
   */
  addIdentity(userId: ObjectId, identity: UserIdentity): Promise<AddIdentityResult>;
  setUiLanguage(userId: ObjectId, uiLanguage: string): Promise<StoredUser | null>;
  /**
   * SPEC 12: attaches the browser's anonId to the user and gives its past events the `userId` (only those that have none). (It used to
   * re-own the anonymous visitor's `learn_cache` entries too: the AI step is for signed-in users only, SPEC 21 v5, so there are none.)
   */
  attachAnon(userId: ObjectId, anonId: string): Promise<void>;
  insertEvent(event: EventDoc): Promise<void>;

  /** Sessions are keyed by the hash of the id held in the cookie. */
  createSession(idHash: string, session: StoredSession & { createdAt: Date }): Promise<void>;
  /** The live session, or null when unknown or past `expiresAt` (the TTL index lags by up to a minute). */
  getSession(idHash: string, now: Date): Promise<StoredSession | null>;
  /** Sliding renewal: new expiry, and the user's `lastSeenAt`. */
  renewSession(idHash: string, userId: ObjectId, now: Date, expiresAt: Date): Promise<void>;
  deleteSession(idHash: string): Promise<void>;
}

/** Same provider, subject and tenant (Google identities have none). */
export function sameIdentity(a: UserIdentity, b: UserIdentity): boolean {
  return a.provider === b.provider && a.subject === b.subject && (a.tenantId ?? '') === (b.tenantId ?? '');
}

/** The identity as stored on the user (without the provider-only extras `name` / `avatarUrl`). */
export function toUserIdentity(identity: ProviderIdentity): UserIdentity {
  return {
    provider: identity.provider,
    subject: identity.subject,
    ...(identity.tenantId ? { tenantId: identity.tenantId } : {}),
    email: identity.email,
    emailVerified: identity.emailVerified,
  };
}

function isDuplicateKey(err: unknown): boolean {
  return err instanceof MongoServerError && err.code === 11000;
}

// ---------------------------------------------------------------------------------------------------------------------
// MongoDB
// ---------------------------------------------------------------------------------------------------------------------

export function createMongoAuthStore(appDb: AppDb): AuthStore {
  const { users, sessions } = appDb;

  return {
    async findUserByIdentity(identity) {
      return (await users.findOne({
        identities: {
          $elemMatch: {
            provider: identity.provider,
            subject: identity.subject,
            tenantId: identity.tenantId ?? { $exists: false },
          },
        },
      })) as StoredUser | null;
    },

    async getUser(id) {
      return (await users.findOne({ _id: id })) as StoredUser | null;
    },

    async createUser(user) {
      try {
        const res = await users.insertOne({ ...user });
        return { ...user, _id: res.insertedId };
      } catch (err) {
        if (isDuplicateKey(err)) return null;
        throw err;
      }
    },

    async refreshUser(user, identity, now) {
      const set: Record<string, unknown> = {
        lastSeenAt: now,
        'identities.$[i].emailVerified': identity.emailVerified,
      };
      if (identity.email) set['identities.$[i].email'] = identity.email;
      if (!user.name && identity.name) set.name = identity.name;
      if (!user.avatarUrl && identity.avatarUrl) set.avatarUrl = identity.avatarUrl;
      await users.updateOne(
        { _id: user._id },
        { $set: set },
        {
          arrayFilters: [
            {
              'i.provider': identity.provider,
              'i.subject': identity.subject,
              'i.tenantId': identity.tenantId ?? { $exists: false },
            },
          ],
        },
      );
    },

    async addIdentity(userId, identity) {
      try {
        const res = await users.updateOne(
          { _id: userId, 'identities.provider': { $ne: identity.provider } },
          { $push: { identities: identity } },
        );
        return res.matchedCount === 1 ? 'ok' : 'providerLinked';
      } catch (err) {
        if (isDuplicateKey(err)) return 'identityInUse';
        throw err;
      }
    },

    async setUiLanguage(userId, uiLanguage) {
      return (await users.findOneAndUpdate(
        { _id: userId },
        { $set: { uiLanguage } },
        { returnDocument: 'after' },
      )) as StoredUser | null;
    },

    async attachAnon(userId, anonId) {
      await users.updateOne(
        { _id: userId, anonIds: { $ne: anonId } },
        { $push: { anonIds: { $each: [anonId], $slice: -limits.auth.maxAnonIds } } },
      );
      // `userId: null` also matches events stored without the field. Events already owned by another user stay theirs.
      await appDb.events.updateMany({ anonId, userId: null } as unknown as Filter<EventDoc>, { $set: { userId } });
      // (API audit 2026-10-07: no learn cache is re-owned any more - the AI step is for signed-in users only, SPEC 21 v5, so an anonymous
      // visitor has none.)
    },

    async insertEvent(event) {
      await appDb.events.insertOne({ ...event });
    },

    async createSession(idHash, session) {
      await sessions.insertOne({ _id: idHash, ...session });
    },

    async getSession(idHash, now) {
      const doc = await sessions.findOne({ _id: idHash, expiresAt: { $gt: now } });
      return doc ? { userId: doc.userId, lastSeenAt: doc.lastSeenAt, expiresAt: doc.expiresAt } : null;
    },

    async renewSession(idHash, userId, now, expiresAt) {
      await sessions.updateOne({ _id: idHash }, { $set: { lastSeenAt: now, expiresAt } });
      await users.updateOne({ _id: userId }, { $set: { lastSeenAt: now } });
    },

    async deleteSession(idHash) {
      await sessions.deleteOne({ _id: idHash });
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// In memory (tests and dev without MONGODB_URI; lost on restart)
// ---------------------------------------------------------------------------------------------------------------------

export interface MemoryAuthStore extends AuthStore {
  readonly users: Map<string, StoredUser>;
  readonly sessions: Map<string, StoredSession>;
  /** Every event written or attached, for assertions. */
  readonly events: EventDoc[];
}

export function createMemoryAuthStore(): MemoryAuthStore {
  const users = new Map<string, StoredUser>();
  const sessions = new Map<string, StoredSession>();
  const events: EventDoc[] = [];

  // (structuredClone would turn the ObjectId into a plain object.)
  const clone = (u: StoredUser): StoredUser => ({
    ...u,
    identities: u.identities.map((i) => ({ ...i })),
    anonIds: [...u.anonIds],
    ...(u.limitOverrides ? { limitOverrides: { ...u.limitOverrides } } : {}),
  });
  const find = (identity: UserIdentity): StoredUser | undefined =>
    [...users.values()].find((u) => u.identities.some((i) => sameIdentity(i, identity)));

  return {
    users,
    sessions,
    events,

    async findUserByIdentity(identity) {
      const u = find(identity);
      return u ? clone(u) : null;
    },

    async getUser(id) {
      const u = users.get(id.toHexString());
      return u ? clone(u) : null;
    },

    async createUser(user) {
      // The Mongo unique index is on provider + subject.
      const taken = user.identities.some((i) =>
        [...users.values()].some((u) => u.identities.some((x) => x.provider === i.provider && x.subject === i.subject)),
      );
      if (taken) return null;
      const stored: StoredUser = { ...clone({ ...user, _id: new ObjectId() }) };
      users.set(stored._id.toHexString(), stored);
      return clone(stored);
    },

    async refreshUser(user, identity, now) {
      const u = users.get(user._id.toHexString());
      if (!u) return;
      const own = u.identities.find((i) => sameIdentity(i, identity));
      if (own) {
        own.emailVerified = identity.emailVerified;
        if (identity.email) own.email = identity.email;
      }
      if (!u.name && identity.name) u.name = identity.name;
      if (!u.avatarUrl && identity.avatarUrl) u.avatarUrl = identity.avatarUrl;
      u.lastSeenAt = now;
    },

    async addIdentity(userId, identity) {
      if ([...users.values()].some((u) => u.identities.some((i) => i.provider === identity.provider && i.subject === identity.subject))) {
        return 'identityInUse';
      }
      const u = users.get(userId.toHexString());
      if (!u || u.identities.some((i) => i.provider === identity.provider)) return 'providerLinked';
      u.identities.push({ ...identity });
      return 'ok';
    },

    async setUiLanguage(userId, uiLanguage) {
      const u = users.get(userId.toHexString());
      if (!u) return null;
      u.uiLanguage = uiLanguage;
      return clone(u);
    },

    async attachAnon(userId, anonId) {
      const u = users.get(userId.toHexString());
      if (u && !u.anonIds.includes(anonId)) u.anonIds = [...u.anonIds, anonId].slice(-limits.auth.maxAnonIds);
      for (const e of events) if (e.anonId === anonId && e.userId === undefined) e.userId = userId;
    },

    async insertEvent(event) {
      events.push({ ...event });
    },

    async createSession(idHash, session) {
      sessions.set(idHash, { userId: session.userId, lastSeenAt: session.lastSeenAt, expiresAt: session.expiresAt });
    },

    async getSession(idHash, now) {
      const s = sessions.get(idHash);
      return s && s.expiresAt.getTime() > now.getTime() ? { ...s } : null;
    },

    async renewSession(idHash, userId, now, expiresAt) {
      const s = sessions.get(idHash);
      if (s) {
        s.lastSeenAt = now;
        s.expiresAt = expiresAt;
      }
      const u = users.get(userId.toHexString());
      if (u) u.lastSeenAt = now;
    },

    async deleteSession(idHash) {
      sessions.delete(idHash);
    },
  };
}
