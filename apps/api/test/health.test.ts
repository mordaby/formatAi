import { describe, expect, it } from 'vitest';
import { loadEnv } from '../src/env.js';
import { buildServer } from '../src/server.js';

describe('GET /api/health', () => {
  it('reports db as "not configured" when no database is connected', async () => {
    const env = loadEnv({ ...process.env, MONGODB_URI: '' });
    const app = await buildServer({ env, db: null, logger: false });

    const res = await app.inject({ method: 'GET', url: '/api/health' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, db: 'not configured' });

    await app.close();
  });
});
