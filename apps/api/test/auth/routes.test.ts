// Sign-in end to end (SPEC 12, 5 E) through fastify inject and the real openid-client, against a fake local
// OIDC issuer (no request ever leaves the machine). Every suite runs against the in-memory stores, and against a
// real local MongoDB when MONGODB_URI is set.
import type { MeResponse } from '@formatai/shared';
import { ObjectId } from 'mongodb';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createMemoryStore } from '../../src/protection/store.js';
import { buildServer } from '../../src/server.js';
import { makeEnv } from '../protection/harness.js';
import type { FakeIssuer } from './fakeIssuer.js';
import {
  API_BASE,
  createAuthHarness,
  googleClaims,
  memoryKit,
  microsoftClaims,
  mongoKit,
  mongoUri,
  startTestIssuer,
  useKit,
  WEB_ORIGIN,
  type AuthHarness,
  type AuthHarnessOptions,
  type AuthKit,
} from './harness.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function defineAuthSuite(kit: AuthKit): void {
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
  async function setup(opts: AuthHarnessOptions = {}): Promise<AuthHarness> {
    h = await createAuthHarness(kit, issuer, opts);
    return h;
  }
  const me = async (b: ReturnType<AuthHarness['browser']>): Promise<MeResponse> => (await b.get('/api/me')).json() as MeResponse;
  const flowCookie = (setCookies: string[], name: string): string => setCookies.find((c) => c.startsWith(`${name}=`)) ?? '';

  // ---------- providers and /start ----------

  describe('GET /api/auth/providers', () => {
    it('offers Google first, then Microsoft', async () => {
      const t = await setup();
      const res = await t.browser().get('/api/auth/providers');
      expect(res.json()).toEqual({ providers: ['google', 'microsoft'] });
    });

    it('offers only the providers that are configured', async () => {
      const t = await setup({ providers: ['google'] });
      const b = t.browser();
      expect((await b.get('/api/auth/providers')).json()).toEqual({ providers: ['google'] });
      // A provider that is not offered has no routes either.
      expect((await b.get('/api/auth/microsoft/start')).status).toBe(404);
      expect((await b.get('/api/auth/microsoft/callback')).status).toBe(404);
      expect((await b.get('/api/auth/github/start')).status).toBe(404);
    });
  });

  describe('GET /api/auth/:provider/start', () => {
    it('redirects to the provider with the code flow, PKCE S256, scopes, state and nonce', async () => {
      const t = await setup();
      const res = await t.browser().get('/api/auth/google/start');
      expect(res.status).toBe(302);
      const url = res.location!;
      expect(url.origin + url.pathname).toBe(`${issuer.origin}/google/authorize`);
      const p = url.searchParams;
      expect(p.get('client_id')).toBe('google-client-id');
      expect(p.get('response_type')).toBe('code');
      expect(p.get('scope')).toBe('openid email profile');
      expect(p.get('redirect_uri')).toBe(`${API_BASE}/api/auth/google/callback`);
      expect(p.get('code_challenge_method')).toBe('S256');
      expect(p.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(p.get('state')).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(p.get('nonce')).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(p.get('prompt')).toBeNull();
    });

    it('keeps state, nonce and the PKCE verifier in a short-lived signed httpOnly cookie - not in the URL', async () => {
      const t = await setup();
      const res = await t.browser().get('/api/auth/google/start?returnTo=/result');
      const raw = flowCookie(res.setCookies, 'flow_google');
      expect(raw).toMatch(/HttpOnly/i);
      expect(raw).toMatch(/SameSite=Lax/i);
      expect(raw).toMatch(/Path=\/api\/auth/);
      expect(raw).toMatch(/Max-Age=600/);
      expect(raw).not.toMatch(/Secure/i); // development
      const value = raw.split(';')[0]!.split('=')[1]!;
      expect(value).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/); // payload.mac
      const flow = JSON.parse(Buffer.from(value.split('.')[0]!, 'base64url').toString('utf8')) as Record<string, string>;
      expect(flow.state).toBe(res.location!.searchParams.get('state'));
      expect(flow.nonce).toBe(res.location!.searchParams.get('nonce'));
      expect(flow.returnTo).toBe('/result');
      // The verifier stays out of everything the provider sees; only its S256 challenge is sent.
      expect(res.location!.href).not.toContain(flow.codeVerifier!);
    });

    it('answers 502 when the provider cannot be reached', async () => {
      const t = await setup();
      await issuer.close(); // discovery fails
      const res = await t.browser().get('/api/auth/google/start');
      expect(res.status).toBe(502);
      expect(res.json()).toEqual({ error: 'providerUnavailable' });
      issuer = await startTestIssuer();
    });
  });

  // ---------- /callback: sign-in, users, sessions ----------

  describe('sign-in', () => {
    it('creates a registered user, sets the session cookie and lands on returnTo', async () => {
      const t = await setup();
      const b = t.browser();
      const claims = googleClaims({ email: 'gina@example.com' });
      const res = await t.signIn(b, 'google', claims, '/result?tab=rules');

      expect(res.status).toBe(302);
      expect(res.location!.origin).toBe(WEB_ORIGIN);
      expect(res.location!.pathname + res.location!.search).toBe('/result?tab=rules');

      const sid = flowCookie(res.setCookies, 'sid');
      expect(sid).toMatch(/HttpOnly/i);
      expect(sid).toMatch(/SameSite=Lax/i);
      expect(sid).toMatch(/Path=\/;/);
      expect(sid).toMatch(/Max-Age=2592000/);
      expect(sid).not.toMatch(/Secure/i);
      // The flow cookie is spent.
      expect(b.cookie('flow_google')).toBeUndefined();
      expect(issuer.tokenRequests.at(-1)).toMatchObject({ name: 'google', ok: true });

      const users = await t.users();
      expect(users).toHaveLength(1);
      expect(users[0]).toMatchObject({
        tier: 'registered',
        name: 'Gina Google',
        avatarUrl: 'https://example.com/g.png',
        identities: [{ provider: 'google', subject: claims.sub, email: 'gina@example.com', emailVerified: true }],
      });
      expect(users[0]!.identities[0]!.tenantId).toBeUndefined();

      const body = await me(b);
      expect(body.user).toMatchObject({
        id: users[0]!._id!.toHexString(),
        name: 'Gina Google',
        email: 'gina@example.com',
        tier: 'registered',
        providers: ['google'],
        isAdmin: false,
        uiLanguage: null,
      });
      expect(await t.sessionCount()).toBe(1);
    });

    it('a second sign-in with the same identity finds the same user, and rotates the session', async () => {
      const t = await setup();
      const claims = googleClaims();
      const first = t.browser();
      await t.signIn(first, 'google', claims);
      const userId = (await me(first)).user!.id;
      const firstSid = first.cookie('sid')!;

      // The same person signs in again from the same browser: a new session id, the old one is dead.
      await t.signIn(first, 'google', claims);
      expect(first.cookie('sid')).not.toBe(firstSid);
      expect((await me(first)).user!.id).toBe(userId);
      const old = t.browser();
      old.jar.set('sid', firstSid);
      expect((await me(old)).user).toBeNull();
      expect(await t.sessionCount()).toBe(1);

      // ...and from another browser.
      const second = t.browser();
      await t.signIn(second, 'google', claims);
      expect((await me(second)).user!.id).toBe(userId);
      expect(await t.users()).toHaveLength(1);
      expect(await t.sessionCount()).toBe(2);
    });

    it('refreshes the identity on every sign-in (a changed email or a lost verification counts at once)', async () => {
      const t = await setup();
      const claims = googleClaims({ email: 'boss@example.com' }); // an ADMIN_EMAILS entry
      const b = t.browser();
      await t.signIn(b, 'google', claims);
      expect((await me(b)).user!.isAdmin).toBe(true);
      await t.signIn(b, 'google', { ...claims, email_verified: false });
      expect((await me(b)).user!.isAdmin).toBe(false);
      expect((await t.users())[0]!.identities[0]!.emailVerified).toBe(false);
    });

    it('identifies a Microsoft user by tenant id + object id, not by sub or email', async () => {
      const t = await setup();
      const claims = microsoftClaims({ tid: 'tenant-A', oid: 'oid-1', email: 'max@corp.example' });
      const b = t.browser();
      await t.signIn(b, 'microsoft', claims);
      const users = await t.users();
      expect(users[0]!.identities).toEqual([
        { provider: 'microsoft', subject: 'oid-1', tenantId: 'tenant-A', email: 'max@corp.example', emailVerified: false },
      ]);
      const userId = (await me(b)).user!.id;

      // Same tid + oid, another `sub` (Microsoft's sub is per application) and another email: the same user.
      const again = t.browser();
      await t.signIn(again, 'microsoft', { ...claims, sub: 'another-sub', email: 'new-name@corp.example' });
      expect((await me(again)).user!.id).toBe(userId);
      expect(await t.users()).toHaveLength(1);
      expect((await t.users())[0]!.identities[0]!.email).toBe('new-name@corp.example');

      // The same oid in another tenant is not the same account. (It never happens - object ids are GUIDs - and
      // the unique index is on provider + subject, so it is refused rather than created; it must never be merged.)
      const other = t.browser();
      const res = await t.signIn(other, 'microsoft', { ...claims, tid: 'tenant-B' });
      expect(res.location!.searchParams.get('authError')).toBe('failed');
      expect((await me(other)).user).toBeNull();
      expect(await t.users()).toHaveLength(1);
    });

    it('a Microsoft ID token without tid or oid signs nobody in', async () => {
      const t = await setup();
      const b = t.browser();
      const res = await t.signIn(b, 'microsoft', { sub: 'only-a-sub', email: 'x@example.com' });
      expect(res.location!.searchParams.get('authError')).toBe('failed');
      expect(b.cookie('sid')).toBeUndefined();
      expect(await t.users()).toHaveLength(0);
    });

    it('never merges accounts by email: the same email at another provider or subject is a different user', async () => {
      const t = await setup();
      const email = 'same.person@example.com';
      const google = t.browser();
      const microsoft = t.browser();
      const otherGoogle = t.browser();
      await t.signIn(google, 'google', googleClaims({ email, email_verified: true }));
      await t.signIn(microsoft, 'microsoft', microsoftClaims({ email }));
      await t.signIn(otherGoogle, 'google', googleClaims({ email, email_verified: true })); // another Google account

      const ids = new Set([(await me(google)).user!.id, (await me(microsoft)).user!.id, (await me(otherGoogle)).user!.id]);
      expect(ids.size).toBe(3);
      expect(await t.users()).toHaveLength(3);
      expect((await me(google)).user!.providers).toEqual(['google']);
      expect((await me(microsoft)).user!.providers).toEqual(['microsoft']);
    });

    it('sets no session and creates no user on any failure', async () => {
      const t = await setup();
      const b = t.browser();

      // no flow cookie at all
      let res = await b.get('/api/auth/google/callback?code=c&state=s');
      expect(res.location!.searchParams.get('authError')).toBe('expired');

      // a forged flow cookie
      b.jar.set('flow_google', 'eyJmb28iOiJiYXIifQ.forged');
      res = await b.get('/api/auth/google/callback?code=c&state=s');
      expect(res.location!.searchParams.get('authError')).toBe('expired');

      // declined at the provider
      let start = await b.get('/api/auth/google/start?returnTo=/result');
      res = await b.get(issuer.deny(start.location!.href));
      expect(res.location!.searchParams.get('authError')).toBe('denied');
      expect(res.location!.pathname).toBe('/result');

      // a state that isn't the one we sent (login CSRF)
      start = await b.get('/api/auth/google/start');
      const back = new URL(issuer.approve(start.location!.href, googleClaims()), API_BASE);
      back.searchParams.set('state', 'attacker-chosen-state');
      res = await b.get(back.pathname + back.search);
      expect(res.location!.searchParams.get('authError')).toBe('failed');

      // an ID token with someone else's nonce (a replayed token)
      start = await b.get('/api/auth/google/start');
      issuer.wrongNonceOnce = true;
      res = await b.get(issuer.approve(start.location!.href, googleClaims()));
      expect(res.location!.searchParams.get('authError')).toBe('failed');

      // a callback that belongs to another provider's flow
      start = await b.get('/api/auth/google/start');
      res = await b.get(`/api/auth/microsoft/callback?code=c&state=${start.location!.searchParams.get('state')}`);
      expect(res.location!.searchParams.get('authError')).toBe('expired');

      expect(b.cookie('sid')).toBeUndefined();
      expect(await t.users()).toHaveLength(0);
      expect(await t.sessionCount()).toBe(0);
    });

    it('a code works once: replaying the callback with the same flow signs nobody in', async () => {
      const t = await setup();
      const b = t.browser();
      const start = await b.get('/api/auth/google/start');
      const callback = issuer.approve(start.location!.href, googleClaims());
      const flow = b.cookie('flow_google')!;
      expect((await b.get(callback)).location!.searchParams.get('authError')).toBeNull();
      const replayer = t.browser();
      replayer.jar.set('flow_google', flow);
      const res = await replayer.get(callback);
      expect(res.location!.searchParams.get('authError')).toBe('failed');
      expect(replayer.cookie('sid')).toBeUndefined();
      expect(await t.users()).toHaveLength(1);
    });

    it('rejects a flow older than ten minutes', async () => {
      const t = await setup();
      const b = t.browser();
      const start = await b.get('/api/auth/google/start');
      const callback = issuer.approve(start.location!.href, googleClaims());
      t.clock.current = new Date(t.clock.current.getTime() + 11 * 60_000);
      const res = await b.get(callback);
      expect(res.location!.searchParams.get('authError')).toBe('expired');
      expect(b.cookie('sid')).toBeUndefined();
    });

    it('a flow is single use', async () => {
      const t = await setup();
      const b = t.browser();
      const start = await b.get('/api/auth/google/start');
      const callback = issuer.approve(start.location!.href, googleClaims());
      expect((await b.get(callback)).location!.searchParams.get('authError')).toBeNull();
      // The cookie was cleared: the same callback again finds no flow.
      expect((await b.get(callback)).location!.searchParams.get('authError')).toBe('expired');
    });
  });

  describe('returnTo', () => {
    it.each([
      ['https://evil.example/steal', '/'],
      ['//evil.example', '/'],
      ['/\\evil.example', '/'],
      ['javascript:alert(1)', '/'],
      ['/ok/../fine?x=1', '/fine?x=1'],
      ['/result#rules', '/result#rules'],
      ['/result\r\nSet-Cookie: x=y', '/'],
    ])('lands on %j as %j - never on another site', async (returnTo, expected) => {
      const t = await setup();
      const b = t.browser();
      const res = await t.signIn(b, 'google', googleClaims(), returnTo);
      expect(res.status).toBe(302);
      expect(res.location!.origin).toBe(WEB_ORIGIN);
      expect(res.location!.pathname + res.location!.search + res.location!.hash).toBe(expected);
    });

    it('failure redirects stay on the web app too', async () => {
      const t = await setup();
      const b = t.browser();
      const start = await b.get(`/api/auth/google/start?returnTo=${encodeURIComponent('https://evil.example/')}`);
      const res = await b.get(issuer.deny(start.location!.href));
      expect(res.location!.origin).toBe(WEB_ORIGIN);
      expect(res.location!.searchParams.get('authError')).toBe('denied');
    });
  });

  // ---------- logout, /api/me ----------

  describe('POST /api/auth/logout', () => {
    it('ends the session and clears the cookie', async () => {
      const t = await setup();
      const b = t.browser();
      await t.signIn(b, 'google', googleClaims());
      const sid = b.cookie('sid')!;
      expect(await t.sessionCount()).toBe(1);

      const res = await b.post('/api/auth/logout');
      expect(res.status).toBe(200);
      expect(res.json()).toEqual({ ok: true });
      expect(b.cookie('sid')).toBeUndefined();
      expect(await t.sessionCount()).toBe(0);
      expect((await me(b)).user).toBeNull();

      // The old cookie no longer works, even when replayed.
      const replay = t.browser();
      replay.jar.set('sid', sid);
      expect((await me(replay)).user).toBeNull();
    });

    it('is fine without a session', async () => {
      const t = await setup();
      const res = await t.browser().post('/api/auth/logout');
      expect(res.status).toBe(200);
    });

    it('refuses a browser request that names another origin, and keeps the session', async () => {
      const t = await setup();
      const b = t.browser();
      await t.signIn(b, 'google', googleClaims());
      const res = await b.post('/api/auth/logout', undefined, { origin: 'https://evil.example' });
      expect(res.status).toBe(403);
      expect((await me(b)).user).not.toBeNull();
      expect((await b.post('/api/auth/logout', undefined, { origin: WEB_ORIGIN })).status).toBe(200);
    });
  });

  describe('GET /api/me and PATCH /api/me', () => {
    it('is { user: null } when signed out, and never cached', async () => {
      const t = await setup();
      const res = await t.browser().get('/api/me');
      expect(res.json()).toEqual({ user: null });
      expect(res.raw.headers['cache-control']).toBe('no-store');
    });

    it('has no email property when the provider gave none', async () => {
      const t = await setup();
      const noEmail = t.browser();
      await t.signIn(noEmail, 'google', { sub: 'no-email-sub' });
      expect((await me(noEmail)).user).not.toHaveProperty('email');
    });

    it('saves the UI language (and nothing else)', async () => {
      const t = await setup();
      const b = t.browser();
      await t.signIn(b, 'google', googleClaims());
      const res = await b.patch('/api/me', { uiLanguage: 'he' });
      expect(res.status).toBe(200);
      expect((res.json() as MeResponse).user!.uiLanguage).toBe('he');
      expect((await me(b)).user!.uiLanguage).toBe('he');

      for (const bad of [{ uiLanguage: 'fr' }, { uiLanguage: 'en', tier: 'paid' }, { tier: 'paid' }, {}, [], { uiLanguage: 1 }]) {
        expect((await b.patch('/api/me', bad)).status).toBe(400);
      }
      expect((await me(b)).user).toMatchObject({ uiLanguage: 'he', tier: 'registered' });
    });

    it('needs a session', async () => {
      const t = await setup();
      const res = await t.browser().patch('/api/me', { uiLanguage: 'he' });
      expect(res.status).toBe(401);
    });
  });

  // ---------- sessions ----------

  describe('session cookie', () => {
    it('ignores a forged or foreign cookie', async () => {
      const t = await setup();
      const b = t.browser();
      await t.signIn(b, 'google', googleClaims());
      const sid = b.cookie('sid')!;
      const [id] = sid.split('.');

      for (const bad of ['garbage', `${id}.AAAA`, `${id}`, 'x.y.z', `${id}.${sid.split('.')[1]!.split('').reverse().join('')}`]) {
        const c = t.browser();
        c.jar.set('sid', bad);
        expect((await me(c)).user).toBeNull();
      }
    });

    it('is not accepted when signed with another secret', async () => {
      const t = await setup();
      const b = t.browser();
      await t.signIn(b, 'google', googleClaims());
      const other = await createAuthHarness(kit, issuer, { env: { SESSION_SECRET: 'a-different-secret-entirely' } });
      try {
        const c = other.browser();
        c.jar.set('sid', b.cookie('sid')!);
        expect((await me(c)).user).toBeNull();
      } finally {
        await other.close();
      }
    });

    it('expires after 30 days, and is renewed (cookie included) while in use', async () => {
      const t = await setup();
      const b = t.browser();
      await t.signIn(b, 'google', googleClaims());

      // Within the renewal interval: nothing is rewritten.
      t.clock.current = new Date(t.clock.current.getTime() + 10 * 60_000);
      expect((await b.get('/api/me')).setCookies.some((c) => c.startsWith('sid='))).toBe(false);

      // After it: the expiry slides and the cookie is refreshed.
      t.clock.current = new Date(t.clock.current.getTime() + 20 * DAY_MS);
      const renewed = await b.get('/api/me');
      expect((renewed.json() as MeResponse).user).not.toBeNull();
      expect(renewed.setCookies.some((c) => c.startsWith('sid='))).toBe(true);

      // 20 more days: without the renewal above the session would be 40 days old and gone; it is still alive.
      // 31 days after its last use it is gone.
      t.clock.current = new Date(t.clock.current.getTime() + 20 * DAY_MS);
      expect((await me(b)).user).not.toBeNull();
      t.clock.current = new Date(t.clock.current.getTime() + 31 * DAY_MS);
      const gone = await b.get('/api/me');
      expect((gone.json() as MeResponse).user).toBeNull();
      expect(b.cookie('sid')).toBeUndefined();
    });
  });

  // ---------- identityOf, tier, admin ----------

  describe('identityOf(req)', () => {
    // (The harness mounts a probe at /api/__identity that returns what identityOf(req) resolves.)
    it('is the anonymous visitor without a session', async () => {
      const t = await setup();
      const b = t.browser();
      const res = await b.get('/api/__identity');
      expect(res.json()).toEqual({ kind: 'anon', anonId: b.cookie('anonId') });
    });

    it('resolves the session to { userId, tier, anonId, isAdmin }, and follows a tier change at once', async () => {
      const t = await setup();
      const b = t.browser();
      await b.get('/api/session'); // gets the anonId cookie
      await t.signIn(b, 'google', googleClaims());
      const userId = (await me(b)).user!.id;

      expect((await b.get('/api/__identity')).json()).toEqual({
        kind: 'user',
        userId,
        tier: 'registered',
        anonId: b.cookie('anonId'),
        isAdmin: false,
      });

      // An admin sets the tier (M4): the very next request sees it.
      await t.setTier(userId, 'paid');
      expect((await b.get('/api/__identity')).json()).toMatchObject({ kind: 'user', userId, tier: 'paid' });
      expect((await me(b)).user!.tier).toBe('paid');

      // Signed out again: anonymous, same anonId.
      await b.post('/api/auth/logout');
      expect((await b.get('/api/__identity')).json()).toEqual({ kind: 'anon', anonId: b.cookie('anonId') });
    });
  });

  describe('admin (ADMIN_EMAILS / MICROSOFT_ADMIN_OIDS)', () => {
    it('is a verified Google email on the allowlist (any case)', async () => {
      const t = await setup();
      const admin = t.browser();
      await t.signIn(admin, 'google', googleClaims({ email: 'BOSS@example.COM', email_verified: true }));
      expect((await me(admin)).user!.isAdmin).toBe(true);
      expect((await admin.get('/api/__identity')).json()).toMatchObject({ isAdmin: true });

      const second = t.browser();
      await t.signIn(second, 'google', googleClaims({ email: 'other-admin@example.com', email_verified: true }));
      expect((await me(second)).user!.isAdmin).toBe(true);
    });

    it('is not an unverified Google email, nor an email that is only on Microsoft', async () => {
      const t = await setup();
      const unverified = t.browser();
      await t.signIn(unverified, 'google', googleClaims({ email: 'boss@example.com', email_verified: false }));
      expect((await me(unverified)).user!.isAdmin).toBe(false);

      // Microsoft does not verify the email claim: it must never grant admin.
      const ms = t.browser();
      await t.signIn(ms, 'microsoft', microsoftClaims({ email: 'boss@example.com' }));
      expect((await me(ms)).user!.isAdmin).toBe(false);
      const msVerified = t.browser();
      await t.signIn(msVerified, 'microsoft', microsoftClaims({ email: 'boss@example.com', email_verified: true }));
      expect((await me(msVerified)).user!.isAdmin).toBe(false);
    });

    it('is a configured Microsoft object id', async () => {
      const t = await setup();
      const b = t.browser();
      await t.signIn(b, 'microsoft', microsoftClaims({ oid: 'ms-admin-oid' }));
      expect((await me(b)).user!.isAdmin).toBe(true);
      const c = t.browser();
      await t.signIn(c, 'microsoft', microsoftClaims({ oid: 'someone-else' }));
      expect((await me(c)).user!.isAdmin).toBe(false);
    });

    it('nobody is admin when the lists are empty', async () => {
      const t = await setup({ env: { ADMIN_EMAILS: undefined, MICROSOFT_ADMIN_OIDS: undefined } });
      const b = t.browser();
      await t.signIn(b, 'google', googleClaims({ email: 'boss@example.com' }));
      expect((await me(b)).user!.isAdmin).toBe(false);
    });
  });

  // ---------- linking a second provider ----------

  describe('linking a second provider', () => {
    it('adds the identity to the signed-in user, and either provider then signs in as that user', async () => {
      const t = await setup();
      const b = t.browser();
      await t.signIn(b, 'google', googleClaims());
      const userId = (await me(b)).user!.id;

      const start = await b.post('/api/me/link/microsoft/start', { returnTo: '/settings' });
      expect(start.status).toBe(200);
      const { url } = start.json() as { url: string };
      expect(new URL(url).pathname).toBe('/microsoft/authorize');
      expect(new URL(url).searchParams.get('prompt')).toBe('select_account');
      expect(flowCookie(start.setCookies, 'flow_microsoft')).toMatch(/HttpOnly/i);

      const claims = microsoftClaims({ tid: 'tenant-A', oid: 'linked-oid' });
      const back = await b.get(issuer.approve(url, claims));
      expect(back.status).toBe(302);
      expect(back.location!.pathname).toBe('/settings');
      expect(back.location!.searchParams.get('linked')).toBe('microsoft');
      expect(back.location!.searchParams.get('authError')).toBeNull();

      const body = await me(b);
      expect(body.user!.id).toBe(userId);
      expect(body.user!.providers).toEqual(['google', 'microsoft']);
      const users = await t.users();
      expect(users).toHaveLength(1);
      expect(users[0]!.identities[1]).toMatchObject({ provider: 'microsoft', subject: 'linked-oid', tenantId: 'tenant-A' });
      // The session was kept (linking is not a sign-in).
      expect(await t.sessionCount()).toBe(1);

      // Signing in with the linked provider is the same user.
      const other = t.browser();
      await t.signIn(other, 'microsoft', claims);
      expect((await me(other)).user!.id).toBe(userId);
      expect(await t.users()).toHaveLength(1);
    });

    it('is refused when that identity already belongs to another user', async () => {
      const t = await setup();
      const msClaims = microsoftClaims();
      const owner = t.browser();
      await t.signIn(owner, 'microsoft', msClaims);
      const ownerId = (await me(owner)).user!.id;

      const b = t.browser();
      await t.signIn(b, 'google', googleClaims());
      const userId = (await me(b)).user!.id;
      const { url } = (await b.post('/api/me/link/microsoft/start')).json() as { url: string };
      const back = await b.get(issuer.approve(url, msClaims));
      expect(back.location!.searchParams.get('authError')).toBe('identityInUse');
      expect(back.location!.searchParams.get('linked')).toBeNull();

      expect((await me(b)).user!.providers).toEqual(['google']);
      expect((await me(owner)).user!.providers).toEqual(['microsoft']);
      expect((await me(owner)).user!.id).toBe(ownerId);
      expect((await me(b)).user!.id).toBe(userId);
      expect(await t.users()).toHaveLength(2);
    });

    it('is refused when the user already has an account of that provider', async () => {
      const t = await setup();
      const b = t.browser();
      await t.signIn(b, 'google', googleClaims());
      const res = await b.post('/api/me/link/google/start');
      expect(res.status).toBe(409);
      expect(res.json()).toEqual({ error: 'providerLinked' });
    });

    it('needs a session, a configured provider, and the same user coming back', async () => {
      const t = await setup({ providers: ['google', 'microsoft'] });
      expect((await t.browser().post('/api/me/link/microsoft/start')).status).toBe(401);

      const b = t.browser();
      await t.signIn(b, 'google', googleClaims());
      expect((await b.post('/api/me/link/github/start')).status).toBe(404);
      expect((await b.post('/api/me/link/microsoft/start', undefined, { origin: 'https://evil.example' })).status).toBe(403);

      // Someone else signs in on this browser while the provider page is open: the link must not attach to them.
      const { url } = (await b.post('/api/me/link/microsoft/start')).json() as { url: string };
      const callback = issuer.approve(url, microsoftClaims());
      const flow = b.cookie('flow_microsoft')!;
      await t.signIn(b, 'google', googleClaims()); // a different Google account: session is now user 2
      b.jar.set('flow_microsoft', flow);
      const back = await b.get(callback);
      expect(back.location!.searchParams.get('authError')).toBe('sessionMismatch');
      expect((await me(b)).user!.providers).toEqual(['google']);

      // ...and without any session at all.
      const anon = t.browser();
      anon.jar.set('flow_microsoft', flow);
      expect((await anon.get(issuer.approve(url, microsoftClaims()))).location!.searchParams.get('authError')).toBe('sessionMismatch');
    });
  });

  // ---------- anonymous visitor -> user ----------

  describe('attaching the anonymous visitor at sign-in (SPEC 12)', () => {
    it('gives the anonId its past events, re-owns its cache, and keeps the anonId on the user', async () => {
      const t = await setup();
      const b = t.browser();
      await b.get('/api/session');
      const anonId = b.cookie('anonId')!;

      const someoneElse = new ObjectId();
      await t.authStore.insertEvent({ ts: new Date(), anonId, type: 'file_uploaded', props: { rows: 3 } });
      await t.authStore.insertEvent({ ts: new Date(), anonId, type: 'preview_shown', props: {} });
      await t.authStore.insertEvent({ ts: new Date(), anonId: 'another-anon-0123456789', type: 'page_view', props: {} });
      await t.authStore.insertEvent({ ts: new Date(), anonId, userId: someoneElse, type: 'page_view', props: {} });
      await t.putCache(`anon:${anonId}`, 'structure-1');
      await t.putCache(`anon:${anonId}`, 'structure-2');
      await t.putCache('anon:another-anon-0123456789', 'structure-1');

      await t.signIn(b, 'google', googleClaims(), '/result');
      const user = (await t.users())[0]!;
      const userId = user._id!;

      expect(user.anonIds).toEqual([anonId]);
      const events = await t.events();
      const byType = (type: string) => events.filter((e) => e.type === type);
      expect(byType('file_uploaded')[0]!.userId?.equals(userId)).toBe(true);
      expect(byType('preview_shown')[0]!.userId?.equals(userId)).toBe(true);
      // Other visitors' events, and events that already belong to a user, are left alone.
      expect(events.find((e) => e.anonId === 'another-anon-0123456789')!.userId).toBeUndefined();
      expect(events.find((e) => e.userId?.equals(someoneElse))!.anonId).toBe(anonId);
      // The sign-up itself is an event, owned by the new user.
      expect(byType('signed_up')).toHaveLength(1);
      expect(byType('signed_up')[0]).toMatchObject({ anonId, props: { provider: 'google' } });
      expect(byType('signed_up')[0]!.userId?.equals(userId)).toBe(true);

      // The learn cache follows the person, and only their own entries.
      expect(await t.hasCache(`user:${userId.toHexString()}`, 'structure-1')).toBe(true);
      expect(await t.hasCache(`user:${userId.toHexString()}`, 'structure-2')).toBe(true);
      expect(await t.hasCache(`anon:${anonId}`, 'structure-1')).toBe(false);
      expect(await t.hasCache(`anon:${anonId}`, 'structure-2')).toBe(false);
      expect(await t.hasCache('anon:another-anon-0123456789', 'structure-1')).toBe(true);
    });

    it('on a later sign-in from another browser, attaches that browser too (the user\'s own cache entry wins)', async () => {
      const t = await setup();
      const claims = googleClaims();
      const first = t.browser();
      await t.signIn(first, 'google', claims);
      const userId = (await t.users())[0]!._id!.toHexString();
      await t.putCache(`user:${userId}`, 'shared-structure');

      const second = t.browser();
      await second.get('/api/session');
      const anon2 = second.cookie('anonId')!;
      await t.authStore.insertEvent({ ts: new Date(), anonId: anon2, type: 'file_uploaded', props: {} });
      await t.putCache(`anon:${anon2}`, 'shared-structure'); // same structure the user already has
      await t.putCache(`anon:${anon2}`, 'new-structure');

      await t.signIn(second, 'google', claims);
      const user = (await t.users())[0]!;
      expect(user.anonIds).toContain(anon2);
      expect(user.anonIds).toHaveLength(2);
      expect((await t.events()).find((e) => e.type === 'file_uploaded')!.userId?.toHexString()).toBe(userId);
      expect(await t.hasCache(`user:${userId}`, 'new-structure')).toBe(true);
      expect(await t.hasCache(`anon:${anon2}`, 'shared-structure')).toBe(false);
      expect(await t.hasCache(`anon:${anon2}`, 'new-structure')).toBe(false);
      expect((await t.events()).filter((e) => e.type === 'signed_in')).toHaveLength(1);
    });

    it('a failed sign-in attaches nothing', async () => {
      const t = await setup();
      const b = t.browser();
      await b.get('/api/session');
      const anonId = b.cookie('anonId')!;
      await t.authStore.insertEvent({ ts: new Date(), anonId, type: 'file_uploaded', props: {} });
      const start = await b.get('/api/auth/google/start');
      await b.get(issuer.deny(start.location!.href));
      expect((await t.events())[0]!.userId).toBeUndefined();
    });
  });

  // ---------- production ----------

  describe('production', () => {
    it('marks the flow and session cookies Secure', async () => {
      const t = await setup({ production: true });
      const b = t.browser();
      const start = await b.get('/api/auth/google/start');
      expect(flowCookie(start.setCookies, 'flow_google')).toMatch(/Secure/i);
      expect(start.location!.searchParams.get('redirect_uri')).toBe('https://api.example.test/api/auth/google/callback');
      const res = await b.get(issuer.approve(start.location!.href, googleClaims()));
      expect(res.location!.searchParams.get('authError')).toBeNull();
      const sid = flowCookie(res.setCookies, 'sid');
      expect(sid).toMatch(/Secure/i);
      expect(sid).toMatch(/HttpOnly/i);
      expect(sid).toMatch(/SameSite=Lax/i);
    });
  });
}

describe('sign-in (in-memory stores)', () => defineAuthSuite(memoryKit));
describe.skipIf(!mongoUri)('sign-in (MongoDB)', () => defineAuthSuite(mongoKit()));

describe('sign-in startup requirements', () => {
  const base = { NODE_ENV: 'production', TURNSTILE_SECRET_KEY: 'ts', IP_HASH_SECRET: 'ip-secret' };
  const build = (env: Record<string, string | undefined>) =>
    buildServer({ env: makeEnv({ ...base, ...env }), db: null, logger: false, store: createMemoryStore() });

  it('refuses to start in production without SESSION_SECRET', async () => {
    await expect(build({})).rejects.toThrow(/SESSION_SECRET/);
  });

  it('refuses to start in production with a provider but without API_PUBLIC_URL', async () => {
    await expect(build({ SESSION_SECRET: 's', GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'secret' })).rejects.toThrow(
      /API_PUBLIC_URL/,
    );
  });

  it('refuses to start in production without a database (users and sessions live there)', async () => {
    await expect(
      buildServer({ env: makeEnv({ ...base, SESSION_SECRET: 's' }), db: null, logger: false }),
    ).rejects.toThrow(/MONGODB_URI/);
  });

  it('a provider is offered only when both its id and secret are set', async () => {
    const app = await buildServer({
      env: makeEnv({ GOOGLE_CLIENT_ID: 'id-only', GOOGLE_CLIENT_SECRET: undefined, MICROSOFT_CLIENT_ID: 'id', MICROSOFT_CLIENT_SECRET: 'secret' }),
      db: null,
      logger: false,
    });
    try {
      const res = await app.inject({ method: 'GET', url: '/api/auth/providers' });
      expect(res.json()).toEqual({ providers: ['microsoft'] });
    } finally {
      await app.close();
    }
  });
});
