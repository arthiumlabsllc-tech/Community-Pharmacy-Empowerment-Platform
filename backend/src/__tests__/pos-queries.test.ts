import {
  TILL_PRODUCT_LIMIT_DEFAULT,
  TILL_PRODUCT_LIMIT_MAX,
  buildTillProductQuery,
  clampTillLimit,
  clampTillOffset,
} from '../utils/pos-queries';

/**
 * The bug this file exists for.
 *
 * `LIMIT $2` against a one-element parameter array reads perfectly well and
 * fails at the database, and nothing in the type system connects a placeholder
 * to a parameter. So the connection is asserted here, for every combination of
 * filters, because the numbering shifts with each one — a query that is right
 * with no filters can be wrong with a search.
 */

function placeholders(text: string): number[] {
  return [...text.matchAll(/\$(\d+)/g)].map((match) => Number(match[1]));
}

/** The placeholders used must be exactly $1..$n for n parameters. */
function expectBound(query: { text: string; params: unknown[] }): void {
  const used = placeholders(query.text);
  expect(used.length).toBeGreaterThan(0);
  // A gap means a parameter was pushed that the SQL never reads. A number
  // beyond the length means the SQL asks for one that was never pushed, which
  // is the failure that shipped.
  expect([...new Set(used)].sort((a, b) => a - b)).toEqual(
    query.params.map((_, index) => index + 1)
  );
}

describe('buildTillProductQuery', () => {
  it('binds the limit even with no filters at all', () => {
    const query = buildTillProductQuery({ pharmacyId: 'ph-1', limit: 120 });

    expectBound(query);
    expect(query.params).toEqual(['ph-1', 120, 0]);
    expect(query.text).toContain('LIMIT $2 OFFSET $3');
  });

  it('binds the limit when a search has taken a slot', () => {
    const query = buildTillProductQuery({ pharmacyId: 'ph-1', search: 'amox', limit: 60 });

    expectBound(query);
    expect(query.params).toEqual(['ph-1', '%amox%', 60, 0]);
    expect(query.text).toContain('LIMIT $3 OFFSET $4');
  });

  it('binds the limit when every filter has taken a slot', () => {
    const query = buildTillProductQuery({
      pharmacyId: 'ph-1',
      search: 'amox',
      category: 'Antibiotics',
      inStock: true,
      limit: 200,
      offset: 400,
    });

    expectBound(query);
    expect(query.params).toEqual(['ph-1', '%amox%', 'Antibiotics', 200, 400]);
    expect(query.text).toContain('LIMIT $4 OFFSET $5');
  });

  it('scopes every query to one pharmacy', () => {
    const query = buildTillProductQuery({ pharmacyId: 'ph-9' });

    expect(query.text).toContain('WHERE pharmacy_id = $1 AND is_active = true');
    expect(query.params[0]).toBe('ph-9');
  });

  it('takes no parameter for the in-stock filter, so the numbering does not move', () => {
    const withFlag = buildTillProductQuery({ pharmacyId: 'ph-1', inStock: true });
    const without = buildTillProductQuery({ pharmacyId: 'ph-1' });

    expect(withFlag.params).toEqual(without.params);
    expect(withFlag.text).toContain('AND quantity > 0');
    expect(without.text).not.toContain('AND quantity > 0');
    expectBound(withFlag);
  });

  it('matches a search across the four fields a cashier might scan', () => {
    const { text } = buildTillProductQuery({ pharmacyId: 'ph-1', search: 'para' });

    for (const column of ['product_name', 'generic_name', 'product_code', 'barcode']) {
      expect(text).toContain(`${column} ILIKE $2`);
    }
  });

  it('ignores a filter that is present but empty', () => {
    const query = buildTillProductQuery({ pharmacyId: 'ph-1', search: '', category: '' });

    expect(query.params).toEqual(['ph-1', TILL_PRODUCT_LIMIT_DEFAULT, 0]);
    expect(query.text).not.toContain('ILIKE');
    expect(query.text).not.toContain('category =');
  });

  it('keeps the shortest-dated stock first, which is what FEFO means at the counter', () => {
    const { text } = buildTillProductQuery({ pharmacyId: 'ph-1' });

    expect(text).toContain('WHEN expiry_date < CURRENT_DATE THEN 2');
    expect(text.indexOf('expiry_date ASC')).toBeLessThan(text.indexOf('product_name ASC'));
  });

  it('treats a batch dated today as sellable, in the flag and in the order alike', () => {
    const { text } = buildTillProductQuery({ pharmacyId: 'ph-1' });

    // The printed date is the last day the manufacturer guarantees the
    // medicine. `<=` here cost a legitimate sale, because the till refuses to
    // add an is_expired product to the basket at all.
    expect(text).toContain('(expiry_date < CURRENT_DATE) AS is_expired');
    expect(text).not.toContain('(expiry_date <= CURRENT_DATE) AS is_expired');

    // And today's date is the most urgent stock on the shelf, so it belongs in
    // the leading group rather than down with the expired rows.
    expect(text).toContain('ELSE 0 END');
    expect(text).not.toContain('CASE WHEN expiry_date > CURRENT_DATE THEN 0 ELSE 1 END');
  });

  it('puts undated rows between the sellable and the expired', () => {
    const { text } = buildTillProductQuery({ pharmacyId: 'ph-1' });

    // Matches sortBatchesFefo in utils/fefo.ts and compareTillOrder in the
    // offline catalogue: a batch nobody has dated is still stock, but it should
    // not be dispensed ahead of one that is about to expire.
    expect(text).toContain('CASE WHEN expiry_date IS NULL THEN 1');
    expect(text.indexOf('expiry_date IS NULL THEN 1')).toBeLessThan(
      text.indexOf('expiry_date < CURRENT_DATE THEN 2')
    );
  });

  it('counts a batch dated today as near expiry, not as no badge at all', () => {
    const { text } = buildTillProductQuery({ pharmacyId: 'ph-1' });

    expect(text).toContain('(expiry_date >= CURRENT_DATE');
  });

  it('breaks ties on id so a paged fetch cannot skip or repeat a row', () => {
    const { text } = buildTillProductQuery({ pharmacyId: 'ph-1', limit: 200, offset: 200 });

    expect(text.indexOf('product_name ASC')).toBeLessThan(text.indexOf('id ASC'));
    expect(text).toContain('OFFSET $3');
  });

  it('selects the derived flags the till renders rather than recomputing them', () => {
    const { text } = buildTillProductQuery({ pharmacyId: 'ph-1' });

    expect(text).toContain('AS needs_reorder');
    expect(text).toContain('AS is_expired');
    expect(text).toContain('AS near_expiry');
    expect(text).toContain('vat_treatment');
  });
});

describe('clampTillLimit', () => {
  it('caps a request that would pull the whole inventory on every keystroke', () => {
    expect(clampTillLimit(10_000)).toBe(TILL_PRODUCT_LIMIT_MAX);
    expect(clampTillLimit(TILL_PRODUCT_LIMIT_MAX)).toBe(TILL_PRODUCT_LIMIT_MAX);
  });

  it('falls back rather than querying for nothing', () => {
    expect(clampTillLimit(0)).toBe(TILL_PRODUCT_LIMIT_DEFAULT);
    expect(clampTillLimit(-5)).toBe(TILL_PRODUCT_LIMIT_DEFAULT);
    expect(clampTillLimit(undefined)).toBe(TILL_PRODUCT_LIMIT_DEFAULT);
    expect(clampTillLimit('nonsense')).toBe(TILL_PRODUCT_LIMIT_DEFAULT);
  });

  it('accepts a limit supplied as a query string, which is how it arrives', () => {
    expect(clampTillLimit('120')).toBe(120);
  });
});

describe('clampTillOffset', () => {
  it('never pages backwards', () => {
    expect(clampTillOffset(-100)).toBe(0);
    expect(clampTillOffset(undefined)).toBe(0);
    expect(clampTillOffset('nonsense')).toBe(0);
    expect(clampTillOffset('200')).toBe(200);
  });
});
