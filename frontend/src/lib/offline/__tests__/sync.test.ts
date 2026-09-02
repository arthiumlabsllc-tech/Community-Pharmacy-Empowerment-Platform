import { QUEUE_STORE, resetDatabaseHandle } from '../db';
import {
  enqueue,
  getQueueItem,
  markFailed,
  markRejected,
  markSyncing,
  newLocalId,
  saveQueueItem,
  type QueueItem,
} from '../queue';
import { installFakeIndexedDb, recordsIn, type FakeIndexedDb } from './fake-indexed-db';
import * as noticesModule from '../notices';

/**
 * How the queue drains.
 *
 * The interesting behaviour is not the success path — it is the four different
 * reasons a write can fail, each of which needs a different response:
 *
 *   1. the network is absent or the server errored → retry with backoff;
 *   2. the server rejected the write → park it at once and show its reason;
 *   3. the session expired → stop the run and change nothing at all;
 *   4. a record it depends on is never coming → park it and name that record.
 *
 * Collapsing those into "retry later" is how a queue ends up empty while the
 * till still shows a sale as pending, which is the bug this layer exists to not
 * have.
 */

jest.mock('../../api', () => {
  const actual = jest.requireActual('../../api');
  return {
    __esModule: true,
    // ApiError has to stay the real class: sync.ts branches on `instanceof`,
    // and a mocked one would make every failure look like an unknown error.
    ApiError: actual.ApiError,
    isNetworkError: actual.isNetworkError,
    isOffline: actual.isOffline,
    default: {
      get: jest.fn(),
      post: jest.fn(),
      put: jest.fn(),
      delete: jest.fn(),
      fetch: jest.fn(),
    },
  };
});

import api, { ApiError } from '../../api';
import { attemptsRemaining, assertNoStrayLocalIds, isSyncRunning, syncNow } from '../sync';

const post = api.post as unknown as jest.Mock;

let fake: FakeIndexedDb;

function httpError(status: number, message: string): ApiError {
  return new ApiError({
    message,
    endpoint: '/pos/sales',
    method: 'POST',
    status,
    data: { message },
  });
}

function transportError(message = 'Could not reach the server'): ApiError {
  return new ApiError({
    message,
    endpoint: '/pos/sales',
    method: 'POST',
    networkError: true,
    offline: true,
  });
}

function setOnline(online: boolean): void {
  Object.defineProperty(window.navigator, 'onLine', { value: online, configurable: true });
}

function sale(overrides: Record<string, unknown> = {}) {
  return enqueue({
    entity: 'sale',
    endpoint: '/pos/sales',
    payload: { items: [{ inventoryId: 'inv-1', quantity: 1 }] },
    label: 'Sale · GHS 12.00 · 1 item',
    ...overrides,
  });
}

beforeEach(() => {
  fake = installFakeIndexedDb();
  resetDatabaseHandle();
  post.mockReset();
  setOnline(true);
});

afterEach(() => {
  setOnline(true);
  resetDatabaseHandle();
  fake.restore();
});

describe('when there is no connection', () => {
  it('sends nothing and spends no attempts, so the queue the cashier sees stays true', async () => {
    const item = await sale();
    setOnline(false);

    const result = await syncNow();

    expect(result.skippedOffline).toBe(true);
    expect(result.attempted).toBe(0);
    expect(result.remaining).toBe(1);
    expect(post).not.toHaveBeenCalled();
    expect(await getQueueItem(item.id)).toMatchObject({ status: 'queued', attempts: 0 });
  });
});

describe('the success path', () => {
  it('replays the write against its real endpoint, keyed by its own id', async () => {
    const item = await sale();
    post.mockResolvedValue({ success: true, data: { id: 'server-sale-1' } });

    const result = await syncNow();

    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith(
      '/pos/sales',
      { items: [{ inventoryId: 'inv-1', quantity: 1 }] },
      { clientRequestId: item.id }
    );
    expect(result).toMatchObject({ attempted: 1, synced: 1, parked: 0, retrying: 0, remaining: 0 });
    expect(await getQueueItem(item.id)).toBeUndefined();
  });

  it('does nothing when the queue is empty', async () => {
    const result = await syncNow();

    expect(result.attempted).toBe(0);
    expect(result.remaining).toBe(0);
    expect(post).not.toHaveBeenCalled();
  });

  it('reclaims a write a closed tab left in flight, then sends it', async () => {
    const item = await sale();
    await markSyncing(item.id);
    post.mockResolvedValue({ success: true, data: { id: 'server-sale-1' } });

    const result = await syncNow();

    expect(result.reclaimed).toBe(1);
    expect(result.synced).toBe(1);
    expect(post).toHaveBeenCalledTimes(1);
  });
});

describe('local id dependencies', () => {
  it('syncs a patient and then the screening recorded against it, in one run', async () => {
    const localId = newLocalId();

    const patient = await enqueue({
      entity: 'patient',
      endpoint: '/patients',
      payload: { first_name: 'Ama', last_name: 'Osei' },
      label: 'Patient · Ama Osei',
      localId,
      recordedAt: '2026-09-01T09:00:00.000Z',
    });
    const screening = await enqueue({
      entity: 'screening',
      endpoint: '/screenings',
      payload: { patient_id: localId, systolic: 128, diastolic: 82 },
      label: 'Screening · BP 128/82',
      recordedAt: '2026-09-01T09:05:00.000Z',
    });

    post.mockImplementation((endpoint: string) =>
      Promise.resolve({
        success: true,
        data: { id: endpoint === '/patients' ? 'server-patient-1' : 'server-screening-1' },
      })
    );

    const result = await syncNow();

    expect(result).toMatchObject({ attempted: 2, synced: 2, deferred: 0, remaining: 0 });
    expect(post).toHaveBeenNthCalledWith(
      1,
      '/patients',
      { first_name: 'Ama', last_name: 'Osei' },
      { clientRequestId: patient.id }
    );
    expect(post).toHaveBeenNthCalledWith(
      2,
      '/screenings',
      { patient_id: 'server-patient-1', systolic: 128, diastolic: 82 },
      { clientRequestId: screening.id }
    );
  });

  it('waits for a parent that has not synced yet, without charging the child an attempt', async () => {
    const localId = newLocalId();
    const parent = await enqueue({
      entity: 'patient',
      endpoint: '/patients',
      payload: { first_name: 'Ama' },
      label: 'Patient · Ama Osei',
      localId,
    });
    // The parent is in backoff, so it is not due: the child must not be sent
    // with a stand-in id the server would reject as an invalid UUID.
    await markFailed(parent.id, 'Could not reach the server', null);

    const child = await enqueue({
      entity: 'screening',
      endpoint: '/screenings',
      payload: { patient_id: localId },
      label: 'Screening · BP 128/82',
      recordedAt: '2026-09-01T09:05:00.000Z',
    });

    const result = await syncNow();

    expect(result).toMatchObject({ attempted: 0, deferred: 1, parked: 0, remaining: 2 });
    expect(post).not.toHaveBeenCalled();
    expect(result.failures[0]).toMatchObject({
      id: child.id,
      needsAttention: false,
      message: 'Waiting for a record it depends on to sync first',
    });
    expect(await getQueueItem(child.id)).toMatchObject({ status: 'queued', attempts: 0 });
  });

  it('parks a child whose parent could not be saved, and names the parent', async () => {
    const localId = newLocalId();
    const parent = await enqueue({
      entity: 'patient',
      endpoint: '/patients',
      payload: { first_name: 'Ama' },
      label: 'Patient · Ama Osei',
      localId,
    });
    await markRejected(parent.id, 'Phone number is already registered', 409);

    const child = await enqueue({
      entity: 'screening',
      endpoint: '/screenings',
      payload: { patient_id: localId },
      label: 'Screening · BP 128/82',
      recordedAt: '2026-09-01T09:05:00.000Z',
    });

    const result = await syncNow();

    expect(result).toMatchObject({ attempted: 0, parked: 1, remaining: 2 });
    expect(result.failures[0].needsAttention).toBe(true);
    expect(result.failures[0].message).toContain('Patient · Ama Osei');
    expect(result.failures[0].message).toContain('Phone number is already registered');
    expect(await getQueueItem(child.id)).toMatchObject({ status: 'dead' });
  });

  it('parks a child whose parent was discarded, because it can never resolve', async () => {
    const localId = newLocalId();
    const child = await enqueue({
      entity: 'screening',
      endpoint: '/screenings',
      payload: { patient_id: localId },
      label: 'Screening · BP 128/82',
    });

    const result = await syncNow();

    expect(result).toMatchObject({ attempted: 0, parked: 1 });
    expect(result.failures[0].message).toContain('discarded on this device');
    expect(await getQueueItem(child.id)).toMatchObject({ status: 'dead' });
  });
});

describe('when the server rejects the write', () => {
  it('parks it on the first attempt instead of retrying it into the ground', async () => {
    const item = await sale();
    post.mockRejectedValue(httpError(422, 'Product has no VAT classification'));

    const result = await syncNow();

    expect(post).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ attempted: 1, parked: 1, retrying: 0, remaining: 1 });
    expect(result.failures[0]).toMatchObject({
      id: item.id,
      status: 422,
      message: 'Product has no VAT classification',
      needsAttention: true,
    });
    expect(await getQueueItem(item.id)).toMatchObject({
      status: 'dead',
      attempts: 0,
      lastHttpStatus: 422,
    });
  });

  it('parks a stock conflict, which needs a person to count the shelf', async () => {
    await sale();
    post.mockRejectedValue(httpError(409, 'Insufficient stock for Paracetamol 500mg'));

    const result = await syncNow();

    expect(result.parked).toBe(1);
    expect(result.failures[0].message).toBe('Insufficient stock for Paracetamol 500mg');
  });
});

describe('when the connection fails', () => {
  it('retries with backoff and keeps the write queued', async () => {
    const item = await sale();
    post.mockRejectedValue(transportError());

    const result = await syncNow();

    expect(result).toMatchObject({ attempted: 1, retrying: 1, parked: 0, remaining: 1 });
    expect(result.failures[0].needsAttention).toBe(false);

    const queued = await getQueueItem(item.id);
    expect(queued).toMatchObject({ status: 'queued', attempts: 1 });
    expect(queued!.nextAttemptAt).not.toBeNull();
  });

  it('retries a server error, because the next attempt may land on a healthy instance', async () => {
    await sale();
    post.mockRejectedValue(httpError(503, 'Service unavailable'));

    const result = await syncNow();

    expect(result.retrying).toBe(1);
    expect(result.parked).toBe(0);
  });

  it('retries an error it does not recognise rather than assuming the write was wrong', async () => {
    const item = await sale();
    post.mockRejectedValue(new TypeError('something threw that was not an ApiError'));

    const result = await syncNow();

    expect(result).toMatchObject({ retrying: 1, parked: 0 });
    expect(await getQueueItem(item.id)).toMatchObject({ status: 'queued', attempts: 1 });
  });

  it('parks a write that runs out of attempts, and says it is still there', async () => {
    const item = await sale();

    // Spend four of the five, then clear the backoff so this run picks it up.
    // The budget is what is under test here, not the wait between attempts.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await markFailed(item.id, 'Could not reach the server', null);
    }
    const spent = await getQueueItem(item.id);
    await saveQueueItem({ ...spent!, nextAttemptAt: null });

    post.mockRejectedValue(httpError(503, 'Service unavailable'));

    const result = await syncNow();

    expect(result).toMatchObject({ attempted: 1, parked: 1, remaining: 1 });
    const dead = await getQueueItem(item.id);
    expect(dead).toMatchObject({ status: 'dead', attempts: 5 });
    expect(dead!.lastError).toContain('gave up after 5 attempts');
    expect(attemptsRemaining(dead!)).toBe(0);
  });
});

describe('when the session has expired', () => {
  it('stops the run and changes nothing, so signing back in resumes exactly where it left off', async () => {
    const first = await sale({ label: 'First sale', recordedAt: '2026-09-01T09:00:00.000Z' });
    const second = await sale({ label: 'Second sale', recordedAt: '2026-09-01T09:10:00.000Z' });
    post.mockRejectedValue(httpError(401, 'Session expired'));

    const result = await syncNow();

    expect(result).toMatchObject({ signedOut: true, attempted: 1, parked: 0, retrying: 0, remaining: 2 });
    expect(post).toHaveBeenCalledTimes(1);
    expect(result.failures).toHaveLength(0);

    // Neither write has been charged an attempt for somebody else's expired token.
    expect(await getQueueItem(first.id)).toMatchObject({ status: 'queued', attempts: 0 });
    expect(await getQueueItem(second.id)).toMatchObject({ status: 'queued', attempts: 0 });
  });
});

describe('what the pharmacy is told after a sync that succeeded with caveats', () => {
  it('says when the server recognised the write as a replay', async () => {
    await sale();
    post.mockResolvedValue({
      success: true,
      duplicate: true,
      data: { id: 'server-sale-1', receipt_number: 'RCP-00042' },
    });

    const result = await syncNow();

    expect(result.synced).toBe(1);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0].label).toBe('Sale · GHS 12.00 · 1 item · RCP-00042');
    expect(result.warnings[0].message).toContain('duplicate replay was ignored');
  });

  it('says when the till charged a different figure from the server, and which one is stored', async () => {
    await sale();
    post.mockResolvedValue({
      success: true,
      data: { id: 'server-sale-1' },
      offline: { totalMismatch: true, quotedTotal: 42.0, difference: 0.3 },
    });

    const result = await syncNow();

    expect(result.synced).toBe(1);
    expect(result.warnings[0].message).toContain('GHS 42.00');
    expect(result.warnings[0].message).toContain('GHS 0.30 less');
    expect(result.warnings[0].message).toContain('server figure');
  });

  it('says when an offline sale drove stock below zero', async () => {
    await sale();
    post.mockResolvedValue({
      success: true,
      data: { id: 'server-sale-1' },
      offline: { stockWarnings: [{ productName: 'Amoxicillin 250mg', sold: 4, available: 1 }] },
    });

    const result = await syncNow();

    expect(result.warnings[0].message).toContain('Amoxicillin 250mg');
    expect(result.warnings[0].message).toContain('sold 4 with only 1');
    expect(result.warnings[0].message).toContain('needs a count');
  });

  it('says when a mobile money payment could not be confirmed with the provider', async () => {
    await sale();
    post.mockResolvedValue({
      success: true,
      data: { id: 'server-sale-1' },
      offline: { unverifiedPayments: [{ method: 'momo', amount: 42 }] },
    });

    const result = await syncNow();

    expect(result.warnings[0].message).toContain('MOMO of GHS 42.00');
    expect(result.warnings[0].message).toContain('could not be confirmed');
    expect(result.warnings[0].message).toContain('Reconcile');
  });

  it('reports all of them when one sale has more than one thing to look at', async () => {
    await sale();
    post.mockResolvedValue({
      success: true,
      data: { id: 'server-sale-1' },
      offline: {
        totalMismatch: true,
        quotedTotal: 12.0,
        difference: -0.5,
        stockWarnings: [{ productName: 'ORS sachet', sold: 2, available: 0 }],
        unverifiedPayments: [{ method: 'card', amount: 12 }],
      },
    });

    const result = await syncNow();

    expect(result.warnings).toHaveLength(3);
    expect(result.warnings[0].message).toContain('GHS 0.50 more');
  });
});

describe('syncNow', () => {
  it('runs one sync at a time, however many things ask for one', async () => {
    await sale();

    let release: ((value: unknown) => void) | null = null;
    let sent: (() => void) | null = null;
    const inFlight = new Promise<void>((resolve) => {
      sent = resolve;
    });
    post.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
          sent!();
        })
    );

    const first = syncNow();
    const second = syncNow();

    // The guard is synchronous: the second caller is handed the run already in
    // flight rather than starting one of its own.
    expect(second).toBe(first);
    expect(isSyncRunning()).toBe(true);

    await inFlight;
    expect(post).toHaveBeenCalledTimes(1);

    release!({ success: true, data: { id: 'server-sale-1' } });
    const result = await first;

    expect(result.synced).toBe(1);
    expect(isSyncRunning()).toBe(false);
  });

  it('is free to run again once the previous run has finished', async () => {
    post.mockResolvedValue({ success: true, data: { id: 'server-sale-1' } });

    await sale();
    await syncNow();
    await sale({ label: 'Second sale' });
    const result = await syncNow();

    expect(result.synced).toBe(1);
    expect(post).toHaveBeenCalledTimes(2);
  });
});

describe('when offline storage itself fails', () => {
  it('reports the failure rather than throwing, because nobody catches a rejection from the online event', async () => {
    const item = await sale();

    // Withdraw IndexedDB mid-session, as a browser does when it evicts storage
    // under pressure. The handle has to be dropped as well, since db.ts keeps
    // one shared connection and would otherwise carry on using the old one.
    fake.restore();
    resetDatabaseHandle();

    const result = await syncNow();

    expect(result.storageError).toContain('no IndexedDB');
    expect(result.attempted).toBe(0);
    expect(result.synced).toBe(0);
    expect(post).not.toHaveBeenCalled();

    // The point of the test: losing the handle lost nothing. The write is still
    // in the store, and the next run on a working browser will find it.
    expect(recordsIn<QueueItem>(fake, QUEUE_STORE).map((queued) => queued.id)).toEqual([item.id]);
  });
});

describe('what survives the run', () => {
  it('stores a caveat, because most runs finish in the background with nobody watching', async () => {
    await sale();
    post.mockResolvedValue({
      success: true,
      data: { id: 'server-sale-1' },
      offline: { totalMismatch: true, quotedTotal: 42.0, difference: 0.3 },
    });

    const result = await syncNow();

    expect(result.warnings).toHaveLength(1);
    const stored = await noticesModule.listNotices();
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      kind: 'total_mismatch',
      label: 'Sale · GHS 12.00 · 1 item',
      dismissedAt: null,
    });
    expect(stored[0].message).toContain('GHS 42.00');
  });

  it('stores one notice per thing to look at', async () => {
    await sale();
    post.mockResolvedValue({
      success: true,
      duplicate: true,
      data: { id: 'server-sale-1' },
      offline: { stockWarnings: [{ productName: 'ORS sachet', sold: 2, available: 0 }] },
    });

    await syncNow();

    const stored = await noticesModule.listNotices();
    expect(stored.map((notice) => notice.kind).sort()).toEqual(['duplicate', 'stock_negative']);
  });

  it('stores nothing when the server had nothing to add', async () => {
    await sale();
    post.mockResolvedValue({ success: true, data: { id: 'server-sale-1' } });

    await syncNow();

    expect(await noticesModule.listNotices()).toHaveLength(0);
  });

  it('still counts the sale as synced when the notice itself could not be stored', async () => {
    // The server has committed the sale by now. Failing the item over a warning
    // we could not write down would replay a write that is already in the books.
    const spy = jest
      .spyOn(noticesModule, 'recordNotices')
      .mockRejectedValue(new Error('Storage quota exceeded'));
    const item = await sale();
    post.mockResolvedValue({
      success: true,
      data: { id: 'server-sale-1' },
      offline: { totalMismatch: true, quotedTotal: 42.0, difference: 0.3 },
    });

    const result = await syncNow();

    expect(result).toMatchObject({ synced: 1, parked: 0, retrying: 0, remaining: 0 });
    expect(result.warnings).toHaveLength(1);
    expect(await getQueueItem(item.id)).toBeUndefined();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('attemptsRemaining', () => {
  it('counts down to zero and never below', async () => {
    const item = await sale();

    expect(attemptsRemaining(item)).toBe(5);
    expect(attemptsRemaining({ ...item, attempts: 3 })).toBe(2);
    expect(attemptsRemaining({ ...item, attempts: 9 })).toBe(0);
  });
});

describe('assertNoStrayLocalIds', () => {
  it('lets a clean payload through', () => {
    expect(() => assertNoStrayLocalIds({ patient_id: 'real-id', items: [] })).not.toThrow();
  });

  it('refuses to queue a stand-in id nothing will ever create', () => {
    expect(() => assertNoStrayLocalIds({ patient_id: 'local:abc' })).toThrow(
      /Queued without a record to resolve local:abc/
    );
    expect(() => assertNoStrayLocalIds({ items: [{ patient_id: 'local:abc' }] })).toThrow();
  });
});
