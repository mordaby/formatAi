// The size range of a number column (SPEC 5 C, 8.15, owner decision 2026-10-08; fastify inject + a real MongoDB, skipped without MONGODB_URI).
// It belongs to each CONVERSION, never to its source: a source feeds several formats, and one column name can mean different things to them.
// So it is stored with the rules, kept by every write of a source's structure into a conversion (a source edit, a propagation, an alias),
// united with the previous version's on a new version, and changed in place by one owner-scoped route that can only widen it.
import { randomUUID } from 'node:crypto';
import { checkSourceLock } from '@formatai/engine';
import { limits, type LearnResult, type Rules, type SizeRange } from '@formatai/shared';
import type { FastifyInstance } from 'fastify';
import { ObjectId } from 'mongodb';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { connectDb, ensureIndexes, type AppDb } from '../../src/db.js';
import { loadEnv } from '../../src/env.js';
import { createMemoryStore } from '../../src/protection/store.js';
import { buildServer } from '../../src/server.js';
import { makeEnv, mongoUri, stubIdentify, testUserId } from '../protection/harness.js';
import { dropTestDb } from '../setup/testDbs.js';
import { edited, makeCaller, saveBody, sourceOne, TEST_USER } from './helpers.js';

const OTHER_USER = testUserId(2);

/** `sourceOne()` (ID, Amount) with sizes on Amount (a number) and ID (not a number - a range there is stray). */
const withAmountRange = (range: SizeRange | undefined, base: LearnResult = sourceOne()): LearnResult =>
  edited(base, (r) => {
    const amount = r.input.columns.find((c) => c.id === 'amount')!;
    if (range) amount.range = range;
    else delete amount.range;
  });

describe.skipIf(!mongoUri)('size ranges (MongoDB)', () => {
  let appDb: AppDb;
  let app: FastifyInstance;
  let call: ReturnType<typeof makeCaller>;
  const clock = { current: new Date('2026-10-08T12:00:00.000Z') };
  const now = (): Date => new Date(clock.current);

  beforeAll(async () => {
    const env = loadEnv({ ...process.env, MONGODB_URI: mongoUri, MONGODB_DB: `formatai_test_size_${randomUUID().slice(0, 8)}` });
    const db = await connectDb(env);
    if (!db) throw new Error('MongoDB not configured');
    appDb = db;
    await ensureIndexes(appDb);
  });

  afterAll(async () => {
    await dropTestDb(appDb, app);
  });

  beforeEach(async () => {
    await Promise.all([appDb.formats.deleteMany({}), appDb.conversions.deleteMany({}), appDb.sources.deleteMany({})]);
    await app?.close();
    app = await buildServer({ env: makeEnv(), db: appDb, logger: false, store: createMemoryStore(now), now, identify: stubIdentify });
    call = makeCaller(app);
  });

  // ---------------------------------------------------------------- helpers

  const paid = { tier: 'paid' as const };
  const create = (rules: LearnResult | Rules, over: Record<string, unknown> = {}, user: string | null = TEST_USER) =>
    call('POST', '/api/formats', { name: `Format ${randomUUID().slice(0, 4)}`, ...saveBody(rules, over) }, { user, ...paid });
  const attach = (formatId: string, rules: LearnResult | Rules, over: Record<string, unknown> = {}) =>
    call('POST', `/api/formats/${formatId}/conversions`, saveBody(rules, over), paid);
  const detail = async (id: string): Promise<any> => (await call('GET', `/api/conversions/${id}`, undefined, paid)).body.conversion;
  const rulesOf = async (id: string): Promise<Rules> => (await detail(id)).rules as Rules;
  const rangeOf = async (id: string, column = 'amount'): Promise<SizeRange | undefined> => (await rulesOf(id)).input.columns.find((c) => c.id === column)?.range;
  const source = async (id: string): Promise<any> => (await call('GET', `/api/sources/${id}`, undefined, paid)).body.source;
  const saveRules = (id: string, rules: unknown, over: Record<string, unknown> = {}) =>
    call('PATCH', `/api/conversions/${id}`, { rules, status: 'verified', acceptedDifferences: 0, ...over }, paid);
  const patchSource = (id: string, body: Record<string, unknown>) => call('PATCH', `/api/sources/${id}`, body, paid);
  const widen = (id: string, columns: Record<string, unknown>, user: string | null = TEST_USER) => call('POST', `/api/conversions/${id}/widen-ranges`, { columns }, { user, ...paid });
  const stored = async (id: string) => appDb.conversions.findOne({ _id: new ObjectId(id) });

  /** One source (ID, Amount) feeding "Catalog" (learned on thousands to tens of thousands) and "Amounts" (learned on single digits to tens). */
  async function oneSourceTwoFormats() {
    const a = await create(withAmountRange({ lo: 3, hi: 4 }), { name: 'Catalog', sourceName: 'Supplier A' });
    expect(a.status).toBe(201);
    const b = await create(
      withAmountRange(
        { lo: 0, hi: 1 },
        edited(sourceOne(), (r) => {
          r.output.columns = [{ header: 'ID', from: 'id' }, { header: 'Amount', from: 'amount' }];
          r.transform.computed = [];
        }),
      ),
      { name: 'Amounts', inputHeaders: ['ID', 'Amount', 'Something else'] },
    );
    expect(b.status).toBe(201);
    expect(b.body.sourceReused).toEqual({ id: a.body.source.id, name: 'Supplier A' });
    return { a: a.body, b: b.body, sourceId: a.body.source.id as string };
  }

  // ---------------------------------------------------------------- what is stored

  describe('saving', () => {
    it("a new format stores the learned range with the conversion's rules, and nothing of it reaches the source", async () => {
      const res = await create(withAmountRange({ lo: 3, hi: 4 }), { name: 'Catalog', sourceName: 'Supplier A' });
      expect(res.status).toBe(201);
      expect(await rangeOf(res.body.conversion.id)).toEqual({ lo: 3, hi: 4 });

      const doc = await appDb.sources.findOne({ _id: new ObjectId(res.body.source.id) });
      expect(JSON.stringify(doc)).not.toContain('"lo"');
      expect(JSON.stringify(doc)).not.toContain('range');
      const conv = await stored(res.body.conversion.id);
      expect(JSON.stringify(conv!.inputSignature)).not.toContain('"lo"');
      // the signatures the Run screen matches against carry no size either
      const sigs = (await call('GET', '/api/signatures', undefined, paid)).body;
      expect(JSON.stringify(sigs)).not.toContain('"lo"');
      expect(JSON.stringify((await call('GET', '/api/sources', undefined, paid)).body)).not.toContain('"lo"');
    });

    it('rules without a range (everything stored before) save and read back as they were', async () => {
      const res = await create(sourceOne());
      expect(res.status).toBe(201);
      expect(await rangeOf(res.body.conversion.id)).toBeUndefined();
      expect('range' in (await rulesOf(res.body.conversion.id)).input.columns[1]!).toBe(false);
    });

    it('is refused when it is not two bounded integers, lo not above hi', async () => {
      for (const range of [{ lo: 4, hi: 3 }, { lo: limits.matching.sizeMinExponent - 1, hi: 0 }, { lo: 0, hi: limits.matching.sizeMaxExponent + 1 }, { lo: 0.5, hi: 2 }, { lo: 1, hi: 2, min: 7 }]) {
        const res = await create(edited(sourceOne(), (r) => void ((r.input.columns[1] as { range?: unknown }).range = range)));
        expect(res.status, JSON.stringify(range)).toBe(422);
        expect(res.body.error).toBe('invalidRules');
      }
      expect(await appDb.conversions.countDocuments()).toBe(0);
    });

    it('a range on a column that is not a number is dropped (a size means nothing for text)', async () => {
      const res = await create(edited(sourceOne(), (r) => void (r.input.columns[0]!.range = { lo: 1, hi: 2 })));
      expect(res.status).toBe(201);
      expect(await rangeOf(res.body.conversion.id, 'id')).toBeUndefined();
    });

    it('another input of a format (attach) keeps its own learned range, and no source holds one', async () => {
      const first = await create(withAmountRange({ lo: 3, hi: 4 }), { name: 'Catalog', sourceName: 'Supplier A' });
      const second = await attach(
        first.body.format.id,
        edited(withAmountRange({ lo: 0, hi: 1 }), (r) => {
          r.input.columns[1]!.aliases = ['Value'];
        }),
        { inputHeaders: ['ID', 'Value'] },
      );
      expect(second.status).toBe(201);
      expect(await rangeOf(second.body.conversion.id)).toEqual({ lo: 0, hi: 1 });
      expect(await rangeOf(first.body.conversion.id)).toEqual({ lo: 3, hi: 4 });
      for (const doc of await appDb.sources.find({}).toArray()) expect(JSON.stringify(doc)).not.toContain('"lo"');
    });
  });

  // ---------------------------------------------------------------- the pitfall: a source's writes never touch it

  describe('two conversions sharing one source keep their own ranges through every write of the source', () => {
    it('a source edit (rename, alias, reading options) is written into both; each keeps its range', async () => {
      const { a, b, sourceId } = await oneSourceTwoFormats();
      expect(await rangeOf(a.conversion.id)).toEqual({ lo: 3, hi: 4 });
      expect(await rangeOf(b.conversion.id)).toEqual({ lo: 0, hi: 1 });
      expect(JSON.stringify(await source(sourceId))).not.toContain('"lo"');

      const cols = (await source(sourceId)).inputSignature.columns;
      const res = await patchSource(sourceId, {
        baseVersion: 1,
        inputSignature: { columns: [cols[0], { ...cols[1], header: 'Sum', was: 'Amount', aliases: ['Amount', 'Value'] }] },
        inputReading: { sheet: { pick: 'name', name: 'Data' }, headerRow: 2 },
      });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ structureChanged: true, affectedConversions: 2, needsReview: [] });

      for (const [id, range] of [[a.conversion.id, { lo: 3, hi: 4 }], [b.conversion.id, { lo: 0, hi: 1 }]] as const) {
        const c = await detail(id);
        expect(c.version).toBe(2); // really rewritten
        expect(c.rules.input.columns[1]).toMatchObject({ id: 'amount', header: 'Sum', aliases: ['Amount', 'Value'], range });
        expect(checkSourceLock(c.rules, await source(sourceId))).toEqual([]);
      }
      expect(JSON.stringify(await source(sourceId))).not.toContain('"lo"');
    });

    it("an editor save of one conversion (an edit of the source) reaches the other with ITS range, not the saver's", async () => {
      const { a, b, sourceId } = await oneSourceTwoFormats();
      const before = await rulesOf(a.conversion.id);
      const res = await saveRules(a.conversion.id, edited(before, (r) => void (r.input.columns[1]!.aliases = ['Value'])));
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ sourceChanged: true, affectedConversions: 1 });
      expect(await rangeOf(a.conversion.id)).toEqual({ lo: 3, hi: 4 });
      expect(await rangeOf(b.conversion.id)).toEqual({ lo: 0, hi: 1 });
      expect((await rulesOf(b.conversion.id)).input.columns[1]!.aliases).toEqual(['Value']); // the source change did arrive
      expect(JSON.stringify(await source(sourceId))).not.toContain('"lo"');
    });

    it('a confirmed rename (an alias on the source) is written in place into both; ranges are untouched', async () => {
      const { a, b, sourceId } = await oneSourceTwoFormats();
      const res = await call('POST', `/api/sources/${sourceId}/aliases`, { header: 'Amount', alias: 'Total due' }, paid);
      expect(res.status).toBeLessThan(300);
      for (const [id, range] of [[a.conversion.id, { lo: 3, hi: 4 }], [b.conversion.id, { lo: 0, hi: 1 }]] as const) {
        const rules = await rulesOf(id);
        expect(rules.input.columns[1]!.aliases).toContain('Total due');
        expect(rules.input.columns[1]!.range).toEqual(range);
      }
    });

    it('a third format joining the source (it brings an alias, so the source is merged and written to the others) changes no range', async () => {
      const { a, b, sourceId } = await oneSourceTwoFormats();
      const third = await create(
        withAmountRange(
          { lo: 5, hi: 6 },
          edited(sourceOne(), (r) => {
            r.input.columns[1]!.aliases = ['Value'];
            r.output.columns = [{ header: 'ID', from: 'id' }];
            r.transform.computed = [];
          }),
        ),
        { name: 'Ids only', inputHeaders: ['ID', 'Amount'] },
      );
      expect(third.status).toBe(201);
      expect(third.body.sourceReused).toEqual({ id: sourceId, name: 'Supplier A' });
      expect(await rangeOf(a.conversion.id)).toEqual({ lo: 3, hi: 4 });
      expect(await rangeOf(b.conversion.id)).toEqual({ lo: 0, hi: 1 });
      expect(await rangeOf(third.body.conversion.id)).toEqual({ lo: 5, hi: 6 });
      expect((await rulesOf(a.conversion.id)).input.columns[1]!.aliases).toEqual(['Value']);
    });

    it('a source edit that makes the column text takes the range away (a size means nothing for text), and only then', async () => {
      const { a, b, sourceId } = await oneSourceTwoFormats();
      const cols = (await source(sourceId)).inputSignature.columns;
      const res = await patchSource(sourceId, { inputSignature: { columns: [cols[0], { ...cols[1], type: 'text' }] } });
      expect(res.status).toBe(200);
      expect(await rangeOf(a.conversion.id)).toBeUndefined();
      expect(await rangeOf(b.conversion.id)).toBeUndefined();
      // ...while a change to another number type keeps it
      await Promise.all([appDb.formats.deleteMany({}), appDb.conversions.deleteMany({}), appDb.sources.deleteMany({})]);
      const again = await oneSourceTwoFormats();
      const cols2 = (await source(again.sourceId)).inputSignature.columns;
      expect((await patchSource(again.sourceId, { inputSignature: { columns: [cols2[0], { ...cols2[1], type: 'currency' }] } })).status).toBe(200);
      expect(await rangeOf(again.a.conversion.id)).toEqual({ lo: 3, hi: 4 });
      expect(await rangeOf(again.b.conversion.id)).toEqual({ lo: 0, hi: 1 });
    });

    it('a format edit written to the other conversions leaves their ranges alone', async () => {
      const first = await create(withAmountRange({ lo: 3, hi: 4 }), { name: 'Catalog', sourceName: 'Supplier A' });
      const second = await attach(first.body.format.id, withAmountRange({ lo: 0, hi: 1 }, edited(sourceOne(), (r) => void (r.input.columns[1]!.aliases = ['Value']))), { inputHeaders: ['ID', 'Value'] });
      expect(second.status).toBe(201);
      const edit = await saveRules(first.body.conversion.id, edited(await rulesOf(first.body.conversion.id), (r) => void (r.output.columns[1]!.header = 'Doubled')));
      expect(edit.body).toMatchObject({ formatChanged: true, affectedSources: 1 });
      expect(await rangeOf(first.body.conversion.id)).toEqual({ lo: 3, hi: 4 });
      expect(await rangeOf(second.body.conversion.id)).toEqual({ lo: 0, hi: 1 });
    });
  });

  // ---------------------------------------------------------------- a new version keeps the wider range

  describe('a new version of a conversion (Save\'s "Update your format X?", the editor)', () => {
    it('keeps the union of the previous version\'s range and the new one for the same column', async () => {
      const res = await create(withAmountRange({ lo: 3, hi: 4 }));
      const id = res.body.conversion.id as string;
      // a quiet month: learned on tens to hundreds - the saved range grows downwards, never narrows
      expect((await saveRules(id, withAmountRange({ lo: 1, hi: 2 }, await rulesOf(id)))).status).toBe(200);
      expect(await rangeOf(id)).toEqual({ lo: 1, hi: 4 });
      // a bigger one grows it upwards
      expect((await saveRules(id, withAmountRange({ lo: 3, hi: 6 }, await rulesOf(id)))).status).toBe(200);
      expect(await rangeOf(id)).toEqual({ lo: 1, hi: 6 });
      // a narrower one changes nothing
      expect((await saveRules(id, withAmountRange({ lo: 3, hi: 3 }, await rulesOf(id)))).status).toBe(200);
      expect(await rangeOf(id)).toEqual({ lo: 1, hi: 6 });
      expect((await detail(id)).version).toBe(4);
    });

    it('a save that carries no range (too few values this time) keeps the previous one; one that has the first adds it', async () => {
      const res = await create(withAmountRange({ lo: 3, hi: 4 }));
      const id = res.body.conversion.id as string;
      expect((await saveRules(id, withAmountRange(undefined, await rulesOf(id)))).status).toBe(200);
      expect(await rangeOf(id)).toEqual({ lo: 3, hi: 4 });

      const old = await create(sourceOne(), { sourceName: 'Old stored rules' });
      const oldId = old.body.conversion.id as string;
      expect(await rangeOf(oldId)).toBeUndefined();
      expect((await saveRules(oldId, withAmountRange({ lo: 2, hi: 3 }, await rulesOf(oldId)))).status).toBe(200);
      expect(await rangeOf(oldId)).toEqual({ lo: 2, hi: 3 });
    });

    it('is by column id, and a column that is no longer a number loses its range', async () => {
      const res = await create(withAmountRange({ lo: 3, hi: 4 }));
      const id = res.body.conversion.id as string;
      const asText = edited(await rulesOf(id), (r) => {
        r.input.columns[1]!.type = 'text';
        r.transform.computed = [];
        r.output.columns = [{ header: 'ID', from: 'id' }, { header: 'Total', from: 'amount' }];
      });
      expect((await saveRules(id, asText)).status).toBe(200);
      expect(await rangeOf(id)).toBeUndefined();
    });

    it('a restored version also keeps the wider range', async () => {
      const res = await create(withAmountRange({ lo: 3, hi: 4 }));
      const id = res.body.conversion.id as string;
      expect((await saveRules(id, withAmountRange({ lo: 1, hi: 6 }, await rulesOf(id)))).status).toBe(200); // now version 2: 1..6
      const restored = await call('POST', `/api/conversions/${id}/restore/1`, undefined, paid);
      expect(restored.status).toBe(200);
      expect(await rangeOf(id)).toEqual({ lo: 1, hi: 6 });
    });

    it('the previous version\'s range stays in its history as it was', async () => {
      const res = await create(withAmountRange({ lo: 3, hi: 4 }));
      const id = res.body.conversion.id as string;
      await saveRules(id, withAmountRange({ lo: 1, hi: 2 }, await rulesOf(id)));
      const doc = await stored(id);
      expect((doc!.versions[0]!.rules as Rules).input.columns[1]!.range).toEqual({ lo: 3, hi: 4 });
      expect((doc!.rules as Rules).input.columns[1]!.range).toEqual({ lo: 1, hi: 4 });
    });
  });

  // ---------------------------------------------------------------- Run anyway: widen, in place

  describe('POST /api/conversions/:id/widen-ranges (Run anyway)', () => {
    it('widens the saved range to include the file\'s, in place: no new version, nothing else touched', async () => {
      const { a, b, sourceId } = await oneSourceTwoFormats();
      const before = await stored(a.conversion.id);
      const res = await widen(a.conversion.id, { amount: { lo: 1, hi: 2 } });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ widened: ['amount'] });

      const after = await stored(a.conversion.id);
      expect((after!.rules as Rules).input.columns[1]!.range).toEqual({ lo: 1, hi: 4 });
      expect(after!.version).toBe(before!.version);
      expect(after!.versions).toHaveLength(before!.versions.length);
      expect(after!.updatedAt).toEqual(before!.updatedAt);
      // the rest of the rules, byte for byte
      const strip = (r: Rules) => ({ ...r, input: { ...r.input, columns: r.input.columns.map(({ range: _r, ...c }) => c) } });
      expect(strip(after!.rules as Rules)).toEqual(strip(before!.rules as Rules));
      expect(after!.inputSignature).toEqual(before!.inputSignature);
      // the source and the other conversion of it
      expect((await source(sourceId)).version).toBe(1);
      expect(await rangeOf(b.conversion.id)).toEqual({ lo: 0, hi: 1 });
      expect((await stored(b.conversion.id))!.version).toBe(1);
    });

    it('can only widen: a range inside the saved one, or a lower or higher half of it, changes nothing', async () => {
      const res = await create(withAmountRange({ lo: 2, hi: 5 }));
      const id = res.body.conversion.id as string;
      for (const range of [{ lo: 2, hi: 5 }, { lo: 3, hi: 4 }, { lo: 2, hi: 2 }, { lo: 5, hi: 5 }]) {
        const r = await widen(id, { amount: range });
        expect(r.body, JSON.stringify(range)).toEqual({ widened: [] });
        expect(await rangeOf(id)).toEqual({ lo: 2, hi: 5 });
      }
      // one side at a time, and both
      expect((await widen(id, { amount: { lo: 2, hi: 7 } })).body).toEqual({ widened: ['amount'] });
      expect(await rangeOf(id)).toEqual({ lo: 2, hi: 7 });
      expect((await widen(id, { amount: { lo: -3, hi: 7 } })).body).toEqual({ widened: ['amount'] });
      expect(await rangeOf(id)).toEqual({ lo: -3, hi: 7 });
    });

    it('ignores an unknown column id, a column that is not a number, and a column with no saved range', async () => {
      const res = await create(
        edited(withAmountRange({ lo: 3, hi: 4 }), (r) => {
          r.input.columns.push({ id: 'qty', header: 'Qty', type: 'integer' }); // a number with no range yet
          r.output.columns.push({ header: 'Qty', from: 'qty' });
        }),
      );
      expect(res.status).toBe(201);
      const id = res.body.conversion.id as string;
      const out = await widen(id, { nope: { lo: 0, hi: 9 }, id: { lo: 0, hi: 9 }, qty: { lo: 0, hi: 9 }, constructor: { lo: 0, hi: 9 } });
      expect(out.status).toBe(200);
      expect(out.body).toEqual({ widened: [] });
      const rules = await rulesOf(id);
      expect(rules.input.columns.find((c) => c.id === 'id')!.range).toBeUndefined();
      expect(rules.input.columns.find((c) => c.id === 'qty')!.range).toBeUndefined();
      expect(rules.input.columns.find((c) => c.id === 'amount')!.range).toEqual({ lo: 3, hi: 4 });
      // known and unknown together: the known one is widened
      expect((await widen(id, { nope: { lo: 0, hi: 9 }, amount: { lo: 0, hi: 9 } })).body).toEqual({ widened: ['amount'] });
    });

    it('rules saved before there were ranges: nothing to widen, nothing breaks', async () => {
      const res = await create(sourceOne());
      const out = await widen(res.body.conversion.id, { amount: { lo: 0, hi: 1 } });
      expect(out.status).toBe(200);
      expect(out.body).toEqual({ widened: [] });
      expect(await rangeOf(res.body.conversion.id)).toBeUndefined();
    });

    it('validates the bounds and the shape: 400, and nothing is written', async () => {
      const res = await create(withAmountRange({ lo: 3, hi: 4 }));
      const id = res.body.conversion.id as string;
      const bad: unknown[] = [
        { columns: { amount: { lo: 5, hi: 2 } } },
        { columns: { amount: { lo: 0, hi: limits.matching.sizeMaxExponent + 1 } } },
        { columns: { amount: { lo: limits.matching.sizeMinExponent - 1, hi: 0 } } },
        { columns: { amount: { lo: 0.5, hi: 1 } } },
        { columns: { amount: { lo: '0', hi: 1 } } },
        { columns: { amount: { lo: 0, hi: 1, median: 4 } } },
        { columns: { amount: 3 } },
        { columns: [] },
        { columns: {}, extra: true },
        {},
      ];
      for (const body of bad) {
        const r = await call('POST', `/api/conversions/${id}/widen-ranges`, body, paid);
        expect(r.status, JSON.stringify(body)).toBe(400);
        expect(r.body).toEqual({ error: 'invalidRequest' });
      }
      expect((await call('POST', `/api/conversions/${id}/widen-ranges`, undefined, paid)).status).toBe(400);
      expect(await rangeOf(id)).toEqual({ lo: 3, hi: 4 });
    });

    it('is owner-scoped: someone else\'s conversion is a 404, as a missing one, and is not changed', async () => {
      const mine = await create(withAmountRange({ lo: 3, hi: 4 }));
      const id = mine.body.conversion.id as string;
      const other = await widen(id, { amount: { lo: 0, hi: 9 } }, OTHER_USER);
      expect(other.status).toBe(404);
      expect(other.body).toEqual({ error: 'notFound' });
      expect(await rangeOf(id)).toEqual({ lo: 3, hi: 4 });
      expect((await widen(new ObjectId().toHexString(), { amount: { lo: 0, hi: 9 } })).status).toBe(404);
      expect((await widen('not-an-id', { amount: { lo: 0, hi: 9 } })).status).toBe(404);
    });

    it('needs a sign-in', async () => {
      const mine = await create(withAmountRange({ lo: 3, hi: 4 }));
      const anon = await widen(mine.body.conversion.id, { amount: { lo: 0, hi: 9 } }, null);
      expect(anon.status).toBe(401);
      expect(anon.body).toEqual({ error: 'signInRequired' });
      expect(await rangeOf(mine.body.conversion.id)).toEqual({ lo: 3, hi: 4 });
    });

    it('a widened range is what the next new version unites with, and the source lock still holds', async () => {
      const { a, sourceId } = await oneSourceTwoFormats();
      await widen(a.conversion.id, { amount: { lo: 0, hi: 2 } });
      expect(await rangeOf(a.conversion.id)).toEqual({ lo: 0, hi: 4 });
      expect((await saveRules(a.conversion.id, withAmountRange({ lo: 3, hi: 3 }, await rulesOf(a.conversion.id)))).status).toBe(200);
      expect(await rangeOf(a.conversion.id)).toEqual({ lo: 0, hi: 4 });
      expect(checkSourceLock(await rulesOf(a.conversion.id), await source(sourceId))).toEqual([]);
    });
  });
});
