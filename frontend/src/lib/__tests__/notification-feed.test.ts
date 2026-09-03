import {
  DERIVED_PER_GROUP,
  EXPIRING_WINDOW_DAYS,
  FEED_LIMIT,
  countByGroup,
  deriveExpiringAlerts,
  deriveLowStockAlerts,
  kindsForPreferences,
  kindsParam,
  toBellAlert,
  toBellAlerts,
  type BellAlert,
  type InventoryRow,
  type PersistedNotification,
} from '../notification-feed';

/**
 * The bell's two sources, and the mapping between them.
 *
 * Nothing here touches the network, which is the point: the failures worth
 * pinning are the ones that produce a bell that looks correct. Asking the API
 * for `low-stock` instead of `low_stock` is a 400 and an empty dropdown;
 * grouping an expired lot under the reorder icon tells the pharmacist to order
 * stock that has to be quarantined. Both render fine and both are wrong.
 */

const BOTH_ON = { low_stock_alerts: true, expiring_alerts: true };
const BOTH_OFF = { low_stock_alerts: false, expiring_alerts: false };

function notification(overrides: Partial<PersistedNotification> = {}): PersistedNotification {
  return {
    id: 'n-1',
    title: 'Low stock',
    message: 'Paracetamol 500mg fell to 12 — its reorder level is 20.',
    metadata: {
      inventory_id: 'inv-1',
      product_name: 'Paracetamol 500mg',
      quantity: 12,
      reorder_level: 20,
      batch_number: null,
      expiry_date: null,
      days_to_expiry: null,
      href: '/inventory',
    },
    dedupe_key: 'low_stock:inv-1',
    dedupe_kind: 'low_stock',
    created_at: '2026-04-15T09:00:00.000Z',
    read_at: null,
    ...overrides,
  };
}

function inventoryRow(overrides: Partial<InventoryRow> = {}): InventoryRow {
  return {
    id: 'inv-1',
    product_name: 'Paracetamol 500mg',
    batch_number: null,
    quantity: 12,
    reorder_level: 20,
    expiry_date: null,
    ...overrides,
  };
}

/**
 * Formats one date in an explicit zone.
 *
 * Explicit rather than `process.env.TZ`, which does not reach ICU from inside a
 * jest sandbox: the assignment succeeds, the cached zone does not change, and a
 * test built on it passes for a reason it cannot explain. Both zones below are
 * named in the call, so the assertions hold on any machine this suite runs on.
 */
function formatDateIn(timeZone: string, value = '2026-06-01'): string {
  return new Date(value).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone,
  });
}

describe('kindsForPreferences', () => {
  it('asks for all four kinds when both preferences are on', () => {
    expect(kindsForPreferences(BOTH_ON)).toEqual([
      'out_of_stock',
      'low_stock',
      'expired_stock',
      'expiring',
    ]);
  });

  it('asks for the shelf kinds behind the low-stock toggle', () => {
    expect(kindsForPreferences({ low_stock_alerts: true, expiring_alerts: false })).toEqual([
      'out_of_stock',
      'low_stock',
    ]);
  });

  it('asks for the dated kinds behind the expiry toggle', () => {
    expect(kindsForPreferences({ low_stock_alerts: false, expiring_alerts: true })).toEqual([
      'expired_stock',
      'expiring',
    ]);
  });

  it('asks for nothing when both are off, rather than for everything', () => {
    // The caller uses the empty list to skip the request. Sending it would mean
    // "no narrowing" to the API, which is the opposite of what Settings says.
    expect(kindsForPreferences(BOTH_OFF)).toEqual([]);
  });

  it('spells every kind with underscores, which is what the API accepts', () => {
    // The bell's own group names are hyphenated ('low-stock') and sit one call
    // away. A hyphen reaching the query string is a 400 and an empty bell.
    for (const kind of kindsForPreferences(BOTH_ON)) {
      expect(kind).not.toContain('-');
      expect(kind).toMatch(/^[a-z][a-z_]*$/);
    }
  });
});

describe('kindsParam', () => {
  it('joins the kinds the way the API splits them', () => {
    expect(kindsParam(['out_of_stock', 'low_stock'])).toBe('out_of_stock,low_stock');
  });

  it('is null for no kinds, so the caller skips the request instead of sending kinds=', () => {
    expect(kindsParam([])).toBeNull();
  });
});

describe('toBellAlert', () => {
  it('takes the product from the metadata and the condition from the title', () => {
    // The stored title is the condition ('Low stock'), not the product — the
    // inverse of what the derived rows carry. Reading them the same way round
    // would give every row in the bell the same name.
    const alert = toBellAlert(notification())!;
    expect(alert.title).toBe('Paracetamol 500mg');
    expect(alert.label).toBe('Low stock');
    expect(alert.detail).toBe('Paracetamol 500mg fell to 12 — its reorder level is 20.');
  });

  it('groups the two shelf kinds under one icon and the two dated kinds under the other', () => {
    const groupOf = (kind: PersistedNotification['dedupe_kind']) =>
      toBellAlert(notification({ dedupe_kind: kind }))!.group;

    expect(groupOf('out_of_stock')).toBe('low-stock');
    expect(groupOf('low_stock')).toBe('low-stock');
    expect(groupOf('expired_stock')).toBe('expiring');
    expect(groupOf('expiring')).toBe('expiring');
  });

  it('keeps an expired lot out of the reorder group', () => {
    // The action is different: an expiry is quarantined and written off, a
    // shortage is ordered. Same icon for both would say "order more" about stock
    // that has to be destroyed.
    expect(toBellAlert(notification({ dedupe_kind: 'expired_stock' }))!.group).toBe('expiring');
  });

  it('reads a null read_at as unread', () => {
    expect(toBellAlert(notification({ read_at: null }))!.unread).toBe(true);
  });

  it('reads a stamped read_at as read', () => {
    expect(toBellAlert(notification({ read_at: '2026-04-15T10:00:00.000Z' }))!.unread).toBe(false);
  });

  it('reads an absent read_at as unread, since the column can arrive missing', () => {
    // The type says `string | null`, but a row selected without the column would
    // arrive with the key absent, and `undefined === null` is false — which would
    // mark every alert as already read and hide the dots permanently.
    const row = notification() as { read_at?: string | null };
    delete row.read_at;
    expect(toBellAlert(row as PersistedNotification)!.unread).toBe(true);
  });

  it('uses the href the writer chose, and falls back to inventory', () => {
    expect(toBellAlert(notification())!.href).toBe('/inventory');
    expect(
      toBellAlert(notification({ metadata: { href: '/inventory?expiring=1' } }))!.href
    ).toBe('/inventory?expiring=1');
    expect(toBellAlert(notification({ metadata: {} }))!.href).toBe('/inventory');
  });

  it('falls back to the stored title when the metadata has no product name', () => {
    // A row written by an older version of the writer still has to render. A
    // blank title in a list of problems is a row the pharmacist cannot act on.
    expect(toBellAlert(notification({ metadata: null }))!.title).toBe('Low stock');
    expect(toBellAlert(notification({ metadata: { product_name: '   ' } }))!.title).toBe('Low stock');
  });

  it('is null for a kind the bell does not own', () => {
    // The API will happily return one: the reader is not hardcoded to the four
    // stock kinds, because the claims feature writes into the same table. The
    // bell drops it rather than borrow an icon — a claim rejection drawn as a
    // stock problem sends somebody to the shelf.
    expect(toBellAlert(notification({ dedupe_kind: 'claim_rejected' }))).toBeNull();
    expect(toBellAlert(notification({ dedupe_kind: null }))).toBeNull();
  });
});

describe('toBellAlerts', () => {
  it('keeps the order the server sent', () => {
    // The server orders newest first with an id tiebreak, precisely so the list
    // does not reshuffle between opens. Sorting again here would undo it.
    const rows = [
      notification({ id: 'n-3', dedupe_kind: 'expiring' }),
      notification({ id: 'n-1' }),
      notification({ id: 'n-2', dedupe_kind: 'out_of_stock' }),
    ];
    expect(toBellAlerts(rows).map((alert) => alert.id)).toEqual(['n-3', 'n-1', 'n-2']);
  });

  it('drops the kinds it cannot draw and keeps the rest', () => {
    const rows = [
      notification({ id: 'n-1' }),
      notification({ id: 'n-2', dedupe_kind: 'claim_rejected' }),
      notification({ id: 'n-3', dedupe_kind: 'expiring' }),
    ];
    expect(toBellAlerts(rows).map((alert) => alert.id)).toEqual(['n-1', 'n-3']);
  });

  it('maps an empty feed to an empty list, not to a null the caller has to guard', () => {
    expect(toBellAlerts([])).toEqual([]);
  });
});

describe('deriveLowStockAlerts', () => {
  it('names the condition once, so a row at zero does not repeat itself', () => {
    const alert = deriveLowStockAlerts([inventoryRow({ quantity: 0 })])[0];
    expect(alert.label).toBe('Out of stock');
    expect(alert.detail).toBe('Reorder at 20');
  });

  it('shows the quantity and the reorder level while there is still stock', () => {
    const alert = deriveLowStockAlerts([inventoryRow({ quantity: 12, reorder_level: 20 })])[0];
    expect(alert.label).toBe('Low stock');
    expect(alert.detail).toBe('12 left · reorder at 20');
  });

  it('caps the group, so one long list cannot push the other off the bell', () => {
    const rows = Array.from({ length: DERIVED_PER_GROUP + 3 }, (_, index) =>
      inventoryRow({ id: `inv-${index}` })
    );
    expect(deriveLowStockAlerts(rows)).toHaveLength(DERIVED_PER_GROUP);
  });

  it('never claims a derived row is unread, because nothing stamps it', () => {
    // The derived path has no row to write `read_at` to. Marking everything
    // "new" forever would be a dot the pharmacist cannot clear.
    expect(deriveLowStockAlerts([inventoryRow()])[0].unread).toBe(false);
  });

  it('prefixes the id, so a derived row cannot collide with a stored one', () => {
    expect(deriveLowStockAlerts([inventoryRow({ id: 'inv-1' })])[0].id).toBe('low-inv-1');
  });
});

describe('deriveExpiringAlerts', () => {
  it('reads the expiry date in UTC, which is the date on the packet', () => {
    const detail = deriveExpiringAlerts([inventoryRow({ expiry_date: '2026-06-01' })])[0].detail;
    expect(detail).toBe(`Expires ${formatDateIn('UTC')}`);
  });

  it('is not the day before, which is what a machine west of Greenwich would show', () => {
    // Pins the bug beside the fix. `new Date('2026-06-01')` is midnight UTC, so
    // formatted in local time it is still 1 June in Accra and already 31 May in
    // New York — the day before the date on the packet, on an alert whose entire
    // subject is that date. Dropping timeZone: 'UTC' from the module fails here
    // for a reason the next reader can see, whatever zone they are in.
    expect(formatDateIn('America/New_York')).toBe('31 May 2026');
    expect(formatDateIn('UTC')).toBe('1 Jun 2026');
    expect(formatDateIn('Africa/Accra')).toBe('1 Jun 2026');
  });

  it('asks for UTC explicitly, so the machine zone cannot pick the day', () => {
    // The two tests above only catch a regression west of Greenwich: at UTC+0
    // local and UTC formatting agree, and a module that had dropped
    // timeZone: 'UTC' would still pass both. This pins the mechanism instead, and
    // holds on any machine the suite runs on.
    const spy = jest.spyOn(Date.prototype, 'toLocaleDateString');
    deriveExpiringAlerts([inventoryRow({ expiry_date: '2026-06-01' })]);
    const zones = spy.mock.calls.map(
      (call) => (call[1] as Intl.DateTimeFormatOptions | undefined)?.timeZone
    );
    spy.mockRestore();

    expect(zones.length).toBeGreaterThan(0);
    expect(new Set(zones)).toEqual(new Set(['UTC']));
  });

  it('names the lot beside the date when there is one', () => {
    const alert = deriveExpiringAlerts([
      inventoryRow({ expiry_date: '2026-06-01', batch_number: 'B-4471' }),
    ])[0];
    expect(alert.detail).toBe('Expires 1 Jun 2026 · batch B-4471');
  });

  it('says something when the row has no date at all', () => {
    const alert = deriveExpiringAlerts([inventoryRow({ expiry_date: null })])[0];
    expect(alert.detail).toBe(`Expiring within ${EXPIRING_WINDOW_DAYS} days`);
  });

  it('leaves a date it cannot parse alone rather than rendering Invalid Date', () => {
    expect(deriveExpiringAlerts([inventoryRow({ expiry_date: 'not a date' })])[0].detail).toContain(
      'not a date'
    );
  });

  it('caps the group', () => {
    const rows = Array.from({ length: DERIVED_PER_GROUP + 3 }, (_, index) =>
      inventoryRow({ id: `inv-${index}`, expiry_date: '2026-06-01' })
    );
    expect(deriveExpiringAlerts(rows)).toHaveLength(DERIVED_PER_GROUP);
  });
});

describe('countByGroup', () => {
  it('counts both groups, including the ones with nothing in them', () => {
    const alerts: BellAlert[] = [
      ...deriveLowStockAlerts([inventoryRow({ id: 'a' }), inventoryRow({ id: 'b' })]),
      ...deriveExpiringAlerts([inventoryRow({ id: 'c', expiry_date: '2026-06-01' })]),
    ];
    // The footer renders each group only when it is non-zero, so a missing key
    // would read as undefined rather than as zero and drop the separator with it.
    expect(countByGroup(alerts)).toEqual({ 'low-stock': 2, expiring: 1 });
  });

  it('answers zero for an empty list', () => {
    expect(countByGroup([])).toEqual({ 'low-stock': 0, expiring: 0 });
  });

  it('does not mutate the list it counts', () => {
    const alerts = deriveLowStockAlerts([inventoryRow()]);
    countByGroup(alerts);
    expect(alerts).toHaveLength(1);
  });
});

describe('the feed limit', () => {
  it('matches the server default, so the bell and the API agree on one list', () => {
    // FEED_DEFAULT_LIMIT on the server. A larger number here is not a bug, but a
    // smaller one silently hides alerts the API counted in `live`, and the
    // footer's "N in total" would then be the only sign anything was missing.
    expect(FEED_LIMIT).toBe(20);
  });
});

describe('the expiry window', () => {
  it('is the window Settings promises and the writer alerts on', () => {
    // Three surfaces, one number: the writer's EXPIRING_ALERT_DAYS, the Settings
    // hint "Stock expiring within the next 90 days", and the derived read the
    // bell falls back to. The bell used to ask for 30 while the other two said
    // 90, so the fallback showed a third of the promised window and nothing
    // complained — a pharmacy can be within 90 days of a date and never hear.
    expect(EXPIRING_WINDOW_DAYS).toBe(90);
  });

  it('is the number the wording is built from, so the two cannot split', () => {
    expect(deriveExpiringAlerts([inventoryRow({ expiry_date: null })])[0].detail).toContain(
      String(EXPIRING_WINDOW_DAYS)
    );
  });
});
