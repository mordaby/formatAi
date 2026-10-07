// The feature switch "Formats with several sources" (owner decision 2026-10-07, `config/features.ts`): off by default (the MVP), overridden by
// `FEATURE_FORMAT_SOURCES=on|off`. GET /api/session tells the web app the value the server runs with; while it is off the attach route is
// refused (403 `featureOff`) before anything else is looked at, so no hidden path stays reachable. No database needed.
import { features } from '@formatai/shared';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { featuresOf } from '../../src/env.js';
import { buildServer } from '../../src/server.js';
import { createMemoryStore } from '../../src/protection/store.js';
import { makeEnv, stubIdentify } from '../protection/harness.js';
import { makeCaller, saveBody, sourceTwo } from './helpers.js';

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function serve(value: string | undefined) {
  app = await buildServer({ env: makeEnv({ FEATURE_FORMAT_SOURCES: value }), db: null, logger: false, store: createMemoryStore(), identify: stubIdentify });
  return makeCaller(app);
}

const ID = 'aaaaaaaaaaaaaaaaaaaaaaaa';

describe('the switch as the server reads it', () => {
  it('is off by default, and on / off (any case) say it outright', () => {
    expect(features.formatSources).toBe(false);
    expect(featuresOf({})).toEqual({ formatSources: false });
    expect(featuresOf({ FEATURE_FORMAT_SOURCES: 'on' })).toEqual({ formatSources: true });
    expect(featuresOf({ FEATURE_FORMAT_SOURCES: ' ON ' })).toEqual({ formatSources: true });
    expect(featuresOf({ FEATURE_FORMAT_SOURCES: 'off' })).toEqual({ formatSources: false });
    // (a typo keeps the default here; a production start refuses it first - productionConfig.test.ts)
    expect(featuresOf({ FEATURE_FORMAT_SOURCES: 'yes' })).toEqual({ formatSources: false });
  });

  it('GET /api/session says which value the server runs with', async () => {
    for (const [value, on] of [[undefined, false], ['off', false], ['on', true]] as const) {
      const call = await serve(value);
      const res = await call('GET', '/api/session', undefined, { user: null });
      expect(res.status).toBe(200);
      expect(res.body.features).toEqual({ formatSources: on });
      await app!.close();
      app = undefined;
    }
  });
});

describe('the attach route (POST /api/formats/:id/conversions)', () => {
  it('off: refused with featureOff, whoever calls and whatever is sent', async () => {
    const call = await serve(undefined);
    for (const user of [undefined, null]) {
      const res = await call('POST', `/api/formats/${ID}/conversions`, saveBody(sourceTwo()), { user });
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: 'featureOff' });
    }
  });

  it('on: the route is there (with no database it is unavailable, like every registry route)', async () => {
    const call = await serve('on');
    const res = await call('POST', `/api/formats/${ID}/conversions`, saveBody(sourceTwo()));
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: 'unavailable' });
  });

  it('off: the other registry routes are untouched (a format is still created as before)', async () => {
    const call = await serve('off');
    const res = await call('POST', '/api/formats', { name: 'x', ...saveBody(sourceTwo()) });
    expect(res.body).toEqual({ error: 'unavailable' });
  });
});
