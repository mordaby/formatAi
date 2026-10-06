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
    /**
     * Prompt audit X2: `max_tokens` for a model whose thinking cannot be turned off (Opus 5.5, Fable 5 / 5.1, Mythos: `apps/api/src/llm/
     * providers/anthropic.ts`). Thinking counts toward `max_tokens`, so 4,000 could leave no room for the answer. 16,000 keeps a
     * non-streaming request well under the SDK's HTTP timeout. Every model that can run without thinking is sent `maxTokens` with thinking off.
     */
    maxTokensThinking: 16_000,
    temperature: 0,
    /** SPEC 9.3 / 20.5. Default 1; set to 0 for exactly one LLM call per learn. Every loop round gets the same (`learn.loop`). */
    serverRepairRounds: 1,
    /**
     * SPEC 9.1 "claude-cli" (the dev provider): how long one spawned CLI call may run before that child process - and only it, through its
     * own handle - is stopped and the call recorded as failed (`error:timeout`), so the learn and the eval go on. DECISION: 5 minutes - a
     * learn call takes well under one, and one CLI call once hung for over an hour and took an eval run down with it.
     */
    cliTimeoutMs: 300_000,
    /**
     * SPEC 9.3: the browser-triggered repair calls of one learn - the rounds of the learning loop (`learn.loop`, owner decision
     * 2026-10-04: 3 rounds; it was 1 before the loop). The server refuses a fourth under the same learnId.
     */
    browserRepairCalls: 3,
    /**
     * SPEC 9.6 "Fallback" (owner request 2026-10-05): when `LLM_FALLBACK_PROVIDER` is set, a call the primary provider cannot serve (a
     * network error, a timeout, HTTP 429 / 5xx / 401 / 403, Anthropic's overloaded error) is made once more, at once, on the fallback.
     * `apps/api/src/llm/fallback.ts`. DECISION: placeholder numbers (SPEC 20.4); tune from the ledger's `fallback` calls.
     */
    fallback: {
      /** The circuit breaker trips after this many consecutive primary failures ... */
      tripAfter: 3,
      /** ... each within this long of the latest (a failure older than that no longer counts toward a trip). */
      windowMs: 300_000,
      /** While tripped, every call goes straight to the fallback for this long; then the primary is tried again (one failure re-trips). */
      coolDownMs: 300_000,
      /**
       * The primary SDK client's timeout per attempt while a fallback is configured (the SDKs' default is 10 minutes, and they retry it).
       * DECISION: 2 minutes. A learn answer (at most `maxTokens`, 4,000 output tokens, thinking off) takes well under one minute; a model
       * that thinks up to `maxTokensThinking` would need more - raise this with it.
       */
      primaryTimeoutMs: 120_000,
      /**
       * The primary SDK client's own retries (429, 5xx, connection errors, timeouts) while a fallback is configured; the SDKs' default is 2.
       * DECISION: 1 - a blip is still retried once by the SDK, and a real outage reaches the fallback after two attempts, not three.
       */
      primaryMaxRetries: 1,
    },
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
    /** Simple in-memory per-IP request rate limit on POST /api/learn, /api/learn/step and /api/learn/repair. */
    learnRequestsPerIpPerMinute: 10,
    rateLimitWindowMs: 60_000,
    /** Cloudflare Turnstile siteverify call timeout; a timeout counts as a failed check. */
    turnstileTimeoutMs: 5_000,
    /** SPEC 9.3: how long after its learn a browser-triggered repair (a loop round, at most `llm.browserRepairCalls`) is accepted. */
    learnIdTtlMinutes: 60,
    /** Daily `anon:` / `ip:` usage counters are kept this long after their UTC day ends, then TTL-expired. */
    dailyCounterGraceHours: 24,
    /** Lifetime of the first-party `anonId` cookie (SPEC 12). */
    anonCookieMaxAgeDays: 365,
  },
  /**
   * SPEC 16.1 screen 7, 13 (v13, M4): the public forms - the business lead form, the paid waitlist and feedback. Character caps are counted
   * in characters (code points), after trimming; the API refuses what is over them and the web checks the same numbers before sending.
   * DECISION: placeholder numbers (SPEC 20.4); the rate limits are per IP (the window is `protection.rateLimitWindowMs`).
   */
  contact: {
    nameMaxChars: 120,
    emailMaxChars: 254,
    companyMaxChars: 160,
    leadMessageMaxChars: 4000,
    waitlistMessageMaxChars: 1000,
    feedbackMessageMaxChars: 2000,
    /** The page path a form was sent from (`/formats/<id>`): a path only, never a query or a fragment. */
    pageMaxChars: 200,
    /** In-memory limit: one IP may send this many form requests (of any of the three) in one window. */
    perIpPerWindow: 5,
    /** Durable limit, on a keyed hash of the IP (never the IP itself): form submissions that were stored, per UTC day. */
    perIpPerDay: 20,
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
   * SPEC 14.2 (M4): the admin view at /admin. DECISION: placeholder numbers (SPEC 20.4); the admin is a handful of people.
   */
  admin: {
    /** The time ranges the overview can show, in days (SPEC 14.2), and the one it opens on. */
    periodsDays: [7, 30, 90],
    defaultPeriodDays: 30,
    /** Requests one IP may send to the admin routes per `protection.rateLimitWindowMs`: far above what the page needs, far below a scraper. */
    requestsPerIpPerMinute: 60,
    /** Users per page of the users list (and the most a caller may ask for), and the longest search text. */
    usersPageSize: 25,
    maxUsersPageSize: 100,
    maxSearchChars: 100,
    /**
     * `users.limitOverrides` keys an admin may set. Only keys some code reads belong here (`aiLearns`: `aiQuotaOf` in the API), so an
     * override is never a promise nothing keeps. A key added here needs the code that reads it.
     */
    overrideKeys: ['aiLearns'],
    /** The largest value of one override. */
    maxOverride: 100_000,
    /** Rows of the admin audit log, of the leads and feedback lists, and of the function-request list one call returns. */
    auditListed: 50,
    contactsListed: 100,
    functionRequestsListed: 200,
    /** A lead's or feedback's message is cut at this many characters in the list. */
    maxContactMessageChars: 2_000,
    /** Problem kinds the overview lists (the most frequent first). */
    topProblemKinds: 8,
    /**
     * Where "Open GitHub issue" goes: a new-issue form the admin submits herself, pre-filled with the value-free request. No token, no API
     * call from here (issue #41 builds approved functions through a gated PR).
     */
    githubNewIssueUrl: 'https://github.com/mordaby/formatAi/issues/new',
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
    /** Across-row (window) functions per rules file, and columns in one `by:` / `order:` (docs/proposals/window-operations.md). Each window node also counts as one rule. */
    maxWindowOps: 8,
    maxWindowKeys: 3,
    /** SPEC 8.4a: how many exact cell texts one input column may read another way (`input.columns[].readAs`, "Do this every time?" on the Run screen). */
    maxReadAsPerColumn: 100,
    /**
     * What one saved format may keep (docs/proposals/saved-format-contents.md section 7; owner, 2026-10-06; SPEC 11, 21 v15). The tables were
     * capped (`maxTables` x `maxTableRows`), but a value map's entries, the length of a value and the size of a format's rules were not:
     *   - `maxValueMapEntries`: entries in one value map (`transform.valueMaps[].map`), as many as a table's rows;
     *   - `maxValueChars`: characters of any one value the rules keep - a label or a constant in an expression, a table cell, a value map's
     *     key or value, a condition's constant, a filter's or a check's value, a "read as" text, a "stop at" text;
     *   - `maxTitleChars`: characters of a title row's text and of a summary row's label (coordinator follow-up, 2026-10-06: a title is a
     *     sentence of the format's own, longer than a label);
     *   - `maxRulesBytes`: the UTF-8 bytes of one version's rules (compact JSON), well under the request cap (`api.maxBodyBytes`, 256 KB).
     * Checked by the engine's `checkLimits` (the browser's live check, the API's checks of an AI answer) and by the server on every route that
     * stores rules, which refuses a save over any of them with 400 `rulesTooLarge` (the browser checks first, so a user never sees it in normal use).
     */
    maxValueMapEntries: 500,
    // Owner decision (2026-10-06): 300, raised from the proposal's 200.
    maxValueChars: 300,
    maxTitleChars: 500,
    maxRulesBytes: 65_536,
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
     * 'Finish with the AI step' completes only what's missing when at least this share of the output
     * columns already has a rule; below it the whole learn runs instead. First Haiku eval (2026-10-01):
     * completion was far cheaper and as accurate with most columns fixed, but failed where nothing was
     * fixed (a summary output with 0 of 5 columns solved), which the full learn verified.
     */
    completionMinFixedShare: 0.5,
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
    /**
     * Owner rule: if the AI can solve a column, let it; only data with no relation to the input is external.
     * An output text column beyond the light `template` (3 columns, long fixed text) is still COMPOSED from input
     * values when an input column's value sits inside the output cell: such a column is `derived` (kind
     * `composition`), not external. An input column counts when its value (normalized text) is a substring of
     * the output cell on at least this share of the aligned rows...
     */
    compositionMinCoverage: 0.9,
    /** ...and a value shorter than this (in characters) never counts, so a 1-character code ("1", "A") is not a composition. */
    compositionMinValueLength: 2,
    /**
     * Across-row (window) patterns (docs/proposals/window-operations.md). The free engine builds only the ORDER-INDEPENDENT ones
     * (a group's total on every row, a count per group); `minRows` aligned rows are needed to trust one.
     */
    window: {
      minRows: 4,
      /**
       * Whether the learn payload carries `rel: 'window'` hints for the patterns the free engine does not build (previous / next /
       * fillDown / rank / running sum / group average, min, max / row number). ON since learn-v7, which documents the window functions in
       * the system prompt (before that the AI was not told about them, so a hint would only have confused it).
       */
      hintsEnabled: true,
    },
    /**
     * learn-v7 (issue #40): the two optional notes on an `unsupported` entry. `functionRequest`: a camelCase name (at most
     * `maxNameChars`), one neutral sentence (`maxPurposeChars`), at most `maxArgs` typed arguments, a return type. `explanation`: a
     * plain-language guess at the rule, at most `maxExplanationChars`, shown in the session only. The schema enforces them; a note that
     * breaks them is dropped, never a reason to fail or repair a learn.
     */
    notes: {
      maxNameChars: 40,
      maxPurposeChars: 160,
      maxArgs: 6,
      maxExplanationChars: 200,
      /** A request is rejected (counted, not stored) when its name, purpose or argument names contain a payload value: only tokens of at least this many characters are compared (numbers are compared whatever their length). */
      minTokenChars: 3,
    },
    /**
     * learn-v8 (owner decision 2026-10-04; SPEC 9.2, 21 v12 item 17): an answer may give, for an output column, a second rule that also fits
     * every row it was shown (`alternatives`). At most one per column and at most this many per answer; the API drops the rest (counted in
     * the call's `problemCounts.invalidAlternative`, never a repair). Each one costs the browser one more run of the rules on the example.
     */
    maxAlternatives: 3,
    /** The API's `function_requests` collection (SPEC 13): how many distinct (hashed) owners one request remembers; past it `distinctOwners` stops growing. */
    functionRequests: {
      maxOwnerHashes: 1000,
      /**
       * The admin view (SPEC 14.2, M4) offers "Open GitHub issue" for a function request once this many DIFFERENT (hashed) owners have asked
       * for it. DECISION: distinct owners, not `count`: one person who learns the same file five times asks once, and the issue is a demand
       * signal. 5 is a placeholder (SPEC 20.4), tuned from the requests the admin sees.
       */
      issueThreshold: 5,
    },
    /**
     * The learning loop (SPEC 9.3, docs/proposals/learning-loop.md 3.2; owner decision 2026-10-04): after the full verification the
     * browser sends the rows the rules got wrong, round after round, while the number of wrong rows keeps going down. At most `maxRounds`
     * rounds (one browser-triggered repair call each, `llm.browserRepairCalls`), at most `rowsPerRound` new rows in one round, and at most
     * `maxRowsTotal` masked rows in one learn, the first payload's samples and dropped rows included. The payload byte cap
     * (`payload.maxBytes`) holds for the payload with every row sent added to it.
     */
    loop: {
      maxRounds: 3,
      rowsPerRound: 8,
      maxRowsTotal: 40,
    },
    /**
     * Code fills the data parameters of an AI answer from every row of the example (docs/proposals/learning-loop.md 7.1, owner decision
     * 2026-10-04; engine `learn/fillParams.ts`). Each condition (a value list, a cut-off) code settles costs two runs of the rules on the
     * example; at most `maxConditions` of them per answer, in the order they appear (the rest are left as the AI wrote them).
     */
    fill: {
      maxConditions: 24,
    },
    /**
     * The overfitting guards (SPEC 9.2 layer 6, 21 v12 item 19; engine `learn/overfit.ts`): a computed column that is a chain of at least
     * `minCases` cases, each giving a constant to the rows an equality or range of input columns picks (two input columns or more in all),
     * and each the one taken for at most `maxRowsPerCase` of the rows code can see, copies the example's answers instead of stating a rule.
     * DECISION: 6 and 2, from the learn-v8 measurement (2026-10-05): the memorized warehouse list (the kept answer) had 13 cases, each the
     * one taken for one or two of the example's 20 rows, while no other kept rules file of that measurement (90 distinct: learn-v7 and
     * learn-v8, both modes, the noE1 arm) has a chain of more than 4 cases (the longest, a status rule, takes 5 to 117 rows per case).
     * A band table or a value map written as a `switch` reads one column and is never counted.
     */
    overfit: {
      minCases: 6,
      maxRowsPerCase: 2,
    },
    /**
     * A one-time edit or a rule? (SPEC 8.11, 21 v12 item 20; owner decision 2026-10-05; engine `learn/oneTimers.ts`): after an AI learn, a part
     * of a rule that explains exactly one row of the example, singled out by something unique to it (an ID, an exact amount or date no other
     * row has, its position), is a question for the user. At most `maxQuestions` per learn; a column with more such parts than that is not a
     * few one-time edits - it is left to the overfitting guards, and asks nothing.
     */
    oneTimer: {
      maxQuestions: 3,
    },
    /**
     * A list of fixed values (docs/proposals/saved-format-contents.md section 3; owner, 2026-10-06; engine `copiedLists`, `learn/oneTimers.ts`):
     * an output column whose value comes from a lookup, a value map or a chain of cases whose entries are fixed values keyed on an input
     * column. A list is retried once for logic (section 4) and asked about at Save (section 6); a small vocabulary is not a list and saves
     * silently.
     *   - `minEntries`: a list has at least this many entries the example uses. DECISION: 6, the copied list's threshold of #55
     *     (`overfit.minCases`): below it a few named values are one-time edits (the Result screen's question) or a rule, and the popup and the
     *     retry stay rare.
     *   - `vocabulary`: a translation of a category column with few values (`Open -> פתוח`, 4 region codes -> names) - at most `maxEntries`
     *     entries, each giving its value to at least `minRowsPerEntry` rows of the example, keyed on a column that is not an identifier
     *     (#56's classification, engine `maskTypes`). Anything bigger, keyed on an identifier, or with an entry used by a single row is a list.
     */
    lists: {
      minEntries: 6,
      vocabulary: {
        maxEntries: 12,
        minRowsPerEntry: 2,
      },
    },
    /**
     * AI code checks (docs/proposals/ai-code-checks.md, owner decision 2026-10-05; SPEC 21 v14, 9.1): before it answers, the AI step (prompt
     * learn-v9) may ask code a few closed, typed questions about the WHOLE example - `test`, `ranges`, `dependsOn`, `values`, `rows`
     * (`checks.ts`) - and the browser answers them on every row (engine `learn/checks.ts`), masked like the samples. At most `maxRounds` rounds
     * of at most `maxChecksPerRound` checks; after the last round the answer must be the rules. Rows an answer shows count toward
     * `loop.maxRowsTotal` together with the samples and the loop's rows; past it an answer gives counts only.
     */
    checks: {
      maxRounds: 3,
      maxChecksPerRound: 4,
      /** `test`: failing rows shown. */
      maxFailingRows: 3,
      /** `dependsOn`: conflicting pairs of rows shown. */
      maxConflicts: 2,
      /** `ranges`: past this many runs the answer is `clean: false` with the run count only. */
      maxRuns: 12,
      /** `values`: the most common values listed. */
      maxValues: 10,
      /** `rows`: the most rows one check may ask for (`limit`). */
      maxRowsPerCheck: 5,
      /** Helper columns (`let`) one check may define. */
      maxLets: 3,
      /** `dependsOn`: columns in `on`. */
      maxOn: 2,
      /**
       * Characters of one formula of a check (`rule`, a `let`, `where`). DECISION: a quarter of `rules.maxFormulaChars` - a check tests one
       * idea, and every round is sent again with each later step, under the payload byte cap.
       */
      maxFormulaChars: 1000,
      /** Characters of a column reference (`column`, `by`, `on`): a header or an id. */
      maxRefChars: 200,
      /**
       * The time one check may take in the browser's worker (or the eval). It is measured between the steps of the check (a check runs the
       * engine once on every row and cannot be stopped inside that run), and a check past it answers `{ error }` instead.
       */
      timeBudgetMs: 5000,
      /**
       * Who gets learn-v9 in the app: `off` - nobody (learn-v7, as before); `admin` - the admin accounts only (`ADMIN_EMAILS` /
       * `MICROSOFT_ADMIN_OIDS`); `all` - every AI learn. The API's `LEARN_CHECKS` env var overrides it (`off|admin|all`). The eval turns it
       * on with `--prompt learn-v9`. DECISION (owner, 2026-10-05): off until the eval passes, then admin first.
       */
      mode: 'off',
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
    /** Sources one list call returns. */
    maxSourcesListed: 500,
    /** Headers of an example input a save may send to be matched against the owner's sources (SPEC 8.15; structure only). */
    maxInputHeaders: 500,
    /**
     * Headers a source remembers as "known, no format uses them" (`ignoredHeaders`, SPEC 8.15, 13; header names only, never values):
     * past this the oldest are dropped, so a dismissal just made always holds.
     */
    maxIgnoredHeaders: 500,
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
    /**
     * "Same name, different meaning" (SPEC 8.15, 21 v11 items 4-7): when at least this share of a used column's values failed to parse as the
     * saved type, the format needs the user's attention before its file is made. DECISION: 0.9 - a column that is nearly all
     * unreadable is almost surely a different thing under the same name, while a smaller share is ordinary dirty data, which the
     * flagged-rows review handles one row at a time. The share is of the run's rows in (the run does not count one column's
     * non-empty cells), which only ever errs towards saying nothing.
     */
    parseFailShare: 0.9,
  },
} as const;

export type Limits = typeof limits;
