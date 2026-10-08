// The overview's Usage section (SPEC 14.2; the beta usage events, 14.1): computed ONLY from the `events` of the period, each number "n/a" (null)
// when its event type has no row in the period - never 0 for "not recorded". Fastify inject against a real MongoDB (skipped without
// MONGODB_URI); the admin identity is stubbed like in `admin.test.ts`.
import { randomUUID } from 'node:crypto';
import { limits, type AdminOverview, type EventType } from '@formatai/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ObjectId } from 'mongodb';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { connectDb, ensureIndexes, type AppDb } from '../../src/db.js';
import { loadEnv } from '../../src/env.js';
import type { EventDoc } from '../../src/models.js';
import type { Identity } from '../../src/protection/identity.js';
import { createMemoryStore } from '../../src/protection/store.js';
import { buildServer } from '../../src/server.js';
import { dropTestDb } from '../setup/testDbs.js';
import { makeEnv, mongoUri, nextIp, testUserId } from '../protection/harness.js';

const NOW = new Date('2026-10-08T12:00:00.000Z');
const at = (iso: string): Date => new Date(iso);
const ADMIN = testUserId(100);
const [U1, U2, U3] = [testUserId(1), testUserId(2), testUserId(3)];
const WEB_ORIGIN = 'http://localhost:5173';

function identify(req: FastifyRequest): Identity {
  const user = req.headers['x-test-user'];
  if (typeof user !== 'string') return { kind: 'anon', anonId: req.anonId };
  return { kind: 'user', userId: user, tier: 'registered', anonId: req.anonId, isAdmin: true };
}

describe.skipIf(!mongoUri)("the overview's Usage section (MongoDB)", () => {
  let db: AppDb;
  let app: FastifyInstance;

  beforeAll(async () => {
    const env = loadEnv({ ...process.env, MONGODB_URI: mongoUri, MONGODB_DB: `formatai_test_usage_${randomUUID().slice(0, 8)}` });
    const connected = await connectDb(env);
    if (!connected) throw new Error('MongoDB not configured');
    db = connected;
    await ensureIndexes(db);
    app = await buildServer({ env: makeEnv({ WEB_ORIGIN }), db, logger: false, store: createMemoryStore(() => NOW), now: () => new Date(NOW), identify });
  });
  afterAll(async () => {
    await dropTestDb(db, app);
  });
  afterEach(async () => {
    await db.events.deleteMany({});
  });

  async function overview(days = 30): Promise<AdminOverview> {
    const res = await app.inject({ method: 'GET', url: `/api/admin/overview?days=${days}`, remoteAddress: nextIp(), headers: { 'x-test-user': ADMIN } });
    expect(res.statusCode).toBe(200);
    return res.json() as AdminOverview;
  }
  const usage = async (days = 30): Promise<AdminOverview['usage']> => (await overview(days)).usage;

  /** One event; `user` null = a visitor's (no id). */
  const ev = (type: EventType, props: Record<string, unknown>, user: string | null, ts = '2026-10-05T10:00:00Z'): EventDoc => ({
    ts: at(ts),
    type,
    props,
    ...(user ? { userId: new ObjectId(user) } : {}),
  });
  const learn = (path: string, status: string, user: string | null = null, ts?: string) => ev('learn_completed', { path, status, masking: true, aiClicked: path !== 'local' }, user, ts);
  const run = (daysSinceCreated: number, user: string | null, ts?: string) => ev('format_run', { daysSinceCreated, rows: 10, flagged: 1 }, user, ts);

  it('is n/a for every group when the period holds none of the events - not 0', async () => {
    // an event of another kind is there, so the database is not empty: still n/a
    await db.events.insertOne(ev('page_view', { page: 'home' }, null));
    expect(await usage()).toEqual({
      learns: null,
      matching: null,
      formatsChosen: null,
      limits: null,
      saves: null,
      returning: null,
      funnel: { uploaded: null, learned: null, saved: null, ran: null, ranAgain: null },
    });
  });

  it("counts the learns by path and status, a visitor's included", async () => {
    await db.events.insertMany([
      learn('local', 'verified'),
      learn('local', 'verified', U1),
      learn('local', 'partial', U1),
      learn('llm', 'verified', U1),
      learn('llm', 'failed', U2),
      learn('cache', 'verified', U2),
      learn('local', 'blocked'),
    ]);
    const o = await overview();
    expect(o.usage.learns).toEqual([
      { path: 'cache', status: 'verified', count: 1 },
      { path: 'llm', status: 'failed', count: 1 },
      { path: 'llm', status: 'verified', count: 1 },
      { path: 'local', status: 'verified', count: 2 },
      { path: 'local', status: 'blocked', count: 1 },
      { path: 'local', status: 'partial', count: 1 },
    ]);
    expect(o.learns.local).toBe(2);
  });

  it('counts how matching went: auto, choose, none', async () => {
    await db.events.insertMany([
      ev('file_matched', { result: 'auto', score: 0.97 }, U1),
      ev('file_matched', { result: 'auto', score: 0.91 }, U1),
      ev('file_matched', { result: 'choose', score: 0.7 }, U2),
      ev('file_matched', { result: 'none' }, U2),
    ]);
    expect((await usage()).matching).toEqual({ auto: 2, choose: 1, none: 1 });
  });

  it('says what people pick at the "which formats?" step: how often, how often everything, how many offered vs chosen, single vs batch', async () => {
    await db.events.insertMany([
      ev('formats_chosen', { offered: 3, chosen: 3, all: true, batch: false }, U1),
      ev('formats_chosen', { offered: 4, chosen: 1, all: false, batch: false }, U1),
      ev('formats_chosen', { offered: 2, chosen: 2, all: true, batch: true }, U2),
      ev('formats_chosen', { offered: 3, chosen: 0, all: false, batch: true }, U2),
    ]);
    expect((await usage()).formatsChosen).toEqual({ asked: 4, allShare: 0.5, avgOffered: 3, avgChosen: 1.5, single: 2, batch: 2 });
  });

  it('counts the limits hit, the most frequent first, and the saves by kind', async () => {
    await db.events.insertMany([
      ev('limit_hit', { limit: 'savedFormats' }, U1),
      ev('limit_hit', { limit: 'aiLearns' }, U1),
      ev('limit_hit', { limit: 'aiLearns' }, U2),
      ev('format_saved', { kind: 'new' }, U1),
      ev('format_saved', { kind: 'new' }, U2),
      ev('format_saved', { kind: 'edit' }, U2),
      ev('format_saved', { kind: 'anotherInput' }, U1),
    ]);
    const u = await usage();
    expect(u.limits).toEqual([
      { limit: 'aiLearns', count: 2 },
      { limit: 'savedFormats', count: 1 },
    ]);
    expect(u.saves).toEqual({ new: 2, anotherInput: 1, update: 0, edit: 1 });
  });

  it(`counts returning use: signed-in users with a run ${limits.admin.returningAfterDays}+ days after the format was made, and runs per active user`, async () => {
    await db.events.insertMany([
      run(0, U1),
      run(3, U1),
      run(limits.admin.returningAfterDays, U1), // exactly the threshold counts
      run(2, U2),
      run(20, U3),
      run(40, U3),
      run(6, U2),
    ]);
    expect((await usage()).returning).toEqual({ users: 2, runs: 7, activeUsers: 3, runsPerActiveUser: 2.3 });
  });

  it('counts only the period: 7 days leaves out what the 30 holds', async () => {
    await db.events.insertMany([run(9, U1, '2026-10-06T10:00:00Z'), run(9, U2, '2026-09-20T10:00:00Z'), ev('limit_hit', { limit: 'aiLearns' }, U2, '2026-09-20T10:00:00Z')]);
    expect((await usage(7)).returning).toEqual({ users: 1, runs: 1, activeUsers: 1, runsPerActiveUser: 1 });
    expect((await usage(7)).limits).toBeNull(); // n/a in the 7 days, though the 30 has one
    expect((await usage(30)).returning).toEqual({ users: 2, runs: 2, activeUsers: 2, runsPerActiveUser: 1 });
    expect((await usage(30)).limits).toEqual([{ limit: 'aiLearns', count: 1 }]);
  });

  describe('the signed-in funnel (distinct users per step)', () => {
    it('counts each user once per step, visitors never, and the last step is a run 7+ days after creation', async () => {
      await db.events.insertMany([
        // U1 goes all the way; U2 stops after saving; U3 only uploads
        ev('file_uploaded', { role: 'input', fileType: 'csv', rows: 5, cols: 2 }, U1),
        ev('file_uploaded', { role: 'output', fileType: 'csv', rows: 5, cols: 2 }, U1),
        ev('file_uploaded', { role: 'input', fileType: 'csv', rows: 5, cols: 2 }, U2),
        ev('file_uploaded', { role: 'input', fileType: 'csv', rows: 5, cols: 2 }, U3),
        ev('file_uploaded', { role: 'input', fileType: 'csv', rows: 5, cols: 2 }, null),
        learn('local', 'verified', U1),
        learn('local', 'verified', U1),
        learn('llm', 'verified', U2),
        learn('local', 'verified', null),
        ev('format_saved', { kind: 'new' }, U1),
        ev('format_saved', { kind: 'new' }, U2),
        run(1, U1),
        run(12, U1),
        run(30, U1),
      ]);
      expect((await usage()).funnel).toEqual({ uploaded: 3, learned: 2, saved: 2, ran: 1, ranAgain: 1 });
    });

    it('says n/a for a step whose event type has no row in the period, and 0 for one that has rows but no signed-in user', async () => {
      await db.events.insertMany([learn('local', 'verified', null), ev('file_uploaded', { role: 'input', fileType: 'csv' }, U1)]);
      expect((await usage()).funnel).toEqual({ uploaded: 1, learned: 0, saved: null, ran: null, ranAgain: null });
    });

    it('is 0 for "ran again" when every run was early, not n/a: runs were recorded', async () => {
      await db.events.insertMany([run(2, U1)]);
      expect((await usage()).funnel.ranAgain).toBe(0);
    });
  });

  it('keeps the "events by type" list', async () => {
    await db.events.insertMany([learn('local', 'verified'), learn('local', 'verified'), ev('page_view', { page: 'home' }, null)]);
    expect((await overview()).events).toEqual([
      { type: 'learn_completed', count: 2 },
      { type: 'page_view', count: 1 },
    ]);
  });
});
