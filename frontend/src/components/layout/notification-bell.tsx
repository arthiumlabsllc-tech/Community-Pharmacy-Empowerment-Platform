'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Bell, PackageX, CalendarClock, AlertTriangle, CheckCircle2, Loader2 } from 'lucide-react';
import { api } from '@/lib/api';
import {
  EXPIRING_WINDOW_DAYS,
  FEED_LIMIT,
  countByGroup,
  deriveExpiringAlerts,
  deriveLowStockAlerts,
  kindsForPreferences,
  kindsParam,
  toBellAlerts,
  type BellAlert,
  type InventoryRow,
  type PersistedNotification,
} from '@/lib/notification-feed';
import { useAuthStore } from '@/store/auth-store';
import { usePharmacyStore } from '@/store/pharmacy-store';
import { useHydrated } from '@/hooks/use-hydrated';

/** What `GET /notifications` answers. */
interface FeedResponse {
  success: boolean;
  /** False when the database has no alert columns, so nothing is stored to read. */
  supported?: boolean;
  message?: string;
  data?: PersistedNotification[];
  counts?: { live: number; unread: number };
}

/** Where the list on screen came from. The wording below depends on it. */
type FeedSource = 'stored' | 'derived';

/**
 * Notification bell.
 *
 * Reads the persisted stock alerts when the database has them, and derives the
 * same list from live inventory when it does not — which is what a pharmacy that
 * has not applied migration 003 gets, and what the API means by
 * `supported: false`. The two are not presented as the same thing: they count
 * differently, they cover different expiry windows, and only one of them can be
 * marked as read.
 *
 * Which groups appear is driven by the pharmacy's notification preferences from
 * Settings. Those live on the device, so they are applied here as a filter on
 * the request rather than sent to the server as a preference it cannot verify.
 */
export function NotificationBell() {
  const router = useRouter();
  const hydrated = useHydrated();
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
  const user = useAuthStore((state) => state.user);
  const notifications = usePharmacyStore((state) => state.settings.notifications);

  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [alerts, setAlerts] = useState<BellAlert[]>([]);
  const [source, setSource] = useState<FeedSource>('derived');
  const [liveTotal, setLiveTotal] = useState<number | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(false);
  const [clearing, setClearing] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  /**
   * Whether the alerts have been recomputed from the shelf this session.
   *
   * A ref rather than state because it gates a write and nothing renders it.
   * Once per mount is the right cadence: the mutation sites keep alerts current
   * for anything that changes stock, and what they cannot catch is an expiry
   * that crossed into the window overnight with no sale to prompt a refresh.
   * Recomputing on every dropdown open would rescan the whole shelf for a list
   * that is already current.
   */
  const recomputed = useRef(false);

  const showLowStock = notifications.low_stock_alerts;
  const showExpiring = notifications.expiring_alerts;
  // Clearing sets one `read_at` on a pharmacy-wide row, so the API restricts it
  // to the owner and the pharmacist: a cashier clearing the badge at the end of a
  // shift would leave nobody with a sign that anything had run out. Seeing the
  // alerts is not restricted, so the list itself renders the same for everyone.
  const canClear = user?.role === 'pharmacy_owner' || user?.role === 'pharmacist';

  /**
   * The list the bell showed before alerts were persisted, and still shows on a
   * database without them.
   */
  const deriveFromInventory = useCallback(async (): Promise<BellAlert[]> => {
    const requests: Promise<InventoryRow[]>[] = [];
    const which: Array<'low' | 'expiring'> = [];

    if (showLowStock) {
      requests.push(api.get('/inventory/low-stock').then((response) => response.data || []));
      which.push('low');
    }
    if (showExpiring) {
      requests.push(
        api
          .get(`/inventory/expiring?days=${EXPIRING_WINDOW_DAYS}`)
          .then((response) => response.data || [])
      );
      which.push('expiring');
    }

    const results = await Promise.all(requests);
    return results.flatMap((rows, index) =>
      which[index] === 'low' ? deriveLowStockAlerts(rows) : deriveExpiringAlerts(rows)
    );
  }, [showLowStock, showExpiring]);

  const loadAlerts = useCallback(async () => {
    // The preferences are local-first — this device's localStorage, only
    // sometimes pushed to the pharmacy row — so the kinds are decided here and
    // sent as a filter. The server records what is true; it cannot know what any
    // one device wants to see.
    const kinds = kindsParam(
      kindsForPreferences({
        low_stock_alerts: showLowStock,
        expiring_alerts: showExpiring,
      })
    );

    if (kinds === null) {
      setAlerts([]);
      setLiveTotal(null);
      setLoaded(true);
      return;
    }

    setLoading(true);
    setError(false);
    try {
      const feed = await api.get<FeedResponse>(
        `/notifications?${new URLSearchParams({ kinds, limit: String(FEED_LIMIT) })}`
      );

      if (feed.supported === false) {
        // Not an error and not an empty list: nothing has been recorded to read
        // yet. Falling back keeps the bell useful on a database without
        // migration 003, and it upgrades itself with no code change once 003 is
        // applied — the same request starts answering `supported: true`.
        setAlerts(await deriveFromInventory());
        setSource('derived');
        setLiveTotal(null);
      } else {
        setAlerts(toBellAlerts(feed.data ?? []));
        setSource('stored');
        setLiveTotal(feed.counts?.live ?? null);
      }
      setLoaded(true);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [showLowStock, showExpiring, deriveFromInventory]);

  /**
   * Recomputes the alerts from the shelf, then reads them back.
   *
   * The recompute is best effort and its failure is deliberately not shown: a
   * database without the alert columns answers 501, which is the same situation
   * the read handles with `supported: false`, and the read that follows reports
   * what is actually there either way.
   *
   * It runs even when both preferences are off. The alerts are pharmacy-wide
   * state and the preferences are per-device, so one till with its bell switched
   * off must not stop the pharmacy's shortages being recorded for everybody else.
   */
  const recomputeThenLoad = useCallback(async () => {
    try {
      await api.post('/notifications/refresh');
    } catch {
      // See above.
    }
    await loadAlerts();
  }, [loadAlerts]);

  // Once on sign-in, so an expiry that crossed into the window overnight is in
  // the list before the pharmacist opens the bell.
  useEffect(() => {
    if (!hydrated || !isAuthenticated || recomputed.current) return;
    recomputed.current = true;
    recomputeThenLoad();
  }, [hydrated, isAuthenticated, recomputeThenLoad]);

  // Read again whenever the bell is opened so the counts are never stale.
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

  const counts = countByGroup(alerts);
  const unreadCount = alerts.filter((alert) => alert.unread).length;
  const truncated = source === 'stored' && liveTotal !== null && liveTotal > alerts.length;

  /**
   * Live alerts, not unread ones.
   *
   * A badge that counted only the unopened would fall to zero the moment the
   * pharmacist marked them read, and stay at zero while the shelf was still
   * empty. Clearing a notification is not restocking it, and the badge is the one
   * part of the bell visible without opening it.
   */
  const badge = source === 'stored' && liveTotal !== null ? liveTotal : alerts.length;

  const closeAndGo = (alert: BellAlert) => {
    setOpen(false);
    router.push(alert.href);

    // Stamped on the way out rather than on the way in, because `read_at` is
    // meant to record when the shortage was first seen and only going there is
    // seeing it. A failure is not worth interrupting the navigation for, and the
    // dot stays, so the next open reports the truth.
    if (source !== 'stored' || !canClear || !alert.unread) return;
    api.post(`/notifications/${alert.id}/read`).catch(() => undefined);
  };

  const clearAll = async () => {
    const kinds = kindsForPreferences({
      low_stock_alerts: showLowStock,
      expiring_alerts: showExpiring,
    });
    if (kinds.length === 0) return;

    setClearing(true);
    try {
      await api.post('/notifications/read', { kinds });
    } catch {
      // The reload below is the correction: whatever the server actually did is
      // what comes back, so a failed clear leaves the dots rather than claiming
      // one that did not happen.
    }
    await loadAlerts();
    setClearing(false);
  };

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-label={badge ? `${badge} stock alerts` : 'Notifications'}
        aria-expanded={open}
        className="relative p-2.5 rounded-xl hover:bg-gray-100"
      >
        <Bell className="w-5 h-5 text-gray-600" />
        {badge > 0 && (
          <span className="absolute top-1 right-1 min-w-[18px] h-[18px] px-1 bg-red-500 rounded-full border-2 border-white flex items-center justify-center">
            <span className="text-white text-[10px] font-bold leading-none">{badge}</span>
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 z-40 mt-2 w-[320px] bg-white border border-gray-200 rounded-xl shadow-lg overflow-hidden animate-fade-in">
          <div className="flex items-center justify-between gap-2 px-4 py-3 border-b border-gray-100">
            <h2 className="text-sm font-semibold text-gray-900">Stock alerts</h2>
            <div className="flex items-center gap-3">
              {/*
                Only where the alerts are stored, and only for the roles the API
                lets clear them. Offering it to a cashier would be a button that
                answers 403; offering it in the derived fallback would be a button
                that clears nothing, because there is no row to stamp.
              */}
              {source === 'stored' && canClear && unreadCount > 0 && (
                <button
                  type="button"
                  onClick={clearAll}
                  disabled={clearing || loading}
                  className="text-2xs font-medium text-gray-500 hover:text-gray-700 disabled:opacity-50"
                >
                  {clearing ? 'Clearing…' : `Mark ${unreadCount} read`}
                </button>
              )}
              <button
                type="button"
                onClick={() => recomputeThenLoad()}
                disabled={loading || clearing}
                className="text-2xs font-medium text-primary-600 hover:text-primary-700 disabled:opacity-50"
              >
                Refresh
              </button>
            </div>
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
                  {!(showLowStock || showExpiring)
                    ? 'Stock alerts are turned off in Settings.'
                    : `Nothing is low, out of stock, or expiring within ${EXPIRING_WINDOW_DAYS} days.`}
                </p>
              </div>
            ) : (
              <ul className="divide-y divide-gray-50">
                {alerts.map((alert) => (
                  <li key={alert.id}>
                    <button
                      type="button"
                      onClick={() => closeAndGo(alert)}
                      className="w-full flex items-start gap-3 px-4 py-3 hover:bg-gray-50 text-left"
                    >
                      <span
                        className={`mt-0.5 flex-shrink-0 ${
                          alert.group === 'low-stock' ? 'text-red-500' : 'text-amber-500'
                        }`}
                      >
                        {alert.group === 'low-stock' ? (
                          <PackageX className="w-4 h-4" />
                        ) : (
                          <CalendarClock className="w-4 h-4" />
                        )}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-1.5">
                          <span className="text-sm font-medium text-gray-900 truncate">
                            {alert.title}
                          </span>
                          {alert.unread && (
                            <span
                              className="flex-shrink-0 w-1.5 h-1.5 rounded-full bg-primary-600"
                              title="Not opened yet"
                            />
                          )}
                        </span>
                        {/*
                          The label goes first because the line truncates. Two
                          icons cannot tell an expired lot from one expiring in
                          three months, or an empty shelf from a low one, and the
                          writer already named the condition — so the part worth
                          keeping is the part that survives being cut short.
                        */}
                        <span className="block text-xs text-gray-500 truncate">
                          <span className="font-medium text-gray-600">{alert.label}</span>
                          {' · '}
                          {alert.detail}
                        </span>
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
                {/*
                  The breakdown above counts the rows on screen, which is a
                  limited read. Saying so is the difference between "6 low stock"
                  and a pharmacy believing six is all of it.
                */}
                {truncated && ` · ${liveTotal} in total`}
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
