// The sign-in routes (SPEC 12, 5 E). Answers to the browser are redirects back to the web app (`returnTo`) with
// a short result code in the query - `authError=<code>` or `linked=<provider>` - never provider text.
import { limits, type AuthProvidersResponse, type AuthRedirectError, type MeResponse, type MeUser } from '@formatai/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Env } from '../env.js';
import type { UserDoc } from '../models.js';
import { isValidAnonId } from '../protection/identity.js';
import type { AdminConfig } from './admin.js';
import type { OidcClient } from './oidc.js';
import { isAuthProvider, type IdClaims, type ProviderConfig } from './providers.js';
import { redirectTarget, safeReturnTo } from './returnTo.js';
import { SESSION_COOKIE, type SessionManager } from './session.js';
import { decodeFlow, encodeFlow, randomToken, type FlowState } from './signing.js';
import { toUserIdentity, type AuthStore, type StoredUser } from './store.js';

export interface AuthRoutesOptions {
  env: Env;
  store: AuthStore;
  oidc: OidcClient;
  sessions: SessionManager;
  providers: readonly ProviderConfig[];
  admin: AdminConfig;
  secret: string;
  /** e.g. `http://localhost:8787` - the OIDC redirect URIs are `<apiBase>/api/auth/<provider>/callback`. */
  apiBase: string;
  secure: boolean;
  now: () => Date;
}

const UI_LANGUAGES = ['he', 'en'] as const;

const flowCookie = (provider: string): string => `flow_${provider}`;
const FLOW_COOKIE_PATH = '/api/auth';

export function meUser(user: StoredUser, isAdmin: boolean): MeUser {
  const email = (user.identities.find((i) => i.emailVerified && i.email) ?? user.identities.find((i) => i.email))?.email;
  return {
    id: user._id.toHexString(),
    name: user.name ?? null,
    avatarUrl: user.avatarUrl ?? null,
    ...(email ? { email } : {}),
    tier: user.tier,
    providers: user.identities.map((i) => i.provider),
    isAdmin,
    uiLanguage: user.uiLanguage === 'he' || user.uiLanguage === 'en' ? user.uiLanguage : null,
  };
}

/** Only a name on a class of error is logged: never a message, claim, token, email or cookie. */
function errorName(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code;
    return typeof code === 'string' ? `${err.name}:${code}` : err.name;
  }
  return 'unknown';
}

export function registerAuthRoutes(app: FastifyInstance, o: AuthRoutesOptions): void {
  const { store, oidc, sessions, secret, secure, now } = o;
  const byId = new Map(o.providers.map((p) => [p.id, p]));
  const webOrigin = new URL(o.env.WEB_ORIGIN).origin;
  const allowedOrigins = new Set([webOrigin, new URL(o.apiBase).origin]);

  const redirectUri = (p: ProviderConfig): string => `${o.apiBase}/api/auth/${p.id}/callback`;
  const providerOf = (raw: unknown): ProviderConfig | undefined =>
    typeof raw === 'string' && isAuthProvider(raw) ? byId.get(raw) : undefined;

  /** Defence in depth on top of SameSite=Lax + JSON-only bodies: a browser that names an Origin must name ours. */
  const forbiddenOrigin = (req: FastifyRequest, reply: FastifyReply): boolean => {
    const origin = req.headers.origin;
    if (origin === undefined || allowedOrigins.has(origin)) return false;
    void reply.code(403).send({ error: 'forbiddenOrigin' });
    return true;
  };

  /** Sets the flow cookie and returns the provider's authorization URL. */
  async function beginFlow(
    provider: ProviderConfig,
    reply: FastifyReply,
    opts: { mode: FlowState['mode']; returnTo: string; userId?: string },
  ): Promise<URL> {
    const flow: FlowState = {
      provider: provider.id,
      mode: opts.mode,
      state: randomToken(),
      nonce: randomToken(),
      codeVerifier: randomToken(), // 43 chars of base64url: a valid PKCE verifier
      returnTo: opts.returnTo,
      ...(opts.userId ? { userId: opts.userId } : {}),
      expiresAt: now().getTime() + limits.auth.flowMinutes * 60_000,
    };
    // Linking lets the person pick the account (they may be signed in to another one at the provider).
    const extra = opts.mode === 'link' ? { prompt: 'select_account' } : undefined;
    const url = await oidc.authorizationUrl(provider, redirectUri(provider), flow, extra);
    void reply.setCookie(flowCookie(provider.id), encodeFlow(secret, flow), {
      httpOnly: true,
      // Lax, not Strict: the provider's redirect back to /callback is a cross-site top-level GET and must carry it.
      sameSite: 'lax',
      secure,
      path: FLOW_COOKIE_PATH,
      maxAge: limits.auth.flowMinutes * 60,
    });
    return url;
  }

  // ---- which providers can be offered ----

  app.get('/api/auth/providers', async (_req, reply): Promise<AuthProvidersResponse> => {
    void reply.header('cache-control', 'no-store');
    return { providers: o.providers.map((p) => p.id) };
  });

  // ---- sign in ----

  app.get('/api/auth/:provider/start', async (req, reply) => {
    const provider = providerOf((req.params as { provider?: string }).provider);
    if (!provider) return reply.code(404).send({ error: 'unknownProvider' });
    const returnTo = safeReturnTo((req.query as { returnTo?: unknown }).returnTo);
    let url: URL;
    try {
      url = await beginFlow(provider, reply, { mode: 'signin', returnTo });
    } catch (err) {
      req.log.warn({ err: errorName(err), provider: provider.id }, 'sign-in start failed');
      return reply.code(502).send({ error: 'providerUnavailable' });
    }
    return reply.redirect(url.toString());
  });

  app.get('/api/auth/:provider/callback', async (req, reply) => {
    const provider = providerOf((req.params as { provider?: string }).provider);
    if (!provider) return reply.code(404).send({ error: 'unknownProvider' });

    const cookieName = flowCookie(provider.id);
    const flow = decodeFlow(secret, req.cookies[cookieName], now().getTime());
    // A flow is single use: whatever happens next, this cookie is spent.
    void reply.clearCookie(cookieName, { path: FLOW_COOKIE_PATH });

    const returnTo = flow?.returnTo ?? '/';
    const back = (param?: [string, string]): FastifyReply =>
      reply.redirect(redirectTarget(webOrigin, returnTo, param));
    const fail = (code: AuthRedirectError): FastifyReply => back(['authError', code]);

    if (!flow || flow.provider !== provider.id) return fail('expired');

    const rawQuery = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
    const query = new URLSearchParams(rawQuery);
    if (query.has('error')) return fail(query.get('error') === 'access_denied' ? 'denied' : 'failed');

    let claims: IdClaims;
    try {
      // The token request must repeat the exact redirect URI, whatever host this request arrived on.
      const callbackUrl = new URL(redirectUri(provider));
      callbackUrl.search = rawQuery;
      claims = await oidc.finish(provider, callbackUrl, flow);
    } catch (err) {
      req.log.warn({ err: errorName(err), provider: provider.id }, 'sign-in failed');
      return fail('failed');
    }
    const identity = provider.identity(claims);
    if (!identity) return fail('failed');

    const at = now();

    if (flow.mode === 'link') {
      const me = req.sessionUser;
      if (!me || me._id.toHexString() !== flow.userId) return fail('sessionMismatch');
      // The identity's owner is looked up by provider + subject only - never by email.
      const owner = await store.findUserByIdentity(identity);
      if (owner) {
        if (!owner._id.equals(me._id)) return fail('identityInUse');
        await store.refreshUser(owner, identity, at);
        return back(['linked', provider.id]);
      }
      const added = await store.addIdentity(me._id, toUserIdentity(identity));
      if (added !== 'ok') return fail(added);
      return back(['linked', provider.id]);
    }

    // Find-or-create by identity ONLY. The same email at another provider (or another Microsoft tenant) is a
    // different person as far as we can tell: SPEC 12 forbids merging by email.
    let user = await store.findUserByIdentity(identity);
    let created = false;
    if (user) {
      await store.refreshUser(user, identity, at);
    } else {
      const doc: UserDoc = {
        identities: [toUserIdentity(identity)],
        ...(identity.name ? { name: identity.name } : {}),
        ...(identity.avatarUrl ? { avatarUrl: identity.avatarUrl } : {}),
        tier: 'registered',
        createdAt: at,
        lastSeenAt: at,
        anonIds: [],
      };
      user = await store.createUser(doc);
      if (user) {
        created = true;
      } else {
        // A concurrent sign-in of the same identity created it first.
        user = await store.findUserByIdentity(identity);
        if (!user) return fail('failed');
      }
    }

    // SPEC 12: this browser's anonymous history becomes the user's (events; cache entries; the anonId itself).
    // Best effort: a hiccup here must not turn a successful sign-in into an error page.
    const anonId = isValidAnonId(req.anonId) ? req.anonId : undefined;
    try {
      if (anonId) await store.attachAnon(user._id, anonId);
      await store.insertEvent({
        ts: at,
        ...(anonId ? { anonId } : {}),
        userId: user._id,
        type: created ? 'signed_up' : 'signed_in',
        props: { provider: provider.id },
      });
    } catch (err) {
      req.log.warn({ err: errorName(err) }, 'attaching the anonymous visitor failed');
    }

    await sessions.start(reply, user._id, req.cookies[SESSION_COOKIE]);
    return back();
  });

  // ---- sign out ----

  app.post('/api/auth/logout', async (req, reply) => {
    if (forbiddenOrigin(req, reply)) return reply;
    await sessions.end(req, reply);
    void reply.header('cache-control', 'no-store');
    return { ok: true };
  });

  // ---- the signed-in user ----

  app.get('/api/me', async (req, reply): Promise<MeResponse> => {
    void reply.header('cache-control', 'no-store');
    const user = req.sessionUser;
    return { user: user ? meUser(user, sessions.isAdmin(user)) : null };
  });

  app.patch('/api/me', async (req, reply) => {
    if (forbiddenOrigin(req, reply)) return reply;
    void reply.header('cache-control', 'no-store');
    const user = req.sessionUser;
    if (!user) return reply.code(401).send({ error: 'signedOut' });

    const body = req.body as Record<string, unknown> | null;
    const keys = body && typeof body === 'object' && !Array.isArray(body) ? Object.keys(body) : [];
    const language = body?.uiLanguage;
    // Only the UI language can be changed here.
    if (keys.length !== 1 || !UI_LANGUAGES.some((l) => l === language)) {
      return reply.code(400).send({ error: 'invalidBody' });
    }
    const updated = await store.setUiLanguage(user._id, language as string);
    if (!updated) return reply.code(401).send({ error: 'signedOut' });
    const res: MeResponse = { user: meUser(updated, sessions.isAdmin(updated)) };
    return res;
  });

  // ---- link a second provider ----

  app.post('/api/me/link/:provider/start', async (req, reply) => {
    if (forbiddenOrigin(req, reply)) return reply;
    void reply.header('cache-control', 'no-store');
    const user = req.sessionUser;
    if (!user) return reply.code(401).send({ error: 'signedOut' });
    const provider = providerOf((req.params as { provider?: string }).provider);
    if (!provider) return reply.code(404).send({ error: 'unknownProvider' });
    if (user.identities.some((i) => i.provider === provider.id)) {
      return reply.code(409).send({ error: 'providerLinked' });
    }
    const body = req.body as { returnTo?: unknown } | null | undefined;
    const returnTo = safeReturnTo(body && typeof body === 'object' ? body.returnTo : undefined);
    try {
      const url = await beginFlow(provider, reply, { mode: 'link', returnTo, userId: user._id.toHexString() });
      // A fetch() can't follow a redirect to another site and keep the cookie story simple: the client navigates.
      return { url: url.toString() };
    } catch (err) {
      req.log.warn({ err: errorName(err), provider: provider.id }, 'link start failed');
      return reply.code(502).send({ error: 'providerUnavailable' });
    }
  });
}
