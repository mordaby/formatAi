// The beta usage events (SPEC 14.1; owner decision 2026-10-08): what the owner sees of how testers use the product. The `events` collection
// (SPEC 13) holds `{ ts, userId?, type, props }`; this file is the whitelist of what `props` may be, per type.
//
// PRIVACY (SPEC 15, non-negotiable): props are counts, codes and ids ONLY - a number in a small range, a boolean, a value from a closed list
// (never a free string), a rounded score, at most an ObjectId-shaped format id. There is no field here that could hold a file name, a column
// name, a header or a cell value, and every schema is STRICT: anything not listed is rejected (the server then drops the event, so a client
// that sends more than it should - by mistake or on purpose - stores nothing of it).
//
// Two sources, told apart by the type:
//   - SERVER events are written by the API where the action happens (`format_saved`, `format_run`, `limit_hit`, `feedback_given`,
//     `lead_submitted`, `upgrade_intent`); the client is not trusted for these, and `POST /api/events` refuses them.
//   - CLIENT events are what only the browser knows (`page_view`, `learn_completed`, ...); they arrive through `POST /api/events`.
//
// The time of an event is the server's (`ts`), never a client's. Who it belongs to is the session's: a signed-in user's events carry their
// `userId`; a visitor's carry NO id at all (no anonId, no IP - pure counts; SPEC 14.1, 20.18).
import { z } from 'zod';
import { LIMIT_CODES } from './codes';
import { limits } from './config/limits';
import { WAITLIST_TRIGGERS } from './contact';

// ---------------------------------------------------------------- the small vocabularies

/** `page_view.page`: a route NAME, never the path or the query (a path can carry a format id). */
export const PAGE_NAMES = ['home', 'learn', 'formats', 'format', 'convert', 'business', 'privacy', 'terms', 'accessibility', 'admin', 'other'] as const;
export type PageName = (typeof PAGE_NAMES)[number];

/**
 * The route name of a pathname. Only the first segment decides, so nothing after it (an id, a file name) is ever looked at. `/batch` is the Run
 * screen's old address; `/result` is the Learn screen's result (the learn itself is on Home).
 */
export function pageNameOf(pathname: string): PageName {
  const segments = pathname.split(/[?#]/, 1)[0]!.split('/').filter(Boolean);
  const first = segments[0] ?? '';
  switch (first) {
    case '':
      return 'home';
    case 'result':
      return 'learn';
    case 'formats':
      return segments.length > 1 ? 'format' : 'formats';
    case 'convert':
    case 'batch':
      return 'convert';
    case 'business':
    case 'privacy':
    case 'terms':
    case 'accessibility':
    case 'admin':
      return first;
    default:
      return 'other';
  }
}

/** `file_uploaded.fileType`: from the file's extension only. */
export const EVENT_FILE_TYPES = ['xlsx', 'xls', 'csv', 'txt'] as const;
export type EventFileType = (typeof EVENT_FILE_TYPES)[number];

/** A count kept within what a prop may hold (a file with more rows than any plan allows is still reported, as the most there can be). */
export const capCount = (n: number): number => Math.max(0, Math.min(limits.events.maxCount, Math.round(n)));
/** A small count (columns, files, formats) kept within what a prop may hold. */
export const capSmall = (n: number): number => Math.max(0, Math.min(limits.events.maxSmallCount, Math.round(n)));

/** The file type of a file name (its extension, lower-cased), or null when it is none we read. Only the extension is looked at; the name is not kept. */
export function fileTypeOfName(name: string): EventFileType | null {
  const dot = name.lastIndexOf('.');
  const ext = dot < 0 ? '' : name.slice(dot + 1).toLowerCase();
  return (EVENT_FILE_TYPES as readonly string[]).includes(ext) ? (ext as EventFileType) : null;
}

/**
 * `file_rejected.reason`: why a file was turned away. `type` / `size` are the drop zone's, `unreadable` / `noTable` the reader's (the Run screen and
 * the drop zones); the rest are the engine's table checks that reject a file at Learn (SPEC 6.1 `TableIssueCode`, severity `reject`).
 */
export const FILE_REJECT_REASONS = ['type', 'size', 'unreadable', 'noTable', 'noHeaderRow', 'multipleTables', 'mergedHeader', 'splitHeader', 'tooFewDataRows', 'onlyDrawings', 'emptySheet'] as const;
export type FileRejectReason = (typeof FILE_REJECT_REASONS)[number];

/**
 * `learn_completed.status`: how a learn ended, as the browser's own full verification and the learn flow say it (SPEC 5 A):
 * `verified` - rules that make the whole example; `failed` - rules that do not (the same word as the outcome report, `verified` | `failed`);
 * `partial` - the free engine's partial result, shown before the AI step; `blocked` - pre-flight stopped it (SPEC 6.3); `notReady` - the AI
 * readiness gate stopped the AI step; `error` - no result (an API error, a network error, rules nobody could learn).
 */
export const LEARN_COMPLETED_STATUSES = ['verified', 'failed', 'partial', 'blocked', 'notReady', 'error'] as const;
export type LearnCompletedStatus = (typeof LEARN_COMPLETED_STATUSES)[number];

/** `learn_completed.path`: which way the rules came: the free engine, the AI step, or the owner's structure cache (SPEC 9.5). */
export const LEARN_PATHS = ['local', 'llm', 'cache'] as const;

/** The answers to "You already have this format" (`same`) and to "This output matches your format" (`anotherInput`): their buttons. */
export const KNOWN_FORMAT_ANSWERS = {
  same: ['convert', 'learnAnyway', 'chooseOther'],
  anotherInput: ['yes', 'no', 'chooseOther'],
} as const;

/** `signin_wall_shown.trigger`: why the wall opened (the web app's `SignInReason`). */
export const SIGN_IN_WALL_TRIGGERS = ['save', 'download', 'keepGoing', 'ai', 'formats', 'expired'] as const;
export type SignInWallTrigger = (typeof SIGN_IN_WALL_TRIGGERS)[number];

/** `file_matched.result`: the Run screen's matching of one file against the user's input files: one clear winner, a choice, or none. */
export const FILE_MATCH_RESULTS = ['auto', 'choose', 'none'] as const;

/** `download.kind`: a single converted file, a zip, a batch's summary sheet, one file of a batch, or the learn result. */
export const DOWNLOAD_KINDS = ['single', 'zip', 'summary', 'batchFile', 'learnResult'] as const;
export type DownloadKind = (typeof DOWNLOAD_KINDS)[number];

/** `format_saved.kind` (set by the API from the route that saved): a new format, another input of one, a new version from Learn's Save, an editor save. */
export const FORMAT_SAVED_KINDS = ['new', 'anotherInput', 'update', 'edit'] as const;
export type FormatSavedKind = (typeof FORMAT_SAVED_KINDS)[number];

/** `lead_submitted.kind`: the "For business" form or the paid waitlist. */
export const LEAD_KINDS = ['contact', 'waitlist'] as const;

// ---------------------------------------------------------------- the schemas

const count = z.number().int().min(0).max(limits.events.maxCount);
const small = z.number().int().min(0).max(limits.events.maxSmallCount);
const flag = z.boolean();
/** A score of 0..1, kept to two decimals (a finer one says nothing more and is rounded here, not refused). */
export const roundScore = (n: number): number => Math.round(n * 100) / 100;
const score = z.number().min(0).max(1).transform(roundScore);

const strict = z.strictObject;

/** The props of every event type, strict: an unknown key, a string outside its list or a number out of range makes the whole event invalid. */
export const EVENT_PROPS = {
  // ---- written by the API ----
  format_saved: strict({ kind: z.enum(FORMAT_SAVED_KINDS) }),
  format_run: strict({ daysSinceCreated: z.number().int().min(0).max(limits.events.maxDaysSinceCreated), rows: count, flagged: count }),
  limit_hit: strict({ limit: z.enum(LIMIT_CODES) }),
  feedback_given: strict({ replyRequested: flag }),
  lead_submitted: strict({ kind: z.enum(LEAD_KINDS) }),
  upgrade_intent: strict({ trigger: z.enum(WAITLIST_TRIGGERS) }),

  // ---- sent by the browser ----
  page_view: strict({ page: z.enum(PAGE_NAMES) }),
  file_rejected: strict({ reason: z.enum(FILE_REJECT_REASONS) }),
  // (`rows` / `cols` are left out when the worker found no table in the file: not a 0, which would claim an empty one)
  file_uploaded: strict({ role: z.enum(['input', 'output', 'run']), fileType: z.enum(EVENT_FILE_TYPES), rows: count.optional(), cols: small.optional() }),
  learn_completed: strict({ path: z.enum(LEARN_PATHS), status: z.enum(LEARN_COMPLETED_STATUSES), masking: flag, aiClicked: flag }),
  known_format: z.discriminatedUnion('kind', [
    strict({ kind: z.literal('same'), answer: z.enum(KNOWN_FORMAT_ANSWERS.same) }),
    strict({ kind: z.literal('anotherInput'), answer: z.enum(KNOWN_FORMAT_ANSWERS.anotherInput) }),
  ]),
  signin_wall_shown: strict({ trigger: z.enum(SIGN_IN_WALL_TRIGGERS) }),
  // (`score` is left out when nothing matched)
  file_matched: strict({ result: z.enum(FILE_MATCH_RESULTS), score: score.optional() }),
  formats_chosen: strict({ offered: small, chosen: small, all: flag, batch: flag }),
  download: strict({ kind: z.enum(DOWNLOAD_KINDS) }),
  batch_run: strict({ files: small, converted: small, needsAttention: small, noMatch: small, notChosen: small }),
} as const;

export type EventType = keyof typeof EVENT_PROPS;

/** The events the API writes itself. */
export const SERVER_EVENT_TYPES = ['format_saved', 'format_run', 'limit_hit', 'feedback_given', 'lead_submitted', 'upgrade_intent'] as const satisfies readonly EventType[];
export type ServerEventType = (typeof SERVER_EVENT_TYPES)[number];

/** The events the browser sends through `POST /api/events`: every type that is not a server event. */
export const CLIENT_EVENT_TYPES = [
  'page_view',
  'file_rejected',
  'file_uploaded',
  'learn_completed',
  'known_format',
  'signin_wall_shown',
  'file_matched',
  'formats_chosen',
  'download',
  'batch_run',
] as const satisfies readonly EventType[];
export type ClientEventType = (typeof CLIENT_EVENT_TYPES)[number];

/** What a caller passes for an event of type `T` (a score is rounded on the way in). */
export type EventInput<T extends EventType> = z.input<(typeof EVENT_PROPS)[T]>;
/** What is stored for it. */
export type EventProps<T extends EventType> = z.output<(typeof EVENT_PROPS)[T]>;

/** An event as stored: its type and its checked props. */
export type UsageEvent = { [T in EventType]: { type: T; props: EventProps<T> } }[EventType];

/** An event as the browser sends it. */
export interface ClientEventRequest {
  type: ClientEventType;
  props: Record<string, unknown>;
}

/** `POST /api/events` body. */
export interface PostEventsRequest {
  events: ClientEventRequest[];
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * One event, checked against its type's schema; null for anything that is not exactly an event of a type in `allowed` (an unknown type, a server
 * event from the browser, an extra key, a value outside its list or range). The result holds only what the schema lists.
 */
export function parseEvent(raw: unknown, allowed: readonly EventType[]): UsageEvent | null {
  if (!isRecord(raw) || typeof raw.type !== 'string' || !(allowed as readonly string[]).includes(raw.type)) return null;
  const type = raw.type as EventType;
  const parsed = EVENT_PROPS[type].safeParse(raw.props ?? {});
  return parsed.success ? ({ type, props: parsed.data } as UsageEvent) : null;
}

/**
 * The events of a `POST /api/events` body: at most `limits.events.maxPerRequest` are looked at (the rest are dropped), an invalid one is dropped
 * without costing the others. `dropped` counts everything that did not make it. A body that is not `{ events: [...] }` has none.
 */
export function parseClientEvents(body: unknown): { events: UsageEvent[]; dropped: number } {
  if (!isRecord(body) || !Array.isArray(body.events)) return { events: [], dropped: 0 };
  const looked = body.events.slice(0, limits.events.maxPerRequest);
  const events: UsageEvent[] = [];
  for (const raw of looked) {
    const event = parseEvent(raw, CLIENT_EVENT_TYPES);
    if (event) events.push(event);
  }
  return { events, dropped: body.events.length - events.length };
}
