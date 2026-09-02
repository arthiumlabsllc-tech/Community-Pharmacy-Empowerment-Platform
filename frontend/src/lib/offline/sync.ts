import api, { ApiError } from '../api';
import { recordNotices, type NoticeKind } from './notices';
import {
  MAX_ATTEMPTS,
  deferItem,
  dueItems,
  getQueueItem,
  isLocalId,
  listQueue,
  markFailed,
  markRejected,
  markSyncing,
  reclaimStaleSyncing,
  rememberIdentity,
  removeQueueItem,
  resolveLocalIds,
  type QueueItem,
} from './queue';

/**
 * Drains the offline queue.
 *
 * Items are replayed against their REAL endpoints — POST /patients, POST
 * /pos/sales — rather than into a batch /sync route. That keeps one validation
 * path, one tax engine and one stock guard instead of two, and it means a
 * queued write is subject to exactly the same rules as one made at the counter.
 * What makes the replay safe is the X-Client-Request-Id header: the server
 * stores the response against that key and returns it again, so a request that
 * committed and lost its response on the way back does not create a second
 * patient or a second sale.
 *
 * Failure handling is the part that matters. A write can fail because the
 * network dropped (retry), because the server is unhappy (park it and show the
 * reason), because the user is signed out (stop, change nothing), or because a
 * record it depends on is never coming (park it and say which one). Treating
 * all four as "retry later" is how a queue ends up silently empty.
 */

export interface SyncFailure {
  id: string;
  label: string;
  entity: QueueItem['entity'];
  message: string;
  status: number | null;
  /** True when the item is now in the dead pile and needs a person. */
  needsAttention: boolean;
}

/** Something the server accepted but the pharmacy should still look at. */
export interface SyncWarning {
  id: string;
  label: string;
  message: string;
}

export interface SyncRunResult {
  startedAt: string;
  finishedAt: string;
  /** Items this run actually sent. */
  attempted: number;
  synced: number;
  /** Waiting on a parent record; not counted as a failure. */
  deferred: number;
  /** Failed, but still queued with backoff. */
  retrying: number;
  /** Parked for a human: rejected by the server, or out of attempts. */
  parked: number;
  /** True when nothing was sent because the device is still offline. */
  skippedOffline: boolean;
  /** True when the run stopped because the session is no longer valid. */
  signedOut: boolean;
  /** Items reclaimed from a tab that closed mid-request. */
  reclaimed: number;
  failures: SyncFailure[];
  warnings: SyncWarning[];
  /** What is left in the queue after the run, dead items included. */
  remaining: number;
  /**
   * Set when offline storage itself failed, rather than any individual write.
   *
   * IndexedDB can be evicted under storage pressure or turned off in private
   * browsing, and when that happens the queue cannot even be read. Reporting it
   * here rather than throwing matters: the run is wired straight to the `online`
   * event and to the service worker, where a rejected promise becomes an
   * unhandled rejection that nobody ever sees, and the till would carry on
   * showing an empty queue as though everything had synced.
   */
  storageError: string | null;
}

export interface ServerEnvelope {
  success?: boolean;
  message?: string;
  data?: { id?: string; receipt_number?: string; total_amount?: string | number } | null;
  duplicate?: boolean;
  offline?: {
    totalMismatch?: boolean;
    difference?: number | null;
    quotedTotal?: number | null;
    stockWarnings?: Array<{ productName: string; sold: number; available: number }>;
    unverifiedPayments?: Array<{ method: string; amount: number }>;
  } | null;
}

/** How long a child waits for its parent before being reconsidered. */
const DEFER_DELAY_MS = 15_000;

let running: Promise<SyncRunResult> | null = null;

export function isSyncRunning(): boolean {
  return running !== null;
}

/**
 * Starts a run, or joins the one already in flight.
 *
 * The guard is not an optimisation. The `online` event, the interval timer, the
 * service worker and a manual "Sync now" button can all fire within a second of
 * each other, and two concurrent runs over the same item would send it twice —
 * which the idempotency key would absorb, but only by turning a bug into
 * noise in the server log.
 */
export function syncNow(): Promise<SyncRunResult> {
  if (running) return running;

  const run = executeRun().finally(() => {
    running = null;
  });
  running = run;
  return run;
}

function browserIsOffline(): boolean {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

async function executeRun(): Promise<SyncRunResult> {
  const startedAt = new Date().toISOString();
  const result: SyncRunResult = {
    startedAt,
    finishedAt: startedAt,
    attempted: 0,
    synced: 0,
    deferred: 0,
    retrying: 0,
    parked: 0,
    skippedOffline: false,
    signedOut: false,
    reclaimed: 0,
    failures: [],
    warnings: [],
    remaining: 0,
    storageError: null,
  };

  try {
    await drain(result);
  } catch (error) {
    result.storageError = error instanceof Error ? error.message : 'Offline storage failed';
  }

  result.finishedAt = new Date().toISOString();
  return result;
}

/**
 * One pass over the queue, filling in `result` as it goes.
 *
 * Every await in here touches IndexedDB, and any of them can throw if the
 * browser has evicted or refused storage. That is caught by the caller rather
 * than statement by statement, on purpose: a run that cannot read the queue has
 * nothing useful to say about individual writes, and carrying on regardless
 * would leave items marked `syncing` with no run behind them.
 */
async function drain(result: SyncRunResult): Promise<void> {
  // A tab closed mid-request leaves items stuck in `syncing`, which would
  // otherwise block the queue forever. Reclaiming does not spend an attempt.
  result.reclaimed = await reclaimStaleSyncing();

  if (browserIsOffline()) {
    // Do not spend attempts on a connection that is known to be absent. The
    // queue is untouched, so the counter the cashier sees stays accurate.
    result.skippedOffline = true;
    result.remaining = (await listQueue()).length;
    return;
  }

  // Two reads of the same store, and worth it: `dueItems` stays the single
  // definition of "ready to send", and the owners map has to see the whole
  // queue including items in backoff, which are exactly the parents a child
  // needs to be told to wait for.
  const due = await dueItems();
  const all = await listQueue();
  result.remaining = all.length;
  if (due.length === 0) return;

  // localId -> the item that will create it, so a child can be told which
  // parent it is waiting for and whether that parent is ever coming.
  const owners = new Map<string, QueueItem>();
  for (const item of all) {
    if (item.localId) owners.set(item.localId, item);
  }

  for (const item of due) {
    if (result.signedOut) break;

    const { payload, unresolved } = await resolveLocalIds(item.payload);

    if (unresolved.length > 0) {
      const outcome = await handleUnresolved(item, unresolved, owners);
      if (outcome.status === 'parked') result.parked += 1;
      else result.deferred += 1;

      result.failures.push({
        id: item.id,
        label: item.label,
        entity: item.entity,
        message: outcome.message,
        status: null,
        needsAttention: outcome.status === 'parked',
      });
      continue;
    }

    result.attempted += 1;
    await markSyncing(item.id);

    try {
      const response = await api.post<ServerEnvelope>(item.endpoint, payload, {
        clientRequestId: item.id,
      });

      await handleSuccess(item, response, result);
    } catch (error) {
      await handleFailure(item, error, result);
    }

    // Counted as the run goes rather than once at the end, so a run interrupted
    // by a storage failure still reports roughly where the queue stands.
    result.remaining = all.length - result.synced;
  }

  result.remaining = (await listQueue()).length;
}

/**
 * An item whose payload still contains a `local:` id.
 *
 * Three cases, and only the first is a wait:
 *   - the parent is still queued or retrying → defer, no attempt spent;
 *   - the parent is dead → the child will never resolve, so park it and name
 *     the parent rather than letting it loop for the rest of the day;
 *   - the parent is gone from the queue with no identity recorded → it was
 *     discarded, which is a decision somebody made, and the child has to be
 *     shown as depending on a record that was thrown away.
 */
async function handleUnresolved(
  item: QueueItem,
  unresolved: string[],
  owners: Map<string, QueueItem>
): Promise<{ status: 'deferred' | 'parked'; message: string }> {
  for (const localId of unresolved) {
    const owner = owners.get(localId);

    if (!owner) {
      const message =
        'This depends on a record that was discarded on this device, so it can never be saved. ' +
        'Re-enter it against the real record, or discard it.';
      await markRejected(item.id, message, null);
      return { status: 'parked', message };
    }

    // Re-read rather than trusting the snapshot taken before the loop: the
    // parent may have been parked moments ago by this same run, and telling the
    // cashier to "wait" for something that will never arrive is worse than
    // naming the problem.
    const current = (await getQueueItem(owner.id)) ?? owner;
    if (current.status === 'dead') {
      const message =
        `Waiting on "${current.label}", which could not be saved: ` +
        `${current.lastError || 'unknown reason'} Fix or discard that one first.`;
      await markRejected(item.id, message, null);
      return { status: 'parked', message };
    }
  }

  const message = 'Waiting for a record it depends on to sync first';
  await deferItem(item.id, message, DEFER_DELAY_MS);
  return { status: 'deferred', message };
}

export interface Caveat {
  kind: NoticeKind;
  message: string;
}

/**
 * What the server accepted but the pharmacy still has to look at.
 *
 * Pure, so the wording can be checked without a queue, a database or a network.
 * Each of these is a case where an offline sale could be stored perfectly and
 * still be wrong in a way only the server was in a position to see.
 */
export function describeCaveats(response: ServerEnvelope | null | undefined): Caveat[] {
  const caveats: Caveat[] = [];

  if (response?.duplicate) {
    caveats.push({
      kind: 'duplicate',
      message: 'Already recorded on the server — the duplicate replay was ignored.',
    });
  }

  const offline = response?.offline;

  if (offline?.totalMismatch) {
    const difference = Number(offline.difference ?? 0);
    caveats.push({
      kind: 'total_mismatch',
      message:
        `The till charged GHS ${Number(offline.quotedTotal ?? 0).toFixed(2)} but the server's figure is ` +
        `GHS ${difference >= 0 ? `${difference.toFixed(2)} less` : `GHS ${Math.abs(difference).toFixed(2)} more`}. ` +
        'The stored sale uses the server figure.',
    });
  }

  for (const warning of offline?.stockWarnings ?? []) {
    caveats.push({
      kind: 'stock_negative',
      message:
        `${warning.productName}: sold ${warning.sold} with only ${warning.available} on the system. ` +
        'Stock is now negative and needs a count.',
    });
  }

  for (const payment of offline?.unverifiedPayments ?? []) {
    caveats.push({
      kind: 'unverified_payment',
      message:
        `${payment.method.toUpperCase()} of GHS ${Number(payment.amount).toFixed(2)} was recorded offline and ` +
        'could not be confirmed with the payment provider. Reconcile it against the statement.',
    });
  }

  return caveats;
}

async function handleSuccess(
  item: QueueItem,
  response: ServerEnvelope,
  result: SyncRunResult
): Promise<void> {
  const serverId = response?.data?.id;

  // Record the mapping BEFORE removing the item: a crash in between leaves a
  // redundant identity, whereas the reverse order would leave dependents
  // pointing at a local id nothing can ever resolve.
  if (item.localId && typeof serverId === 'string' && serverId) {
    await rememberIdentity(item.localId, serverId);
  }

  const receipt = response?.data?.receipt_number;
  const label = receipt ? `${item.label} · ${receipt}` : item.label;

  const caveats = describeCaveats(response);
  for (const caveat of caveats) {
    result.warnings.push({ id: item.id, label, message: caveat.message });
  }

  // Also written to storage, before the item leaves the queue. The run's own
  // warnings reach only whoever happened to be watching when it finished, and
  // most runs finish in the background.
  if (caveats.length > 0) {
    try {
      await recordNotices(
        caveats.map((caveat) => ({ ...caveat, sourceId: item.id, label }))
      );
    } catch {
      // A notice that could not be stored must not turn a sale the server has
      // already committed into one that looks like it failed.
    }
  }

  await removeQueueItem(item.id);
  result.synced += 1;
}

async function handleFailure(
  item: QueueItem,
  error: unknown,
  result: SyncRunResult
): Promise<void> {
  const apiError = error instanceof ApiError ? error : null;
  const status = apiError?.status ?? null;
  const message = apiError?.message || (error as Error)?.message || 'Sync failed';

  // The session expired. Retrying would burn every item's budget against a 401
  // and park the whole queue; instead nothing is changed and the run stops, so
  // signing back in picks up exactly where it left off.
  if (status === 401) {
    result.signedOut = true;
    await deferItem(item.id, 'Signed out — sign back in to sync', DEFER_DELAY_MS);
    return;
  }

  if (apiError && !apiError.retryable) {
    await markRejected(item.id, message, status);
    result.parked += 1;
    result.failures.push({
      id: item.id,
      label: item.label,
      entity: item.entity,
      message,
      status,
      needsAttention: true,
    });
    return;
  }

  const updated = await markFailed(item.id, message, status);
  if (updated?.status === 'dead') {
    result.parked += 1;
    result.failures.push({
      id: item.id,
      label: item.label,
      entity: item.entity,
      message: updated.lastError || message,
      status,
      needsAttention: true,
    });
  } else {
    result.retrying += 1;
    result.failures.push({
      id: item.id,
      label: item.label,
      entity: item.entity,
      message,
      status,
      needsAttention: false,
    });
  }
}

/**
 * How many attempts an item has left before it needs a person. Exposed so the
 * review screen can say "2 attempts left" instead of a bare retry count.
 */
export function attemptsRemaining(item: QueueItem): number {
  return Math.max(MAX_ATTEMPTS - item.attempts, 0);
}

/** Guards a payload against being queued with an unresolved stand-in id that
 *  nothing will ever create — a caller bug, caught at the door. */
export function assertNoStrayLocalIds(payload: Record<string, unknown>): void {
  const found: string[] = [];

  const walk = (value: unknown): void => {
    if (typeof value === 'string') {
      if (isLocalId(value)) found.push(value);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }
    if (value && typeof value === 'object') {
      Object.values(value as Record<string, unknown>).forEach(walk);
    }
  };

  walk(payload);

  if (found.length > 0) {
    throw new Error(
      `Queued without a record to resolve ${found.join(', ')}. Pass the local id as the ` +
        "creating item's localId so dependents can be rewritten when it syncs."
    );
  }
}
