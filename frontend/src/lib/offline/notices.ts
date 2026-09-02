import { NOTICES_STORE, getAllRecords, putRecord, pruneTo } from './db';
import { newId } from './queue';

/**
 * What a successful sync still needs somebody to look at.
 *
 * A sale replayed from the offline queue can be stored perfectly and still be
 * wrong in a way only the server could see: the till charged a figure that
 * disagrees with the statutory one, the goods came off a shelf the system thought
 * was emptier, or a mobile money payment was taken on a phone network the
 * internet could not confirm. None of those is a failure, and none of them is
 * nothing.
 *
 * They are written to storage rather than only returned from the run, because
 * most runs happen in the background — on the `online` event, on a timer — with
 * nobody watching the screen. A warning held only in a component's state is a
 * warning that is gone by the time the owner opens the review page.
 */

export type NoticeKind =
  | 'duplicate'
  | 'total_mismatch'
  | 'stock_negative'
  | 'unverified_payment';

export interface SyncNotice {
  id: string;
  kind: NoticeKind;
  /** The queue item this came from. That item is gone by the time this is read. */
  sourceId: string;
  label: string;
  message: string;
  raisedAt: string;
  /** Set once dismissed. The notice is kept, because clearing it is a decision. */
  dismissedAt: string | null;
}

export interface NewNotice {
  kind: NoticeKind;
  sourceId: string;
  label: string;
  message: string;
}

/**
 * How many notices are kept.
 *
 * Dismissed ones are retained so an owner can see what was cleared and when, but
 * not forever: a busy pharmacy would otherwise accumulate a row per sale for the
 * life of the device, and this store shares its quota with the catalogue that
 * makes offline selling possible.
 */
const MAX_NOTICES = 200;

export async function recordNotices(notices: NewNotice[]): Promise<SyncNotice[]> {
  if (notices.length === 0) return [];

  const raisedAt = new Date().toISOString();
  const created = notices.map<SyncNotice>((notice) => ({
    id: newId(),
    kind: notice.kind,
    sourceId: notice.sourceId,
    label: notice.label,
    message: notice.message,
    raisedAt,
    dismissedAt: null,
  }));

  for (const notice of created) {
    await putRecord(NOTICES_STORE, notice.id, notice);
  }

  await pruneOldNotices();
  return created;
}

/** Keeps the newest `MAX_NOTICES`. Open notices are never among the ones dropped. */
async function pruneOldNotices(): Promise<number> {
  // Already newest-first.
  const all = await listNotices({ includeDismissed: true });
  if (all.length <= MAX_NOTICES) return 0;

  const open = all.filter((notice) => !notice.dismissedAt);
  const dismissed = all.filter((notice) => notice.dismissedAt);

  // Pruning exists to bound the store, not to make a problem go away, so the
  // allowance is spent on dismissed notices only — oldest of them first.
  const dismissedAllowed = Math.max(MAX_NOTICES - open.length, 0);
  const drop = dismissed.slice(dismissedAllowed);
  if (drop.length === 0) return 0;

  const dropIds = new Set(drop.map((notice) => notice.id));
  return pruneTo(
    NOTICES_STORE,
    all.filter((notice) => !dropIds.has(notice.id)).map((notice) => notice.id)
  );
}

export async function listNotices(
  options: { includeDismissed?: boolean } = {}
): Promise<SyncNotice[]> {
  const all = await getAllRecords<SyncNotice>(NOTICES_STORE);
  const relevant = options.includeDismissed ? all : all.filter((notice) => !notice.dismissedAt);
  return relevant.sort((a, b) => b.raisedAt.localeCompare(a.raisedAt));
}

export async function countOpenNotices(): Promise<number> {
  const all = await getAllRecords<SyncNotice>(NOTICES_STORE);
  return all.filter((notice) => !notice.dismissedAt).length;
}

/**
 * Clears a notice from the list without deleting it.
 *
 * Dismissing says "somebody has seen this and dealt with it", which is different
 * from it never having happened — and in a pharmacy the difference between a
 * stock discrepancy that was investigated and one that quietly disappeared is the
 * whole audit trail.
 */
export async function dismissNotice(id: string): Promise<SyncNotice | undefined> {
  const all = await getAllRecords<SyncNotice>(NOTICES_STORE);
  const notice = all.find((entry) => entry.id === id);
  if (!notice) return undefined;

  const dismissed: SyncNotice = { ...notice, dismissedAt: new Date().toISOString() };
  await putRecord(NOTICES_STORE, dismissed.id, dismissed);
  return dismissed;
}

export async function dismissAllNotices(): Promise<number> {
  const open = await listNotices();
  const dismissedAt = new Date().toISOString();

  for (const notice of open) {
    await putRecord(NOTICES_STORE, notice.id, { ...notice, dismissedAt });
  }
  return open.length;
}
