/**
 * The scheduler's triggers.
 *
 * Only the service worker's request is covered here. It is the one trigger whose
 * answer is read outside the page, and getting it wrong is asymmetric: a page
 * that stays silent when it cannot drain costs a retry, while a page that
 * acknowledges a drain it will not perform makes the browser drop the
 * registration and leaves the queue waiting for somebody to open the app.
 */

jest.mock('../queue', () => ({
  queueCounts: jest.fn(async () => ({ queued: 0, syncing: 0, dead: 0, total: 0 })),
  wakeQueue: jest.fn(async () => 0),
}));

jest.mock('../sync', () => ({
  isSyncRunning: jest.fn(() => false),
  syncNow: jest.fn(async () => ({
    startedAt: '',
    finishedAt: '',
    attempted: 0,
    synced: 0,
    deferred: 0,
    retrying: 0,
    parked: 0,
    skippedOffline: false,
    signedOut: false,
    reclaimed: 0,
    failures: [],
    warnings: [],
    remaining: 0,
    storageError: null,
  })),
}));

jest.mock('../background-sync', () => ({
  requestBackgroundSync: jest.fn(async () => true),
}));

import { queueCounts } from '../queue';
import { isSyncRunning, syncNow } from '../sync';
import { requestBackgroundSync } from '../background-sync';
import { startSyncScheduler, stopSyncScheduler } from '../scheduler';

const counts = queueCounts as unknown as jest.Mock;
const running = isSyncRunning as unknown as jest.Mock;
const drain = syncNow as unknown as jest.Mock;
const register = requestBackgroundSync as unknown as jest.Mock;

type WorkerHandler = (event: { data: unknown; ports: Array<{ postMessage: jest.Mock }> }) => void;

let handlers: WorkerHandler[] = [];

/** Stands in for navigator.serviceWorker, capturing the listener the scheduler adds. */
function installBus(): void {
  handlers = [];

  Object.defineProperty(navigator, 'serviceWorker', {
    value: {
      ready: Promise.resolve({}),
      controller: null,
      register: jest.fn(),
      addEventListener: (type: string, handler: WorkerHandler) => {
        if (type === 'message') handlers.push(handler);
      },
      removeEventListener: (type: string, handler: WorkerHandler) => {
        if (type === 'message') handlers = handlers.filter((entry) => entry !== handler);
      },
    },
    configurable: true,
  });
}

/** The worker asking every listening page to drain the queue. */
function workerAsks(): { postMessage: jest.Mock } {
  const port = { postMessage: jest.fn() };
  for (const handler of [...handlers]) {
    handler({ data: { type: 'RUN_SYNC' }, ports: [port] });
  }
  return port;
}

describe('the worker asking this page to drain the queue', () => {
  beforeEach(() => {
    installBus();
    counts.mockResolvedValue({ queued: 0, syncing: 0, dead: 0, total: 0 });
    running.mockReturnValue(false);
    startSyncScheduler({ canSync: () => true });
  });

  afterEach(() => {
    stopSyncScheduler();
  });

  it('accepts the work and starts a run', () => {
    const port = workerAsks();

    expect(port.postMessage).toHaveBeenCalledWith({ type: 'SYNC_ACCEPTED' });
    expect(drain).toHaveBeenCalledTimes(1);
  });

  it('says nothing when there is no session, so the browser keeps trying', () => {
    stopSyncScheduler();
    startSyncScheduler({ canSync: () => false });

    const port = workerAsks();

    // A signed-out page cannot drain anything, and acknowledging would tell the
    // worker the sync happened. The worker would resolve the event, the browser
    // would drop the tag, and the queue would sit there until somebody signed in
    // and opened the app — which is the failure Background Sync was added to
    // prevent.
    expect(port.postMessage).not.toHaveBeenCalled();
    expect(drain).not.toHaveBeenCalled();
  });

  it('accepts without starting a second run while one is in flight', () => {
    running.mockReturnValue(true);

    const port = workerAsks();

    // The work is being done, just not by a run this call started. The guard
    // against two concurrent runs lives in the tab rather than in storage, so
    // starting another here would race the first for the same rows.
    expect(port.postMessage).toHaveBeenCalledWith({ type: 'SYNC_ACCEPTED' });
    expect(drain).not.toHaveBeenCalled();
  });

  it('ignores any other message the worker sends', () => {
    const port = { postMessage: jest.fn() };
    for (const handler of [...handlers]) {
      handler({ data: { type: 'SOMETHING_ELSE' }, ports: [port] });
    }

    expect(port.postMessage).not.toHaveBeenCalled();
    expect(drain).not.toHaveBeenCalled();
  });

  it('stops listening when the scheduler stops', () => {
    stopSyncScheduler();

    const port = workerAsks();

    expect(handlers).toHaveLength(0);
    expect(port.postMessage).not.toHaveBeenCalled();
  });
});

describe('asking the browser to retry after this page is gone', () => {
  beforeEach(() => {
    installBus();
    running.mockReturnValue(false);
  });

  afterEach(() => {
    stopSyncScheduler();
  });

  it('registers the tag when the scheduler starts with work still queued', async () => {
    counts.mockResolvedValue({ queued: 2, syncing: 0, dead: 0, total: 2 });

    startSyncScheduler({ canSync: () => true });
    // The read is async; the registration follows it rather than blocking start.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(register).toHaveBeenCalled();
  });

  it('does not register on an empty queue, so the browser fires nothing pointless', async () => {
    counts.mockResolvedValue({ queued: 0, syncing: 0, dead: 0, total: 0 });

    startSyncScheduler({ canSync: () => true });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(register).not.toHaveBeenCalled();
  });

  it('carries on when the queue cannot be read at all', async () => {
    // IndexedDB evicted under storage pressure, or refused in private browsing.
    // The triggers still have to be running, because a broken read is reported by
    // the run itself rather than by giving up on syncing.
    counts.mockRejectedValue(new Error('Offline storage is unavailable on this device'));

    startSyncScheduler({ canSync: () => true });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(register).not.toHaveBeenCalled();
    expect(handlers).toHaveLength(1);
  });
});
