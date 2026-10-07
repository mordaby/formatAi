// The development-only session helper (POST /api/dev/session) and the small quota read the account menu uses
// (GET /api/learn/quota). In-memory stores only; no real provider is involved.
import type { LearnQuotaResponse, MeResponse } from '@formatai/shared';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { FakeIssuer } from './fakeIssuer.js';
import { createAuthHarness, memoryKit, startTestIssuer, WEB_ORIGIN, type AuthHarness } from './harness.js';

describe('POST /api/dev/session (development only)', () => {
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

  it('signs the caller in as a new test user, whose email is under the reserved .test domain', async () => {
    h = await createAuthHarness(memoryKit, issuer);
    const b = h.browser();
    expect(((await b.get('/api/me')).json() as MeResponse).user).toBeNull();

    const res = await b.post('/api/dev/session', { name: 'Test Person' });
    expect(res.status).toBe(200);
    const me = (await b.get('/api/me')).json() as MeResponse;
    expect(me.user).toMatchObject({ name: 'Test Person', tier: 'registered', providers: ['google'], isAdmin: false });
    expect(me.user!.email).toMatch(/^dev-[0-9a-f]+@example\.test$/);
  });

  it('can make a paid test user', async () => {
    h = await createAuthHarness(memoryKit, issuer);
    const b = h.browser();
    await b.post('/api/dev/session', { tier: 'paid' });
    expect(((await b.get('/api/me')).json() as MeResponse).user?.tier).toBe('paid');
  });

  it('refuses a call that names a foreign Origin', async () => {
    h = await createAuthHarness(memoryKit, issuer);
    const res = await h.browser().post('/api/dev/session', {}, { origin: 'https://evil.example' });
    expect(res.status).toBe(403);
    expect(await h.sessionCount()).toBe(0);
  });

  it('accepts the web app origin', async () => {
    h = await createAuthHarness(memoryKit, issuer);
    const res = await h.browser().post('/api/dev/session', {}, { origin: WEB_ORIGIN });
    expect(res.status).toBe(200);
  });

  it('API audit: does not exist when the web app is reached at a public origin (a deploy without NODE_ENV=production) - unless DEV_SIGN_IN=true', async () => {
    h = await createAuthHarness(memoryKit, issuer, { env: { WEB_ORIGIN: 'https://formatai.example.com' } });
    expect((await h.browser().post('/api/dev/session', {})).status).toBe(404);
    await h.close();
    h = await createAuthHarness(memoryKit, issuer, { env: { WEB_ORIGIN: 'http://localhost:5173', API_PUBLIC_URL: 'https://formatai.example.com' } });
    expect((await h.browser().post('/api/dev/session', {})).status).toBe(404);
    await h.close();
    h = await createAuthHarness(memoryKit, issuer, { env: { WEB_ORIGIN: 'https://formatai.example.com', DEV_SIGN_IN: 'true' } });
    expect((await h.browser().post('/api/dev/session', {}, { origin: 'https://formatai.example.com' })).status).toBe(200);
    expect(await h.sessionCount()).toBe(1);
  });

  it('does not exist in a production process', async () => {
    h = await createAuthHarness(memoryKit, issuer, { production: true });
    const res = await h.browser().post('/api/dev/session', {});
    expect(res.status).toBe(404);
    expect(await h.sessionCount()).toBe(0);
  });
});

describe('GET /api/learn/quota', () => {
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

  it('tells a signed-in user what is left of their AI learns, and an anonymous visitor to sign in', async () => {
    h = await createAuthHarness(memoryKit, issuer);
    const b = h.browser();
    const anon = await b.get('/api/learn/quota');
    expect(anon.status).toBe(403);
    expect(anon.json()).toEqual({ error: 'signInForAi' });

    await b.post('/api/dev/session', {});
    const res = await b.get('/api/learn/quota');
    expect(res.status).toBe(200);
    const body = res.json() as LearnQuotaResponse;
    expect(body.quota.period).toBe('month');
    expect(body.quota.remaining).toBe(3);
  });
});
