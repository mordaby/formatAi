// learn-v7 (issue #40, SPEC 13, 15): function requests end to end - the `function_requests` store contract (atomic upsert, counts, distinct
// HASHED owners), the value filter in the learn route (a request with a payload value is rejected, counted, never stored), and the privacy
// rule for the explanation (never cached, never in the ledger, never saved). Runs on the in-memory store and on real MongoDB when MONGODB_URI is set.
import { formulaRulesToWire } from '@formatai/engine';
import { limits, toWire, type FunctionRequest, type LearnPayload, type LearnResult } from '@formatai/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { requestCounterKey, requestKey } from '../../src/learn/index.js';
import { externalColumnPayload, externalColumnRules } from '../learn/fixtures.js';
import {
  anonCookie,
  createHarness,
  makeComplete,
  memoryKit,
  mongoKit,
  mongoUri,
  TEST_USER,
  testUserId,
  useKit,
  type Harness,
  type StoreKit,
} from './harness.js';

const REQUEST: FunctionRequest = {
  name: 'lookupStorageSite',
  purpose: 'Finds the storage site of an item from an external reference table.',
  args: [{ name: 'item', type: 'text' }],
  returns: 'text',
};
const EXPLANATION = 'Looks like the storage site that belongs to each item.';
const KEY = requestKey(REQUEST);

/** The wire JSON an AI answer for `externalColumnPayload()` has: Warehouse unsupported, with the notes. */
function answerWith(notes: { functionRequest?: unknown; explanation?: unknown }): unknown {
  const rules = externalColumnRules('externalData');
  const noted = { ...rules, unsupported: [{ ...rules.unsupported[0]!, ...notes }] } as unknown as LearnResult;
  return toWire(formulaRulesToWire(noted) as unknown as LearnResult);
}

const month = (d: Date): string => d.toISOString().slice(0, 7);

function defineSuite(kit: StoreKit): void {
  useKit(kit);

  let harness: Harness | undefined;
  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });
  async function setup(json: unknown, payloadOver: Partial<LearnPayload> = {}): Promise<{ h: Harness; llm: ReturnType<typeof makeComplete>; body: Record<string, unknown> }> {
    const llm = makeComplete({ json });
    const h = (harness = await createHarness(kit, { complete: llm.fn }));
    return { h, llm, body: { payload: externalColumnPayload(payloadOver), noCache: true } };
  }

  // ---------- the store contract ----------

  describe('function_requests store', () => {
    const write = (over: Partial<Parameters<Harness['handle']['store']['upsertFunctionRequest']>[0]> = {}) => ({
      key: KEY,
      name: REQUEST.name,
      purpose: REQUEST.purpose,
      args: REQUEST.args,
      returns: REQUEST.returns,
      topic: 'lookups',
      ownerHash: 'a'.repeat(24),
      now: new Date('2026-10-01T10:00:00Z'),
      ...over,
    });

    it('creates the document on first sight (status new) and bumps it after: count, lastSeen, distinct owners by hash', async () => {
      const { store, functionRequests } = await kit.make(() => new Date());
      await store.upsertFunctionRequest(write());
      await store.upsertFunctionRequest(write({ ownerHash: 'a'.repeat(24), now: new Date('2026-10-02T10:00:00Z'), purpose: 'a later, different sentence' }));
      await store.upsertFunctionRequest(write({ ownerHash: 'b'.repeat(24), now: new Date('2026-10-03T10:00:00Z') }));

      const docs = await functionRequests();
      expect(docs).toHaveLength(1);
      expect(docs[0]).toMatchObject({
        key: KEY,
        name: 'lookupStorageSite',
        purpose: REQUEST.purpose, // as first seen
        args: REQUEST.args,
        returns: 'text',
        topic: 'lookups',
        count: 3,
        distinctOwners: 2,
        status: 'new',
      });
      expect(docs[0]!.firstSeen).toEqual(new Date('2026-10-01T10:00:00Z'));
      expect(docs[0]!.lastSeen).toEqual(new Date('2026-10-03T10:00:00Z'));
      expect([...docs[0]!.ownerHashes].sort()).toEqual(['a'.repeat(24), 'b'.repeat(24)]);
    });

    it('is atomic: concurrent upserts of one request never lose a count or a distinct owner', async () => {
      const { store, functionRequests } = await kit.make(() => new Date());
      await Promise.all(Array.from({ length: 30 }, (_, i) => store.upsertFunctionRequest(write({ ownerHash: String(i % 6).repeat(24) }))));
      const docs = await functionRequests();
      expect(docs).toHaveLength(1);
      expect(docs[0]!.count).toBe(30);
      expect(docs[0]!.distinctOwners).toBe(6);
    });

    it('keeps different requests apart (the key is the name plus the signature)', async () => {
      const { store, functionRequests } = await kit.make(() => new Date());
      await store.upsertFunctionRequest(write());
      await store.upsertFunctionRequest(write({ key: requestKey({ ...REQUEST, returns: 'integer' }), returns: 'integer' }));
      expect((await functionRequests()).map((d) => d.key).sort()).toEqual([KEY, requestKey({ ...REQUEST, returns: 'integer' })].sort());
    });

    it('stores text that starts with "$" as plain text (never read as a field path)', async () => {
      const { store, functionRequests } = await kit.make(() => new Date());
      await store.upsertFunctionRequest(write({ purpose: '$purpose is a literal', name: 'dollarName' }));
      const [doc] = await functionRequests();
      expect(doc!.purpose).toBe('$purpose is a literal');
    });

    it('stops growing the owner set at limits.learn.functionRequests.maxOwnerHashes', async () => {
      const cap = limits.learn.functionRequests as { maxOwnerHashes: number };
      const before = cap.maxOwnerHashes;
      cap.maxOwnerHashes = 3;
      try {
        const { store, functionRequests } = await kit.make(() => new Date());
        for (let i = 0; i < 5; i++) await store.upsertFunctionRequest(write({ ownerHash: String(i).repeat(24) }));
        const [doc] = await functionRequests();
        expect(doc!.count).toBe(5);
        expect(doc!.distinctOwners).toBe(3);
      } finally {
        cap.maxOwnerHashes = before;
      }
    });
  });

  // ---------- the learn route ----------

  describe('POST /api/learn with a function request and an explanation', () => {
    it('records a clean request (topic guessed, owner hashed) and answers with both notes still on the answer', async () => {
      const { h, body } = await setup(answerWith({ functionRequest: REQUEST, explanation: EXPLANATION }));
      const res = await h.learn(body);
      expect(res.statusCode).toBe(200);
      const json = res.json();
      expect(json.verified).toBe(true);
      expect(json.rules.unsupported).toEqual([{ outputColumn: 'Warehouse', reasonCode: 'externalData', functionRequest: REQUEST, explanation: EXPLANATION }]);

      const docs = await h.handle.functionRequests();
      expect(docs).toHaveLength(1);
      expect(docs[0]).toMatchObject({ key: KEY, name: REQUEST.name, purpose: REQUEST.purpose, args: REQUEST.args, returns: 'text', topic: 'lookups', count: 1, distinctOwners: 1, status: 'new' });
      expect(docs[0]!.ownerHashes).toHaveLength(1);
      expect(docs[0]!.ownerHashes[0]).toMatch(/^[0-9a-f]{24}$/);
      expect(JSON.stringify(docs[0])).not.toContain(TEST_USER); // never the raw owner id
      expect(await h.handle.counter(requestCounterKey('recorded', h.clock.current))).toBe(1);
      expect(await h.handle.counter(requestCounterKey('rejected', h.clock.current))).toBe(0);
      expect(JSON.stringify(docs[0])).not.toContain('Looks like'); // the explanation is not in the collection
    });

    it.each([
      ['a sample value in the name (a lower-case token of a cell)', { ...REQUEST, name: 'northSiteLookup' }],
      ['a sample value in the purpose, any case', { ...REQUEST, purpose: 'Finds the SOUTH storage site.' }],
      ['a sample value in an argument name', { ...REQUEST, args: [{ name: 'northItem', type: 'text' as const }] }],
      ['a sample id (a cell of the input)', { ...REQUEST, purpose: 'Finds the site for a1.' }],
      ['a number of a sample row', { ...REQUEST, purpose: 'Returns the site when the amount is 10.' }],
      ['a hint value', { ...REQUEST, purpose: 'Finds the site, like Zulu does.' }],
    ])('rejects a request with %s: counted, never stored, removed from the answer (the explanation stays)', async (_label, request) => {
      const { h, body } = await setup(answerWith({ functionRequest: request, explanation: EXPLANATION }));
      // (the hint is for the column that HAS a rule, Total: a hint for the unsupported column would be evidence against giving up on it, a repair)
      (body.payload as LearnPayload).hints = [{ out: 1, rel: 'valueMap', in: [0], pairs: [['A1', 'Zulu']], coverage: 1 }];
      const res = await h.learn(body);
      expect(res.statusCode).toBe(200);
      expect(res.json().verified).toBe(true); // a rejected extra never fails a learn
      expect(res.json().rules.unsupported).toEqual([{ outputColumn: 'Warehouse', reasonCode: 'externalData', explanation: EXPLANATION }]);

      expect(await h.handle.functionRequests()).toEqual([]);
      expect(await h.handle.counter(requestCounterKey('rejected', h.clock.current))).toBe(1);
      expect(await h.handle.counter(requestCounterKey('recorded', h.clock.current))).toBe(0);
    });

    it('rejects a request that mentions a MASKED word of the payload (the vocabulary the answer was written against)', async () => {
      const { h, body } = await setup(answerWith({ functionRequest: { ...REQUEST, name: 'qzxvbSite' } }));
      (body.payload as LearnPayload).masking = true;
      (body.payload as LearnPayload).samples = [
        { in: ['A1', 10], out: ['A1', 20, 'Qzxvb'] },
        { in: ['A2', 5], out: ['A2', 10, 'Plmko'] },
      ];
      const res = await h.learn(body);
      expect(res.statusCode).toBe(200);
      expect(res.json().rules.unsupported[0].functionRequest).toBeUndefined();
      expect(await h.handle.functionRequests()).toEqual([]);
    });

    it('drops a malformed request (not camelCase) and an over-long explanation without failing or repairing the learn', async () => {
      const { h, llm, body } = await setup(answerWith({ functionRequest: { ...REQUEST, name: 'Lookup Storage Site' }, explanation: 'e'.repeat(limits.learn.notes.maxExplanationChars + 1) }));
      const res = await h.learn(body);
      expect(res.statusCode).toBe(200);
      const json = res.json();
      expect(json.verified).toBe(true);
      expect(json.problems).toEqual([]);
      expect(llm.calls).toHaveLength(1); // no repair
      expect(json.rules.unsupported).toEqual([{ outputColumn: 'Warehouse', reasonCode: 'externalData' }]);
      expect(await h.handle.functionRequests()).toEqual([]);
    });

    it('counts a request per distinct HASHED owner: the same function from two users is one document, count 2, distinctOwners 2; the same user twice, count 2, distinctOwners 1', async () => {
      const { h, body } = await setup(answerWith({ functionRequest: REQUEST }));
      const second = testUserId(2);
      const cookieA = anonCookie(await h.get('/api/session'));
      const cookieB = anonCookie(await h.get('/api/session'));
      expect((await h.learn(body, { cookie: cookieA })).statusCode).toBe(200);
      expect((await h.learn(body, { cookie: cookieA })).statusCode).toBe(200);
      let [doc] = await h.handle.functionRequests();
      expect(doc).toMatchObject({ count: 2, distinctOwners: 1 });

      expect((await h.learn(body, { user: second, cookie: cookieB })).statusCode).toBe(200);
      const docs = await h.handle.functionRequests();
      expect(docs).toHaveLength(1);
      [doc] = docs;
      expect(doc).toMatchObject({ count: 3, distinctOwners: 2 });
      const stored = JSON.stringify(doc);
      expect(stored).not.toContain(TEST_USER);
      expect(stored).not.toContain(second);
    });

    it('a repair that carries the same request again does not count it twice', async () => {
      const { h, body } = await setup(answerWith({ functionRequest: REQUEST, explanation: EXPLANATION }));
      const cookie = anonCookie(await h.get('/api/session'));
      const learned = (await h.learn(body, { cookie })).json() as { rules: unknown; learnId: string };
      expect((await h.handle.functionRequests())[0]!.count).toBe(1);

      const repair = await h.post('/api/learn/repair', { payload: body.payload, previousRules: learned.rules, problems: [], learnId: learned.learnId }, { cookie });
      expect(repair.statusCode).toBe(200);
      expect(repair.json().rules.unsupported[0]).toMatchObject({ functionRequest: REQUEST, explanation: EXPLANATION }); // still on the answer
      expect((await h.handle.functionRequests())[0]).toMatchObject({ count: 1, distinctOwners: 1 });
    });
  });

  // ---------- the explanation is never stored ----------

  describe('the explanation (and the request) never reach the cache, the ledger, a cache hit or the registry', () => {
    it('is not in the structure cache, not in the ledger, and not on a later cache hit', async () => {
      // Masking ON: only masking-ON rules are cached, and these have no text constants.
      const { h, body } = await setup(answerWith({ functionRequest: REQUEST, explanation: EXPLANATION }), { masking: true });
      const cookie = anonCookie(await h.get('/api/session'));
      const first = (await h.learn({ ...body, noCache: false }, { cookie })).json();
      expect(first.verified).toBe(true);
      expect(first.rules.unsupported[0].explanation).toBe(EXPLANATION);

      expect(await h.handle.cacheEntryCount()).toBe(1);
      for (const cached of await h.handle.cacheRules()) {
        expect(cached).not.toContain('Looks like');
        expect(cached).not.toContain('lookupStorageSite');
        expect(cached).not.toContain('functionRequest');
        expect(cached).not.toContain('explanation');
      }
      expect(JSON.stringify(await h.handle.ledger())).not.toMatch(/Looks like|lookupStorageSite|explanation|functionRequest/);

      const hit = await h.learn({ ...body, noCache: false }, { cookie });
      const hitJson = hit.json();
      expect(hitJson.cached).toBe(true);
      expect(hitJson.rules.unsupported).toEqual([{ outputColumn: 'Warehouse', reasonCode: 'externalData' }]);
    });
  });
}

describe('function requests (in-memory store)', () => {
  defineSuite(memoryKit);
});

describe.skipIf(!mongoUri)('function requests (MongoDB)', () => {
  defineSuite(mongoKit());
});

// keep the month helper referenced for readers: counters are monthly
void month;
