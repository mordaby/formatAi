// The suite's clean-up of its throwaway databases (test/setup/testDbs.ts): which server and which names it may touch. Never run against a
// real server here - dropping in a test would take the other files' databases away while they run.
import { describe, expect, it } from 'vitest';
import { dropTestDb, isTestDbName, localMongoUri } from './setup/testDbs.js';

describe('the test databases clean-up', () => {
  it('works on a MongoDB on this machine only', () => {
    expect(localMongoUri('mongodb://127.0.0.1:27017')).toBe('mongodb://127.0.0.1:27017');
    expect(localMongoUri('mongodb://localhost:27017/x')).toBe('mongodb://localhost:27017/x');
    expect(localMongoUri('mongodb://[::1]:27017')).toBe('mongodb://[::1]:27017');
    expect(localMongoUri('mongodb+srv://user:pw@cluster.example.mongodb.net')).toBeNull();
    expect(localMongoUri('mongodb://10.0.0.5:27017')).toBeNull();
    expect(localMongoUri(undefined)).toBeNull();
    expect(localMongoUri('')).toBeNull();
  });

  it('drops formatai_test and formatai_test_* only', () => {
    for (const name of ['formatai_test', 'formatai_test_1a2b3c4d', 'formatai_test_reg_x']) expect(isTestDbName(name)).toBe(true);
    for (const name of ['formatai', 'formatai_dev', 'formatai_testing', 'admin', 'local', 'config', 'x_formatai_test']) expect(isTestDbName(name)).toBe(false);
  });

  it("drops a file's database first, and still closes the app and the client when the drop fails", async () => {
    const order: string[] = [];
    const appDb = {
      db: {
        dropDatabase: async () => {
          order.push('drop');
          throw new Error('server gone');
        },
      },
      client: { close: async () => void order.push('client') },
    };
    const app = { close: async () => void order.push('app') };
    await expect(dropTestDb(appDb as never, app)).rejects.toThrow('server gone');
    expect(order).toEqual(['drop', 'app', 'client']);
  });
});
