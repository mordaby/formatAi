// "The learned rules survive sign-in" (SPEC 5 E). Signing in sends the browser away to Google or Microsoft and back,
// which reloads the page and forgets everything held in memory. So just before the redirect, what has been learned so
// far - the two example files (names and bytes), the masking choice, the result screen's edits, and a visitor's choice of
// "Learn with AI" - is kept in this browser's IndexedDB, and put back when the app starts again.
//
// SPEC 2/15: this NEVER leaves the browser: it is written to and read from IndexedDB only, no network code is
// anywhere near it. It is dropped once restored, and after an hour (`webConfig.pendingLearn.maxAgeMs`) whether or
// not it was - the privacy page promises it: every page load drops a copy past its hour at once, and an open tab
// drops one when its hour is up (`keepPendingWithinTheHour`). Every browser storage call is wrapped: private windows,
// blocked site data and quota errors just mean "nothing was kept", and the app carries on without it.
import type { LearnResult, Rules } from '@formatai/shared';
import { webConfig } from '../config';

export interface StoredFile {
  name: string;
  type: string;
  bytes: ArrayBuffer;
}

/** The result screen's state worth keeping: the rules as edited so far, which lines were edited, the one-off exceptions. */
export interface PendingResult {
  /** The format's name (the title). */
  name: string;
  rules: LearnResult | Rules;
  edited: string[];
  exceptions: number[];
}

export interface PendingLearn {
  version: 1;
  /** `Date.now()` when it was kept. */
  savedAt: number;
  /** Where the browser was (a path, no query), for information. */
  path: string;
  input: StoredFile | null;
  output: StoredFile | null;
  masking: boolean;
  /** The learn was continued past "rows couldn't be aligned" (SPEC 6.4); the local analysis is re-run the same way. */
  tryAnyway?: boolean;
  /** A visitor chose "Learn with AI" on Home and signed in from its wall: once they are signed in, the learn starts by itself (no `result` is kept with it) and the AI step follows. */
  deepAnalysis?: boolean;
  /** Set when a result was on screen; the local analysis is re-run on the files and these edits are put back on top. */
  result: PendingResult | null;
}

export interface PendingLearnStore {
  /** Keeps `record`, replacing any earlier one. Resolves false when the browser would not (nothing is kept). */
  save(record: PendingLearn): Promise<boolean>;
  /** The kept record, or null when there is none, it is too old (it is then dropped too), or storage failed. */
  load(now?: number): Promise<PendingLearn | null>;
  clear(): Promise<void>;
}

function usable(value: unknown, now: number): value is PendingLearn {
  if (typeof value !== 'object' || value === null) return false;
  const r = value as Partial<PendingLearn>;
  if (r.version !== 1 || typeof r.savedAt !== 'number') return false;
  // A record from the future (a clock that moved back) is as unusable as an old one.
  return r.savedAt <= now + 60_000 && now - r.savedAt <= webConfig.pendingLearn.maxAgeMs;
}

/** In memory: tests, and browsers with no IndexedDB. It does not survive a reload, which is the honest limit there. */
export function createMemoryPendingStore(): PendingLearnStore {
  let kept: PendingLearn | null = null;
  return {
    save: async (record) => {
      kept = record;
      return true;
    },
    load: async (now = Date.now()) => {
      if (kept && !usable(kept, now)) kept = null;
      return kept;
    },
    clear: async () => {
      kept = null;
    },
  };
}

/** IndexedDB (`factory` is injectable so a test can pass a small fake). */
export function createIdbPendingStore(factory: IDBFactory): PendingLearnStore {
  const { dbName, storeName, key } = webConfig.pendingLearn;

  const open = (): Promise<IDBDatabase> =>
    new Promise((resolve, reject) => {
      const req = factory.open(dbName, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(storeName)) req.result.createObjectStore(storeName);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error('IndexedDB could not be opened'));
      req.onblocked = () => reject(new Error('IndexedDB is blocked'));
    });

  /** One request in its own transaction; the promise settles when the transaction has finished. */
  async function run<T>(mode: IDBTransactionMode, make: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const db = await open();
    try {
      return await new Promise<T>((resolve, reject) => {
        const tx = db.transaction(storeName, mode);
        const req = make(tx.objectStore(storeName));
        let result: T;
        req.onsuccess = () => {
          result = req.result;
        };
        req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
        tx.oncomplete = () => resolve(result);
        tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
        tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
      });
    } finally {
      db.close();
    }
  }

  return {
    async save(record) {
      try {
        await run('readwrite', (s) => s.put(record, key));
        return true;
      } catch {
        return false;
      }
    },
    async load(now = Date.now()) {
      try {
        const value = await run<unknown>('readonly', (s) => s.get(key));
        if (value === undefined) return null;
        if (usable(value, now)) return value;
        await run('readwrite', (s) => s.delete(key)); // too old (or not ours): dropped
        return null;
      } catch {
        return null;
      }
    },
    async clear() {
      try {
        await run('readwrite', (s) => s.delete(key));
      } catch {
        // nothing to do: an hour from now it is stale anyway
      }
    },
  };
}

let current: PendingLearnStore | undefined;

/** The store the app uses: IndexedDB when the browser has it, else memory. */
export function getPendingStore(): PendingLearnStore {
  if (!current) {
    let factory: IDBFactory | undefined;
    try {
      factory = typeof indexedDB === 'undefined' ? undefined : indexedDB;
    } catch {
      factory = undefined; // reading it can throw when site data is blocked
    }
    current = factory ? createIdbPendingStore(factory) : createMemoryPendingStore();
  }
  return current;
}

/** Tests: replace the store (pass undefined to go back to the default). */
export function setPendingStore(store: PendingLearnStore | undefined): void {
  current = store;
}

/**
 * The hour the privacy page promises ("kept ... for up to an hour ... and then deleted"), enforced - not only when the app next starts and
 * restores: at once on every page load (a copy past its hour is dropped by `load`, whoever is signed in and whatever the screen), and while
 * the tab is open a timer drops the copy when its hour is up (one this tab kept for a sign-in that did not leave after all, or one another tab
 * kept: the store is read again every `sweepEveryMs`). `check()` reads it again now (after this tab kept one); `stop()` ends the timers.
 */
export function keepPendingWithinTheHour(getStore: () => PendingLearnStore = getPendingStore): { check(): void; stop(): void } {
  const { maxAgeMs, sweepEveryMs } = webConfig.pendingLearn;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const check = (): void => {
    void (async () => {
      const record = await getStore().load(); // (a copy past its hour is dropped by this very read)
      if (stopped) return;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      // (a moment past the hour, so that the copy reads as too old then)
      if (record) timer = setTimeout(check, Math.max(0, record.savedAt + maxAgeMs - Date.now()) + 1000);
    })().catch(() => undefined);
  };
  check();
  const sweep = setInterval(check, sweepEveryMs);
  return {
    check,
    stop: () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      clearInterval(sweep);
    },
  };
}

/** A dropped `File`, as it is kept: name, type and bytes. */
export async function storeFile(file: File): Promise<StoredFile> {
  return { name: file.name, type: file.type, bytes: await file.arrayBuffer() };
}

/** The other way round, for the files the app keeps in its session. */
export function fileOf(stored: StoredFile): File {
  return new File([stored.bytes], stored.name, { type: stored.type });
}
