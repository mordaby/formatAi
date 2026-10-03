// A local OpenID Connect issuer for tests: discovery, JWKS and a token endpoint that checks what a real
// provider checks (client secret, redirect URI, single-use code, PKCE S256) and signs real RS256 ID tokens.
// The sign-in code talks to it through the real openid-client, so nothing about the library is mocked.
// One server plays several providers (`/<name>/...`), each with its own client credentials.
import { createHash, createSign, generateKeyPairSync } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeClient {
  clientId: string;
  clientSecret: string;
}

interface PendingCode {
  name: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  nonce: string;
  claims: Record<string, unknown>;
}

export interface TokenRequestLog {
  name: string;
  ok: boolean;
  error?: string;
}

export interface FakeIssuer {
  origin: string;
  /** The issuer identifier of provider `name`. */
  issuerUrl(name: string): string;
  /**
   * The person approves at the provider: returns the path and query the browser is sent back to
   * (the redirect URI's path with `code` and `state`). `claims` become the ID token's claims.
   */
  approve(authorizationUrl: string, claims: Record<string, unknown>): string;
  /** The person declines: what the browser is sent back with. */
  deny(authorizationUrl: string): string;
  /** The next ID token carries this nonce instead of the one asked for (a replayed / injected token). */
  wrongNonceOnce: boolean;
  readonly tokenRequests: TokenRequestLog[];
  close(): Promise<void>;
}

const b64 = (input: Buffer | string): string => Buffer.from(input).toString('base64url');

export async function startFakeIssuer(clients: Record<string, FakeClient>): Promise<FakeIssuer> {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'test-key', alg: 'RS256', use: 'sig' };
  const codes = new Map<string, PendingCode>();
  const tokenRequests: TokenRequestLog[] = [];
  let counter = 0;

  let origin = '';
  const issuerUrl = (name: string): string => `${origin}/${name}`;

  const sign = (payload: Record<string, unknown>): string => {
    const head = b64(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'test-key' }));
    const body = b64(JSON.stringify(payload));
    const sig = createSign('RSA-SHA256').update(`${head}.${body}`).sign(privateKey);
    return `${head}.${body}.${b64(sig)}`;
  };

  const json = (res: ServerResponse, status: number, body: unknown): void => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };

  const readBody = async (req: IncomingMessage): Promise<URLSearchParams> => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', origin);
    const [, name = '', ...rest] = url.pathname.split('/');
    const client = clients[name];
    const endpoint = rest.join('/');
    if (!client) return json(res, 404, { error: 'unknown_issuer' });

    if (endpoint === '.well-known/openid-configuration') {
      return json(res, 200, {
        issuer: issuerUrl(name),
        authorization_endpoint: `${issuerUrl(name)}/authorize`,
        token_endpoint: `${issuerUrl(name)}/token`,
        jwks_uri: `${issuerUrl(name)}/jwks`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'],
      });
    }
    if (endpoint === 'jwks') return json(res, 200, { keys: [jwk] });

    if (endpoint === 'token' && req.method === 'POST') {
      const form = await readBody(req);
      const fail = (error: string): void => {
        tokenRequests.push({ name, ok: false, error });
        json(res, 400, { error });
      };
      const pending = codes.get(form.get('code') ?? '');
      codes.delete(form.get('code') ?? ''); // single use
      if (form.get('grant_type') !== 'authorization_code') return fail('unsupported_grant_type');
      if (form.get('client_id') !== client.clientId || form.get('client_secret') !== client.clientSecret) {
        return fail('invalid_client');
      }
      if (!pending || pending.name !== name) return fail('invalid_grant');
      if (form.get('redirect_uri') !== pending.redirectUri) return fail('redirect_uri_mismatch');
      const challenge = createHash('sha256')
        .update(form.get('code_verifier') ?? '')
        .digest('base64url');
      if (challenge !== pending.codeChallenge) return fail('pkce_mismatch');

      const now = Math.floor(Date.now() / 1000);
      const idToken = sign({
        iss: issuerUrl(name),
        aud: pending.clientId,
        iat: now,
        exp: now + 300,
        nonce: fake.wrongNonceOnce ? 'not-the-nonce-that-was-asked-for' : pending.nonce,
        ...pending.claims,
      });
      fake.wrongNonceOnce = false;
      tokenRequests.push({ name, ok: true });
      return json(res, 200, { access_token: `at-${++counter}`, token_type: 'Bearer', expires_in: 3600, id_token: idToken });
    }
    return json(res, 404, { error: 'not_found' });
  };

  const server: Server = createServer((req, res) => {
    handle(req, res).catch(() => json(res, 500, { error: 'server_error' }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const callbackFor = (authorizationUrl: string, params: Record<string, string>): string => {
    const auth = new URL(authorizationUrl);
    const back = new URL(auth.searchParams.get('redirect_uri') ?? '');
    for (const [k, v] of Object.entries(params)) back.searchParams.set(k, v);
    const state = auth.searchParams.get('state');
    if (state) back.searchParams.set('state', state);
    return `${back.pathname}${back.search}`;
  };

  const fake: FakeIssuer = {
    origin,
    issuerUrl,
    wrongNonceOnce: false,
    tokenRequests,
    approve(authorizationUrl, claims) {
      const auth = new URL(authorizationUrl);
      const name = auth.pathname.split('/')[1] ?? '';
      const client = clients[name];
      if (!client) throw new Error(`no fake provider "${name}"`);
      const p = auth.searchParams;
      if (p.get('client_id') !== client.clientId) throw new Error('wrong client_id');
      if (p.get('response_type') !== 'code') throw new Error('not the code flow');
      if (p.get('code_challenge_method') !== 'S256' || !p.get('code_challenge')) throw new Error('no PKCE S256');
      if (!p.get('state') || !p.get('nonce')) throw new Error('no state / nonce');
      const code = `code-${++counter}`;
      codes.set(code, {
        name,
        clientId: client.clientId,
        redirectUri: p.get('redirect_uri') ?? '',
        codeChallenge: p.get('code_challenge') ?? '',
        nonce: p.get('nonce') ?? '',
        claims,
      });
      return callbackFor(authorizationUrl, { code });
    },
    deny(authorizationUrl) {
      return callbackFor(authorizationUrl, { error: 'access_denied' });
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
        server.closeAllConnections();
      }),
  };
  return fake;
}
