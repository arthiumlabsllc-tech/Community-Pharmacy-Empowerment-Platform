'use client';

import { useEffect, useState } from 'react';
import { WifiOff, Wifi, RefreshCw } from 'lucide-react';

/**
 * Fallback page served by the service worker when a navigation fails offline.
 *
 * The copy is deliberately literal about what works: previously-visited pages
 * are served from the worker cache, but nothing can be saved to the server
 * until connectivity returns. Offline write queueing is not wired up yet, so
 * the page does not claim that unsaved changes are being held for you.
 */
export default function OfflinePage() {
  const [online, setOnline] = useState(true);

  useEffect(() => {
    setOnline(navigator.onLine);
    const goOnline = () => setOnline(true);
    const goOffline = () => setOnline(false);

    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
    };
  }, []);

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 p-6">
      <div className="text-center max-w-md">
        <div
          className={`w-16 h-16 rounded-2xl mx-auto mb-6 flex items-center justify-center ${
            online ? 'bg-green-100 text-green-600' : 'bg-amber-100 text-amber-600'
          }`}
        >
          {online ? <Wifi className="w-8 h-8" /> : <WifiOff className="w-8 h-8" />}
        </div>

        <h1 className="text-2xl font-bold text-gray-900 mb-3">
          {online ? 'Connection restored' : 'You\u2019re offline'}
        </h1>

        <p className="text-gray-500 mb-6">
          {online
            ? 'Your connection is back. Reload to pick up where you left off.'
            : 'Pages you have already visited stay available, but nothing can be saved to the server until your connection returns.'}
        </p>

        <div className="space-y-4">
          <button onClick={() => window.location.reload()} className="btn-primary btn-lg w-full">
            <RefreshCw className="w-4 h-4" />
            {online ? 'Reload the app' : 'Try again'}
          </button>
          <p className="text-xs text-gray-400">
            {online
              ? 'Any form you were filling in will need to be completed again.'
              : 'Finish any sale or record you were working on once you are back online — entries are not stored on this device yet.'}
          </p>
        </div>
      </div>
    </div>
  );
}
