import { queueCounts, wakeQueue } from './queue';
import { isSyncRunning, syncNow, type SyncRunResult } from './sync';
import { requestBackgroundSync } from './background-sync';

/**
 * When a sync run happens.
 *
 * `syncNow` is the drain; this module is the set of reasons to call it. They are
 * kept apart because the drain has to stay callable from a service worker and
 * from a test, neither of which has a window to listen to.
 *
 * Three triggers, and each exists because the others miss something:
 *   - `online` fires the moment the interface comes back, which is when a
 *     cashier expects the queue to move;
 *   - the interval catches the case where `online` never fired at all — a
 *     captive portal, a router that came back, or a tab that was opened while
 *     the browser already considered itself online but the server was down;
 *   - `visibilitychange` catches a till that was backgrounded overnight and
 *     brought back in the morning, when the interval may have been throttled to
 *     nothing by the browser while the tab was hidden.
 *
 * A fourth trigger comes from outside the page: the service worker, when the
 * browser fires a Background Sync registration. It is handled here rather than in
 * `background-sync.ts` because it is the same kind of thing — a reason to run —
 * and because it needs the session check the other triggers share.
 */

const DEFAULT_INTERVAL_MS = 60_000;

export interface SchedulerOptions {
  /** Milliseconds between opportunistic runs while online. Defaults to 60s. */
  intervalMs?: number;
  /**
   * Whether a run could possibly succeed. The app passes the session check;
   * without it a signed-out till would fire a doomed request every minute and
   * the run would spend its whole budget discovering the same 401.
   */
  canSync?: () => boolean;
}

type RunListener = (result: SyncRunResult) => void;

const runListeners = new Set<RunListener>();

/**
 * Hears the outcome of every run this module starts.
 *
 * The queue already announces its own changes, but a run can finish with nothing
 * to show for it — everything parked, or a storage failure — and the banner has
 * to be able to say so rather than fall back to "syncing…".
 */
export function subscribeToSyncRuns(listener: RunListener): () => void {
  runListeners.add(listener);
  return () => {
    runListeners.delete(listener);
  };
}

function announce(result: SyncRunResult): void {
  for (const listener of [...runListeners]) {
    try {
      listener(result);
    } catch {
      // A broken banner must not stop the queue from draining.
    }
  }
}

/**
 * Runs a sync and tells whoever is listening how it went. This is the entry
 * point for a manual "Sync now" button as well as for the triggers below, so
 * that every run is reported the same way.
 */
export async function runSync(): Promise<SyncRunResult> {
  const result = await syncNow();
  announce(result);
  return result;
}

let stop: (() => void) | null = null;

export function isSchedulerRunning(): boolean {
  return stop !== null;
}

/**
 * Starts the triggers. Calling it twice is harmless and returns the same stop
 * function, because more than one place in the app has a reason to want syncing
 * to be happening and none of them can tell whether another already started it.
 */
export function startSyncScheduler(options: SchedulerOptions = {}): () => void {
  if (typeof window === 'undefined') return () => {};
  if (stop) return stop;

  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const canSync = options.canSync ?? (() => true);

  const connected = (): boolean => navigator.onLine !== false;

  const attempt = async (): Promise<void> => {
    if (!canSync() || !connected() || isSyncRunning()) return;
    await runSync();
  };

  const onOnline = async (): Promise<void> => {
    if (!canSync()) return;
    try {
      // Every backoff timer was set to avoid hammering a server that was
      // failing. That situation is over, so the queue should go now rather
      // than wait out a delay nobody still needs.
      await wakeQueue();
    } catch {
      // Storage unavailable: the run below will report it.
    }
    await attempt();
  };

  const onVisibility = (): void => {
    if (document.visibilityState === 'visible') void attempt();
  };

  /**
   * The worker asking a page to drain the queue.
   *
   * The worker cannot do it itself: a sync run needs the session token, and a
   * service worker has no access to the page's storage. So it asks, and waits for
   * an answer.
   *
   * Answering is the whole point. The worker fails the sync event unless a page
   * says it took the work, and a failure is what makes the browser try again
   * later on its own backoff. A page that cannot sync must therefore stay silent
   * rather than acknowledge a drain it will not perform — a signed-out tab that
   * said "accepted" would cause the browser to drop the tag and leave the queue
   * sitting there until somebody happened to open the app.
   */
  const onWorkerMessage = (event: MessageEvent): void => {
    if (!event.data || event.data.type !== 'RUN_SYNC') return;
    if (!canSync()) return;

    const port = event.ports && event.ports[0];
    // Acknowledged before the run rather than after. A drain can take minutes on
    // a queue that has been sitting overnight, and the worker's patience is
    // shorter than that: answering late would look like no answer, so the browser
    // would retry and start the same work a second time.
    port?.postMessage({ type: 'SYNC_ACCEPTED' });

    // A run already in flight is this work being done. Starting another would
    // race it for the same rows, because the guard against that is per tab.
    if (!isSyncRunning()) void runSync();
  };

  const workerBus = navigator.serviceWorker;
  const canTalkToWorker =
    Boolean(workerBus) &&
    typeof workerBus.addEventListener === 'function' &&
    typeof workerBus.removeEventListener === 'function';

  if (canTalkToWorker) workerBus.addEventListener('message', onWorkerMessage);

  // Asked once at start rather than only when something is queued: an app opened
  // with a stale queue and closed again five minutes later is precisely the case
  // Background Sync exists for, and by then nothing is left running to ask.
  queueCounts()
    .then((counts) => {
      if (counts.queued > 0) void requestBackgroundSync();
    })
    .catch(() => {
      /* reported by the interval below, which reads the same store */
    });

  const timer = window.setInterval(() => {
    if (!canSync() || !connected()) return;

    // Reading the queue first means an idle till does no work at all. It also
    // keeps a storage failure out of the sync path: it is reported here instead,
    // where it can be seen, rather than looking like a run that synced nothing.
    queueCounts()
      .then((counts) => {
        if (counts.queued > 0) void attempt();
      })
      .catch(() => {
        /* announced the next time a run is attempted */
      });
  }, intervalMs);

  window.addEventListener('online', onOnline);
  document.addEventListener('visibilitychange', onVisibility);

  stop = () => {
    window.clearInterval(timer);
    window.removeEventListener('online', onOnline);
    document.removeEventListener('visibilitychange', onVisibility);
    if (canTalkToWorker) workerBus.removeEventListener('message', onWorkerMessage);
    stop = null;
  };

  return stop;
}

/** Stops the triggers. Does not cancel a run already in flight. */
export function stopSyncScheduler(): void {
  stop?.();
}
