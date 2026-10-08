// The usage events the public forms write once a submission is stored (SPEC 14.1; owner decision 2026-10-08): `lead_submitted` (the business
// form, the paid waitlist), `upgrade_intent` (the waitlist's trigger) and `feedback_given`. In-memory stores, fastify inject.
//
// What is checked: only after a successful store, the signed-in user's id or NO id for a visitor, and that nothing the sender typed (name, email,
// company, message, page) is in an event.
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { createMemoryContactStore } from '../../src/contact/store.js';
import { createMemoryEventStore, type MemoryEventStore } from '../../src/events/index.js';
import { createMemoryStore } from '../../src/protection/store.js';
import { buildServer } from '../../src/server.js';
import { makeEnv, makeTurnstileFetch, nextIp, stubIdentify, testUserId } from '../protection/harness.js';

const NOW = new Date('2026-10-08T10:00:00.000Z');
const USER = testUserId(7);

const lead = { name: 'Dana Levi', email: 'dana@example.com', company: 'Acme Ltd', message: 'We receive 30 supplier files a month.', page: '/business' };
const waitlist = { email: 'dana@example.com', message: 'More formats, please.', trigger: 'savedFormats', page: '/formats' };
const feedback = { message: 'The preview is great.', page: '/result' };
const typed = /Dana|dana@|Acme|supplier|More formats|preview is great|\/business|\/formats|\/result/;

describe('usage events written by the forms', () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  async function setup(): Promise<{ events: MemoryEventStore; post(url: string, body: unknown, o?: { user?: string | null; token?: string }): Promise<{ status: number }> }> {
    const events = createMemoryEventStore();
    const turnstile = makeTurnstileFetch(['good']);
    app = await buildServer({
      env: makeEnv({ IP_HASH_SECRET: 'events-test-secret', TURNSTILE_SECRET_KEY: 'turnstile-secret' }),
      db: null,
      logger: false,
      store: createMemoryStore(() => NOW),
      contactStore: createMemoryContactStore(),
      eventStore: events,
      fetch: turnstile.fn,
      now: () => new Date(NOW),
      identify: stubIdentify,
    });
    const server = app;
    return {
      events,
      post: async (url, body, o = {}) => {
        const res = await server.inject({
          method: 'POST',
          url,
          remoteAddress: nextIp(),
          headers: { 'content-type': 'application/json', ...(o.user ? { 'x-test-user': o.user } : {}) },
          payload: JSON.stringify({ ...(body as object), ...(o.token ? { turnstileToken: o.token } : {}) }),
        });
        return { status: res.statusCode };
      },
    };
  }

  it('lead_submitted {kind: contact} for the business form - a visitor\'s with no id', async () => {
    const { events, post } = await setup();
    expect((await post('/api/leads', lead, { token: 'good' })).status).toBe(200);
    expect(events.events).toHaveLength(1);
    expect(events.events[0]).toEqual({ ts: NOW, type: 'lead_submitted', props: { kind: 'contact' } });
    expect(JSON.stringify(events.events)).not.toMatch(typed);
  });

  it('lead_submitted {kind: waitlist} and upgrade_intent {trigger} for the waitlist - a signed-in user\'s with their id', async () => {
    const { events, post } = await setup();
    expect((await post('/api/waitlist', waitlist, { user: USER })).status).toBe(200);
    expect(events.events.map((e) => [e.type, e.props, String(e.userId)])).toEqual([
      ['lead_submitted', { kind: 'waitlist' }, USER],
      ['upgrade_intent', { trigger: 'savedFormats' }, USER],
    ]);
    expect(JSON.stringify(events.events.map((e) => e.props))).not.toMatch(typed);
  });

  it('upgrade_intent says "other" when the form was not opened by a limit', async () => {
    const { events, post } = await setup();
    await post('/api/waitlist', { email: 'a@example.com', page: '/business' }, { token: 'good' });
    expect(events.events.map((e) => e.props)).toEqual([{ kind: 'waitlist' }, { trigger: 'other' }]);
    expect(events.events.every((e) => e.userId === undefined)).toBe(true);
  });

  it('feedback_given says only whether an answer was asked for - not the message, not the address', async () => {
    const { events, post } = await setup();
    expect((await post('/api/feedback', feedback, { user: USER })).status).toBe(200);
    expect((await post('/api/feedback', { ...feedback, email: 'dana@example.com' }, { user: USER })).status).toBe(200);
    expect(events.events.map((e) => [e.type, e.props])).toEqual([
      ['feedback_given', { replyRequested: false }],
      ['feedback_given', { replyRequested: true }],
    ]);
    expect(JSON.stringify(events.events)).not.toMatch(typed);
  });

  it('writes nothing for a submission that was refused: a bad body, a failed Turnstile, a rate limit', async () => {
    const { events, post } = await setup();
    expect((await post('/api/leads', { ...lead, email: 'nope' }, { token: 'good' })).status).toBe(400);
    expect((await post('/api/leads', lead, { token: 'bad' })).status).toBe(403);
    expect((await post('/api/waitlist', { email: '', page: '/x' }, { user: USER })).status).toBe(400);
    expect((await post('/api/feedback', { message: ' ', page: '/x' }, { user: USER })).status).toBe(400);
    expect(events.events).toEqual([]);
  });
});
