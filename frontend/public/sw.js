/**
 * The service worker.
 *
 * Served from /public/sw.js and registered by app-bootstrap.tsx in production
 * only, so it works on Cloudflare Pages with no build plugin in the way.
 *
 * It does two jobs, and it is worth being clear about what neither of them is:
 *
 *  - Caching, so a page that was opened once while online can be opened again
 *    without one. Navigation responses and the assets they pull are cached as
 *    they are fetched rather than precached from a build manifest, because there
 *    is no manifest here. The consequence is real and deliberate: a route that
 *    has never been visited on this device will not load offline, and falls back
 *    to /offline. Precaching /pos without its hashed JS chunks would be worse —
 *    it would render a blank till instead of an honest "you are offline" page.
 *
 *  - Handing a Background Sync event to a page that can drain the offline queue.
 *    It cannot drain it itself; see handOffToAPage below.
 *
 * Business data never passes through this worker. The offline queue lives in
 * IndexedDB and is written by src/lib/offline/*, which does not depend on a
 * service worker being registered at all.
 */

const CACHE_NAME = 'pharmacy-platform-v1';
const OFFLINE_URL = '/offline';

// Assets to pre-cache on install
const PRECACHE_URLS = [
  '/',
  '/offline',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

// Install — pre-cache essential assets
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      // One URL at a time rather than cache.addAll, which is all-or-nothing: a
      // single route that 404s rejects the batch and precaches nothing, and the
      // .catch that used to swallow it turned that into a silent blank slate.
      Promise.all(
        PRECACHE_URLS.map((url) =>
          cache.add(url).catch(() => {
            // Not worth failing the install over. The fetch handler below still
            // goes to the network first for navigations, so a missing entry only
            // costs the offline fallback for that one route.
          })
        )
      )
    )
  );
  self.skipWaiting();
});

// Activate — clean up old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames
          .filter((name) => name !== CACHE_NAME)
          .map((name) => caches.delete(name))
      );
    })
  );
  self.clients.claim();
});

// Fetch — network-first with cache fallback
self.addEventListener('fetch', (event) => {
  // Skip non-GET requests (API calls, form submissions)
  if (event.request.method !== 'GET') return;

  // Skip cross-origin requests
  if (!event.request.url.startsWith(self.location.origin)) return;

  // For navigation requests (page loads): network-first
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          // Cached only when it is a page worth showing again. A 500 stored here
          // would be served instead of the offline fallback, and a redirected
          // response — a signed-out till bounced to /login, say — is not this URL
          // at all, and cache.put rejects it rather than storing it.
          if (response.ok && !response.redirected) {
            const responseClone = response.clone();
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(event.request, responseClone);
            });
          }
          return response;
        })
        .catch(() => {
          // Offline — serve from cache, fallback to offline page
          return caches.match(event.request).then((cached) => {
            return cached || caches.match(OFFLINE_URL);
          });
        })
    );
    return;
  }

  // For static assets: cache-first with network fallback
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;

      return fetch(event.request)
        .then((response) => {
          // Cache successful responses
          if (response.ok) {
            const responseClone = response.clone();
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(event.request, responseClone);
            });
          }
          return response;
        })
        .catch(() => {
          // Return empty response for failed asset requests
          return new Response('Offline', { status: 503 });
        });
    })
  );
});

// ---------------------------------------------------------------------------
// Background Sync
// ---------------------------------------------------------------------------

/** Must match SYNC_TAG in src/lib/offline/background-sync.ts. */
const SYNC_TAG = 'sync-queue';

/**
 * How long a page gets to say it took the work before this worker asks the next
 * one. Long enough to survive a background tab waking from being frozen, short
 * enough not to exhaust the browser's patience with the sync event itself.
 */
const CLIENT_ANSWER_MS = 8000;

self.addEventListener('sync', (event) => {
  if (event.tag !== SYNC_TAG) return;
  event.waitUntil(handOffToAPage());
});

/**
 * Asks an open page to drain the offline queue, and fails if none of them does.
 *
 * This worker cannot drain the queue itself. A sync run has to send the session
 * token, and a service worker has no access to a page's storage — so the work
 * belongs to a page and the worker's job is to find one.
 *
 * Failing matters more than it looks. Resolving the event tells the browser the
 * sync succeeded; it drops the tag and never fires it again, and a queue of sales
 * a cashier already took money for would then wait until somebody happened to
 * open the app. Rejecting keeps the registration alive and the browser retries on
 * its own escalating backoff, which is what a queue that must not be lost wants.
 */
async function handOffToAPage() {
  const clients = await self.clients.matchAll({
    type: 'window',
    includeUncontrolled: true,
  });

  // One at a time. Two tabs draining the same queue would race for the same
  // rows, and the guard against that lives in each tab rather than in storage.
  for (const client of clients) {
    if (await askClient(client)) return;
  }

  throw new Error(
    clients.length === 0
      ? 'No page was open to sync the offline queue'
      : 'No open page could take the offline queue'
  );
}

/**
 * Posts the request and waits for the page to accept it.
 *
 * A MessageChannel rather than a bare postMessage because the answer has to be
 * tied to this request and not to some later one: the page replies on the port it
 * is handed, so a slow reply to an earlier ask cannot be mistaken for a fast
 * reply to this one.
 */
function askClient(client) {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    let settled = false;
    let timer = null;

    const finish = (accepted) => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      channel.port1.close();
      resolve(Boolean(accepted));
    };

    channel.port1.onmessage = (event) => {
      finish(event.data && event.data.type === 'SYNC_ACCEPTED');
    };

    timer = setTimeout(() => finish(false), CLIENT_ANSWER_MS);

    // A page that is signed out stays silent on purpose, and silence is what
    // makes this worker fail — see onWorkerMessage in src/lib/offline/scheduler.ts.
    client.postMessage({ type: 'RUN_SYNC' }, [channel.port2]);
  });
}
