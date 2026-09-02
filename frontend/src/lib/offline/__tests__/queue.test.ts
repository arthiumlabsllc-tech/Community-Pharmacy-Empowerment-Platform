import { DISCARD_STORE, QUEUE_STORE, resetDatabaseHandle } from '../db';
import {
  MAX_ATTEMPTS,
  backoffFor,
  deferItem,
  discardItem,
  dueItems,
  enqueue,
  getQueueItem,
  isLocalId,
  listDiscarded,
  listQueue,
  markFailed,
  markRejected,
  markSyncing,
  newLocalId,
  queueCounts,
  reclaimStaleSyncing,
  rememberIdentity,
  removeQueueItem,
  resolveIdentity,
  resolveLocalIds,
  retryItem,
  saveQueueItem,
  subscribeToQueue,
  wakeQueue,
  type DiscardedItem,
  type NewQueueItem,
  type QueueItem,
} from '../queue';
import { installFakeIndexedDb, recordsIn, type FakeIndexedDb } from './fake-indexed-db';

/**
 * The queue's contract, which is one sentence long: nothing disappears except by
 * syncing or by a person choosing to throw it away and saying why.
 *
 * These tests are written against that sentence rather than against the
 * implementation, because the failure they exist to prevent — a paid sale
 * silently deleted after three retries — is invisible in the happy path and only
 * shows up in the drawer at the end of the day.
 */

let fake: FakeIndexedDb;
const unsubscribes: Array<() => void> = [];

function sale(overrides: Partial<NewQueueItem> = {}): NewQueueItem {
  return {
    entity: 'sale',
    endpoint: '/pos/sales',
    payload: { items: [{ inventoryId: 'inv-1', quantity: 2 }] },
    label: 'Sale · GHS 42.00 · 2 items',
    ...overrides,
  };
}

beforeEach(() => {
  fake = installFakeIndexedDb();
  resetDatabaseHandle();
});

afterEach(() => {
  while (unsubscribes.length) unsubscribes.pop()?.();
  resetDatabaseHandle();
  fake.restore();
});

describe('enqueue', () => {
  it('stores the write ready to go, with no attempts spent', async () => {
    const item = await enqueue(sale());

    expect(item.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(item.status).toBe('queued');
    expect(item.attempts).toBe(0);
    expect(item.nextAttemptAt).toBeNull();
    expect(item.method).toBe('POST');
    expect(await getQueueItem(item.id)).toMatchObject({ id: item.id, status: 'queued' });
  });

  it('uses an id the caller supplies, so the till can reuse it as client_sale_id', async () => {
    const item = await enqueue(sale({ id: 'till-generated-id' }));

    expect(item.id).toBe('till-generated-id');
  });

  it('keeps the moment it happened separate from the moment it was queued', async () => {
    const recordedAt = '2026-09-01T17:04:00.000Z';
    const item = await enqueue(sale({ recordedAt }));

    // A sale rung up at five in the evening and synced the next morning has to
    // land on the right trading day, which is what recordedAt is for.
    expect(item.recordedAt).toBe(recordedAt);
    expect(item.createdAt).not.toBe(recordedAt);
  });

  it('gives every item a distinct id, so the server cannot mistake one for a replay of another', async () => {
    const first = await enqueue(sale());
    const second = await enqueue(sale());

    expect(first.id).not.toBe(second.id);
  });
});

describe('listQueue', () => {
  it('puts waiting work first and the dead pile last', async () => {
    const dead = await enqueue(sale({ label: 'Rejected sale' }));
    await markRejected(dead.id, 'Product is not classified', 422);

    const queued = await enqueue(sale({ label: 'Waiting sale' }));

    const items = await listQueue();
    expect(items.map((item) => item.label)).toEqual(['Waiting sale', 'Rejected sale']);
    expect(queued.status).toBe('queued');
  });

  it('orders by when the thing happened, not by when it was queued', async () => {
    await enqueue(sale({ label: 'Later', recordedAt: '2026-09-01T18:00:00.000Z' }));
    await enqueue(sale({ label: 'Earlier', recordedAt: '2026-09-01T09:00:00.000Z' }));

    const items = await listQueue();
    expect(items.map((item) => item.label)).toEqual(['Earlier', 'Later']);
  });

  it('reports the counts the review screen shows', async () => {
    await enqueue(sale());
    const dead = await enqueue(sale());
    await markRejected(dead.id, 'Nope', 400);
    const syncing = await enqueue(sale());
    await markSyncing(syncing.id);

    expect(await queueCounts()).toEqual({ queued: 1, syncing: 1, dead: 1, total: 3 });
  });
});

describe('the rule that nothing is dropped', () => {
  it('retries a transport failure with a growing backoff and keeps the item', async () => {
    const item = await enqueue(sale());

    const first = await markFailed(item.id, 'Could not reach the server', null);
    expect(first).toMatchObject({ status: 'queued', attempts: 1 });
    expect(first!.nextAttemptAt).not.toBeNull();

    const second = await markFailed(item.id, 'Could not reach the server', null);
    expect(second).toMatchObject({ status: 'queued', attempts: 2 });
    expect(Date.parse(second!.nextAttemptAt!)).toBeGreaterThan(Date.parse(first!.nextAttemptAt!));

    expect(await listQueue()).toHaveLength(1);
  });

  it('still holds the item once the budget is spent, and says so in words a cashier can act on', async () => {
    const item = await enqueue(sale());

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      await markFailed(item.id, 'Could not reach the server', 503);
    }

    const dead = await getQueueItem(item.id);
    expect(dead).toBeDefined();
    expect(dead!.status).toBe('dead');
    expect(dead!.attempts).toBe(MAX_ATTEMPTS);
    expect(dead!.nextAttemptAt).toBeNull();
    expect(dead!.lastError).toContain('gave up after 5 attempts');
    expect(dead!.lastError).toContain('still here');

    // The point of the whole file: it is still in the store.
    expect(await listQueue()).toHaveLength(1);
    expect((await queueCounts()).dead).toBe(1);
  });

  it('parks a rejection the server will not change its mind about, on the first attempt', async () => {
    const item = await enqueue(sale());

    const parked = await markRejected(item.id, 'Product has no VAT classification', 422);

    expect(parked).toMatchObject({
      status: 'dead',
      attempts: 0,
      lastHttpStatus: 422,
      lastError: 'Product has no VAT classification',
    });
    expect(await listQueue()).toHaveLength(1);
  });

  it('does not spend an attempt when the item is merely waiting', async () => {
    const item = await enqueue(sale());

    await deferItem(item.id, 'Waiting for the patient to sync first', 60_000);

    const deferred = await getQueueItem(item.id);
    expect(deferred).toMatchObject({ status: 'queued', attempts: 0 });
    expect(deferred!.lastError).toBe('Waiting for the patient to sync first');
  });

  it('returns nothing for an id that was never queued, rather than inventing a record', async () => {
    expect(await markFailed('nope', 'x', null)).toBeUndefined();
    expect(await markRejected('nope', 'x', null)).toBeUndefined();
    expect(await retryItem('nope')).toBeUndefined();
    expect(await discardItem('nope', 'gone')).toBeNull();
  });
});

describe('dueItems', () => {
  it('skips an item whose backoff has not elapsed', async () => {
    const item = await enqueue(sale());
    await markFailed(item.id, 'Could not reach the server', null);

    expect(await dueItems()).toHaveLength(0);

    const afterBackoff = new Date(Date.now() + backoffFor(1) + 5_000);
    expect(await dueItems(afterBackoff)).toHaveLength(1);
  });

  it('skips items in flight, which belong to a run that has not finished', async () => {
    const item = await enqueue(sale());
    await markSyncing(item.id);

    expect(await dueItems()).toHaveLength(0);
  });

  it('skips the dead pile, which needs a person rather than a network', async () => {
    const item = await enqueue(sale());
    await markRejected(item.id, 'Rejected', 400);

    expect(await dueItems()).toHaveLength(0);
  });
});

describe('reclaimStaleSyncing', () => {
  it('frees an item a closed tab left in flight, without charging it an attempt', async () => {
    const item = await enqueue(sale());
    await markSyncing(item.id);
    expect(await dueItems()).toHaveLength(0);

    expect(await reclaimStaleSyncing()).toBe(1);

    const reclaimed = await getQueueItem(item.id);
    expect(reclaimed).toMatchObject({ status: 'queued', attempts: 0, nextAttemptAt: null });
    expect(await dueItems()).toHaveLength(1);
  });

  it('leaves everything else alone', async () => {
    await enqueue(sale());
    expect(await reclaimStaleSyncing()).toBe(0);
  });
});

describe('wakeQueue', () => {
  it('clears backoff timers when the connection returns, but not the dead pile', async () => {
    const waiting = await enqueue(sale({ label: 'Waiting' }));
    await markFailed(waiting.id, 'Could not reach the server', null);

    const dead = await enqueue(sale({ label: 'Dead' }));
    await markRejected(dead.id, 'Rejected', 400);

    expect(await wakeQueue()).toBe(1);
    expect(await dueItems()).toHaveLength(1);
    expect((await getQueueItem(dead.id))!.status).toBe('dead');
  });
});

describe('retryItem', () => {
  it('gives a dead item a fresh budget and forgets the old error', async () => {
    const item = await enqueue(sale());
    await markRejected(item.id, 'Product has no VAT classification', 422);

    const retried = await retryItem(item.id);

    expect(retried).toMatchObject({
      status: 'queued',
      attempts: 0,
      nextAttemptAt: null,
      lastError: null,
      lastHttpStatus: null,
    });
    expect(await dueItems()).toHaveLength(1);
  });
});

describe('discardItem', () => {
  it('is the only deletion path, and it leaves an accountable record behind', async () => {
    const item = await enqueue(sale({ label: 'Sale · GHS 12.00' }));
    await markFailed(item.id, 'Could not reach the server', 503);

    const discarded = await discardItem(item.id, 'Customer walked out without the goods');

    expect(discarded).toMatchObject({
      id: item.id,
      entity: 'sale',
      label: 'Sale · GHS 12.00',
      attempts: 1,
      lastHttpStatus: 503,
      discardReason: 'Customer walked out without the goods',
    });
    expect(discarded!.discardedAt).toBeTruthy();
    expect(discarded!.payload).toEqual({ items: [{ inventoryId: 'inv-1', quantity: 2 }] });

    expect(await listQueue()).toHaveLength(0);
    expect(await getQueueItem(item.id)).toBeUndefined();

    const stored = recordsIn<DiscardedItem>(fake, DISCARD_STORE);
    expect(stored).toHaveLength(1);
    expect(stored[0].discardReason).toBe('Customer walked out without the goods');
  });

  it('will not let a discard go unexplained', async () => {
    const item = await enqueue(sale());

    const discarded = await discardItem(item.id, '   ');

    expect(discarded!.discardReason).toBe('No reason given');
  });

  it('keeps the discarded list newest first', async () => {
    const first = await enqueue(sale({ label: 'First' }));
    await discardItem(first.id, 'Duplicate entry');
    const second = await enqueue(sale({ label: 'Second' }));
    await discardItem(second.id, 'Duplicate entry');

    const discarded = await listDiscarded();
    expect(discarded).toHaveLength(2);
    expect(discarded[0].discardedAt >= discarded[1].discardedAt).toBe(true);
  });
});

describe('removeQueueItem', () => {
  it('takes a synced write out of the store and leaves no discard record', async () => {
    const item = await enqueue(sale());

    await removeQueueItem(item.id);

    expect(await listQueue()).toHaveLength(0);
    expect(recordsIn(fake, DISCARD_STORE)).toHaveLength(0);
  });
});

describe('local id resolution', () => {
  it('recognises a stand-in id and nothing else', () => {
    const localId = newLocalId();
    expect(isLocalId(localId)).toBe(true);
    expect(isLocalId('3f2b8c1e-0000-4000-8000-000000000000')).toBe(false);
    expect(isLocalId(null)).toBe(false);
    expect(isLocalId(42)).toBe(false);
  });

  it('rewrites a stand-in id everywhere it appears in the payload', async () => {
    const localId = newLocalId();
    await rememberIdentity(localId, 'real-patient-id');

    const { payload, unresolved } = await resolveLocalIds({
      patient_id: localId,
      readings: [{ taken_by: localId, systolic: 128 }],
      notes: 'Routine check',
      vitals: { recorded_against: localId },
    });

    expect(unresolved).toEqual([]);
    expect(payload).toEqual({
      patient_id: 'real-patient-id',
      readings: [{ taken_by: 'real-patient-id', systolic: 128 }],
      notes: 'Routine check',
      vitals: { recorded_against: 'real-patient-id' },
    });
  });

  it('reports an unresolved id rather than sending it to the server', async () => {
    const localId = newLocalId();

    const { payload, unresolved } = await resolveLocalIds({ patient_id: localId });

    expect(unresolved).toEqual([localId]);
    expect((payload as { patient_id: string }).patient_id).toBe(localId);
  });

  it('reports each unresolved id once even when it appears several times', async () => {
    const localId = newLocalId();

    const { unresolved } = await resolveLocalIds({ a: localId, b: [localId, localId] });

    expect(unresolved).toEqual([localId]);
  });

  it('leaves values that are not plain objects alone', async () => {
    const when = new Date('2026-09-01T10:00:00.000Z');
    const { payload } = await resolveLocalIds({ at: when, count: 3, ok: true, nothing: null });

    expect(payload).toEqual({ at: when, count: 3, ok: true, nothing: null });
  });

  it('refuses to remember a mapping for something that was never a stand-in', async () => {
    await rememberIdentity('not-a-local-id', 'whatever');
    expect(await resolveIdentity('not-a-local-id')).toBeUndefined();
  });
});

describe('backoffFor', () => {
  it('grows from half a minute and stops at ten', () => {
    expect(backoffFor(1)).toBe(30_000);
    expect(backoffFor(2)).toBe(60_000);
    expect(backoffFor(3)).toBe(120_000);
    expect(backoffFor(9)).toBe(600_000);
    expect(backoffFor(50)).toBe(600_000);
  });

  it('does not go backwards or negative for a nonsense attempt count', () => {
    expect(backoffFor(0)).toBe(30_000);
    expect(backoffFor(-5)).toBe(30_000);
  });
});

describe('subscribeToQueue', () => {
  it('tells the UI whenever the queue moves', async () => {
    const heard: number[] = [];
    unsubscribes.push(subscribeToQueue(() => heard.push(Date.now())));

    const item = await enqueue(sale());
    await markSyncing(item.id);
    await markFailed(item.id, 'Could not reach the server', null);
    await removeQueueItem(item.id);

    expect(heard).toHaveLength(4);
  });

  it('stops telling a subscriber that has unsubscribed', async () => {
    let heard = 0;
    const unsubscribe = subscribeToQueue(() => {
      heard += 1;
    });

    await enqueue(sale());
    unsubscribe();
    await enqueue(sale());

    expect(heard).toBe(1);
  });

  it('survives a subscriber that throws', async () => {
    unsubscribes.push(
      subscribeToQueue(() => {
        throw new Error('broken component');
      })
    );
    let healthy = 0;
    unsubscribes.push(subscribeToQueue(() => {
      healthy += 1;
    }));

    await enqueue(sale());

    expect(healthy).toBe(1);
  });
});

describe('saveQueueItem', () => {
  it('persists exactly what it is given', async () => {
    const item = await enqueue(sale());
    const edited: QueueItem = { ...item, label: 'Corrected label' };

    await saveQueueItem(edited);

    expect((await getQueueItem(item.id))!.label).toBe('Corrected label');
    expect(recordsIn<QueueItem>(fake, QUEUE_STORE)).toHaveLength(1);
  });
});
