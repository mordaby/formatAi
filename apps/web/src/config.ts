// Web-app config (SPEC non-negotiable 8: limits live in config, never inline in code).
// DECISION: these are web-only knobs, so they live here rather than in
// packages/shared/src/config; move them there if the API or eval ever needs them
// (the max file size in particular is "per tier" in SPEC 6.1 and has no shared entry yet).

import { tiers, type Localized } from '@formatai/shared';

/** Placeholder address until the owner has a real one (the legal pages, the Upgrade panel's fallback link). */
const contactEmail = 'formatAI@gmail.com';

export const webConfig = {
  /**
   * SPEC 15: "parse in a worker with a timeout". The timer counts only time the worker
   * is actually busy; it is paused while the worker waits for the main thread's HTTP
   * call (the LLM can take a while and is not a parse problem).
   */
  workerTimeoutMs: {
    learn: 120_000,
    convert: 60_000,
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
    /** "See what we send" before the learn: the pair analysis (as long as a learn's, the first time), then the request built from it. */
    sendPreview: 120_000,
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
  pendingLearn: {
    maxAgeMs: 60 * 60 * 1000,
    dbName: 'formatai',
    storeName: 'pending',
    key: 'learn',
    /** A browser whose IndexedDB never answers must not hold the Result screen back. */
    loadTimeoutMs: 3000,
    /** While a tab is open it looks this often for a kept copy another tab made, so that one is dropped on its hour too (`keepPendingWithinTheHour`). */
    sweepEveryMs: 5 * 60 * 1000,
  },
  /** The fallback under the paid-waitlist form (the "Upgrade" panel): write to us. A placeholder address until the owner has one. */
  contactHref: `mailto:${contactEmail}`,
  /**
   * The public legal pages (privacy, terms, accessibility statement; v13 M4). EVERY value in square brackets is a placeholder the OWNER must
   * replace before launch, and the retention numbers are PROPOSALS (see the header of i18n/legal.ts: the whole text needs the owner's or a
   * lawyer's review).
   */
  legal: {
    /** When the three texts last changed (ISO date): shown at the top of each page. Change it whenever the text changes. */
    updated: '2026-10-05',
    contactEmail,
    operator: { en: 'FormatAI', he: '[שם החברה וכתובתה - להשלמה על ידי הבעלים]' } satisfies Localized,
    /** "Disputes will be decided only by ..." (the terms). */
    jurisdiction: { en: '[the competent courts of Tel Aviv-Jaffa, Israel - to be confirmed]', he: '[בתי המשפט המוסמכים בתל אביב-יפו - לאישור]' } satisfies Localized,
    hosting: { en: '[hosting and database providers - to be completed by the owner]', he: '[ספקי האחסון ומסד הנתונים - להשלמה על ידי הבעלים]' } satisfies Localized,
    /** The accessibility coordinator the statement names (Israeli accessibility regulations, 2013). */
    accessibility: {
      coordinator: { en: '[Accessibility coordinator name - to be completed]', he: '[שם רכז הנגישות - להשלמה]' } satisfies Localized,
      email: '[accessibility email - to be completed]',
      phone: { en: '[phone - to be completed]', he: '[טלפון - להשלמה]' } satisfies Localized,
    },
    /** How long the privacy policy says records are kept. PROPOSALS: no job deletes old documents yet. */
    retentionMonths: { aiCallRecords: 12, forms: 24 },
  },
  /** SPEC 16.2: the UI-language cookie. */
  languageCookie: { name: 'lang', maxAgeSeconds: 365 * 24 * 60 * 60 },
  /** Base URL of the API. Empty = same origin (the Vite dev server proxies /api). */
  apiBaseUrl: (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? '',
} as const;
