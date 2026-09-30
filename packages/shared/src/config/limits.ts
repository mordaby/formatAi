// All limits live in config, never in code (SPEC non-negotiable #8).
// Sources: SPEC 2, 7.3, 9.1, 9.3, 9.5.

export const limits = {
  /** SPEC 15: the API has no endpoint that accepts files, and JSON bodies are capped at 256 KB. */
  api: {
    maxBodyBytes: 262_144,
  },
  /** SPEC 7.3: hard caps on the learn payload. */
  payload: {
    maxColumns: 60,
    maxPairs: 12,
    maxFamilies: 6,
    maxDropped: 5,
    maxCellChars: 40,
    maxBytes: 49_152,
    /** SPEC 7.3 §"Size rules": drop samples first, but never below this many pairs. */
    minPairs: 4,
  },
  /** SPEC 9.1, 9.3: LLM call settings and repair-round caps. */
  llm: {
    maxTokens: 4000,
    temperature: 0,
    /** SPEC 9.3 / 20.5. Default 1; set to 0 for exactly one LLM call per learn. */
    serverRepairRounds: 1,
    /** SPEC 9.3: at most 1 extra browser-triggered repair call after full verification. */
    browserRepairCalls: 1,
  },
  /**
   * SPEC 9.5: a daily anonymous budget and a daily overall budget, in USD.
   * DECISION: placeholder numbers (SPEC 20.4). Tune from real `llm_calls`/`budgets`
   * spend data before launch; also set a matching monthly cap in the provider's console.
   */
  budgets: {
    dailyAnonUsd: 5,
    dailyOverallUsd: 50,
  },
  /**
   * SPEC 9.5 / 11 / 12 (M2): the API protections in front of the LLM endpoints.
   * DECISION: placeholder numbers (SPEC 20.4), tuned later from `limit_hit` events.
   */
  protection: {
    /** Simple in-memory per-IP request rate limit on POST /api/learn and /api/learn/repair. */
    learnRequestsPerIpPerMinute: 10,
    rateLimitWindowMs: 60_000,
    /** Cloudflare Turnstile siteverify call timeout; a timeout counts as a failed check. */
    turnstileTimeoutMs: 5_000,
    /** SPEC 9.3: how long after its learn a browser-triggered repair (at most one) is accepted. */
    learnIdTtlMinutes: 60,
    /** Daily `anon:` / `ip:` usage counters are kept this long after their UTC day ends, then TTL-expired. */
    dailyCounterGraceHours: 24,
    /** Lifetime of the first-party `anonId` cookie (SPEC 12). */
    anonCookieMaxAgeDays: 365,
  },
  /** SPEC 9.5 "Cache": saved rules for a structure the same owner already learned. */
  cache: {
    ttlDays: 30,
  },
  /** SPEC 12: sign-in. DECISION: placeholder numbers (SPEC 20.4). */
  auth: {
    /** A session lasts this long after its last renewal (sliding). */
    sessionDays: 30,
    /** The session (and `users.lastSeenAt`) is renewed at most this often, so a request is not a write. */
    sessionRenewMinutes: 60,
    /** How long after "Continue with ..." the provider's answer is accepted (state / nonce / PKCE cookie). */
    flowMinutes: 10,
    /** A user's `anonIds` keeps this many most recent ids (one per browser they signed in from). */
    maxAnonIds: 50,
  },
  /**
   * SPEC 8.3/8.14/21 (v3): limits on the rules language itself, checked by
   * `checkRules` (maxExprDepth only) and by the engine's `checkLimits` (the rest -
   * node budgets after expanding calls, function/table counts, table row counts;
   * the rules-per-format count itself lives in `tiers.ts`, since it's per tier).
   */
  rules: {
    maxExprDepth: 8,
    maxNodesPerOutputColumn: 200,
    maxFunctions: 20,
    maxTables: 20,
    maxTableRows: 500,
    /**
     * learn-v5: the LLM writes expressions as formula TEXT (`packages/engine/src/
     * formula`), which is untrusted input. A hard length cap, checked before any
     * tokenizing/parsing work, rejects pathological input (e.g. a 1 MB string, or
     * 100,000 nested parens) in O(1) instead of doing any parse work on it at all.
     * 4,000 chars is generous for any real expression this language can produce
     * (200-node budget per output column) while still being a trivially cheap check.
     */
    maxFormulaChars: 4000,
  },
  /**
   * SPEC 6.5: the local fast path.
   * DECISION: 'wide' (a looser fast path that would also cover some cases that
   * currently need the LLM) is reserved for later, once eval data shows the
   * strict path is too narrow to matter; only 'strict' is implemented in M1.
   * SPEC 21 v5 item 4: the AI readiness gate (engine `aiReadiness`) is deliberately minimal - it
   * stops only what is certain to fail even with the AI - so it has no thresholds of its own
   * (its payload check uses the `payload` caps above).
   */
  learn: {
    fastPathMode: 'strict',
    /**
     * SPEC 21 v5 item 3: after this many failed AI attempts on the same example pair (same owner, same
     * structure hash) the app stops calling the AI for that pair and counts it as ONE AI learn.
     */
    maxFailedAiAttempts: 3,
    /** How long those failed attempts are remembered; after it the pair may be tried again. */
    failedAttemptsWindowHours: 24,
    /**
     * SPEC 6.2 step 4 (the `template` relation): an output text built from input values with FIXED text around
     * and between them (`<id>:"<name>"`, `INV-<n>`). Deliberately light: a rule this loose is only trusted when
     * it is short and proven on every row, and a wrongly caught complex rule is worse than one sent to the AI.
     */
    template: {
      /** Input columns a template may read; the same column used twice counts twice. */
      maxColumns: 2,
      /** Longest fixed text (in characters) in any one place. */
      maxLiteralChars: 6,
      /** Longest fixed text (in characters) in total, all places together. */
      maxTotalLiteralChars: 10,
    },
  },
  /**
   * SPEC 8.11 / 8.12 / 11 / 13: the registry (saved formats and their conversions).
   * DECISION: placeholder numbers (SPEC 20.4).
   */
  registry: {
    maxNameChars: 100,
    /** Aliases one input column may collect from confirmed mappings (SPEC 5 C). */
    maxAliasesPerColumn: 20,
    maxAliasChars: 200,
    /** Older versions kept per conversion / format (SPEC 8.11 "Every save creates a new version"); the oldest is dropped past this. */
    maxVersions: 30,
    /** Example rows a user may mark as "fixed by hand" (SPEC 8.11), per conversion. */
    maxExampleExceptions: 5_000,
    /** Formats one list call returns. */
    maxFormatsListed: 500,
  },
  /**
   * SPEC 8.12 / DECISION 10: matching a file to a conversion, in the browser.
   * Score = share of required columns found, minus a small penalty per extra unknown column.
   */
  matching: {
    /** A conversion is picked automatically at or above this score... */
    autoScore: 0.9,
    /** ...and at least this far above the next best one. */
    autoMargin: 0.1,
    /** Penalty per file column the conversion doesn't know (many exports carry columns nobody uses), capped by maxExtraPenalty. */
    extraColumnPenalty: 0.01,
    maxExtraPenalty: 0.05,
    /** How many conversions the user is offered when nothing is picked automatically. */
    maxSuggestions: 3,
    /** How many renamed-column candidates are offered per missing required column. */
    maxRenamedCandidates: 3,
    /** Minimum header similarity (0..1) for a file column to be offered as a renamed column. */
    minRenamedSimilarity: 0.4,
  },
} as const;

export type Limits = typeof limits;
