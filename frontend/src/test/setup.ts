import '@testing-library/jest-dom';

/**
 * Shared jest setup.
 *
 * Kept deliberately small. jsdom provides no service worker and no IndexedDB;
 * the fakes for those live with the suites that need them, because a fake has
 * to match the exact API surface the code under test uses, and guessing that
 * here would just be a second thing to keep in step.
 */

// app-bootstrap registers a service worker on load, and the sync scheduler
// listens on the same object for the worker asking a page to drain the queue.
// Nothing in a unit test can answer either, and an unhandled rejection — or a
// cleanup calling a method the fake does not have — would be attributed to
// whatever the test was actually doing. `SyncManager` is deliberately not faked:
// its absence is what makes `backgroundSyncSupported()` report the same thing
// here that Firefox and Safari report in production.
if (typeof globalThis.navigator !== 'undefined' && !('serviceWorker' in globalThis.navigator)) {
  Object.defineProperty(globalThis.navigator, 'serviceWorker', {
    value: {
      register: jest.fn(async () => ({})),
      ready: Promise.resolve({}),
      controller: null,
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
    },
    configurable: true,
  });
}
