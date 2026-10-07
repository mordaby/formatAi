// Drops the databases the API test suite leaves behind on a local MongoDB: `formatai_test` and every `formatai_test_*` (parallel test
// files each make their own). Nothing else is ever touched - not `formatai_dev`, not any other database, not MongoDB's own (admin,
// config, local).
//
//   node apps/api/scripts/drop-test-dbs.mjs          lists what would be dropped
//   node apps/api/scripts/drop-test-dbs.mjs --yes    drops them
//
// MONGODB_URI overrides the default local address. A remote (non-localhost) address is refused: this is a local clean-up tool only.
import { MongoClient } from 'mongodb';

const uri = process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27017';
const host = new URL(uri.replace(/^mongodb(\+srv)?:/, 'http:')).hostname;
if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host)) {
  console.error(`Refusing: ${host} is not a local MongoDB. This tool only cleans a local database server.`);
  process.exit(1);
}

const TEST_DB = /^formatai_test(_.+)?$/;
const doIt = process.argv.includes('--yes');

const client = new MongoClient(uri);
await client.connect();
try {
  const { databases } = await client.db('admin').admin().listDatabases();
  const targets = databases.map((d) => d.name).filter((name) => TEST_DB.test(name));
  if (targets.length === 0) {
    console.log('No test databases to drop.');
  } else if (!doIt) {
    console.log(`Would drop ${targets.length} test database(s):\n  ${targets.join('\n  ')}\nRun again with --yes to drop them.`);
  } else {
    for (const name of targets) {
      await client.db(name).dropDatabase();
      console.log(`dropped ${name}`);
    }
    console.log(`Done: ${targets.length} test database(s) dropped.`);
  }
} finally {
  await client.close();
}
