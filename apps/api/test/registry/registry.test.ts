// The registry API end to end (fastify inject + a real MongoDB; skipped without MONGODB_URI): formats and
// conversions, tier limits, ownership, attaching sources under the format lock, editing a format (which
// propagates to every source), versions and restore, signatures, runs and aliases. The identity is stubbed.
import { randomUUID } from 'node:crypto';
import { checkFormatLock, formatOf } from '@formatai/engine';
import { limits, tiers, type LearnResult, type Rules } from '@formatai/shared';
import type { FastifyInstance } from 'fastify';
import { ObjectId } from 'mongodb';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { connectDb, ensureIndexes, type AppDb } from '../../src/db.js';
import { loadEnv } from '../../src/env.js';
import { newFormatsKey } from '../../src/protection/keys.js';
import { createMemoryStore, type MemoryStore } from '../../src/protection/store.js';
import { buildServer } from '../../src/server.js';
import { makeEnv, mongoUri, stubIdentify, testUserId } from '../protection/harness.js';
import { edited, makeCaller, saveBody, sourceOne, sourceTwo, TEST_USER } from './helpers.js';
import { dropTestDb } from '../setup/testDbs.js';

const OTHER_USER = testUserId(2);

describe.skipIf(!mongoUri)('registry API (MongoDB)', () => {
  let appDb: AppDb;
  let app: FastifyInstance;
  let store: MemoryStore;
  const clock = { current: new Date('2026-09-30T12:00:00.000Z') };
  const now = (): Date => new Date(clock.current);
  let call: ReturnType<typeof makeCaller>;

  const originalTiers = structuredClone({ registered: tiers.registered, paid: tiers.paid });
  const originalMaxVersions = limits.registry.maxVersions;

  async function start(): Promise<void> {
    await app?.close();
    store = createMemoryStore(now);
    app = await buildServer({ env: makeEnv(), db: appDb, logger: false, store, now, identify: stubIdentify });
    call = makeCaller(app);
  }

  beforeAll(async () => {
    const env = loadEnv({ ...process.env, MONGODB_URI: mongoUri, MONGODB_DB: `formatai_test_reg_${randomUUID().slice(0, 8)}` });
    const db = await connectDb(env);
    if (!db) throw new Error('MongoDB not configured');
    appDb = db;
    await ensureIndexes(appDb);
  });

  afterAll(async () => {
    await dropTestDb(appDb, app);
  });

  beforeEach(async () => {
    clock.current = new Date('2026-09-30T12:00:00.000Z');
    await Promise.all([appDb.formats.deleteMany({}), appDb.conversions.deleteMany({}), appDb.sources.deleteMany({})]);
    await start();
  });

  afterEach(() => {
    Object.assign(tiers.registered, structuredClone(originalTiers.registered));
    Object.assign(tiers.paid, structuredClone(originalTiers.paid));
    (limits.registry as { maxVersions: number }).maxVersions = originalMaxVersions;
  });

  // ---------------------------------------------------------------- helpers

  const create = (rules: LearnResult | Rules = sourceOne(), over: Record<string, unknown> = {}, user: string | null = TEST_USER) =>
    call('POST', '/api/formats', { name: 'Catalog load', ...saveBody(rules, over) }, { user });

  /** Creates a format with source 1, and attaches source 2 to it; returns the ids. */
  async function twoSources(): Promise<{ formatId: string; s1: string; s2: string }> {
    const first = await create();
    expect(first.status).toBe(201);
    const formatId = first.body.format.id as string;
    const second = await call('POST', `/api/formats/${formatId}/conversions`, {
      sourceName: 'Source 2',
      ...saveBody(sourceTwo()),
    });
    expect(second.status).toBe(201);
    return { formatId, s1: first.body.conversion.id, s2: second.body.conversion.id };
  }

  const detail = async (id: string, user: string = TEST_USER): Promise<any> =>
    (await call('GET', `/api/conversions/${id}`, undefined, { user })).body.conversion;
  const rulesOf = async (id: string): Promise<Rules> => (await detail(id)).rules as Rules;
  const save = (id: string, rules: unknown, over: Record<string, unknown> = {}, user: string = TEST_USER) =>
    call('PATCH', `/api/conversions/${id}`, { rules, status: 'verified', acceptedDifferences: 0, ...over }, { user });
  const mul = (col: string, by: number) => ({ op: 'mul', args: [{ col }, { const: by }] }) as never;

  // ---------------------------------------------------------------- access

  describe('access', () => {
    it('needs a sign-in on every route (401 signInRequired), and answers nothing about ids', async () => {
      const id = new ObjectId().toHexString();
      const routes: [Parameters<typeof call>[0], string, unknown?][] = [
        ['POST', '/api/formats', saveBody(sourceOne())],
        ['GET', '/api/formats'],
        ['GET', `/api/formats/${id}`],
        ['PATCH', `/api/formats/${id}`, { name: 'x' }],
        ['DELETE', `/api/formats/${id}`],
        ['POST', `/api/formats/${id}/conversions`, saveBody(sourceOne())],
        ['GET', `/api/conversions/${id}`],
        ['PATCH', `/api/conversions/${id}`, { sourceName: 'x' }],
        ['DELETE', `/api/conversions/${id}`],
        ['GET', `/api/conversions/${id}/versions`],
        ['POST', `/api/conversions/${id}/restore/1`, {}],
        ['POST', `/api/conversions/${id}/runs`, { rows: 1, flagged: 0 }],
        ['POST', `/api/conversions/${id}/aliases`, { header: 'ID', alias: 'x' }],
        ['GET', '/api/signatures'],
      ];
      for (const [method, url, body] of routes) {
        const res = await call(method, url, body, { user: null });
        expect(res.status, `${method} ${url}`).toBe(401);
        expect(res.body).toEqual({ error: 'signInRequired' });
      }
    });

    it('answers 503 unavailable when no database is configured', async () => {
      const bare = await buildServer({ env: makeEnv(), db: null, logger: false, store: createMemoryStore(now), identify: stubIdentify });
      try {
        const res = await makeCaller(bare)('GET', '/api/formats');
        expect(res.status).toBe(503);
        expect(res.body).toEqual({ error: 'unavailable' });
      } finally {
        await bare.close();
      }
    });

    it("never shows or changes another user's formats and conversions (404 on every route)", async () => {
      const { formatId, s1 } = await twoSources();
      const before = await appDb.conversions.countDocuments();

      const routes: [Parameters<typeof call>[0], string, unknown?][] = [
        ['GET', `/api/formats/${formatId}`],
        ['PATCH', `/api/formats/${formatId}`, { name: 'Mine now' }],
        ['DELETE', `/api/formats/${formatId}`],
        ['POST', `/api/formats/${formatId}/conversions`, saveBody(sourceTwo())],
        ['GET', `/api/conversions/${s1}`],
        ['PATCH', `/api/conversions/${s1}`, { sourceName: 'Mine now' }],
        ['PATCH', `/api/conversions/${s1}`, { rules: sourceOne(), status: 'verified' }],
        ['DELETE', `/api/conversions/${s1}`],
        ['GET', `/api/conversions/${s1}/versions`],
        ['POST', `/api/conversions/${s1}/restore/1`, {}],
        ['POST', `/api/conversions/${s1}/runs`, { rows: 1, flagged: 0 }],
        ['POST', `/api/conversions/${s1}/aliases`, { header: 'ID', alias: 'Code' }],
      ];
      for (const [method, url, body] of routes) {
        const res = await call(method, url, body, { user: OTHER_USER });
        expect(res.status, `${method} ${url}`).toBe(404);
        expect(res.body).toEqual({ error: 'notFound' });
      }
      expect((await call('GET', '/api/formats', undefined, { user: OTHER_USER })).body).toEqual({ formats: [] });
      expect((await call('GET', '/api/signatures', undefined, { user: OTHER_USER })).body).toEqual({ signatures: [] });

      // Nothing of the owner's changed.
      expect(await appDb.conversions.countDocuments()).toBe(before);
      const owner = await call('GET', `/api/formats/${formatId}`);
      expect(owner.body.format.name).toBe('Catalog load');
      expect(owner.body.conversions.map((c: any) => c.sourceName)).toEqual(['Source 1', 'Source 2']);
    });

    it('treats an id that is not a 24-hex ObjectId like a missing one', async () => {
      for (const bad of ['nope', '12', 'zzzzzzzzzzzzzzzzzzzzzzzz', '123456789012']) {
        expect((await call('GET', `/api/formats/${bad}`)).status).toBe(404);
        expect((await call('GET', `/api/conversions/${bad}`)).status).toBe(404);
      }
      expect((await call('GET', `/api/formats/${new ObjectId().toHexString()}`)).status).toBe(404);
    });
  });

  // ---------------------------------------------------------------- create, list, get, rename, delete

  describe('formats', () => {
    it('creates the format and its first conversion from the rules (POST /api/formats)', async () => {
      const res = await create();
      expect(res.status).toBe(201);
      const { format, conversion } = res.body;
      expect(format).toMatchObject({
        name: 'Catalog load',
        origin: 'learned',
        version: 1,
        fileType: 'xlsx',
        outputColumns: 2,
        sources: 1,
        statuses: { verified: 1 },
        runCount: 0,
      });
      expect(conversion).toMatchObject({
        formatId: format.id,
        sourceName: 'Source 1',
        status: 'verified',
        acceptedDifferences: 0,
        learnPath: 'llm',
        version: 1,
        runCount: 0,
      });

      // The format holds the output side only (no `from`), the conversion the full rules with server-set meta.
      const formatDoc = await appDb.formats.findOne({ _id: new ObjectId(format.id) });
      expect(String(formatDoc!.ownerId)).toBe(TEST_USER);
      expect(formatDoc!.output).toMatchObject({ sheetName: 'Out', columns: [{ header: 'ID' }, { header: 'Total' }] });
      expect(JSON.stringify(formatDoc!.output)).not.toContain('"from"');
      expect(formatDoc!.layout).toEqual({ sort: [] });
      expect(formatDoc!.outputValidations).toEqual([]);
      expect(formatDoc!.versions).toEqual([]);

      const doc = await appDb.conversions.findOne({ _id: new ObjectId(conversion.id) });
      expect(doc!.rules).toMatchObject({
        name: 'Catalog load',
        meta: { formatId: format.id, sourceName: 'Source 1', status: 'verified', source: 'examplePair', learnPath: 'llm', masking: false, model: 'fake-model' },
      });
      expect(doc!.inputSignature).toEqual({
        columns: [
          { header: 'ID', aliases: [], type: 'idLike', required: false },
          { header: 'Amount', aliases: [], type: 'decimal', required: false },
        ],
      });
      expect(doc).toMatchObject({ model: 'fake-model', promptVersion: 'learn-v7', masking: false, exampleExceptions: [] });
    });

    it('never stores the AI explanation or function request, even when the browser sends them (SPEC 15, learn-v7)', async () => {
      const rules = {
        ...sourceOne(),
        output: { ...sourceOne().output, columns: [...sourceOne().output.columns, { header: 'Site', from: null }] },
        unsupported: [
          {
            outputColumn: 'Site',
            reasonCode: 'other' as const,
            explanation: 'a guess that may name Dana',
            functionRequest: { name: 'lookupSite', purpose: 'Finds a site.', args: [{ name: 'x', type: 'text' as const }], returns: 'text' as const },
          },
        ],
      };
      const res = await create(rules);
      expect(res.status).toBe(201);
      const doc = await appDb.conversions.findOne({ _id: new ObjectId(res.body.conversion.id) });
      expect((doc!.rules as Rules).unsupported).toEqual([{ outputColumn: 'Site', reasonCode: 'other' }]);
      expect(JSON.stringify(await appDb.conversions.find({}).toArray())).not.toMatch(/Dana|lookupSite|explanation|functionRequest/);
      // ...nor in the next version an edit writes
      const next = await save(res.body.conversion.id, { ...(doc!.rules as Rules), unsupported: rules.unsupported });
      expect(next.status).toBe(200);
      expect(JSON.stringify(await appDb.conversions.find({}).toArray())).not.toMatch(/Dana|lookupSite|explanation|functionRequest/);
    });

    it('takes a source name, a saved-with-differences status and example exceptions', async () => {
      const res = await create(sourceOne(), {
        sourceName: 'Supplier A',
        status: 'differencesAccepted',
        acceptedDifferences: 3,
        exampleExceptions: [9, 2, 2, 5],
        learnPath: 'local',
      });
      expect(res.status).toBe(201);
      expect(res.body.conversion).toMatchObject({ sourceName: 'Supplier A', status: 'differencesAccepted', acceptedDifferences: 3, learnPath: 'local' });
      const stored = await detail(res.body.conversion.id);
      expect(stored.exampleExceptions).toEqual([2, 5, 9]);
    });

    it('accepts a full rules file (with name and meta) as the browser holds it, and keeps the server in charge of meta', async () => {
      const first = await create();
      const full = await rulesOf(first.body.conversion.id);
      full.meta.formatId = 'stale-id-from-elsewhere';
      // (the same input as the first source: without an explicit `newSource` the server would reuse that source, SPEC 8.15)
      const again = await create(full, { name: 'Copy', newSource: { name: 'Copy source' } });
      expect(again.status).toBe(201);
      const stored = await rulesOf(again.body.conversion.id);
      expect(stored.meta.formatId).toBe(again.body.format.id);
      expect(stored.meta.sourceName).toBe('Copy source');
    });

    it('rejects malformed bodies with 400 invalidRequest (and needsReview can only be set by the server)', async () => {
      const bad: Record<string, unknown>[] = [
        { name: '' },
        { name: 'x'.repeat(limits.registry.maxNameChars + 1) },
        { name: 5 },
        { status: 'needsReview' },
        { status: 'great' },
        { learnPath: 'somewhere' },
        { learnPath: undefined },
        { masking: 'yes' },
        { acceptedDifferences: -1 },
        { exampleExceptions: 'all' },
        { exampleExceptions: [1.5] },
        { sourceName: '   ' },
        { rules: 'not an object' },
        { rules: undefined },
      ];
      for (const over of bad) {
        const res = await create(sourceOne(), over);
        expect(res.status, JSON.stringify(over)).toBe(400);
        expect(res.body).toEqual({ error: 'invalidRequest' });
      }
      expect((await call('POST', '/api/formats', 'text')).status).toBe(400);
      expect(await appDb.formats.countDocuments()).toBe(0);
    });

    it('rejects rules that fail the checks with 422 invalidRules and the problems, and saves nothing', async () => {
      const dangling = edited(sourceOne(), (r) => {
        r.output.columns[1]!.from = 'no_such_column';
      });
      const res = await create(dangling);
      expect(res.status).toBe(422);
      expect(res.body.error).toBe('invalidRules');
      expect(res.body.problems).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'reference' })]));

      const notRules = await create({ schemaVersion: 1, nonsense: true } as never);
      expect(notRules.status).toBe(422);
      expect(notRules.body.problems.every((p: any) => p.kind === 'schema')).toBe(true);

      expect(await appDb.formats.countDocuments()).toBe(0);
      expect(await appDb.conversions.countDocuments()).toBe(0);
    });

    it('lists formats newest first with their sources, statuses and runs', async () => {
      const a = await create(sourceOne(), { name: 'First' });
      clock.current = new Date(clock.current.getTime() + 60_000);
      const b = await create(sourceOne(), { name: 'Second', status: 'differencesAccepted', acceptedDifferences: 1 });
      await call('POST', `/api/formats/${a.body.format.id}/conversions`, saveBody(sourceTwo(), { status: 'userConfirmed' }));
      await call('POST', `/api/conversions/${a.body.conversion.id}/runs`, { rows: 10, flagged: 1 });
      await call('POST', `/api/conversions/${a.body.conversion.id}/runs`, { rows: 12, flagged: 0 });

      const list = await call('GET', '/api/formats');
      expect(list.status).toBe(200);
      const formats = list.body.formats;
      expect(formats.map((f: any) => f.name)).toEqual(['Second', 'First']);
      expect(formats[0]).toMatchObject({ id: b.body.format.id, sources: 1, statuses: { differencesAccepted: 1 }, runCount: 0 });
      expect(formats[0].lastRunAt).toBeUndefined();
      expect(formats[1]).toMatchObject({ sources: 2, statuses: { verified: 1, userConfirmed: 1 }, runCount: 2 });
      expect(formats[1].lastRunAt).toBe(clock.current.toISOString());
      // A list never carries rules or history.
      expect(JSON.stringify(list.body)).not.toContain('"rules"');
      expect(JSON.stringify(list.body)).not.toContain('"versions"');
    });

    it('returns a format with its output side and its conversions (no rules) - GET /api/formats/:id', async () => {
      const { formatId } = await twoSources();
      const res = await call('GET', `/api/formats/${formatId}`);
      expect(res.status).toBe(200);
      expect(res.body.format).toMatchObject({ id: formatId, name: 'Catalog load', sources: 2 });
      expect(res.body.format.output.columns).toEqual([{ header: 'ID' }, { header: 'Total' }]);
      expect(res.body.format.layout).toEqual({ sort: [] });
      expect(res.body.conversions.map((c: any) => c.sourceName)).toEqual(['Source 1', 'Source 2']);
      expect(JSON.stringify(res.body.conversions)).not.toContain('"rules"');
    });

    it('renames a format (PATCH), and rejects an empty name', async () => {
      const { body } = await create();
      const res = await call('PATCH', `/api/formats/${body.format.id}`, { name: '  Monthly control  ' });
      expect(res.status).toBe(200);
      expect(res.body.format).toMatchObject({ name: 'Monthly control', sources: 1 });
      expect((await call('PATCH', `/api/formats/${body.format.id}`, { name: '' })).status).toBe(400);
      expect((await call('GET', `/api/formats/${body.format.id}`)).body.format.name).toBe('Monthly control');
    });

    it('deletes a format with all its conversions - DELETE /api/formats/:id', async () => {
      const { formatId, s1 } = await twoSources();
      const other = await create(sourceOne(), { name: 'Keep me' });
      const res = await call('DELETE', `/api/formats/${formatId}`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ deleted: true, conversions: 2 });
      expect((await call('GET', `/api/formats/${formatId}`)).status).toBe(404);
      expect((await call('GET', `/api/conversions/${s1}`)).status).toBe(404);
      expect(await appDb.conversions.countDocuments({ formatId: new ObjectId(formatId) })).toBe(0);
      expect((await call('GET', `/api/formats/${other.body.format.id}`)).status).toBe(200);
    });
  });

  // ---------------------------------------------------------------- tier limits

  describe('tier limits (SPEC 11)', () => {
    it('lets a registered user save 3 formats, then 403 limitHit savedFormats - and a delete frees a slot', async () => {
      expect(tiers.registered.savedFormats).toBe(3);
      const made: string[] = [];
      for (let i = 0; i < 3; i++) made.push((await create(sourceOne(), { name: `F${i}` })).body.format.id);
      const fourth = await create(sourceOne(), { name: 'F4' });
      expect(fourth.status).toBe(403);
      expect(fourth.body).toEqual({ error: 'limitHit', limit: 'savedFormats' });
      expect(await appDb.formats.countDocuments()).toBe(3);

      await call('DELETE', `/api/formats/${made[0]}`);
      expect((await create(sourceOne(), { name: 'F4' })).status).toBe(201);
      // Another user's formats do not count against this user.
      expect((await create(sourceOne(), {}, OTHER_USER)).status).toBe(201);
    });

    it('API audit: saves at once never get past the saved-formats limit (the count is taken again with the format in)', async () => {
      // (each with a source of its own name: the saves race for the format slots, not for a source's name)
      const results = await Promise.all(Array.from({ length: 6 }, (_, i) => create(sourceOne(), { name: `R${i}`, newSource: { name: `S${i}` } })));
      const saved = results.filter((r) => r.status === 201).length;
      expect(saved).toBeLessThanOrEqual(tiers.registered.savedFormats as number);
      for (const r of results.filter((x) => x.status !== 201)) expect(r.body).toEqual({ error: 'limitHit', limit: 'savedFormats' });
      expect(await appDb.formats.countDocuments()).toBe(saved);
      expect(await appDb.conversions.countDocuments()).toBe(saved); // nothing half-saved
      expect(await appDb.sources.countDocuments()).toBe(saved); // a source made for a save taken back goes with it
      // (Saves that raced for the last slots may all be taken back - DECISION in the route.) One after another, every free slot is used.
      for (let i = saved; i < (tiers.registered.savedFormats as number); i++) expect((await create(sourceOne(), { name: `T${i}`, newSource: { name: `U${i}` } })).status).toBe(201);
      expect((await create(sourceOne(), { name: 'Over', newSource: { name: 'Over' } })).status).toBe(403);
    });

    it('limits sources per format (registered: 3), and answers 403 limitHit sourcesPerFormat on the next one', async () => {
      const { formatId } = await twoSources();
      const third = await call('POST', `/api/formats/${formatId}/conversions`, saveBody(sourceTwo()));
      expect(third.status).toBe(201);
      expect(third.body.conversion.sourceName).toBe('Source 3');
      const fourth = await call('POST', `/api/formats/${formatId}/conversions`, saveBody(sourceTwo()));
      expect(fourth.status).toBe(403);
      expect(fourth.body).toEqual({ error: 'limitHit', limit: 'sourcesPerFormat' });
      expect(await appDb.conversions.countDocuments({ formatId: new ObjectId(formatId) })).toBe(3);

      // Paid: unlimited sources.
      const paid = await create(sourceOne(), {}, OTHER_USER);
      const paidFormat = paid.body.format.id as string;
      for (let i = 0; i < 4; i++) {
        const res = await call('POST', `/api/formats/${paidFormat}/conversions`, saveBody(sourceTwo()), { user: OTHER_USER, tier: 'paid' });
        expect(res.status).toBe(201);
      }
    });

    it('limits rules per format by tier: 403 limitHit rulesPerFormat (registered 30, paid 300)', async () => {
      const many = edited(sourceOne(), (r) => {
        r.output.columns = Array.from({ length: 31 }, (_, i) => ({ header: `Col ${i}`, from: 'id' }));
      });
      const res = await create(many);
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: 'limitHit', limit: 'rulesPerFormat' });
      expect(await appDb.formats.countDocuments()).toBe(0);
      expect((await create(many, {}, OTHER_USER)).status).toBe(403);

      const paid = await call('POST', '/api/formats', { name: 'Wide', ...saveBody(many) }, { user: OTHER_USER, tier: 'paid' });
      expect(paid.status).toBe(201);
    });

    it('also holds the rules per format on attach and on edit', async () => {
      const { formatId, s1 } = await twoSources();
      const many = edited(sourceOne(), (r) => {
        r.output.columns = Array.from({ length: 31 }, (_, i) => ({ header: `Col ${i}`, from: 'id' }));
      });
      const attach = await call('POST', `/api/formats/${formatId}/conversions`, saveBody(many));
      expect(attach.status).toBe(403);
      expect(attach.body).toEqual({ error: 'limitHit', limit: 'rulesPerFormat' });
      const edit = await save(s1, many);
      expect(edit.status).toBe(403);
      expect(edit.body).toEqual({ error: 'limitHit', limit: 'rulesPerFormat' });
    });

    it('paid: N NEW formats a calendar month (DECISION 9) - deleting never gives one back, a new month resets', async () => {
      tiers.paid.newSavedFormatsPerMonth = 2;
      const asPaid = (over: Record<string, unknown> = {}) =>
        call('POST', '/api/formats', { name: 'P', ...saveBody(sourceOne(), over) }, { tier: 'paid' });
      expect(tiers.paid.savedFormats).toBe('unlimited');

      const one = await asPaid();
      expect((await asPaid()).status).toBe(201);
      const third = await asPaid();
      expect(third.status).toBe(429);
      expect(third.body).toEqual({ error: 'limitHit', limit: 'newFormatsPerMonth' });
      expect(await store.getCounter(newFormatsKey(TEST_USER, clock.current))).toBe(2);

      await call('DELETE', `/api/formats/${one.body.format.id}`, undefined, { tier: 'paid' });
      expect((await asPaid()).status).toBe(429); // a delete does not refund the month

      clock.current = new Date('2026-10-01T00:00:01.000Z');
      expect((await asPaid()).status).toBe(201);
    });

    it('does not use up a paid user\'s monthly count for a request that creates nothing', async () => {
      tiers.paid.newSavedFormatsPerMonth = 1;
      const bad = await call('POST', '/api/formats', { name: 'P', ...saveBody({ schemaVersion: 1 }) }, { tier: 'paid' });
      expect(bad.status).toBe(422);
      expect(await store.getCounter(newFormatsKey(TEST_USER, clock.current))).toBe(0);
      expect((await call('POST', '/api/formats', { name: 'P', ...saveBody(sourceOne()) }, { tier: 'paid' })).status).toBe(201);
    });
  });

  // ---------------------------------------------------------------- attach a source (A2)

  describe('attaching a source (POST /api/formats/:id/conversions)', () => {
    it('attaches a source whose output matches the format, named by default "Source N"', async () => {
      const { body } = await create();
      const res = await call('POST', `/api/formats/${body.format.id}/conversions`, saveBody(sourceTwo()));
      expect(res.status).toBe(201);
      expect(res.body.conversion).toMatchObject({ formatId: body.format.id, sourceName: 'Source 2', status: 'verified', version: 1 });
      const stored = await rulesOf(res.body.conversion.id);
      expect(stored.meta).toMatchObject({ formatId: body.format.id, sourceName: 'Source 2' });
      // The format did not change: attaching never edits the format.
      const format = await call('GET', `/api/formats/${body.format.id}`);
      expect(format.body.format).toMatchObject({ version: 1, sources: 2 });
    });

    it('answers 422 formatMismatch with the columns that differ when the output does not match', async () => {
      const { body } = await create();
      const renamed = edited(sourceTwo(), (r) => {
        r.output.columns[1]!.header = 'Grand total';
      });
      const res = await call('POST', `/api/formats/${body.format.id}/conversions`, saveBody(renamed));
      expect(res.status).toBe(422);
      expect(res.body.error).toBe('formatMismatch');
      expect(res.body.problems).toEqual([
        expect.objectContaining({ kind: 'formatMismatch', path: 'output.columns[1].header' }),
      ]);

      const extra = edited(sourceTwo(), (r) => {
        r.output.columns.push({ header: 'Extra', from: 'code' });
      });
      const other = await call('POST', `/api/formats/${body.format.id}/conversions`, saveBody(extra));
      expect(other.status).toBe(422);
      expect(other.body.problems[0]).toMatchObject({ kind: 'formatMismatch', path: 'output.columns[2]' });

      const csv = edited(sourceTwo(), (r) => {
        r.output.file = { type: 'csv', delimiter: ',', header: true };
      });
      const file = await call('POST', `/api/formats/${body.format.id}/conversions`, saveBody(csv));
      expect(file.status).toBe(422);
      expect(file.body.problems).toEqual([expect.objectContaining({ path: 'output.file' })]);
      expect(await appDb.conversions.countDocuments()).toBe(1);
    });

    it('holds a format written before v4 (grandTotal) to the same lock: header-keyed summary rows compare equal', async () => {
      const withTotal = edited(sourceOne(), (r) => {
        (r.output as { grandTotal?: unknown }).grandTotal = { labelColumn: 'id', label: 'Sum', sum: ['total'] };
      });
      const { body } = await create(withTotal);
      const modern = edited(sourceTwo(), (r) => {
        r.output.summaryRows = [{ label: 'Sum', labelColumn: 'ID', cells: { Total: 'sum' } }];
      });
      const res = await call('POST', `/api/formats/${body.format.id}/conversions`, saveBody(modern));
      expect(res.status).toBe(201);
    });

    it('rejects a second source with the same name (409 nameTaken, case-insensitive) and picks the first free default', async () => {
      const { formatId, s2 } = await twoSources();
      const dup = await call('POST', `/api/formats/${formatId}/conversions`, saveBody(sourceTwo(), { sourceName: 'source 2' }));
      expect(dup.status).toBe(409);
      expect(dup.body).toEqual({ error: 'nameTaken' });

      await call('DELETE', `/api/conversions/${s2}`);
      const next = await call('POST', `/api/formats/${formatId}/conversions`, saveBody(sourceTwo()));
      expect(next.body.conversion.sourceName).toBe('Source 2'); // the freed name
    });

    it('rejects invalid rules with 422 invalidRules', async () => {
      const { body } = await create();
      const broken = edited(sourceTwo(), (r) => {
        r.output.columns[0]!.from = 'missing';
      });
      const res = await call('POST', `/api/formats/${body.format.id}/conversions`, saveBody(broken));
      expect(res.status).toBe(422);
      expect(res.body.error).toBe('invalidRules');
    });
  });

  // ---------------------------------------------------------------- conversions: read, edit, delete

  describe('conversions', () => {
    it('returns one conversion with its rules, signature and counts', async () => {
      const { body } = await create(sourceOne(), { exampleExceptions: [3] });
      const res = await call('GET', `/api/conversions/${body.conversion.id}`);
      expect(res.status).toBe(200);
      const c = res.body.conversion;
      expect(c).toMatchObject({ id: body.conversion.id, sourceName: 'Source 1', exampleExceptions: [3], masking: false, model: 'fake-model' });
      expect(c.rules.output.columns).toHaveLength(2);
      expect(c.inputSignature.columns).toHaveLength(2);
      expect(c.versions).toBeUndefined();
    });

    it('renames a source without making a new version, keeping the copy inside the rules in step', async () => {
      const { s1 } = await twoSources();
      const res = await call('PATCH', `/api/conversions/${s1}`, { sourceName: 'Acme price list' });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ formatChanged: false, affectedSources: 0, needsReview: [], conversion: { sourceName: 'Acme price list', version: 1 } });
      expect((await rulesOf(s1)).meta.sourceName).toBe('Acme price list');
      // The same name (any case) is taken by the other source.
      const taken = await call('PATCH', `/api/conversions/${s1}`, { sourceName: 'SOURCE 2' });
      expect(taken.status).toBe(409);
      expect(taken.body).toEqual({ error: 'nameTaken' });
      // Renaming to its own name is fine.
      expect((await call('PATCH', `/api/conversions/${s1}`, { sourceName: 'acme price list' })).status).toBe(200);
    });

    it('saves edited rules as a new version (a source-side edit does not touch the format)', async () => {
      const { formatId, s1, s2 } = await twoSources();
      const rules = await rulesOf(s1);
      const res = await save(
        s1,
        edited(rules, (r) => {
          r.transform.computed[0]!.expr = mul('amount', 3);
        }),
        { status: 'differencesAccepted', acceptedDifferences: 2, exampleExceptions: [4, 1] },
      );
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ formatChanged: false, affectedSources: 0, needsReview: [], conversion: { version: 2, status: 'differencesAccepted', acceptedDifferences: 2 } });

      const stored = await detail(s1);
      expect(stored.rules.transform.computed[0].expr).toEqual(mul('amount', 3));
      expect(stored.rules.meta.status).toBe('differencesAccepted');
      expect(stored.exampleExceptions).toEqual([1, 4]);
      const doc = await appDb.conversions.findOne({ _id: new ObjectId(s1) });
      expect(doc!.versions).toHaveLength(1);
      expect(doc!.versions[0]).toMatchObject({ version: 1, status: 'verified', acceptedDifferences: 0 });
      expect((doc!.versions[0]!.rules as Rules).transform.computed[0]!.expr).toEqual(mul('amount', 2));
      // The format and the other source are as they were.
      expect((await call('GET', `/api/formats/${formatId}`)).body.format.version).toBe(1);
      expect((await detail(s2)).version).toBe(1);
    });

    it('keeps the old exceptions when a save does not send new ones', async () => {
      const { body } = await create(sourceOne(), { exampleExceptions: [7] });
      await save(body.conversion.id, await rulesOf(body.conversion.id));
      expect((await detail(body.conversion.id)).exampleExceptions).toEqual([7]);
    });

    it('answers 409 versionConflict when the conversion moved on since baseVersion', async () => {
      const { body } = await create();
      const id = body.conversion.id as string;
      const rules = await rulesOf(id);
      expect((await save(id, rules, { baseVersion: 1 })).status).toBe(200);
      const stale = await save(id, rules, { baseVersion: 1 });
      expect(stale.status).toBe(409);
      expect(stale.body).toEqual({ error: 'versionConflict' });
      expect((await call('PATCH', `/api/conversions/${id}`, { sourceName: 'x', baseVersion: 1 })).status).toBe(409);
      expect((await detail(id)).version).toBe(2);
    });

    it('rejects a malformed update with 400, and invalid rules with 422', async () => {
      const { body } = await create();
      const id = body.conversion.id as string;
      const rules = await rulesOf(id);
      const bad: Record<string, unknown>[] = [
        {},
        { status: 'verified' }, // a status needs rules
        { acceptedDifferences: 1 },
        { rules, status: 'needsReview' },
        { rules },
        { rules: 'x', status: 'verified' },
        { sourceName: '' },
        { sourceName: 'ok', baseVersion: 0 },
      ];
      for (const b of bad) {
        const res = await call('PATCH', `/api/conversions/${id}`, b);
        expect(res.status, JSON.stringify(Object.keys(b))).toBe(400);
        expect(res.body).toEqual({ error: 'invalidRequest' });
      }
      const broken = edited(rules, (r) => {
        r.output.columns[0]!.from = 'missing';
      });
      const res = await save(id, broken);
      expect(res.status).toBe(422);
      expect(res.body.error).toBe('invalidRules');
      expect((await detail(id)).version).toBe(1);
    });

    it('deletes a conversion, and the format stays even with no source left', async () => {
      const { body } = await create();
      const del = await call('DELETE', `/api/conversions/${body.conversion.id}`);
      expect(del.status).toBe(200);
      expect(del.body).toEqual({ deleted: true });
      expect((await call('GET', `/api/conversions/${body.conversion.id}`)).status).toBe(404);
      const format = await call('GET', `/api/formats/${body.format.id}`);
      expect(format.status).toBe(200);
      expect(format.body).toMatchObject({ format: { sources: 0 }, conversions: [] });
      // A source can be attached to it again (SPEC 8.12: a format need not have been learned).
      const again = await call('POST', `/api/formats/${body.format.id}/conversions`, saveBody(sourceTwo()));
      expect(again.status).toBe(201);
      // The first source stays (SPEC 8.15: it is the company's), so its name is not free.
      expect(again.body.conversion.sourceName).toBe('Source 2');
    });
  });

  // ---------------------------------------------------------------- editing a format

  describe('editing a format from a conversion (SPEC 8.12: written to every source)', () => {
    it('updates the format and every other source; sources that still resolve keep their status', async () => {
      const { formatId, s1, s2 } = await twoSources();
      const s2Before = await detail(s2);
      const res = await save(
        s1,
        edited(await rulesOf(s1), (r) => {
          r.output.columns[1]!.header = 'Grand total'; // a rename...
          r.output.columns[1]!.format = '0.00'; // ...and a number format
        }),
      );
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ formatChanged: true, affectedSources: 1, needsReview: [], conversion: { id: s1, version: 2 } });

      const format = await call('GET', `/api/formats/${formatId}`);
      expect(format.body.format).toMatchObject({ version: 2 });
      expect(format.body.format.output.columns).toEqual([{ header: 'ID' }, { header: 'Grand total', format: '0.00' }]);
      const formatDoc = await appDb.formats.findOne({ _id: new ObjectId(formatId) });
      expect(formatDoc!.versions).toHaveLength(1);
      expect(formatDoc!.versions[0]).toMatchObject({ version: 1 });
      expect((formatDoc!.versions[0]!.format as any).output.columns[1]).toEqual({ header: 'Total' });

      // The other source took the new output side and kept its own mapping (found through the rename).
      const s2After = await detail(s2);
      expect(s2After).toMatchObject({ status: 'verified', version: 2 });
      expect(s2After.rules.output.columns).toEqual([
        { header: 'ID', from: 'code' },
        { header: 'Grand total', from: 'cost', format: '0.00' },
      ]);
      expect(s2After.rules.transform).toEqual(s2Before.rules.transform); // its own logic is untouched
      expect(s2After.rules.input).toEqual(s2Before.rules.input);
      expect(s2After.inputSignature).toEqual(s2Before.inputSignature);
      // Both sources equal the format again under the lock.
      expect(checkFormatLock(s2After.rules, formatOf(await rulesOf(s1)))).toEqual([]);
      // The old rules stay in the history.
      const doc = await appDb.conversions.findOne({ _id: new ObjectId(s2) });
      expect((doc!.versions[0]!.rules as Rules).output.columns[1]!.header).toBe('Total');
    });

    it('marks a source needsReview when the format gained a column it cannot produce', async () => {
      const { s1, s2 } = await twoSources();
      const res = await save(
        s1,
        edited(await rulesOf(s1), (r) => {
          r.output.columns.push({ header: 'Note', from: null });
          r.unsupported.push({ outputColumn: 'Note', reasonCode: 'other' });
        }),
      );
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ formatChanged: true, affectedSources: 1, needsReview: [{ id: s2, sourceName: 'Source 2' }] });

      const s2After = await detail(s2);
      expect(s2After.status).toBe('needsReview');
      expect(s2After.rules.meta.status).toBe('needsReview');
      expect(s2After.rules.output.columns[2]).toEqual({ header: 'Note', from: null });
      expect(s2After.rules.unsupported).toEqual([{ outputColumn: 'Note', reasonCode: 'other' }]);
      // The editing source itself keeps its status.
      expect((await detail(s1)).status).toBe('verified');
    });

    it('marks a source needsReview when a reference in the format does not resolve for it', async () => {
      const { formatId, s1, s2 } = await twoSources();
      const res = await save(
        s1,
        edited(await rulesOf(s1), (r) => {
          // A title row that reads the smallest value of one of Source 1's own input columns.
          r.output.titleRows = [{ parts: [{ text: 'From ' }, { agg: 'min', column: 'amount', format: '0' }] }];
        }),
      );
      expect(res.status).toBe(200);
      expect(res.body.affectedSources).toBe(1);
      expect(res.body.needsReview).toEqual([{ id: s2, sourceName: 'Source 2', formatId, formatName: 'Catalog load' }]);
      expect((await detail(s2)).status).toBe('needsReview');
    });

    it('turns the format\'s sort and group (by output header) back into each source\'s own ids', async () => {
      const { formatId, s1, s2 } = await twoSources();
      const res = await save(
        s1,
        edited(await rulesOf(s1), (r) => {
          r.transform.sort = [{ column: 'total', dir: 'desc' }];
          r.transform.group = { by: 'id', showDetailRows: true, blankRowsAfter: 1, summaryRows: [{ label: 'Sum', labelColumn: 'ID', cells: { Total: 'sum' } }] };
        }),
      );
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ formatChanged: true, affectedSources: 1, needsReview: [] });

      const format = (await call('GET', `/api/formats/${formatId}`)).body.format;
      expect(format.layout.sort).toEqual([{ header: 'Total', dir: 'desc' }]);
      expect(format.layout.group).toMatchObject({ by: 'ID', showDetailRows: true, blankRowsAfter: 1 });

      const s2After = await detail(s2);
      expect(s2After.status).toBe('verified');
      expect(s2After.rules.transform.sort).toEqual([{ column: 'cost', dir: 'desc' }]); // Total <- cost in Source 2
      expect(s2After.rules.transform.group).toMatchObject({ by: 'code', showDetailRows: true, blankRowsAfter: 1 });
      expect(s2After.rules.output.summaryRows).toEqual([]); // the format has none for the whole output
    });

    it('drops the format\'s sort in every source when the edit removes it', async () => {
      const { s1, s2 } = await twoSources();
      await save(s1, edited(await rulesOf(s1), (r) => { r.transform.sort = [{ column: 'total', dir: 'asc' }]; }));
      expect((await detail(s2)).rules.transform.sort).toEqual([{ column: 'cost', dir: 'asc' }]);
      const res = await save(s1, edited(await rulesOf(s1), (r) => { r.transform.sort = []; }));
      expect(res.body.formatChanged).toBe(true);
      expect((await detail(s2)).rules.transform.sort).toEqual([]);
    });

    it('carries output validations (they belong to the format) and keeps each source\'s own input validations', async () => {
      const { s1, s2 } = await twoSources();
      await save(s2, edited(await rulesOf(s2), (r) => { r.validations = [{ column: 'code', rule: 'required', severity: 'flag' }]; }));
      const res = await save(
        s1,
        edited(await rulesOf(s1), (r) => {
          r.validations = [{ on: 'output', column: 'Total', rule: 'range', min: 0, severity: 'flag' }];
        }),
      );
      expect(res.body).toMatchObject({ formatChanged: true, affectedSources: 1, needsReview: [] });
      const s2After = await detail(s2);
      expect(s2After.rules.validations).toEqual([
        { column: 'code', rule: 'required', severity: 'flag' },
        { on: 'output', column: 'Total', rule: 'range', min: 0, severity: 'flag' },
      ]);
    });

    it('is a format edit with nothing to propagate when the format has one source', async () => {
      const { body } = await create();
      const res = await save(
        body.conversion.id,
        edited(await rulesOf(body.conversion.id), (r) => {
          r.output.columns.reverse();
        }),
      );
      expect(res.body).toMatchObject({ formatChanged: true, affectedSources: 0, needsReview: [] });
      const format = await call('GET', `/api/formats/${body.format.id}`);
      expect(format.body.format).toMatchObject({ version: 2 });
      expect(format.body.format.output.columns).toEqual([{ header: 'Total' }, { header: 'ID' }]);
    });

    it('keeps a source that was already marked needsReview marked, and reports it', async () => {
      const { formatId, s1, s2 } = await twoSources();
      await save(s1, edited(await rulesOf(s1), (r) => { r.output.columns.push({ header: 'Note', from: null }); r.unsupported.push({ outputColumn: 'Note', reasonCode: 'other' }); }));
      expect((await detail(s2)).status).toBe('needsReview');
      const res = await save(s1, edited(await rulesOf(s1), (r) => { r.output.sheetName = 'Renamed sheet'; }));
      expect(res.body.affectedSources).toBe(1);
      expect(res.body.needsReview).toEqual([{ id: s2, sourceName: 'Source 2', formatId, formatName: 'Catalog load' }]);
      expect((await detail(s2)).status).toBe('needsReview');
    });

    it('lets the user review a needsReview source: saving its rules makes it verified again', async () => {
      const { s1, s2 } = await twoSources();
      await save(s1, edited(await rulesOf(s1), (r) => { r.output.columns.push({ header: 'Note', from: null }); r.unsupported.push({ outputColumn: 'Note', reasonCode: 'other' }); }));
      const review = await save(s2, await rulesOf(s2), { status: 'userConfirmed' });
      expect(review.status).toBe(200);
      expect(review.body).toMatchObject({ formatChanged: false, conversion: { status: 'userConfirmed' } });
    });
  });

  // ---------------------------------------------------------------- versions and restore

  describe('versions and restore (SPEC 8.11 "Saving")', () => {
    async function threeVersions(): Promise<{ id: string; original: Rules }> {
      const { body } = await create();
      const id = body.conversion.id as string;
      const original = await rulesOf(id);
      await save(id, edited(original, (r) => { r.transform.computed[0]!.expr = mul('amount', 3); }), { status: 'differencesAccepted', acceptedDifferences: 1 });
      await save(id, edited(original, (r) => { r.transform.computed[0]!.expr = mul('amount', 4); }));
      return { id, original };
    }

    it('lists the versions newest first, the current one included', async () => {
      const { id } = await threeVersions();
      const res = await call('GET', `/api/conversions/${id}/versions`);
      expect(res.status).toBe(200);
      expect(res.body.versions.map((v: any) => [v.version, v.current, v.status, v.acceptedDifferences])).toEqual([
        [3, true, 'verified', 0],
        [2, false, 'differencesAccepted', 1],
        [1, false, 'verified', 0],
      ]);
      expect(JSON.stringify(res.body)).not.toContain('"rules"');
      expect(res.body.versions.every((v: any) => typeof v.at === 'string')).toBe(true);
    });

    it('restores an earlier version as a NEW version, keeping the history', async () => {
      const { id, original } = await threeVersions();
      const res = await call('POST', `/api/conversions/${id}/restore/1`, {});
      expect(res.status).toBe(200);
      expect(res.body.conversion).toMatchObject({ version: 4, status: 'verified' });
      const now = await detail(id);
      expect(now.rules.transform).toEqual(original.transform);
      expect(now.rules.meta.sourceName).toBe('Source 1');
      const versions = (await call('GET', `/api/conversions/${id}/versions`)).body.versions;
      expect(versions.map((v: any) => v.version)).toEqual([4, 3, 2, 1]);

      // Restoring a version that was saved with differences brings its status and count back.
      const back = await call('POST', `/api/conversions/${id}/restore/2`, {});
      expect(back.body.conversion).toMatchObject({ version: 5, status: 'differencesAccepted', acceptedDifferences: 1 });
    });

    it('answers 404 for a version that does not exist (or the current one, which needs no restore)', async () => {
      const { id } = await threeVersions();
      for (const v of ['9', '0', 'abc', '3']) {
        const res = await call('POST', `/api/conversions/${id}/restore/${v}`, {});
        expect(res.status, v).toBe(404);
        expect(res.body).toEqual({ error: 'notFound' });
      }
    });

    it('refuses to restore a version from before a change to the format (422 formatMismatch)', async () => {
      const { s1, s2 } = await twoSources();
      await save(s1, edited(await rulesOf(s1), (r) => { r.output.columns[1]!.header = 'Grand total'; })); // a format edit
      // Source 2's version 1 still has the old header.
      const res = await call('POST', `/api/conversions/${s2}/restore/1`, {});
      expect(res.status).toBe(422);
      expect(res.body.error).toBe('formatMismatch');
      expect(res.body.problems[0]).toMatchObject({ kind: 'formatMismatch', path: 'output.columns[1].header' });
      expect((await detail(s2)).version).toBe(2);
      // Its own version 2 (written by the format edit) is current; source 1's version 1 also predates the edit.
      expect((await call('POST', `/api/conversions/${s1}/restore/1`, {})).status).toBe(422);
    });

    it('keeps at most limits.registry.maxVersions older versions, dropping the oldest', async () => {
      (limits.registry as { maxVersions: number }).maxVersions = 3;
      await start();
      const { body } = await create();
      const id = body.conversion.id as string;
      const rules = await rulesOf(id);
      for (let i = 0; i < 6; i++) {
        expect((await save(id, edited(rules, (r) => { r.transform.computed[0]!.expr = mul('amount', 10 + i); }))).status).toBe(200);
      }
      const doc = await appDb.conversions.findOne({ _id: new ObjectId(id) });
      expect(doc!.version).toBe(7);
      expect(doc!.versions.map((v) => v.version)).toEqual([4, 5, 6]);
      const listed = (await call('GET', `/api/conversions/${id}/versions`)).body.versions;
      expect(listed.map((v: any) => v.version)).toEqual([7, 6, 5, 4]);
    });
  });

  // ---------------------------------------------------------------- signatures, runs, aliases

  describe('signatures, runs and aliases', () => {
    it('returns one signature per SOURCE (SPEC 8.15), with the formats it feeds, for matching in the browser', async () => {
      const { formatId, s1, s2 } = await twoSources();
      // Another format fed by the same source as Source 1: one source, two conversions (SPEC 8.15).
      const other = await create(sourceOne(), { name: 'Other format' });
      expect(other.body.sourceReused).toEqual({ id: expect.any(String), name: 'Source 1' });
      await create(sourceOne(), {}, OTHER_USER);
      const res = await call('GET', '/api/signatures');
      expect(res.status).toBe(200);
      // Two sources (Source 1 feeds two formats, Source 2 one); the other user's source is not here.
      expect(res.body.signatures).toHaveLength(2);
      const entry = res.body.signatures.find((s: any) => s.name === 'Source 2');
      expect(entry).toEqual({
        sourceId: expect.any(String),
        name: 'Source 2',
        columns: [
          { header: 'Code', aliases: [], type: 'idLike', required: true },
          { header: 'Price', aliases: [], type: 'decimal', required: true },
        ],
        conversions: [{ conversionId: s2, formatId, formatName: 'Catalog load', status: 'verified' }],
      });
      const one = res.body.signatures.find((s: any) => s.name === 'Source 1');
      expect(one.conversions.map((c: any) => [c.conversionId, c.formatName])).toEqual([
        [s1, 'Catalog load'],
        [other.body.conversion.id, 'Other format'],
      ]);
      // Only signatures: no rules, no example values.
      expect(JSON.stringify(res.body)).not.toContain('"transform"');
    });

    it('keeps the signature and the status current after edits (a needsReview source says so)', async () => {
      const { s1, s2 } = await twoSources();
      await save(s1, edited(await rulesOf(s1), (r) => { r.output.columns.push({ header: 'Note', from: null }); r.unsupported.push({ outputColumn: 'Note', reasonCode: 'other' }); }));
      await save(s1, edited(await rulesOf(s1), (r) => { r.input.columns[0]!.header = 'Item'; }));
      const { signatures } = (await call('GET', '/api/signatures')).body;
      const ofConversion = (id: string) => signatures.find((s: any) => s.conversions.some((c: any) => c.conversionId === id));
      expect(ofConversion(s1).columns[0].header).toBe('Item');
      expect(ofConversion(s2).conversions[0].status).toBe('needsReview');
    });

    it('counts a run: runCount, lastRunAt and the counts of the last run - nothing else is kept', async () => {
      const { body } = await create();
      const id = body.conversion.id as string;
      const first = await call('POST', `/api/conversions/${id}/runs`, { rows: 120, flagged: 3, fileName: 'secret.xlsx', firstRow: ['x'] });
      expect(first.status).toBe(200);
      expect(first.body).toEqual({ runCount: 1, lastRunAt: clock.current.toISOString() });
      clock.current = new Date(clock.current.getTime() + 5000);
      const second = await call('POST', `/api/conversions/${id}/runs`, { rows: 80, flagged: 0 });
      expect(second.body).toEqual({ runCount: 2, lastRunAt: clock.current.toISOString() });

      const c = await detail(id);
      expect(c).toMatchObject({ runCount: 2, lastRunAt: clock.current.toISOString(), lastRun: { rows: 80, flagged: 0 } });
      const doc = await appDb.conversions.findOne({ _id: new ObjectId(id) });
      expect(JSON.stringify(doc)).not.toContain('secret.xlsx');
      expect(doc!.lastRun).toEqual({ rows: 80, flagged: 0 });
    });

    it('rejects a run without counts', async () => {
      const { body } = await create();
      for (const b of [{}, { rows: -1, flagged: 0 }, { rows: 1.5, flagged: 0 }, { rows: '3', flagged: 0 }, { rows: 1 }]) {
        const res = await call('POST', `/api/conversions/${body.conversion.id}/runs`, b);
        expect(res.status, JSON.stringify(b)).toBe(400);
        expect(res.body).toEqual({ error: 'invalidRequest' });
      }
      expect((await detail(body.conversion.id)).runCount).toBe(0);
    });

    it('saves a confirmed mapping as a new alias of the input column, visible in the signature (no new version)', async () => {
      const { body } = await create();
      const id = body.conversion.id as string;
      const res = await call('POST', `/api/conversions/${id}/aliases`, { header: 'Amount', alias: ' Sum insured ' });
      expect(res.status).toBe(200);
      expect(res.body.inputSignature.columns[1]).toEqual({ header: 'Amount', aliases: ['Sum insured'], type: 'decimal', required: false });

      const c = await detail(id);
      expect(c.version).toBe(1);
      expect(c.rules.input.columns[1].aliases).toEqual(['Sum insured']);
      const sig = (await call('GET', '/api/signatures')).body.signatures[0];
      expect(sig.columns[1].aliases).toEqual(['Sum insured']);

      // Idempotent - also for the same alias in another case, or the column's own header.
      await call('POST', `/api/conversions/${id}/aliases`, { header: 'Amount', alias: 'sum insured' });
      await call('POST', `/api/conversions/${id}/aliases`, { header: 'Amount', alias: 'amount' });
      expect((await detail(id)).rules.input.columns[1].aliases).toEqual(['Sum insured']);
    });

    it('refuses an alias that already names another input column, an unknown column, and too many aliases', async () => {
      const { body } = await create();
      const id = body.conversion.id as string;
      const clash = await call('POST', `/api/conversions/${id}/aliases`, { header: 'Amount', alias: 'id' });
      expect(clash.status).toBe(409);
      expect(clash.body).toEqual({ error: 'aliasConflict' });
      const unknown = await call('POST', `/api/conversions/${id}/aliases`, { header: 'Nope', alias: 'x' });
      expect(unknown.status).toBe(400);
      expect(unknown.body).toEqual({ error: 'invalidRequest' });
      expect((await call('POST', `/api/conversions/${id}/aliases`, { header: 'Amount', alias: '  ' })).status).toBe(400);

      for (let i = 0; i < limits.registry.maxAliasesPerColumn; i++) {
        expect((await call('POST', `/api/conversions/${id}/aliases`, { header: 'Amount', alias: `A${i}` })).status).toBe(200);
      }
      expect((await call('POST', `/api/conversions/${id}/aliases`, { header: 'Amount', alias: 'one too many' })).status).toBe(400);
    });

    it('keeps an alias through a later save that starts from the stored rules', async () => {
      const { body } = await create();
      const id = body.conversion.id as string;
      await call('POST', `/api/conversions/${id}/aliases`, { header: 'Amount', alias: 'Value' });
      await save(id, edited(await rulesOf(id), (r) => { r.transform.computed[0]!.expr = mul('amount', 5); }));
      const sig = (await call('GET', '/api/signatures')).body.signatures[0];
      expect(sig.columns[1].aliases).toEqual(['Value']);
    });
  });

  // ---------------------------------------------------------------- storage of user text as keys

  describe('rules whose keys are user text (dots, dollar signs, empty, Hebrew) - value maps, header-keyed summary rows', () => {
    const trickyRules = (): LearnResult =>
      edited(sourceOne(), (r) => {
        r.transform.valueMaps = [{ column: 'id', map: { 'a.b': 'x', $100: 'y', '': 'z', 'שלום': 'w' }, onMissing: 'keep' }];
        r.output.columns[1]!.header = 'Total.$x';
        r.output.summaryRows = [{ label: 'Sum', labelColumn: 'ID', cells: { 'Total.$x': 'sum' } }];
      });

    it('stores, returns, versions and propagates them unchanged', async () => {
      const first = await create(trickyRules());
      expect(first.status).toBe(201);
      const id = first.body.conversion.id as string;
      const stored = await rulesOf(id);
      expect(stored.transform.valueMaps[0]!.map).toEqual({ 'a.b': 'x', $100: 'y', '': 'z', 'שלום': 'w' });
      const formatDoc = await appDb.formats.findOne({ _id: new ObjectId(first.body.format.id) });
      expect((formatDoc!.output as any).summaryRows[0].cells).toEqual({ 'Total.$x': 'sum' });

      // A second source, a save (the old version goes into history through $push) and a format edit.
      const second = await call('POST', `/api/formats/${first.body.format.id}/conversions`, saveBody(edited(sourceTwo(), (r) => {
        r.output.columns[1]!.header = 'Total.$x';
        r.output.summaryRows = [{ label: 'Sum', labelColumn: 'ID', cells: { 'Total.$x': 'sum' } }];
      })));
      expect(second.status).toBe(201);
      const res = await save(id, edited(stored, (r) => { r.output.columns[1]!.header = 'Amount.due'; r.output.summaryRows![0]!.cells = { 'Amount.due': 'sum' }; }));
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ formatChanged: true, affectedSources: 1, needsReview: [] });
      const doc = await appDb.conversions.findOne({ _id: new ObjectId(id) });
      expect((doc!.versions[0]!.rules as Rules).transform.valueMaps[0]!.map).toEqual({ 'a.b': 'x', $100: 'y', '': 'z', 'שלום': 'w' });
      expect((await detail(second.body.conversion.id)).rules.output.summaryRows[0].cells).toEqual({ 'Amount.due': 'sum' });
    });
  });
});
