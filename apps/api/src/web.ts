// Serves the built web app from the API process: ONE service, ONE origin (deployment, SPEC 21 v13).
//
// DECISION: the API serves the SPA (static files plus a fallback to index.html), instead of a separate static site.
// Everything the browser talks to is then one origin, so the session and anonId cookies stay first-party
// (SameSite=Lax, Secure) - no third-party-cookie rules to lose them to, no CORS, no second domain to register with the
// sign-in providers, and the OIDC redirect URI is on the same host the person is already on. The cost: a web-only change
// redeploys the API too (one build, a few minutes) - fine at this size. Moving the web to a CDN later is `VITE_API_BASE_URL`
// plus CORS, both already supported.
//
// Only started when `buildServer` is given a `webDist` (production, or `WEB_DIST` set): development keeps Vite on 5173.
import fastifyStatic from '@fastify/static';
import type { FastifyInstance } from 'fastify';

/**
 * The Content-Security-Policy of the app. Every external origin the app really loads, and nothing more:
 *  - Cloudflare Turnstile: its script (`api.js`) and the challenge iframe, both from challenges.cloudflare.com;
 *  - Google Fonts (docs/design-plan.md: IBM Plex Sans Hebrew): the stylesheet from fonts.googleapis.com, the font files
 *    from fonts.gstatic.com;
 *  - the account avatar: a Google profile picture (`*.googleusercontent.com`; Microsoft sends none).
 * Everything else is `'self'`: the bundle, the engine worker (a module worker built into /assets), and the API (`/api`).
 *
 * DECISION: `style-src` keeps `'unsafe-inline'`. The app's own inline styles are set through the CSSOM (React's `style`
 * prop), which CSP allows; the allowance is for Turnstile's widget, which injects style elements into the page (Cloudflare
 * lists it too). Scripts get no such allowance: no inline script, no `eval`.
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' https://challenges.cloudflare.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: https://*.googleusercontent.com",
  "connect-src 'self'",
  'frame-src https://challenges.cloudflare.com',
  "worker-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

/** HSTS: six months, this host only - no `includeSubDomains` or `preload` on a shared `onrender.com` parent. */
const HSTS = 'max-age=15552000';

export interface RegisterWebAppOptions {
  /** The built web app (`apps/web/dist`): index.html and /assets. */
  dir: string;
  /** The public origin is https: send `Strict-Transport-Security` too. */
  hsts: boolean;
}

const isApiPath = (path: string): boolean => path === '/api' || path.startsWith('/api/');

/** `/assets/index-Dm1LC8Y7.js`: a file with an extension. A page route (`/admin`, `/format/<id>`) has none. */
const hasExtension = (path: string): boolean => /\.[^/]+$/.test(path);

/**
 * Registers the security headers on every response, the static files, and the SPA fallback. Call LAST in `buildServer`
 * (the API routes are matched first; the fallback is the not-found handler, which this replaces).
 */
export async function registerWebApp(app: FastifyInstance, opts: RegisterWebAppOptions): Promise<void> {
  app.addHook('onSend', async (_req, reply) => {
    void reply.header('content-security-policy', CONTENT_SECURITY_POLICY);
    void reply.header('x-content-type-options', 'nosniff');
    void reply.header('referrer-policy', 'strict-origin-when-cross-origin');
    // frame-ancestors is the modern way; X-Frame-Options is for the old browsers that ignore it.
    void reply.header('x-frame-options', 'DENY');
    void reply.header('permissions-policy', 'camera=(), microphone=(), geolocation=(), payment=()');
    if (opts.hsts) void reply.header('strict-transport-security', HSTS);
  });

  await app.register(fastifyStatic, {
    root: opts.dir,
    // `pnpm build` writes a .br and a .gz next to every large file (apps/web/scripts/precompress.mjs): served as is, no per-request compression.
    preCompressed: true,
    // Cache-Control is ours (below): the plugin's default would call index.html cacheable for a while.
    cacheControl: false,
    setHeaders(reply, filePath) {
      // DECISION: Vite names everything under /assets with a hash of its content, so those files never change under
      // their name: cache them for a year. index.html (and anything else) names the current hashes: always revalidate
      // (the ETag makes that a 304), so a deploy is picked up on the next load and a stale page never asks for a gone file.
      const hashed = filePath.replace(/\\/g, '/').includes('/assets/');
      void reply.header('cache-control', hashed ? 'public, max-age=31536000, immutable' : 'no-cache');
    },
  });

  app.setNotFoundHandler(async (req, reply) => {
    const path = req.url.split('?', 1)[0]!;
    // A page route (GET, no extension, not /api): the single-page app decides what it shows. A missing file (/assets/gone.js)
    // or an unknown API route is a real 404 - never index.html pretending to be a script.
    if ((req.method === 'GET' || req.method === 'HEAD') && !isApiPath(path) && !hasExtension(path)) {
      return reply.code(200).type('text/html; charset=utf-8').sendFile('index.html');
    }
    return reply.code(404).send({ message: `Route ${req.method}:${path} not found`, error: 'Not Found', statusCode: 404 });
  });
}
