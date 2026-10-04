// Web-app config (SPEC non-negotiable 8: limits live in config, never inline in code).
// DECISION: these are web-only knobs, so they live here rather than in
// packages/shared/src/config; move them there if the API or eval ever needs them
// (the max file size in particular is "per tier" in SPEC 6.1 and has no shared entry yet).

import { tiers } from '@formatai/shared';

export const webConfig = {
  /**
   * SPEC 15: "parse in a worker with a timeout". The timer counts only time the worker
   * is actually busy; it is paused while the worker waits for the main thread's HTTP
   * call (the LLM can take a while and is not a parse problem).
   */
  workerTimeoutMs: {
    learn: 120_000,
    convert: 60_000,
    verify: 60_000,
    inspect: 30_000,
    /** The rules editor (SPEC 8.11): reading the example again, then quick checks on it. */
    loadExample: 60_000,
    liveCheck: 10_000,
    fullCheck: 60_000,
    staticChecks: 10_000,
    /** Convert a file (SPEC 5 C/D): the headers, matching, one run, and packing a batch's zip. */
    readHeaders: 30_000,
    matchFile: 30_000,
    columnGaps: 10_000,
    convertWithDecisions: 60_000,
    batch: 120_000,
  },
  /** SPEC 15 "Enforce a maximum file size": the free tier's size until the session says otherwise. */
  maxFileBytes: tiers.anonymous.maxFileBytes,
  /** Rows kept from a converted sheet for the on-screen preview (the tier decides how many are shown). */
  convertPreviewRows: 50,
  /** Flagged rows listed one by one in the conversion-time review; the bulk buttons cover the rest (SPEC 21 v5 item 5). */
  convertReviewRows: 200,
  /** Flags listed on the run result screen. */
  convertFlagRows: 100,
  /** How long a learn waits for "who is signed in" (`/api/me`) before it goes on as if nobody were (a server that does not answer must not hold it back). */
  meReadyTimeoutMs: 5000,
  /** Coming back to the tab (or the window) reads who is signed in again, at most this often: signing in (or out) in another tab is noticed without a reload. */
  meRefreshMinGapMs: 10_000,
  /**
   * SPEC 5 E "The learned rules survive sign-in": what is learned so far (the two example files and the edits) is kept in
   * this browser's IndexedDB - never sent anywhere - while the browser goes to the provider and back, and dropped
   * after an hour (or once it is restored).
   */
  pendingLearn: { maxAgeMs: 60 * 60 * 1000, dbName: 'formatai', storeName: 'pending', key: 'learn', /** A browser whose IndexedDB never answers must not hold the Result screen back. */ loadTimeoutMs: 3000 },
  /** Where the "Upgrade" panel points until paid plans have a real sign-up (M4): a placeholder address. */
  contactHref: 'mailto:hello@formatai.example',
  /** SPEC 16.2: the UI-language cookie. */
  languageCookie: { name: 'lang', maxAgeSeconds: 365 * 24 * 60 * 60 },
  /** Base URL of the API. Empty = same origin (the Vite dev server proxies /api). */
  apiBaseUrl: (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? '',
} as const;
