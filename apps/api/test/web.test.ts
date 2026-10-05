// One service, one origin (SPEC 21 v13): the API serves the built web app - static files with the right cache headers,
// the page-route fallback, and the security headers - without touching /api.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../src/server.js';
import { CONTENT_SECURITY_POLICY } from '../src/web.js';
import { makeEnv } from './protection/harness.js';

const INDEX = '<!doctype html><html><head><title>t</title></head><body><div id="root"></div></body></html>';
const SCRIPT = `console.log("${'x'.repeat(2000)}");`;

let root: string;
let dist: string;
beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), 'formatai-web-'));
  dist = path.join(root, 'dist');
  mkdirSync(path.join(dist, 'assets'), { recursive: true });
  writeFileSync(path.join(dist, 'index.html'), INDEX);
  writeFileSync(path.join(dist, 'assets', 'app-abc123.js'), SCRIPT);
  writeFileSync(path.join(dist, 'assets', 'app-abc123.js.br'), 'BROTLI-BYTES');
  writeFileSync(path.join(dist, 'assets', 'app-abc123.js.gz'), 'GZIP-BYTES');
  writeFileSync(path.join(root, 'secret.txt'), 'outside the web root');
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function start(webDist: string | null = dist, env: Record<string, string | undefined> = {}): Promise<FastifyInstance> {
  app = await buildServer({ env: makeEnv({ PUBLIC_ORIGIN: undefined, RENDER_EXTERNAL_URL: undefined, ...env }), db: null, logger: false, webDist: webDist ?? undefined });
  return app;
}

describe('the web app, served by the API', () => {
  it('serves index.html at / and revalidates it every time (it names the current hashed files)', async () => {
    const res = await (await start()).inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/html/);
    expect(res.headers['cache-control']).toBe('no-cache');
    expect(res.headers.etag).toBeTruthy();
    expect(res.body).toBe(INDEX);
    // A page load is not an API call: no cookie is set (the app's first /api request gives the anonId).
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('answers a revalidation with 304', async () => {
    const a = await start();
    const first = await a.inject({ method: 'GET', url: '/' });
    const again = await a.inject({ method: 'GET', url: '/', headers: { 'if-none-match': String(first.headers.etag) } });
    expect(again.statusCode).toBe(304);
  });

  it('caches hashed assets for a year, as immutable', async () => {
    const res = await (await start()).inject({ method: 'GET', url: '/assets/app-abc123.js' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/javascript/);
    expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(res.body).toBe(SCRIPT);
  });

  it('sends the pre-compressed copy the browser accepts (brotli, then gzip, else the file)', async () => {
    const a = await start();
    const br = await a.inject({ method: 'GET', url: '/assets/app-abc123.js', headers: { 'accept-encoding': 'gzip, br' } });
    expect(br.headers['content-encoding']).toBe('br');
    expect(br.headers['content-type']).toMatch(/javascript/);
    expect(br.body).toBe('BROTLI-BYTES');
    const gz = await a.inject({ method: 'GET', url: '/assets/app-abc123.js', headers: { 'accept-encoding': 'gzip' } });
    expect(gz.headers['content-encoding']).toBe('gzip');
    expect(gz.body).toBe('GZIP-BYTES');
    const plain = await a.inject({ method: 'GET', url: '/assets/app-abc123.js' });
    expect(plain.headers['content-encoding']).toBeUndefined();
    expect(String(plain.headers.vary).toLowerCase()).toContain('accept-encoding');
  });

  it('answers a page route (no file extension) with index.html: the app decides what to show', async () => {
    const a = await start();
    for (const url of ['/admin', '/admin/users', '/format/64b0c0ffee64b0c0ffee64b0', '/convert?resume=1', '/privacy/']) {
      const res = await a.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(200);
      expect(res.headers['content-type'], url).toMatch(/^text\/html/);
      expect(res.headers['cache-control'], url).toBe('no-cache');
      expect(res.body, url).toBe(INDEX);
    }
    const head = await a.inject({ method: 'HEAD', url: '/admin' });
    expect(head.statusCode).toBe(200);
  });

  it('a missing file is a 404, never index.html pretending to be a script', async () => {
    const a = await start();
    for (const url of ['/assets/gone-123.js', '/favicon.ico', '/robots.txt']) {
      const res = await a.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(404);
      expect(res.headers['content-type'], url).toMatch(/json/);
    }
  });

  it('keeps /api for the API: an unknown route is a JSON 404, and only a page route falls back', async () => {
    const a = await start();
    for (const url of ['/api', '/api/nope', '/api/formats/extra/deeper']) {
      const res = await a.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(404);
      expect(res.json().error, url).toBe('Not Found');
    }
    expect((await a.inject({ method: 'POST', url: '/admin' })).statusCode).toBe(404);
    const health = await a.inject({ method: 'GET', url: '/api/health' });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toEqual({ ok: true, db: 'not configured' });
  });

  it('does not serve anything from outside the web root', async () => {
    const a = await start();
    for (const url of ['/../secret.txt', '/%2e%2e/secret.txt', '/assets/../../secret.txt', '/assets/%2e%2e%2f%2e%2e%2fsecret.txt']) {
      const res = await a.inject({ method: 'GET', url });
      expect(res.body, url).not.toContain('outside the web root');
    }
  });

  it('puts the security headers on the app and on the API', async () => {
    const a = await start();
    for (const url of ['/', '/assets/app-abc123.js', '/api/health', '/api/session']) {
      const res = await a.inject({ method: 'GET', url });
      expect(res.headers['content-security-policy'], url).toBe(CONTENT_SECURITY_POLICY);
      expect(res.headers['x-content-type-options'], url).toBe('nosniff');
      expect(res.headers['referrer-policy'], url).toBe('strict-origin-when-cross-origin');
      expect(res.headers['x-frame-options'], url).toBe('DENY');
      expect(res.headers['strict-transport-security'], url).toBeUndefined(); // the origin here is http
    }
  });

  it('sends Strict-Transport-Security when the public origin is https', async () => {
    const res = await (await start(dist, { WEB_ORIGIN: 'https://formatai.example.test' })).inject({ method: 'GET', url: '/' });
    expect(res.headers['strict-transport-security']).toBe('max-age=15552000');
  });

  it('is off without a web root (development: Vite serves the web)', async () => {
    const res = await (await start(null)).inject({ method: 'GET', url: '/admin' });
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-security-policy']).toBeUndefined();
  });
});

describe('the Content-Security-Policy', () => {
  const directive = (name: string): string[] => {
    const found = CONTENT_SECURITY_POLICY.split('; ').find((d) => d.startsWith(`${name} `));
    return found ? found.split(' ').slice(1) : [];
  };

  it('allows exactly the external origins the app loads: Turnstile, Google Fonts and the Google avatar', () => {
    expect(directive('script-src')).toEqual(["'self'", 'https://challenges.cloudflare.com']);
    expect(directive('frame-src')).toEqual(['https://challenges.cloudflare.com']);
    expect(directive('style-src')).toContain('https://fonts.googleapis.com');
    expect(directive('font-src')).toContain('https://fonts.gstatic.com');
    expect(directive('img-src')).toContain('https://*.googleusercontent.com');
    expect(directive('connect-src')).toEqual(["'self'"]);
  });

  it('forbids inline and eval script, plugins, other base URLs and being framed', () => {
    expect(directive('script-src')).not.toContain("'unsafe-inline'");
    expect(directive('script-src')).not.toContain("'unsafe-eval'");
    expect(directive('object-src')).toEqual(["'none'"]);
    expect(directive('base-uri')).toEqual(["'self'"]);
    expect(directive('frame-ancestors')).toEqual(["'none'"]);
  });
});
