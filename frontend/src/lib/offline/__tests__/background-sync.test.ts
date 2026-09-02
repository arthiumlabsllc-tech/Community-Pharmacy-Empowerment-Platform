/**
 * Background Sync: the registration on this side, and the worker on the other.
 *
 * The interesting failures are not the happy path. They are the browsers that
 * cannot do this at all, and the two ways the handoff can lie: a page saying it
 * took work it cannot do, and a worker telling the browser a sync succeeded when
 * no page ever answered. The second is the worse one, because the browser then
 * drops the tag for good and a queue of paid-for sales waits until somebody
 * happens to open the app.
 *
 * `public/sw.js` is loaded into a sandbox rather than asserted against as text.
 * Two files in two languages with nothing tying them together at runtime is
 * exactly the situation where a string match passes and the feature is broken.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { runInNewContext } from 'vm';
// jsdom does not expose MessageChannel and jest shadows the Node global with its
// own, so the worker's is taken from worker_threads. It is the same web-standard
// implementation: port1.onmessage starts the port, and a message posted to port2
// arrives on it.
import { MessageChannel } from 'worker_threads';
import { SYNC_TAG, backgroundSyncSupported, requestBackgroundSync } from '../background-sync';

const WORKER_PATH = join(__dirname, '..', '..', '..', '..', 'public', 'sw.js');

function readSource(path: string): string {
  return readFileSync(path, 'utf8');
}

/** Replaces the fake from src/test/setup.ts, which has no `sync` on it. */
function installServiceWorker(registration: unknown): () => void {
  const original = Object.getOwnPropertyDescriptor(navigator, 'serviceWorker');

  Object.defineProperty(navigator, 'serviceWorker', {
    value: {
      ready: Promise.resolve(registration),
      controller: null,
      register: jest.fn(),
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
    },
    configurable: true,
  });

  return () => {
    if (original) Object.defineProperty(navigator, 'serviceWorker', original);
  };
}

/**
 * jsdom has no SyncManager, which is the same thing Firefox and Safari report in
 * production — so the default environment is already the unsupported case, and
 * support is what has to be faked.
 */
function installSyncManager(): () => void {
  (globalThis as Record<string, unknown>).SyncManager = class {};
  return () => {
    delete (globalThis as Record<string, unknown>).SyncManager;
  };
}

describe('backgroundSyncSupported', () => {
  it('is false in a browser with no SyncManager, which is Firefox and Safari', () => {
    expect(backgroundSyncSupported()).toBe(false);
  });

  it('is true once the interface is there', () => {
    const restore = installSyncManager();

    expect(backgroundSyncSupported()).toBe(true);

    restore();
  });
});

describe('requestBackgroundSync', () => {
  it('asks for nothing in a browser that cannot do it', async () => {
    const register = jest.fn(async () => undefined);
    const restore = installServiceWorker({ sync: { register } });

    await expect(requestBackgroundSync()).resolves.toBe(false);
    expect(register).not.toHaveBeenCalled();

    restore();
  });

  it('registers the tag', async () => {
    const register = jest.fn(async () => undefined);
    const restoreWorker = installServiceWorker({ sync: { register } });
    const restoreManager = installSyncManager();

    await expect(requestBackgroundSync()).resolves.toBe(true);
    expect(register).toHaveBeenCalledWith(SYNC_TAG);

    restoreManager();
    restoreWorker();
  });

  it('reports false rather than throwing when the registration has no sync', async () => {
    const restoreWorker = installServiceWorker({});
    const restoreManager = installSyncManager();

    await expect(requestBackgroundSync()).resolves.toBe(false);

    restoreManager();
    restoreWorker();
  });

  it('reports false rather than throwing when the browser refuses', async () => {
    // A caller has already stored the record by the time this runs, so an
    // exception here surfaces as a failed write that in fact succeeded.
    const register = jest.fn(async () => {
      throw new Error('The browser refused the registration');
    });
    const restoreWorker = installServiceWorker({ sync: { register } });
    const restoreManager = installSyncManager();

    await expect(requestBackgroundSync()).resolves.toBe(false);

    restoreManager();
    restoreWorker();
  });
});

// ---------------------------------------------------------------------------
// The worker
// ---------------------------------------------------------------------------

/** A page the worker can ask. Replies on the port it is handed, or stays silent. */
interface FakeClient {
  asked: Array<{ type: string }>;
  /** Set to answer the request; left unset to model a frozen or signed-out tab. */
  replies: boolean;
  postMessage: (data: unknown, ports?: unknown[]) => void;
}

/**
 * Every port the worker handed to a fake page.
 *
 * Closed after each test. These are worker_threads MessagePorts, and one left
 * open holds a libuv handle that keeps the jest worker process alive after the
 * suite has finished — which jest reports by force-exiting it, and which shows
 * up as a failure in whatever ran next rather than as the leak it is.
 */
const handedPorts: Array<{ close: () => void }> = [];

afterEach(() => {
  for (const port of handedPorts.splice(0)) port.close();
});

function makeClient(replies: boolean): FakeClient {
  const client: FakeClient = {
    asked: [],
    replies,
    postMessage: (data: unknown, ports?: unknown[]) => {
      client.asked.push(data as { type: string });
      // Typed as the two things this test does with a port — answer on it, and
      // close it afterwards — rather than as a DOM MessagePort: jsdom's is not
      // the implementation imported above.
      const port = (ports ?? [])[0] as
        | { postMessage: (value: unknown) => void; close: () => void }
        | undefined;
      if (port) handedPorts.push(port);
      if (replies && port) {
        // On a later tick, the way a real page does it: the handler that answers
        // is a listener on the other side of a message event.
        setTimeout(() => port.postMessage({ type: 'SYNC_ACCEPTED' }), 0);
      }
    },
  };
  return client;
}

interface LoadedWorker {
  clients: FakeClient[];
  /** Resolves or rejects the way the browser's sync event would. */
  fireSync: (tag: string) => Promise<void>;
  /** Fires the answer deadline the worker sets for an unresponsive page. */
  expireDeadlines: () => void;
  /** How many of those deadlines the worker has set and not yet fired. */
  pendingDeadlines: () => number;
  syncTag: string | null;
}

/**
 * Runs the real sw.js against the minimum worker surface it touches.
 *
 * Timers are captured rather than waited on, because the worker's patience for a
 * page is eight seconds and a test that slept through it would be slower than the
 * whole rest of the suite for no extra confidence.
 */
function loadWorker(): LoadedWorker {
  const listeners = new Map<string, Array<(event: any) => void>>();
  const deadlines: Array<() => void> = [];
  const clients: FakeClient[] = [];

  const sandbox = {
    self: {
      addEventListener: (type: string, handler: (event: any) => void) => {
        listeners.set(type, [...(listeners.get(type) ?? []), handler]);
      },
      clients: { matchAll: async () => clients },
      skipWaiting: () => undefined,
      location: { origin: 'https://pharmacy.test' },
    },
    MessageChannel,
    setTimeout: (callback: () => void) => {
      deadlines.push(callback);
      return deadlines.length;
    },
    clearTimeout: () => undefined,
  };

  const source = readSource(WORKER_PATH);
  runInNewContext(source, sandbox, { filename: 'sw.js' });

  // Read back out of the source rather than hardcoded, so the assertion below is
  // about the tag this worker really listens for.
  const declared = /const SYNC_TAG = '([^']+)'/.exec(source);

  return {
    clients,
    syncTag: declared ? declared[1] : null,
    fireSync: (tag: string) => {
      let waited: Promise<void> = Promise.resolve();
      for (const handler of listeners.get('sync') ?? []) {
        handler({
          tag,
          waitUntil: (promise: Promise<void>) => {
            waited = promise;
          },
        });
      }
      return waited;
    },
    expireDeadlines: () => {
      for (const deadline of deadlines.splice(0)) deadline();
    },
    pendingDeadlines: () => deadlines.length,
  };
}

/**
 * Yields until something the worker does asynchronously has actually happened.
 *
 * A fixed number of ticks is not enough here. The page's reply crosses a real
 * worker_threads MessagePort, and port delivery is libuv work rather than a
 * macrotask — on a loaded runner it can take longer than any tick count that is
 * still quick. Waiting on the condition keeps the wait as short as it can be and
 * as long as it has to be.
 */
async function waitFor(condition: () => boolean, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for the worker');
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

/**
 * Starts an assertion on a sync event before the worker can settle it.
 *
 * Both return a promise the test awaits later. What matters is that the handler
 * is attached during the call: awaiting the event first and asserting afterwards
 * leaves a window in which a rejection belongs to nobody, Node reports it as
 * unhandled, and jest attributes that to the test instead of to the timing.
 */
function expectSettles(event: Promise<void>): Promise<void> {
  return expect(event).resolves.toBeUndefined();
}

function expectFails(event: Promise<void>, message: RegExp): Promise<void> {
  return expect(event).rejects.toThrow(message);
}

describe('the worker sync event', () => {
  it('listens for the tag this app registers', () => {
    expect(loadWorker().syncTag).toBe(SYNC_TAG);
  });

  it('succeeds when a page says it took the work', async () => {
    const worker = loadWorker();
    worker.clients.push(makeClient(true));

    const event = worker.fireSync(SYNC_TAG);

    // Awaited directly. The assertion is attached before the worker can settle
    // the event, so what it returns is the thing to wait on — and it waits
    // exactly as long as the page's reply takes to cross the port, no longer.
    await expectSettles(event);

    // The page was asked, and the browser is told the sync happened — so it
    // drops the tag instead of firing it again at a queue that is already being
    // drained.
    expect(worker.clients[0].asked).toEqual([{ type: 'RUN_SYNC' }]);
  });

  it('fails when no page answers, so the browser keeps the tag and retries', async () => {
    const worker = loadWorker();
    worker.clients.push(makeClient(false));

    const event = worker.fireSync(SYNC_TAG);
    const assertion = expectFails(event, /No open page could take the offline queue/);
    // The tab's deadline is what tells the worker nobody is coming. It is
    // captured rather than really waited on, so it has to be fired by hand — and
    // only once the worker has actually set it.
    await waitFor(() => worker.pendingDeadlines() === 1);
    worker.expireDeadlines();

    await assertion;
  });

  it('fails when there is no page at all', async () => {
    const worker = loadWorker();

    const event = worker.fireSync(SYNC_TAG);

    // No clients means no deadline to fire by hand: the worker gives up as soon
    // as matchAll comes back empty.
    await expectFails(event, /No page was open to sync the offline queue/);
  });

  it('moves on to the next tab when the first is frozen', async () => {
    const worker = loadWorker();
    const frozen = makeClient(false);
    const usable = makeClient(true);
    worker.clients.push(frozen, usable);

    const event = worker.fireSync(SYNC_TAG);
    const assertion = expectSettles(event);
    // The first tab's deadline is what releases the worker to ask the second.
    await waitFor(() => worker.pendingDeadlines() === 1);
    worker.expireDeadlines();

    await assertion;
    expect(frozen.asked).toEqual([{ type: 'RUN_SYNC' }]);
    expect(usable.asked).toEqual([{ type: 'RUN_SYNC' }]);
  });

  it('ignores a tag it does not own', async () => {
    const worker = loadWorker();
    worker.clients.push(makeClient(true));

    await expectSettles(worker.fireSync('some-other-tag'));
    expect(worker.clients[0].asked).toEqual([]);
  });
});
