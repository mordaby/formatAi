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

Requires Node 22+ and pnpm 10.

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
- Next: **M1 — learning** (pair analysis, pre-flight, fast path, masking, payload, LLM client, eval harness).
