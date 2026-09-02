'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Bell, PackageX, CalendarClock, AlertTriangle, CheckCircle2, Loader2 } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuthStore } from '@/store/auth-store';
import { usePharmacyStore } from '@/store/pharmacy-store';
import { useHydrated } from '@/hooks/use-hydrated';

interface InventoryItem {
  id: string;
  product_name: string;
  batch_number?: string | null;
  quantity: number;
  reorder_level: number;
  expiry_date?: string | null;
}

interface Alert {
  id: string;
  kind: 'low-stock' | 'expiring';
  title: string;
  detail: string;
  href: string;
}

const MAX_PER_GROUP = 4;

/**
 * Notification bell backed by real inventory state rather than the (currently
 * unpopulated) notifications table: low/out-of-stock items and stock expiring
 * inside 30 days. Which groups appear is driven by the pharmacy's notification
 * preferences from Settings.
 */
export function NotificationBell() {
  const router = useRouter();
  const hydrated = useHydrated();
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
  const notifications = usePharmacyStore((state) => state.settings.notifications);

  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const showLowStock = notifications.low_stock_alerts;
  const showExpiring = notifications.expiring_alerts;

  const loadAlerts = useCallback(async () => {
    if (!showLowStock && !showExpiring) {
      setAlerts([]);
      setLoaded(true);
      return;
    }

    setLoading(true);
    setError(false);
    try {
      const requests: Promise<InventoryItem[]>[] = [];
      const kinds: ('low-stock' | 'expiring')[] = [];

      if (showLowStock) {
        requests.push(api.get('/inventory/low-stock').then((r) => r.data || []));
        kinds.push('low-stock');
      }
      if (showExpiring) {
        requests.push(api.get('/inventory/expiring?days=30').then((r) => r.data || []));
        kinds.push('expiring');
      }

      const results = await Promise.all(requests);

      const merged: Alert[] = [];
      results.forEach((rows, index) => {
        const kind = kinds[index];
        rows.slice(0, MAX_PER_GROUP).forEach((item) => {
          merged.push(
            kind === 'low-stock'
              ? {
                  id: `low-${item.id}`,
                  kind,
                  title: item.product_name,
                  detail:
                    item.quantity === 0
                      ? 'Out of stock'
                      : `${item.quantity} left · reorder at ${item.reorder_level}`,
                  href: '/inventory',
                }
              : {
                  id: `exp-${item.id}`,
                  kind,
                  title: item.product_name,
                  detail: item.expiry_date
                    ? `Expires ${new Date(item.expiry_date).toLocaleDateString('en-GB', {
                        day: 'numeric',
                        month: 'short',
                        year: 'numeric',
                      })}${item.batch_number ? ` · batch ${item.batch_number}` : ''}`
                    : 'Expiring within 30 days',
                  href: '/inventory',
                }
          );
        });
      });

      setAlerts(merged);
      setLoaded(true);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [showLowStock, showExpiring]);

  // Refresh whenever the bell is opened so the counts are never stale, and once
  // on sign-in so the badge shows immediately.
  useEffect(() => {
    if (!hydrated || !isAuthenticated) return;
    loadAlerts();
  }, [hydrated, isAuthenticated, loadAlerts]);

  useEffect(() => {
    if (!open || !hydrated || !isAuthenticated) return;
    loadAlerts();
  }, [open, hydrated, isAuthenticated, loadAlerts]);

  // Close on outside click
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, []);

  const counts = alerts.reduce(
    (acc, alert) => {
      acc[alert.kind] += 1;
      return acc;
    },
    { 'low-stock': 0, expiring: 0 } as Record<Alert['kind'], number>
  );

  const closeAndGo = (href: string) => {
    setOpen(false);
    router.push(href);
  };

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-label={alerts.length ? `${alerts.length} stock alerts` : 'Notifications'}
        aria-expanded={open}
        className="relative p-2.5 rounded-xl hover:bg-gray-100"
      >
        <Bell className="w-5 h-5 text-gray-600" />
        {alerts.length > 0 && (
          <span className="absolute top-1 right-1 min-w-[18px] h-[18px] px-1 bg-red-500 rounded-full border-2 border-white flex items-center justify-center">
            <span className="text-white text-[10px] font-bold leading-none">{alerts.length}</span>
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 z-40 mt-2 w-[320px] bg-white border border-gray-200 rounded-xl shadow-lg overflow-hidden animate-fade-in">
          <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100">
            <h2 className="text-sm font-semibold text-gray-900">Stock alerts</h2>
            <button
              type="button"
              onClick={() => loadAlerts()}
              disabled={loading}
              className="text-2xs font-medium text-primary-600 hover:text-primary-700 disabled:opacity-50"
            >
              Refresh
            </button>
          </div>

          <div className="max-h-[340px] overflow-y-auto">
            {loading && !loaded ? (
              <div className="flex items-center justify-center gap-2 py-10 text-sm text-gray-500">
                <Loader2 className="w-4 h-4 animate-spin" /> Loading alerts...
              </div>
            ) : error ? (
              <div className="py-10 px-4 text-center">
                <AlertTriangle className="w-6 h-6 text-amber-500 mx-auto mb-2" />
                <p className="text-sm text-gray-600">Could not load alerts.</p>
                <button type="button" onClick={() => loadAlerts()} className="btn-ghost btn-sm mt-2">
                  Try again
                </button>
              </div>
            ) : alerts.length === 0 ? (
              <div className="py-10 px-4 text-center">
                <CheckCircle2 className="w-7 h-7 text-green-500 mx-auto mb-2" />
                <p className="text-sm font-medium text-gray-900">You&apos;re all caught up</p>
                <p className="text-xs text-gray-500 mt-1">
                  {showLowStock || showExpiring
                    ? 'No low stock and nothing expiring in the next 30 days.'
                    : 'Stock alerts are turned off in Settings.'}
                </p>
              </div>
            ) : (
              <ul className="divide-y divide-gray-50">
                {alerts.map((alert) => (
                  <li key={alert.id}>
                    <button
                      type="button"
                      onClick={() => closeAndGo(alert.href)}
                      className="w-full flex items-start gap-3 px-4 py-3 hover:bg-gray-50 text-left"
                    >
                      <span
                        className={`mt-0.5 flex-shrink-0 ${
                          alert.kind === 'low-stock' ? 'text-red-500' : 'text-amber-500'
                        }`}
                      >
                        {alert.kind === 'low-stock' ? (
                          <PackageX className="w-4 h-4" />
                        ) : (
                          <CalendarClock className="w-4 h-4" />
                        )}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-medium text-gray-900 truncate">
                          {alert.title}
                        </span>
                        <span className="block text-xs text-gray-500 truncate">{alert.detail}</span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {loaded && !error && (counts['low-stock'] > 0 || counts.expiring > 0) && (
            <div className="px-4 py-2.5 border-t border-gray-100 bg-gray-50 flex items-center justify-between gap-2 text-2xs text-gray-500">
              <span>
                {counts['low-stock'] > 0 && `${counts['low-stock']} low stock`}
                {counts['low-stock'] > 0 && counts.expiring > 0 && ' · '}
                {counts.expiring > 0 && `${counts.expiring} expiring`}
              </span>
              <Link
                href="/inventory"
                onClick={() => setOpen(false)}
                className="font-medium text-primary-600 hover:text-primary-700"
              >
                Open inventory
              </Link>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
