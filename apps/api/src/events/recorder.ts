// Writing the usage events (SPEC 14.1, 13 `events`; owner decision 2026-10-08): one place that decides WHAT is stored and for WHOM.
//
//   what - only a checked event: its type and its props passed through the shared strict schema (`EVENT_PROPS`), so a prop nobody listed, a free
//          string or a number out of range never reaches the database, whoever sends it;
//   when - the SERVER's clock (`now`), never a client's;
//   whom - the signed-in user (`userId`), or NOBODY: a visitor's event is stored with no id at all - no anonId, no IP, nothing that links
//          two events to one browser (DECISION, owner's privacy stance; SPEC 14.1, 15, 20.18).
//
// Recording is best effort: an event that cannot be written is logged by its error name and forgotten - it must never turn the user's
// save, run or form into an error.
import { parseEvent, SERVER_EVENT_TYPES, type EventInput, type ServerEventType, type UsageEvent } from '@formatai/shared';
import type { FastifyRequest } from 'fastify';
import type { EventDoc } from '../models.js';
import { identityOf, type Identity } from '../protection/identity.js';
import { objectIdOf } from '../registry/ids.js';
import type { EventStore } from './store.js';

export interface EventRecorder {
  /** Records an event the API itself writes, for the caller of `req`. Never throws. */
  record<T extends ServerEventType>(req: FastifyRequest, type: T, props: EventInput<T>): Promise<void>;
  /** Records events that were already checked (the browser's batch, `POST /api/events`), for the caller of `req`. Never throws. */
  recordChecked(req: FastifyRequest, events: readonly UsageEvent[]): Promise<void>;
}

export interface EventRecorderOptions {
  store: EventStore;
  now: () => Date;
  /** Who is calling (default: `identityOf`, the session). */
  identify?: ((req: FastifyRequest) => Identity) | undefined;
  /** Where a failure is logged (the error's name only). */
  warn?: ((message: string) => void) | undefined;
}

export function createEventRecorder(opts: EventRecorderOptions): EventRecorder {
  const identify = opts.identify ?? identityOf;

  /** The signed-in user's id, or undefined for a visitor (whose events are stored without any). */
  const owner = (req: FastifyRequest): ReturnType<typeof objectIdOf> => {
    const identity = identify(req);
    return identity.kind === 'user' ? objectIdOf(identity.userId) : undefined;
  };

  async function write(req: FastifyRequest, events: readonly UsageEvent[]): Promise<void> {
    if (events.length === 0) return;
    try {
      const userId = owner(req);
      const ts = opts.now();
      const docs: EventDoc[] = events.map((e) => ({ ts: new Date(ts), ...(userId ? { userId } : {}), type: e.type, props: { ...e.props } }));
      await opts.store.insertMany(docs);
    } catch (err) {
      opts.warn?.(`recording usage events failed (${err instanceof Error ? err.name : 'unknown'})`);
    }
  }

  return {
    async record(req, type, props) {
      // (the same strict check the browser's events pass: a bug that passes a prop nobody listed stores nothing)
      const event = parseEvent({ type, props }, SERVER_EVENT_TYPES);
      if (!event) {
        opts.warn?.(`a usage event of type ${type} was refused by its schema`);
        return;
      }
      await write(req, [event]);
    },
    recordChecked: write,
  };
}
