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
    /**
     * The largest column position (`columns[].i`, 0-based) a payload may name: Excel's last column (XFD, 16,384 columns). API audit C3
     * (2026-10-07): an unbounded position let one request build a sample table billions of cells wide (i = 50,000,000 took 3.5 s; ~4.29e9
     * ran for minutes or ran out of memory). The browser never sends more: a sheet has no column past it.
     */
    maxColumnIndex: 16_383,
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
      /**
       * API audit C8 (2026-10-07): the FALLBACK provider's SDK client gets the same short leash (it had the SDKs' defaults: 10 minutes
       * per attempt, 2 retries - half an hour for one call while the primary is down). DECISION: 2 minutes and 1 retry, as the primary's.
       */
      fallbackTimeoutMs: 120_000,
      fallbackMaxRetries: 1,
    },
  },
  /**
   * SPEC 9.5: a daily overall budget, in USD - the kill switch. (The daily anonymous one went with the anonymous AI step: API audit,
   * 2026-10-07.) DECISION: a placeholder number (SPEC 20.4). Tune from real `llm_calls`/`budgets`
   * spend data before launch; also set a matching monthly cap in the provider's console.
   */
  budgets: {
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
    /**
     * Every usage counter (`usage_counters`) is TTL-expired this long after the end of the period it counts: a daily one after its UTC
     * day, a monthly one after its UTC month (owner decision 2026-10-07: "the end of its period plus about 2 days"). The privacy page
     * says the same number (`counterGraceDays` in apps/web/src/pages/Legal/params.ts).
     */
    counterGraceHours: 48,
    /** Lifetime of the first-party `anonId` cookie (SPEC 12). */
    anonCookieMaxAgeDays: 365,
    /**
     * API audit C1 (2026-10-07): a hard cap on the REQUESTS one signed-in user makes that call the AI - POST /api/learn, /step and
     * /repair, whatever they end in - per UTC day, by tier. Independent of the AI-learn quota, which counts successes only: a failed
     * learn, a provider error and a `failed` outcome cost the user nothing there, so a script could spend the shared daily budget
     * (`budgets.dailyOverallUsd`) for everyone. Over it: 429 `limitHit` `aiRequestsPerDay`. A cache hit calls no AI and is not counted.
     * DECISION: registered 40, paid 400 - generous for real use (a learn is its first call plus up to `llm.browserRepairCalls` loop
     * rounds and `learn.checks.maxRounds` steps, so 40 is about ten whole learns a day, three times the plan's monthly AI learns), low
     * enough that one account cannot spend the shared daily budget alone. Placeholder numbers (SPEC 20.4): tune from the ledger.
     */
    aiRequestsPerDay: { registered: 40, paid: 400 },
    /**
     * API audit C1: the `failed` outcome reports one user may have refunded per UTC day (`POST /api/learn/:learnId/outcome`). Past it a
     * report is still taken - the result is evicted from the cache - but the learn stays counted and no failure is recorded on the pair.
     * DECISION: 10 - a real user reports a failed learn a few times a day at most; refunding without end made every learn free.
     */
    failedRefundsPerDay: 10,
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
    /**
     * API audit (2026-10-07): a GLOBAL cap on the submissions stored in one UTC day - leads, waitlist and feedback together - whatever IP
     * they come from. The per-IP caps hold one address; a client that invents its address (`X-Forwarded-For` behind `TRUST_PROXY`) could
     * otherwise fill the database (the Atlas plan's storage). Past it every form answers 429 `rateLimited` until the next UTC day.
     * DECISION: 200 a day - far above what the forms see, and at most about 1.5 MB a day of the largest documents (a 4,000-character message).
     */
    globalPerDay: 200,
  },
  /** SPEC 9.5 "Cache": saved rules for a structure the same owner already learned. */
  cache: {
    ttlDays: 30,
  },
  /**
   * How long records are kept (owner decision 2026-10-07: the privacy page's promise is what the code does). The privacy page reads these
   * numbers (apps/web/src/pages/Legal/params.ts) and the API's TTL indexes are built from them (`ensureIndexes`, apps/api/src/db.ts), so
   * the two can never say different things. A month is counted as `daysPerMonth` days: a record goes a little before the page's "up to N
   * months", never after. DECISION: the numbers are the owner's proposals (12 and 24 months); change them here only.
   */
  retention: {
    /** `llm_calls`: the AI call records (when, which model, tokens, cost, outcome - never content). */
    aiCallRecordsMonths: 12,
    /** `leads` (the business contact form and the paid waitlist) and `feedback`. */
    formsMonths: 24,
    /** `events` (sign-in and sign-up records: when, which provider). DECISION: the AI-record period, as the owner decided. */
    eventsMonths: 12,
    daysPerMonth: 30,
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
    /**
     * API audit (2026-10-07): the number parameters a rule may give the engine, which it uses as sizes. Unbounded, one answer or one saved
     * format could crash or hang the engine (`padLeft` to a length of 1e9 builds a gigabyte string; `round` to 1e9 digits, 1e9 blank rows
     * after each group). The schema refuses more (an AI answer gets a repair; a save is refused). DECISION: far above any real use -
     *   - `maxRoundDigits`: `round(x, digits)`, at most 15 places either side of the point (a double holds 15-17 significant digits);
     *   - `maxPadLength`: `padLeft(x, length, char)` and an input column's `padLeft` - an ID, an account or an IBAN (34) is far shorter;
     *   - `maxLengthEquals`: a `lengthEquals` check (its suggestion pads to that length);
     *   - `maxBlankRowsAfter`: blank rows after each group (`group.blankRowsAfter`); a report has one or two.
     */
    maxRoundDigits: 15,
    maxPadLength: 100,
    maxLengthEquals: 100,
    maxBlankRowsAfter: 20,
  },
  /**
   * SPEC 6.1, 6.2, 7.1 (non-negotiable #8): the thresholds and caps of the engine's table detection (`io/detectTable.ts`) and pair
   * analysis (`learn/analyze/*`). They were named constants and inline numbers in the engine; moved here with the SAME values (refactor,
   * 2026-10-07: no behaviour change). The ones that SPEC 6 and 7.1 quote (15 rows, 2,000 rows, 0.9, 50 values, 5 breakpoints, 200
   * shuffles, 95%) are the values below. Shares are fractions of rows (or cells) between 0 and 1. A change here changes what the analysis
   * reports: run the eval's stress (`pnpm --filter ./eval stress`) and the case verifier before keeping one.
   */
  analysis: {
    /** SPEC 6.1: finding the header row and the data under it. */
    table: {
      /** The header is searched for in this many rows from the top (input and output). */
      headerScanRows: 15,
      /** A header row has at least this share of its columns filled (and never fewer than 2 cells). */
      headerMinNonEmptyShare: 0.5,
      /** ... and at least this share of its filled cells are text. */
      headerMinTextShare: 0.7,
      /** A header is followed by this many consistently typed data rows ... */
      headerDataRows: 3,
      /** ... or, to still find it and reject the sheet later, at least this many; also the fewest data rows a sheet may have. */
      minDataRows: 2,
      /** A block of rows is "consistently typed" when this share of its columns hold one cell type. */
      dataBlockConsistentShare: 0.6,
    },
    /** SPEC 6.2 "Speed on large files": candidate relations are tried on this many aligned rows first, then confirmed on all of them. */
    sampleRows: 2000,
    /** SPEC 6.2: a relation is reported (as a hint) only when it holds on at least this share of the rows. */
    minCoverage: 0.9,
    /** The sample pass keeps a candidate this far below `minCoverage` (sampling noise). */
    sampleSlack: 0.03,
    /** A column counts as numeric when at least this share of its non-empty cells are numbers. */
    numericColumnShare: 0.9,
    /** A text longer than this many characters is never read as a number stored as text ("1,234.50", "₪100"). */
    maxNumericTextChars: 40,
    /** Failing aligned-row indices kept per relation, and relations kept per output column. */
    maxFailing: 50,
    maxRelations: 6,
    /** Header check of a csv/txt output: a reading counts as "the rows are explained" when relations explain at least this share of its rows. */
    headerMinExplainedShare: 0.9,
    /** A plain number is read as an Excel serial date only from 1910-01-01 (3654) to 2099-12-31 (73415). */
    serialDateMin: 3654,
    serialDateMax: 73415,
    /** SPEC 6.2 step 3 (pivot): at least this many output headers equal values of one input column, which has at most `maxDistinctValues`. */
    pivot: {
      minColumns: 3,
      maxDistinctValues: 1000,
    },
    /** SPEC 6.2 step 2: lining output rows up with input rows (`align.ts`). */
    align: {
      /** Aligned output rows sampled to test a key, and to count the columns an alignment explains. */
      keySampleRows: 1000,
      explainSampleRows: 300,
      /** A key is accepted when it is found for this share of the sampled output rows ... */
      keyMinMatchShare: 0.5,
      /** ... and at least this share of its matches are unique, or ... */
      keyMinUniqueShare: 0.8,
      /** ... a match points to this many input rows or fewer on average. */
      keyMaxSpread: 1.5,
      /** An input column is a key candidate when this share of its non-empty cells are distinct. */
      keyMinDistinctShare: 0.5,
      /** An output value is "found" in an input column when this share of the sampled output cells are among its values. */
      valueMinContainment: 0.8,
      /** A two-column key is looked for only when the best single key matches fewer than this share of the rows. */
      strongKeyMatchShare: 0.9,
      /** Output/input column pairs (the best by containment) tried together as a two-column key. */
      maxValuePairs: 10,
      /** A summary's group column is filled on at least this share of the output rows ... */
      summaryMinNonEmptyShare: 0.95,
      /** ... and the input has at most 1 / this many groups per output row (most groups must be present). */
      summaryMinGroupShare: 0.8,
      /** An output column is "explained" by an input column or aggregate on at least this share of the rows (or groups). */
      explainMinShare: 0.9,
    },
    /** SPEC 6.2 step 4: bands of a numeric or date column (e.g. `Qty < 10 -> single`). */
    bands: {
      /** At most this many breakpoints between bands (so at most 6 bands). */
      maxBreakpoints: 5,
      /** A band must hold at least this many rows that agree with it. */
      minBandRows: 2,
    },
    /** SPEC 6.2 "Bands must beat chance": the permutation test. */
    chance: {
      /** How many shuffles of the output values the test runs. */
      shuffles: 200,
      /** A band rule is reported only when shuffled output values pass the same search at most this share of the time. */
      maxRate: 0.01,
      /** Above this many rows the test is skipped (luck cannot line that many rows up into a few bands). */
      maxRows: 1000,
    },
    /** SPEC 6.2 step 4: unknown columns the input determines (`derived.ts`). */
    derived: {
      /** Fewer aligned rows than this can't show a dependency. */
      minRows: 6,
      /** Columns considered for a two-column dependency: the ones with the fewest distinct values. */
      maxPairColumns: 10,
      /** Two columns are combined only when their value pairs fit a table this big (bounds memory, not evidence). */
      maxPairTableCells: 1_000_000,
      /** Columns named in the hint of a constant the input can write. */
      maxConstantSources: 2,
    },
    /** SPEC 6.2 step 4 (`relations.ts`): the search for the relation of one output column. */
    relations: {
      /** Sample rows read to find a padding, a split or a substring, and a number rendering. */
      textProbeRows: 200,
      numberFormatProbeRows: 50,
      /** Sample rows a date rendering is searched on, and the rows the concat sequences are derived from. */
      dateProbeRows: 5,
      concatProbeRows: 12,
      /** `concat`: at most this many columns joined, this many candidate sequences per separator, and this share of the probe rows must agree. */
      concatMaxParts: 5,
      concatMaxSequences: 8,
      concatMinHitShare: 0.75,
      /** `mulConst` / `addConst`: the rows with the largest input values the constant is derived from. */
      constantProbeRows: 3,
      /** `sum` of 3+ columns: the first `sumMaxColumns` numeric columns are searched, on `sumProbeRows` rows, keeping `sumMaxCandidates`. */
      sumMinColumns: 3,
      sumMaxColumns: 16,
      sumProbeRows: 3,
      sumMaxCandidates: 5,
      /** `valueMap` (SPEC 6.2 step 4): a value map is built for at most this many distinct keys. */
      valueMapMaxEntries: 50,
    },
    /** The search budget of the `template` relation (the template's own size limits are `learn.template`). */
    templateSearch: {
      /** Sample rows the candidate templates are derived from and cross-checked on, and the probe rows a search runs on. */
      probeRows: 12,
      searchRows: 3,
      /** Search budget per probe row, and candidates kept: past this the data fits many readings and none is reported anyway. */
      maxNodes: 4000,
      maxCandidates: 40,
    },
    /** SPEC 6.2 step 4 "dropped rows" (`dropped.ts`). */
    dropped: {
      /** A filter on a set of values is tried only on a column with at most this many distinct values. */
      maxFilterValues: 50,
      /** A filter lists its kept / dropped values only when there are at most this many. */
      maxListedValues: 20,
      /** Candidate filters kept. */
      maxFilters: 5,
      /** When no single column is a dedupe key, this many columns (the most distinct) are tried in pairs. */
      maxKeyColumns: 5,
    },
    /** SPEC 6.2 step 3 (`families.ts`): one input row becoming several output rows. */
    families: {
      /** Columns to rows: the value column an output reads from the input columns its labels name must equal them on this share of the rows. */
      minValueShare: 0.9,
      /** A fan-out where every row has the same number of output rows is a "fixed fan-out" up to this size. */
      fixedFanOutMaxSize: 5,
    },
    /** SPEC 6.2 "Classify output rows" (`tables.ts`). */
    tables: {
      /** A first row of a "headerless" output is a header when at least this share of its cells repeat the input's headers. */
      firstRowHeaderShare: 0.5,
      /** A row differs structurally from its scope (a summary row) when it is empty in a column where at least this share of the scope's rows hold a value. */
      summaryEmptyShare: 0.9,
    },
    /** SPEC 6.2 step 4, across-row patterns (`windows.ts`): how many columns are tried. */
    windows: {
      /** Numeric (and rankable) input columns tried as the column a window reads. */
      maxValueColumns: 10,
      /** Group columns tried for the order-independent patterns, and for the order-dependent ones (a pass over all rows each). */
      maxGroupColumns: 24,
      maxOrderedGroupColumns: 4,
      /** Other readings kept in a finding's `alt`, and as relations. */
      maxAlternatives: 3,
    },
    /** SPEC 6.2 "Classify output rows" (`layout.ts`): the output's language, when its headers and titles have no letters to tell. */
    layout: {
      /** Rows read from each column to find the share of Hebrew letters. */
      languageSampleRows: 200,
    },
    /** SPEC 7.1: the column profile (`profile.ts`). */
    profile: {
      /** Values read for the shape signature, spread over the column. */
      shapeSampleRows: 2000,
      /** A shape signature has at most this many shapes ... */
      maxShapes: 4,
      /** ... is at most this many characters long, and is built from values of at most this many characters. */
      maxShapeChars: 80,
      maxShapeValueChars: 30,
      /** A signature is given only when its shapes cover at least this share of the values (free text gets none). */
      shapeMinCoveredShare: 0.5,
      /** `israeliId`: a valid check digit on at least this share of the rows, and this share at least `israeliIdMinChars` long. */
      israeliIdMinShare: 0.95,
      israeliIdMinChars: 7,
      /** Digit strings are identifiers (`idLike`) from this many digits (too long for an amount) ... */
      idLikeMinDigits: 8,
      /** ... or, in text (csv), when all have the same length of at least this many digits and at least this share of them differ. */
      idLikeSameLengthMinDigits: 5,
      idLikeMinDistinctShare: 0.5,
      /** The payload gives a column's number of distinct values when there are at most this many, else their share. */
      payloadMaxListedDistinct: 20,
    },
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
      /**
       * API audit C9 (2026-10-07): the problems one round may send (`RepairRequest.problems`; the server refuses more with 400
       * `invalidProblems`, the browser's loop keeps the first ones). DECISION: 100 - above any round the browser builds (10 diff
       * problems, 10 of the fixed lock, a row count, the layout's, and one per output column for a column given up on, copied or a list);
       * the request's body cap (`api.maxBodyBytes`) bounds their size.
       */
      maxProblems: 100,
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
     * The time the browser spends on ONE AI answer (engine audit, 2026-10-07; `learn/flow.ts` `judge`): code's fill from every row, the
     * overfitting guards and the full verification each run the rules on every row of the example - up to 100,000 rows on
     * the paid tier, where one answer took 17 s (fill 15 s, verification 1 s; a 20,000-row example 2.5 s). Measured between steps (a run of
     * the rules cannot be stopped inside). Past it: the fill settles no further condition (the rest stay as the AI wrote them, like past
     * `fill.maxConditions`), and the learn makes no further round and no list round - it ends with the best
     * answer so far (`LearnFromExamplesResult.timeBudget`, loop end `timeBudget`): verified only when every row matches, otherwise its
     * differences are "needs your input". The questions at the end (one-time edits, lists) are still asked.
     */
    judge: {
      timeBudgetMs: 20_000,
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
     *     (the column classification, engine `classifyColumns`). Anything bigger, keyed on an identifier, or with an entry used by a single row is a list.
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
       * on with `--prompt learn-v9`. DECISION (owner, 2026-10-05): off until the eval passes, then admin first. Owner decision
       * (2026-10-07): the code stays, switched off; re-evaluated by 2026-11-15, after the beta with real testers' files.
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

/** A retention period of `months` (`limits.retention`), in seconds: the `expireAfterSeconds` of a TTL index. */
export function retentionSeconds(months: number): number {
  return months * limits.retention.daysPerMonth * 24 * 60 * 60;
}
