// The admin routes (SPEC 14.2, M4), all under /api/admin and for admins only:
//
//   GET   /api/admin/overview?days=7|30|90            users, learns, AI calls and their estimated cost, problems, function requests
//   GET   /api/admin/function-requests                every group (name + signature) with count, first and last seen, topic, issue link
//   PATCH /api/admin/function-requests/:id            { status: "issueOpened" | "new" }: mark that its GitHub issue was opened (or take it back)
//   GET   /api/admin/users?q=&page=&pageSize=         search by email or name
//   PATCH /api/admin/users/:id                        { tier?, limitOverrides? }: every change goes to the audit log
//   GET   /api/admin/contacts?source=lead|feedback    leads and feedback, read-only
//   GET   /api/admin/audit                            the newest audit lines
//
// Every route runs the same gate first, in this order: the per-IP rate limit (429), a sign-in (401 `signInRequired`), `isAdmin` evaluated by the
// SERVER from the session (403 `forbidden`: the web app hiding a link is a courtesy, never the check), the database (503 `unavailable`). A change
// (PATCH) must also come from our own origin when the browser says where it comes from. Nothing here returns a file's contents (the server has
// none), a masked payload, a secret or the text of an `llm_calls` row: the numbers are counts and sums, and refusals are stable codes.
import { limits, type AdminContactsResponse, type AdminAuditResponse, type AdminFunctionRequestsResponse, type AdminUpdateFunctionRequestResponse, type AdminUpdateUserResponse, type AdminUsersResponse } from '@formatai/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ObjectId } from 'mongodb';
import type { AppDb } from '../db.js';
import type { Env } from '../env.js';
import type { FunctionRequestStatus } from '../models.js';
import { identityOf, type Identity } from '../protection/identity.js';
import { normalizeIp } from '../protection/ip.js';
import type { Protection } from '../protection/index.js';
import { createRateLimiter } from '../protection/rateLimit.js';
import { fail } from '../registry/context.js';
import { objectIdOf } from '../registry/ids.js';
import { actorOf, listAudit, recordChanges, undoRecorded, type AuditChange } from './audit.js';
import { listContacts } from './contacts.js';
import { presentFunctionRequest } from './functionRequests.js';
import { buildOverview } from './overview.js';
import { listUsers, parseUserUpdate, presentUsers, sameOverrides } from './users.js';

export interface RegisterAdminRoutesOptions {
  /** Null when no database is configured: every admin route then answers 503 `unavailable`. */
  db: AppDb | null;
  env: Env;
  protection: Protection;
  /** Tests: who is calling (default: `identityOf`, which reads the session; `isAdmin` is set by the session from ADMIN_EMAILS / MICROSOFT_ADMIN_OIDS). */
  identify?: (req: FastifyRequest) => Identity;
}

/** A positive whole number from a query string, or null. */
function wholeNumber(raw: unknown, min: number, max: number): number | null {
  if (typeof raw !== 'string' || !/^\d{1,6}$/.test(raw)) return null;
  const n = Number(raw);
  return n >= min && n <= max ? n : null;
}

export function registerAdminRoutes(app: FastifyInstance, opts: RegisterAdminRoutesOptions): void {
  const { db, protection } = opts;
  const identify = opts.identify ?? identityOf;
  const limiter = createRateLimiter({
    max: limits.admin.requestsPerIpPerMinute,
    windowMs: limits.protection.rateLimitWindowMs,
    now: () => protection.now().getTime(),
  });
  const allowedOrigins = new Set([new URL(opts.env.WEB_ORIGIN).origin, new URL(opts.env.API_PUBLIC_URL ?? `http://localhost:${opts.env.PORT}`).origin]);

  /** The admin making this request (the gate has already passed). */
  const adminId = (req: FastifyRequest): ObjectId => {
    const identity = identify(req);
    const id = identity.kind === 'user' ? objectIdOf(identity.userId) : undefined;
    if (!id) throw new Error('an admin route ran without an admin'); // (the gate above makes this unreachable)
    return id;
  };

  // An encapsulated plugin: the gate below belongs to the admin routes only.
  void app.register(async (admin) => {
    admin.addHook('onRequest', async (req, reply) => {
      void reply.header('cache-control', 'no-store');

      // 1. The rate limit comes first: a flood must not reach the session's data, let alone the database.
      const verdict = limiter.hit(normalizeIp(req.ip));
      if (!verdict.allowed) {
        void reply.header('retry-after', String(verdict.retryAfterSec));
        return fail(reply, 429, { error: 'rateLimited' });
      }
      // 2. Signed in? 3. An admin? The server decides, from the session.
      const identity = identify(req);
      if (identity.kind !== 'user' || !objectIdOf(identity.userId)) return fail(reply, 401, { error: 'signInRequired' });
      if (identity.isAdmin !== true) return fail(reply, 403, { error: 'forbidden' });
      // 4. Defence in depth for a change, on top of SameSite=Lax and JSON-only bodies: a browser that names an Origin must name ours.
      if (req.method !== 'GET' && req.headers.origin !== undefined && !allowedOrigins.has(req.headers.origin)) return fail(reply, 403, { error: 'forbidden' });
      if (!db) return fail(reply, 503, { error: 'unavailable' });
      return undefined;
    });

    const dbOf = (): AppDb => db!;

    // ------------------------------------------------------------ overview

    admin.get('/api/admin/overview', async (req, reply) => {
      const raw = (req.query as { days?: unknown }).days;
      const days = raw === undefined ? limits.admin.defaultPeriodDays : wholeNumber(raw, 1, 365);
      if (days === null || !(limits.admin.periodsDays as readonly number[]).includes(days)) return fail(reply, 400, { error: 'invalidRequest' });
      return buildOverview(dbOf(), protection.now(), days);
    });

    // ------------------------------------------------------------ function requests

    admin.get('/api/admin/function-requests', async (): Promise<AdminFunctionRequestsResponse> => {
      const docs = await dbOf()
        .functionRequests.find({})
        .sort({ distinctOwners: -1, count: -1, lastSeen: -1 })
        .limit(limits.admin.functionRequestsListed)
        .toArray();
      return {
        requests: docs.map((d) => presentFunctionRequest(d as typeof d & { _id: ObjectId })),
        threshold: limits.learn.functionRequests.issueThreshold,
      };
    });

    admin.patch('/api/admin/function-requests/:id', async (req, reply) => {
      const d = dbOf();
      const id = objectIdOf((req.params as { id?: string }).id);
      const body = req.body as Record<string, unknown> | null;
      const keys = body && typeof body === 'object' && !Array.isArray(body) ? Object.keys(body) : [];
      if (keys.length !== 1 || (body?.status !== 'issueOpened' && body?.status !== 'new')) return fail(reply, 400, { error: 'invalidRequest' });
      const status: FunctionRequestStatus = body.status;
      if (!id) return fail(reply, 404, { error: 'notFound' });

      const before = await d.functionRequests.findOne({ _id: id });
      if (!before) return fail(reply, 404, { error: 'notFound' });
      // `approved` and `declined` are the build pipeline's (issue #41); this view only moves a request between new and issueOpened.
      if (before.status !== 'new' && before.status !== 'issueOpened') return fail(reply, 409, { error: 'versionConflict' });
      if (before.status === status) return { request: presentFunctionRequest(before as typeof before & { _id: ObjectId }) } satisfies AdminUpdateFunctionRequestResponse;

      const actor = await actorOf(d, adminId(req));
      const lines = await recordChanges(d, actor, [{ action: 'functionRequest.status', targetKind: 'functionRequest', targetId: id, before: before.status, after: status }], protection.now());
      let after;
      try {
        // Only from the status that was just read: two admins clicking at once cannot both win.
        after = await d.functionRequests.findOneAndUpdate({ _id: id, status: before.status }, { $set: { status } }, { returnDocument: 'after' });
      } catch (err) {
        await undoRecorded(d, lines);
        throw err;
      }
      if (!after) {
        await undoRecorded(d, lines);
        return fail(reply, 409, { error: 'versionConflict' });
      }
      return { request: presentFunctionRequest(after as typeof after & { _id: ObjectId }) } satisfies AdminUpdateFunctionRequestResponse;
    });

    // ------------------------------------------------------------ users

    admin.get('/api/admin/users', async (req, reply): Promise<AdminUsersResponse | FastifyReply> => {
      const query = req.query as { q?: unknown; page?: unknown; pageSize?: unknown };
      if (query.q !== undefined && typeof query.q !== 'string') return fail(reply, 400, { error: 'invalidRequest' });
      const page = query.page === undefined ? 1 : wholeNumber(query.page, 1, 100_000);
      const pageSize = query.pageSize === undefined ? limits.admin.usersPageSize : wholeNumber(query.pageSize, 1, limits.admin.maxUsersPageSize);
      if (page === null || pageSize === null) return fail(reply, 400, { error: 'invalidRequest' });
      const { users, total } = await listUsers(dbOf(), protection.now(), { q: query.q ?? '', page, pageSize });
      return { users, total, page, pageSize };
    });

    admin.patch('/api/admin/users/:id', async (req, reply) => {
      const d = dbOf();
      const update = parseUserUpdate(req.body);
      if (!update) return fail(reply, 400, { error: 'invalidRequest' });
      const id = objectIdOf((req.params as { id?: string }).id);
      const user = id ? await d.users.findOne({ _id: id }) : null;
      if (!id || !user) return fail(reply, 404, { error: 'notFound' });

      const changes: AuditChange[] = [];
      const set: Record<string, unknown> = {};
      const unset: Record<string, ''> = {};
      if (update.tier !== undefined && update.tier !== user.tier) {
        set.tier = update.tier;
        changes.push({ action: 'user.tier', targetKind: 'user', targetId: id, before: user.tier, after: update.tier });
      }
      if (update.limitOverrides !== undefined && !sameOverrides(user.limitOverrides, update.limitOverrides ?? undefined)) {
        if (update.limitOverrides === null) unset.limitOverrides = '';
        else set.limitOverrides = update.limitOverrides;
        changes.push({ action: 'user.limitOverrides', targetKind: 'user', targetId: id, before: user.limitOverrides ?? null, after: update.limitOverrides });
      }

      if (changes.length > 0) {
        // The log first, the change second, and the log lines taken back if the change does not happen: a change is never made unrecorded.
        const lines = await recordChanges(d, await actorOf(d, adminId(req)), changes, protection.now());
        try {
          await d.users.updateOne({ _id: id }, { ...(Object.keys(set).length > 0 ? { $set: set } : {}), ...(Object.keys(unset).length > 0 ? { $unset: unset } : {}) });
        } catch (err) {
          await undoRecorded(d, lines);
          throw err;
        }
      }
      const fresh = (await d.users.findOne({ _id: id }))!;
      const [row] = await presentUsers(d, [fresh as typeof fresh & { _id: ObjectId }], protection.now());
      return { user: row! } satisfies AdminUpdateUserResponse;
    });

    // ------------------------------------------------------------ leads and feedback, audit log

    admin.get('/api/admin/contacts', async (req, reply): Promise<AdminContactsResponse | FastifyReply> => {
      const source = (req.query as { source?: unknown }).source;
      if (source !== undefined && source !== 'lead' && source !== 'feedback' && source !== 'all') return fail(reply, 400, { error: 'invalidRequest' });
      return { items: await listContacts(dbOf(), source ?? 'all') };
    });

    admin.get('/api/admin/audit', async (): Promise<AdminAuditResponse> => ({ entries: await listAudit(dbOf()) }));
  });
}
