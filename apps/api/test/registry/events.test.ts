// The usage events the registry routes write where the action happens (SPEC 14.1; owner decision 2026-10-08): `format_saved` (a new format, another
// input of one, an editor save), `format_run` (counts and the age of the FORMAT in whole days - the returning-use metric) and `limit_hit`
// (one hook sees every refusal). Fastify inject against a real MongoDB (skipped without MONGODB_URI), the identity stubbed.
//
// What is checked: the right kind from the right route, only on success, for the signed-in user's id and no other, props that are counts and
// codes (a file name in the request never reaches an event), and that a store that cannot write costs the user nothing.
import { randomUUID } from 'node:crypto';
import { tiers } from '@formatai/shared';
import type { FastifyInstance } from 'fastify';
import { ObjectId } from 'mongodb';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { connectDb, ensureIndexes, type AppDb } from '../../src/db.js';
import { loadEnv } from '../../src/env.js';
import type { EventStore } from '../../src/events/index.js';
import type { EventDoc } from '../../src/models.js';
import { createMemoryStore } from '../../src/protection/store.js';
import { buildServer } from '../../src/server.js';
import { dropTestDb } from '../setup/testDbs.js';
import { makeEnv, mongoUri, stubIdentify, testUserId } from '../protection/harness.js';
import { edited, makeCaller, saveBody, sourceOne, sourceTwo, TEST_USER } from './helpers.js';

const DAY = 24 * 60 * 60 * 1000;
const OTHER_USER = testUserId(2);
const START = new Date('2026-09-01T12:00:00.000Z');

describe.skipIf(!mongoUri)('usage events written by the registry routes (MongoDB)', () => {
  let appDb: AppDb;
  let app: FastifyInstance;
  let call: ReturnType<typeof makeCaller>;
  const clock = { current: new Date(START) };
  const now = (): Date => new Date(clock.current);
  const originalSavedFormats = tiers.registered.savedFormats;

  async function start(eventStore?: EventStore): Promise<void> {
    await app?.close();
    app = await buildServer({ env: makeEnv(), db: appDb, logger: false, store: createMemoryStore(now), now, identify: stubIdentify, ...(eventStore ? { eventStore } : {}) });
    call = makeCaller(app);
  }

  const events = (type?: string): Promise<EventDoc[]> => appDb.events.find(type ? { type } : {}).sort({ ts: 1, _id: 1 }).toArray();

  beforeAll(async () => {
    const env = loadEnv({ ...process.env, MONGODB_URI: mongoUri, MONGODB_DB: `formatai_test_evr_${randomUUID().slice(0, 8)}` });
    const db = await connectDb(env);
    if (!db) throw new Error('MongoDB not configured');
    appDb = db;
    await ensureIndexes(appDb);
  });

  afterAll(async () => {
    await dropTestDb(appDb, app);
  });

  beforeEach(async () => {
    clock.current = new Date(START);
    await Promise.all([appDb.formats.deleteMany({}), appDb.conversions.deleteMany({}), appDb.sources.deleteMany({}), appDb.events.deleteMany({})]);
    await start();
  });

  afterEach(() => {
    (tiers.registered as { savedFormats: number | 'unlimited' }).savedFormats = originalSavedFormats;
  });

  const create = (over: Record<string, unknown> = {}, user: string | null = TEST_USER) => call('POST', '/api/formats', { name: 'Catalog load', ...saveBody(sourceOne(), over) }, { user });

  describe('format_saved', () => {
    it('is "new" for a new format, with the user\'s id and nothing but the kind', async () => {
      const res = await create();
      expect(res.status).toBe(201);
      const saved = await events('format_saved');
      expect(saved).toHaveLength(1);
      expect(saved[0]).toMatchObject({ type: 'format_saved', props: { kind: 'new' }, userId: new ObjectId(TEST_USER), ts: START });
      expect(saved[0]!.anonId).toBeUndefined();
    });

    it('is "anotherInput" for an input attached to a format', async () => {
      const formatId = (await create()).body.format.id as string;
      const res = await call('POST', `/api/formats/${formatId}/conversions`, { sourceName: 'Input 2', ...saveBody(sourceTwo()) });
      expect(res.status).toBe(201);
      expect((await events('format_saved')).map((e) => e.props)).toEqual([{ kind: 'new' }, { kind: 'anotherInput' }]);
    });

    it('is "edit" for a rules save (Save\'s "Update your format" and the editor share this route: DECISION, SPEC 14.1)', async () => {
      const id = (await create()).body.conversion.id as string;
      const rules = edited(sourceOne(), (r) => {
        r.output.columns[1]!.header = 'Total due';
      });
      const res = await call('PATCH', `/api/conversions/${id}`, { rules, status: 'verified', acceptedDifferences: 0 });
      expect(res.status).toBe(200);
      expect((await events('format_saved')).map((e) => e.props)).toEqual([{ kind: 'new' }, { kind: 'edit' }]);
    });

    it('is not written for a rename, a refused save or a request that failed', async () => {
      const id = (await create()).body.conversion.id as string;
      await appDb.events.deleteMany({});
      // a rename of the source only: not a save of rules
      expect((await call('PATCH', `/api/conversions/${id}`, { sourceName: 'Renamed input' })).status).toBe(200);
      // rules that fail the checks
      expect((await call('PATCH', `/api/conversions/${id}`, { rules: { nonsense: true }, status: 'verified' })).status).toBe(422);
      // a body that is no save at all
      expect((await call('POST', '/api/formats', { name: 'x' })).status).toBe(400);
      // someone else's conversion, and a visitor
      expect((await call('PATCH', `/api/conversions/${id}`, { rules: sourceOne(), status: 'verified' }, { user: OTHER_USER })).status).toBe(404);
      expect((await call('POST', '/api/formats', { name: 'x', ...saveBody(sourceOne()) }, { user: null })).status).toBe(401);
      expect(await events()).toEqual([]);
    });

    it('carries no name: not the format\'s, the input\'s or a file\'s', async () => {
      await create({ name: 'Secret Supplier Prices', suggestedSourceName: 'secret-supplier-file', inputHeaders: ['Secret Header'] });
      expect(JSON.stringify(await events())).not.toMatch(/Secret|supplier/i);
    });
  });

  describe('format_run', () => {
    async function run(id: string, counts: Record<string, unknown>, user = TEST_USER) {
      return call('POST', `/api/conversions/${id}/runs`, counts, { user });
    }

    it('says how many days old the FORMAT is when it is run: 0 the same day, 9 after nine and a half days', async () => {
      const id = (await create()).body.conversion.id as string;
      expect((await run(id, { rows: 40, flagged: 2 })).status).toBe(200);
      clock.current = new Date(START.getTime() + 9.5 * DAY);
      expect((await run(id, { rows: 41, flagged: 0 })).status).toBe(200);
      clock.current = new Date(START.getTime() + 400 * DAY);
      expect((await run(id, { rows: 5, flagged: 5 })).status).toBe(200);
      const runs = await events('format_run');
      expect(runs.map((e) => e.props)).toEqual([
        { daysSinceCreated: 0, rows: 40, flagged: 2 },
        { daysSinceCreated: 9, rows: 41, flagged: 0 },
        { daysSinceCreated: 400, rows: 5, flagged: 5 },
      ]);
      expect(runs.every((e) => e.userId?.toHexString() === TEST_USER)).toBe(true);
    });

    it('counts from the format\'s creation, not the conversion\'s: a format\'s later input has the format\'s age', async () => {
      const formatId = (await create()).body.format.id as string;
      clock.current = new Date(START.getTime() + 10 * DAY);
      const second = (await call('POST', `/api/formats/${formatId}/conversions`, { sourceName: 'Input 2', ...saveBody(sourceTwo()) })).body.conversion.id as string;
      clock.current = new Date(START.getTime() + 11 * DAY);
      await run(second, { rows: 3, flagged: 0 });
      expect((await events('format_run'))[0]!.props).toEqual({ daysSinceCreated: 11, rows: 3, flagged: 0 });
    });

    it('never goes below 0 (a clock that disagrees with the one that made the format)', async () => {
      const id = (await create()).body.conversion.id as string;
      clock.current = new Date(START.getTime() - 3 * DAY);
      await run(id, { rows: 1, flagged: 0 });
      expect((await events('format_run'))[0]!.props).toMatchObject({ daysSinceCreated: 0 });
    });

    it('keeps only the counts: a file name or a row in the request never reaches the event', async () => {
      const id = (await create()).body.conversion.id as string;
      await run(id, { rows: 120, flagged: 3, fileName: 'secret.xlsx', firstRow: ['x'] });
      const [event] = await events('format_run');
      expect(Object.keys(event!.props).sort()).toEqual(['daysSinceCreated', 'flagged', 'rows']);
      expect(JSON.stringify(event)).not.toMatch(/secret|firstRow/);
    });

    it('is not written for a run that was refused: bad counts, someone else\'s conversion, a visitor', async () => {
      const id = (await create()).body.conversion.id as string;
      expect((await run(id, { rows: -1, flagged: 0 })).status).toBe(400);
      expect((await run(id, { rows: 'many', flagged: 0 })).status).toBe(400);
      expect((await run(id, { rows: 1, flagged: 0 }, OTHER_USER)).status).toBe(404);
      expect((await call('POST', `/api/conversions/${id}/runs`, { rows: 1, flagged: 0 }, { user: null })).status).toBe(401);
      expect(await events('format_run')).toEqual([]);
    });
  });

  describe('limit_hit', () => {
    it('is written by the one hook for the refusal a route sends, with the limit and the user\'s id', async () => {
      (tiers.registered as { savedFormats: number | 'unlimited' }).savedFormats = 1;
      expect((await create({ name: 'First' })).status).toBe(201);
      const second = await create({ name: 'Second', newSource: { name: 'Other input' } });
      expect(second.status).toBe(403);
      expect(second.body).toEqual({ error: 'limitHit', limit: 'savedFormats' });
      const hits = await events('limit_hit');
      expect(hits).toHaveLength(1);
      expect(hits[0]).toMatchObject({ props: { limit: 'savedFormats' }, userId: new ObjectId(TEST_USER) });
    });

    it('is also written for the other limits the routes refuse with (sources per format)', async () => {
      const formatId = (await create()).body.format.id as string;
      for (let i = 0; i < 2; i++) await call('POST', `/api/formats/${formatId}/conversions`, saveBody(sourceTwo()));
      expect((await call('POST', `/api/formats/${formatId}/conversions`, saveBody(sourceTwo()))).status).toBe(403);
      expect((await events('limit_hit')).map((e) => e.props)).toEqual([{ limit: 'sourcesPerFormat' }]);
    });

    it('is not written for a refusal that is not a limit', async () => {
      await create();
      expect((await call('GET', '/api/formats/000000000000000000000000')).status).toBe(404);
      expect((await call('GET', '/api/formats', undefined, { user: null })).status).toBe(401);
      expect(await events('limit_hit')).toEqual([]);
    });
  });

  describe('a store that cannot write', () => {
    it('costs the user nothing: the save, the run and the refusal go through', async () => {
      const broken: EventStore = {
        async insertMany() {
          throw new Error('disk full');
        },
      };
      await start(broken);
      const made = await create();
      expect(made.status).toBe(201);
      expect((await call('POST', `/api/conversions/${made.body.conversion.id}/runs`, { rows: 1, flagged: 0 })).status).toBe(200);
      (tiers.registered as { savedFormats: number | 'unlimited' }).savedFormats = 1;
      expect((await create({ name: 'Second' })).status).toBe(403);
    });
  });
});
