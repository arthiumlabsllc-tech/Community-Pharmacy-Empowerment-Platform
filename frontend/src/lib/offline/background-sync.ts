/**
 * The browser's own retry, as distinct from the app's.
 *
 * `scheduler.ts` drains the queue while a page is open: on the `online` event,
 * on an interval, and when a backgrounded tab is brought back. What none of
 * those cover is a tablet that was locked with sales still queued — the page is
 * gone, so there is no listener left to fire, and the queue waits until somebody
 * happens to open the app again.
 *
 * The Background Sync API exists for exactly that gap. Registering a tag asks the
 * browser to fire the service worker when connectivity returns, on the browser's
 * own schedule and with its own backoff, whether or not the app is open.
 *
 * Two things follow from how it actually works, and both shape this module:
 *
 *  1. It is Chromium-only. Firefox does not implement it and Safari does not
 *     expose it, so registration has to be a bonus and never the plan. Where it
 *     is missing the queue simply waits for the scheduler, which is what it did
 *     before this file existed. Nothing here may be load-bearing.
 *
 *  2. A service worker cannot read the page's storage, so it cannot get the
 *     session token a sync run needs. The worker therefore does not drain the
 *     queue; it hands the request to a page that can. That handoff, and the rule
 *     that a page which cannot sync must not pretend otherwise, live in
 *     `scheduler.ts` beside the triggers they resemble.
 *
 * This module deliberately imports nothing from the offline layer. `queue.ts`
 * calls it at the moment work appears, and a cycle back through the scheduler
 * would make that call order-dependent.
 */

/** The tag the service worker listens for. Must match `public/sw.js`. */
export const SYNC_TAG = 'sync-queue';

/**
 * Whether this browser can hand the queue to the worker at all.
 *
 * Checks the interface rather than the registration: `navigator.serviceWorker`
 * exists wherever a worker could be registered, but `SyncManager` only exists
 * where `registration.sync` will be there to ask.
 */
export function backgroundSyncSupported(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    typeof globalThis !== 'undefined' &&
    'SyncManager' in globalThis &&
    'serviceWorker' in navigator &&
    Boolean(navigator.serviceWorker)
  );
}

/**
 * Asks the browser to fire the worker when a connection returns.
 *
 * Returns whether the request was accepted, so a caller can tell "registered"
 * from "this browser will never do this" without inspecting anything. Registering
 * a tag that is already registered is a no-op, so this is safe to call every time
 * something is queued rather than only on the transition from empty.
 *
 * Never throws. A worker that has not finished registering, or a browser that
 * refuses, must not turn a missing enhancement into a broken queue — the sale has
 * already been written to storage by the time this is called, and an exception
 * here would surface as a failed sale that in fact succeeded.
 */
export async function requestBackgroundSync(): Promise<boolean> {
  if (!backgroundSyncSupported()) return false;

  try {
    const registration = await navigator.serviceWorker.ready;
    // Typed as unknown because `sync` is not in the ServiceWorkerRegistration
    // lib types: it is a Chromium extension, and the whole point is that it may
    // not be there.
    const sync = (registration as unknown as { sync?: { register?: (tag: string) => Promise<void> } })
      .sync;

    if (!sync || typeof sync.register !== 'function') return false;

    await sync.register(SYNC_TAG);
    return true;
  } catch {
    return false;
  }
}
