// Wire types of the admin API (SPEC 14.2, M4): /api/admin/*, admins only (401 `signInRequired`, 403 `forbidden`). Type-only, like `api.ts`.
//
// Counts, ids, codes and the value-free function requests only: the server holds no file contents, and no payload (masked or not),
// secret or `llm_calls` text is ever sent here. A lead's or feedback's message is what that person typed into our own form.
import type { AuthProviderId } from './api';
import type { AiLearnPeriod } from './config/tiers';

/** The time ranges of the overview (`limits.admin.periodsDays`). */
export type AdminPeriodDays = 7 | 30 | 90;

/** One UTC day of the overview: AI calls that day and their estimated cost (null: no call that day had a priced model). */
export interface AdminDayRow {
  /** `yyyy-mm-dd`, UTC. */
  day: string;
  aiCalls: number;
  costUsd: number | null;
}

/** One model's calls in the period; `costUsd` null when none of its calls has an estimate (an unpriced model: never a guess). */
export interface AdminModelRow {
  model: string;
  calls: number;
  /** Our own estimate of the tokens (`llm_calls.estimate`), a count - never text. */
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  /** Calls with no estimated cost (an unpriced model, or a call written before estimates existed). */
  unpriced: number;
}

/** GET /api/admin/overview?days=7|30|90 */
export interface AdminOverview {
  days: number;
  /** First and last UTC day shown (`yyyy-mm-dd`); the last one is today. */
  from: string;
  to: string;
  users: {
    total: number;
    registered: number;
    paid: number;
    /** Signed up in the period. */
    newInPeriod: number;
    /** Last seen in the period (`lastSeenAt` is renewed at most once an hour). */
    activeInPeriod: number;
  };
  learns: {
    /** Learns that reached a model (distinct `learnId` with at least one real call). */
    ai: number;
    /** An AI learn whose server checks passed (a call ended `verified`). The browser's own verdict is not kept in the ledger. */
    aiVerified: number;
    /** Answered, but no call passed the checks. */
    aiFailed: number;
    /** Every call was a provider error: nobody's failed attempt (the quota is given back). */
    aiErrored: number;
    /** Learns answered from the owner's structure cache (no model, no cost). */
    cache: number;
    /** Learns solved in the browser: only known from `learn_completed {path: local}` events; null when none were recorded (n/a, not zero). */
    local: number | null;
  };
  /** Saved formats and how much they are run. The run count is not dated (the conversion keeps `runCount` and `lastRunAt`). */
  conversions: {
    formats: number;
    formatsNew: number;
    /** Conversions whose last run was in the period. */
    ranInPeriod: number;
    /** `runCount` summed over every conversion, all time. */
    runsAllTime: number;
  };
  llm: {
    /** Real model calls in the period (a cache hit is not a call). */
    calls: number;
    /** Estimated cost (`llm_calls.estimate.costUsd`) summed over the priced calls; null when none is priced. */
    costUsd: number | null;
    unpriced: number;
    /** One row per UTC day, oldest first, empty days included. */
    byDay: AdminDayRow[];
    byModel: AdminModelRow[];
  };
  /** The problem kinds the checks found (`llm_calls.problemCounts`), most frequent first, zeros left out. */
  problems: { kind: string; count: number }[];
  functionRequests: {
    /** Groups (one per name and signature). */
    groups: number;
    /** Times they were recorded. */
    requests: number;
    atThreshold: number;
    issueOpened: number;
    /** First seen in the period. */
    newInPeriod: number;
  };
  /** The `events` collection in the period, by type (today only what the server itself records: `signed_up`, `signed_in`). */
  events: { type: string; count: number }[];
}

export type AdminFunctionRequestStatus = 'new' | 'issueOpened' | 'approved' | 'declined';

/** One function request (SPEC 13 `function_requests`): value-free by construction. */
export interface AdminFunctionRequest {
  id: string;
  name: string;
  purpose: string;
  /** `name(arg: type, ...): returns`. */
  signature: string;
  args: { name: string; type: string }[];
  returns: string;
  topic: string;
  /** Times recorded, and by how many different (hashed) owners. */
  count: number;
  distinctOwners: number;
  firstSeen: string;
  lastSeen: string;
  status: AdminFunctionRequestStatus;
  /** `distinctOwners` has reached `limits.learn.functionRequests.issueThreshold`. */
  atThreshold: boolean;
  /** Only while the request is `new` and at the threshold: the pre-filled new-issue form on GitHub (value-free text, nothing else). */
  issueUrl?: string;
}

/** GET /api/admin/function-requests */
export interface AdminFunctionRequestsResponse {
  requests: AdminFunctionRequest[];
  threshold: number;
}

/** PATCH /api/admin/function-requests/:id body: mark that its GitHub issue was opened (so it is not offered twice), or take that back. */
export interface AdminUpdateFunctionRequestRequest {
  status: 'new' | 'issueOpened';
}

export interface AdminUpdateFunctionRequestResponse {
  request: AdminFunctionRequest;
}

/** GET /api/admin/users: one user. */
export interface AdminUserRow {
  id: string;
  name: string | null;
  /** Every email on the account, the verified ones first. */
  emails: string[];
  providers: AuthProviderId[];
  tier: 'registered' | 'paid';
  createdAt: string;
  lastSeenAt: string;
  /** AI learns counted this period (`used` null: the tier's quota is unlimited, nothing is counted) against the effective limit (override, else the tier's). */
  aiLearns: { used: number | null; limit: number | null; period: AiLearnPeriod };
  formats: number;
  limitOverrides: Record<string, number>;
}

/** GET /api/admin/users?q=&page=&pageSize= (q matches an email or a name). */
export interface AdminUsersResponse {
  users: AdminUserRow[];
  total: number;
  page: number;
  pageSize: number;
}

/**
 * PATCH /api/admin/users/:id body. `tier` is `registered` or `paid` (anonymous has no user). `limitOverrides` REPLACES the user's
 * overrides (`limits.admin.overrideKeys`; `null` or `{}` removes them). Every change is written to the admin audit log.
 */
export interface AdminUpdateUserRequest {
  tier?: 'registered' | 'paid';
  limitOverrides?: Record<string, number> | null;
}

export interface AdminUpdateUserResponse {
  user: AdminUserRow;
}

/**
 * GET /api/admin/contacts: leads and feedback, newest first, read-only. Shape: `{ createdAt, kind, email?, name?, company?, message, page? }`
 * (the lead form's `ts` / the feedback's `text` and `rating` are read as `createdAt` / `message` / `rating`).
 */
export interface AdminContact {
  id: string;
  source: 'lead' | 'feedback';
  createdAt: string | null;
  kind: string;
  email?: string;
  name?: string;
  company?: string;
  role?: string;
  message?: string;
  page?: string;
  rating?: number;
  language?: string;
}

export interface AdminContactsResponse {
  items: AdminContact[];
}

export type AdminAuditAction = 'user.tier' | 'user.limitOverrides' | 'functionRequest.status';

/** One line of the admin audit log: who, when, what changed (`before` -> `after`). */
export interface AdminAuditEntry {
  id: string;
  ts: string;
  adminId: string;
  adminEmail: string | null;
  action: AdminAuditAction;
  targetKind: 'user' | 'functionRequest';
  targetId: string;
  /** The user's email / the function's name, read now (null when it is gone). */
  targetLabel: string | null;
  before: unknown;
  after: unknown;
}

/** GET /api/admin/audit */
export interface AdminAuditResponse {
  entries: AdminAuditEntry[];
}
