/**
 * Document interfaces for every MongoDB collection listed in SPEC.md section 13.
 * No file contents or cell values are ever stored here - only metadata, rules
 * (real constants only, after unmasking) and event props (counts/ids/codes).
 * `learn_cache` (SPEC 9.5) also holds rules: with masking off they can carry real constants
 * from one owner's data, so it is owner-scoped and TTL-expired - see `LearnCacheDoc`.
 */
import type { ObjectId } from 'mongodb';
import type { RepairProblem, SourceInputReading, SourceInputSignature, SourceStructure, Tier, Validation, ValueType } from '@formatai/shared';

export type AuthProvider = 'google' | 'microsoft';

export interface UserIdentity {
  provider: AuthProvider;
  subject: string;
  /** Microsoft only: tenant id (`tid`), combined with `subject` (`oid`) to identify the user. */
  tenantId?: string;
  email: string;
  emailVerified: boolean;
}

/** A signed-in user's tier (SPEC 11): new users are 'registered'; an admin sets 'paid' (M4). Not signed in = 'anonymous', which has no user. */
export type UserTier = Exclude<Tier, 'anonymous'>;

export interface UserDoc {
  _id?: ObjectId;
  identities: UserIdentity[];
  name?: string;
  avatarUrl?: string;
  uiLanguage?: string;
  tier: UserTier;
  createdAt: Date;
  lastSeenAt: Date;
  /** Anonymous ids attached to this user across sign-ins (SPEC 12). */
  anonIds: string[];
  limitOverrides?: Record<string, number>;
}

/**
 * A sign-in session (SPEC 12). `_id` is the SHA-256 (hex) of the random session id held in the signed cookie, so
 * a copy of this collection can't be used to take over a session. TTL-expired through `expiresAt`.
 */
export interface SessionDoc {
  _id: string;
  userId: ObjectId;
  createdAt: Date;
  lastSeenAt: Date;
  expiresAt: Date;
}

// ---- Registry (SPEC 8.12): a format has many conversions (one per source) ----

export type ConversionStatus = 'verified' | 'differencesAccepted' | 'userConfirmed' | 'draft' | 'needsReview';
export type LearnPath = 'local' | 'llm' | 'cache';
export type LearnSource = 'examplePair' | 'inputDescription' | 'descriptionOnly';

/**
 * An earlier version of a format. `FormatDoc.versions` holds the versions that were REPLACED (oldest first, at
 * most `limits.registry.maxVersions`); the current one lives in the document's own fields.
 */
export interface FormatVersion {
  version: number;
  /** The format side at that version: `{ output, layout, outputValidations }`. */
  format: unknown;
  editedBy?: ObjectId;
  /** When that version was saved. */
  at: Date;
}

/** The shape of a file the company produces. Kept as unknown here - validated in @formatai/shared. */
export interface FormatDoc {
  _id?: ObjectId;
  ownerId: ObjectId;
  name: string;
  schemaVersion: number;
  /** Rules `output` section (columns without `from`, layout, file). */
  output: unknown;
  /** sort and group normalized to output headers. */
  layout: unknown;
  /** Validations with `on: "output"`. */
  outputValidations: unknown[];
  origin: 'learned' | 'template';
  /** Starts at 1; every change to the output side (SPEC 8.12 "Editing a format") makes the next one. */
  version: number;
  versions: FormatVersion[];
  createdAt: Date;
  updatedAt: Date;
}

export interface InputColumnSignature {
  header: string;
  aliases: string[];
  type: string;
  required: boolean;
}

/**
 * An earlier version of a conversion (SPEC 8.11 "Saving": every save creates one; old ones can be restored).
 * `ConversionDoc.versions` holds the versions that were REPLACED (oldest first, at most
 * `limits.registry.maxVersions`); the current one lives in the document's own fields.
 */
export interface ConversionVersion {
  version: number;
  /** Full rules file (schema v1, SPEC 8). */
  rules: unknown;
  status: ConversionStatus;
  acceptedDifferences: number;
  editedBy?: ObjectId;
  /** When that version was saved. */
  at: Date;
}

/**
 * An earlier version of a source (SPEC 13 `sources.versions[{ source, editedBy, at }]`). `SourceDoc.versions` holds the
 * versions that were REPLACED (oldest first, at most `limits.registry.maxVersions`); the current one lives in the
 * document's own fields.
 */
export interface SourceVersionDoc {
  version: number;
  /** The structure at that version. */
  source: SourceStructure;
  editedBy?: ObjectId;
  /** When that version was saved. */
  at: Date;
}

/**
 * One kind of incoming file the company receives or keeps (SPEC 8.15, 13). STRUCTURE ONLY - headers, types, shapes, reading
 * options and input checks; never a value, a range or a sample read from data cells. Conversions link it to formats.
 */
export interface SourceDoc {
  _id?: ObjectId;
  ownerId: ObjectId;
  name: string;
  /** `nameKey(name)` (trimmed, spaces collapsed, lower-cased): what the unique (ownerId, nameKey) index runs on, so names are
   * unique per owner regardless of case (SPEC 13). Always written together with `name`. */
  nameKey: string;
  /** The union of the columns its conversions use, with aliases; `required` = required by at least one conversion. */
  inputSignature: SourceInputSignature;
  inputReading: SourceInputReading;
  inputValidations: Validation[];
  /** Starts at 1; every edit of the structure (SPEC 8.15 "Editing a source") makes the next one. */
  version: number;
  versions: SourceVersionDoc[];
  createdAt: Date;
  updatedAt: Date;
}

/** How one source becomes a format: a full, self-contained rules file. */
export interface ConversionDoc {
  _id?: ObjectId;
  ownerId: ObjectId;
  formatId: ObjectId;
  /** The source this conversion reads (SPEC 8.15, 13): required - a conversion is a link between a source and a format. The
   * source's own name is the only name (DECISION: no copy is kept here; `rules.meta.sourceName` inside the rules file is
   * informational and follows a rename). */
  sourceId: ObjectId;
  schemaVersion: number;
  rules: unknown;
  inputSignature: { columns: InputColumnSignature[] };
  source: LearnSource;
  status: ConversionStatus;
  acceptedDifferences: number;
  /** Example row numbers the user marked as fixed by hand; used only when checking the example. */
  exampleExceptions: number[];
  learnPath: LearnPath;
  masking: boolean;
  model?: string;
  promptVersion?: string;
  /** Starts at 1; every save (and every restore, and a format edit written to it) makes the next one. */
  version: number;
  versions: ConversionVersion[];
  runCount: number;
  lastRunAt?: Date;
  /** Counts of the last run - never rows or values. */
  lastRun?: { rows: number; flagged: number };
  createdAt: Date;
  updatedAt: Date;
}

export interface EventDoc {
  _id?: ObjectId;
  ts: Date;
  anonId?: string;
  userId?: ObjectId;
  type: string;
  /** Counts, ids and codes only - never cell values or file names. */
  props: Record<string, unknown>;
}

export type LlmCallPurpose = 'learn' | 'repair' | 'escalation';

export interface LlmCallDoc {
  _id?: ObjectId;
  ts: Date;
  userId?: ObjectId;
  anonId?: string;
  learnId: string;
  purpose: LlmCallPurpose;
  model: string;
  promptVersion: string;
  masking: boolean;
  tokensIn: number;
  tokensOut: number;
  tokensCached: number;
  costUsd: number;
  latencyMs: number;
  outcome: string;
  cacheHit: boolean;
  /** SPEC 9.2: counts only, never formula text or any other payload/response content -
   * so the product can track things like "how often models write invalid formulas"
   * straight from the ledger. */
  problemCounts: Record<RepairProblem['kind'], number>;
}

/**
 * Keys look like `user:<id>:<yyyy-mm>`, `anon:<id>:<yyyy-mm-dd>` or `ip:<hash>:<yyyy-mm-dd>`.
 * `expiresAt` is set for anon/ip keys (TTL-expired) and left unset for user keys.
 */
export interface UsageCounterDoc {
  _id?: ObjectId;
  key: string;
  count: number;
  expiresAt?: Date;
}

/** Spend totals per UTC day; one document per day. `anonSpendUsd` is the part spent on
 * anonymous (not signed in) learns - what the daily anonymous budget (SPEC 9.5) is checked against. */
export interface BudgetDoc {
  _id?: ObjectId;
  day: string;
  spendUsd: number;
  anonSpendUsd?: number;
}

/**
 * SPEC 9.5 `learn_cache`: saved rules per (owner, structure hash). The owner is `anon:<anonId>` now,
 * `user:<id>` from M3. DECISION: a cached entry is only ever returned to the SAME owner - rules can hold
 * constants derived from one user's data (value-map entries, filter values, labels), see
 * `protection/cache.ts`. TTL-expired through `createdAt` (config `limits.cache.ttlDays`).
 */
export interface LearnCacheDoc {
  _id?: ObjectId;
  owner: string;
  key: string;
  /** The rules as a JSON string: opaque to the database, and free of BSON field-name limits (value-map
   * keys are user text and may contain dots or a leading dollar sign). */
  rules: string;
  promptVersion: string;
  createdAt: Date;
}

/** Where a recorded function request stands. Only `new` is written today (the M4 admin adds the others: a threshold or a click turns a request into a GitHub issue). */
export type FunctionRequestStatus = 'new' | 'issueOpened' | 'approved' | 'declined';

/**
 * SPEC 13 `function_requests` (issue #40, learn-v7): one document per requested function, deduplicated on `key` (the normalized
 * name plus the signature). Holds NOTHING from any user's data: the request is value-filtered before it is written (`learn/notes.ts`),
 * and who asked is kept only as a set of hashed owner ids (`ownerHashes`, an HMAC under the server secret: the raw id is never
 * stored), which is what `distinctOwners` counts.
 */
export interface FunctionRequestDoc {
  _id?: ObjectId;
  /** `<normalized name>(<arg types>):<returns>`. Unique. */
  key: string;
  /** The name as first seen. */
  name: string;
  /** The purpose sentence as first seen. */
  purpose: string;
  args: { name: string; type: ValueType }[];
  returns: ValueType;
  /** A catalogue topic (extraction, cleanup, formatting, combining, logic, lookups, arithmetic, dates, acrossRows, rowOps, structure) guessed from the purpose words, or `unknown`. */
  topic: string;
  /** How many times it was recorded (once per learn answer that carried it). */
  count: number;
  /** How many different (hashed) owners asked: the size of `ownerHashes`. */
  distinctOwners: number;
  /** HMAC of the owner id (truncated), at most `limits.learn.functionRequests.maxOwnerHashes`. Never a raw id. */
  ownerHashes: string[];
  firstSeen: Date;
  lastSeen: Date;
  status: FunctionRequestStatus;
}

export interface LeadDoc {
  _id?: ObjectId;
  name: string;
  email: string;
  company?: string;
  role?: string;
  message?: string;
  language?: string;
  ts: Date;
}

export interface WaitlistDoc {
  _id?: ObjectId;
  userId?: ObjectId;
  email: string;
  trigger: string;
  message?: string;
  ts: Date;
}

export interface FeedbackDoc {
  _id?: ObjectId;
  formatId?: ObjectId;
  userId?: ObjectId;
  rating: number;
  text?: string;
  ts: Date;
}
