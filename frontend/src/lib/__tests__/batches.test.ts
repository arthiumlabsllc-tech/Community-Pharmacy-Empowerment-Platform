import {
  ADJUST_MODES,
  BATCH_MIGRATION,
  BATCH_STATUS,
  EMPTY_RECEIVE_FORM,
  WRITE_OFF_REASONS,
  buildAdjustPayload,
  buildReceivePayload,
  buildWriteOffPayload,
  expiryConflictBetween,
  isBatchTrackingMissing,
  parseWholeUnits,
  previewAdjust,
  previewReceive,
  previewWriteOff,
  receiveFormErrors,
  similarLots,
  type BatchRow,
  type ReceiveForm,
} from '../batches';

function batchRow(overrides: Partial<BatchRow> = {}): BatchRow {
  return {
    id: 'batch-1',
    batch_number: 'ABC123',
    expiry_date: '2026-06-01',
    received_at: '2026-01-04',
    quantity: 60,
    cost_price: '4.50',
    stock_value: 270,
    supplier_id: null,
    supplier_name: null,
    invoice_number: null,
    received_by: null,
    is_backfill: false,
    is_active: true,
    is_expired: false,
    days_to_expiry: 150,
    status: 'sellable',
    sellable: true,
    ...overrides,
  };
}

function receiveForm(overrides: Partial<ReceiveForm> = {}): ReceiveForm {
  return {
    ...EMPTY_RECEIVE_FORM,
    batch_number: 'LOT-9',
    expiry_date: '2027-03-01',
    quantity: '40',
    ...overrides,
  };
}

/**
 * The optional fields that must never be sent blank.
 *
 * Only these, and not the whole payload: `batch_number` and `expiry_date` are
 * required, so they *are* `''` on an untouched form and the form's own
 * validation is what stops that being submitted. The optional ones are
 * different — the server validates `cost_price` with isFloat and `received_at`
 * with isDate, and `''` fails both even though `optional({ nullable: true })`
 * was meant to allow the key to be left out entirely.
 */
const OPTIONAL_RECEIVE_KEYS = ['cost_price', 'invoice_number', 'received_at', 'note', 'supplier_id'];

function blankOptionals(payload: Record<string, unknown>): string[] {
  return OPTIONAL_RECEIVE_KEYS.filter(
    (key) => key in payload && (payload[key] === '' || payload[key] === null || payload[key] === undefined)
  );
}

describe('the reasons stock leaves without being sold', () => {
  it('are the three the backend and the ledger constraint accept', () => {
    // A drift guard rather than a tautology: these strings are written out here
    // so that adding a fourth reason to the client without the database, or
    // renaming one without the CHECK constraint, fails this file. A reason the
    // form offers and the server rejects is a 500 on a form that looked valid.
    expect(WRITE_OFF_REASONS.map((reason) => reason.value)).toEqual([
      'expiry_writeoff',
      'damage_writeoff',
      'recall',
    ]);
  });

  it('label each reason in the words a pharmacist uses, not the column value', () => {
    expect(WRITE_OFF_REASONS.map((reason) => reason.label)).toEqual([
      'Expired',
      'Damaged',
      'Recalled',
    ]);
  });

  it('say what quantity is usual for each, because that is the part people get wrong', () => {
    for (const reason of WRITE_OFF_REASONS) {
      expect(reason.hint.length).toBeGreaterThan(20);
    }
  });
});

describe('the four batch states', () => {
  it('are all described, so a status the server adds cannot render as undefined', () => {
    expect(Object.keys(BATCH_STATUS).sort()).toEqual([
      'empty',
      'expired',
      'quarantined',
      'sellable',
    ]);
  });

  it('attach an action to every state that is not sellable', () => {
    // "Not sellable" on its own leaves a box on the shelf. Each of the three
    // has to say what to do about it.
    for (const status of ['expired', 'quarantined', 'empty'] as const) {
      expect(BATCH_STATUS[status].action.length).toBeGreaterThan(20);
    }
  });

  it('separate expired from quarantined, which are different decisions', () => {
    expect(BATCH_STATUS.expired.className).not.toBe(BATCH_STATUS.quarantined.className);
    expect(BATCH_STATUS.quarantined.action).toContain('decision');
    expect(BATCH_STATUS.expired.action).toContain('Write it off');
  });
});

describe('the two ways to correct a batch', () => {
  it('are counted and change, and no third', () => {
    expect(ADJUST_MODES.map((mode) => mode.value)).toEqual(['counted', 'change']);
  });
});

describe('parseWholeUnits', () => {
  it('reads whole numbers, positive and negative', () => {
    expect(parseWholeUnits('12')).toBe(12);
    expect(parseWholeUnits('-3')).toBe(-3);
    expect(parseWholeUnits('0')).toBe(0);
    expect(parseWholeUnits('  7 ')).toBe(7);
  });

  it('refuses a fraction rather than silently dropping it', () => {
    // parseInt would return 12 here and the form would tell the pharmacist one
    // thing while sending another. Half a tablet is a real quantity on a shelf
    // and deserves an error, not a truncation.
    expect(parseWholeUnits('12.5')).toBeNull();
    expect(parseWholeUnits('0.5')).toBeNull();
  });

  it('refuses an empty field rather than reading it as zero', () => {
    // Zero units is an answer. Guessing it turns a half-filled form into a
    // stock-take that closed a batch.
    expect(parseWholeUnits('')).toBeNull();
    expect(parseWholeUnits('   ')).toBeNull();
  });

  it('refuses anything that is not a number', () => {
    expect(parseWholeUnits('twelve')).toBeNull();
    expect(parseWholeUnits('1e3')).toBeNull();
    expect(parseWholeUnits('+4')).toBeNull();
  });
});

describe('expiryConflictBetween', () => {
  it('is null when the two dates agree', () => {
    expect(expiryConflictBetween('2026-06-01', '2026-06-01')).toBeNull();
  });

  it('is null when there is no date on file to disagree with', () => {
    expect(expiryConflictBetween(null, '2026-06-01')).toBeNull();
  });

  it('keeps the earlier date, whichever side it is on', () => {
    // The safe direction to be wrong in is the one that takes stock off the
    // shelf sooner, not the one that dispenses it later than the manufacturer
    // guaranteed.
    expect(expiryConflictBetween('2026-06-01', '2026-08-01')).toEqual({
      on_file: '2026-06-01',
      submitted: '2026-08-01',
      kept: '2026-06-01',
    });
    expect(expiryConflictBetween('2026-08-01', '2026-06-01')).toEqual({
      on_file: '2026-08-01',
      submitted: '2026-06-01',
      kept: '2026-06-01',
    });
  });

  it('reports both dates, because only the pharmacist can find out which is wrong', () => {
    const conflict = expiryConflictBetween('2026-06-01', '2026-08-01');
    expect(conflict!.on_file).not.toBe(conflict!.submitted);
    expect(conflict!.kept).toBe(conflict!.on_file);
  });
});

describe('previewReceive', () => {
  it('creates a new lot when the number is not on file', () => {
    expect(previewReceive('LOT-9', 40, '2027-03-01', [batchRow()])).toEqual({
      merged: false,
      quantityAfter: 40,
      expiryConflict: null,
    });
  });

  it('tops up an existing lot rather than showing a second delivery', () => {
    expect(previewReceive('ABC123', 40, '2026-06-01', [batchRow()])).toEqual({
      merged: true,
      quantityAfter: 100,
      expiryConflict: null,
    });
  });

  it('matches the lot number exactly, the way the unique constraint does', () => {
    expect(previewReceive('abc123', 40, '2026-06-01', [batchRow()]).merged).toBe(false);
  });

  it('carries the expiry disagreement through to the preview', () => {
    const preview = previewReceive('ABC123', 40, '2026-09-01', [batchRow()]);
    expect(preview.merged).toBe(true);
    expect(preview.expiryConflict).toEqual({
      on_file: '2026-06-01',
      submitted: '2026-09-01',
      kept: '2026-06-01',
    });
  });

  it('still tops up when the shelf holds nothing', () => {
    expect(previewReceive('ABC123', 40, '2026-06-01', [batchRow({ quantity: 0 })])).toEqual({
      merged: true,
      quantityAfter: 40,
      expiryConflict: null,
    });
  });

  it('finds the lot among several, which is what the panel hands over', () => {
    const batches = [
      batchRow({ id: 'b1', batch_number: 'AAA' }),
      batchRow({ id: 'b2', batch_number: 'ABC123', quantity: 25 }),
      batchRow({ id: 'b3', batch_number: 'ZZZ' }),
    ];
    expect(previewReceive('ABC123', 10, '2026-06-01', batches).quantityAfter).toBe(35);
  });
});

describe('similarLots', () => {
  const onFile = [
    batchRow({ id: 'b1', batch_number: 'ABC123' }),
    batchRow({ id: 'b2', batch_number: 'XYZ 77' }),
  ];

  it('is empty for a lot number that is genuinely new', () => {
    expect(similarLots(onFile, 'LOT-9')).toEqual([]);
  });

  it('is empty for an exact match, which previewReceive already handles as a merge', () => {
    expect(similarLots(onFile, 'ABC123')).toEqual([]);
  });

  it('flags a case difference, which the unique constraint will not catch', () => {
    const found = similarLots(onFile, 'abc123');
    expect(found.map((batch) => batch.batch_number)).toEqual(['ABC123']);
  });

  it('flags a spacing difference, which splits a reorder level across two rows', () => {
    expect(similarLots(onFile, 'XYZ77').map((batch) => batch.id)).toEqual(['b2']);
    expect(similarLots(onFile, 'xyz  77').map((batch) => batch.id)).toEqual(['b2']);
  });

  it('is empty for a blank field rather than matching every other blank', () => {
    expect(similarLots([...onFile, batchRow({ id: 'b3', batch_number: '   ' })], '')).toEqual([]);
    expect(similarLots([...onFile, batchRow({ id: 'b3', batch_number: '   ' })], '  ')).toEqual([]);
  });

  it('does not flag a lot that merely starts the same way', () => {
    expect(similarLots(onFile, 'ABC1234')).toEqual([]);
    expect(similarLots(onFile, 'ABC')).toEqual([]);
  });
});

describe('previewAdjust', () => {
  it('works the difference out from a counted quantity, up and down', () => {
    expect(previewAdjust('counted', '42', 50)).toEqual({ ok: true, value: { change: -8, after: 42 } });
    expect(previewAdjust('counted', '55', 50)).toEqual({ ok: true, value: { change: 5, after: 55 } });
  });

  it('takes a change as it is given, negative and positive', () => {
    expect(previewAdjust('change', '-8', 50)).toEqual({ ok: true, value: { change: -8, after: 42 } });
    expect(previewAdjust('change', '5', 50)).toEqual({ ok: true, value: { change: 5, after: 55 } });
  });

  it('counts down to zero, which closes the batch', () => {
    expect(previewAdjust('counted', '0', 50)).toEqual({ ok: true, value: { change: -50, after: 0 } });
  });

  it('refuses to count fewer than none', () => {
    const preview = previewAdjust('counted', '-5', 50);
    expect(preview.ok).toBe(false);
    if (preview.ok) return;
    expect(preview.error).toContain('cannot be negative');
    // And it says what to do instead, because the pharmacist meant something.
    expect(preview.error).toContain('write-off');
  });

  it('refuses a change that lands below zero and sends it to a write-off', () => {
    const preview = previewAdjust('change', '-60', 50);
    expect(preview.ok).toBe(false);
    if (preview.ok) return;
    expect(preview.error).toContain('-10');
    expect(preview.error).toContain('write-off');
  });

  it('counts a shortfall down, which is the common stock-take case', () => {
    // Not below zero, so this one goes through: 70 on the books, 40 counted.
    expect(previewAdjust('counted', '40', 70)).toEqual({
      ok: true,
      value: { change: -30, after: 40 },
    });
  });

  it('refuses a count that equals what is already there', () => {
    const preview = previewAdjust('counted', '50', 50);
    expect(preview.ok).toBe(false);
    if (preview.ok) return;
    expect(preview.error).toContain('nothing to correct');
  });

  it('refuses a change of zero, which is not a correction', () => {
    const preview = previewAdjust('change', '0', 50);
    expect(preview.ok).toBe(false);
    if (preview.ok) return;
    expect(preview.error).toContain('change the count by something');
  });

  it('refuses a blank or fractional field before it reaches the server', () => {
    expect(previewAdjust('counted', '', 50).ok).toBe(false);
    expect(previewAdjust('change', '2.5', 50).ok).toBe(false);
  });

  it('words the two refusals differently, because they ask for different things', () => {
    const counted = previewAdjust('counted', '', 50);
    const change = previewAdjust('change', '', 50);
    expect(counted.ok).toBe(false);
    expect(change.ok).toBe(false);
    if (counted.ok || change.ok) return;
    expect(counted.error).toContain('counted');
    expect(change.error).toContain('negative');
  });
});

describe('previewWriteOff', () => {
  it('takes the whole lot when the quantity is left blank', () => {
    expect(previewWriteOff('', 60)).toEqual({
      ok: true,
      value: { amount: 60, after: 0, closesBatch: true },
    });
    expect(previewWriteOff('   ', 60).ok).toBe(true);
  });

  it('takes a part of the lot and leaves the rest on the shelf', () => {
    expect(previewWriteOff('12', 60)).toEqual({
      ok: true,
      value: { amount: 12, after: 48, closesBatch: false },
    });
  });

  it('refuses more than is on hand, naming both figures', () => {
    const preview = previewWriteOff('80', 60);
    expect(preview.ok).toBe(false);
    if (preview.ok) return;
    expect(preview.error).toContain('60');
    expect(preview.error).toContain('80');
  });

  it('refuses a lot with nothing on hand', () => {
    const preview = previewWriteOff('', 0);
    expect(preview.ok).toBe(false);
    if (preview.ok) return;
    expect(preview.error).toContain('nothing on hand');
  });

  it('sends a lot below zero to the stock-take instead, which is what it actually is', () => {
    // Negative stock is not stock to destroy. Writing it off would close a
    // batch that owes the pharmacy an explanation.
    const preview = previewWriteOff('', -7);
    expect(preview.ok).toBe(false);
    if (preview.ok) return;
    expect(preview.error).toContain('7 below zero');
    expect(preview.error).toContain('Correct the count');
  });

  it('refuses zero and fractions', () => {
    expect(previewWriteOff('0', 60).ok).toBe(false);
    expect(previewWriteOff('-1', 60).ok).toBe(false);
    expect(previewWriteOff('1.5', 60).ok).toBe(false);
  });

  it('says a blank quantity is allowed, so the refusal does not read as mandatory', () => {
    const preview = previewWriteOff('twelve', 60);
    expect(preview.ok).toBe(false);
    if (preview.ok) return;
    expect(preview.error).toContain('leave it blank for the whole lot');
  });
});

describe('buildReceivePayload', () => {
  it('sends the three required fields', () => {
    expect(buildReceivePayload(receiveForm())).toEqual({
      batch_number: 'LOT-9',
      expiry_date: '2027-03-01',
      quantity: 40,
    });
  });

  it('omits every optional field that was left blank', () => {
    expect(blankOptionals(buildReceivePayload(receiveForm()))).toEqual([]);
  });

  it('omits the optional fields even when the form is completely empty', () => {
    const payload = buildReceivePayload(EMPTY_RECEIVE_FORM);
    expect(blankOptionals(payload)).toEqual([]);
    expect(Object.keys(payload).sort()).toEqual(['batch_number', 'expiry_date', 'quantity']);
  });

  it('includes each optional field once it has a value', () => {
    const payload = buildReceivePayload(
      receiveForm({
        cost_price: '4.50',
        invoice_number: ' INV-4471 ',
        received_at: '2026-05-30',
        note: '  Delivered by Mensah Pharma  ',
      })
    );
    expect(payload).toEqual({
      batch_number: 'LOT-9',
      expiry_date: '2027-03-01',
      quantity: 40,
      cost_price: 4.5,
      invoice_number: 'INV-4471',
      received_at: '2026-05-30',
      note: 'Delivered by Mensah Pharma',
    });
    expect(blankOptionals(payload)).toEqual([]);
  });

  it('trims the lot number, which is the field a recall searches on', () => {
    expect(buildReceivePayload(receiveForm({ batch_number: '  LOT-9  ' })).batch_number).toBe('LOT-9');
  });

  it('sends a quantity as a number and not as the string that was typed', () => {
    expect(typeof buildReceivePayload(receiveForm()).quantity).toBe('number');
  });
});

describe('receiveFormErrors', () => {
  it('are all empty for a valid form', () => {
    expect(Object.values(receiveFormErrors(receiveForm())).filter(Boolean)).toEqual([]);
  });

  it('requires a lot number and says what it is for', () => {
    const errors = receiveFormErrors(receiveForm({ batch_number: '   ' }));
    expect(errors.batch_number).toContain('recall traces from');
  });

  it('requires an expiry date', () => {
    expect(receiveFormErrors(receiveForm({ expiry_date: '' })).expiry_date).not.toBe('');
  });

  it('requires at least one unit', () => {
    expect(receiveFormErrors(receiveForm({ quantity: '0' })).quantity).toContain('at least 1');
    expect(receiveFormErrors(receiveForm({ quantity: '-5' })).quantity).toContain('at least 1');
    expect(receiveFormErrors(receiveForm({ quantity: '' })).quantity).toContain('whole number');
  });

  it('enforces the same length limits the server does', () => {
    expect(receiveFormErrors(receiveForm({ batch_number: 'x'.repeat(101) })).batch_number).toContain(
      '100 characters'
    );
    expect(
      receiveFormErrors(receiveForm({ invoice_number: 'x'.repeat(101) })).invoice_number
    ).toContain('100 characters');
    expect(receiveFormErrors(receiveForm({ note: 'x'.repeat(501) })).note).toContain(
      '500 characters'
    );
  });

  it('accepts a lot number and a note at exactly the limit', () => {
    const errors = receiveFormErrors(
      receiveForm({ batch_number: 'x'.repeat(100), invoice_number: 'y'.repeat(100), note: 'z'.repeat(500) })
    );
    expect(errors.batch_number).toBe('');
    expect(errors.invoice_number).toBe('');
    expect(errors.note).toBe('');
  });

  it('refuses a negative cost price, which would inflate the margin on every unit', () => {
    expect(receiveFormErrors(receiveForm({ cost_price: '-1' })).cost_price).toContain('negative');
    expect(receiveFormErrors(receiveForm({ cost_price: '0' })).cost_price).toBe('');
  });

  it('refuses an arrival date in the future', () => {
    // `today` is passed in rather than read from the clock, so the boundary is
    // written down as a date. Without the parameter these assertions would
    // have to be built relative to now, and a test that computes its own
    // expectation from the same clock the code uses cannot catch a clock bug.
    expect(
      receiveFormErrors(receiveForm({ received_at: '2027-01-01' }), '2026-06-01').received_at
    ).toContain('future');
  });

  it('accepts an arrival dated today, and any day before it', () => {
    expect(
      receiveFormErrors(receiveForm({ received_at: '2026-06-01' }), '2026-06-01').received_at
    ).toBe('');
    expect(
      receiveFormErrors(receiveForm({ received_at: '2026-05-31' }), '2026-06-01').received_at
    ).toBe('');
  });

  it('says nothing when the arrival date is left blank', () => {
    // Blank is not wrong. The server coalesces it to CURRENT_DATE on a new
    // lot, and on a merge it leaves the original arrival date alone so FEFO's
    // tie-break keeps selling the older delivery first.
    expect(receiveFormErrors(receiveForm({ received_at: '' }), '2026-06-01').received_at).toBe('');
  });

  it('compares the same ten characters the server compares', () => {
    // A date input yields `YYYY-MM-DD`, but a value carrying a time of day must
    // not be refused here and accepted by the endpoint. This is the case that
    // diverges without the slice: '2026-06-01T23:00:00Z' sorts after
    // '2026-06-01' as a string, while both are the same day.
    expect(
      receiveFormErrors(receiveForm({ received_at: '2026-06-01T23:00:00Z' }), '2026-06-01')
        .received_at
    ).toBe('');
    // And the slice must not weaken the rule it exists to make consistent.
    expect(
      receiveFormErrors(receiveForm({ received_at: '2026-06-02T00:00:00Z' }), '2026-06-01')
        .received_at
    ).toContain('future');
  });

  it('answers for every field of the form, so no field can be asked about and get undefined', () => {
    // The reason the return type is keyed by `ReceiveForm` rather than by
    // `string`. Adding a field to the form and forgetting its rule is a
    // compile error first and this failure second.
    expect(Object.keys(receiveFormErrors(receiveForm())).sort()).toEqual(
      Object.keys(EMPTY_RECEIVE_FORM).sort()
    );
  });
});

describe('buildAdjustPayload', () => {
  it('carries exactly one quantity key, whichever mode it was built in', () => {
    // The structural form of the server's exactly-one-of rule. Two ways of
    // saying the same thing in one request is a disagreement waiting to be
    // resolved by whichever field the code reads last, so the type makes it
    // impossible rather than the caller making it unlikely.
    for (const mode of ['counted', 'change'] as const) {
      const payload = buildAdjustPayload(mode, 42, 'Annual stock-take');
      const quantityKeys = Object.keys(payload).filter((key) => key !== 'note');
      expect(quantityKeys).toHaveLength(1);
      expect(quantityKeys[0]).toBe(mode === 'counted' ? 'counted_quantity' : 'quantity_change');
    }
  });

  it('never sends both keys, even from a caller that has both figures', () => {
    const counted = buildAdjustPayload('counted', 42, 'Counted during the stock-take');
    const change = buildAdjustPayload('change', -8, 'Counted during the stock-take');
    expect(counted).toEqual({ counted_quantity: 42, note: 'Counted during the stock-take' });
    expect(change).toEqual({ quantity_change: -8, note: 'Counted during the stock-take' });
    expect('quantity_change' in counted).toBe(false);
    expect('counted_quantity' in change).toBe(false);
  });

  it('keeps a negative change negative, which is the whole point of the mode', () => {
    // Compared as a whole object rather than by reading `.quantity_change`,
    // because the union return type does not allow that access without
    // narrowing first. That refusal to compile is the type doing its job: a
    // caller cannot read the key its own mode did not set.
    expect(buildAdjustPayload('change', -8, 'Damaged in transit')).toEqual({
      quantity_change: -8,
      note: 'Damaged in transit',
    });
  });

  it('trims the note but never drops it', () => {
    expect(buildAdjustPayload('counted', 42, '  Counted 42, shelf B  ').note).toBe(
      'Counted 42, shelf B'
    );
  });
});

describe('buildWriteOffPayload', () => {
  it('omits the quantity when the whole lot is going', () => {
    const payload = buildWriteOffPayload('expiry_writeoff', null, 'Past its date');
    expect(payload).toEqual({ reason: 'expiry_writeoff', note: 'Past its date' });
    // Omitted rather than sent as null, so the isInt({ min: 1 }) check never
    // sees a key it has to decide about.
    expect('quantity' in payload).toBe(false);
  });

  it('sends the quantity when part of the lot is going', () => {
    expect(buildWriteOffPayload('damage_writeoff', 12, 'Carton crushed')).toEqual({
      reason: 'damage_writeoff',
      quantity: 12,
      note: 'Carton crushed',
    });
  });

  it('names a reason on every payload, because the ledger requires one', () => {
    for (const reason of WRITE_OFF_REASONS) {
      expect(buildWriteOffPayload(reason.value, null, 'x').reason).toBe(reason.value);
    }
  });
});

describe('isBatchTrackingMissing', () => {
  it('is true for the 501 the batch endpoints answer without migration 003', () => {
    expect(isBatchTrackingMissing({ status: 501, message: 'not installed' })).toBe(true);
  });

  it('is false for every other failure, which is a real error and should be toasted', () => {
    expect(isBatchTrackingMissing({ status: 500 })).toBe(false);
    expect(isBatchTrackingMissing({ status: 404 })).toBe(false);
    expect(isBatchTrackingMissing({ status: 403 })).toBe(false);
    expect(isBatchTrackingMissing({ status: 400 })).toBe(false);
  });

  it('is false for anything that is not a response at all', () => {
    expect(isBatchTrackingMissing(undefined)).toBe(false);
    expect(isBatchTrackingMissing(null)).toBe(false);
    expect(isBatchTrackingMissing(new Error('network'))).toBe(false);
    expect(isBatchTrackingMissing('501')).toBe(false);
  });

  it('names the migration in the message the screens show', () => {
    expect(BATCH_MIGRATION).toBe('database/migrations/003_inventory_batches.sql');
  });
});
