// A very small IndexedDB stand-in for tests (happy-dom has none, and no new dependency is allowed): just enough of the
// real API for `createIdbPendingStore` - open with an upgrade step, one object store, put / get / delete in a
// transaction that completes asynchronously. Values are structured-cloned, like the real thing.

type Handler<T> = ((this: T, ev: unknown) => void) | null;

class FakeRequest<T> {
  result!: T;
  error: Error | null = null;
  onsuccess: Handler<FakeRequest<T>> = null;
  onerror: Handler<FakeRequest<T>> = null;
  onupgradeneeded: Handler<FakeRequest<T>> = null;
  onblocked: Handler<FakeRequest<T>> = null;
}

class FakeTransaction {
  oncomplete: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  error: Error | null = null;
  /** Work queued by requests; it runs, then `oncomplete` fires. */
  readonly work: (() => void)[] = [];
  constructor(private readonly stores: Map<string, Map<string, unknown>>, private readonly storeName: string) {}

  objectStore(name: string): FakeObjectStore {
    if (name !== this.storeName) throw new Error(`no such store ${name}`);
    const data = this.stores.get(name);
    if (!data) throw new Error(`no such store ${name}`);
    return new FakeObjectStore(data, this);
  }

  start(): void {
    setTimeout(() => {
      for (const job of this.work) job();
      setTimeout(() => this.oncomplete?.(), 0);
    }, 0);
  }
}

class FakeObjectStore {
  constructor(private readonly data: Map<string, unknown>, private readonly tx: FakeTransaction) {}

  private request<T>(run: () => T): FakeRequest<T> {
    const req = new FakeRequest<T>();
    this.tx.work.push(() => {
      try {
        req.result = run();
        req.onsuccess?.call(req, {});
      } catch (e) {
        req.error = e as Error;
        req.onerror?.call(req, {});
      }
    });
    return req;
  }

  put(value: unknown, key: string): FakeRequest<string> {
    return this.request(() => {
      this.data.set(key, structuredClone(value));
      return key;
    });
  }
  get(key: string): FakeRequest<unknown> {
    return this.request(() => (this.data.has(key) ? structuredClone(this.data.get(key)) : undefined));
  }
  delete(key: string): FakeRequest<undefined> {
    return this.request(() => {
      this.data.delete(key);
      return undefined;
    });
  }
}

class FakeDatabase {
  readonly objectStoreNames = { contains: (name: string): boolean => this.stores.has(name) };
  constructor(readonly stores: Map<string, Map<string, unknown>>) {}
  createObjectStore(name: string): void {
    this.stores.set(name, new Map());
  }
  transaction(storeName: string): FakeTransaction {
    const tx = new FakeTransaction(this.stores, storeName);
    tx.start();
    return tx;
  }
  close(): void {}
}

export interface FakeIdb {
  factory: IDBFactory;
  /** What is stored, for the test to look at. */
  databases: Map<string, Map<string, Map<string, unknown>>>;
  /** The next `open` fails. */
  failNextOpen(): void;
}

export function createFakeIndexedDb(): FakeIdb {
  const databases = new Map<string, Map<string, Map<string, unknown>>>();
  let fail = false;
  const factory = {
    open(name: string): FakeRequest<FakeDatabase> {
      const req = new FakeRequest<FakeDatabase>();
      setTimeout(() => {
        if (fail) {
          fail = false;
          req.error = new Error('blocked by the browser');
          req.onerror?.call(req, {});
          return;
        }
        let stores = databases.get(name);
        const fresh = !stores;
        if (!stores) {
          stores = new Map();
          databases.set(name, stores);
        }
        const db = new FakeDatabase(stores);
        req.result = db;
        if (fresh) req.onupgradeneeded?.call(req, {});
        req.onsuccess?.call(req, {});
      }, 0);
      return req;
    },
  } as unknown as IDBFactory;
  return { factory, databases, failNextOpen: () => (fail = true) };
}
