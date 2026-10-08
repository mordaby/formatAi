// The web app's emitter of usage events (SPEC 14.1; owner decision 2026-10-08): `track(type, props)` says that something happened that only the
// browser knows - a page was viewed, a learn ended, a file was turned away, which formats were ticked, a download.
//
// PRIVACY (SPEC 2, 15): what is sent is counts, codes and ids ONLY. Every event is checked against the same strict schema the server
// checks it with (shared `EVENT_PROPS`) BEFORE it is queued, so a prop nobody listed - a file name, a header - is dropped here and never
// leaves the browser, whatever the call site passed. There is no field that takes free text, and no method that takes a file.
//
// BEHAVIOUR: `track` never blocks, never throws and never waits for the network. Events are queued and sent as ONE request a moment later
// (`limits.events.client.flushDebounceMs`; a burst of events is one request), at most `limits.events.maxPerRequest` per request, and at once
// when the page is hidden or left (`visibilitychange`, `pagehide`; `fetch` with `keepalive`, so the browser finishes the request after the
// page is gone). A request that fails is not retried: an event is a count, and losing a few is better than a queue that grows. The queue is capped
// (`limits.events.client.maxQueued`): past it a new event is dropped. Who the events belong to is the server's business (the session cookie
// rides along; a visitor's events are stored with no id).
import { limits, parseEvent, CLIENT_EVENT_TYPES, type ClientEventType, type EventInput } from '@formatai/shared';
import { webConfig } from '../config';

/** Says that something happened. Fire and forget. */
export type Track = <T extends ClientEventType>(type: T, props: EventInput<T>) => void;

export interface EventsApi {
  track: Track;
  /** Sends what is queued, now (the page is being hidden or left). */
  flush(): void;
}

export interface CreateEventsOptions {
  baseUrl?: string;
  /** Injectable for tests. */
  fetch?: typeof fetch;
  /** Timers, injectable for tests (default: the global ones). */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  /** The page whose visibility is watched (default: the global `document` and `window`, when there are any). */
  page?: { document: Pick<Document, 'addEventListener' | 'removeEventListener' | 'visibilityState'>; window?: Pick<Window, 'addEventListener' | 'removeEventListener'> } | null;
  debounceMs?: number;
  maxQueued?: number;
}

/** What goes into a request: the type and the checked props, nothing else. */
interface Queued {
  type: ClientEventType;
  props: Record<string, unknown>;
}

export function createEvents(options: CreateEventsOptions = {}): EventsApi & { dispose(): void } {
  const url = `${options.baseUrl ?? webConfig.apiBaseUrl}/api/events`;
  const doFetch: typeof fetch | undefined = options.fetch ?? (typeof fetch === 'function' ? (input, init) => fetch(input, init) : undefined);
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = options.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const debounceMs = options.debounceMs ?? limits.events.client.flushDebounceMs;
  const maxQueued = options.maxQueued ?? limits.events.client.maxQueued;

  let queue: Queued[] = [];
  let timer: unknown = null;
  let listening: (() => void) | null = null;

  function send(batch: Queued[]): void {
    if (!doFetch || batch.length === 0) return;
    try {
      // `credentials: 'include'`: the session cookie decides whose they are (a visitor has none, and their events are stored with no id).
      // `keepalive`: the request outlives the page when it is sent as the page is hidden.
      void doFetch(url, {
        method: 'POST',
        credentials: 'include',
        keepalive: true,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ events: batch }),
      }).then(
        () => undefined,
        () => undefined,
      );
    } catch {
      // Never into the UI.
    }
  }

  function flush(): void {
    try {
      if (timer !== null) {
        clearTimer(timer);
        timer = null;
      }
      const all = queue;
      queue = [];
      for (let i = 0; i < all.length; i += limits.events.maxPerRequest) send(all.slice(i, i + limits.events.maxPerRequest));
    } catch {
      queue = [];
    }
  }

  /** Watches the page once, on the first event: a hidden or left page sends what waits. */
  function listen(): void {
    if (listening) return;
    const page = options.page === undefined ? (typeof document !== 'undefined' ? { document, window: typeof window !== 'undefined' ? window : undefined } : null) : options.page;
    if (!page) return;
    const onHide = (): void => {
      if (page.document.visibilityState === 'hidden') flush();
    };
    const onLeave = (): void => flush();
    page.document.addEventListener('visibilitychange', onHide);
    page.window?.addEventListener('pagehide', onLeave);
    listening = () => {
      page.document.removeEventListener('visibilitychange', onHide);
      page.window?.removeEventListener('pagehide', onLeave);
    };
  }

  const track: Track = (type, props) => {
    try {
      // The same strict check as the server's: anything not listed is dropped here, before it can be queued, let alone sent.
      const event = parseEvent({ type, props }, CLIENT_EVENT_TYPES);
      if (!event) return;
      if (queue.length >= maxQueued) return;
      queue.push({ type: event.type as ClientEventType, props: { ...event.props } });
      listen();
      // The window starts with the first event and does not move: a stream of events cannot hold the first one back for ever.
      if (timer === null) timer = setTimer(flush, debounceMs);
    } catch {
      // Never into the UI.
    }
  };

  return {
    track,
    flush,
    dispose() {
      listening?.();
      listening = null;
      if (timer !== null) clearTimer(timer);
      timer = null;
      queue = [];
    },
  };
}
