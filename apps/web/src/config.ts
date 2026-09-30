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
  },
  /** SPEC 15 "Enforce a maximum file size": the free tier's size until the session says otherwise. */
  maxFileBytes: tiers.anonymous.maxFileBytes,
  /** Rows kept from a converted sheet for the on-screen preview (the tier decides how many are shown). */
  convertPreviewRows: 50,
  /** SPEC 16.2: the UI-language cookie. */
  languageCookie: { name: 'lang', maxAgeSeconds: 365 * 24 * 60 * 60 },
  /** Base URL of the API. Empty = same origin (the Vite dev server proxies /api). */
  apiBaseUrl: (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? '',
} as const;
