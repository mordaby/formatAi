// pnpm migrate:sources [-- --dry-run]
//
// Groups every owner's conversions that have no `sourceId` yet into sources (SPEC 8.15, 21 v6) and links them; see
// `src/registry/migrate.ts` for the grouping rules. Never touches a rules file. Idempotent: run it again and it finds nothing to do.
// `--dry-run` prints what it would do (owner, planned sources with column count and merged conversions) and writes nothing.
//
// The database is the one in MONGODB_URI / MONGODB_DB (or the repo-root .env), like the API's:
//   MONGODB_URI=mongodb://127.0.0.1:27017 MONGODB_DB=formatai_dev pnpm migrate:sources -- --dry-run
import { connectDb, ensureIndexes } from '../src/db.js';
import { loadEnv } from '../src/env.js';
import { describeMigration, runSourceMigration } from '../src/registry/migrate.js';

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const env = loadEnv();
  const db = await connectDb(env);
  if (!db) {
    console.error('MONGODB_URI is not set: nothing to migrate.');
    process.exitCode = 1;
    return;
  }
  try {
    // The unique (owner, name) index is what keeps two sources from taking one name: make sure it exists before writing.
    if (!dryRun) await ensureIndexes(db);
    const summary = await runSourceMigration(db, { dryRun });
    for (const line of describeMigration(summary, env.MONGODB_DB)) console.log(line);
  } finally {
    await db.client.close();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
