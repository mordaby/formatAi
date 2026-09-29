import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { loadEnv } from '../src/env.js';
import { buildServer } from '../src/server.js';

// SPEC 2 & 15: the API has no endpoint that accepts files, and rejects JSON bodies over
// 256 KB. Bodies of any other content type (multipart, text/plain, ...) are rejected too,
// since the only thing ever sent to the API is a small JSON payload.

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function makeApp(): Promise<FastifyInstance> {
  const env = loadEnv({ ...process.env, MONGODB_URI: '' });
  app = await buildServer({ env, db: null, logger: false });
  app.post('/echo', async (req) => req.body ?? null);
  return app;
}

describe('body size limit', () => {
  it('rejects a ~300 KB JSON body with 413', async () => {
    const server = await makeApp();
    const payload = JSON.stringify({ big: 'x'.repeat(300 * 1024) });

    const res = await server.inject({
      method: 'POST',
      url: '/echo',
      payload,
      headers: { 'content-type': 'application/json' },
    });

    expect(res.statusCode).toBe(413);
  });

  it('accepts a small JSON body', async () => {
    const server = await makeApp();

    const res = await server.inject({
      method: 'POST',
      url: '/echo',
      payload: JSON.stringify({ hello: 'world' }),
      headers: { 'content-type': 'application/json' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ hello: 'world' });
  });
});

describe('content-type allowlist', () => {
  it('rejects multipart/form-data with 415', async () => {
    const server = await makeApp();

    const res = await server.inject({
      method: 'POST',
      url: '/echo',
      payload: '--boundary\r\nContent-Disposition: form-data; name="a"\r\n\r\n1\r\n--boundary--',
      headers: { 'content-type': 'multipart/form-data; boundary=boundary' },
    });

    expect(res.statusCode).toBe(415);
  });

  it('rejects text/plain with 415', async () => {
    const server = await makeApp();

    const res = await server.inject({
      method: 'POST',
      url: '/echo',
      payload: 'hello',
      headers: { 'content-type': 'text/plain' },
    });

    expect(res.statusCode).toBe(415);
  });
});
