// The usage-event emitter (SPEC 14.1; owner decision 2026-10-08): what `track` queues, when it sends, and what it never does. A fake `fetch`, fake
// timers and a fake page: nothing leaves the test.
import { limits } from '@formatai/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApi } from '../src/api';
import { createEvents, type CreateEventsOptions } from '../src/api/events';

/** A page whose visibility a test can change. */
function fakePage() {
  const listeners = new Map<string, Set<() => void>>();
  const target = {
    addEventListener: (type: string, fn: () => void) => void (listeners.get(type) ?? listeners.set(type, new Set()).get(type)!).add(fn),
    removeEventListener: (type: string, fn: () => void) => void listeners.get(type)?.delete(fn),
  };
  const document = { ...target, visibilityState: 'visible' as DocumentVisibilityState };
  return {
    document,
    window: target,
    count: (type: string) => listeners.get(type)?.size ?? 0,
    fire: (type: string) => listeners.get(type)?.forEach((fn) => fn()),
    hide() {
      document.visibilityState = 'hidden';
      this.fire('visibilitychange');
    },
  };
}

interface Sent {
  url: string;
  init: RequestInit;
  events: { type: string; props: Record<string, unknown> }[];
}

function setup(over: CreateEventsOptions = {}) {
  vi.useFakeTimers();
  const sent: Sent[] = [];
  const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: String(url), init: init ?? {}, events: (JSON.parse(String(init?.body)) as { events: Sent['events'] }).events });
    return new Response(null, { status: 204 });
  }) as unknown as typeof fetch;
  const page = fakePage();
  const events = createEvents({ baseUrl: 'https://api.example', fetch: fetchFn, page: page as unknown as CreateEventsOptions['page'], ...over });
  return { events, sent, fetchFn: fetchFn as unknown as ReturnType<typeof vi.fn>, page };
}

afterEach(() => {
  vi.useRealTimers();
});

const view = { page: 'home' } as const;

describe('track', () => {
  it('sends nothing at once: the event waits for the short window, then goes in ONE request', async () => {
    const { events, sent } = setup();
    events.track('page_view', view);
    events.track('download', { kind: 'zip' });
    expect(sent).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(limits.events.client.flushDebounceMs - 1);
    expect(sent).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.events).toEqual([
      { type: 'page_view', props: { page: 'home' } },
      { type: 'download', props: { kind: 'zip' } },
    ]);
  });

  it('posts JSON to /api/events with the cookies and keepalive, and nothing else in the body', async () => {
    const { events, sent } = setup();
    events.track('page_view', view);
    await vi.advanceTimersByTimeAsync(limits.events.client.flushDebounceMs);
    const [request] = sent;
    expect(request!.url).toBe('https://api.example/api/events');
    expect(request!.init.method).toBe('POST');
    expect(request!.init.credentials).toBe('include');
    expect(request!.init.keepalive).toBe(true);
    expect(request!.init.headers).toEqual({ 'content-type': 'application/json' });
    expect(Object.keys(JSON.parse(String(request!.init.body)))).toEqual(['events']);
  });

  it('starts the window with the first event and does not move it: a stream of events cannot hold the first back for ever', async () => {
    const { events, sent } = setup();
    events.track('page_view', view);
    await vi.advanceTimersByTimeAsync(limits.events.client.flushDebounceMs - 500);
    events.track('page_view', { page: 'formats' });
    await vi.advanceTimersByTimeAsync(500);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.events).toHaveLength(2);
    // a new event starts a new window
    events.track('page_view', { page: 'convert' });
    await vi.advanceTimersByTimeAsync(limits.events.client.flushDebounceMs);
    expect(sent).toHaveLength(2);
  });

  it('sends at once when the page is hidden, and not when it becomes visible again', async () => {
    const { events, sent, page } = setup();
    events.track('page_view', view);
    page.hide();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.init.keepalive).toBe(true);
    // nothing is sent twice: the window's timer is gone
    await vi.advanceTimersByTimeAsync(limits.events.client.flushDebounceMs * 2);
    expect(sent).toHaveLength(1);
    page.document.visibilityState = 'visible';
    page.fire('visibilitychange');
    expect(sent).toHaveLength(1);
  });

  it('also sends when the page is left (pagehide)', async () => {
    const { events, sent, page } = setup();
    events.track('download', { kind: 'single' });
    page.fire('pagehide');
    expect(sent).toHaveLength(1);
  });

  it('sends nothing for an empty queue', async () => {
    const { events, sent, page } = setup();
    events.flush();
    events.track('page_view', view);
    page.hide();
    page.hide();
    expect(sent).toHaveLength(1);
  });

  it(`sends at most ${limits.events.maxPerRequest} events in a request and the rest in the next`, async () => {
    const { events, sent } = setup();
    for (let i = 0; i < limits.events.maxPerRequest + 5; i++) events.track('page_view', view);
    events.flush();
    expect(sent.map((s) => s.events.length)).toEqual([limits.events.maxPerRequest, 5]);
  });

  it(`drops a new event when ${limits.events.client.maxQueued} are waiting already`, async () => {
    const { events, sent } = setup();
    for (let i = 0; i < limits.events.client.maxQueued + 40; i++) events.track('page_view', view);
    events.flush();
    expect(sent.reduce((n, s) => n + s.events.length, 0)).toBe(limits.events.client.maxQueued);
  });

  it('takes its limits from the options too', async () => {
    const { events, sent } = setup({ maxQueued: 2, debounceMs: 50 });
    events.track('page_view', view);
    events.track('page_view', view);
    events.track('page_view', view);
    await vi.advanceTimersByTimeAsync(50);
    expect(sent[0]!.events).toHaveLength(2);
  });
});

describe('what never leaves the browser', () => {
  it('drops an event with a prop nobody listed, a free string or a number out of range - before it is queued', async () => {
    const { events, sent, page } = setup();
    // (the types stop most of these at compile time; a caller that casts, or a bug, must still send nothing)
    const track = events.track as (type: string, props: unknown) => void;
    track('file_rejected', { reason: 'type', fileName: 'Quarterly orders.xlsx' });
    track('file_rejected', { reason: 'Quarterly orders.xlsx' });
    track('file_uploaded', { role: 'input', fileType: 'csv', rows: -1, cols: 2 });
    track('learn_completed', { path: 'local', status: 'verified', masking: true, aiClicked: false, headers: ['Name', 'Amount'] });
    track('no_such_event', {});
    track('format_saved', { kind: 'new' }); // a server-only event
    track('page_view', '/formats/65f0c2a1b3d4e5f607182930');
    track('page_view', null);
    page.hide();
    expect(sent).toHaveLength(0);
  });

  it('keeps only what the schema lists', async () => {
    const { events, sent, page } = setup();
    events.track('file_matched', { result: 'choose', score: 0.8567 });
    page.hide();
    expect(sent[0]!.events).toEqual([{ type: 'file_matched', props: { result: 'choose', score: 0.86 } }]);
  });
});

describe('it never gets in the way', () => {
  it('does not throw when fetch throws, rejects or is missing, and does not wait for it', async () => {
    const throwing = setup({ fetch: (() => {
      throw new Error('blocked');
    }) as unknown as typeof fetch });
    throwing.events.track('page_view', view);
    expect(() => throwing.events.flush()).not.toThrow();

    const rejecting = setup({ fetch: vi.fn(async () => {
      throw new TypeError('network');
    }) as unknown as typeof fetch });
    rejecting.events.track('page_view', view);
    expect(() => rejecting.events.flush()).not.toThrow();
    await vi.advanceTimersByTimeAsync(10);

    vi.stubGlobal('fetch', undefined);
    try {
      const missing = createEvents({ page: null });
      expect(() => {
        missing.track('page_view', view);
        missing.flush();
      }).not.toThrow();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('does not retry a failed request: an event is a count, and the queue does not grow', async () => {
    const failing = vi.fn(async () => new Response('no', { status: 500 })) as unknown as typeof fetch;
    const { events, fetchFn } = setup({ fetch: failing });
    events.track('page_view', view);
    events.flush();
    await vi.advanceTimersByTimeAsync(limits.events.client.flushDebounceMs * 5);
    expect(failing).toHaveBeenCalledTimes(1);
    void fetchFn;
  });

  it('does not throw for any input, and a failing timer or page does not reach the caller', () => {
    const { events } = setup({
      setTimer: () => {
        throw new Error('no timers');
      },
    });
    expect(() => events.track('page_view', view)).not.toThrow();
    const broken = createEvents({
      page: {
        document: {
          addEventListener() {
            throw new Error('no page');
          },
          removeEventListener() {},
          visibilityState: 'visible',
        },
      },
      fetch: vi.fn() as unknown as typeof fetch,
    });
    expect(() => broken.track('page_view', view)).not.toThrow();
  });

  it('dispose() takes the listeners and the queue away', async () => {
    const { events, sent, page } = setup();
    events.track('page_view', view);
    expect(page.count('visibilitychange')).toBe(1);
    expect(page.count('pagehide')).toBe(1);
    events.dispose();
    expect(page.count('visibilitychange')).toBe(0);
    expect(page.count('pagehide')).toBe(0);
    await vi.advanceTimersByTimeAsync(limits.events.client.flushDebounceMs * 2);
    expect(sent).toHaveLength(0);
  });

  it('listens to the page only once, however many events', () => {
    const { events, page } = setup();
    for (let i = 0; i < 5; i++) events.track('page_view', view);
    expect(page.count('visibilitychange')).toBe(1);
  });
});

describe('the API client carries it', () => {
  it('offers events on the Api object, where the other clients are, and sends to its base URL through the injected fetch', async () => {
    vi.useFakeTimers();
    const fetchFn = vi.fn(async () => new Response(null, { status: 204 })) as unknown as typeof fetch;
    const api = createApi({ baseUrl: 'https://api.example', fetch: fetchFn });
    api.events.track('page_view', view);
    api.events.flush();
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect((fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toBe('https://api.example/api/events');
    api.events.flush();
  });
});
