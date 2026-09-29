import { connectDb, ensureIndexes } from './db.js';
import { loadEnv } from './env.js';
import { buildServer } from './server.js';

async function main(): Promise<void> {
  const env = loadEnv();
  const db = await connectDb(env);
  if (db) {
    await ensureIndexes(db);
  }

  const app = await buildServer({ env, db });

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
