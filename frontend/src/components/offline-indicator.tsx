'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { AlertTriangle, RefreshCw, WifiOff } from 'lucide-react';
import { useSyncStatus } from '@/hooks/use-sync-status';
import { resolveBanner } from '@/lib/offline/banner';

/**
 * The offline banner.
 *
 * Everything it is allowed to say lives in `lib/offline/banner`, which is pure
 * and tested; this file only decides where it goes on screen.
 */
export function OfflineIndicator() {
  const status = useSyncStatus();
  const pathname = usePathname();

  const banner = resolveBanner({
    ready: status.ready,
    online: status.online,
    queued: status.counts.queued,
    syncing: status.counts.syncing,
    dead: status.counts.dead,
    total: status.counts.total,
    running: status.running,
    storageError: status.storageError,
  });

  if (!banner) return null;

  // The till is a fixed-height flex column and renders its own offline panel,
  // because there "offline" means "you can still sell, and here is the queue"
  // rather than "keep waiting". A second banner would push the grid down and make
  // the page scroll.
  if (pathname === '/pos') return null;

  const Icon = banner.tone === 'danger' ? AlertTriangle : WifiOff;

  return (
    <div
      className={`offline-banner no-print flex items-center justify-center gap-2 ${
        banner.tone === 'danger' ? 'offline-banner-danger' : ''
      }`}
      role="status"
    >
      <Icon className="w-4 h-4 shrink-0" aria-hidden="true" />
      <span>{banner.text}</span>
      {banner.href && banner.linkText && (
        <Link href={banner.href} className="inline-flex items-center gap-1">
          {banner.linkText}
          {banner.linkText === 'Sync now' && <RefreshCw className="w-3 h-3" aria-hidden="true" />}
        </Link>
      )}
    </div>
  );
}
