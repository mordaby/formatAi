// Leads and feedback in the admin view (SPEC 13 `leads`, `feedback`; 14.2 "Tables"): read-only lists of what people typed into our own forms.
//
// DECISION: read tolerantly. The two collections are written by the public pages (not by the admin view), and their documents may be the
// SPEC 13 shapes (`ts`, `text`, `rating`) or `{ createdAt, kind, email?, name?, company?, message, page? }`. Each document is read through
// a whitelist of fields (anything else a form stores - an address, a hash, a user agent - is never passed on), strings are capped, and
// a field of the wrong type is left out rather than guessed.
import { limits, type AdminContact } from '@formatai/shared';
import type { Document } from 'mongodb';
import type { AppDb } from '../db.js';

const FIELD_CHARS = 200;

function text(value: unknown, max = FIELD_CHARS): string | undefined {
  if (typeof value !== 'string') return undefined;
  const t = value.trim();
  return t === '' ? undefined : t.slice(0, max);
}

function date(value: unknown): Date | undefined {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  return undefined;
}

/** One stored document as the list shows it. */
export function normalizeContact(source: 'lead' | 'feedback', raw: Document): AdminContact {
  const createdAt = date(raw.createdAt) ?? date(raw.ts);
  const rating = typeof raw.rating === 'number' && Number.isFinite(raw.rating) ? raw.rating : undefined;
  const fields = {
    email: text(raw.email),
    name: text(raw.name),
    company: text(raw.company),
    role: text(raw.role),
    message: text(raw.message ?? raw.text, limits.admin.maxContactMessageChars),
    page: text(raw.page),
    language: text(raw.language, 10),
    ...(rating !== undefined ? { rating } : {}),
  };
  return {
    id: String(raw._id),
    source,
    createdAt: createdAt ? createdAt.toISOString() : null,
    kind: text(raw.kind, 40) ?? source,
    // (`undefined` fields are dropped by JSON; the type says they are optional)
    ...Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)),
  };
}

/** The newest leads and feedback together (`limits.admin.contactsListed` of each, then the newest of those), newest first. */
export async function listContacts(db: AppDb, source: 'lead' | 'feedback' | 'all'): Promise<AdminContact[]> {
  const n = limits.admin.contactsListed;
  const read = async (name: 'leads' | 'feedback', kind: 'lead' | 'feedback'): Promise<AdminContact[]> =>
    (await db.db.collection(name).find({}).sort({ _id: -1 }).limit(n).toArray()).map((d) => normalizeContact(kind, d));
  const [leads, feedback] = await Promise.all([source === 'feedback' ? [] : read('leads', 'lead'), source === 'lead' ? [] : read('feedback', 'feedback')]);
  return [...leads, ...feedback]
    .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))
    .slice(0, n);
}
