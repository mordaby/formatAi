import { backfillCounterExpiry, connectDb, ensureIndexes } from './db.js';
import { loadEnv } from './env.js';
import { checkProductionConfig, formatProductionProblems, webDistDir } from './productionConfig.js';
import { buildServer } from './server.js';

async function main(): Promise<void> {
  const env = loadEnv();
  const production = env.NODE_ENV === 'production';

  // Production: every missing setting in one message, before anything connects (never a value, only names).
  if (production) {
    const { problems, warnings } = checkProductionConfig(env);
    const message = formatProductionProblems(problems);
    if (message) {
      console.error(message);
      process.exit(1);
    }
    for (const warning of warnings) console.warn(`warning: ${warning}`);
  }

  const db = await connectDb(env);
  if (db) {
    await ensureIndexes(db);
    // Retention (owner decision 2026-10-07): counters from before every counter had an expiry get one, once (a no-op afterwards).
    const backfilled = await backfillCounterExpiry(db);
    if (backfilled > 0) console.info(`usage_counters: set the expiry of ${backfilled} counter(s) written without one`);
  }

  // One service, one origin: production (or an explicit WEB_DIST) serves the built web app too. Development keeps Vite on 5173.
  const webDist = production || env.WEB_DIST ? webDistDir(env) : undefined;
  const app = await buildServer({ env, db, webDist });

  await app.listen({ host: '0.0.0.0', port: env.PORT });

  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, 'shutting down');
    void app
      .close()
      .catch((err: unknown) => app.log.error({ err }, 'error while closing server'))
      .finally(() => db?.client.close())
      .finally(() => process.exit(0));
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
