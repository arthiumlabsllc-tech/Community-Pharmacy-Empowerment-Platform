/**
 * What the offline banner is allowed to say.
 *
 * Split out from the component because the wording is the part that was wrong,
 * and checking it should not need a router, an icon set or a mounted hook.
 *
 * The previous banner said "Changes will sync when connection is restored"
 * whenever the browser reported no connection. That was untrue in the two
 * situations that matter most: with nothing queued there were no changes to sync,
 * and with a write the server had rejected there never would be — however long
 * the connection stayed up. A cashier who believes the second version goes home
 * thinking a paid sale is on its way to the books.
 */

export type BannerTone = 'warn' | 'danger';

export interface Banner {
  tone: BannerTone;
  text: string;
  href?: string;
  linkText?: string;
}

/** The queue facts the banner is allowed to talk about. */
export interface BannerInput {
  /** False until the queue has been read once. */
  ready: boolean;
  online: boolean;
  queued: number;
  syncing: number;
  dead: number;
  total: number;
  running: boolean;
  storageError: string | null;
}

function records(count: number): string {
  return `${count} record${count === 1 ? '' : 's'}`;
}

/**
 * Order matters here:
 *   - a storage failure outranks everything, because without storage nothing can
 *     be queued at all and any other statement would be misleading;
 *   - parked items outrank being offline, because they do not resolve themselves
 *     when the connection comes back;
 *   - "waiting to sync" while online is shown rather than hidden, because the
 *     alternative is a queue that stalls with nothing on screen to say so.
 */
export function resolveBanner(input: BannerInput): Banner | null {
  if (input.storageError) {
    return {
      tone: 'danger',
      text:
        'Offline storage is not working on this device, so nothing can be saved without a connection. ' +
        'This is usually private browsing or a full disk.',
    };
  }

  // Until the first read finishes, every count is a zero we invented.
  if (!input.ready) return null;

  if (input.dead > 0) {
    return {
      tone: 'danger',
      text: `${records(input.dead)} could not be sent to the server and ${
        input.dead === 1 ? 'needs' : 'need'
      } a person to look at ${input.dead === 1 ? 'it' : 'them'}.`,
      href: '/sync',
      linkText: 'Review',
    };
  }

  if (!input.online) {
    if (input.total === 0) {
      // No promise here on purpose: nothing is queued, so nothing will sync.
      return { tone: 'warn', text: 'You are offline.' };
    }

    return {
      tone: 'warn',
      text: `You are offline. ${records(input.total)} saved on this device, waiting for a connection.`,
      href: '/sync',
      linkText: 'View',
    };
  }

  if (input.queued > 0 && !input.running) {
    return {
      tone: 'warn',
      text: `${records(input.queued)} waiting to sync.`,
      href: '/sync',
      linkText: 'Sync now',
    };
  }

  return null;
}
