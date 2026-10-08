// POST /api/events through the REAL session: a signed-in browser's events carry its userId, a visitor's carry nothing - not even the anonymous
// id the browser holds (SPEC 14.1; owner decision 2026-10-08). Every suite runs against the in-memory stores, and against a real local MongoDB
// when MONGODB_URI is set.
import { ObjectId } from 'mongodb';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { FakeIssuer } from './fakeIssuer.js';
import { createAuthHarness, googleClaims, memoryKit, mongoKit, mongoUri, startTestIssuer, useKit, type AuthHarness, type AuthKit } from './harness.js';

const view = (page: string) => ({ events: [{ type: 'page_view', props: { page } }] });

function defineSuite(kit: AuthKit): void {
  useKit(kit);
  let issuer: FakeIssuer;
  beforeAll(async () => {
    issuer = await startTestIssuer();
  });
  afterAll(async () => {
    await issuer.close();
  });
  let h: AuthHarness | undefined;
  afterEach(async () => {
    await h?.close();
    h = undefined;
  });
  async function setup(): Promise<AuthHarness> {
    h = await createAuthHarness(kit, issuer);
    return h;
  }

  it('gives a signed-in browser\'s events its userId, from the session cookie', async () => {
    const t = await setup();
    const b = t.browser();
    await t.signIn(b, 'google', googleClaims());
    const [user] = await t.users();
    expect((await b.post('/api/events', view('formats'))).status).toBe(204);
    const usage = await t.usageEvents();
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ type: 'page_view', props: { page: 'formats' } });
    expect(String(usage[0]!.userId)).toBe(String(user!._id));
    expect(usage[0]!.anonId).toBeUndefined();
  });

  it('gives a visitor\'s events no id at all, though the browser holds an anonymous id - and the request sets no cookie', async () => {
    const t = await setup();
    const b = t.browser();
    // the session route is where a visitor first gets the anonymous id
    await b.get('/api/session');
    expect(b.cookie('anonId')).toBeDefined();
    const before = b.cookie('anonId');
    const res = await b.post('/api/events', view('home'));
    expect(res.status).toBe(204);
    expect(res.setCookies).toEqual([]);
    expect(b.cookie('anonId')).toBe(before);
    const usage = await t.usageEvents();
    expect(usage).toHaveLength(1);
    expect(Object.keys(usage[0]!).filter((k) => k !== '_id').sort()).toEqual(['props', 'ts', 'type']);
    expect(JSON.stringify(usage)).not.toContain(before!);
  });

  it('does not hand a browser an anonymous id: the events request alone sets no cookie', async () => {
    const t = await setup();
    const b = t.browser();
    expect((await b.post('/api/events', view('home'))).setCookies).toEqual([]);
    expect(b.cookie('anonId')).toBeUndefined();
  });

  it('does not join a visitor\'s earlier events to their account when they sign in (they have no id to join by)', async () => {
    const t = await setup();
    const b = t.browser();
    await b.get('/api/session');
    await b.post('/api/events', view('home'));
    await t.signIn(b, 'google', googleClaims());
    const [first] = await t.usageEvents();
    expect(first!.userId).toBeUndefined();
    // ... while the sign-in record keeps the anonymous id it always had
    const signedUp = (await t.events()).find((e) => e.type === 'signed_up');
    expect(signedUp!.anonId).toBeDefined();
    expect(signedUp!.userId).toBeInstanceOf(ObjectId);
  });
}

describe('usage events and the session (in memory)', () => defineSuite(memoryKit));
describe.skipIf(!mongoUri)('usage events and the session (MongoDB)', () => defineSuite(mongoKit()));
