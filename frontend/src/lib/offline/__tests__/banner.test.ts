import { resolveBanner, type BannerInput } from '../banner';

/**
 * The wording of the offline banner.
 *
 * These are tests about sentences rather than code, which is unusual, but the
 * sentence is the feature: the banner is the only thing standing between a
 * cashier and the belief that a sale which will never reach the server is safely
 * on its way. The old one said "Changes will sync when connection is restored"
 * unconditionally, and that is what is being pinned down here.
 */

function state(overrides: Partial<BannerInput> = {}): BannerInput {
  return {
    ready: true,
    online: true,
    queued: 0,
    syncing: 0,
    dead: 0,
    total: 0,
    running: false,
    storageError: null,
    ...overrides,
  };
}

describe('when there is nothing to say', () => {
  it('says nothing while online with an empty queue', () => {
    expect(resolveBanner(state())).toBeNull();
  });

  it('says nothing before the queue has been read, rather than reporting an invented zero', () => {
    expect(resolveBanner(state({ ready: false, online: false }))).toBeNull();
  });

  it('says nothing while a run is in flight, because the queue is being dealt with', () => {
    expect(resolveBanner(state({ queued: 3, total: 3, running: true }))).toBeNull();
  });
});

describe('when the connection is down', () => {
  it('says so without promising a sync there is nothing to do', () => {
    const banner = resolveBanner(state({ online: false }));

    expect(banner).toEqual({ tone: 'warn', text: 'You are offline.' });
    expect(banner!.text).not.toMatch(/will sync/i);
    expect(banner!.href).toBeUndefined();
  });

  it('counts what has been saved, and offers a way to look at it', () => {
    const banner = resolveBanner(state({ online: false, queued: 4, total: 4 }));

    expect(banner!.tone).toBe('warn');
    expect(banner!.text).toBe(
      'You are offline. 4 records saved on this device, waiting for a connection.'
    );
    expect(banner).toMatchObject({ href: '/sync', linkText: 'View' });
  });

  it('counts items in flight as saved, because they are still on the device', () => {
    const banner = resolveBanner(state({ online: false, queued: 1, syncing: 2, total: 3 }));

    expect(banner!.text).toContain('3 records saved on this device');
  });

  it('singular for one', () => {
    expect(resolveBanner(state({ online: false, queued: 1, total: 1 }))!.text).toContain('1 record saved');
  });
});

describe('when something needs a person', () => {
  it('says a parked write could not be sent, which is not the same as waiting', () => {
    const banner = resolveBanner(state({ dead: 1, total: 1 }));

    expect(banner!.tone).toBe('danger');
    expect(banner!.text).toBe(
      '1 record could not be sent to the server and needs a person to look at it.'
    );
    expect(banner).toMatchObject({ href: '/sync', linkText: 'Review' });
  });

  it('pluralises both halves', () => {
    expect(resolveBanner(state({ dead: 3, total: 3 }))!.text).toBe(
      '3 records could not be sent to the server and need a person to look at them.'
    );
  });

  it('outranks being offline, because a parked write does not fix itself when the connection returns', () => {
    const banner = resolveBanner(state({ online: false, dead: 2, queued: 5, total: 7 }));

    expect(banner!.tone).toBe('danger');
    expect(banner!.text).toContain('could not be sent to the server');
    expect(banner!.text).not.toContain('You are offline');
  });

  it('outranks a queue that is merely waiting', () => {
    const banner = resolveBanner(state({ dead: 1, queued: 4, total: 5 }));

    expect(banner!.tone).toBe('danger');
    expect(banner!.text).not.toContain('waiting to sync');
  });
});

describe('when offline storage itself is broken', () => {
  it('says so, because nothing can be queued at all', () => {
    const banner = resolveBanner(state({ storageError: 'This browser has no IndexedDB' }));

    expect(banner!.tone).toBe('danger');
    expect(banner!.text).toContain('Offline storage is not working');
    expect(banner!.text).toContain('nothing can be saved without a connection');
  });

  it('outranks everything else, including a parked write it could never have stored', () => {
    const banner = resolveBanner(
      state({ storageError: 'Quota exceeded', dead: 2, online: false, total: 2 })
    );

    expect(banner!.text).toContain('Offline storage is not working');
  });
});

describe('when online but work is still sitting there', () => {
  it('is shown rather than left invisible, with a way to push it', () => {
    const banner = resolveBanner(state({ queued: 2, total: 2 }));

    expect(banner!.tone).toBe('warn');
    expect(banner!.text).toBe('2 records waiting to sync.');
    expect(banner).toMatchObject({ href: '/sync', linkText: 'Sync now' });
  });
});

describe('every link it offers', () => {
  it('goes to the review page, which is the only place a queued write can be acted on', () => {
    const banners = [
      resolveBanner(state({ dead: 1, total: 1 })),
      resolveBanner(state({ online: false, queued: 1, total: 1 })),
      resolveBanner(state({ queued: 1, total: 1 })),
    ];

    for (const banner of banners) {
      expect(banner!.href).toBe('/sync');
      expect(banner!.linkText).toBeTruthy();
    }
  });

  it('offers no link when there is nothing to do about it', () => {
    expect(resolveBanner(state({ online: false }))!.href).toBeUndefined();
    expect(resolveBanner(state({ storageError: 'no storage' }))!.href).toBeUndefined();
  });
});
