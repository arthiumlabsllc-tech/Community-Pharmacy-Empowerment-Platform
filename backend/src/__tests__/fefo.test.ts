import {
  type BatchAllocation,
  type BatchRow,
  describeFefoShortfall,
  isAcceptableArrivalDate,
  planFefo,
  sortBatchesFefo,
  summariseAllocations,
  todayInGhana,
  toIsoDate,
} from '../utils/fefo';

/**
 * What this file exists for.
 *
 * Which batches a sale draws from is the one stock decision that cannot be
 * checked after the fact. Get it wrong and the pharmacy holds the long-dated
 * stock while the short-dated stock expires on the shelf — paid for twice — and
 * when a manufacturer recalls a lot there is no way to say which customers got
 * it. None of that shows up as an error at the time, so the rule is pinned here
 * against every case that is awkward, without a database in sight.
 */

const TODAY = '2026-09-02';

function batch(id: string, overrides: Partial<BatchRow> = {}): BatchRow {
  return {
    id,
    batchNumber: id.toUpperCase(),
    expiryDate: '2027-01-01',
    quantity: 10,
    unitCost: 1,
    receivedAt: '2026-01-01',
    isActive: true,
    ...overrides,
  };
}

/** The allocation as a readable list, so a failure says what changed. */
function taken(plan: ReturnType<typeof planFefo>): Array<[string, number]> {
  return plan.allocations.map((entry) => [entry.batchNumber, entry.quantity]);
}

describe('the order stock comes off the shelf in', () => {
  it('takes the shortest-dated batch first', () => {
    const plan = planFefo(
      [
        batch('long', { expiryDate: '2027-06-01' }),
        batch('short', { expiryDate: '2026-10-01' }),
      ],
      4,
      { today: TODAY }
    );

    expect(taken(plan)).toEqual([['SHORT', 4]]);
    expect(plan.shortfall).toBe(0);
  });

  it('spans two batches when the first cannot cover the line', () => {
    const plan = planFefo(
      [
        batch('long', { expiryDate: '2027-06-01', quantity: 20, unitCost: 5 }),
        batch('short', { expiryDate: '2026-10-01', quantity: 6, unitCost: 4 }),
      ],
      10,
      { today: TODAY }
    );

    // Six from the short-dated batch, then four from the next. One receipt
    // line, two allocations — which is why the junction table exists.
    expect(taken(plan)).toEqual([
      ['SHORT', 6],
      ['LONG', 4],
    ]);
    expect(plan.shortfall).toBe(0);
  });

  it('breaks a shared expiry date on the delivery date', () => {
    const plan = planFefo(
      [
        batch('later-delivery', { expiryDate: '2026-12-01', receivedAt: '2026-05-01' }),
        batch('earlier-delivery', { expiryDate: '2026-12-01', receivedAt: '2026-02-01' }),
      ],
      3,
      { today: TODAY }
    );

    expect(taken(plan)).toEqual([['EARLIER-DELIVERY', 3]]);
  });

  it('gives the same plan however the batches happen to arrive', () => {
    const batches = [
      batch('a', { expiryDate: '2026-12-01', receivedAt: '2026-05-01' }),
      batch('b', { expiryDate: '2026-12-01', receivedAt: '2026-02-01' }),
      batch('c', { expiryDate: '2026-11-01' }),
      batch('d', { expiryDate: null }),
    ];

    const forward = taken(planFefo(batches, 40, { today: TODAY }));
    const backward = taken(planFefo([...batches].reverse(), 40, { today: TODAY }));

    // A total order is what makes a recall reproducible. Without it the same
    // sale rung up twice draws from different batches, and "which customers got
    // lot X" has two answers.
    expect(backward).toEqual(forward);
    expect(forward.map(([name]) => name)).toEqual(['C', 'B', 'A', 'D']);
  });

  it('puts a batch nobody has dated last', () => {
    const ordered = sortBatchesFefo(
      [batch('undated', { expiryDate: null }), batch('dated', { expiryDate: '2027-01-01' })],
      TODAY
    );

    // Sorting an undated batch first would mean stock with no date at all is
    // always dispensed ahead of stock that is about to expire.
    expect(ordered.map((entry) => entry.id)).toEqual(['dated', 'undated']);
  });

  it('leaves the batches it was given alone', () => {
    const batches = [
      batch('long', { expiryDate: '2027-06-01' }),
      batch('short', { expiryDate: '2026-10-01' }),
    ];
    const before = JSON.stringify(batches);

    planFefo(batches, 10, { today: TODAY, allowOversell: true });

    expect(JSON.stringify(batches)).toBe(before);
  });

  it('skips a batch that is empty', () => {
    const plan = planFefo(
      [batch('gone', { expiryDate: '2026-10-01', quantity: 0 }), batch('here')],
      3,
      { today: TODAY }
    );

    expect(taken(plan)).toEqual([['HERE', 3]]);
    expect(plan.available).toBe(10);
  });
});

describe('the day a batch stops being sellable', () => {
  it('sells a batch on its expiry date', () => {
    const plan = planFefo([batch('today', { expiryDate: TODAY })], 3, { today: TODAY });

    // The printed date is the last day the manufacturer guarantees it. Refusing
    // the sale here costs a legitimate one, and the till refuses to add an
    // expired product to the basket at all.
    expect(plan.shortfall).toBe(0);
    expect(plan.skipped).toEqual([]);
    expect(taken(plan)).toEqual([['TODAY', 3]]);
  });

  it('refuses it the day after', () => {
    const plan = planFefo([batch('yesterday', { expiryDate: '2026-09-01' })], 3, {
      today: TODAY,
    });

    expect(taken(plan)).toEqual([]);
    expect(plan.shortfall).toBe(3);
    expect(plan.skipped).toEqual([
      {
        batchId: 'yesterday',
        batchNumber: 'YESTERDAY',
        expiryDate: '2026-09-01',
        quantity: 10,
        reason: 'expired',
      },
    ]);
  });

  it('never calls an undated batch expired', () => {
    const plan = planFefo([batch('undated', { expiryDate: null })], 3, { today: TODAY });

    expect(plan.shortfall).toBe(0);
    expect(plan.skipped).toEqual([]);
  });
});

describe('stock that is there but cannot be sold', () => {
  it('reports a retired batch that still holds stock', () => {
    const plan = planFefo([batch('quarantined', { isActive: false, quantity: 8 })], 3, {
      today: TODAY,
    });

    expect(plan.shortfall).toBe(3);
    expect(plan.skipped).toEqual([
      expect.objectContaining({ batchNumber: 'QUARANTINED', quantity: 8, reason: 'inactive' }),
    ]);
  });

  it('says nothing about a retired batch that is empty', () => {
    const plan = planFefo([batch('closed-off', { isActive: false, quantity: 0 })], 3, {
      today: TODAY,
    });

    // Nobody needs telling about a batch with nothing in it.
    expect(plan.skipped).toEqual([]);
    expect(plan.shortfall).toBe(3);
  });

  it('counts only sellable stock as available', () => {
    const plan = planFefo(
      [
        batch('good', { quantity: 5 }),
        batch('expired', { expiryDate: '2026-08-01', quantity: 12 }),
        batch('retired', { isActive: false, quantity: 7 }),
      ],
      10,
      { today: TODAY }
    );

    expect(plan.available).toBe(5);
    expect(plan.shortfall).toBe(5);
  });
});

describe('an explicit override to sell past the date', () => {
  it('takes expired stock only when it is asked to', () => {
    const batches = [batch('wrong-date', { expiryDate: '2026-08-01', quantity: 6 })];

    const refused = planFefo(batches, 6, { today: TODAY });
    expect(refused.shortfall).toBe(6);

    const allowed = planFefo(batches, 6, { today: TODAY, allowExpired: true });
    expect(allowed.shortfall).toBe(0);
    expect(taken(allowed)).toEqual([['WRONG-DATE', 6]]);
  });

  it('still prefers in-date stock when the override is on', () => {
    const plan = planFefo(
      [
        batch('wrong-date', { expiryDate: '2026-08-01' }),
        batch('fine', { expiryDate: '2027-03-01' }),
      ],
      4,
      { today: TODAY, allowExpired: true }
    );

    expect(taken(plan)).toEqual([['FINE', 4]]);
  });
});

describe('a sale recorded while the till was disconnected', () => {
  it('drives the earliest batch negative rather than losing the sale', () => {
    const plan = planFefo(
      [
        batch('short', { expiryDate: '2026-10-01', quantity: 3, unitCost: 4 }),
        batch('long', { expiryDate: '2027-06-01', quantity: 0 }),
      ],
      10,
      { today: TODAY, allowOversell: true }
    );

    // The goods have physically left. Refusing to record the sale loses real
    // turnover and leaves the counter claiming stock that is not there; a
    // negative count is the honest statement, and a stock-take reconciles it.
    expect(taken(plan)).toEqual([['SHORT', 10]]);
    expect(plan.shortfall).toBe(0);
  });

  it('falls back to the earliest batch of any kind when nothing is usable', () => {
    const plan = planFefo(
      [
        batch('emptied-later', { expiryDate: '2027-01-01', quantity: 0 }),
        batch('emptied-first', { expiryDate: '2026-10-01', quantity: 0 }),
      ],
      5,
      { today: TODAY, allowOversell: true }
    );

    expect(taken(plan)).toEqual([['EMPTIED-FIRST', 5]]);
    expect(plan.shortfall).toBe(0);
  });

  it('records that expired stock was dispensed instead of absorbing it', () => {
    const plan = planFefo([batch('gone-off', { expiryDate: '2026-08-01', quantity: 4 })], 10, {
      today: TODAY,
      allowOversell: true,
    });

    // Both, deliberately. The allocation says the units came from this batch;
    // the skip says the batch was past its date when they did. Silently folding
    // that into a product total would hide the one stock error that can hurt
    // somebody.
    expect(taken(plan)).toEqual([['GONE-OFF', 10]]);
    expect(plan.shortfall).toBe(0);
    expect(plan.skipped).toEqual([expect.objectContaining({ reason: 'expired', quantity: 4 })]);
  });

  it('reports the shortfall when overselling is not allowed', () => {
    const plan = planFefo([batch('short', { quantity: 3 })], 10, { today: TODAY });

    expect(taken(plan)).toEqual([['SHORT', 3]]);
    expect(plan.shortfall).toBe(7);
  });

  it('invents nothing when there are no batches at all', () => {
    const plan = planFefo([], 4, { today: TODAY, allowOversell: true });

    // A product that has never been received has no batch to hang the sale on.
    // Making one up would put a lot number on a receipt that does not exist.
    expect(plan.allocations).toEqual([]);
    expect(plan.shortfall).toBe(4);
    expect(plan.available).toBe(0);
  });
});

describe('what the line cost', () => {
  it('weights the unit cost by what was actually taken', () => {
    const plan = planFefo(
      [
        batch('long', { expiryDate: '2027-06-01', quantity: 20, unitCost: 5 }),
        batch('short', { expiryDate: '2026-10-01', quantity: 6, unitCost: 4 }),
      ],
      10,
      { today: TODAY }
    );

    // 6 at 4.00 and 4 at 5.00. A margin computed against the product's average
    // cost is a margin for stock that was not sold.
    expect(plan.weightedUnitCost).toBe(4.4);
  });

  it('reports no cost when nothing was allocated', () => {
    const plan = planFefo([batch('expired', { expiryDate: '2026-08-01' })], 3, { today: TODAY });

    // Zero, not a divide-by-zero NaN that would poison every total downstream.
    expect(plan.weightedUnitCost).toBe(0);
  });

  it('carries each batch\'s own cost onto its allocation', () => {
    const plan = planFefo(
      [
        batch('cheap', { expiryDate: '2026-10-01', unitCost: 2.5 }),
        batch('dear', { expiryDate: '2027-06-01', unitCost: 9.99 }),
      ],
      15,
      { today: TODAY }
    );

    expect(plan.allocations.map((entry) => entry.unitCost)).toEqual([2.5, 9.99]);
  });
});

describe('a quantity that is not a quantity', () => {
  it('allocates nothing for zero', () => {
    const plan = planFefo([batch('here')], 0, { today: TODAY });

    expect(plan.allocations).toEqual([]);
    expect(plan.shortfall).toBe(0);
  });

  it('floors a fraction, because units are not divisible', () => {
    const plan = planFefo([batch('here')], 3.9, { today: TODAY });

    expect(taken(plan)).toEqual([['HERE', 3]]);
    expect(plan.shortfall).toBe(0);
  });

  it('allocates nothing for a negative or nonsense number', () => {
    for (const wanted of [-5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const plan = planFefo([batch('here')], wanted, { today: TODAY });

      // Infinity floors to itself, so without the guard in planFefo it would
      // have taken the entire shelf on one allocation and reported no shortfall.
      expect(plan.allocations).toEqual([]);
      expect(plan.shortfall).toBe(0);
    }
  });
});

describe('toIsoDate — a DATE column arriving from node-postgres', () => {
  it('reads a Date by its local parts, not in UTC', () => {
    // This is the whole reason the helper exists. node-postgres builds the Date
    // from the date parts in the process timezone; reading it back with
    // toISOString() moves a server west of Greenwich to the previous day, and
    // an expiry that is a day early is stock sold past its date.
    expect(toIsoDate(new Date(2027, 0, 1))).toBe('2027-01-01');
    expect(toIsoDate(new Date(2026, 8, 30))).toBe('2026-09-30');
  });

  it('takes the date part of a string that carries a time', () => {
    expect(toIsoDate('2027-01-01')).toBe('2027-01-01');
    expect(toIsoDate('2027-01-01T00:00:00.000Z')).toBe('2027-01-01');
  });

  it('returns null rather than guessing for anything it cannot read', () => {
    // Null is a real answer here: undated stock exists, and it has to sort last
    // rather than compare as the epoch.
    for (const value of [null, undefined, '', 'nonsense', new Date('nonsense'), 12345, {}]) {
      expect(toIsoDate(value)).toBeNull();
    }
  });
});

describe('summariseAllocations — the label on the receipt line', () => {
  function allocation(
    batchNumber: string,
    expiryDate: string | null,
    quantity = 1
  ): BatchAllocation {
    return { batchId: batchNumber, batchNumber, expiryDate, quantity, unitCost: 1 };
  }

  it('has nothing to say about a line that took no batches', () => {
    expect(summariseAllocations([])).toEqual({ batchNumber: null, expiryDate: null });
  });

  it('names the one lot it drew from', () => {
    expect(summariseAllocations([allocation('B/SHORT', '2026-10-01')])).toEqual({
      batchNumber: 'B/SHORT',
      expiryDate: '2026-10-01',
    });
  });

  it('names every lot when a line spanned batches', () => {
    // A receipt that showed only the first lot would hide the one a recall is
    // actually about.
    const summary = summariseAllocations([
      allocation('B/SHORT', '2026-10-01', 6),
      allocation('B/LONG', '2027-06-01', 4),
    ]);

    expect(summary.batchNumber).toBe('B/SHORT+B/LONG');
    expect(summary.expiryDate).toBe('2026-10-01');
  });

  it('reports the shortest date across the lots, not the first', () => {
    const summary = summariseAllocations([
      allocation('B/LONG', '2027-06-01'),
      allocation('B/SHORT', '2026-10-01'),
      allocation('B/UNDATED', null),
    ]);

    expect(summary.expiryDate).toBe('2026-10-01');
  });

  it('says so when none of the lots were dated', () => {
    expect(
      summariseAllocations([allocation('A', null), allocation('B', null)]).expiryDate
    ).toBeNull();
  });

  it('summarises rather than truncating a list of lot numbers', () => {
    // A half-printed lot number reads like a whole one, and somebody phones it
    // in during a recall. Better to name one lot and say how many there were.
    const summary = summariseAllocations(
      [allocation('LOT-AAAAAAAA', null), allocation('LOT-BBBBBBBB', null), allocation('LOT-CCCC', null)],
      20
    );

    expect(summary.batchNumber).toBe('LOT-AAAAAAAA +2 more');
    expect(summary.batchNumber!.length).toBeLessThanOrEqual(20);
  });

  it('never hands back more than the column will hold', () => {
    // Degenerate on purpose: a limit too small for the "+N more" suffix itself.
    // The real limit is 100 and the suffix is never longer than a dozen, so
    // this cannot happen in a pharmacy — but a value the column rejects is a
    // failed sale, so the guarantee is worth pinning down.
    const summary = summariseAllocations(
      [allocation('LOT-AAAAAAAA', null), allocation('LOT-BBBBBBBB', null)],
      4
    );

    expect(summary.batchNumber!.length).toBeLessThanOrEqual(4);
  });
});

describe('todayInGhana', () => {
  it('reads the UTC date, because Ghana is on GMT all year', () => {
    expect(todayInGhana(new Date('2026-09-02T23:59:00Z'))).toBe('2026-09-02');
    expect(todayInGhana(new Date('2026-09-03T00:00:00Z'))).toBe('2026-09-03');
  });

  it('returns something an ISO date can be compared against', () => {
    expect(todayInGhana()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('isAcceptableArrivalDate', () => {
  it('accepts today and any day before it', () => {
    expect(isAcceptableArrivalDate('2026-09-02', TODAY)).toBe(true);
    expect(isAcceptableArrivalDate('2026-09-01', TODAY)).toBe(true);
    expect(isAcceptableArrivalDate('2019-03-04', TODAY)).toBe(true);
  });

  it('refuses tomorrow, which is the typo this exists for', () => {
    expect(isAcceptableArrivalDate('2026-09-03', TODAY)).toBe(false);
    // A transposed year is how it arrives in practice: a delivery note read at
    // speed. Nothing above refuses it — the date parses, the lot saves — and
    // the consequence only shows up as stock that stops rotating.
    expect(isAcceptableArrivalDate('2027-09-02', TODAY)).toBe(false);
  });

  it('compares the day rather than a time of day, the same slice the route makes', () => {
    expect(isAcceptableArrivalDate('2026-09-02T23:00:00Z', TODAY)).toBe(true);
    expect(isAcceptableArrivalDate('2026-09-03T00:00:00Z', TODAY)).toBe(false);
  });

  it('defaults to the pharmacy date rather than to a date written down here', () => {
    // Two assertions that only pass together: the first would also pass if the
    // default were any far-future date, the second would also pass if the
    // comparison were inverted.
    expect(isAcceptableArrivalDate(todayInGhana())).toBe(true);
    expect(isAcceptableArrivalDate('9999-12-31')).toBe(false);
  });

  it('keeps the older delivery first, which is what refusing the date protects', () => {
    // The tie-break itself is pinned under planFefo. This is the reason the
    // rule above is not cosmetic: with the same expiry, whichever lot carries
    // the earlier received_at is the one the pharmacy sells.
    const batches = [
      batch('typo', { expiryDate: '2026-12-01', receivedAt: '2027-05-01' }),
      batch('correct', { expiryDate: '2026-12-01', receivedAt: '2026-05-01' }),
    ];

    expect(isAcceptableArrivalDate('2027-05-01', TODAY)).toBe(false);
    expect(sortBatchesFefo(batches, TODAY).map((entry) => entry.id)).toEqual(['correct', 'typo']);
  });
});

describe('the sentence a cashier can act on', () => {
  it('sends somebody to quarantine the stock when every batch is past its date', () => {
    const plan = planFefo(
      [
        batch('a', { expiryDate: '2026-08-01', quantity: 12 }),
        batch('b', { expiryDate: '2026-07-15', quantity: 3 }),
      ],
      10,
      { today: TODAY }
    );

    expect(describeFefoShortfall('Amoxicillin 500mg', plan, 10)).toBe(
      'Amoxicillin 500mg: 15 on hand but every batch expired on 2026-07-15. ' +
        'It cannot be sold — quarantine it and record a write-off.'
    );
  });

  it('names both figures when some stock is sellable and some is not', () => {
    const plan = planFefo(
      [batch('good', { quantity: 5 }), batch('bad', { expiryDate: '2026-08-01', quantity: 12 })],
      10,
      { today: TODAY }
    );

    expect(describeFefoShortfall('Amoxicillin 500mg', plan, 10)).toBe(
      'Not enough sellable stock of Amoxicillin 500mg: 5 available, 10 requested. ' +
        'A further 12 are past their expiry date and cannot be sold.'
    );
  });

  it('says plainly that there is not enough, when that is all there is to it', () => {
    const plan = planFefo([batch('good', { quantity: 5 })], 10, { today: TODAY });

    // "Out of stock" would send somebody to the shelf to look again; "expired"
    // sends somebody to quarantine a batch. Getting these the same way round is
    // the point of keeping the wording next to the allocation.
    expect(describeFefoShortfall('Amoxicillin 500mg', plan, 10)).toBe(
      'Not enough stock of Amoxicillin 500mg: 5 available, 10 requested'
    );
  });
});
