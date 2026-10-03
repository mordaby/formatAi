// The pure parts of sign-in: signed values, the flow cookie, returnTo, the provider table and identity
// mapping, and admin detection. No server, no database.
import { describe, expect, it } from 'vitest';
import { isAdmin, loadAdminConfig } from '../../src/auth/admin.js';
import { googleIdentity, loadProviders, microsoftIdentity, PROVIDER_TABLE } from '../../src/auth/providers.js';
import { redirectTarget, safeReturnTo } from '../../src/auth/returnTo.js';
import { decodeFlow, encodeFlow, hashToken, randomToken, signValue, verifyValue, type FlowState } from '../../src/auth/signing.js';
import { sameIdentity, toUserIdentity } from '../../src/auth/store.js';
import { loadEnv } from '../../src/env.js';
import type { UserIdentity } from '../../src/models.js';

const SECRET = 'unit-test-secret';

describe('signed values', () => {
  it('round-trips, and rejects tampering, another purpose, another secret and garbage', () => {
    const signed = signValue(SECRET, 'session', 'abc123');
    expect(verifyValue(SECRET, 'session', signed)).toBe('abc123');
    expect(verifyValue(SECRET, 'flow', signed)).toBeNull(); // a session id is not a flow cookie
    expect(verifyValue('other-secret', 'session', signed)).toBeNull();
    expect(verifyValue(SECRET, 'session', signed.replace('abc123', 'abc124'))).toBeNull();
    expect(verifyValue(SECRET, 'session', `${signed}x`)).toBeNull();
    for (const bad of ['', '.', 'abc', 'abc.', '.abc', undefined, null, 42, {}]) {
      expect(verifyValue(SECRET, 'session', bad)).toBeNull();
    }
  });

  it('random tokens are long and distinct, and hash to a stable digest', () => {
    const a = randomToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(randomToken()).not.toBe(a);
    expect(hashToken(a)).toBe(hashToken(a));
    expect(hashToken(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken(a)).not.toBe(hashToken(`${a}x`));
  });
});

describe('the sign-in flow cookie', () => {
  const flow: FlowState = {
    provider: 'google',
    mode: 'signin',
    state: 's',
    nonce: 'n',
    codeVerifier: 'v',
    returnTo: '/result',
    expiresAt: 10_000,
  };

  it('round-trips until it expires', () => {
    const cookie = encodeFlow(SECRET, flow);
    expect(decodeFlow(SECRET, cookie, 9_999)).toEqual(flow);
    expect(decodeFlow(SECRET, cookie, 10_000)).toBeNull();
  });

  it('rejects a forged, re-signed-with-another-secret or malformed cookie', () => {
    const cookie = encodeFlow(SECRET, flow);
    expect(decodeFlow('other', cookie, 0)).toBeNull();
    // The payload edited (returnTo pointing elsewhere) with the old MAC.
    const [payload, mac] = cookie.split('.') as [string, string];
    const edited = Buffer.from(JSON.stringify({ ...flow, returnTo: '/evil' })).toString('base64url');
    expect(decodeFlow(SECRET, `${edited}.${mac}`, 0)).toBeNull();
    expect(decodeFlow(SECRET, `${payload}.${mac}`, 0)).toEqual(flow);
    // A validly signed value that is not a flow.
    expect(decodeFlow(SECRET, signValue(SECRET, 'flow', Buffer.from('{"x":1}').toString('base64url')), 0)).toBeNull();
    expect(decodeFlow(SECRET, signValue(SECRET, 'flow', 'not-base64-json'), 0)).toBeNull();
    // A session cookie signed with the same secret is not a flow.
    expect(decodeFlow(SECRET, signValue(SECRET, 'session', Buffer.from(JSON.stringify(flow)).toString('base64url')), 0)).toBeNull();
  });
});

describe('safeReturnTo', () => {
  it.each([
    ['/', '/'],
    ['/result', '/result'],
    ['/result?tab=rules&x=1', '/result?tab=rules&x=1'],
    ['/formats/abc#section', '/formats/abc#section'],
    ['/a/../b', '/b'],
    ['/a b', '/a%20b'],
  ])('keeps the relative path %j as %j', (raw, expected) => {
    expect(safeReturnTo(raw)).toBe(expected);
  });

  it.each([
    undefined,
    null,
    42,
    ['/a'],
    '',
    'result',
    'https://evil.example/',
    'http://evil.example',
    '//evil.example',
    '//evil.example/path',
    '/\\evil.example',
    '\\\\evil.example',
    '/..//evil.example',
    'javascript:alert(1)',
    'data:text/html,x',
    '/x\r\nSet-Cookie: a=b',
    '/x\u0000',
    `/${'a'.repeat(600)}`,
  ])('falls back to / for %j', (raw) => {
    expect(safeReturnTo(raw)).toBe('/');
  });

  it('does not let a path that normalises to a network-path reference through', () => {
    // "/.//evil.example" normalises to "//evil.example", which a browser resolves against another host.
    expect(safeReturnTo('/.//evil.example')).not.toMatch(/^\/\//);
    expect(safeReturnTo('/..//evil.example')).not.toMatch(/^\/\//);
  });

  it('builds the redirect on the web origin with a result code', () => {
    expect(redirectTarget('http://localhost:5173', '/result?a=1', ['authError', 'denied'])).toBe(
      'http://localhost:5173/result?a=1&authError=denied',
    );
    expect(redirectTarget('http://localhost:5173', '/', ['linked', 'microsoft'])).toBe('http://localhost:5173/?linked=microsoft');
    expect(redirectTarget('https://app.example.com', '/x')).toBe('https://app.example.com/x');
  });
});

describe('providers', () => {
  const env = (o: Record<string, string>) =>
    loadEnv({
      NODE_ENV: 'test',
      GOOGLE_CLIENT_ID: undefined,
      GOOGLE_CLIENT_SECRET: undefined,
      MICROSOFT_CLIENT_ID: undefined,
      MICROSOFT_CLIENT_SECRET: undefined,
      ...o,
    });

  it('offers only providers with both a client id and a secret, Google first', () => {
    expect(loadProviders(env({}))).toEqual([]);
    expect(loadProviders(env({ GOOGLE_CLIENT_ID: 'id' })).map((p) => p.id)).toEqual([]);
    expect(loadProviders(env({ MICROSOFT_CLIENT_ID: 'i', MICROSOFT_CLIENT_SECRET: 's' })).map((p) => p.id)).toEqual(['microsoft']);
    const both = loadProviders(
      env({ MICROSOFT_CLIENT_ID: 'mi', MICROSOFT_CLIENT_SECRET: 'ms', GOOGLE_CLIENT_ID: 'gi', GOOGLE_CLIENT_SECRET: 'gs' }),
    );
    expect(both.map((p) => p.id)).toEqual(['google', 'microsoft']);
    expect(both[0]).toMatchObject({ clientId: 'gi', clientSecret: 'gs', issuer: 'https://accounts.google.com' });
    expect(both[1]).toMatchObject({ clientId: 'mi', clientSecret: 'ms' });
  });

  it('uses the scopes openid, email, profile and the Microsoft `common` endpoint', () => {
    for (const spec of Object.values(PROVIDER_TABLE)) expect(spec.scopes).toEqual(['openid', 'email', 'profile']);
    expect(PROVIDER_TABLE.microsoft.issuer).toBe('https://login.microsoftonline.com/common/v2.0');
  });

  it('a Google identity is the sub; the email is verified only when Google says so', () => {
    expect(googleIdentity({ sub: '123', email: 'a@b.c', email_verified: true, name: 'A', picture: 'p' })).toEqual({
      provider: 'google',
      subject: '123',
      email: 'a@b.c',
      emailVerified: true,
      name: 'A',
      avatarUrl: 'p',
    });
    expect(googleIdentity({ sub: '123', email: 'a@b.c', email_verified: 'true' })?.emailVerified).toBe(true);
    expect(googleIdentity({ sub: '123', email: 'a@b.c', email_verified: false })?.emailVerified).toBe(false);
    expect(googleIdentity({ sub: '123', email: 'a@b.c' })?.emailVerified).toBe(false);
    expect(googleIdentity({ sub: '123' })?.email).toBe('');
    expect(googleIdentity({ email: 'a@b.c' })).toBeNull();
    expect(googleIdentity({ sub: '' })).toBeNull();
    expect(googleIdentity({ sub: 5 })).toBeNull();
  });

  it('a Microsoft identity is tid + oid (never sub or email), and its email is never verified by default', () => {
    expect(microsoftIdentity({ sub: 'app-scoped', tid: 'T', oid: 'O', email: 'x@corp.com', name: 'X' })).toEqual({
      provider: 'microsoft',
      subject: 'O',
      tenantId: 'T',
      email: 'x@corp.com',
      emailVerified: false,
      name: 'X',
    });
    expect(microsoftIdentity({ tid: 'T', oid: 'O', preferred_username: 'p@corp.com' })?.email).toBe('p@corp.com');
    expect(microsoftIdentity({ tid: 'T', oid: 'O', email: 'x@corp.com', email_verified: true })?.emailVerified).toBe(true);
    expect(microsoftIdentity({ sub: 's', oid: 'O' })).toBeNull(); // no tenant
    expect(microsoftIdentity({ sub: 's', tid: 'T' })).toBeNull(); // no object id
    expect(microsoftIdentity({ sub: 's', email: 'x@corp.com' })).toBeNull();
  });

  it('the same email under another provider, subject or tenant is another identity', () => {
    const g = toUserIdentity(googleIdentity({ sub: '1', email: 'same@x.com', email_verified: true })!);
    const g2 = toUserIdentity(googleIdentity({ sub: '2', email: 'same@x.com', email_verified: true })!);
    const m = toUserIdentity(microsoftIdentity({ tid: 'T', oid: '1', email: 'same@x.com' })!);
    const m2 = toUserIdentity(microsoftIdentity({ tid: 'U', oid: '1', email: 'same@x.com' })!);
    expect(sameIdentity(g, g)).toBe(true);
    expect(sameIdentity(g, g2)).toBe(false);
    expect(sameIdentity(g, m)).toBe(false); // same subject "1", another provider
    expect(sameIdentity(m, m2)).toBe(false); // same oid, another tenant
    expect(sameIdentity(m, { ...m, email: 'changed@x.com' })).toBe(true); // the email is not the identity
  });
});

describe('admin', () => {
  const env = (o: Record<string, string | undefined>) => loadEnv({ NODE_ENV: 'test', ADMIN_EMAILS: undefined, MICROSOFT_ADMIN_OIDS: undefined, ...o });
  const google = (email: string, emailVerified: boolean): UserIdentity => ({ provider: 'google', subject: 'g', email, emailVerified });
  const microsoft = (oid: string, tenantId: string, email = ''): UserIdentity => ({
    provider: 'microsoft',
    subject: oid,
    tenantId,
    email,
    emailVerified: false,
  });

  it('parses comma, semicolon and whitespace separated lists, case-insensitively', () => {
    const cfg = loadAdminConfig(env({ ADMIN_EMAILS: ' A@x.com,b@x.com ; C@X.com\nd@x.com ', MICROSOFT_ADMIN_OIDS: 'AAA-1, T1:BBB-2' }));
    expect([...cfg.emails].sort()).toEqual(['a@x.com', 'b@x.com', 'c@x.com', 'd@x.com']);
    expect([...cfg.microsoftOids].sort()).toEqual(['aaa-1', 't1:bbb-2']);
  });

  it('a verified Google email on the list is an admin', () => {
    const cfg = loadAdminConfig(env({ ADMIN_EMAILS: 'boss@x.com' }));
    expect(isAdmin([google('Boss@X.com', true)], cfg)).toBe(true);
    expect(isAdmin([google('boss@x.com', false)], cfg)).toBe(false);
    expect(isAdmin([google('someone@x.com', true)], cfg)).toBe(false);
    expect(isAdmin([google('', true)], cfg)).toBe(false);
  });

  it('a Microsoft email never makes an admin; a configured oid (or tid:oid) does', () => {
    const cfg = loadAdminConfig(env({ ADMIN_EMAILS: 'boss@x.com', MICROSOFT_ADMIN_OIDS: 'oid-1, tenant-9:oid-2' }));
    expect(isAdmin([microsoft('unlisted', 't', 'boss@x.com')], cfg)).toBe(false);
    expect(isAdmin([{ ...microsoft('unlisted', 't', 'boss@x.com'), emailVerified: true }], cfg)).toBe(false);
    expect(isAdmin([microsoft('OID-1', 'any-tenant')], cfg)).toBe(true);
    expect(isAdmin([microsoft('oid-2', 'tenant-9')], cfg)).toBe(true);
    expect(isAdmin([microsoft('oid-2', 'tenant-8')], cfg)).toBe(false); // tid:oid pins the tenant
  });

  it('any linked identity can grant it, and empty lists grant nobody', () => {
    const cfg = loadAdminConfig(env({ ADMIN_EMAILS: 'boss@x.com' }));
    expect(isAdmin([microsoft('o', 't'), google('boss@x.com', true)], cfg)).toBe(true);
    const none = loadAdminConfig(env({}));
    expect(isAdmin([google('boss@x.com', true), microsoft('o', 't')], none)).toBe(false);
  });
});
