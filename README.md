# formatAi

Learns a company's file formats from examples and converts incoming files (supplier price lists, partner reports, client exports, other systems' reports) into them — including exact system load files (csv / delimited text). A format has many sources; each source is taught once from an example pair, then a deterministic engine converts every future file. Files never leave the browser; an LLM only writes a small rules file, once. Domain-neutral by design.

- Product/build spec: [SPEC.md](SPEC.md)
- The learn-call prompt: [LEARN_PROMPT.md](LEARN_PROMPT.md)
- Task tracking: GitHub issues, grouped by milestone (M0–M4)

## Layout

```
packages/
  engine/   pure TS: read → detect table → rules pipeline → write (runs in browser worker + Node)
  shared/   rules schema (zod + JSON Schema), config (limits, tiers, models, prices), prompts, i18n codes
apps/
  api/      Fastify + MongoDB (LLM proxy, limits, accounts — built up in M1–M4)
  web/      React + Vite (M2)
eval/       model evaluation harness (M1)
vendor/     SheetJS tarball (installed from the SheetJS CDN, not the stale npm `xlsx`)
```

## Setup

Requires Node 24+ (`engines` in package.json) and pnpm 10.

```bash
pnpm install
cp .env.example .env   # then fill in values
pnpm test              # all packages
pnpm typecheck
```

### MongoDB

The API reads `MONGODB_URI` / `MONGODB_DB` from the repo-root `.env`.

- **Local dev:** a local MongoDB Community server works as is: `MONGODB_URI=mongodb://127.0.0.1:27017`, `MONGODB_DB=formatai_dev`.
- **Production:** paste your Atlas (or other) connection string.
- With `MONGODB_URI` empty the API still boots; `/api/health` reports `db: "not configured"`.

Run the API: `pnpm --filter @formatai/api dev` → http://localhost:8787/api/health

## Status

- **M0 — engine without AI (spec v3):** rules schema v1 incl. typed operations, functions and lookup tables; type checker and limits; format lock (formatOf / checkFormatLock); table detection; the 11-step pipeline (decimal math, dedupe, three expand modes, groups, titles, input/output validations); read xlsx/xls/csv/txt; write xlsx (RTL) and csv/txt (delimiter, header on/off, quoting, UTF-8/Windows-1255); golden tests across domains.
- **M1 — learning:** column profile and pair analysis; pre-flight; strict fast path (no LLM); masking; payload builder; one LLM interface (`LLM_PROVIDER`: anthropic | openai | claude-cli | fake); LLM writes formulas parsed into the whitelisted AST; layered checks + repair + escalation; full verification; eval harness with 38 cases across domains and next-month hold-outs — see [eval/RESULTS.md](eval/RESULTS.md).
- **M2 — web tool:** approved design (docs/design-plan.md); Hebrew/English + RTL/LTR; the engine runs in a Web Worker; upload → pre-flight → learn → rules map, editor with live match counter and one-off exceptions, preview with differences; masking switch and "See what we send"; budgets and an owner-scoped cache.
- **M3 — accounts:** Google and Microsoft sign-in (the AI learn needs it: sign-in is its gate, with a per-user quota; Turnstile guards only the public forms); the registry of formats and sources; convert with matching; batch.
- **M4 — launch pieces:** the admin view, the business page, the waitlist and feedback, the privacy, terms and accessibility pages, and the deploy (docs/deploy.md).

### Run the app locally

`pnpm dev` starts the API (8787) and the web app (http://localhost:5173). Tests: `pnpm test` (hermetic — it never reads your .env). API database tests: set `MONGODB_URI=mongodb://127.0.0.1:27017 MONGODB_DB=formatai_test` for that run. They never touch your own database: every test file makes its own `formatai_test_*` database and drops it, and the suite drops any left on a local MongoDB before and after the run. To clear them by hand: `pnpm --filter @formatai/api db:drop-test` (local MongoDB only).

### Dev LLM without an API key

Set `LLM_PROVIDER=claude-cli` and log in once: `npm i -g @anthropic-ai/claude-code`, run `claude`, type `/login`. Calls then use your Claude subscription (dev only; refused in production). Run the eval: `pnpm eval --provider claude-cli --models haiku --masking on,off`.
