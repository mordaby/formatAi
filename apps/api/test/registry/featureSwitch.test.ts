// The feature switch "Formats with several sources" (owner decisions 2026-10-07, `config/features.ts`): off by default (the MVP), overridden by
// `FEATURE_FORMAT_SOURCES=on|off`. GET /api/session tells the web app the value the server runs with. The switch hides only the explicit
// source UI in the web app: the attach route stays open whatever it says - the Learn-time "Is this file another input for it?" saves through
// it - and its plan limit and locks still hold (registry.test.ts). No database needed.
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

describe('the attach route (POST /api/formats/:id/conversions) is the same whatever the switch says', () => {
  it('off and on alike: a visitor is asked to sign in, and a signed-in call reaches the registry (with no database: unavailable)', async () => {
    for (const value of [undefined, 'off', 'on']) {
      const call = await serve(value);
      const anon = await call('POST', `/api/formats/${ID}/conversions`, saveBody(sourceTwo()), { user: null });
      expect(anon.status, String(value)).toBe(401);
      const res = await call('POST', `/api/formats/${ID}/conversions`, saveBody(sourceTwo()));
      expect(res.status, String(value)).toBe(503);
      expect(res.body).toEqual({ error: 'unavailable' });
      await app!.close();
      app = undefined;
    }
  });
});
