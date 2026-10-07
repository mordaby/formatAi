// The API suite's throwaway MongoDB databases (`formatai_test`, `formatai_test_*`: every test file makes its own). Two pieces:
//
//   - `setup` / `teardown` - vitest's `globalSetup` (vitest.config.ts): before and after the whole run, every such database on a LOCAL
//     MongoDB is dropped, so a run that crashed or timed out (a hook past its timeout skips the rest of its teardown) leaves nothing behind
//     for the next one. A remote address (Atlas) is never touched - the same rule as `scripts/drop-test-dbs.mjs` (`pnpm db:drop-test`).
//     DECISION: before AND after - before, for what an earlier run left; after, for what this one did. Two suites run at once against the
//     same local server would drop each other's databases: run them one after the other.
//   - `dropTestDb` - one test file's teardown: its database is dropped FIRST and whatever happens next (an app whose close throws or hangs
//     can no longer skip it), then the app and the client are closed.
import { MongoClient } from 'mongodb';
import type { AppDb } from '../../src/db.js';

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const TEST_DB = /^formatai_test(_.+)?$/;

/** `uri` when it is a MongoDB on this machine, else null (none set, a remote server, or no URL at all). */
export function localMongoUri(uri: string | undefined): string | null {
  if (!uri) return null;
  try {
    const host = new URL(uri.replace(/^mongodb(\+srv)?:/, 'http:')).hostname;
    return LOCAL_HOSTS.has(host) ? uri : null;
  } catch {
    return null;
  }
}

/** Whether a database name is one of the suite's throwaway databases (and so may be dropped). */
export const isTestDbName = (name: string): boolean => TEST_DB.test(name);

/** Drops every `formatai_test` / `formatai_test_*` database of the local MongoDB; nothing else, and never on a remote one. */
export async function dropLocalTestDbs(): Promise<string[]> {
  const uri = localMongoUri(process.env.MONGODB_URI);
  if (!uri) return [];
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 5_000 });
  try {
    await client.connect();
    const { databases } = await client.db('admin').admin().listDatabases({ nameOnly: true });
    const targets = databases.map((d) => d.name).filter(isTestDbName);
    for (const name of targets) await client.db(name).dropDatabase();
    return targets;
  } catch {
    // No local server running: the suites that need one are skipped or fail on their own, with their own message.
    return [];
  } finally {
    await client.close();
  }
}

export async function setup(): Promise<void> {
  await dropLocalTestDbs();
}

export async function teardown(): Promise<void> {
  await dropLocalTestDbs();
}

/** One test file's teardown: the database is dropped first, whatever happens next; then the app (when there is one) and the client close. */
export async function dropTestDb(appDb: AppDb | null | undefined, app?: { close(): Promise<unknown> } | null): Promise<void> {
  try {
    await appDb?.db.dropDatabase();
  } finally {
    try {
      await app?.close();
    } finally {
      await appDb?.client.close();
    }
  }
}
