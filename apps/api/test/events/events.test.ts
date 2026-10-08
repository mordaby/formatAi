// POST /api/events end to end (fastify inject, in-memory stores): the usage events only the browser knows (SPEC 14.1; owner decision 2026-10-08).
// What this holds: the server's time and the signed-in user's id (or NO id at all for a visitor), every prop checked against its strict schema
// (an invalid event is dropped, not the batch), the caps (events per request, bytes, requests per minute per IP), the Origin check, and that
// the route never gives a visitor an id (no cookie).
import { limits } from '@formatai/shared';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { ObjectId } from 'mongodb';
import { afterEach, describe, expect, it } from 'vitest';
import { createMemoryEventStore, type MemoryEventStore } from '../../src/events/index.js';
import { createMemoryStore } from '../../src/protection/store.js';
import { buildServer } from '../../src/server.js';
import { makeEnv, nextIp, stubIdentify, testUserId } from '../protection/harness.js';

const NOW = new Date('2026-10-08T09:30:00.000Z');
const WEB_ORIGIN = 'http://localhost:5173';
const USER = testUserId(7);

const pageView = (page = 'home') => ({ type: 'page_view', props: { page } });

interface Setup {
  app: FastifyInstance;
  store: MemoryEventStore;
  clock: { current: Date };
  post(body: unknown, o?: { ip?: string; user?: string | null; origin?: string; cookie?: string; raw?: string; contentType?: string }): Promise<LightMyRequestResponse>;
}

describe('POST /api/events', () => {
  let t: Setup | undefined;
  afterEach(async () => {
    await t?.app.close();
    t = undefined;
  });

  async function setup(env: Record<string, string | undefined> = {}): Promise<Setup> {
    const clock = { current: new Date(NOW) };
    const now = (): Date => new Date(clock.current);
    const store = createMemoryEventStore();
    const app = await buildServer({
      env: makeEnv({ WEB_ORIGIN, ...env }),
      db: null,
      logger: false,
      store: createMemoryStore(now),
      eventStore: store,
      now,
      identify: stubIdentify,
    });
    const made: Setup = {
      app,
      store,
      clock,
      post: (body, o = {}) =>
        app.inject({
          method: 'POST',
          url: '/api/events',
          remoteAddress: o.ip ?? nextIp(),
          headers: {
            'content-type': o.contentType ?? 'application/json',
            ...(o.user ? { 'x-test-user': o.user } : {}),
            ...(o.origin ? { origin: o.origin } : {}),
            ...(o.cookie ? { cookie: o.cookie } : {}),
          },
          payload: o.raw ?? JSON.stringify(body),
        }),
    };
    t = made;
    return made;
  }

  describe('who an event belongs to', () => {
    it('stores a signed-in user\'s events with their userId and the SERVER\'s time', async () => {
      const { post, store } = await setup();
      const res = await post({ events: [pageView('formats'), { type: 'download', props: { kind: 'zip' } }] }, { user: USER });
      expect(res.statusCode).toBe(204);
      expect(res.body).toBe('');
      expect(store.events).toHaveLength(2);
      expect(store.events[0]).toEqual({ ts: NOW, userId: new ObjectId(USER), type: 'page_view', props: { page: 'formats' } });
      expect(store.events[1]).toMatchObject({ userId: new ObjectId(USER), type: 'download', props: { kind: 'zip' } });
    });

    it('stores a visitor\'s events with NO id at all: no userId, no anonId, nothing that links two of them', async () => {
      const { post, store } = await setup();
      const res = await post({ events: [pageView('home'), pageView('learn')] }, { cookie: 'anonId=AAAAAAAAAAAAAAAAAAAAAA' });
      expect(res.statusCode).toBe(204);
      expect(store.events).toHaveLength(2);
      for (const e of store.events) {
        expect(Object.keys(e).sort()).toEqual(['props', 'ts', 'type']);
      }
      // nothing of the request that could identify it: no IP, no cookie value
      expect(JSON.stringify(store.events)).not.toMatch(/AAAAAAAA|198\.51|userId|anonId/);
    });

    it('never gives a visitor an id: the answer sets no cookie', async () => {
      const { post } = await setup();
      const res = await post({ events: [pageView()] });
      expect(res.statusCode).toBe(204);
      expect(res.headers['set-cookie']).toBeUndefined();
    });

    it('ignores a time, a user and any other field the browser adds to an event or to the body', async () => {
      const { post, store } = await setup();
      await post(
        { userId: testUserId(99), anonId: 'x', ts: '2001-01-01T00:00:00Z', events: [{ ...pageView(), ts: '2001-01-01T00:00:00Z', userId: testUserId(98), anonId: 'y' }] },
        { user: USER },
      );
      expect(store.events).toEqual([{ ts: NOW, userId: new ObjectId(USER), type: 'page_view', props: { page: 'home' } }]);
    });

    it('stamps each request with the time it arrived', async () => {
      const { post, store, clock } = await setup();
      await post({ events: [pageView()] });
      clock.current = new Date('2026-10-09T10:00:00.000Z');
      await post({ events: [pageView()] });
      expect(store.events.map((e) => e.ts.toISOString())).toEqual([NOW.toISOString(), '2026-10-09T10:00:00.000Z']);
    });
  });

  describe('what is kept', () => {
    it('drops an invalid event and keeps the rest of the batch', async () => {
      const { post, store } = await setup();
      const res = await post({
        events: [
          pageView('home'),
          { type: 'page_view', props: { page: '/formats/65f0c2a1b3d4e5f607182930' } }, // a path, not a route name
          { type: 'file_rejected', props: { reason: 'orders-2026.xlsx' } }, // a file name where a code belongs
          { type: 'download', props: { kind: 'zip', fileName: 'a.xlsx' } }, // a prop nobody listed
          { type: 'file_uploaded', props: { role: 'input', fileType: 'csv', rows: -3, cols: 2 } },
          { type: 'no_such_event', props: {} },
          'not even an object',
          null,
          { type: 'download', props: { kind: 'single' } },
        ],
      });
      expect(res.statusCode).toBe(204);
      expect(store.events.map((e) => [e.type, e.props])).toEqual([
        ['page_view', { page: 'home' }],
        ['download', { kind: 'single' }],
      ]);
    });

    it('refuses the events the API writes itself: a browser cannot report a save, a run or a limit', async () => {
      const { post, store } = await setup();
      await post(
        {
          events: [
            { type: 'format_saved', props: { kind: 'new' } },
            { type: 'format_run', props: { daysSinceCreated: 30, rows: 5, flagged: 0 } },
            { type: 'limit_hit', props: { limit: 'savedFormats' } },
            { type: 'feedback_given', props: { replyRequested: true } },
            { type: 'lead_submitted', props: { kind: 'contact' } },
            { type: 'upgrade_intent', props: { trigger: 'other' } },
            { type: 'signed_up', props: { provider: 'google' } },
          ],
        },
        { user: USER },
      );
      expect(store.events).toEqual([]);
    });

    it('rounds a score to two decimals and keeps nothing a schema does not list', async () => {
      const { post, store } = await setup();
      await post({ events: [{ type: 'file_matched', props: { result: 'choose', score: 0.8567 } }, { type: 'file_matched', props: { result: 'none' } }] });
      expect(store.events.map((e) => e.props)).toEqual([{ result: 'choose', score: 0.86 }, { result: 'none' }]);
    });

    it('stores a file\'s size as counts and its type as a code, never its name', async () => {
      const { post, store } = await setup();
      await post({ events: [{ type: 'file_uploaded', props: { role: 'run', fileType: 'xlsx', rows: 1204, cols: 8 } }] });
      expect(store.events[0]!.props).toEqual({ role: 'run', fileType: 'xlsx', rows: 1204, cols: 8 });
    });

    it('answers 204 and stores nothing for a body that holds no events', async () => {
      const { post, store } = await setup();
      for (const body of [{}, { events: [] }, { events: 'x' }, { events: {} }, [], null, 'text', 7]) {
        expect((await post(body)).statusCode).toBe(204);
      }
      expect(store.events).toEqual([]);
    });

    it('answers a body that is not JSON with the usual client error, and stores nothing', async () => {
      const { post, store } = await setup();
      expect((await post(null, { raw: '{"events": [' })).statusCode).toBe(400);
      expect((await post(null, { raw: 'events=1', contentType: 'text/plain' })).statusCode).toBe(415);
      expect(store.events).toEqual([]);
    });
  });

  describe('the caps', () => {
    it(`stores at most ${limits.events.maxPerRequest} events of one request`, async () => {
      const { post, store } = await setup();
      const res = await post({ events: Array.from({ length: limits.events.maxPerRequest + 6 }, () => pageView()) });
      expect(res.statusCode).toBe(204);
      expect(store.events).toHaveLength(limits.events.maxPerRequest);
    });

    it('takes exactly the limit', async () => {
      const { post, store } = await setup();
      await post({ events: Array.from({ length: limits.events.maxPerRequest }, () => pageView()) });
      expect(store.events).toHaveLength(limits.events.maxPerRequest);
    });

    it(`refuses a body over ${limits.events.maxBodyBytes} bytes (413) and stores nothing`, async () => {
      const { post, store } = await setup();
      const big = { events: [pageView()], padding: 'x'.repeat(limits.events.maxBodyBytes) };
      const res = await post(big);
      expect(res.statusCode).toBe(413);
      expect(store.events).toEqual([]);
    });

    it(`limits one IP to ${limits.events.perIpPerWindow} requests a minute (429 rateLimited), and another IP is not affected`, async () => {
      const { post, store, clock } = await setup();
      const ip = '203.0.113.9';
      for (let i = 0; i < limits.events.perIpPerWindow; i++) expect((await post({ events: [pageView()] }, { ip })).statusCode).toBe(204);
      const over = await post({ events: [pageView()] }, { ip });
      expect(over.statusCode).toBe(429);
      expect(over.json()).toEqual({ error: 'rateLimited' });
      expect(over.headers['retry-after']).toBeDefined();
      expect(store.events).toHaveLength(limits.events.perIpPerWindow);
      expect((await post({ events: [pageView()] }, { ip: '203.0.113.10' })).statusCode).toBe(204);
      // ... and the window passes
      clock.current = new Date(NOW.getTime() + limits.protection.rateLimitWindowMs + 1_000);
      expect((await post({ events: [pageView()] }, { ip })).statusCode).toBe(204);
    });

    it('asks no Turnstile token, even where Turnstile is configured', async () => {
      const { post, store } = await setup({ TURNSTILE_SECRET_KEY: 'turnstile-secret' });
      expect((await post({ events: [pageView()] })).statusCode).toBe(204);
      expect(store.events).toHaveLength(1);
    });
  });

  describe('the Origin check', () => {
    it('refuses a cross-site Origin (403 forbidden) and stores nothing', async () => {
      const { post, store } = await setup();
      const res = await post({ events: [pageView()] }, { origin: 'https://evil.example', user: USER });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: 'forbidden' });
      expect(store.events).toEqual([]);
    });

    it('takes the web app\'s origin, the API\'s own, and a request that names none', async () => {
      const { post, store } = await setup();
      expect((await post({ events: [pageView()] }, { origin: WEB_ORIGIN })).statusCode).toBe(204);
      expect((await post({ events: [pageView()] }, { origin: 'http://localhost:8787' })).statusCode).toBe(204);
      expect((await post({ events: [pageView()] })).statusCode).toBe(204);
      expect(store.events).toHaveLength(3);
    });
  });

  it('is not reachable with another method', async () => {
    const { app } = await setup();
    const res = await app.inject({ method: 'GET', url: '/api/events', remoteAddress: nextIp() });
    expect(res.statusCode).toBe(404);
  });
});
