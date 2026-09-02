import {
  DISCARD_STORE,
  IDENTITIES_STORE,
  QUEUE_STORE,
  deleteRecord,
  getAllRecords,
  getRecord,
  putRecord,
} from './db';
import { requestBackgroundSync } from './background-sync';

/**
 * The offline write queue.
 *
 * ONE RULE governs the whole file: nothing leaves the queue except by syncing
 * successfully or by a person explicitly discarding it on the review screen.
 * The previous implementation deleted an item after three failed attempts,
 * which meant a sale a cashier had rung up and a customer had paid for could
 * vanish from the device with no trace and no error — the worst possible
 * outcome for a pharmacy, because the money is in the drawer and the record is
 * nowhere.
 *
 * So a failed item is retried with backoff, and once it runs out of attempts it
 * becomes `dead`: still stored, still counted, still shown, and only clearable
 * by a human decision that is itself recorded.
 */

export type QueueEntity = 'sale' | 'patient' | 'screening' | 'inventory';

/** `queued` waits for a connection; `syncing` is in flight; `dead` needs a person. */
export type QueueStatus = 'queued' | 'syncing' | 'dead';

export interface QueueItem {
  /** Also sent as X-Client-Request-Id, so a replay cannot duplicate the write. */
  id: string;
  entity: QueueEntity;
  /** Path under /api, e.g. '/pos/sales'. Replayed against the real endpoint. */
  endpoint: string;
  method: 'POST';
  payload: Record<string, unknown>;
  /** One line for the review screen: "Sale · GHS 42.00 · 3 items". */
  label: string;
  /**
   * The stand-in id this item creates, when other queued items will reference
   * the record. A patient registered offline gets `local:<uuid>`; the screening
   * recorded against them carries that string until the patient syncs.
   */
  localId: string | null;
  status: QueueStatus;
  attempts: number;
  /** When it was queued. */
  createdAt: string;
  /**
   * When the thing actually happened, on the device's clock. Sent to the server
   * as client_recorded_at so a sale queued at 17:00 and synced next morning
   * still lands on the right trading day.
   */
  recordedAt: string;
  /** Null means "try as soon as there is a connection". */
  nextAttemptAt: string | null;
  lastError: string | null;
  lastHttpStatus: number | null;
}

/** What was thrown away, and by whom, kept after the queue item is gone. */
export interface DiscardedItem {
  id: string;
  entity: QueueEntity;
  label: string;
  payload: Record<string, unknown>;
  attempts: number;
  lastError: string | null;
  lastHttpStatus: number | null;
  createdAt: string;
  recordedAt: string;
  discardedAt: string;
  discardReason: string;
}

export const LOCAL_PREFIX = 'local:';

/**
 * Attempts before an item goes dead.
 *
 * Five is enough to ride out a flaky mobile connection — the common case in
 * Ghana, where signal returns for a moment and drops again — without leaving a
 * genuinely rejected write retrying all day. A 4xx is not retried at all, so
 * this budget is spent only on transport failures and 5xx.
 */
export const MAX_ATTEMPTS = 5;

const BASE_BACKOFF_MS = 30_000;
const MAX_BACKOFF_MS = 600_000;

/** A fresh id. crypto.randomUUID is present in every browser that has the
 *  service-worker support this feature already requires. */
export function newId(): string {
  const cryptoRef = typeof crypto !== 'undefined' ? crypto : undefined;
  if (cryptoRef && typeof cryptoRef.randomUUID === 'function') return cryptoRef.randomUUID();

  // Fallback for an older engine. Not used for anything security-bearing: the
  // id only has to be unique per device so replays can be matched.
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (character) => {
    const random = Math.floor(Math.random() * 16);
    const value = character === 'x' ? random : (random & 0x3) | 0x8;
    return value.toString(16);
  });
}

/** A stand-in id for a record that does not exist on the server yet. */
export function newLocalId(): string {
  return `${LOCAL_PREFIX}${newId()}`;
}

export function isLocalId(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(LOCAL_PREFIX);
}

export function backoffFor(attempts: number): number {
  const exponent = Math.max(Math.min(attempts - 1, 10), 0);
  return Math.min(BASE_BACKOFF_MS * 2 ** exponent, MAX_BACKOFF_MS);
}

// ---------------------------------------------------------------------------
// Change notification
// ---------------------------------------------------------------------------

type Listener = () => void;

const listeners = new Set<Listener>();

/**
 * Tells the UI the queue moved.
 *
 * In-process only, and that is a deliberate limit worth stating: a second tab
 * will not hear about a sale queued in the first until it reloads or its own
 * sync run reads the store. BroadcastChannel would close that gap, but a till
 * is one screen, and pretending to cross-tab consistency that is not there is
 * worse than not offering it.
 */
export function subscribeToQueue(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function notify(): void {
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch {
      // A broken subscriber must not stop the queue from working.
    }
  }
}

/**
 * What a caller supplies. Everything else is filled in by `enqueue`: the id,
 * the status, the attempt count, the timestamps and the method, which is always
 * POST because the queue only ever creates records.
 */
export type NewQueueItem = Pick<QueueItem, 'entity' | 'endpoint' | 'payload' | 'label'> &
  Partial<Pick<QueueItem, 'id' | 'localId' | 'recordedAt'>>;

/**
 * Adds a write to the queue.
 *
 * The id defaults to a fresh one, and a caller should leave it that way unless
 * reuse is the whole point: two writes queued under one id are one write as far
 * as the server's idempotency check is concerned, so an id reused by accident
 * silently swallows the second record. `queueOfflineSale` does reuse one on
 * purpose — the basket's own id — so a sale the server already created but whose
 * response was lost comes back as that sale rather than as a duplicate.
 */
export async function enqueue(item: NewQueueItem): Promise<QueueItem> {
  const now = new Date().toISOString();
  const record: QueueItem = {
    id: item.id ?? newId(),
    entity: item.entity,
    endpoint: item.endpoint,
    method: 'POST',
    payload: item.payload,
    label: item.label,
    localId: item.localId ?? null,
    status: 'queued',
    attempts: 0,
    createdAt: now,
    recordedAt: item.recordedAt ?? now,
    nextAttemptAt: null,
    lastError: null,
    lastHttpStatus: null,
  };

  await putRecord(QUEUE_STORE, record.id, record);
  notify();

  // Asked after the write rather than before. The record is safely stored by
  // now, so a browser that refuses the request — or has no Background Sync at
  // all, which is every browser but Chromium — costs nothing but the retry, and
  // the scheduler still drains the queue the next time a page is open.
  void requestBackgroundSync();

  return record;
}

export async function getQueueItem(id: string): Promise<QueueItem | undefined> {
  return getRecord<QueueItem>(QUEUE_STORE, id);
}

/** Everything still waiting, oldest first, dead items last. */
export async function listQueue(): Promise<QueueItem[]> {
  const items = await getAllRecords<QueueItem>(QUEUE_STORE);
  const rank: Record<QueueStatus, number> = { queued: 0, syncing: 1, dead: 2 };

  return items.sort((a, b) => {
    if (a.status !== b.status) return rank[a.status] - rank[b.status];
    return a.recordedAt.localeCompare(b.recordedAt) || a.createdAt.localeCompare(b.createdAt);
  });
}

export async function queueCounts(): Promise<{ queued: number; syncing: number; dead: number; total: number }> {
  const items = await getAllRecords<QueueItem>(QUEUE_STORE);
  const counts = { queued: 0, syncing: 0, dead: 0, total: items.length };
  for (const item of items) counts[item.status] += 1;
  return counts;
}

/** Queued items whose backoff has elapsed. `syncing` items are skipped: they
 *  belong to a run that is still in flight, or to a tab that was closed mid
 *  request — and reclaiming those is `reclaimStaleSyncing`'s job, not this one. */
export async function dueItems(now = new Date()): Promise<QueueItem[]> {
  const items = await listQueue();
  const timestamp = now.toISOString();

  return items.filter(
    (item) => item.status === 'queued' && (!item.nextAttemptAt || item.nextAttemptAt <= timestamp)
  );
}

export async function saveQueueItem(item: QueueItem): Promise<void> {
  await putRecord(QUEUE_STORE, item.id, item);
  notify();
}

export async function markSyncing(id: string): Promise<void> {
  const item = await getQueueItem(id);
  if (!item) return;
  await saveQueueItem({ ...item, status: 'syncing' });
}

/**
 * Pushes an item back without spending a retry.
 *
 * Used when the item is not wrong, it is merely waiting: its parent record has
 * not synced yet, or the user has signed out. Counting those as attempts would
 * push a perfectly good sale towards the dead pile because of somebody else's
 * ordering.
 */
export async function deferItem(id: string, reason: string, delayMs: number): Promise<void> {
  const item = await getQueueItem(id);
  if (!item) return;

  await saveQueueItem({
    ...item,
    status: 'queued',
    nextAttemptAt: new Date(Date.now() + delayMs).toISOString(),
    lastError: reason,
  });
}

/**
 * Parks an item the server has definitively rejected.
 *
 * A 400 or a 422 is not going to get better on the fourth attempt, and burning
 * the whole backoff schedule before showing it would leave the cashier looking
 * at a queue that appears to be working. It goes straight to dead with the
 * server's own words attached.
 */
export async function markRejected(
  id: string,
  message: string,
  httpStatus: number | null
): Promise<QueueItem | undefined> {
  const item = await getQueueItem(id);
  if (!item) return undefined;

  const updated: QueueItem = {
    ...item,
    status: 'dead',
    nextAttemptAt: null,
    lastHttpStatus: httpStatus,
    lastError: message,
  };

  await saveQueueItem(updated);
  return updated;
}

/**
 * Records a failure. Retries with backoff until the budget is spent, then marks
 * the item dead — it is never removed here.
 */
export async function markFailed(
  id: string,
  error: string,
  httpStatus: number | null
): Promise<QueueItem | undefined> {
  const item = await getQueueItem(id);
  if (!item) return undefined;

  const attempts = item.attempts + 1;
  const dead = attempts >= MAX_ATTEMPTS;

  const updated: QueueItem = {
    ...item,
    attempts,
    status: dead ? 'dead' : 'queued',
    nextAttemptAt: dead
      ? null
      : new Date(Date.now() + backoffFor(attempts)).toISOString(),
    lastError: dead
      ? `${error} — gave up after ${attempts} attempts. It is still here; retry or discard it.`
      : error,
    lastHttpStatus: httpStatus,
  };

  await saveQueueItem(updated);
  return updated;
}

/**
 * Gives a dead item another full budget. Used by the review screen's Retry
 * button, after whoever is looking at it has fixed whatever the server objected
 * to — classified the product, corrected the patient's details, counted the
 * stock.
 */
export async function retryItem(id: string): Promise<QueueItem | undefined> {
  const item = await getQueueItem(id);
  if (!item) return undefined;

  const updated: QueueItem = {
    ...item,
    status: 'queued',
    attempts: 0,
    nextAttemptAt: null,
    lastError: null,
    lastHttpStatus: null,
  };

  await saveQueueItem(updated);
  return updated;
}

/**
 * The only deletion path, and it leaves a record behind.
 *
 * `reason` is required rather than optional: a discard that is not explained is
 * indistinguishable from a bug that lost the data, and the whole point of the
 * review screen is that the two can be told apart.
 */
export async function discardItem(id: string, reason: string): Promise<DiscardedItem | null> {
  const item = await getQueueItem(id);
  if (!item) return null;

  const discarded: DiscardedItem = {
    id: item.id,
    entity: item.entity,
    label: item.label,
    payload: item.payload,
    attempts: item.attempts,
    lastError: item.lastError,
    lastHttpStatus: item.lastHttpStatus,
    createdAt: item.createdAt,
    recordedAt: item.recordedAt,
    discardedAt: new Date().toISOString(),
    discardReason: reason.trim() || 'No reason given',
  };

  await putRecord(DISCARD_STORE, discarded.id, discarded);
  await deleteRecord(QUEUE_STORE, id);
  notify();
  return discarded;
}

export async function listDiscarded(): Promise<DiscardedItem[]> {
  const items = await getAllRecords<DiscardedItem>(DISCARD_STORE);
  return items.sort((a, b) => b.discardedAt.localeCompare(a.discardedAt));
}

/** Called after a successful sync. */
export async function removeQueueItem(id: string): Promise<void> {
  await deleteRecord(QUEUE_STORE, id);
  notify();
}

/**
 * A tab closed mid-request leaves an item stuck in `syncing` forever, which
 * would silently hold up everything behind it. On start-up any such item goes
 * back to `queued` WITHOUT spending an attempt: the server's idempotency key
 * makes resending it safe, so a crash is not the device's fault and should not
 * eat into the retry budget.
 */
export async function reclaimStaleSyncing(): Promise<number> {
  const items = await getAllRecords<QueueItem>(QUEUE_STORE);
  const stale = items.filter((item) => item.status === 'syncing');

  for (const item of stale) {
    await saveQueueItem({ ...item, status: 'queued', nextAttemptAt: null });
  }
  return stale.length;
}

/**
 * The connection came back, so every backoff timer is stale: it was set to
 * avoid hammering a server that was up and failing, which is no longer the
 * situation. Dead items are left alone — they need a person, not a network.
 */
export async function wakeQueue(): Promise<number> {
  const items = await getAllRecords<QueueItem>(QUEUE_STORE);
  const waiting = items.filter((item) => item.status === 'queued' && item.nextAttemptAt !== null);

  for (const item of waiting) {
    await saveQueueItem({ ...item, nextAttemptAt: null });
  }
  return waiting.length;
}

// ---------------------------------------------------------------------------
// Local id resolution
// ---------------------------------------------------------------------------

/**
 * Records what a stand-in id turned out to be.
 *
 * Written before the queue item is removed, so a crash between the two leaves a
 * mapping that is merely redundant rather than a dependent item pointing at a
 * local id nothing can ever resolve.
 */
export async function rememberIdentity(localId: string, serverId: string): Promise<void> {
  if (!isLocalId(localId)) return;
  await putRecord(IDENTITIES_STORE, localId, serverId);
}

export async function resolveIdentity(localId: string): Promise<string | undefined> {
  return getRecord<string>(IDENTITIES_STORE, localId);
}

export interface ResolvedPayload {
  payload: Record<string, unknown>;
  /** Local ids with no server id yet — the parent has not synced. */
  unresolved: string[];
}

/**
 * Rewrites every `local:<uuid>` in a payload to the server id it maps to.
 *
 * This is what lets a screening recorded offline against a patient registered
 * offline arrive at the server in the right order and pointing at a real row.
 * Anything still unresolved is reported rather than sent: posting `local:...`
 * as a patient_id would be rejected as an invalid UUID, and the rejection would
 * look like a bug in the screening rather than what it is — a parent that has
 * not synced yet.
 */
export async function resolveLocalIds(
  payload: Record<string, unknown>
): Promise<ResolvedPayload> {
  const unresolved = new Set<string>();

  const walk = async (value: unknown): Promise<unknown> => {
    if (typeof value === 'string') {
      if (!isLocalId(value)) return value;
      const mapped = await resolveIdentity(value);
      if (mapped) return mapped;
      unresolved.add(value);
      return value;
    }

    if (Array.isArray(value)) {
      const out: unknown[] = [];
      for (const entry of value) out.push(await walk(entry));
      return out;
    }

    if (value && typeof value === 'object' && value.constructor === Object) {
      const out: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
        out[key] = await walk(entry);
      }
      return out;
    }

    return value;
  };

  const resolved = (await walk(payload)) as Record<string, unknown>;
  return { payload: resolved, unresolved: [...unresolved] };
}

/** True when a payload still references a record that has not synced. */
export async function hasUnresolvedDependencies(payload: Record<string, unknown>): Promise<boolean> {
  const { unresolved } = await resolveLocalIds(payload);
  return unresolved.length > 0;
}
