/**
 * Document interfaces for every MongoDB collection listed in SPEC.md section 13.
 * No file contents or cell values are ever stored here - only metadata, rules
 * (real constants only, after unmasking) and event props (counts/ids/codes).
 * `learn_cache` (SPEC 9.5) also holds rules: with masking off they can carry real constants
 * from one owner's data, so it is owner-scoped and TTL-expired - see `LearnCacheDoc`.
 */
import type { ObjectId } from 'mongodb';
import type { RepairProblem } from '@formatai/shared';

export type AuthProvider = 'google' | 'microsoft';

export interface UserIdentity {
  provider: AuthProvider;
  subject: string;
  /** Microsoft only: tenant id (`tid`), combined with `subject` (`oid`) to identify the user. */
  tenantId?: string;
  email: string;
  emailVerified: boolean;
}

export type UserTier = 'anonymous' | 'free' | 'paid';

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

// ---- Registry (SPEC 8.12): a format has many conversions (one per source) ----

export type ConversionStatus = 'verified' | 'differencesAccepted' | 'userConfirmed' | 'draft' | 'needsReview';
export type LearnPath = 'local' | 'llm' | 'cache';
export type LearnSource = 'examplePair' | 'inputDescription' | 'descriptionOnly';

export interface FormatVersion {
  /** The format side at that version (output, layout, outputValidations). */
  format: unknown;
  editedBy?: ObjectId;
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
  versions: FormatVersion[];
  createdAt: Date;
}

export interface InputColumnSignature {
  header: string;
  aliases: string[];
  type: string;
  required: boolean;
}

export interface ConversionVersion {
  /** Full rules file (schema v1, SPEC 8). */
  rules: unknown;
  editedBy?: ObjectId;
  at: Date;
}

/** How one source becomes a format: a full, self-contained rules file. */
export interface ConversionDoc {
  _id?: ObjectId;
  ownerId: ObjectId;
  formatId: ObjectId;
  sourceName: string;
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
  versions: ConversionVersion[];
  runCount: number;
  lastRunAt?: Date;
  createdAt: Date;
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
