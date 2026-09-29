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
