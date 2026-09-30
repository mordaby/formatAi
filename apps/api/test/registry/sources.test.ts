// Sources as first-class objects (SPEC 8.15, 13; fastify inject + a real MongoDB; skipped without MONGODB_URI): saving creates or
// REUSES a source, the source routes, an edit of a source reaching every conversion of it (whatever format it feeds), the source lock
// on restore, the alias route, and the migration of conversions written before sources existed.
import { randomUUID } from 'node:crypto';
import { checkSourceLock, sourceOf } from '@formatai/engine';
import type { LearnResult, Rules, SourceStructure } from '@formatai/shared';
import type { FastifyInstance } from 'fastify';
import { ObjectId } from 'mongodb';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { connectDb, ensureIndexes, type AppDb } from '../../src/db.js';
import { loadEnv } from '../../src/env.js';
import { describeMigration, runSourceMigration } from '../../src/registry/migrate.js';
import { createMemoryStore } from '../../src/protection/store.js';
import { buildServer } from '../../src/server.js';
import { makeEnv, mongoUri, stubIdentify, testUserId } from '../protection/harness.js';
import { edited, makeCaller, saveBody, sourceOne, sourceTwo, TEST_USER } from './helpers.js';

const OTHER_USER = testUserId(2);

describe.skipIf(!mongoUri)('sources (MongoDB)', () => {
  let appDb: AppDb;
  let app: FastifyInstance;
  let call: ReturnType<typeof makeCaller>;
  const clock = { current: new Date('2026-09-30T12:00:00.000Z') };
  const now = (): Date => new Date(clock.current);

  beforeAll(async () => {
    const env = loadEnv({ ...process.env, MONGODB_URI: mongoUri, MONGODB_DB: `formatai_test_src_${randomUUID().slice(0, 8)}` });
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
    // a fresh store per test: the paid tier's monthly count of new formats must not carry over
    await app?.close();
    app = await buildServer({ env: makeEnv(), db: appDb, logger: false, store: createMemoryStore(now), now, identify: stubIdentify });
    call = makeCaller(app);
  });

  // ---------------------------------------------------------------- helpers

  const paid = { tier: 'paid' as const };
  /** Save as a new format (flow A). `tier: 'paid'` so the saved-format and sources-per-format limits never get in the way. */
  const create = (rules: LearnResult | Rules = sourceOne(), over: Record<string, unknown> = {}, user: string | null = TEST_USER) =>
    call('POST', '/api/formats', { name: `Format ${randomUUID().slice(0, 4)}`, ...saveBody(rules, over) }, { user, ...paid });
  /** Attach to a format (flow A2). */
  const attach = (formatId: string, rules: LearnResult | Rules, over: Record<string, unknown> = {}, user: string | null = TEST_USER) =>
    call('POST', `/api/formats/${formatId}/conversions`, saveBody(rules, over), { user, ...paid });
  const detail = async (id: string): Promise<any> => (await call('GET', `/api/conversions/${id}`, undefined, paid)).body.conversion;
  const rulesOf = async (id: string): Promise<Rules> => (await detail(id)).rules as Rules;
  const source = async (id: string, user: string = TEST_USER): Promise<any> => (await call('GET', `/api/sources/${id}`, undefined, { user, ...paid })).body.source;
  const sources = async (user: string = TEST_USER): Promise<any[]> => (await call('GET', '/api/sources', undefined, { user, ...paid })).body.sources;
  const saveRules = (id: string, rules: unknown, over: Record<string, unknown> = {}) =>
    call('PATCH', `/api/conversions/${id}`, { rules, status: 'verified', acceptedDifferences: 0, ...over }, paid);
  const patchSource = (id: string, body: Record<string, unknown>, user: string = TEST_USER) => call('PATCH', `/api/sources/${id}`, body, { user, ...paid });

  /** One source feeding two formats: sourceOne's input -> "Catalog" (ID, Total = Amount x 2) and -> "Amounts" (ID, Amount). */
  async function oneSourceTwoFormats() {
    const first = await create(sourceOne(), { name: 'Catalog', sourceName: 'Supplier A' });
    expect(first.status).toBe(201);
    const second = await create(
      edited(sourceOne(), (r) => {
        r.output.columns = [
          { header: 'ID', from: 'id' },
          { header: 'Amount', from: 'amount' },
        ];
        r.transform.computed = [];
      }),
      { name: 'Amounts', inputHeaders: ['ID', 'Amount', 'Something else'] },
    );
    expect(second.status).toBe(201);
    return { a: first.body, b: second.body, sourceId: first.body.source.id as string };
  }

  // ---------------------------------------------------------------- saving: create or reuse

  describe('saving (SPEC 8.15 "Saving")', () => {
    it('flow A creates a source, a format and the conversion between them; the source holds structure only', async () => {
      const res = await create(sourceOne(), { name: 'Catalog', sourceName: 'Supplier A' });
      expect(res.status).toBe(201);
      expect(res.body.source).toEqual({ id: expect.any(String), name: 'Supplier A' });
      expect(res.body.sourceReused).toBeUndefined();
      expect(res.body.conversion).toMatchObject({ sourceId: res.body.source.id, sourceName: 'Supplier A' });

      const doc = await appDb.sources.findOne({ _id: new ObjectId(res.body.source.id) });
      expect(String(doc!.ownerId)).toBe(TEST_USER);
      expect(doc).toMatchObject({ name: 'Supplier A', nameKey: 'supplier a', version: 1, versions: [] });
      expect(doc!.inputSignature.columns).toEqual([
        { header: 'ID', aliases: [], type: 'idLike', required: false },
        { header: 'Amount', aliases: [], type: 'decimal', required: false },
      ]);
      expect(doc!.inputReading).toEqual({ sheet: { pick: 'first' }, headerRow: 'auto' });
      expect(doc!.inputValidations).toEqual([]);
      // Structure only: nothing but headers, types, shapes and reading options.
      expect(Object.keys(doc!).sort()).toEqual(['_id', 'createdAt', 'inputReading', 'inputSignature', 'inputValidations', 'name', 'nameKey', 'ownerId', 'updatedAt', 'version', 'versions']);

      const conv = await appDb.conversions.findOne({ _id: new ObjectId(res.body.conversion.id) });
      expect(String(conv!.sourceId)).toBe(res.body.source.id);
      // The engine's rules file is still self-contained: meta carries the name, and the lock holds.
      expect((conv!.rules as Rules).meta.sourceName).toBe('Supplier A');
      expect(checkSourceLock(conv!.rules as Rules, sourceOf(conv!.rules as Rules))).toEqual([]);
    });

    it('a second format whose example input matches the same source REUSES it, and says so', async () => {
      const { a, b } = await oneSourceTwoFormats();
      expect(b.sourceReused).toEqual({ id: a.source.id, name: 'Supplier A' });
      expect(b.conversion.sourceId).toBe(a.source.id);
      expect(await appDb.sources.countDocuments()).toBe(1);
      const [s] = await sources();
      expect(s.conversions.map((c: any) => c.formatName)).toEqual(['Catalog', 'Amounts']);
    });

    it('matches on the example input\'s headers when the client sends them, and on the declared ones otherwise', async () => {
      const { sourceId } = await oneSourceTwoFormats();
      // a conversion that reads only ID out of a file that has ID and Amount: matched thanks to inputHeaders...
      const onlyId = (): LearnResult =>
        edited(sourceOne(), (r) => {
          r.input.columns = [r.input.columns[0]!];
          r.transform.computed = [];
          r.output.columns = [{ header: 'ID', from: 'id' }];
        });
      const withHeaders = await create(onlyId(), { name: 'Only ids', inputHeaders: ['ID', 'Amount'] });
      expect(withHeaders.body.sourceReused).toEqual({ id: sourceId, name: 'Supplier A' });
      // ...but from the declared column alone it is one of two source columns (0.5): not a match, a new source
      const declaredOnly = await create(onlyId(), { name: 'Only ids 2' });
      expect(declaredOnly.body.sourceReused).toBeUndefined();
      expect(declaredOnly.body.source.id).not.toBe(sourceId);
    });

    it('merges new columns and aliases into the reused source (a source edit) and writes the aliases to its other conversions', async () => {
      const { a, sourceId } = await oneSourceTwoFormats();
      const more = edited(sourceOne(), (r) => {
        r.input.columns[0]!.aliases = ['Identifier'];
        r.input.columns.push({ id: 'note', header: 'Note', type: 'text', required: true });
        r.output.columns = [{ header: 'ID', from: 'id' }, { header: 'Note', from: 'note' }];
        r.transform.computed = [];
      });
      const res = await create(more, { name: 'Notes', inputHeaders: ['ID', 'Amount', 'Note'] });
      expect(res.status).toBe(201);
      expect(res.body.sourceReused).toEqual({ id: sourceId, name: 'Supplier A' });

      const s = await source(sourceId);
      expect(s.version).toBe(2);
      expect(s.inputSignature.columns.map((c: any) => [c.header, c.aliases, c.required])).toEqual([
        ['ID', ['Identifier'], false],
        ['Amount', [], false],
        ['Note', [], true],
      ]);
      // The first format's conversion learned the alias in place: no new version of it, and it still honours the lock.
      const first = await detail(a.conversion.id);
      expect(first.version).toBe(1);
      expect(first.rules.input.columns[0].aliases).toEqual(['Identifier']);
      expect(checkSourceLock(first.rules, s)).toEqual([]);
      // ...and the new conversion, saved with the source's aliases
      expect(checkSourceLock(await rulesOf(res.body.conversion.id), s)).toEqual([]);
    });

    it('does not reuse a source the conversion does not fit (a column typed differently): a new source, with the next free name', async () => {
      await create(sourceOne(), { sourceName: 'Supplier A' });
      const retyped = edited(sourceOne(), (r) => {
        r.input.columns[1]!.type = 'integer';
        r.transform.computed = [];
        r.output.columns = [{ header: 'ID', from: 'id' }, { header: 'Total', from: 'amount' }];
      });
      const res = await create(retyped, { inputHeaders: ['ID', 'Amount'] });
      expect(res.status).toBe(201);
      expect(res.body.sourceReused).toBeUndefined();
      expect(res.body.source.name).toBe('Source 1');
      expect(await appDb.sources.countDocuments()).toBe(2);
    });

    it('an explicit `sourceId` that does not fit answers 422 sourceMismatch with what differs, and saves nothing', async () => {
      const { sourceId } = await oneSourceTwoFormats();
      const retyped = edited(sourceOne(), (r) => {
        r.input.columns[1]!.type = 'integer';
        r.transform.computed = [];
        r.output.columns = [{ header: 'ID', from: 'id' }];
      });
      const before = await appDb.formats.countDocuments();
      const res = await create(retyped, { sourceId });
      expect(res.status).toBe(422);
      expect(res.body.error).toBe('sourceMismatch');
      expect(res.body.problems).toEqual([expect.objectContaining({ kind: 'sourceMismatch', path: 'input.columns[1].type' })]);
      expect(await appDb.formats.countDocuments()).toBe(before);
    });

    it('an explicit `sourceId` reuses that source, and another owner\'s source is a 404', async () => {
      const { a, sourceId } = await oneSourceTwoFormats();
      const other = edited(sourceOne(), (r) => {
        r.output.columns = [{ header: 'ID', from: 'id' }];
        r.transform.computed = [];
      });
      const res = await create(other, { name: 'Ids', sourceId });
      expect(res.status).toBe(201);
      expect(res.body.sourceReused).toEqual({ id: sourceId, name: 'Supplier A' });
      const theirs = await create(sourceOne(), {}, OTHER_USER);
      expect((await create(other, { sourceId: theirs.body.source.id })).status).toBe(404);
      expect(a.source.id).toBe(sourceId);
    });

    it('an explicit `newSource` never reuses: a new source with that name (409 nameTaken when it is in use, whatever the case)', async () => {
      const { sourceId } = await oneSourceTwoFormats();
      const res = await create(sourceOne(), { name: 'Copy', newSource: { name: 'My own' } });
      expect(res.status).toBe(201);
      expect(res.body.sourceReused).toBeUndefined();
      expect(res.body.source).toEqual({ id: expect.not.stringMatching(sourceId), name: 'My own' });
      const taken = await create(sourceOne(), { newSource: { name: 'SUPPLIER a' } });
      expect(taken.status).toBe(409);
      expect(taken.body).toEqual({ error: 'nameTaken' });
      // both forms at once, or a malformed one, are invalid
      expect((await create(sourceOne(), { newSource: { name: 'x' }, sourceId })).status).toBe(400);
      expect((await create(sourceOne(), { sourceId: 'nope' })).status).toBe(400);
      expect((await create(sourceOne(), { newSource: { name: '' } })).status).toBe(400);
      expect((await create(sourceOne(), { inputHeaders: [1] })).status).toBe(400);
    });

    it('source names are unique per OWNER (not per format), and another owner may use the same name', async () => {
      await create(sourceOne(), { sourceName: 'Supplier A' });
      const clash = await create(sourceTwo(), { sourceName: 'supplier A' });
      expect(clash.status).toBe(409);
      expect(clash.body).toEqual({ error: 'nameTaken' });
      expect((await create(sourceOne(), { sourceName: 'Supplier A' }, OTHER_USER)).status).toBe(201);
      // the default name is the first free "Source N" among ALL the owner's sources
      const a = await create(sourceTwo());
      expect(a.body.source.name).toBe('Source 1');
      const b = await create(edited(sourceTwo(), (r) => { r.input.columns[0]!.header = 'Other'; }));
      expect(b.body.source.name).toBe('Source 2');
    });

    it('flow A2 reuses a matching source for the new conversion; a source that already feeds THIS format is not reused on its own', async () => {
      const { a, sourceId } = await oneSourceTwoFormats();
      // another format, fed by Source 2 (Code, Price)
      const other = await create(sourceTwo(), { name: 'Prices', sourceName: 'Supplier B' });
      // attach sourceOne's input to "Prices": it matches Supplier A, which does not feed Prices yet -> reused
      const shape = edited(sourceOne(), (r) => {
        r.output.columns = [{ header: 'ID', from: 'id' }, { header: 'Total', from: 'total' }];
      });
      const reused = await attach(other.body.format.id, shape, { inputHeaders: ['ID', 'Amount'] });
      expect(reused.status).toBe(201);
      expect(reused.body.sourceReused).toEqual({ id: sourceId, name: 'Supplier A' });
      expect(reused.body.conversion.sourceName).toBe('Supplier A');
      // and again: Supplier A now feeds Prices, so a further attach of the same kind of file makes a NEW source
      const again = await attach(other.body.format.id, shape, { inputHeaders: ['ID', 'Amount'] });
      expect(again.status).toBe(201);
      expect(again.body.sourceReused).toBeUndefined();
      expect(again.body.source.id).not.toBe(sourceId);
      expect(a.format.id).not.toBe(other.body.format.id);
    });

    it('does not use up the paid monthly count, or leave a source behind, when the save is refused', async () => {
      const broken = edited(sourceOne(), (r) => {
        r.output.columns[0]!.from = 'missing';
      });
      expect((await create(broken)).status).toBe(422);
      expect(await appDb.sources.countDocuments()).toBe(0);
      const clash = await create(sourceOne(), { sourceName: 'X' });
      expect(clash.status).toBe(201);
      const refused = await create(sourceTwo(), { sourceName: 'x' });
      expect(refused.status).toBe(409);
      expect(await appDb.formats.countDocuments()).toBe(1);
    });
  });

  // ---------------------------------------------------------------- source routes

  describe('routes', () => {
    it('lists the owner\'s sources with the formats they feed, and returns one with its structure', async () => {
      const { a, b, sourceId } = await oneSourceTwoFormats();
      const orphan = await create(sourceTwo(), { name: 'Prices' });
      await call('DELETE', `/api/conversions/${orphan.body.conversion.id}`, undefined, paid);
      await create(sourceOne(), {}, OTHER_USER);

      const list = await sources();
      expect(list.map((s) => s.name)).toEqual(['Supplier A', 'Source 1']);
      expect(list[0]).toMatchObject({ id: sourceId, columns: 2, version: 1, statuses: { verified: 2 }, runCount: 0 });
      expect(list[0].conversions).toEqual([
        { conversionId: a.conversion.id, formatId: a.format.id, formatName: 'Catalog', status: 'verified' },
        { conversionId: b.conversion.id, formatId: b.format.id, formatName: 'Amounts', status: 'verified' },
      ]);
      expect(list[1].conversions).toEqual([]); // a source with no conversion left stays (SPEC 8.15)

      const one = await source(sourceId);
      expect(one.inputSignature.columns).toHaveLength(2);
      expect(one.inputReading).toEqual({ sheet: { pick: 'first' }, headerRow: 'auto' });
      expect(one.conversions).toHaveLength(2);
      // someone else's id is a 404 everywhere
      expect((await call('GET', `/api/sources/${sourceId}`, undefined, { user: OTHER_USER })).status).toBe(404);
      expect((await call('PATCH', `/api/sources/${sourceId}`, { name: 'Mine' }, { user: OTHER_USER })).status).toBe(404);
      expect((await call('DELETE', `/api/sources/${sourceId}`, undefined, { user: OTHER_USER })).status).toBe(404);
      expect((await call('GET', '/api/sources', undefined, { user: null })).status).toBe(401);
      expect((await call('GET', '/api/sources/not-an-id')).status).toBe(404);
    });

    it('renames a source: every conversion shows the new name (also inside its rules), and names stay unique', async () => {
      const { a, b, sourceId } = await oneSourceTwoFormats();
      const other = await create(sourceTwo(), { sourceName: 'Supplier B' });
      const res = await patchSource(sourceId, { name: 'Acme price list' });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ structureChanged: false, affectedConversions: 0, needsReview: [], source: { name: 'Acme price list', version: 1 } });
      for (const id of [a.conversion.id, b.conversion.id]) {
        const c = await detail(id);
        expect(c.sourceName).toBe('Acme price list');
        expect(c.rules.meta.sourceName).toBe('Acme price list');
        expect(c.version).toBe(1); // a rename is not a new version of the rules
      }
      expect((await patchSource(sourceId, { name: 'supplier b' })).body).toEqual({ error: 'nameTaken' });
      expect((await patchSource(sourceId, { name: 'ACME PRICE LIST' })).status).toBe(200); // its own name, another case
      // the format page shows the source's name
      const format = await call('GET', `/api/formats/${a.format.id}`);
      expect(format.body.conversions[0].sourceName).toBe('ACME PRICE LIST');
      expect(other.status).toBe(201);
      // ...and the old route (a conversion's `sourceName`) renames its source
      const viaConversion = await call('PATCH', `/api/conversions/${b.conversion.id}`, { sourceName: 'Via conversion' }, paid);
      expect(viaConversion.body.conversion.sourceName).toBe('Via conversion');
      expect((await source(sourceId)).name).toBe('Via conversion');
      expect((await detail(a.conversion.id)).sourceName).toBe('Via conversion');
    });

    it('deletes a source only when it feeds no format (409 sourceInUse), and keeps it when its conversion is deleted', async () => {
      const { a, b, sourceId } = await oneSourceTwoFormats();
      const blocked = await call('DELETE', `/api/sources/${sourceId}`, undefined, paid);
      expect(blocked.status).toBe(409);
      expect(blocked.body).toEqual({ error: 'sourceInUse' });
      await call('DELETE', `/api/conversions/${a.conversion.id}`, undefined, paid);
      expect((await call('DELETE', `/api/sources/${sourceId}`, undefined, paid)).status).toBe(409);
      await call('DELETE', `/api/formats/${b.format.id}`, undefined, paid);
      expect((await source(sourceId)).conversions).toEqual([]); // still there
      const gone = await call('DELETE', `/api/sources/${sourceId}`, undefined, paid);
      expect(gone.body).toEqual({ deleted: true });
      expect((await call('GET', `/api/sources/${sourceId}`, undefined, paid)).status).toBe(404);
    });

    it('rejects malformed source edits with 400, and answers 409 versionConflict for a stale baseVersion', async () => {
      const { sourceId } = await oneSourceTwoFormats();
      const cols = (await source(sourceId)).inputSignature.columns;
      const bad: Record<string, unknown>[] = [
        {},
        { baseVersion: 1 },
        { name: '' },
        { unknown: true },
        { inputSignature: { columns: [] } },
        { inputSignature: { columns: [{ header: 'ID', aliases: [], type: 'nonsense', required: false }] } },
        { inputSignature: { columns: [cols[0], { ...cols[1], header: 'id' }] } }, // two columns, one name
        { inputReading: { sheet: { pick: 'nowhere' }, headerRow: 'auto' } },
        { inputValidations: [{ column: 'ID', rule: 'no such rule', severity: 'flag' }] },
      ];
      for (const body of bad) {
        const res = await patchSource(sourceId, body);
        expect(res.status, JSON.stringify(body)).toBe(400);
      }
      // an alias may not stand for two columns
      const clash = await patchSource(sourceId, { inputSignature: { columns: [{ ...cols[0], aliases: ['Amount'] }, cols[1]] } });
      expect(clash.status).toBe(409);
      expect(clash.body).toEqual({ error: 'aliasConflict' });
      expect((await patchSource(sourceId, { name: 'x', baseVersion: 7 })).body).toEqual({ error: 'versionConflict' });
    });
  });

  // ---------------------------------------------------------------- editing a source

  describe('editing a source (SPEC 8.15: written to every conversion of it)', () => {
    it('a structural edit makes a new source version and is written into the `input` of every conversion, in every format', async () => {
      const { a, b, sourceId } = await oneSourceTwoFormats();
      const cols = (await source(sourceId)).inputSignature.columns;
      const res = await patchSource(sourceId, {
        baseVersion: 1,
        inputSignature: {
          columns: [
            { ...cols[0], header: 'Item', was: 'ID', aliases: ['ID', 'Code'] },
            { ...cols[1], aliases: ['Value'] },
          ],
        },
        inputReading: { sheet: { pick: 'name', name: 'Data' }, headerRow: 2 },
      });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ structureChanged: true, affectedConversions: 2, needsReview: [], source: { version: 2 } });

      for (const id of [a.conversion.id, b.conversion.id]) {
        const c = await detail(id);
        expect(c.version).toBe(2);
        expect(c.status).toBe('verified');
        expect(c.rules.input.columns[0]).toMatchObject({ id: 'id', header: 'Item', aliases: ['ID', 'Code'] });
        expect(c.rules.input.columns[1]).toMatchObject({ id: 'amount', header: 'Amount', aliases: ['Value'] });
        expect(c.rules.input.sheet).toEqual({ pick: 'name', name: 'Data' });
        expect(c.rules.input.headerRow).toBe(2);
        expect(c.inputSignature.columns[0].header).toBe('Item');
        expect(checkSourceLock(c.rules, await source(sourceId))).toEqual([]);
      }
      // what the rules do is untouched: the output still reads the same ids
      expect((await rulesOf(a.conversion.id)).output.columns.map((c) => c.from)).toEqual(['id', 'total']);
      // the old version is in the history
      const doc = await appDb.sources.findOne({ _id: new ObjectId(sourceId) });
      expect(doc!.versions).toHaveLength(1);
      expect(doc!.versions[0]!.version).toBe(1);
      // the signature matching reads follows
      const sig = (await call('GET', '/api/signatures')).body.signatures[0];
      expect(sig.columns[0]).toMatchObject({ header: 'Item', aliases: ['ID', 'Code'] });
    });

    it('a conversion whose rules no longer resolve becomes needsReview, and the response says which (with its format)', async () => {
      const { a, b, sourceId } = await oneSourceTwoFormats();
      const cols = (await source(sourceId)).inputSignature.columns;
      // Amount becomes text: "Total = Amount x 2" no longer type-checks in Catalog, but "Amounts" just copies it.
      const res = await patchSource(sourceId, { inputSignature: { columns: [cols[0], { ...cols[1], type: 'text' }] } });
      expect(res.status).toBe(200);
      expect(res.body.affectedConversions).toBe(2);
      expect(res.body.needsReview).toEqual([{ id: a.conversion.id, formatId: a.format.id, formatName: 'Catalog' }]);
      expect((await detail(a.conversion.id)).status).toBe('needsReview');
      expect((await detail(b.conversion.id)).status).toBe('verified');
      // the flag shows where the formats are listed
      const list = await sources();
      expect(list[0].statuses).toEqual({ needsReview: 1, verified: 1 });
    });

    it('dropping a column a conversion reads makes it need review; the others are unharmed', async () => {
      const { a, b, sourceId } = await oneSourceTwoFormats();
      const cols = (await source(sourceId)).inputSignature.columns;
      const res = await patchSource(sourceId, { inputSignature: { columns: [cols[0]] } });
      expect(res.status).toBe(200);
      expect(res.body.needsReview.map((f: any) => f.id).sort()).toEqual([a.conversion.id, b.conversion.id].sort());
      expect((await rulesOf(a.conversion.id)).input.columns.map((c) => c.header)).toEqual(['ID']);
    });

    it('an edit of the input side made from a conversion\'s rules map is a SOURCE edit: the source and the other formats follow', async () => {
      const { a, b, sourceId } = await oneSourceTwoFormats();
      const res = await saveRules(
        a.conversion.id,
        edited(await rulesOf(a.conversion.id), (r) => {
          r.input.columns[0]!.header = 'Item';
          r.input.columns[0]!.aliases = ['ID'];
          r.input.columns.push({ id: 'note', header: 'Note', type: 'text' });
        }),
      );
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ formatChanged: false, sourceChanged: true, affectedConversions: 1, needsReview: [] });

      const s = await source(sourceId);
      expect(s.version).toBe(2);
      expect(s.inputSignature.columns.map((c: any) => [c.header, c.aliases])).toEqual([['Item', ['ID']], ['Amount', []], ['Note', []]]);
      // the other format's conversion follows the rename (its ids are its own), gets a new version, and keeps its status
      const sibling = await detail(b.conversion.id);
      expect(sibling.version).toBe(2);
      expect(sibling.status).toBe('verified');
      expect(sibling.rules.input.columns.map((c: any) => [c.id, c.header])).toEqual([['id', 'Item'], ['amount', 'Amount']]);
      expect(checkSourceLock(sibling.rules, s)).toEqual([]);
      expect(checkSourceLock(await rulesOf(a.conversion.id), s)).toEqual([]);
    });

    it('an edit that leaves the input side as the source says is not a source edit', async () => {
      const { a, sourceId } = await oneSourceTwoFormats();
      const res = await saveRules(a.conversion.id, edited(await rulesOf(a.conversion.id), (r) => { r.output.columns[1]!.format = '0.0'; }));
      expect(res.status).toBe(200);
      expect(res.body.sourceChanged).toBeUndefined();
      expect((await source(sourceId)).version).toBe(1);
    });

    it('derives `required` from the conversions: required by at least one', async () => {
      const { a, b, sourceId } = await oneSourceTwoFormats();
      const flags = async () => (await source(sourceId)).inputSignature.columns.map((c: any) => c.required);
      expect(await flags()).toEqual([false, false]);
      await saveRules(b.conversion.id, edited(await rulesOf(b.conversion.id), (r) => { r.input.columns[1]!.required = true; }));
      expect(await flags()).toEqual([false, true]);
      // another conversion not requiring it does not clear it
      await saveRules(a.conversion.id, edited(await rulesOf(a.conversion.id), (r) => { r.input.columns[1]!.required = false; }));
      expect(await flags()).toEqual([false, true]);
      // until nobody does
      await saveRules(b.conversion.id, edited(await rulesOf(b.conversion.id), (r) => { r.input.columns[1]!.required = false; }));
      expect(await flags()).toEqual([false, false]);
    });
  });

  // ---------------------------------------------------------------- aliases, restore

  describe('aliases and restore', () => {
    it('a confirmed mapping is saved ONCE on the source and reaches every conversion of it (no new versions)', async () => {
      const { a, b, sourceId } = await oneSourceTwoFormats();
      const res = await call('POST', `/api/sources/${sourceId}/aliases`, { header: 'Amount', alias: 'Value' }, paid);
      expect(res.status).toBe(200);
      expect(res.body.inputSignature.columns[1]).toEqual({ header: 'Amount', aliases: ['Value'], type: 'decimal', required: false });
      expect((await source(sourceId)).version).toBe(1);
      for (const id of [a.conversion.id, b.conversion.id]) {
        const c = await detail(id);
        expect(c.rules.input.columns[1].aliases).toEqual(['Value']);
        expect(c.inputSignature.columns[1].aliases).toEqual(['Value']);
        expect(c.version).toBe(1);
      }
      // the same alias again is a no-op; one that names another column is refused; an unknown column is a 400
      expect((await call('POST', `/api/sources/${sourceId}/aliases`, { header: 'Amount', alias: 'value' }, paid)).status).toBe(200);
      expect((await call('POST', `/api/sources/${sourceId}/aliases`, { header: 'Amount', alias: 'ID' }, paid)).body).toEqual({ error: 'aliasConflict' });
      expect((await call('POST', `/api/sources/${sourceId}/aliases`, { header: 'Nope', alias: 'X' }, paid)).status).toBe(400);
      expect((await call('POST', `/api/sources/${sourceId}/aliases`, { header: 'Amount', alias: 'X' }, { user: OTHER_USER })).status).toBe(404);
    });

    it('the old conversion route still works and is forwarded to the source (the other format learns it too)', async () => {
      const { a, b, sourceId } = await oneSourceTwoFormats();
      const res = await call('POST', `/api/conversions/${a.conversion.id}/aliases`, { header: 'ID', alias: 'Identifier' }, paid);
      expect(res.status).toBe(200);
      expect(res.body.inputSignature.columns[0]).toMatchObject({ header: 'ID', aliases: ['Identifier'] });
      expect((await source(sourceId)).inputSignature.columns[0].aliases).toEqual(['Identifier']);
      expect((await detail(b.conversion.id)).rules.input.columns[0].aliases).toEqual(['Identifier']);
      // and a later editor save that starts from the stored rules keeps it
      await saveRules(a.conversion.id, await rulesOf(a.conversion.id));
      expect((await source(sourceId)).inputSignature.columns[0].aliases).toEqual(['Identifier']);
    });

    it('restoring an older version brings it to the source\'s current aliases, and refuses one the source lock forbids', async () => {
      const { a, sourceId } = await oneSourceTwoFormats();
      const id = a.conversion.id as string;
      await call('POST', `/api/sources/${sourceId}/aliases`, { header: 'ID', alias: 'Identifier' }, paid);
      await saveRules(id, edited(await rulesOf(id), (r) => { r.transform.computed[0]!.expr = { op: 'mul', args: [{ col: 'amount' }, { const: 3 }] }; })); // version 2
      // version 1 has no alias, the source has one: it comes back with the source's
      const restored = await call('POST', `/api/conversions/${id}/restore/1`, {}, paid);
      expect(restored.status).toBe(200);
      expect((await rulesOf(id)).input.columns[0]!.aliases).toEqual(['Identifier']);

      // the source's reading changes; an older version that reads the file the old way cannot come back on its own
      const cols = (await source(sourceId)).inputSignature.columns;
      await patchSource(sourceId, { inputSignature: { columns: cols }, inputReading: { sheet: { pick: 'first' }, headerRow: 4 } });
      const refused = await call('POST', `/api/conversions/${id}/restore/2`, {}, paid);
      expect(refused.status).toBe(422);
      expect(refused.body.error).toBe('sourceMismatch');
      expect(refused.body.problems).toEqual([expect.objectContaining({ kind: 'sourceMismatch', path: 'input.headerRow' })]);
    });
  });

  // ---------------------------------------------------------------- migration

  describe('migration of conversions written before sources existed (pnpm migrate:sources)', () => {
    /** Creates conversions through the API and then turns them into "legacy" ones: no sourceId, no source documents. */
    async function legacyConversions() {
      const a = await create(sourceOne(), { name: 'Catalog', sourceName: 'Supplier A' });
      const b = await create(
        edited(sourceOne(), (r) => {
          r.output.columns = [{ header: 'ID', from: 'id' }];
          r.transform.computed = [];
          r.input.columns[0]!.header = 'id'; // same signature after normalization
        }),
        { name: 'Ids', sourceName: 'Supplier A copy', newSource: undefined, inputHeaders: ['ID'] },
      );
      const c = await create(sourceTwo(), { name: 'Prices', sourceName: 'Supplier B' });
      const d = await create(sourceOne(), { name: 'Theirs', sourceName: 'Supplier A' }, OTHER_USER);
      await appDb.sources.deleteMany({});
      await appDb.conversions.updateMany({}, { $unset: { sourceId: '' } });
      return { a, b, c, d };
    }
    const snapshot = async () => JSON.stringify(await appDb.conversions.find({}).sort({ _id: 1 }).toArray());

    it('a dry run reports what it would do and writes nothing', async () => {
      await legacyConversions();
      const before = await snapshot();
      const summary = await runSourceMigration(appDb, { dryRun: true });
      expect(summary.dryRun).toBe(true);
      expect(summary.owners).toHaveLength(2);
      expect(await appDb.sources.countDocuments()).toBe(0);
      expect(await snapshot()).toBe(before);
      const lines = describeMigration(summary, 'x').join('\n');
      expect(lines).toContain('dry run');
      expect(lines).toContain('would create source "Supplier A"');
    });

    it('creates one source per group, links every conversion, never touches a rules file, and a second run has nothing to do', async () => {
      const { a, b, c, d } = await legacyConversions();
      const rulesBefore = (await appDb.conversions.find({}).sort({ _id: 1 }).toArray()).map((x) => JSON.stringify(x.rules));

      const first = await runSourceMigration(appDb, { dryRun: false, now: now() });
      expect(first).toMatchObject({ dryRun: false, sourcesCreated: 3, conversionsLinked: 4, alreadyLinked: 0 });
      const owned = await appDb.sources.find({ ownerId: new ObjectId(TEST_USER) }).sort({ createdAt: 1, _id: 1 }).toArray();
      expect(owned.map((s) => s.name)).toEqual(['Supplier A', 'Supplier B']);
      // identical-after-normalization signatures merged; different ones did not; other owners never merge
      const linked = async (id: string) => String((await appDb.conversions.findOne({ _id: new ObjectId(id) }))!.sourceId);
      expect(await linked(a.body.conversion.id)).toBe(String(owned[0]!._id));
      expect(await linked(b.body.conversion.id)).toBe(String(owned[0]!._id));
      expect(await linked(c.body.conversion.id)).toBe(String(owned[1]!._id));
      expect(await linked(d.body.conversion.id)).not.toBe(String(owned[0]!._id));
      expect(await appDb.sources.countDocuments({ ownerId: new ObjectId(OTHER_USER) })).toBe(1);
      // no rules were touched
      expect((await appDb.conversions.find({}).sort({ _id: 1 }).toArray()).map((x) => JSON.stringify(x.rules))).toEqual(rulesBefore);

      // idempotent: nothing to do, nothing changes
      const before = await snapshot();
      const sourcesBefore = await appDb.sources.countDocuments();
      const second = await runSourceMigration(appDb, { dryRun: false });
      expect(second).toMatchObject({ owners: [], sourcesCreated: 0, conversionsLinked: 0, alreadyLinked: 4 });
      expect(await appDb.sources.countDocuments()).toBe(sourcesBefore);
      expect(await snapshot()).toBe(before);
      expect(describeMigration(second, 'x').join('\n')).toContain('nothing to do');
    });

    it('the API works on migrated data: one source per group in signatures, and an edit reaches every conversion of a merged source', async () => {
      const { a, b } = await legacyConversions();
      await runSourceMigration(appDb, { dryRun: false });
      const sigs = (await call('GET', '/api/signatures')).body.signatures;
      expect(sigs.map((s: any) => [s.name, s.conversions.length])).toEqual([['Supplier A', 2], ['Supplier B', 1]]);
      // b spells a header differently from the source ("id" / "ID": the migration never touches rules), so it does not pass the lock yet;
      // saving it brings it to the source (the source's spelling wins: it is the same column to the engine) - no source edit, no sibling touched
      const s = (await sources())[0];
      expect(checkSourceLock(await rulesOf(b.body.conversion.id), await source(s.id)).map((p) => p.path)).toEqual(['input.columns[0]']);
      const res = await saveRules(b.body.conversion.id, await rulesOf(b.body.conversion.id));
      expect(res.status).toBe(200);
      expect(res.body.sourceChanged).toBeUndefined();
      expect(checkSourceLock(await rulesOf(b.body.conversion.id), await source(s.id))).toEqual([]);
      expect(checkSourceLock(await rulesOf(a.body.conversion.id), await source(s.id))).toEqual([]);
      expect((await source(s.id)).version).toBe(1);
      expect((await detail(a.body.conversion.id)).version).toBe(1);
    });

    it('creates the sources\' unique name index, and gives a second run of a half-finished migration a fresh name', async () => {
      await legacyConversions();
      // a source with the group's name already exists (e.g. a half-finished earlier run): the new one is "(2)"
      await appDb.sources.insertOne({
        ownerId: new ObjectId(TEST_USER),
        name: 'Supplier A',
        nameKey: 'supplier a',
        ...(sourceOf(sourceTwo()) as SourceStructure),
        version: 1,
        versions: [],
        createdAt: now(),
        updatedAt: now(),
      });
      const summary = await runSourceMigration(appDb, { dryRun: false });
      expect(summary.owners.find((o) => String(o.ownerId) === TEST_USER)!.sources.map((s) => s.name)).toEqual(['Supplier A (2)', 'Supplier B']);
      const indexes = (await appDb.sources.indexes()).map((i) => i.name);
      expect(indexes).toContain('sources_ownerId_nameKey_unique');
      await expect(
        appDb.sources.insertOne({ ownerId: new ObjectId(TEST_USER), name: 'SUPPLIER B', nameKey: 'supplier b', ...(sourceOf(sourceTwo()) as SourceStructure), version: 1, versions: [], createdAt: now(), updatedAt: now() }),
      ).rejects.toThrow();
    });
  });
});
