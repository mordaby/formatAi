// SPEC 5 E "The learned rules survive sign-in": the two example files and the edits are kept in the browser's IndexedDB across the
// trip to the provider - and never anywhere else. A round trip through a small fake IndexedDB, the one-hour limit, and the ways
// browser storage can refuse (which must never break the app).
import { describe, expect, it } from 'vitest';
import { createIdbPendingStore, createMemoryPendingStore, fileOf, storeFile, type PendingLearn } from '../src/app/pendingLearn';
import { webConfig } from '../src/config';
import { ordersRules } from '../src/editor/testkit';
import { createFakeIndexedDb } from './helpers/fakeIndexedDb';

const NOW = 1_800_000_000_000;

function record(over: Partial<PendingLearn> = {}): PendingLearn {
  return {
    version: 1,
    savedAt: NOW,
    path: '/result',
    input: { name: 'orders.csv', type: 'text/csv', bytes: new TextEncoder().encode('a,b\n1,2\n').buffer as ArrayBuffer },
    output: { name: 'report.csv', type: 'text/csv', bytes: new TextEncoder().encode('x\n1\n').buffer as ArrayBuffer },
    masking: true,
    result: { name: 'Orders report', rules: ordersRules(), edited: ['col:Total'], exceptions: [4, 9] },
    ...over,
  };
}

describe('IndexedDB store', () => {
  it('keeps a learn and gives it back exactly: file names and bytes, masking, the edited rules, the exceptions', async () => {
    const idb = createFakeIndexedDb();
    const store = createIdbPendingStore(idb.factory);
    expect(await store.load(NOW)).toBeNull();

    expect(await store.save(record())).toBe(true);
    const back = await store.load(NOW + 60_000);
    expect(back).not.toBeNull();
    expect(back!.input!.name).toBe('orders.csv');
    expect(new TextDecoder().decode(back!.input!.bytes)).toBe('a,b\n1,2\n');
    expect(new TextDecoder().decode(back!.output!.bytes)).toBe('x\n1\n');
    expect(back!.masking).toBe(true);
    expect(back!.result).toEqual({ name: 'Orders report', rules: ordersRules(), edited: ['col:Total'], exceptions: [4, 9] });

    // It is in the database named in config, and nowhere else.
    const { dbName, storeName, key } = webConfig.pendingLearn;
    expect(idb.databases.get(dbName)!.get(storeName)!.has(key)).toBe(true);
  });

  it('replaces an earlier record, and clear() forgets it', async () => {
    const store = createIdbPendingStore(createFakeIndexedDb().factory);
    await store.save(record({ path: '/one' }));
    await store.save(record({ path: '/two' }));
    expect((await store.load(NOW))!.path).toBe('/two');
    await store.clear();
    expect(await store.load(NOW)).toBeNull();
  });

  it('drops a record after an hour (and removes it), and one from the future', async () => {
    const idb = createFakeIndexedDb();
    const store = createIdbPendingStore(idb.factory);
    await store.save(record());
    const { dbName, storeName, key } = webConfig.pendingLearn;

    expect(await store.load(NOW + webConfig.pendingLearn.maxAgeMs - 1)).not.toBeNull();
    expect(await store.load(NOW + webConfig.pendingLearn.maxAgeMs + 1)).toBeNull();
    expect(idb.databases.get(dbName)!.get(storeName)!.has(key)).toBe(false);

    await store.save(record({ savedAt: NOW + 10 * 60_000 }));
    expect(await store.load(NOW)).toBeNull();
  });

  it('ignores something in the store that is not one of ours', async () => {
    const idb = createFakeIndexedDb();
    const store = createIdbPendingStore(idb.factory);
    await store.save({ version: 2, savedAt: NOW } as unknown as PendingLearn);
    expect(await store.load(NOW)).toBeNull();
  });

  it('never throws when the browser refuses: save says false, load says null', async () => {
    const idb = createFakeIndexedDb();
    const store = createIdbPendingStore(idb.factory);
    idb.failNextOpen();
    expect(await store.save(record())).toBe(false);
    idb.failNextOpen();
    expect(await store.load(NOW)).toBeNull();
    idb.failNextOpen();
    await expect(store.clear()).resolves.toBeUndefined();
    // and it works again afterwards
    expect(await store.save(record())).toBe(true);
  });
});

describe('memory store (browsers without IndexedDB, and tests)', () => {
  it('keeps, expires and clears', async () => {
    const store = createMemoryPendingStore();
    await store.save(record());
    expect(await store.load(NOW)).not.toBeNull();
    expect(await store.load(NOW + webConfig.pendingLearn.maxAgeMs + 1)).toBeNull();
    await store.save(record());
    await store.clear();
    expect(await store.load(NOW)).toBeNull();
  });
});

describe('files', () => {
  it('a dropped file comes back as the same file', async () => {
    const original = new File(['hello,world\n1,2\n'], 'input.csv', { type: 'text/csv' });
    const stored = await storeFile(original);
    expect(stored).toMatchObject({ name: 'input.csv', type: 'text/csv' });
    const back = fileOf(stored);
    expect(back.name).toBe('input.csv');
    expect(await back.text()).toBe('hello,world\n1,2\n');
  });
});
