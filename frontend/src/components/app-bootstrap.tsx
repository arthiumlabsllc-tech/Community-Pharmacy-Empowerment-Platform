'use client';

import { useEffect } from 'react';
import { applyFontSize, readFontSize } from '@/lib/appearance';
import { startSyncScheduler } from '@/lib/offline/scheduler';
import { useAuthStore } from '@/store/auth-store';

/**
 * App-wide one-time side effects that have to run in the browser:
 *  - applying the saved accessibility font size
 *  - registering the offline service worker
 *  - starting the offline sync triggers
 *
 * This is the only place that starts the scheduler. `useSyncStatus` deliberately
 * does not, because it is mounted in a banner that comes and goes with
 * navigation and must not take the triggers down with it.
 */
export function AppBootstrap() {
  useEffect(() => {
    applyFontSize(readFontSize());
  }, []);

  useEffect(() => {
    // A run cannot succeed without a session, and attempting one every minute
    // would spend the queue's whole retry budget rediscovering the same 401.
    const stop = startSyncScheduler({
      canSync: () => Boolean(useAuthStore.getState().accessToken),
    });
    return stop;
  }, []);

  useEffect(() => {
    // Registering in development makes Next's hot-reloaded assets serve stale
    // from the cache, so the worker is production-only.
    if (process.env.NODE_ENV !== 'production') return;
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;

    const register = () => {
      navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {
        // Offline support is a progressive enhancement — never block the app on it.
      });
    };

    // Defer until after first paint so the worker never competes with hydration.
    if (document.readyState === 'complete') {
      const timer = setTimeout(register, 1500);
      return () => clearTimeout(timer);
    }

    const onLoad = () => setTimeout(register, 1500);
    window.addEventListener('load', onLoad);
    return () => window.removeEventListener('load', onLoad);
  }, []);

  return null;
}
