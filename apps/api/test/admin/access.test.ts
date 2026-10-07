// Who may use /api/admin, decided by the server from a real sign-in session (SPEC 12 "Admin", 14.2): a visitor gets 401, a signed-in user who
// is not on the allowlist gets 403, an admin gets in - and a tier an admin sets is what the same user's next request is checked against.
// The sign-in is the real flow against a fake local OIDC issuer (`auth/harness.ts`). In-memory stores always (no database: an admin then gets
// 503), and a real MongoDB when MONGODB_URI is set.
import type { AdminOverview, AdminUpdateUserResponse, MeResponse } from '@formatai/shared';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { FakeIssuer } from '../auth/fakeIssuer.js';
import { createAuthHarness, googleClaims, memoryKit, microsoftClaims, mongoKit, mongoUri, startTestIssuer, useKit, type AuthHarness, type AuthKit } from '../auth/harness.js';

const ADMIN_ROUTES: ['GET' | 'PATCH', string, unknown?][] = [
  ['GET', '/api/admin/overview'],
  ['GET', '/api/admin/function-requests'],
  ['PATCH', '/api/admin/function-requests/000000000000000000000001', { status: 'issueOpened' }],
  ['GET', '/api/admin/users'],
  ['PATCH', '/api/admin/users/000000000000000000000001', { tier: 'paid' }],
  ['GET', '/api/admin/contacts'],
  ['GET', '/api/admin/audit'],
];

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
  const setup = async (): Promise<AuthHarness> => (h = await createAuthHarness(kit, issuer));
  const send = (b: ReturnType<AuthHarness['browser']>, method: 'GET' | 'PATCH', url: string, body?: unknown) =>
    method === 'GET' ? b.get(url) : b.patch(url, body);

  it('401 for a visitor, on every admin route', async () => {
    const t = await setup();
    const visitor = t.browser();
    for (const [method, url, body] of ADMIN_ROUTES) {
      const res = await send(visitor, method, url, body);
      expect(res.status, `${method} ${url}`).toBe(401);
      expect(res.json()).toEqual({ error: 'signInRequired' });
    }
  });

  it('403 for a signed-in user who is not an admin - whatever the tier, provider or email - on every admin route', async () => {
    const t = await setup();
    const sessions = [
      { provider: 'google' as const, claims: googleClaims() },
      // the allowlisted email, but not verified by Google: not an admin
      { provider: 'google' as const, claims: googleClaims({ email: 'boss@example.com', email_verified: false }) },
      // Microsoft does not verify the email claim: it never grants admin
      { provider: 'microsoft' as const, claims: microsoftClaims({ email: 'boss@example.com' }) },
    ];
    for (const s of sessions) {
      const b = t.browser();
      await t.signIn(b, s.provider, s.claims);
      expect(((await b.get('/api/me')).json() as MeResponse).user!.isAdmin).toBe(false);
      for (const [method, url, body] of ADMIN_ROUTES) {
        const res = await send(b, method, url, body);
        expect(res.status, `${method} ${url}`).toBe(403);
        expect(res.json()).toEqual({ error: 'forbidden' });
      }
    }
    // a paid user is still not an admin
    const paid = t.browser();
    await t.signIn(paid, 'google', googleClaims());
    const id = ((await paid.get('/api/me')).json() as MeResponse).user!.id;
    await t.setTier(id, 'paid');
    expect((await paid.get('/api/admin/overview')).status).toBe(403);
  });

  if (kit.name === 'memory') {
    it('an admin passes the gate and is told 503 when there is no database', async () => {
      const t = await setup();
      const admin = t.browser();
      await t.signIn(admin, 'google', googleClaims({ email: 'Boss@Example.com', email_verified: true }));
      for (const [method, url, body] of ADMIN_ROUTES) {
        const res = await send(admin, method, url, body);
        expect(res.status, `${method} ${url}`).toBe(503);
        expect(res.json()).toEqual({ error: 'unavailable' });
      }
    });
  } else {
    it('an admin (a verified allowlisted Google email, or a configured Microsoft oid) gets the overview', async () => {
      const t = await setup();
      const google = t.browser();
      await t.signIn(google, 'google', googleClaims({ email: 'Boss@Example.com', email_verified: true }));
      const res = await google.get('/api/admin/overview?days=7');
      expect(res.status).toBe(200);
      expect((res.json() as AdminOverview).users.total).toBeGreaterThanOrEqual(1);

      const microsoft = t.browser();
      await t.signIn(microsoft, 'microsoft', microsoftClaims({ oid: 'ms-admin-oid' }));
      expect((await microsoft.get('/api/admin/audit')).status).toBe(200);
    });

    it('a tier the admin sets is what that user is checked against on the next request, and the change is in the audit log', async () => {
      const t = await setup();
      const admin = t.browser();
      await t.signIn(admin, 'google', googleClaims({ email: 'boss@example.com', email_verified: true }));
      const person = t.browser();
      await t.signIn(person, 'google', googleClaims());
      const id = ((await person.get('/api/me')).json() as MeResponse).user!.id;

      const res = await admin.patch(`/api/admin/users/${id}`, { tier: 'paid', limitOverrides: { aiLearns: 7 } }, { origin: 'http://localhost:5173' });
      expect(res.status).toBe(200);
      expect((res.json() as AdminUpdateUserResponse).user).toMatchObject({ id, tier: 'paid', aiLearns: { limit: 7 } });
      expect(((await person.get('/api/me')).json() as MeResponse).user!.tier).toBe('paid');
      expect((await person.get('/api/__identity')).json()).toMatchObject({ kind: 'user', userId: id, tier: 'paid', learnLimitOverride: 7 });
      // API audit P2: the quota says the user's OWN limit - the override, not the plan's number
      expect((await person.get('/api/learn/quota')).json()).toEqual({ quota: { remaining: 7, period: 'month', limit: 7 } });

      // the audit log names the admin who did it, as she signed in
      const audit = (await admin.get('/api/admin/audit')).json() as { entries: { adminEmail: string | null; action: string; targetId: string }[] };
      expect(audit.entries.map((e) => [e.action, e.targetId, e.adminEmail]).sort()).toEqual([
        ['user.limitOverrides', id, 'boss@example.com'],
        ['user.tier', id, 'boss@example.com'],
      ]);

      // ...and the person herself still cannot reach any of it
      expect((await person.patch(`/api/admin/users/${id}`, { tier: 'registered' })).status).toBe(403);
      expect(((await person.get('/api/me')).json() as MeResponse).user!.tier).toBe('paid');
    });
  }
}

describe('admin access (in memory)', () => defineSuite(memoryKit));
describe.skipIf(!mongoUri)('admin access (MongoDB)', () => defineSuite(mongoKit()));
