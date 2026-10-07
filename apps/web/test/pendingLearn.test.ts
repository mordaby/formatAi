// SPEC 5 E "The learned rules survive sign-in": the two example files and the edits are kept in the browser's IndexedDB across the
// trip to the provider - and never anywhere else. A round trip through a small fake IndexedDB, the one-hour limit, and the ways
// browser storage can refuse (which must never break the app).
import { cleanup, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createIdbPendingStore, createMemoryPendingStore, fileOf, keepPendingWithinTheHour, setPendingStore, storeFile, type PendingLearn, type PendingLearnStore } from '../src/app/pendingLearn';
import { webConfig } from '../src/config';
import { ordersRules } from '../src/editor/testkit';
import { createFakeIndexedDb } from './helpers/fakeIndexedDb';
import { fakeApi, renderApp } from './helpers/renderApp';

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

/** A store like the memory one (`load` drops a copy past its hour), whose content a test can look at without reading it through `load`. */
function peekable(): { store: PendingLearnStore; peek(): PendingLearn | null } {
  let kept: PendingLearn | null = null;
  return {
    store: {
      save: async (r) => {
        kept = r;
        return true;
      },
      load: async (now = Date.now()) => {
        if (kept && now - kept.savedAt > webConfig.pendingLearn.maxAgeMs) kept = null;
        return kept;
      },
      clear: async () => {
        kept = null;
      },
    },
    peek: () => kept,
  };
}

// The audit's C8: the privacy page promises the copy kept for a sign-in is deleted after about an hour - it was only deleted when the app
// next started (and only once it knew who was signed in).
describe('the hour is enforced (the privacy page\'s promise)', () => {
  afterEach(() => {
    vi.useRealTimers();
    cleanup();
    setPendingStore(undefined);
  });

  it('while the tab is open, a kept copy is dropped when its hour is up', async () => {
    vi.useFakeTimers();
    const { store, peek } = peekable();
    await store.save(record({ savedAt: Date.now() }));
    const hour = keepPendingWithinTheHour(() => store);
    await vi.advanceTimersByTimeAsync(59 * 60 * 1000);
    expect(peek()).not.toBeNull();
    await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
    expect(peek()).toBeNull();
    hour.stop();
  });

  it('... and so is one another tab kept meanwhile (the store is looked at again while the tab is open)', async () => {
    vi.useFakeTimers();
    const { store, peek } = peekable();
    const hour = keepPendingWithinTheHour(() => store);
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    await store.save(record({ savedAt: Date.now() })); // another tab, just before it left for the provider
    await vi.advanceTimersByTimeAsync(webConfig.pendingLearn.maxAgeMs + webConfig.pendingLearn.sweepEveryMs + 2000);
    expect(peek()).toBeNull();
    hour.stop();
  });

  it('a copy this tab keeps for a sign-in that does not leave (a blocked redirect) is dropped on its hour too: the tab is told it was kept', async () => {
    vi.useFakeTimers();
    const { store, peek } = peekable();
    const hour = keepPendingWithinTheHour(() => store);
    await vi.advanceTimersByTimeAsync(1000);
    await store.save(record({ savedAt: Date.now() }));
    hour.check();
    await vi.advanceTimersByTimeAsync(webConfig.pendingLearn.maxAgeMs + 2000);
    expect(peek()).toBeNull();
    hour.stop();
  });

  it('a page load drops a copy past its hour at once - before it is known who is signed in (who may never be)', async () => {
    const { store, peek } = peekable();
    await store.save(record({ savedAt: Date.now() - 2 * webConfig.pendingLearn.maxAgeMs }));
    setPendingStore(store);
    renderApp({ api: fakeApi({ auth: { me: vi.fn(() => new Promise<never>(() => undefined)) } }) });
    await waitFor(() => expect(peek()).toBeNull());
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
