import {
  buildCallList,
  buildRecallQuery,
  buildUnreachableList,
  EMPTY_RECALL_SEARCH,
  groupBatchesForQuarantine,
  PROVENANCE,
  QUARANTINE_ACTION,
  RECALL_LIMIT_CHOICES,
  RECALL_LIMIT_DEFAULT,
  RECALL_LIMIT_MAX,
  RECALL_NEEDS_A_TERM,
  recallSearchErrors,
  type QuarantineAction,
  type RecallBatch,
  type RecallProvenance,
  type RecallSale,
  type RecallSearchForm,
} from '../recall';

/**
 * What this file exists for.
 *
 * A recall is the one screen where a wrong answer is acted on: somebody is
 * telephoned, or stock is taken off the shelf, or — worst — neither happens
 * because the list looked complete. So the rules that decide who is on the list
 * are pinned here, including the ones the server also enforces, because a
 * client that quietly asks for less than it meant to gets a shorter answer and
 * no error.
 */

function search(overrides: Partial<RecallSearchForm> = {}): RecallSearchForm {
  return { ...EMPTY_RECALL_SEARCH, ...overrides };
}

function batch(overrides: Partial<RecallBatch> = {}): RecallBatch {
  return {
    id: 'batch-1',
    inventory_id: 'inv-1',
    product_name: 'Amoxicillin 500mg',
    product_code: 'AMX500',
    generic_name: 'Amoxicillin',
    manufacturer: 'Mensah Pharma',
    batch_number: 'ABC123',
    expiry_date: '2027-03-01',
    is_expired: false,
    received_at: '2026-01-04',
    supplier_name: null,
    invoice_number: 'INV-4471',
    quantity_on_hand: 40,
    stock_value: 180,
    is_active: true,
    is_backfill: false,
    action: 'quarantine',
    ...overrides,
  };
}

function sale(overrides: Partial<RecallSale> = {}): RecallSale {
  return {
    sale_id: 'sale-1',
    receipt_number: 'RCP-0001',
    sold_at: '2026-08-14T09:12:00.000Z',
    sale_status: 'completed',
    voided: false,
    recorded_offline: false,
    product_name: 'Amoxicillin 500mg',
    product_code: 'AMX500',
    generic_name: 'Amoxicillin',
    inventory_id: 'inv-1',
    batch_id: 'batch-1',
    batch_number: 'ABC123',
    expiry_date: '2027-03-01',
    quantity: 10,
    sell_unit: 'capsule',
    unit_cost: 0.45,
    line_value: 4.5,
    requires_prescription: true,
    provenance: 'batch_ledger',
    confirmed: true,
    patient: {
      id: 'pat-1',
      name: 'Ama Mensah',
      phone: '0241111111',
      alternate_phone: null,
      nhis_number: null,
    },
    customer: null,
    contact: { phone: '0241111111', source: 'patient' },
    served_by: { id: 'user-1', name: 'Kwame Boateng' },
    ...overrides,
  };
}

/** A line nobody can be telephoned about: no patient record, no walk-in number. */
function silentSale(overrides: Partial<RecallSale> = {}): RecallSale {
  return sale({ patient: null, customer: null, contact: null, ...overrides });
}

describe('recallSearchErrors', () => {
  it('refuses a search that names nothing', () => {
    expect(recallSearchErrors(search()).batch_number).toBe(RECALL_NEEDS_A_TERM);
  });

  it('accepts a lot on its own, and a product on its own', () => {
    expect(recallSearchErrors(search({ batch_number: 'ABC123' })).batch_number).toBe('');
    // The message names both fields, so a product-only search must not leave
    // the lot field looking wrong.
    expect(recallSearchErrors(search({ product_name: 'Amoxicillin' })).batch_number).toBe('');
  });

  it('treats whitespace as nothing, because the server trims before deciding', () => {
    expect(recallSearchErrors(search({ batch_number: '   ', product_name: '  ' })).batch_number).toBe(
      RECALL_NEEDS_A_TERM
    );
  });

  it('refuses a window that runs backwards', () => {
    const errors = recallSearchErrors(
      search({ batch_number: 'ABC123', from: '2026-08-20', to: '2026-08-01' })
    );
    expect(errors.from).toContain('after the to date');
  });

  it('accepts a window whose ends are the same day, which is a single day of sales', () => {
    expect(
      recallSearchErrors(search({ batch_number: 'ABC123', from: '2026-08-01', to: '2026-08-01' })).from
    ).toBe('');
  });

  it('compares ten characters, the same slice the server makes', () => {
    // Without the slice this reads as from > to and would be refused here and
    // accepted by the endpoint: as strings, '...T23:00' sorts after '...T00:00'.
    expect(
      recallSearchErrors(
        search({
          batch_number: 'ABC123',
          from: '2026-08-01T23:00:00Z',
          to: '2026-08-01T00:00:00Z',
        })
      ).from
    ).toBe('');
  });

  it('leaves an open-ended window alone', () => {
    expect(recallSearchErrors(search({ batch_number: 'ABC123', from: '2026-01-01' })).from).toBe('');
    expect(recallSearchErrors(search({ batch_number: 'ABC123', to: '2026-12-31' })).from).toBe('');
  });

  it('answers for every field of the form, so none can be asked about and get undefined', () => {
    expect(Object.keys(recallSearchErrors(search())).sort()).toEqual(
      Object.keys(EMPTY_RECALL_SEARCH).sort()
    );
  });
});

describe('buildRecallQuery', () => {
  it('leaves out what was not typed', () => {
    expect(buildRecallQuery(search({ batch_number: 'ABC123' }))).toBe('batch_number=ABC123&limit=500');
  });

  it('trims the two terms it searches on, because the server trims them too', () => {
    expect(buildRecallQuery(search({ batch_number: '  ABC123  ' }))).toContain('batch_number=ABC123');
    expect(buildRecallQuery(search({ product_name: ' Amoxicillin ' }))).toContain(
      'product_name=Amoxicillin'
    );
  });

  it('reduces a date to the day', () => {
    const query = buildRecallQuery(
      search({ batch_number: 'ABC123', from: '2026-08-01T23:00:00Z', to: '2026-08-31T00:00:00Z' })
    );
    expect(query).toContain('from=2026-08-01');
    expect(query).toContain('to=2026-08-31');
    expect(query).not.toContain('T23');
  });

  it('carries both terms and the window together', () => {
    const query = buildRecallQuery(
      search({
        batch_number: 'ABC123',
        product_name: 'Amoxicillin',
        from: '2026-08-01',
        to: '2026-08-31',
        limit: '1000',
      })
    );
    const params = new URLSearchParams(query);
    expect(params.get('batch_number')).toBe('ABC123');
    expect(params.get('product_name')).toBe('Amoxicillin');
    expect(params.get('from')).toBe('2026-08-01');
    expect(params.get('to')).toBe('2026-08-31');
    expect(params.get('limit')).toBe('1000');
  });

  it('sends nothing but the limit for an untouched form', () => {
    // Not a search the page will make — the form's own validation stops it —
    // but it must not produce a term that looks like one.
    expect(buildRecallQuery(search())).toBe(`limit=${RECALL_LIMIT_DEFAULT}`);
  });
});

describe('QUARANTINE_ACTION', () => {
  it('names the three answers the server gives, and no others', () => {
    expect(Object.keys(QUARANTINE_ACTION).sort()).toEqual(
      ['quarantine', 'already_quarantined', 'nothing_on_hand'].sort()
    );
  });

  it('tells the pharmacist what to do, not just what the state is called', () => {
    for (const action of Object.keys(QUARANTINE_ACTION) as QuarantineAction[]) {
      expect(QUARANTINE_ACTION[action].instruction.length).toBeGreaterThan(20);
      expect(QUARANTINE_ACTION[action].className).toMatch(/^badge-/);
    }
  });
});

describe('groupBatchesForQuarantine', () => {
  it('puts each batch in the group its action names', () => {
    const groups = groupBatchesForQuarantine([
      batch({ id: 'a', action: 'quarantine' }),
      batch({ id: 'b', action: 'already_quarantined' }),
      batch({ id: 'c', action: 'nothing_on_hand' }),
    ]);

    expect(groups.toQuarantine.map((entry) => entry.id)).toEqual(['a']);
    expect(groups.alreadyOff.map((entry) => entry.id)).toEqual(['b']);
    expect(groups.allDispensed.map((entry) => entry.id)).toEqual(['c']);
  });

  it('keeps the order it was given, so the page cannot reorder an answer', () => {
    const groups = groupBatchesForQuarantine([
      batch({ id: 'second', action: 'quarantine' }),
      batch({ id: 'first', action: 'quarantine' }),
    ]);

    expect(groups.toQuarantine.map((entry) => entry.id)).toEqual(['second', 'first']);
  });

  it('returns three empty groups for a recall that matched no batch on file', () => {
    expect(groupBatchesForQuarantine([])).toEqual({
      toQuarantine: [],
      alreadyOff: [],
      allDispensed: [],
    });
  });

  it('files every batch exactly once', () => {
    const batches = [
      batch({ id: 'a', action: 'quarantine' }),
      batch({ id: 'b', action: 'already_quarantined' }),
      batch({ id: 'c', action: 'nothing_on_hand' }),
      batch({ id: 'd', action: 'quarantine' }),
    ];
    const groups = groupBatchesForQuarantine(batches);

    // A batch that landed in two groups would be quarantined twice, and one
    // that landed in none would stay on the shelf being sold.
    const filed = [...groups.toQuarantine, ...groups.alreadyOff, ...groups.allDispensed];
    expect(filed).toHaveLength(batches.length);
    expect(new Set(filed.map((entry) => entry.id)).size).toBe(batches.length);
  });
});

describe('buildCallList', () => {
  it('makes one call per number, however many times the lot was bought', () => {
    const list = buildCallList([
      sale({ sale_id: 's1', receipt_number: 'RCP-0001', quantity: 10 }),
      sale({ sale_id: 's2', receipt_number: 'RCP-0007', quantity: 5 }),
    ]);

    expect(list).toHaveLength(1);
    expect(list[0].phone).toBe('0241111111');
    expect(list[0].units).toBe(15);
    expect(list[0].receipts).toEqual(['RCP-0001', 'RCP-0007']);
  });

  it('keeps two numbers apart', () => {
    const list = buildCallList([
      sale({ sale_id: 's1', contact: { phone: '0241111111', source: 'patient' } }),
      sale({ sale_id: 's2', contact: { phone: '0209999999', source: 'customer' } }),
    ]);

    expect(list.map((entry) => entry.phone).sort()).toEqual(['0209999999', '0241111111']);
  });

  it('skips a voided sale, which is the rule summariseReach applies on the server', () => {
    // The stock came back, so it is not out there. Still shown in the sales
    // table, marked as voided, because the customer may have been given a
    // replacement from the same lot.
    const list = buildCallList([sale({ sale_id: 's1', voided: true, quantity: 30 })]);

    expect(list).toEqual([]);
  });

  it('counts a voided line alongside an unvoided one on the same number', () => {
    const list = buildCallList([
      sale({ sale_id: 's1', voided: true, quantity: 30 }),
      sale({ sale_id: 's2', quantity: 10 }),
    ]);

    expect(list).toHaveLength(1);
    expect(list[0].units).toBe(10);
  });

  it('puts the person holding the most of the lot first', () => {
    const list = buildCallList([
      sale({ sale_id: 's1', quantity: 4, contact: { phone: '0201111111', source: 'patient' } }),
      sale({ sale_id: 's2', quantity: 60, contact: { phone: '0241111111', source: 'patient' } }),
      sale({ sale_id: 's3', quantity: 9, contact: { phone: '0551111111', source: 'customer' } }),
    ]);

    expect(list.map((entry) => entry.phone)).toEqual(['0241111111', '0551111111', '0201111111']);
  });

  it('breaks a tie on the number, so the list is the same every time it is built', () => {
    const rows = [
      sale({ sale_id: 's1', quantity: 10, contact: { phone: '0551111111', source: 'patient' } }),
      sale({ sale_id: 's2', quantity: 10, contact: { phone: '0241111111', source: 'patient' } }),
    ];

    expect(buildCallList(rows).map((entry) => entry.phone)).toEqual(['0241111111', '0551111111']);
    expect(buildCallList([...rows].reverse()).map((entry) => entry.phone)).toEqual([
      '0241111111',
      '0551111111',
    ]);
  });

  it('names both people on a shared household phone rather than dropping one', () => {
    const list = buildCallList([
      sale({
        sale_id: 's1',
        contact: { phone: '0241111111', source: 'patient' },
        patient: { id: 'p1', name: 'Ama Mensah', phone: '0241111111', alternate_phone: null, nhis_number: null },
      }),
      sale({
        sale_id: 's2',
        contact: { phone: '0241111111', source: 'patient' },
        patient: { id: 'p2', name: 'Kofi Mensah', phone: '0241111111', alternate_phone: null, nhis_number: null },
      }),
    ]);

    expect(list[0].names).toEqual(['Ama Mensah', 'Kofi Mensah']);
  });

  it('does not list the same name twice against one number', () => {
    const list = buildCallList([sale({ sale_id: 's1' }), sale({ sale_id: 's2' })]);

    expect(list[0].names).toEqual(['Ama Mensah']);
  });

  it('falls back to the walk-in name when there is no patient record', () => {
    const list = buildCallList([
      sale({
        sale_id: 's1',
        patient: null,
        customer: { name: 'Walk-in', phone: '0209999999' },
        contact: { phone: '0209999999', source: 'customer' },
      }),
    ]);

    expect(list[0].names).toEqual(['Walk-in']);
    expect(list[0].source).toBe('customer');
  });

  it('leaves the names empty rather than inventing one for a number with no name attached', () => {
    const list = buildCallList([
      sale({ patient: null, customer: { name: null, phone: '0209999999' }, contact: { phone: '0209999999', source: 'customer' } }),
    ]);

    expect(list[0].names).toEqual([]);
  });

  it('returns nothing for a lot that was never sold', () => {
    expect(buildCallList([])).toEqual([]);
  });

  it('drops a line with nobody to phone, which buildUnreachableList is for', () => {
    expect(buildCallList([silentSale()])).toEqual([]);
  });
});

describe('buildUnreachableList', () => {
  it('keeps only the lines with no number on file', () => {
    const list = buildUnreachableList([sale({ sale_id: 's1' }), silentSale({ sale_id: 's2' })]);

    expect(list.map((entry) => entry.sale_id)).toEqual(['s2']);
  });

  it('skips a voided line, whose stock came back', () => {
    expect(buildUnreachableList([silentSale({ voided: true })])).toEqual([]);
  });

  it('loses no units between the two lists', () => {
    const sales = [
      sale({ sale_id: 's1', quantity: 10 }),
      silentSale({ sale_id: 's2', quantity: 10 }),
      sale({ sale_id: 's3', voided: true, quantity: 99 }),
      silentSale({ sale_id: 's4', quantity: 3 }),
    ];

    // Every unvoided unit is either going to be telephoned about or is on the
    // list of units that cannot be. A unit in neither is a unit the recall has
    // quietly dropped, which is the failure this screen exists to prevent. It is
    // also the server's own invariant: reach.reachableUnits +
    // reach.unreachableUnits equals totals.units_dispensed.
    const outThere = sales
      .filter((entry) => !entry.voided)
      .reduce((total, entry) => total + entry.quantity, 0);
    const phoned = buildCallList(sales).reduce((total, entry) => total + entry.units, 0);
    const unreachable = buildUnreachableList(sales).reduce(
      (total, entry) => total + entry.quantity,
      0
    );

    expect(phoned).toBe(10);
    expect(unreachable).toBe(13);
    expect(phoned + unreachable).toBe(outThere);
  });

  it('counts a number shared by two sales once, but keeps both lots of units', () => {
    const sales = [
      sale({ sale_id: 's1', quantity: 10, contact: { phone: '0241111111', source: 'patient' } }),
      silentSale({ sale_id: 's2', quantity: 7 }),
      sale({ sale_id: 's3', quantity: 4, contact: { phone: '0241111111', source: 'patient' } }),
    ];

    const list = buildCallList(sales);
    expect(list).toHaveLength(1);
    expect(list[0].units).toBe(14);
    expect(list[0].units + buildUnreachableList(sales)[0].quantity).toBe(21);
  });
});

describe('PROVENANCE', () => {
  it('covers both ways a line can be matched', () => {
    expect(Object.keys(PROVENANCE).sort()).toEqual(['batch_ledger', 'product_row'].sort());
  });

  it('says why the unconfirmed one is weaker, not just that it is', () => {
    for (const provenance of Object.keys(PROVENANCE) as RecallProvenance[]) {
      expect(PROVENANCE[provenance].meaning.length).toBeGreaterThan(20);
    }
    expect(PROVENANCE.product_row.meaning).toContain('lead');
  });
});

describe('the limits offered', () => {
  it('are all within what the server will honour', () => {
    for (const choice of RECALL_LIMIT_CHOICES) {
      expect(Number(choice.value)).toBeGreaterThan(0);
      expect(Number(choice.value)).toBeLessThanOrEqual(RECALL_LIMIT_MAX);
    }
  });

  it('opens on the server default, so an untouched search asks for what the endpoint would have chosen', () => {
    expect(EMPTY_RECALL_SEARCH.limit).toBe(String(RECALL_LIMIT_DEFAULT));
    expect(RECALL_LIMIT_CHOICES.map((choice) => choice.value)).toContain(
      String(RECALL_LIMIT_DEFAULT)
    );
  });

  it('offers the maximum as a choice, because a big recall is the case that needs it', () => {
    expect(RECALL_LIMIT_CHOICES.map((choice) => choice.value)).toContain(String(RECALL_LIMIT_MAX));
  });
});
