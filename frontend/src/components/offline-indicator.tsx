'use client';

import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import { WifiOff } from 'lucide-react';

export function OfflineIndicator() {
  const [isOffline, setIsOffline] = useState(false);
  const pathname = usePathname();

  useEffect(() => {
    const handleOffline = () => setIsOffline(true);
    const handleOnline = () => setIsOffline(false);

    setIsOffline(!navigator.onLine);

    window.addEventListener('offline', handleOffline);
    window.addEventListener('online', handleOnline);

    return () => {
      window.removeEventListener('offline', handleOffline);
      window.removeEventListener('online', handleOnline);
    };
  }, []);

  if (!isOffline) return null;

  // The till is a fixed-height flex column and renders its own offline state,
  // because there it means "you cannot ring up a sale at all" rather than
  // "your changes will sync later". A second banner here would only push the
  // grid down and cause the page to scroll.
  if (pathname === '/pos') return null;

  return (
    <div className="offline-banner no-print flex items-center justify-center gap-2">
      <WifiOff className="w-4 h-4" />
      <span>You are offline. Changes will sync when connection is restored.</span>
    </div>
  );
}
