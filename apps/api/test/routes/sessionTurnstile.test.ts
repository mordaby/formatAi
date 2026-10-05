// GET /api/session and the Turnstile owner switch (TURNSTILE_DISABLED, env.ts): while it is on, no site key is served, so the
// browser shows no widget and sends no token.
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { loadEnv } from '../../src/env.js';
import { registerSessionRoute } from '../../src/routes/session.js';

async function sessionWith(vars: Record<string, string>): Promise<Record<string, unknown>> {
  const app = Fastify();
  app.decorateRequest('anonId', '');
  registerSessionRoute(app, { env: loadEnv({ NODE_ENV: 'test', ...vars }) });
  const res = await app.inject({ method: 'GET', url: '/api/session' });
  await app.close();
  return res.json() as Record<string, unknown>;
}

describe('GET /api/session and TURNSTILE_DISABLED', () => {
  it('serves the site key when Turnstile is on', async () => {
    expect((await sessionWith({ TURNSTILE_SITE_KEY: 'site-key' })).turnstileSiteKey).toBe('site-key');
  });

  it('serves no site key while the owner switch is on, whatever the keys say', async () => {
    for (const value of ['true', 'TRUE', '1', 'yes']) {
      expect(await sessionWith({ TURNSTILE_SITE_KEY: 'pending', TURNSTILE_DISABLED: value })).not.toHaveProperty('turnstileSiteKey');
    }
  });

  it('any other value leaves it on', async () => {
    expect((await sessionWith({ TURNSTILE_SITE_KEY: 'site-key', TURNSTILE_DISABLED: 'false' })).turnstileSiteKey).toBe('site-key');
  });
});
