/**
 * IndexedDB for the offline till.
 *
 * IndexedDB rather than localStorage because of size, not sophistication: a
 * pharmacy's cached product catalogue with prices, batches and expiry dates is
 * easily a few hundred rows, and localStorage's ~5MB is shared with everything
 * else the origin stores. Losing the catalogue means the till cannot sell
 * offline at all, which is the one thing this whole layer exists to prevent.
 *
 * The wrapper is deliberately thin and promise-based. It covers put / get /
 * getAll / delete / clear and nothing else — no cursors, no indexes, no
 * multi-store transactions. That is all the queue and the cache need, and
 * keeping the surface this small is what makes it testable against an
 * in-memory fake.
 */

export const DB_NAME = 'pharmacy-offline';
/**
 * Bumped to 2 for the notices store. The upgrade handler below creates whatever
 * is missing, so an existing device upgrades in place and keeps its queue.
 */
export const DB_VERSION = 2;

/** Queued writes waiting for a connection. */
export const QUEUE_STORE = 'queue';
/** local:<uuid> -> the server id it turned out to be. */
export const IDENTITIES_STORE = 'identities';
/** Products cached for offline selling, keyed by inventory id. */
export const CATALOGUE_STORE = 'catalogue';
/** Small named settings blobs (tax, pharmacy profile), keyed by name. */
export const SETTINGS_STORE = 'settings';
/**
 * Writes a person threw away on the review screen, kept after the fact.
 *
 * Discarding is the only way anything leaves the queue, and in a pharmacy the
 * owner has to be able to see that a cashier dropped a sale or a patient rather
 * than only noticing that the day's takings do not match the drawer.
 */
export const DISCARD_STORE = 'discarded';
/**
 * Things a sync succeeded at but the pharmacy still has to act on: a till total
 * that disagreed with the server, stock driven negative, a mobile money payment
 * the provider could not confirm.
 *
 * Persisted rather than kept in the banner, because most runs happen in the
 * background while nobody is looking, and a mismatch discovered only in the
 * memory of a component that has since unmounted is a mismatch nobody ever hears
 * about.
 */
export const NOTICES_STORE = 'notices';

export const STORES = [
  QUEUE_STORE,
  IDENTITIES_STORE,
  CATALOGUE_STORE,
  SETTINGS_STORE,
  DISCARD_STORE,
  NOTICES_STORE,
] as const;

export type StoreName = (typeof STORES)[number];

/** True when the browser can offer IndexedDB at all. Private browsing on some
 *  engines throws on open rather than on access. */
export function isIndexedDbAvailable(): boolean {
  return typeof indexedDB !== 'undefined';
}

let openPromise: Promise<IDBDatabase> | null = null;

/**
 * Opens (once) and upgrades the database. The single shared connection matters:
 * opening a second one while an upgrade is pending deadlocks the browser.
 */
export function openDatabase(): Promise<IDBDatabase> {
  if (openPromise) return openPromise;

  openPromise = new Promise<IDBDatabase>((resolve, reject) => {
    if (!isIndexedDbAvailable()) {
      reject(new Error('This browser has no IndexedDB, so nothing can be stored offline'));
      return;
    }

    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const database = request.result;
      for (const name of STORES) {
        // Out-of-line keys everywhere: every caller passes the key explicitly,
        // which keeps records free to change shape without a migration.
        if (!database.objectStoreNames.contains(name)) {
          database.createObjectStore(name);
        }
      }
    };

    request.onsuccess = () => {
      const database = request.result;
      // A version change from another tab blocks every subsequent write until
      // this connection closes, so close it rather than hang the till.
      database.onversionchange = () => database.close();
      resolve(database);
    };

    request.onerror = () => reject(request.error ?? new Error('Could not open offline storage'));
    request.onblocked = () =>
      reject(new Error('Offline storage is in use by another tab. Close it and reload.'));
  });

  // A failed open must not be cached forever, or one transient error would
  // disable offline selling for the rest of the session.
  openPromise.catch(() => {
    openPromise = null;
  });

  return openPromise;
}

function toPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Offline storage request failed'));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () =>
      reject(transaction.error ?? new Error('Offline storage transaction aborted'));
    transaction.onerror = () =>
      reject(transaction.error ?? new Error('Offline storage transaction failed'));
  });
}

export async function putRecord<T>(store: StoreName, key: string, value: T): Promise<void> {
  const database = await openDatabase();
  const transaction = database.transaction(store, 'readwrite');
  transaction.objectStore(store).put(value, key);
  await transactionDone(transaction);
}

export async function getRecord<T>(store: StoreName, key: string): Promise<T | undefined> {
  const database = await openDatabase();
  const transaction = database.transaction(store, 'readonly');
  return toPromise(transaction.objectStore(store).get(key) as IDBRequest<T | undefined>);
}

export async function getAllRecords<T>(store: StoreName): Promise<T[]> {
  const database = await openDatabase();
  const transaction = database.transaction(store, 'readonly');
  return toPromise(transaction.objectStore(store).getAll() as IDBRequest<T[]>);
}

export async function getAllKeys(store: StoreName): Promise<string[]> {
  const database = await openDatabase();
  const transaction = database.transaction(store, 'readonly');
  return toPromise(transaction.objectStore(store).getAllKeys() as IDBRequest<string[]>).then(
    (keys) => keys.map(String)
  );
}

export async function deleteRecord(store: StoreName, key: string): Promise<void> {
  const database = await openDatabase();
  const transaction = database.transaction(store, 'readwrite');
  transaction.objectStore(store).delete(key);
  await transactionDone(transaction);
}

export async function clearStore(store: StoreName): Promise<void> {
  const database = await openDatabase();
  const transaction = database.transaction(store, 'readwrite');
  transaction.objectStore(store).clear();
  await transactionDone(transaction);
}

/**
 * Writes many records in one transaction.
 *
 * Used to refresh the cached catalogue: a pharmacy with 800 products must not
 * open 800 transactions, and a partial write would leave the till able to sell
 * some of the stock and not the rest.
 */
export async function putMany<T>(store: StoreName, entries: Array<[string, T]>): Promise<void> {
  if (entries.length === 0) return;

  const database = await openDatabase();
  const transaction = database.transaction(store, 'readwrite');
  const objectStore = transaction.objectStore(store);
  for (const [key, value] of entries) objectStore.put(value, key);
  await transactionDone(transaction);
}

/** Drops keys that are no longer in `keep`. Used to prune delisted products. */
export async function pruneTo(store: StoreName, keep: string[]): Promise<number> {
  const existing = await getAllKeys(store);
  const keepSet = new Set(keep);
  const stale = existing.filter((key) => !keepSet.has(key));
  if (stale.length === 0) return 0;

  const database = await openDatabase();
  const transaction = database.transaction(store, 'readwrite');
  const objectStore = transaction.objectStore(store);
  for (const key of stale) objectStore.delete(key);
  await transactionDone(transaction);

  return stale.length;
}

/** Test seam: forgets the shared connection so a suite can start clean. */
export function resetDatabaseHandle(): void {
  openPromise = null;
}
