'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { queueCounts, subscribeToQueue } from '@/lib/offline/queue';
import { runSync, subscribeToSyncRuns } from '@/lib/offline/scheduler';
import { isSyncRunning, type SyncRunResult } from '@/lib/offline/sync';

/**
 * What the app can honestly say about offline state.
 *
 * The previous banner announced "Changes will sync when connection is restored"
 * whenever the browser went offline, which was untrue in the two situations that
 * matter most: when nothing had been queued, so there were no changes to sync,
 * and when a write had been rejected by the server and would never sync on its
 * own. Both read as reassurance. This hook exists so the UI can tell the three
 * cases apart.
 *
 * It observes only. The triggers that actually start a run are started once by
 * `AppBootstrap`, because a hook mounted in a banner that unmounts on navigation
 * must not take the scheduler down with it.
 */

export interface SyncCounts {
  queued: number;
  syncing: number;
  dead: number;
  total: number;
}

export interface SyncStatus {
  /** False until the queue has been read once; before that every count is a guess. */
  ready: boolean;
  /** The browser's own view of the connection. */
  online: boolean;
  counts: SyncCounts;
  /** True while a run is in flight, whoever started it. */
  running: boolean;
  /** The outcome of the most recent run, or null if there has not been one. */
  lastRun: SyncRunResult | null;
  /** Set when IndexedDB itself failed, which is not the same as being offline. */
  storageError: string | null;
  /** True when something needs a person, and will not fix itself. */
  needsAttention: boolean;
  syncNow: () => Promise<SyncRunResult | null>;
}

const NO_COUNTS: SyncCounts = { queued: 0, syncing: 0, dead: 0, total: 0 };

export function useSyncStatus(): SyncStatus {
  const [ready, setReady] = useState(false);
  const [online, setOnline] = useState(true);
  const [counts, setCounts] = useState<SyncCounts>(NO_COUNTS);
  const [ownRunInFlight, setOwnRunInFlight] = useState(false);
  const [lastRun, setLastRun] = useState<SyncRunResult | null>(null);
  const [storageError, setStorageError] = useState<string | null>(null);

  const mounted = useRef(true);
  const reading = useRef(false);
  const reread = useRef(false);

  const refresh = useCallback(async () => {
    // Coalesced, because a sync run notifies the queue once per item it touches
    // and overlapping reads could resolve out of order, leaving the banner
    // showing a count from before the run finished.
    if (reading.current) {
      reread.current = true;
      return;
    }
    reading.current = true;

    try {
      do {
        reread.current = false;
        try {
          const next = await queueCounts();
          if (!mounted.current) return;
          setCounts(next);
          setStorageError(null);
        } catch (error) {
          if (!mounted.current) return;
          setStorageError(
            error instanceof Error ? error.message : 'Offline storage is unavailable on this device'
          );
        }
        if (mounted.current) setReady(true);
      } while (reread.current && mounted.current);
    } finally {
      reading.current = false;
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    setOnline(typeof navigator === 'undefined' || navigator.onLine !== false);
    void refresh();

    const unsubscribeQueue = subscribeToQueue(() => {
      void refresh();
    });

    const unsubscribeRuns = subscribeToSyncRuns((result) => {
      setLastRun(result);
      setOwnRunInFlight(false);
      if (result.storageError) setStorageError(result.storageError);
      void refresh();
    });

    const handleOnline = () => {
      setOnline(true);
      void refresh();
    };
    const handleOffline = () => setOnline(false);

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      mounted.current = false;
      unsubscribeQueue();
      unsubscribeRuns();
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, [refresh]);

  const syncNow = useCallback(async (): Promise<SyncRunResult | null> => {
    setOwnRunInFlight(true);
    try {
      return await runSync();
    } finally {
      if (mounted.current) setOwnRunInFlight(false);
    }
  }, []);

  return {
    ready,
    online,
    counts,
    // A run the scheduler started is not tracked by our own state, but the queue
    // notifications it produces re-render this hook, so reading the module flag
    // here is enough to keep the banner truthful about a run in flight.
    running: ownRunInFlight || isSyncRunning(),
    lastRun,
    storageError,
    needsAttention: counts.dead > 0,
    syncNow,
  };
}
