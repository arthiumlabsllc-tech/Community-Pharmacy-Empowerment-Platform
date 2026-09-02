import {
  CATALOGUE_STORE,
  DB_NAME,
  IDENTITIES_STORE,
  QUEUE_STORE,
  SETTINGS_STORE,
  STORES,
  clearStore,
  deleteRecord,
  getAllKeys,
  getAllRecords,
  getRecord,
  isIndexedDbAvailable,
  openDatabase,
  pruneTo,
  putMany,
  putRecord,
  resetDatabaseHandle,
  type StoreName,
} from '../db';
import { installFakeIndexedDb, type FakeIndexedDb } from './fake-indexed-db';

/**
 * The storage seam under the whole offline layer.
 *
 * Three properties here are load-bearing rather than incidental: one shared
 * connection (opening a second during an upgrade deadlocks the browser), a
 * failed open that is not cached (otherwise one transient error disables offline
 * selling for the rest of the shift), and records that are cloned on the way in
 * (otherwise a caller mutating an object after storing it would silently rewrite
 * history).
 */

let fake: FakeIndexedDb;

beforeEach(() => {
  fake = installFakeIndexedDb();
  resetDatabaseHandle();
});

afterEach(() => {
  resetDatabaseHandle();
  fake.restore();
});

describe('openDatabase', () => {
  it('creates every store the offline layer needs on first open', async () => {
    await openDatabase();

    expect([...fake.stores.keys()].sort()).toEqual([...STORES].sort());
    expect(STORES).toEqual([
      QUEUE_STORE,
      IDENTITIES_STORE,
      CATALOGUE_STORE,
      SETTINGS_STORE,
      'discarded',
      'notices',
    ]);
  });

  it('opens once and shares the connection, however many callers ask', async () => {
    const [first, second, third] = await Promise.all([openDatabase(), openDatabase(), openDatabase()]);

    expect(fake.opens).toBe(1);
    expect(second).toBe(first);
    expect(third).toBe(first);
  });

  it('does not remember a failed open, so the next attempt can still work', async () => {
    fake.failNextOpen(new Error('Storage quota exceeded'));

    await expect(openDatabase()).rejects.toThrow('Storage quota exceeded');
    expect(fake.opens).toBe(1);

    // Had the failure been cached, offline selling would be dead for the rest of
    // the session on the strength of one bad moment.
    await expect(openDatabase()).resolves.toBeDefined();
    expect(fake.opens).toBe(2);
  });

  it('closes the connection when another tab upgrades the database', async () => {
    const database = await openDatabase();

    database.onversionchange?.({} as never);

    // A version change from another tab blocks every later write until this
    // connection closes, so db.ts closes it rather than let the till hang.
    expect(fake.databases[0].closed).toBe(true);
  });

  it('says plainly when the browser has no IndexedDB at all', async () => {
    fake.restore();
    resetDatabaseHandle();

    expect(isIndexedDbAvailable()).toBe(false);
    await expect(openDatabase()).rejects.toThrow('no IndexedDB');
  });

  it('refuses to read from a store that does not exist rather than returning nothing', async () => {
    await expect(getRecord('nope' as StoreName, 'key')).rejects.toThrow(/No object store named "nope"/);
  });
});

describe('put and get', () => {
  it('round-trips a record', async () => {
    await putRecord(QUEUE_STORE, 'item-1', { label: 'Sale · GHS 12.00', attempts: 0 });

    expect(await getRecord(QUEUE_STORE, 'item-1')).toEqual({ label: 'Sale · GHS 12.00', attempts: 0 });
  });

  it('returns undefined for a key that was never written, not null and not a throw', async () => {
    await openDatabase();
    expect(await getRecord(QUEUE_STORE, 'missing')).toBeUndefined();
  });

  it('stores a copy, so mutating the caller\'s object afterwards cannot rewrite the record', async () => {
    const record = { label: 'as stored' };
    await putRecord(QUEUE_STORE, 'item-1', record);

    record.label = 'mutated after the write';

    expect(await getRecord(QUEUE_STORE, 'item-1')).toEqual({ label: 'as stored' });
  });

  it('hands back a copy, so a caller cannot edit the store by holding the result', async () => {
    await putRecord(QUEUE_STORE, 'item-1', { label: 'as stored' });

    const read = (await getRecord<{ label: string }>(QUEUE_STORE, 'item-1'))!;
    read.label = 'edited in memory';

    expect(await getRecord(QUEUE_STORE, 'item-1')).toEqual({ label: 'as stored' });
  });

  it('overwrites on the same key rather than appending', async () => {
    await putRecord(QUEUE_STORE, 'item-1', { attempts: 1 });
    await putRecord(QUEUE_STORE, 'item-1', { attempts: 2 });

    expect(await getAllRecords(QUEUE_STORE)).toEqual([{ attempts: 2 }]);
  });

  it('keeps stores separate', async () => {
    await putRecord(QUEUE_STORE, 'shared-key', { from: 'queue' });
    await putRecord(SETTINGS_STORE, 'shared-key', { from: 'settings' });

    expect(await getRecord(QUEUE_STORE, 'shared-key')).toEqual({ from: 'queue' });
    expect(await getRecord(SETTINGS_STORE, 'shared-key')).toEqual({ from: 'settings' });
  });
});

describe('getAllRecords and getAllKeys', () => {
  it('lists everything in a store', async () => {
    await putRecord(CATALOGUE_STORE, 'a', { name: 'A' });
    await putRecord(CATALOGUE_STORE, 'b', { name: 'B' });

    expect(await getAllRecords(CATALOGUE_STORE)).toHaveLength(2);
    expect((await getAllKeys(CATALOGUE_STORE)).sort()).toEqual(['a', 'b']);
  });

  it('returns empty rather than failing on a store nothing has been written to', async () => {
    await openDatabase();

    expect(await getAllRecords(IDENTITIES_STORE)).toEqual([]);
    expect(await getAllKeys(IDENTITIES_STORE)).toEqual([]);
  });

  it('returns keys as strings even if a number was used', async () => {
    await putRecord(SETTINGS_STORE, '750000', { threshold: true });

    expect(await getAllKeys(SETTINGS_STORE)).toEqual(['750000']);
  });
});

describe('deleteRecord and clearStore', () => {
  it('removes one record and leaves the rest', async () => {
    await putRecord(QUEUE_STORE, 'a', { n: 1 });
    await putRecord(QUEUE_STORE, 'b', { n: 2 });

    await deleteRecord(QUEUE_STORE, 'a');

    expect(await getAllKeys(QUEUE_STORE)).toEqual(['b']);
  });

  it('does not fail when asked to remove a key that is not there', async () => {
    await openDatabase();
    await expect(deleteRecord(QUEUE_STORE, 'missing')).resolves.toBeUndefined();
  });

  it('empties one store without touching another', async () => {
    await putRecord(QUEUE_STORE, 'a', { n: 1 });
    await putRecord(CATALOGUE_STORE, 'a', { n: 1 });

    await clearStore(QUEUE_STORE);

    expect(await getAllRecords(QUEUE_STORE)).toEqual([]);
    expect(await getAllRecords(CATALOGUE_STORE)).toHaveLength(1);
  });
});

describe('putMany', () => {
  it('writes a whole catalogue in one transaction', async () => {
    await putMany(CATALOGUE_STORE, [
      ['a', { name: 'A' }],
      ['b', { name: 'B' }],
      ['c', { name: 'C' }],
    ]);

    expect(await getAllRecords(CATALOGUE_STORE)).toHaveLength(3);
    // One transaction, not three: the shared connection was opened once.
    expect(fake.opens).toBe(1);
  });

  it('does nothing when given an empty list, rather than opening a transaction for it', async () => {
    await putMany(CATALOGUE_STORE, []);

    expect(fake.opens).toBe(0);
  });
});

describe('pruneTo', () => {
  it('drops the keys that are not in the new catalogue and reports how many', async () => {
    await putMany(CATALOGUE_STORE, [
      ['a', { name: 'A' }],
      ['b', { name: 'B' }],
      ['c', { name: 'C' }],
    ]);

    expect(await pruneTo(CATALOGUE_STORE, ['a', 'c'])).toBe(1);
    expect((await getAllKeys(CATALOGUE_STORE)).sort()).toEqual(['a', 'c']);
  });

  it('leaves everything alone when nothing is stale', async () => {
    await putRecord(CATALOGUE_STORE, 'a', { name: 'A' });

    expect(await pruneTo(CATALOGUE_STORE, ['a', 'b'])).toBe(0);
    expect(await getAllKeys(CATALOGUE_STORE)).toEqual(['a']);
  });

  it('empties the store when told to keep nothing', async () => {
    await putRecord(CATALOGUE_STORE, 'a', { name: 'A' });

    expect(await pruneTo(CATALOGUE_STORE, [])).toBe(1);
    expect(await getAllRecords(CATALOGUE_STORE)).toEqual([]);
  });
});

describe('the database name', () => {
  it('is its own database, not shared with anything else on the origin', () => {
    expect(DB_NAME).toBe('pharmacy-offline');
  });
});
