'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import toast from 'react-hot-toast';
import { format } from 'date-fns';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Inbox,
  Loader2,
  RefreshCw,
  Trash2,
  WifiOff,
} from 'lucide-react';
import { useAuthStore } from '@/store/auth-store';
import { useHydrated } from '@/hooks/use-hydrated';
import { useSyncStatus } from '@/hooks/use-sync-status';
import { DashboardLayout } from '@/components/layout/dashboard-layout';
import { Modal } from '@/components/ui/modal';
import {
  discardItem,
  listDiscarded,
  listQueue,
  retryItem,
  subscribeToQueue,
  type DiscardedItem,
  type QueueEntity,
  type QueueItem,
} from '@/lib/offline/queue';
import {
  countOpenNotices,
  dismissAllNotices,
  dismissNotice,
  listNotices,
  type NoticeKind,
  type SyncNotice,
} from '@/lib/offline/notices';
import { attemptsRemaining, type SyncRunResult } from '@/lib/offline/sync';

/**
 * Everything this device has recorded and not yet been able to send.
 *
 * The page has to work with no connection at all — that is the situation it
 * exists for — so nothing on it reads from the API. It reads IndexedDB and, when
 * the user asks, tries a sync.
 *
 * It is also the only place a queued write can be thrown away, and it will not
 * let that happen without a written reason: an unexplained disappearance is
 * indistinguishable from a bug that lost somebody's money.
 */

const ENTITY_LABEL: Record<QueueEntity, string> = {
  sale: 'Sale',
  patient: 'Patient',
  screening: 'Screening',
  inventory: 'Stock adjustment',
};

const NOTICE_LABEL: Record<NoticeKind, string> = {
  duplicate: 'Already on the server',
  total_mismatch: 'Total disagreed',
  stock_negative: 'Stock went negative',
  unverified_payment: 'Payment unconfirmed',
};

function when(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  return format(parsed, 'd MMM yyyy, HH:mm');
}

/** Every failure on this page is a storage failure, and saying so is the point. */
function reasonFor(error: unknown): string {
  return error instanceof Error
    ? error.message
    : 'Offline storage could not be written on this device';
}

/**
 * When the item will next be tried by itself, or null if it is due now, in
 * flight, or has given up.
 *
 * Worth showing because "3 attempts left" on its own leaves a cashier staring at
 * a queue that will not move for another ten minutes, with the sync button doing
 * nothing — it only sends what is already due.
 */
function waitingUntil(item: QueueItem): Date | null {
  if (item.status !== 'queued' || item.nextAttemptAt === null) return null;
  const at = new Date(item.nextAttemptAt);
  if (Number.isNaN(at.getTime()) || at.getTime() <= Date.now()) return null;
  return at;
}

function describeRun(result: SyncRunResult): void {
  if (result.storageError) {
    toast.error(result.storageError);
    return;
  }
  if (result.signedOut) {
    toast.error('You are signed out. Sign in again and these will send.');
    return;
  }
  if (result.skippedOffline) {
    toast('Still no connection. They are safe on this device.', { icon: '📴' });
    return;
  }
  if (result.parked > 0) {
    toast.error(
      `${result.parked} could not be sent and need${result.parked === 1 ? 's' : ''} a decision.`
    );
    return;
  }
  if (result.synced > 0) {
    const extra = result.deferred > 0 ? ` · ${result.deferred} waiting on another record` : '';
    toast.success(`${result.synced} sent to the server${extra}`);
    return;
  }
  if (result.retrying > 0) {
    toast('The server did not answer. They will be tried again.', { icon: '⏳' });
    return;
  }
  if (result.deferred > 0) {
    toast(`${result.deferred} waiting for a record they depend on.`, { icon: '⏳' });
    return;
  }
  toast('Nothing waiting to send.');
}

export default function SyncPage() {
  const router = useRouter();
  const hydrated = useHydrated();
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
  const status = useSyncStatus();

  const [items, setItems] = useState<QueueItem[]>([]);
  const [discarded, setDiscarded] = useState<DiscardedItem[]>([]);
  const [notices, setNotices] = useState<SyncNotice[]>([]);
  const [openNotices, setOpenNotices] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [showCleared, setShowCleared] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const [discardTarget, setDiscardTarget] = useState<QueueItem | null>(null);
  const [discardReason, setDiscardReason] = useState('');

  const load = useCallback(async () => {
    try {
      const [queued, cleared, stored, open] = await Promise.all([
        listQueue(),
        listDiscarded(),
        listNotices(),
        countOpenNotices(),
      ]);
      setItems(queued);
      setDiscarded(cleared);
      setNotices(stored);
      setOpenNotices(open);
      setLoadError(null);
    } catch (error) {
      setLoadError(
        error instanceof Error ? error.message : 'Offline storage could not be read on this device'
      );
    }
  }, []);

  useEffect(() => {
    if (hydrated && !isAuthenticated) router.replace('/login');
  }, [hydrated, isAuthenticated, router]);

  // Read once, then follow the queue. Subscribing is the right signal rather
  // than the hook's counts: an item moving from "waiting" to "needs a decision"
  // is the transition this page exists for and it does not change the total.
  // A sale queued on another screen while this one is open arrives the same way,
  // and the trailing read always lands after the last mutation.
  useEffect(() => {
    if (!hydrated) return;
    void load();
    return subscribeToQueue(() => {
      void load();
    });
  }, [hydrated, load]);

  // None of these re-read the page afterwards: a change to the queue announces
  // itself and the subscription above reloads, so an extra read here would only
  // race the one already in flight.
  async function syncNow() {
    const result = await status.syncNow();
    if (result) describeRun(result);
  }

  async function retryOne(item: QueueItem) {
    setBusyId(item.id);
    try {
      await retryItem(item.id);
      if (!status.online) {
        toast('Queued to send as soon as there is a connection.', { icon: '⏳' });
        return;
      }
      const result = await status.syncNow();
      if (result) describeRun(result);
    } catch (error) {
      toast.error(reasonFor(error));
    } finally {
      setBusyId(null);
    }
  }

  async function confirmDiscard() {
    if (!discardTarget) return;
    if (!discardReason.trim()) {
      toast.error('Say why, so this can be told apart from a bug that lost it.');
      return;
    }

    setBusyId(discardTarget.id);
    try {
      await discardItem(discardTarget.id, discardReason.trim());
      toast.success('Removed from the queue and recorded below.');
      setDiscardTarget(null);
      setDiscardReason('');
      setShowCleared(true);
    } catch (error) {
      toast.error(reasonFor(error));
    } finally {
      setBusyId(null);
    }
  }

  async function clearNotice(notice: SyncNotice) {
    setBusyId(notice.id);
    try {
      await dismissNotice(notice.id);
      // Notices are not the queue, so nothing announces this one.
      await load();
    } catch (error) {
      toast.error(reasonFor(error));
    } finally {
      setBusyId(null);
    }
  }

  async function clearEveryNotice() {
    setBusyId('notices');
    try {
      await dismissAllNotices();
      await load();
    } catch (error) {
      toast.error(reasonFor(error));
    } finally {
      setBusyId(null);
    }
  }

  const needsDecision = items.filter((item) => item.status === 'dead');
  const waiting = items.filter((item) => item.status !== 'dead');

  return (
    <DashboardLayout>
      <div className="animate-fade-in space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Offline queue</h1>
            <p className="text-sm text-gray-500">
              Recorded on this device and not yet on the server.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <span
              className={
                status.online ? 'badge-success inline-flex items-center gap-1' : 'badge-warning inline-flex items-center gap-1'
              }
            >
              {status.online ? <CheckCircle2 className="h-3.5 w-3.5" /> : <WifiOff className="h-3.5 w-3.5" />}
              {status.online ? 'Online' : 'Offline'}
            </span>
            <button
              type="button"
              className="btn-primary btn-sm"
              onClick={syncNow}
              disabled={status.running}
            >
              {status.running ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <RefreshCw className="h-4 w-4" />
              )}
              {status.running ? 'Syncing…' : 'Sync now'}
            </button>
          </div>
        </div>

        {(loadError || status.storageError) && (
          <div className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-900">
            <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
            <div>
              <p className="font-semibold">Offline storage is not working on this device.</p>
              <p>{loadError || status.storageError}</p>
              <p className="mt-1">
                Nothing can be saved while the connection is down. This is usually private browsing
                or a full disk.
              </p>
            </div>
          </div>
        )}

        {openNotices > 0 && (
          <div className="card p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="font-semibold text-gray-900">Sent, but worth a look</h2>
                <p className="text-sm text-gray-500">
                  {openNotices} of these reached the server and came back with something to check.
                </p>
              </div>
              <button
                type="button"
                className="btn-ghost btn-sm"
                onClick={clearEveryNotice}
                disabled={busyId === 'notices'}
              >
                Mark all as seen
              </button>
            </div>

            <ul className="mt-3 space-y-2">
              {notices.map((notice) => (
                <li
                  key={notice.id}
                  className="flex items-start justify-between gap-3 rounded-lg border border-yellow-200 bg-yellow-50 p-3"
                >
                  <div className="min-w-0">
                    <p className="text-xs font-semibold uppercase tracking-wide text-yellow-800">
                      {NOTICE_LABEL[notice.kind]}
                    </p>
                    <p className="text-sm text-gray-800">{notice.label}</p>
                    <p className="mt-0.5 text-sm text-gray-600">{notice.message}</p>
                    <p className="mt-1 text-xs text-gray-500">{when(notice.raisedAt)}</p>
                  </div>
                  <button
                    type="button"
                    className="btn-ghost btn-sm flex-shrink-0"
                    onClick={() => clearNotice(notice)}
                    disabled={busyId === notice.id}
                  >
                    Seen
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {needsDecision.length > 0 && (
          <div className="card p-4">
            <h2 className="font-semibold text-gray-900">Needs a decision</h2>
            <p className="text-sm text-gray-500">
              The server refused these, or they ran out of attempts. They will not send themselves —
              fix the cause and retry, or remove them with a reason.
            </p>
            <ul className="mt-3 space-y-3">
              {needsDecision.map((item) => (
                <QueueRow
                  key={item.id}
                  item={item}
                  tone="danger"
                  busy={busyId === item.id}
                  expanded={expandedId === item.id}
                  onTogglePayload={() =>
                    setExpandedId(expandedId === item.id ? null : item.id)
                  }
                  onRetry={() => retryOne(item)}
                  onDiscard={() => {
                    setDiscardTarget(item);
                    setDiscardReason('');
                  }}
                />
              ))}
            </ul>
          </div>
        )}

        <div className="card p-4">
          <h2 className="font-semibold text-gray-900">Waiting to send</h2>
          <p className="text-sm text-gray-500">
            {status.online
              ? 'These go to the server on their own. Nothing here needs doing.'
              : 'Saved on this device. They will be sent as soon as there is a connection.'}
          </p>

          {waiting.length === 0 ? (
            <div className="empty-state">
              <Inbox className="h-10 w-10 text-gray-300" />
              <p className="mt-2 text-sm text-gray-500">Nothing waiting.</p>
            </div>
          ) : (
            <ul className="mt-3 space-y-3">
              {waiting.map((item) => (
                <QueueRow
                  key={item.id}
                  item={item}
                  tone="neutral"
                  busy={busyId === item.id}
                  expanded={expandedId === item.id}
                  onTogglePayload={() =>
                    setExpandedId(expandedId === item.id ? null : item.id)
                  }
                  onRetry={() => retryOne(item)}
                  onDiscard={() => {
                    setDiscardTarget(item);
                    setDiscardReason('');
                  }}
                />
              ))}
            </ul>
          )}
        </div>

        {discarded.length > 0 && (
          <div className="card p-4">
            <button
              type="button"
              className="flex w-full items-center justify-between gap-2 text-left"
              onClick={() => setShowCleared((value) => !value)}
              aria-expanded={showCleared}
            >
              <span>
                <span className="font-semibold text-gray-900">Removed on this device</span>
                <span className="ml-2 text-sm text-gray-500">
                  {discarded.length} · kept so a removal can be told apart from a loss
                </span>
              </span>
              {showCleared ? (
                <ChevronDown className="h-4 w-4 text-gray-400" />
              ) : (
                <ChevronRight className="h-4 w-4 text-gray-400" />
              )}
            </button>

            {showCleared && (
              <ul className="mt-3 space-y-2">
                {discarded.map((entry) => (
                  <li key={entry.id} className="rounded-lg border border-gray-200 p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="text-sm font-medium text-gray-900">{entry.label}</p>
                      <span className="badge-neutral">{ENTITY_LABEL[entry.entity]}</span>
                    </div>
                    <p className="mt-1 text-sm text-gray-600">
                      Removed {when(entry.discardedAt)} — {entry.discardReason}
                    </p>
                    {entry.lastError && (
                      <p className="mt-1 text-xs text-gray-500">Last error: {entry.lastError}</p>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>

      <Modal
        open={discardTarget !== null}
        onClose={() => setDiscardTarget(null)}
        title="Remove this from the queue?"
        description="It will not be sent to the server. The removal and your reason are kept on this device."
        size="sm"
        footer={
          <>
            <button type="button" className="btn-secondary btn-sm" onClick={() => setDiscardTarget(null)}>
              Keep it
            </button>
            <button
              type="button"
              className="btn-danger btn-sm"
              onClick={confirmDiscard}
              disabled={!discardReason.trim()}
            >
              <Trash2 className="h-4 w-4" />
              Remove
            </button>
          </>
        }
      >
        {discardTarget && (
          <div className="space-y-3">
            <div className="rounded-lg bg-gray-50 p-3 text-sm">
              <p className="font-medium text-gray-900">{discardTarget.label}</p>
              <p className="mt-0.5 text-gray-500">
                {ENTITY_LABEL[discardTarget.entity]} · recorded {when(discardTarget.recordedAt)}
              </p>
              {discardTarget.lastError && (
                <p className="mt-2 text-gray-700">{discardTarget.lastError}</p>
              )}
            </div>

            <div>
              <label className="label" htmlFor="discard-reason">
                Why is this being removed?
              </label>
              <textarea
                id="discard-reason"
                className="input"
                rows={3}
                value={discardReason}
                onChange={(event) => setDiscardReason(event.target.value)}
                placeholder="For example: customer left without the goods, or entered twice by mistake."
              />
              <p className="mt-1 text-xs text-gray-500">
                Required. If the day&rsquo;s takings do not match the drawer, this is what explains
                the difference.
              </p>
            </div>
          </div>
        )}
      </Modal>
    </DashboardLayout>
  );
}

interface QueueRowProps {
  item: QueueItem;
  tone: 'danger' | 'neutral';
  busy: boolean;
  expanded: boolean;
  onTogglePayload: () => void;
  onRetry: () => void;
  onDiscard: () => void;
}

function QueueRow({ item, tone, busy, expanded, onTogglePayload, onRetry, onDiscard }: QueueRowProps) {
  const left = attemptsRemaining(item);
  const waitsUntil = waitingUntil(item);
  // An item that will not send by itself: rejected, out of attempts, or sitting
  // on its backoff timer. One that is due needs no button, and one in flight
  // must not be reset underneath the request already on its way.
  const needsNudge = item.status === 'dead' || waitsUntil !== null;
  const border = tone === 'danger' ? 'border-red-200 bg-red-50' : 'border-gray-200';

  return (
    <li className={`rounded-lg border p-3 ${border}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-medium text-gray-900">{item.label}</p>
          <p className="mt-0.5 text-xs text-gray-500">
            <span className="badge-neutral mr-2">{ENTITY_LABEL[item.entity]}</span>
            Recorded {when(item.recordedAt)}
            {item.status === 'syncing' && ' · sending now'}
            {waitsUntil && ` · next try ${format(waitsUntil, 'HH:mm')}`}
          </p>
        </div>

        <div className="flex flex-shrink-0 items-center gap-2">
          {item.status === 'dead' ? (
            <span className="badge-danger">Needs a decision</span>
          ) : left < 5 ? (
            <span className="badge-warning">
              {left} attempt{left === 1 ? '' : 's'} left
            </span>
          ) : null}
          <button
            type="button"
            className="btn-ghost btn-sm"
            onClick={onTogglePayload}
            aria-expanded={expanded}
          >
            {expanded ? 'Hide' : 'Details'}
          </button>
          {needsNudge && (
            <button type="button" className="btn-secondary btn-sm" onClick={onRetry} disabled={busy}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              {item.status === 'dead' ? 'Retry' : 'Try now'}
            </button>
          )}
          <button type="button" className="btn-danger btn-sm" onClick={onDiscard} disabled={busy}>
            <Trash2 className="h-4 w-4" />
            Remove
          </button>
        </div>
      </div>

      {item.lastError && (
        <p
          className={`mt-2 text-sm ${
            tone === 'danger' ? 'text-red-800' : 'text-gray-600'
          }`}
        >
          {item.lastError}
        </p>
      )}

      {expanded && (
        <pre className="mt-2 max-h-64 overflow-auto rounded-lg bg-gray-900 p-3 text-xs text-gray-100">
          {JSON.stringify(item.payload, null, 2)}
        </pre>
      )}
    </li>
  );
}
