import { resetDatabaseHandle } from '../db';
import {
  countOpenNotices,
  dismissAllNotices,
  dismissNotice,
  listNotices,
  recordNotices,
  type NewNotice,
} from '../notices';
import { installFakeIndexedDb, type FakeIndexedDb } from './fake-indexed-db';

/**
 * The things a sync succeeded at but nobody should shrug off.
 *
 * The property worth testing hardest is the last one: bounding the store must
 * never drop a notice that is still open, because that is how a stock
 * discrepancy turns into a mystery at the end of the month.
 */

let fake: FakeIndexedDb;

function batch(count: number, tag: string): NewNotice[] {
  return Array.from({ length: count }, (_, index) => ({
    kind: 'stock_negative' as const,
    sourceId: `queue-${tag}-${index}`,
    label: `Sale ${tag} ${index}`,
    message: `${tag} ${index} needs a stock count`,
  }));
}

beforeEach(() => {
  fake = installFakeIndexedDb();
  resetDatabaseHandle();
});

afterEach(() => {
  resetDatabaseHandle();
  fake.restore();
});

describe('recordNotices', () => {
  it('stores each one open, with the queue item it came from', async () => {
    const created = await recordNotices([
      {
        kind: 'total_mismatch',
        sourceId: 'queue-item-1',
        label: 'Sale · GHS 42.00',
        message: 'The till charged GHS 42.00 but the server says GHS 41.70.',
      },
    ]);

    expect(created).toHaveLength(1);
    expect(created[0].id).toBeTruthy();
    expect(created[0].dismissedAt).toBeNull();
    expect(created[0].raisedAt).toBeTruthy();

    const stored = await listNotices();
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ kind: 'total_mismatch', sourceId: 'queue-item-1' });
  });

  it('does nothing when there is nothing to say', async () => {
    expect(await recordNotices([])).toEqual([]);
    expect(await listNotices({ includeDismissed: true })).toEqual([]);
  });

  it('gives each notice its own id, so dismissing one cannot clear another', async () => {
    const created = await recordNotices(batch(3, 'a'));

    expect(new Set(created.map((notice) => notice.id)).size).toBe(3);
  });
});

describe('listNotices', () => {
  it('hides dismissed ones by default and shows them when asked', async () => {
    const created = await recordNotices(batch(2, 'a'));
    await dismissNotice(created[0].id);

    expect(await listNotices()).toHaveLength(1);
    expect(await listNotices({ includeDismissed: true })).toHaveLength(2);
  });

  it('is empty on a device that has never had anything to report', async () => {
    expect(await listNotices()).toEqual([]);
  });
});

describe('dismissNotice', () => {
  it('marks the notice as seen rather than deleting it, so the audit trail survives', async () => {
    const [created] = await recordNotices(batch(1, 'a'));

    const dismissed = await dismissNotice(created.id);

    expect(dismissed!.dismissedAt).toBeTruthy();
    expect(await countOpenNotices()).toBe(0);

    const all = await listNotices({ includeDismissed: true });
    expect(all).toHaveLength(1);
    expect(all[0].message).toContain('needs a stock count');
  });

  it('says nothing happened for an id that is not there', async () => {
    expect(await dismissNotice('nope')).toBeUndefined();
  });

  it('clears every open notice at once when the owner has been through the list', async () => {
    await recordNotices(batch(4, 'a'));

    expect(await dismissAllNotices()).toBe(4);
    expect(await countOpenNotices()).toBe(0);
    expect(await listNotices({ includeDismissed: true })).toHaveLength(4);
  });
});

describe('bounding the store', () => {
  it('drops old dismissed notices to make room, but never an open one', async () => {
    await recordNotices(batch(190, 'old'));
    await dismissAllNotices();
    await recordNotices(batch(30, 'new'));

    const all = await listNotices({ includeDismissed: true });
    const open = await listNotices();

    expect(open).toHaveLength(30);
    expect(all.filter((notice) => !notice.dismissedAt)).toHaveLength(30);
    // Capped, and everything dropped to get there was already dismissed.
    expect(all.length).toBe(200);
  });

  it('leaves the store alone while it is under the cap', async () => {
    await recordNotices(batch(10, 'a'));
    await dismissAllNotices();

    expect(await listNotices({ includeDismissed: true })).toHaveLength(10);
  });
});
