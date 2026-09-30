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

## Protections in front of the LLM (M2, SPEC 9.5 / 11 / 12 / 15)

`POST /api/learn` and `POST /api/learn/repair` exist in every environment and are guarded by, in order:
a per-IP request rate limit (`limits.protection`), the body shape, Cloudflare Turnstile
(`turnstileToken`, anonymous learns), the owner's structure cache, the daily budgets
(`limits.budgets`), and the per-tier learn limits (`tiers.*.learnsToLlm`, plus
`limits.protection.anonLearnsPerIpPerDay`). Refusals are `{ error, limit? }` with a stable code
(`packages/shared/src/codes.ts`, texts in `i18n/messages.ts`):

| Status | `error` | When |
|---|---|---|
| 429 | `rateLimited` | too many requests from one IP this minute (`Retry-After` set) |
| 403 | `turnstileFailed` | Turnstile token missing or rejected |
| 429 | `limitHit` + `limit` (`learnsPerDay`, `learnsPerMonth`, `repairsPerLearn`) | a per-tier limit |
| 429 | `anonBudgetExhausted` | the daily anonymous budget is spent ("Sign in to keep going") |
| 503 | `budgetExhausted` | the daily overall budget is spent (kill switch) |
| 400 | `invalidPayload`, `invalidPreviousRules`, `invalidProblems`, `invalidLearnId` | malformed body / repair without a valid `learnId` |

`GET /api/session` returns `{ anonId, tier: 'free', limits, turnstileSiteKey? }` and sets the
first-party `anonId` cookie (httpOnly, SameSite=Lax, Secure in production) on first contact.

Production (`NODE_ENV=production`) refuses to start without `TURNSTILE_SECRET_KEY`,
`IP_HASH_SECRET` (or `SESSION_SECRET`) and `MONGODB_URI`. Behind a proxy or load balancer set
`TRUST_PROXY` (number of hops, or `true`) so per-IP limits see the real client address. In
development with no `TURNSTILE_SECRET_KEY`, Turnstile is skipped (one warning); with no
`MONGODB_URI`, limits, budgets and the cache are kept in memory.

The learn cache (`learn_cache`) is keyed by a hash of the structure only and is only ever returned
to the same owner (anonId now, user id in M3) - see `src/protection/cache.ts`.

Tests: `test/protection/`. The MongoDB-backed suites run when `MONGODB_URI` is set (they use a
throwaway database that is dropped afterwards), e.g.
`MONGODB_URI=mongodb://127.0.0.1:27017 pnpm --filter @formatai/api test`.
