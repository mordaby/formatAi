// Sources as first-class objects (SPEC 8.15, 13; fastify inject + a real MongoDB; skipped without MONGODB_URI): saving creates or
// REUSES a source, the source routes, an edit of a source reaching every conversion of it (whatever format it feeds), the source lock
// on restore, and the alias route.
import { randomUUID } from 'node:crypto';
import { checkSourceLock, sourceOf } from '@formatai/engine';
import { limits, type LearnResult, type Rules } from '@formatai/shared';
import type { FastifyInstance } from 'fastify';
import { ObjectId } from 'mongodb';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { connectDb, ensureIndexes, type AppDb } from '../../src/db.js';
import { loadEnv } from '../../src/env.js';
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
      expect(res.body.source).toEqual({ id: expect.any(String), name: 'Supplier A', formats: 1 });
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

    describe('input checks are the source\'s per column (8.15 "The source lock")', () => {
      // What the learn step does: a `required` check on every column the format reads that had no empty cell in the example.
      const required = (column: string) => ({ column, rule: 'required', severity: 'flag' }) as const;
      const FILE = ['ID', 'Amount', 'Note'];
      /** Reads ID, Amount and Note out of the file. */
      const readsThree = (): LearnResult =>
        edited(sourceOne(), (r) => {
          r.input.columns.push({ id: 'note', header: 'Note', type: 'text' });
          r.output.columns = [{ header: 'ID', from: 'id' }, { header: 'Total', from: 'total' }, { header: 'Note', from: 'note' }];
          r.validations = [required('id'), required('amount'), required('note')];
        });
      /** Reads one column fewer out of the same file: no Note, so no check on it. */
      const readsTwo = (): LearnResult =>
        edited(sourceOne(), (r) => {
          r.validations = [required('id'), required('amount')];
        });

      it('two formats learned from the same file that read different columns share ONE source', async () => {
        const first = await create(readsThree(), { name: 'Wide', inputHeaders: FILE });
        const second = await create(readsTwo(), { name: 'Narrow', inputHeaders: FILE });
        expect(first.status).toBe(201);
        expect(second.status).toBe(201);
        expect(second.body.sourceReused).toEqual({ id: first.body.source.id, name: first.body.source.name });
        expect(second.body.source).toMatchObject({ id: first.body.source.id, formats: 2 });
        expect(await appDb.sources.countDocuments()).toBe(1);
        const [s] = await sources();
        expect(s.conversions.map((c: any) => c.formatName)).toEqual(['Wide', 'Narrow']);
        // nothing was added to the source (the narrow one lacks only checks on a column it doesn't read), and both honour its lock
        const doc = await source(first.body.source.id);
        expect(doc.version).toBe(1);
        expect(doc.inputValidations).toEqual([required('ID'), required('Amount'), required('Note')]);
        expect(checkSourceLock(await rulesOf(first.body.conversion.id), doc)).toEqual([]);
        expect(checkSourceLock(await rulesOf(second.body.conversion.id), doc)).toEqual([]);
        // ...and the narrow conversion was given no check on a column it does not have
        expect((await rulesOf(second.body.conversion.id)).validations).toEqual([required('id'), required('amount')]);
        // the other order works too: the wide one joins the narrow one's source and brings the checks on its extra column
        await Promise.all([appDb.formats.deleteMany({}), appDb.conversions.deleteMany({}), appDb.sources.deleteMany({})]);
        const narrowFirst = await create(readsTwo(), { name: 'Narrow', inputHeaders: FILE });
        const wideSecond = await create(readsThree(), { name: 'Wide', inputHeaders: FILE });
        expect(wideSecond.body.sourceReused).toEqual({ id: narrowFirst.body.source.id, name: narrowFirst.body.source.name });
        expect((await source(narrowFirst.body.source.id)).inputValidations).toEqual([required('ID'), required('Amount'), required('Note')]);
      });

      it("an editor save that changes the conversion's input checks edits them on the source: only the conversions that read the column follow", async () => {
        const wide = await create(readsThree(), { name: 'Wide', inputHeaders: FILE });
        const narrow = await create(readsTwo(), { name: 'Narrow', inputHeaders: FILE });
        const sourceId = wide.body.source.id as string;
        const range = (column: string) => ({ column, rule: 'range', min: 0, severity: 'flag' }) as const;
        const unique = (column: string) => ({ column, rule: 'unique', severity: 'flag' }) as const;
        // a flag check on Note, which the narrow format does not read: the source takes it, the narrow conversion is not touched
        const onNote = await saveRules(wide.body.conversion.id, edited(await rulesOf(wide.body.conversion.id), (r) => { r.validations.push(unique('note')); }));
        expect(onNote.status).toBe(200);
        expect(onNote.body).toMatchObject({ sourceChanged: true, affectedConversions: 1 });
        expect((await source(sourceId)).inputValidations).toEqual([required('ID'), required('Amount'), required('Note'), unique('Note')]);
        expect((await detail(narrow.body.conversion.id)).version).toBe(1);
        expect((await rulesOf(narrow.body.conversion.id)).validations).toEqual([required('id'), required('amount')]);
        // a flag check on Amount, which both read: the narrow conversion gets it too (it only marks rows)
        const onAmount = await saveRules(wide.body.conversion.id, edited(await rulesOf(wide.body.conversion.id), (r) => { r.validations.push(range('amount')); }));
        expect(onAmount.body).toMatchObject({ sourceChanged: true });
        const doc = await source(sourceId);
        expect(doc.inputValidations).toEqual([required('ID'), required('Amount'), required('Note'), unique('Note'), range('Amount')]);
        expect((await rulesOf(narrow.body.conversion.id)).validations).toEqual([required('id'), required('amount'), range('amount')]);
        expect(checkSourceLock(await rulesOf(narrow.body.conversion.id), doc)).toEqual([]);
        expect(checkSourceLock(await rulesOf(wide.body.conversion.id), doc)).toEqual([]);
        // an edit that leaves the checks as they were is still not a source edit
        const same = await saveRules(narrow.body.conversion.id, edited(await rulesOf(narrow.body.conversion.id), (r) => { r.output.columns[1]!.format = '0.0'; }));
        expect(same.body.sourceChanged).toBeUndefined();
      });

      it('DECISION: a flag check only one of them has on a shared column is merged into the source; a block check is a mismatch', async () => {
        const first = await create(readsTwo(), { name: 'Plain', inputHeaders: FILE });
        const flagged = edited(readsTwo(), (r) => {
          r.output.columns = [{ header: 'ID', from: 'id' }, { header: 'Amount', from: 'amount' }];
          r.transform.computed = [];
          r.validations.push({ column: 'amount', rule: 'range', min: 0, severity: 'flag' });
        });
        const second = await create(flagged, { name: 'Flagged', inputHeaders: FILE });
        expect(second.body.sourceReused).toEqual({ id: first.body.source.id, name: first.body.source.name });
        const doc = await source(first.body.source.id);
        expect(doc.version).toBe(2);
        expect(doc.inputValidations).toEqual([required('ID'), required('Amount'), { column: 'Amount', rule: 'range', min: 0, severity: 'flag' }]);
        // the first conversation is untouched (a flag never changes what it produces) and still fits the source
        expect((await detail(first.body.conversion.id)).version).toBe(1);
        expect(checkSourceLock(await rulesOf(first.body.conversion.id), doc)).toEqual([]);
        expect(checkSourceLock(await rulesOf(second.body.conversion.id), doc)).toEqual([]);

        // a check that leaves rows out would change the other format's output: not the same source
        const blocking = edited(readsTwo(), (r) => {
          r.output.columns = [{ header: 'ID', from: 'id' }];
          r.transform.computed = [];
          r.validations.push({ column: 'amount', rule: 'range', min: 0, severity: 'block' });
        });
        const third = await create(blocking, { name: 'Blocking', inputHeaders: FILE });
        expect(third.status).toBe(201);
        expect(third.body.sourceReused).toBeUndefined();
        expect(await appDb.sources.countDocuments()).toBe(2);
      });
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
      expect(res.body.source).toEqual({ id: expect.not.stringMatching(sourceId), name: 'My own', formats: 1 });
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

    it('a default name from the example file (`suggestedSourceName`) names a new source, and is numbered - never refused - when it is taken', async () => {
      const first = await create(sourceOne(), { suggestedSourceName: 'orders' });
      expect(first.status).toBe(201);
      expect(first.body.source.name).toBe('orders');
      expect(first.body.conversion.sourceName).toBe('orders');
      expect((await rulesOf(first.body.conversion.id)).meta.sourceName).toBe('orders');
      // another kind of file with the same default ("orders 2026-09.xlsx" from a different supplier): " (2)", " (3)", whatever the case
      const second = await create(sourceTwo(), { suggestedSourceName: 'Orders' });
      expect(second.status).toBe(201);
      expect(second.body.source.name).toBe('Orders (2)');
      const third = await create(edited(sourceTwo(), (r) => { r.input.columns[0]!.header = 'Other'; }), { suggestedSourceName: ' orders  ' });
      expect(third.status).toBe(201);
      expect(third.body.source.name).toBe('orders (3)');
      expect((await sources()).map((s) => s.name).sort()).toEqual(['Orders (2)', 'orders', 'orders (3)']);
      // names belong to the owner: another one is not in the way (Hebrew works like any other)
      expect((await create(sourceOne(), { suggestedSourceName: 'orders' }, OTHER_USER)).body.source.name).toBe('orders');
      expect((await create(sourceTwo(), { suggestedSourceName: 'ספקים' }, OTHER_USER)).body.source.name).toBe('ספקים');
      const hebrew = await create(edited(sourceTwo(), (r) => { r.input.columns[0]!.header = 'Other'; }), { suggestedSourceName: 'ספקים' }, OTHER_USER);
      expect(hebrew.body.source.name).toBe('ספקים (2)');
    });

    it('a name somebody chose (`sourceName` typed, or `newSource`) is still refused when taken, and wins over the default', async () => {
      const first = await create(sourceOne(), { sourceName: 'Supplier A', suggestedSourceName: 'orders' });
      expect(first.body.source.name).toBe('Supplier A');
      const typed = await create(sourceTwo(), { sourceName: 'supplier a', suggestedSourceName: 'prices' });
      expect(typed.status).toBe(409);
      expect(typed.body).toEqual({ error: 'nameTaken' });
      const explicit = await create(sourceTwo(), { newSource: { name: 'SUPPLIER A' }, suggestedSourceName: 'prices' });
      expect(explicit.status).toBe(409);
      expect(explicit.body).toEqual({ error: 'nameTaken' });
      expect(await appDb.sources.countDocuments()).toBe(1);
      expect(await appDb.formats.countDocuments()).toBe(1);
      expect((await create(sourceTwo(), { newSource: { name: 'Mine' }, suggestedSourceName: 'prices' })).body.source.name).toBe('Mine');
    });

    it('a default that cannot be a name is ignored ("Source N"), and none is used when an existing source is reused', async () => {
      for (const [i, bad] of ['', '   ', 'x'.repeat(limits.registry.maxNameChars + 1), 5].entries()) {
        const res = await create(edited(sourceOne(), (r) => { r.input.columns[0]!.header = `Col ${i}`; }), { suggestedSourceName: bad });
        expect(res.status).toBe(201);
        expect(res.body.source.name).toBe(`Source ${i + 1}`);
      }
      await Promise.all([appDb.formats.deleteMany({}), appDb.conversions.deleteMany({}), appDb.sources.deleteMany({})]);
      const { sourceId } = await oneSourceTwoFormats();
      const again = await create(
        edited(sourceOne(), (r) => {
          r.output.columns = [{ header: 'ID', from: 'id' }];
          r.transform.computed = [];
        }),
        { name: 'Ids', suggestedSourceName: 'orders' },
      );
      expect(again.status).toBe(201);
      expect(again.body.sourceReused).toEqual({ id: sourceId, name: 'Supplier A' });
      expect(await appDb.sources.countDocuments()).toBe(1);
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

  // ---------------------------------------------------------------- readAs (8.4a), saved from the Run screen's "Do this every time?"

  describe('what a column reads another way (readAs) is an edit of the source', () => {
    const withReadAs = (rules: Rules, map: Record<string, string>): Rules => edited(rules, (r) => void (r.input.columns[1]!.readAs = map));

    it('a save of the editor path writes it to the source and to every other format it feeds, as a new version of each', async () => {
      const { a, b, sourceId } = await oneSourceTwoFormats();
      // "1.5" and "a.b" are texts with a dot: stored and read back like any other key
      const res = await saveRules(a.conversion.id, withReadAs(await rulesOf(a.conversion.id), { 'N/A': '', 'a.b': '1.5' }));
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ formatChanged: false, sourceChanged: true, affectedConversions: 1, needsReview: [] });
      expect(res.body.conversion.version).toBe(2);

      const s = await source(sourceId);
      expect(s.version).toBe(2);
      expect(s.inputSignature.columns[1].readAs).toEqual({ 'N/A': '', 'a.b': '1.5' });
      const sibling = await detail(b.conversion.id);
      expect(sibling.version).toBe(2);
      expect(sibling.status).toBe('verified');
      expect(sibling.rules.input.columns[1].readAs).toEqual({ 'N/A': '', 'a.b': '1.5' });
      expect(checkSourceLock(sibling.rules, s)).toEqual([]);
      expect(checkSourceLock(await rulesOf(a.conversion.id), s)).toEqual([]);
    });

    it('a second mapping on the same column adds to it (the editor path replaces the column with what the save carries)', async () => {
      const { a, b, sourceId } = await oneSourceTwoFormats();
      await saveRules(a.conversion.id, withReadAs(await rulesOf(a.conversion.id), { 'N/A': '' }));
      // saved from the OTHER format's conversion, which the first save brought to the source (its version moved on): nothing is lost
      const res = await saveRules(b.conversion.id, withReadAs(await rulesOf(b.conversion.id), { 'N/A': '', none: '0' }));
      expect(res.status).toBe(200);
      expect((await source(sourceId)).inputSignature.columns[1].readAs).toEqual({ 'N/A': '', none: '0' });
      expect((await rulesOf(a.conversion.id)).input.columns[1]!.readAs).toEqual({ 'N/A': '', none: '0' });
    });

    it('an editor that has not seen the mapping is refused by the version check, not allowed to take it away', async () => {
      const { a, b } = await oneSourceTwoFormats();
      const stale = await rulesOf(b.conversion.id); // version 1, no mapping
      await saveRules(a.conversion.id, withReadAs(await rulesOf(a.conversion.id), { 'N/A': '' }));
      const res = await saveRules(b.conversion.id, edited(stale, (r) => void (r.output.columns[1]!.format = '0.0')), { baseVersion: 1 });
      expect(res.status).toBe(409);
      expect(res.body).toEqual({ error: 'versionConflict' });
    });

    it('a new format saved into the source after the mapping takes the source\'s reading', async () => {
      const { a, sourceId } = await oneSourceTwoFormats();
      await saveRules(a.conversion.id, withReadAs(await rulesOf(a.conversion.id), { 'N/A': '' }));
      const third = await create(
        edited(sourceOne(), (r) => {
          r.output.columns = [{ header: 'Amount', from: 'amount' }];
          r.transform.computed = [];
        }),
        { name: 'Only amounts', inputHeaders: ['ID', 'Amount'] },
      );
      expect(third.status).toBe(201);
      expect(third.body.source.id).toBe(sourceId);
      const rules = await rulesOf(third.body.conversion.id);
      expect(rules.input.columns.find((c) => c.header === 'Amount')!.readAs).toEqual({ 'N/A': '' });
      expect(checkSourceLock(rules, await source(sourceId))).toEqual([]);
    });

    it('restoring the version before it undoes it: the source and the other formats read the column as before', async () => {
      const { a, b, sourceId } = await oneSourceTwoFormats();
      const id = a.conversion.id as string;
      await saveRules(id, withReadAs(await rulesOf(id), { 'N/A': '' })); // version 2 of a (and of b); the source is at version 2
      const restored = await call('POST', `/api/conversions/${id}/restore/1`, {}, paid);
      expect(restored.status).toBe(200);
      expect(restored.body.conversion.version).toBe(3);
      expect('readAs' in (await rulesOf(id)).input.columns[1]!).toBe(false);
      const s = await source(sourceId);
      expect(s.version).toBe(3);
      expect('readAs' in s.inputSignature.columns[1]).toBe(false);
      const sibling = await detail(b.conversion.id);
      expect(sibling.version).toBe(3);
      expect('readAs' in sibling.rules.input.columns[1]).toBe(false);
      expect(checkSourceLock(sibling.rules, s)).toEqual([]);
      // and the other way: restoring the version WITH it brings it back to everyone
      const again = await call('POST', `/api/conversions/${id}/restore/2`, {}, paid);
      expect(again.status).toBe(200);
      expect((await rulesOf(b.conversion.id)).input.columns[1]!.readAs).toEqual({ 'N/A': '' });
    });

    it('restore still refuses a version that differs in anything else the source lock holds', async () => {
      const { a, sourceId } = await oneSourceTwoFormats();
      const id = a.conversion.id as string;
      await saveRules(id, withReadAs(await rulesOf(id), { 'N/A': '' })); // version 2
      const cols = (await source(sourceId)).inputSignature.columns;
      await patchSource(sourceId, { inputSignature: { columns: cols }, inputReading: { sheet: { pick: 'first' }, headerRow: 4 } });
      const refused = await call('POST', `/api/conversions/${id}/restore/1`, {}, paid);
      expect(refused.status).toBe(422);
      expect(refused.body.problems.map((p: any) => p.path)).toContain('input.headerRow');
    });

    it('rules whose readAs is malformed are refused as invalid rules (an empty key, a non-text value)', async () => {
      const { a } = await oneSourceTwoFormats();
      const rules = await rulesOf(a.conversion.id);
      expect((await saveRules(a.conversion.id, withReadAs(rules, { '': 'x' }))).status).toBe(422);
      expect((await saveRules(a.conversion.id, withReadAs(rules, { x: 1 as unknown as string }))).status).toBe(422);
      const tooMany = Object.fromEntries(Array.from({ length: limits.rules.maxReadAsPerColumn + 1 }, (_, i) => [`t${i}`, '']));
      expect((await saveRules(a.conversion.id, withReadAs(rules, tooMany))).status).toBe(422);
    });
  });

  // ---------------------------------------------------------------- sourceId is required

  describe('a conversion always has a source (sourceId is required)', () => {
    it("every way of saving leaves a conversion whose sourceId is one of the owner's sources, with no copy of the name", async () => {
      const a = await create(sourceOne(), { name: 'Catalog', sourceName: 'Supplier A' }); // flow A, a new source
      const reuse = await create(
        edited(sourceOne(), (r) => {
          r.output.columns = [{ header: 'ID', from: 'id' }];
          r.transform.computed = [];
        }),
        { name: 'Ids', inputHeaders: ['ID', 'Amount'] },
      ); // reuses it
      const attached = await attach(a.body.format.id, sourceTwo()); // flow A2, a new source
      const named = await attach(
        a.body.format.id,
        edited(sourceOne(), (r) => {
          r.input.columns[1]!.type = 'integer';
        }),
        { newSource: { name: 'Third' } },
      );
      for (const res of [a, reuse, attached, named]) expect(res.status).toBe(201);

      const docs = await appDb.conversions.find({}).toArray();
      expect(docs).toHaveLength(4);
      for (const doc of docs) {
        expect(doc.sourceId).toBeInstanceOf(ObjectId);
        const owned = await appDb.sources.findOne({ _id: doc.sourceId, ownerId: doc.ownerId });
        expect(owned, 'its source exists and belongs to the same owner').not.toBeNull();
        expect((doc.rules as Rules).meta.sourceName).toBe(owned!.name); // informational, inside the rules file
        expect(Object.keys(doc)).not.toContain('sourceName'); // the source's own name is the only name
      }
      expect(await appDb.sources.countDocuments()).toBe(3);
    });

    it("every answer that names a conversion carries its sourceId and the source's name", async () => {
      const a = await create(sourceOne(), { name: 'Catalog', sourceName: 'Supplier A' });
      const id = a.body.conversion.id as string;
      const sid = a.body.source.id as string;
      const expected = { sourceId: sid, sourceName: 'Supplier A' };
      expect(a.body.conversion).toMatchObject(expected);
      expect((await call('GET', `/api/formats/${a.body.format.id}`, undefined, paid)).body.conversions[0]).toMatchObject(expected);
      expect(await detail(id)).toMatchObject(expected);
      const saved = await saveRules(id, await rulesOf(id));
      expect(saved.status).toBe(200);
      expect(saved.body.conversion).toMatchObject(expected);
      const restored = await call('POST', `/api/conversions/${id}/restore/1`, {}, paid);
      expect(restored.status).toBe(200);
      expect(restored.body.conversion).toMatchObject(expected);
      const attached = await attach(a.body.format.id, sourceTwo(), { sourceName: 'Supplier B' });
      expect(attached.body.conversion).toMatchObject({ sourceId: attached.body.source.id, sourceName: 'Supplier B' });
      // a rename shows the new name everywhere: the source is the only place it is kept
      expect((await patchSource(sid, { name: 'Acme' })).status).toBe(200);
      expect(await detail(id)).toMatchObject({ sourceId: sid, sourceName: 'Acme' });
      expect((await call('GET', `/api/formats/${a.body.format.id}`, undefined, paid)).body.conversions.map((c: any) => c.sourceName)).toEqual(['Acme', 'Supplier B']);
    });

    it('a save with a source that cannot be resolved is refused, and nothing is stored', async () => {
      const mine = await create(sourceOne(), { name: 'Mine' });
      const theirs = await create(sourceTwo(), {}, OTHER_USER);
      const counts = async () => ({ formats: await appDb.formats.countDocuments(), conversions: await appDb.conversions.countDocuments(), sources: await appDb.sources.countDocuments() });
      const before = await counts();

      const cases: [string, Record<string, unknown>, number][] = [
        ['an id that is no source', { sourceId: new ObjectId().toHexString() }, 404],
        ["another owner's source", { sourceId: theirs.body.source.id }, 404],
        ['a malformed id', { sourceId: 'nope' }, 400],
        ['a source and a new source at once', { sourceId: mine.body.source.id, newSource: { name: 'x' } }, 400],
      ];
      for (const [label, over, status] of cases) {
        const created = await create(sourceOne(), { name: 'New', ...over });
        expect([label, created.status]).toEqual([label, status]);
        const attached = await attach(mine.body.format.id, sourceTwo(), over);
        expect([label, attached.status]).toEqual([label, status]);
      }
      expect(await counts()).toEqual(before);
    });

    it('a conversion whose source no longer exists is not served (there is no fallback for one without a source)', async () => {
      const a = await create(sourceOne(), { name: 'Catalog' });
      const id = a.body.conversion.id as string;
      expect((await saveRules(id, await rulesOf(id))).status).toBe(200); // a version to restore
      await appDb.sources.deleteOne({ _id: new ObjectId(a.body.source.id) }); // the database is now broken: only a direct write can do this
      expect((await call('GET', `/api/conversions/${id}`, undefined, paid)).status).toBe(404);
      expect((await call('PATCH', `/api/conversions/${id}`, { sourceName: 'x' }, paid)).status).toBe(404);
      expect((await call('POST', `/api/conversions/${id}/restore/1`, {}, paid)).status).toBe(404);
      expect((await call('POST', `/api/conversions/${id}/aliases`, { header: 'ID', alias: 'Code' }, paid)).status).toBe(404);
    });

    it("`sourceFormats` is how many formats the conversion's source feeds, and a save says so", async () => {
      const { a, b, sourceId } = await oneSourceTwoFormats();
      expect(a.source.formats).toBe(1);
      expect(b.source).toEqual({ id: sourceId, name: 'Supplier A', formats: 2 });
      expect((await detail(a.conversion.id)).sourceFormats).toBe(2);
      expect((await detail(b.conversion.id)).sourceFormats).toBe(2);
      // another conversion of the same source into a format it already feeds is still one format
      const third = await attach(
        b.format.id,
        edited(sourceOne(), (r) => {
          r.output.columns = [
            { header: 'ID', from: 'id' },
            { header: 'Amount', from: 'amount' },
          ];
          r.transform.computed = [];
        }),
        { sourceId },
      );
      expect(third.status).toBe(201);
      expect(third.body.source.formats).toBe(2);
      // deleting a format's conversion takes it off the count
      await call('DELETE', `/api/conversions/${a.conversion.id}`, undefined, paid);
      expect((await detail(b.conversion.id)).sourceFormats).toBe(1);
    });
  });

  // ---------------------------------------------------------------- headers to ignore ("new column" dismissals)

  describe('ignored headers (SPEC 8.15: the "new column" notice does not come back every month)', () => {
    const ignoredIn = async (id: string): Promise<string[] | undefined> => (await appDb.sources.findOne({ _id: new ObjectId(id) }))?.ignoredHeaders;
    const ignore = (id: string, headers: unknown, user: string | null = TEST_USER) => call('POST', `/api/sources/${id}/ignored-headers`, { headers }, { user, ...paid });
    /** The signature entry the browser matches a file against. */
    const entryOf = async (id: string): Promise<any> => (await call('GET', '/api/signatures', undefined, paid)).body.signatures.find((s: any) => s.sourceId === id);

    it("a save remembers the example's columns that no rule reads, so the first real file does not announce them as new", async () => {
      const res = await create(sourceOne(), { sourceName: 'Supplier A', inputHeaders: ['ID', 'Amount', 'Notes', 'Created by'] });
      const id = res.body.source.id as string;
      // ID and Amount are the source's columns; the other two are what the example also had.
      expect(await ignoredIn(id)).toEqual(['Notes', 'Created by']);
      expect((await entryOf(id)).ignoredHeaders).toEqual(['Notes', 'Created by']);
      // The structure (and its version) is untouched: this is about files, not about how a format reads one.
      expect((await source(id)).version).toBe(1);
    });

    it("a save with nothing unread, or without the example's headers, remembers nothing (the field is absent, not empty)", async () => {
      const exact = await create(sourceOne(), { sourceName: 'Exact', inputHeaders: ['ID', 'Amount'] });
      expect(await ignoredIn(exact.body.source.id)).toBeUndefined();
      expect((await entryOf(exact.body.source.id)).ignoredHeaders).toBeUndefined();
      const bare = await create(sourceTwo(), { sourceName: 'Bare' });
      expect(await ignoredIn(bare.body.source.id)).toBeUndefined();
    });

    it("a reused source gains the new example's unread columns, and never a column it knows (by header or alias) or already ignores", async () => {
      const { sourceId } = await oneSourceTwoFormats(); // the second example also had 'Something else'
      expect(await ignoredIn(sourceId)).toEqual(['Something else']);
      const withAlias = edited(sourceOne(), (r) => {
        r.input.columns[0]!.aliases = ['Identifier'];
        r.transform.computed = [];
        r.output.columns = [{ header: 'ID', from: 'id' }];
      });
      const res = await create(withAlias, { name: 'Ids', inputHeaders: ['Identifier', 'ID', 'Amount', 'something ELSE', 'Remark'] });
      expect(res.body.sourceReused).toEqual({ id: sourceId, name: 'Supplier A' });
      expect(await ignoredIn(sourceId)).toEqual(['Something else', 'Remark']);
    });

    it('POST adds the headers once per source, deduplicated by normalized header, and answers what the source now ignores', async () => {
      const { sourceId } = await oneSourceTwoFormats();
      const first = await ignore(sourceId, ['  Notes ', 'notes', 'Created by']);
      expect(first.status).toBe(200);
      expect(first.body).toEqual({ ignoredHeaders: ['Something else', 'Notes', 'Created by'] });
      // the same again (in another case) is a no-op
      const again = await ignore(sourceId, ['NOTES', 'Remark']);
      expect(again.body).toEqual({ ignoredHeaders: ['Something else', 'Notes', 'Created by', 'Remark'] });
      expect((await entryOf(sourceId)).ignoredHeaders).toEqual(['Something else', 'Notes', 'Created by', 'Remark']);
      // names only: no new version of the source, and no conversion is touched
      expect((await source(sourceId)).version).toBe(1);
      expect(await appDb.conversions.countDocuments({ version: { $gt: 1 } })).toBe(0);
      const doc = await appDb.sources.findOne({ _id: new ObjectId(sourceId) });
      expect(doc!.ignoredHeaders!.every((h) => typeof h === 'string')).toBe(true);
    });

    it("is owner-scoped: someone else's source is a 404 that changes nothing, and signed out is a 401", async () => {
      const { sourceId } = await oneSourceTwoFormats();
      const other = await create(sourceOne(), { sourceName: 'Theirs' }, OTHER_USER);
      const theirs = other.body.source.id as string;

      const stolen = await ignore(sourceId, ['Notes'], OTHER_USER);
      expect(stolen.status).toBe(404);
      expect(stolen.body).toEqual({ error: 'notFound' });
      expect(await ignoredIn(sourceId)).toEqual(['Something else']);
      // each owner can change only their own source, and each list stays their own
      expect((await ignore(theirs, ['Notes'], OTHER_USER)).status).toBe(200);
      expect(await ignoredIn(theirs)).toEqual(['Notes']);
      expect((await ignore(theirs, ['Notes'])).status).toBe(404);
      expect((await ignore(sourceId, ['Notes'], null)).status).toBe(401);
      expect((await ignore('not-an-id', ['Notes'])).status).toBe(404);
      // and the signatures only ever carry the caller's own
      expect((await call('GET', '/api/signatures', undefined, { user: OTHER_USER, ...paid })).body.signatures.map((s: any) => s.ignoredHeaders)).toEqual([['Notes']]);
    });

    it('takes only a list of header names: anything else is a 400, and an over-long or empty name is left out rather than blocking the rest', async () => {
      const { sourceId } = await oneSourceTwoFormats();
      const tooLong = 'x'.repeat(limits.registry.maxAliasChars + 1);
      const tooMany = Array.from({ length: limits.registry.maxInputHeaders + 1 }, (_, i) => `h${i}`);
      for (const bad of [undefined, 'Notes', [], [1], ['Notes', null], [{ header: 'Notes' }], ['', '   '], [tooLong], tooMany]) {
        const res = await ignore(sourceId, bad);
        expect(res.status, JSON.stringify(bad)?.slice(0, 40)).toBe(400);
        expect(res.body).toEqual({ error: 'invalidRequest' });
      }
      // a field the route does not know is not stored
      expect((await call('POST', `/api/sources/${sourceId}/ignored-headers`, { headers: ['Notes'], values: ['secret'] }, paid)).status).toBe(200);
      const mixed = await ignore(sourceId, ['', tooLong, 'Remark']);
      expect(mixed.body).toEqual({ ignoredHeaders: ['Something else', 'Notes', 'Remark'] });
      // nothing but header names is ever stored
      const doc = await appDb.sources.findOne({ _id: new ObjectId(sourceId) });
      expect(Object.keys(doc!).sort()).toEqual(['_id', 'createdAt', 'ignoredHeaders', 'inputReading', 'inputSignature', 'inputValidations', 'name', 'nameKey', 'ownerId', 'updatedAt', 'version', 'versions']);
    });

    it('is capped: past the limit the oldest are dropped, so the dismissal just made always holds', async () => {
      const { sourceId } = await oneSourceTwoFormats();
      const cap = limits.registry.maxIgnoredHeaders;
      const names = (from: number, n: number): string[] => Array.from({ length: n }, (_, i) => `Column ${from + i}`);
      expect((await ignore(sourceId, names(0, 300))).status).toBe(200);
      const res = await ignore(sourceId, names(300, 300));
      expect(res.body.ignoredHeaders).toHaveLength(cap);
      // 'Something else' + 600 added = 601: the oldest 101 are gone, the newest is there
      expect(res.body.ignoredHeaders).not.toContain('Something else');
      expect(res.body.ignoredHeaders[0]).toBe('Column 100');
      expect(res.body.ignoredHeaders.at(-1)).toBe('Column 599');
      expect(await ignoredIn(sourceId)).toHaveLength(cap);
    });
  });
});
