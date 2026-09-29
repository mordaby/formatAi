# formatAi

Learns an Excel report format from one example pair (input → the output made by hand), then converts new files into that format with a deterministic engine. Files never leave the browser; an LLM only writes a small rules file, once.

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

- **M0 — engine without AI:** rules schema, table detection, the 11-step pipeline (decimal math, dedupe, three expand modes, groups, titles, validations), xlsx/csv read & write incl. RTL, golden tests.
- Next: **M1 — learning** (pair analysis, pre-flight, fast path, masking, payload, LLM client, eval harness).
