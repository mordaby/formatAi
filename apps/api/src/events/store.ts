// Where the usage events are kept (SPEC 13 `events`): behind one small interface, so the route logic is the same against real MongoDB and
// against the in-memory store used by tests and by dev runs with no database.
import type { AppDb } from '../db.js';
import type { EventDoc } from '../models.js';

export interface EventStore {
  /** Writes the events (one batch from one request). */
  insertMany(docs: EventDoc[]): Promise<void>;
}

export function createMongoEventStore(appDb: AppDb): EventStore {
  return {
    async insertMany(docs) {
      if (docs.length === 0) return;
      // (ordered: false - one bad document must not stop the rest of the batch)
      await appDb.events.insertMany(docs.map((d) => ({ ...d })), { ordered: false });
    },
  };
}

/** In-memory: lost on restart. Tests and dev without MONGODB_URI only (production requires a database). */
export interface MemoryEventStore extends EventStore {
  readonly events: EventDoc[];
}

export function createMemoryEventStore(): MemoryEventStore {
  const events: EventDoc[] = [];
  return {
    events,
    async insertMany(docs) {
      for (const d of docs) events.push({ ...d });
    },
  };
}
