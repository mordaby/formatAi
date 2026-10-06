// What one saved format may keep (docs/proposals/saved-format-contents.md section 7; owner, 2026-10-06; SPEC 21 v15): the server refuses a
// save over any of the caps - a value map of more than 500 entries, a value longer than 200 characters, one version over 64 KB - with 400
// `rulesTooLarge`, on EVERY route that stores rules: a new format, a source attached, a new version (the editor's save and the Run screen's
// "Do this every time?"), a version restored, a source edited. Nothing is stored. (fastify inject + a real MongoDB; skipped without MONGODB_URI.)
import { randomUUID } from 'node:crypto';
import { apiErrorMessages, limits, type LearnResult, type Rules } from '@formatai/shared';
import type { FastifyInstance } from 'fastify';
import { ObjectId } from 'mongodb';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { connectDb, ensureIndexes, type AppDb } from '../../src/db.js';
import { loadEnv } from '../../src/env.js';
import { checkRulesFile } from '../../src/registry/rules.js';
import { createMemoryStore } from '../../src/protection/store.js';
import { buildServer } from '../../src/server.js';
import { makeEnv, mongoUri, stubIdentify } from '../protection/harness.js';
import { edited, makeCaller, saveBody, sourceOne, sourceTwo } from './helpers.js';

/** Over the value-map cap: 501 entries on the ID column (shown as ID). */
const bigMap = (r: LearnResult | Rules): void => {
  r.transform.valueMaps = [{ column: 'id', map: Object.fromEntries(Array.from({ length: limits.rules.maxValueMapEntries + 1 }, (_, i) => [`k${i}`, `v${i}`])), onMissing: 'keep' }];
};
/** Over the value cap: a title of 201 characters. */
const longTitle = (r: LearnResult | Rules): void => {
  r.output.titleRows = [{ text: 'x'.repeat(limits.rules.maxValueChars + 1) }];
};
/** Over the version cap: a table nobody reads would go, so a value map just within the entry cap, with long keys (about 70 KB). */
const bigRules = (r: LearnResult | Rules): void => {
  r.transform.valueMaps = [{ column: 'id', map: Object.fromEntries(Array.from({ length: 450 }, (_, i) => [`${'k'.repeat(140)}${i}`, `v${i}`])), onMissing: 'keep' }];
};
const OVER: [string, (r: LearnResult | Rules) => void][] = [
  ['a value map of 501 entries', bigMap],
  ['a value of 201 characters', longTitle],
  ['rules over 64 KB', bigRules],
];

describe('checkRulesFile: the caps come first, as a plain refusal', () => {
  /** A stored rules file (a learn result with its name and meta). */
  const stored = (r: LearnResult): Rules => ({ ...r, name: 'F', meta: { source: 'examplePair', status: 'verified' } });

  it.each(OVER)('%s: tooLarge, no problems to fix one by one', (_, over) => {
    expect(checkRulesFile(stored(edited(sourceOne(), over)), 'paid')).toEqual({ ok: false, onlyRuleLimit: false, tooLarge: true, problems: [] });
  });

  it('within the caps: as before', () => {
    expect(checkRulesFile(stored(sourceOne()), 'paid').ok).toBe(true);
  });

  it('the error has its own texts, in both languages', () => {
    expect(apiErrorMessages.rulesTooLarge.en).toContain('too large to save');
    expect(apiErrorMessages.rulesTooLarge.he).toContain('גדול מדי');
  });
});

describe.skipIf(!mongoUri)('every route that stores rules refuses rules over a cap (MongoDB)', () => {
  let appDb: AppDb;
  let app: FastifyInstance;
  let call: ReturnType<typeof makeCaller>;
  const now = (): Date => new Date('2026-10-06T12:00:00.000Z');
  const paid = { tier: 'paid' as const };

  beforeAll(async () => {
    const env = loadEnv({ ...process.env, MONGODB_URI: mongoUri, MONGODB_DB: `formatai_test_caps_${randomUUID().slice(0, 8)}` });
    const db = await connectDb(env);
    if (!db) throw new Error('MongoDB not configured');
    appDb = db;
    await ensureIndexes(appDb);
  });

  afterAll(async () => {
    await app?.close();
    await appDb.db.dropDatabase();
    await appDb.client.close();
  });

  beforeEach(async () => {
    await Promise.all([appDb.formats.deleteMany({}), appDb.conversions.deleteMany({}), appDb.sources.deleteMany({})]);
    await app?.close();
    app = await buildServer({ env: makeEnv(), db: appDb, logger: false, store: createMemoryStore(now), now, identify: stubIdentify });
    call = makeCaller(app);
  });

  const create = (rules: LearnResult | Rules) => call('POST', '/api/formats', { name: `F ${randomUUID().slice(0, 4)}`, ...saveBody(rules) }, paid);
  const rulesOf = async (id: string): Promise<Rules> => (await call('GET', `/api/conversions/${id}`, undefined, paid)).body.conversion.rules as Rules;
  const counts = async (): Promise<number[]> => [await appDb.formats.countDocuments(), await appDb.conversions.countDocuments(), await appDb.sources.countDocuments()];

  it.each(OVER)('POST /api/formats (save a new format): %s', async (_, over) => {
    const res = await create(edited(sourceOne(), over));
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'rulesTooLarge' });
    expect(await counts()).toEqual([0, 0, 0]);
  });

  it.each(OVER)('POST /api/formats/:id/conversions (attach a source): %s', async (_, over) => {
    const first = await create(sourceOne());
    expect(first.status).toBe(201);
    const before = await counts();
    const res = await call('POST', `/api/formats/${first.body.format.id}/conversions`, saveBody(edited(sourceTwo(), over)), paid);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'rulesTooLarge' });
    expect(await counts()).toEqual(before);
  });

  it.each(OVER)('PATCH /api/conversions/:id (a new version from the editor): %s', async (_, over) => {
    const first = await create(sourceOne());
    const id = first.body.conversion.id as string;
    const rules = await rulesOf(id);
    const res = await call('PATCH', `/api/conversions/${id}`, { rules: edited(rules, over), status: 'verified', acceptedDifferences: 0 }, paid);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'rulesTooLarge' });
    const doc = await appDb.conversions.findOne({ _id: new ObjectId(id) });
    expect(doc!.version).toBe(1);
  });

  it('PATCH /api/conversions/:id (the Run screen\'s "Do this every time?"): a "read as" text over 200 characters', async () => {
    const first = await create(sourceOne());
    const id = first.body.conversion.id as string;
    const rules = await rulesOf(id);
    const fix = edited(rules, (r) => void (r.input.columns[1]!.readAs = { 'N/A': '1'.repeat(limits.rules.maxValueChars + 1) }));
    const res = await call('PATCH', `/api/conversions/${id}`, { rules: fix, status: 'verified', acceptedDifferences: 0, baseVersion: 1 }, paid);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'rulesTooLarge' });
    // 200 characters is fine.
    const ok = edited(rules, (r) => void (r.input.columns[1]!.readAs = { 'N/A': '1'.repeat(limits.rules.maxValueChars) }));
    expect((await call('PATCH', `/api/conversions/${id}`, { rules: ok, status: 'verified', acceptedDifferences: 0, baseVersion: 1 }, paid)).status).toBe(200);
  });

  it('POST /api/conversions/:id/restore/:version: a version over a cap (stored before the caps) does not come back', async () => {
    const first = await create(sourceOne());
    const id = first.body.conversion.id as string;
    const rules = await rulesOf(id);
    // A version kept from before the caps existed, written straight to the database (no route stores it any more).
    await appDb.conversions.updateOne({ _id: new ObjectId(id) }, { $push: { versions: { version: 0, rules: edited(rules, bigMap), status: 'verified', acceptedDifferences: 0, at: now() } } });
    const res = await call('POST', `/api/conversions/${id}/restore/0`, {}, paid);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'rulesTooLarge' });
    expect((await appDb.conversions.findOne({ _id: new ObjectId(id) }))!.version).toBe(1);
  });

  it('PATCH /api/sources/:id: a "read as" text over 200 characters, which every format of the source would store', async () => {
    const first = await create(sourceOne());
    const sourceId = (await call('GET', '/api/sources', undefined, paid)).body.sources[0].id as string;
    const cols = (await call('GET', `/api/sources/${sourceId}`, undefined, paid)).body.source.inputSignature.columns;
    const long = { ...cols[1], readAs: { 'N/A': 'x'.repeat(limits.rules.maxValueChars + 1) } };
    const res = await call('PATCH', `/api/sources/${sourceId}`, { inputSignature: { columns: [cols[0], long] } }, paid);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'rulesTooLarge' });
    expect('readAs' in (await rulesOf(first.body.conversion.id)).input.columns[1]!).toBe(false);
  });
});
