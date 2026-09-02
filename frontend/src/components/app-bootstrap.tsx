'use client';

import { useEffect } from 'react';
import { applyFontSize, readFontSize } from '@/lib/appearance';

/**
 * App-wide one-time side effects that have to run in the browser:
 *  - applying the saved accessibility font size
 *  - registering the offline service worker
 */
export function AppBootstrap() {
  useEffect(() => {
    applyFontSize(readFontSize());
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
