// Where the public forms are kept (SPEC 13 `leads` and `feedback`): behind one small interface, so the route logic is the same
// against real MongoDB and against the in-memory store used by tests and by dev runs with no database.
import type { AppDb } from '../db.js';
import type { FeedbackDoc, LeadDoc } from '../models.js';

export interface ContactStore {
  /** A business lead or a waitlist entry (both live in `leads`, told apart by `kind`). */
  insertLead(doc: LeadDoc): Promise<void>;
  insertFeedback(doc: FeedbackDoc): Promise<void>;
}

export function createMongoContactStore(appDb: AppDb): ContactStore {
  return {
    async insertLead(doc) {
      await appDb.leads.insertOne({ ...doc });
    },
    async insertFeedback(doc) {
      await appDb.feedback.insertOne({ ...doc });
    },
  };
}

/** In-memory: lost on restart. Tests and dev without MONGODB_URI only (production requires a database). */
export interface MemoryContactStore extends ContactStore {
  readonly leads: LeadDoc[];
  readonly feedback: FeedbackDoc[];
}

export function createMemoryContactStore(): MemoryContactStore {
  const leads: LeadDoc[] = [];
  const feedback: FeedbackDoc[] = [];
  return {
    leads,
    feedback,
    async insertLead(doc) {
      leads.push({ ...doc });
    },
    async insertFeedback(doc) {
      feedback.push({ ...doc });
    },
  };
}
