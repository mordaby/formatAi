# @formatai/api

Fastify API for formatAI. M0 skeleton: no sign-in and no LLM calls yet (see `SPEC.md`
milestones). It has no file-upload endpoint and accepts only small JSON bodies
(256 KB max) - user files never leave the browser.

## Run

```sh
pnpm --filter @formatai/api dev     # tsx watch
pnpm --filter @formatai/api start   # single run
pnpm --filter @formatai/api test
pnpm --filter @formatai/api typecheck
```

## Configuration

Copy `.env.example` (repo root) to `.env` (repo root) and fill in values as needed.
The API loads that root `.env` automatically on boot.

To connect MongoDB, paste your connection string into the root `.env` as
`MONGODB_URI` (e.g. a MongoDB Atlas SRV string), and set `MONGODB_DB` if you don't
want the default `formatai` database name. Without `MONGODB_URI`, the API still
boots and `GET /api/health` reports `"db": "not configured"` - this is expected
until you provide a connection string.

## The AI step and its protections (M2 + M3, SPEC 9.5 / 11 / 15 / 21 v5)

The AI step is for signed-in users only. `POST /api/learn`, `POST /api/learn/repair` and
`POST /api/learn/:learnId/outcome` exist in every environment; an anonymous caller gets
`403 signInForAi` before anything else costs anything (free users get everything that runs locally, and
the web shows the local result first). For a signed-in user `POST /api/learn` is guarded by, in order:
a per-IP request rate limit (`limits.protection`), the body shape, the owner's structure cache (a hit costs
nothing and is served even when the quota is spent), the failed-attempt cap of the example pair, the daily
budgets (`limits.budgets`), and the user's AI-learn quota (`tiers.*.aiLearns: { count, period }`, period
`lifetime | month | day | unlimited`). Refusals are `{ error, limit?, period?, counted? }` with a stable code
(`packages/shared/src/codes.ts`, texts in `i18n/messages.ts`):

| Status | `error` | When |
|---|---|---|
| 429 | `rateLimited` | too many requests from one IP this minute (`Retry-After` set) |
| 403 | `signInForAi` | not signed in (learn, repair and outcome) |
| 429 | `limitHit` + `limit: 'aiLearns'` + `period` | the AI-learn quota of the period is used up |
| 429 | `limitHit` + `limit: 'repairsPerLearn'` | the learn's rounds of the learning loop are used (`limits.llm.browserRepairCalls`, 3) |
| 409 | `aiAttemptsExhausted` + `counted` | 3 failed attempts on the same example pair (`limits.learn.maxFailedAiAttempts`); `counted: true` when this very answer counted the pair as one AI learn |
| 503 | `budgetExhausted` | the daily overall budget is spent (kill switch) |
| 400 | `invalidPayload`, `invalidPreviousRules`, `invalidProblems`, `invalidLearnId`, `invalidRequest` | malformed body / follow-up without a valid `learnId` |
| 400 | `invalidRows` | a loop round's `rows` are malformed or larger than the loop allows: more than `limits.learn.loop.rowsPerRound` per round so far, more than `maxRowsTotal` masked rows in the learn (the payload's samples and dropped rows included), or the payload with them added past `limits.payload.maxBytes` |

**The learning loop** (SPEC 9.3, `docs/proposals/learning-loop.md` 3.2): `POST /api/learn/repair` is one round. Its body carries,
besides the previous rules and the problems, `rows`: every row of the example the browser sent since the learn (masked like the
samples). Each round's answer is checked on the samples PLUS all of them (a later round cannot break a row an earlier one fixed), and
gets `limits.llm.serverRepairRounds` server repairs of its own, like the learn call (no escalation). In completion mode an answer that
changed part of the fixed rules has it put back by code (`restoreFixed`) before the checks decide.

**What counts as an AI learn** (`src/protection/aiLearns.ts` has the state machine and its diagram): a
learn counts once, when it succeeds. One unit of the user's period counter (`user:<id>:aiLearns[:<period-key>]`)
is reserved before the LLM call (so concurrent learns cannot pass the quota) and settled after it: kept
when the server checks (SPEC 9.2 layers 1-7) pass, put back when they fail. A failed attempt is recorded on
the pair (owner + structure hash, `aiFail:<owner>:<group>`, remembered for `limits.learn.failedAttemptsWindowHours`);
the attempt that reaches the cap keeps its unit - the pair counts as one learn - and answers
`409 aiAttemptsExhausted { counted: true }`; later attempts on the pair are refused without calling the AI.
A provider outage (no model answered) is nobody's failed attempt. The browser then reports how the
learn ended with `POST /api/learn/:learnId/outcome { outcome: 'verified' | 'accepted' | 'failed' }`
(signed learnId, idempotent): `verified`/`accepted` count a learn that failed the server checks, `failed`
gives back a counted one and records a failure. A loop round that passes the server checks counts its
learn too, and is never a learn of its own: however many rounds a learn takes, it counts once (or not at all).

`GET /api/session` returns `{ anonId, tier: 'free', limits, turnstileSiteKey? }` and sets the
first-party `anonId` cookie (httpOnly, SameSite=Lax, Secure in production) on first contact.

**The public forms** (SPEC 16.1 screens 7 and 9, 13; `src/contact/`): `POST /api/leads` (the "For business" form),
`POST /api/waitlist` (the paid waitlist) and `POST /api/feedback` store `{ createdAt, kind, ... }` documents in `leads`
(kinds `lead` and `waitlist`) and `feedback`. The body is checked with the shared `checkLead` / `checkWaitlist` /
`checkFeedback` (`packages/shared/src/contact.ts`: caps from `limits.contact`, trimmed, only whitelisted fields kept; a bad body is
`400 invalidRequest`). A visitor must send a Turnstile token (`403 turnstileFailed`; a signed-in user is not asked); every caller is
limited per IP (`429 rateLimited`: 5 requests a minute in memory, and 20 stored forms per UTC day on a keyed hash of the IP in
`usage_counters`). The IP is never stored. They exist in every environment and need no sign-in.

Production (`NODE_ENV=production`) refuses to start without `TURNSTILE_SECRET_KEY`,
`IP_HASH_SECRET` (or `SESSION_SECRET`) and `MONGODB_URI`. Behind a proxy or load balancer set
`TRUST_PROXY` (number of hops, or `true`) so per-IP limits see the real client address. With no
`MONGODB_URI`, limits, budgets and the cache are kept in memory (the registry needs the database).

The learn cache (`learn_cache`) is keyed by a hash of the structure only and is only ever returned
to the same owner (`user:<id>`) - see `src/protection/cache.ts`.

Function requests (learn-v7, `function_requests`, SPEC 8.10 / 13 / 15): an AI answer may carry a value-free
`functionRequest` and a short `explanation` on an unsupported column - see `src/learn/notes.ts`. A request is
stored only after a value filter (anything that occurs in the payload rejects it: counted, not stored), deduplicated
on name + signature, counted per distinct HASHED owner. The explanation is returned to the browser and never stored,
cached, logged or saved (`stripAiNotes` runs before the cache and before every registry save).

## Registry: formats, sources and conversions (M3, SPEC 8.12 / 8.15 / 13)

Signed-in users only (`401 signInRequired`), database required (`503 unavailable`); every read and write
checks ownership (someone else's id is a `404 notFound`); ids are 24-hex ObjectIds. Code in `src/registry/`.

| Route | What |
|---|---|
| `POST /api/formats` | create the format (`formatOf(rules)`), its **source** and the conversion between them. The source is chosen by `sourceId` (reuse that one), `newSource: { name }` (always a new one), or - neither - by matching `inputHeaders` (the example input's headers, structure only) against the caller's sources with flow C's matching and threshold: a match is **reused** and the answer carries `sourceReused: { id, name }` (the web app does not show it: sources are created and reused silently in the MVP); otherwise a new source (named by the optional `sourceName` - the user's own, `409 nameTaken` when in use -, else by the optional `suggestedSourceName` (the client's default from the example file's name, made unique with " (2)", " (3)" and never refused), else the first free "Source N"). The answer names `source: { id, name, formats }` (`formats`: how many formats it feeds now) |
| `GET /api/formats`, `GET /api/formats/:id` | list (sources, statuses, runs) / a format with its output side and its conversions |
| `PATCH /api/formats/:id`, `DELETE /api/formats/:id` | rename / delete with its conversions (frees a slot, never refunds learns or this month's new-format count) |
| `POST /api/formats/:id/conversions` | attach a conversion: the rules must pass the format lock, else `422 formatMismatch { problems }`; the source is chosen as above (a source that already feeds this format is never reused automatically); an explicit `sourceId` the rules don't fit answers `422 sourceMismatch { problems }` |
| `GET /api/conversions/:id`, `DELETE /api/conversions/:id` | the conversion with its rules and `sourceFormats` (how many formats its source feeds) / delete (the format stays) |
| `PATCH /api/conversions/:id` | rename the conversion's **source** (`sourceName`), and/or save edited rules as a new version (`{ rules, status, acceptedDifferences, exampleExceptions?, baseVersion? }`); if the output side changed it is a **format edit**: the format gets a new version and every other conversion of the format is rebuilt around it (`needsReview` when its references no longer resolve); if the input side changed it is a **source edit** (SPEC 8.15): the source gets a new version and every other conversion of it, whatever format it feeds, is rebuilt (`sourceChanged`, `affectedConversions`); the response says how many were affected |
| `GET /api/conversions/:id/versions`, `POST /api/conversions/:id/restore/:version` | history (newest first) / restore an older version as a new one (send `{}`); refused with `formatMismatch` / `sourceMismatch` when the format / source changed since (the source's aliases are brought over, the rest must match) |
| `POST /api/conversions/:id/runs` | `{ rows, flagged }` - counts only - bumps `runCount` / `lastRunAt` |
| `POST /api/conversions/:id/aliases` | kept for the web app; forwarded to the conversion's source (below) |
| `GET /api/signatures` | **one entry per source**: `{ sourceId, name, columns, conversions: [{ conversionId, formatId, formatName, status }] }`, for matching a dropped file in the browser (a source with no conversion yet has `conversions: []`) |
| `GET /api/sources`, `GET /api/sources/:id` | the caller's sources with the formats each feeds / one with its structure (headers, aliases, types, reading options, input checks - never a value) |
| `PATCH /api/sources/:id` | `{ name?, inputSignature?, inputReading?, inputValidations?, baseVersion? }`: a rename (names are unique per owner, any case: `409 nameTaken`) and/or an edit of the structure - a new source version **written into the `input` of every conversion of it** (`needsReview` when a conversion's rules no longer resolve; the response lists them); a column's `was` says which header a renamed one had; `required` is derived (required by at least one conversion) |
| `DELETE /api/sources/:id` | only when it feeds no format (`409 sourceInUse` otherwise). Deleting a conversion or a format leaves its source in place |
| `POST /api/sources/:id/aliases` | `{ header, alias }` - a confirmed column mapping, saved **once** on the source; every conversion of it learns it (no new versions) |

Sources are the company's (SPEC 8.15), and every conversion belongs to one: `sourceId` is required on the stored conversion and in every answer, and the source's own `name` is the only name (there is no copy on the conversion). There is no migration: a development database written before sources existed is cleared of the conversions (and their formats) that have no `sourceId`, not converted.

Tier limits (SPEC 11) answer `403 limitHit` with `limit: savedFormats | sourcesPerFormat | rulesPerFormat`,
or `429 limitHit` with `limit: newFormatsPerMonth` (paid, DECISION 9). Other refusals: `422 invalidRules
{ problems }`, `422 sourceMismatch { problems }`, `409 nameTaken | aliasConflict | versionConflict | sourceInUse`, `400 invalidRequest`.

Tests: `test/protection/` and `test/registry/`. The MongoDB-backed suites run when `MONGODB_URI` is set (they
use a throwaway database that is dropped afterwards), e.g.
`MONGODB_URI=mongodb://127.0.0.1:27017 pnpm --filter @formatai/api test`.

## Sign-in (M3, SPEC 5 E / 12)

Google and Microsoft through one OpenID Connect implementation (`openid-client`, authorization code + PKCE);
code in `src/auth/`. A provider is offered when its `<PREFIX>_CLIENT_ID` and `_CLIENT_SECRET` are both set
(`.env.example` lists the redirect URIs to register). Adding a provider = one entry in `auth/providers.ts`.

| Route | |
|---|---|
| `GET /api/auth/providers` | `{ providers: ['google', 'microsoft'] }` - the configured ones, Google first |
| `GET /api/auth/:provider/start?returnTo=` | 302 to the provider; state, nonce and the PKCE verifier go in a signed httpOnly `flow_<provider>` cookie (10 min); `returnTo` must be a same-site relative path |
| `GET /api/auth/:provider/callback` | validates, finds-or-creates the user by identity, sets the session, attaches the anonId, 302 to `WEB_ORIGIN` + `returnTo` (`?authError=<code>` on failure, `?linked=<provider>` after linking) |
| `POST /api/auth/logout` | ends the session |
| `GET /api/me` | `{ user: { id, name, avatarUrl, email?, tier, providers, isAdmin, uiLanguage } \| null }` |
| `PATCH /api/me` | `{ uiLanguage: 'he' \| 'en' }` and nothing else |
| `POST /api/me/link/:provider/start` | `{ url }` to navigate to; links a second provider to the signed-in user |
| `GET /api/learn/quota` | `{ quota: { remaining, period } }` - what is left of the signed-in user's AI learns (403 `signInForAi` otherwise); the account menu shows it |
| `POST /api/dev/session` | **development only** (the route does not exist when `NODE_ENV=production`): creates a throw-away signed-in test user (`{ name?, tier?: "registered" or "paid" }`, email under `@example.test`) and sets the session cookie, so the signed-in screens can be tried without a real provider; the Origin must be the web app's (any loopback name) |

Identity is provider + subject (Microsoft: `tid` + `oid`) - never the email; the same email at another provider is another
user. Sessions are stateful (`sessions` collection, TTL, only SHA-256 of the id stored; the cookie is `<id>.<HMAC>`), rotated at
sign-in, 30 days sliding (`limits.auth`). `identityOf(req)` (`protection/identity.ts`) returns the signed-in user
`{ kind: 'user', userId, tier, anonId, isAdmin, ... }` or the anonymous visitor. New users are `registered`; an admin sets `paid`.
Admin = verified Google email in `ADMIN_EMAILS` or Microsoft `oid` in `MICROSOFT_ADMIN_OIDS`. Production requires `SESSION_SECRET`
(and `API_PUBLIC_URL` when a provider is configured). Tests (`test/auth/`) run the real client against a fake local issuer.
