/**
 * An in-memory IndexedDB covering exactly the surface `../db` uses: open with
 * an upgrade callback, then transaction / objectStore / put / get / getAll /
 * getAllKeys / delete / clear. No cursors, no indexes, no key paths — db.ts does
 * not use them, so neither does this.
 *
 * It lives beside the suites that need it rather than in `src/test/setup.ts`,
 * because a fake has to match the exact API the code under test calls and only
 * the offline layer calls this one.
 *
 * Two behaviours are deliberate:
 *   - Callbacks fire on a microtask, as they do in a browser. db.ts assigns
 *     `request.onsuccess` after `open()` returns, so a synchronous fire would
 *     call a handler that is still null and every test would hang.
 *   - Records are cloned through JSON on the way in and out. Real IndexedDB
 *     stores structured clones, and a fake that handed back the caller's own
 *     object would let a test pass by mutating a stored record in place — which
 *     would then fail in the browser.
 */

type Handler = (() => void) | null;

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

class FakeRequest<T = unknown> {
  result: T | undefined;
  error: Error | null = null;
  onsuccess: Handler = null;
  onerror: Handler = null;

  /**
   * `settle` makes the request succeed on a microtask, which is when a browser
   * would. db.ts attaches `onsuccess` after the call returns, so firing
   * synchronously would call a handler that is still null and the read would
   * hang forever. Writes pass `false`: db.ts ignores their requests and waits on
   * the transaction instead.
   */
  constructor(result?: T, settle = false) {
    this.result = result;
    if (settle) queueMicrotask(() => this.onsuccess?.());
  }
}

class FakeOpenRequest extends FakeRequest<FakeDatabase> {
  onupgradeneeded: Handler = null;
  onblocked: Handler = null;

  constructor(result: FakeDatabase, needsUpgrade: boolean) {
    super(result);
    queueMicrotask(() => {
      if (needsUpgrade) this.onupgradeneeded?.();
      this.onsuccess?.();
    });
  }
}

class FakeObjectStore {
  constructor(private readonly records: Map<string, unknown>) {}

  put(value: unknown, key: string): FakeRequest {
    this.records.set(key, clone(value));
    return new FakeRequest();
  }

  get(key: string): FakeRequest {
    const found = this.records.get(key);
    return new FakeRequest(found === undefined ? undefined : clone(found), true);
  }

  getAll(): FakeRequest {
    return new FakeRequest([...this.records.values()].map(clone), true);
  }

  getAllKeys(): FakeRequest {
    return new FakeRequest([...this.records.keys()], true);
  }

  delete(key: string): FakeRequest {
    this.records.delete(key);
    return new FakeRequest();
  }

  clear(): FakeRequest {
    this.records.clear();
    return new FakeRequest();
  }
}

class FakeTransaction {
  error: Error | null = null;
  oncomplete: Handler = null;
  onabort: Handler = null;
  onerror: Handler = null;

  constructor(private readonly stores: Map<string, Map<string, unknown>>) {
    // The writes happen synchronously after `transaction()` returns and before
    // db.ts awaits completion, so a microtask is late enough to be correct.
    queueMicrotask(() => this.oncomplete?.());
  }

  objectStore(name: string): FakeObjectStore {
    const records = this.stores.get(name);
    if (!records) throw new Error(`No object store named "${name}"`);
    return new FakeObjectStore(records);
  }
}

class FakeDatabase {
  onversionchange: Handler = null;
  closed = false;

  readonly objectStoreNames = {
    contains: (name: string): boolean => this.stores.has(name),
  };

  constructor(private readonly stores: Map<string, Map<string, unknown>>) {}

  createObjectStore(name: string): void {
    this.stores.set(name, new Map());
  }

  transaction(store: string | string[]): FakeTransaction {
    return new FakeTransaction(this.stores);
  }

  close(): void {
    this.closed = true;
  }
}

export interface FakeIndexedDb {
  /** Raw contents, for assertions that care what was actually persisted. */
  stores: Map<string, Map<string, unknown>>;
  /** How many times `open()` was called — db.ts promises exactly one. */
  opens: number;
  databases: FakeDatabase[];
  /** Makes the next open() fail, to test that db.ts does not cache the failure. */
  failNextOpen(error: Error): void;
  restore(): void;
}

export function installFakeIndexedDb(): FakeIndexedDb {
  const stores = new Map<string, Map<string, unknown>>();
  const databases: FakeDatabase[] = [];
  const state = { opens: 0 };
  let failure: Error | null = null;

  function open(): FakeOpenRequest {
    state.opens += 1;

    if (failure) {
      const request = new FakeRequest<FakeDatabase>();
      const error = failure;
      failure = null;
      request.error = error;
      queueMicrotask(() => request.onerror?.());
      return request as unknown as FakeOpenRequest;
    }

    const needsUpgrade = stores.size === 0;
    const database = new FakeDatabase(stores);
    databases.push(database);
    return new FakeOpenRequest(database, needsUpgrade);
  }

  const previous = (globalThis as Record<string, unknown>).indexedDB;
  Object.defineProperty(globalThis, 'indexedDB', {
    value: { open },
    configurable: true,
    writable: true,
  });

  return {
    stores,
    databases,
    get opens() {
      return state.opens;
    },
    failNextOpen(error: Error): void {
      failure = error;
    },
    restore() {
      Object.defineProperty(globalThis, 'indexedDB', {
        value: previous,
        configurable: true,
        writable: true,
      });
    },
  };
}

/** Every record in a store, as persisted. */
export function recordsIn<T>(fake: FakeIndexedDb, store: string): T[] {
  return [...(fake.stores.get(store)?.values() ?? [])] as T[];
}
