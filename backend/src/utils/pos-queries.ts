/**
 * Query building for the till catalogue.
 *
 * Extracted from the route for one reason: a hand-assembled WHERE clause with
 * positional placeholders is easy to get wrong in a way TypeScript cannot see.
 * `LIMIT $3` against a two-element parameter array is a perfectly valid string
 * and a failing query — and it fails at runtime, against a database, which for
 * this project means it fails in a pharmacy rather than in a test.
 *
 * That is not a hypothetical. This exact route shipped with `limit` computed
 * from the query string but never pushed into the parameter array, so every
 * request to `/pos/products` was a 500 and the till could not list a single
 * product. It went unnoticed because the placeholder numbering still looked
 * right when reading the SQL. Building the query here is what makes the
 * relationship between the text and the parameters checkable.
 */

export interface TillProductFilter {
  pharmacyId: string;
  search?: string | null;
  category?: string | null;
  /** Restrict to rows with stock on the shelf. Takes no parameter. */
  inStock?: boolean;
  limit?: unknown;
  /** Where a paged fetch continues. The offline cache pages through everything. */
  offset?: unknown;
}

export interface BuiltQuery {
  text: string;
  params: unknown[];
}

/** The till grid is search-driven, so one page is plenty for it. */
export const TILL_PRODUCT_LIMIT_DEFAULT = 60;

/**
 * A ceiling rather than a default: a request for ten thousand rows would pull
 * the whole inventory through the API on every keystroke of a search. The
 * offline cache respects it and pages instead.
 */
export const TILL_PRODUCT_LIMIT_MAX = 200;

export function clampTillLimit(value: unknown): number {
  const parsed = parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed < 1) return TILL_PRODUCT_LIMIT_DEFAULT;
  return Math.min(parsed, TILL_PRODUCT_LIMIT_MAX);
}

export function clampTillOffset(value: unknown): number {
  const parsed = parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed < 1) return 0;
  return parsed;
}

/**
 * The columns the till renders. Kept as one string so the grid, the offline
 * cache and the cached-product mapper cannot drift apart over which fields
 * exist.
 */
const TILL_PRODUCT_COLUMNS = `id, product_name, generic_name, product_code, barcode, category,
              manufacturer, unit_price, cost_price, quantity, reorder_level, batch_number,
              expiry_date, requires_prescription, vat_treatment, pack_size, default_sell_unit,
              shelf_location,
              (quantity <= reorder_level) AS needs_reorder,
              -- Expired means past the date, not on it: the printed date is the
              -- last day the manufacturer guarantees the medicine, so a batch
              -- dated today is still sellable today. The till refuses to add an
              -- is_expired product to the basket, so getting this wrong costs a
              -- legitimate sale. Matches the inventory summary's COUNT FILTER
              -- and the FEFO ordering further down this same query.
              (expiry_date < CURRENT_DATE) AS is_expired,
              -- >= rather than > so the final sellable day is the loudest badge
              -- on the tile instead of no badge at all.
              (expiry_date >= CURRENT_DATE
                 AND expiry_date <= CURRENT_DATE + INTERVAL '90 days') AS near_expiry`;

export function buildTillProductQuery(filter: TillProductFilter): BuiltQuery {
  const params: unknown[] = [filter.pharmacyId];
  let whereClause = 'WHERE pharmacy_id = $1 AND is_active = true';
  let idx = 2;

  if (filter.search) {
    whereClause += ` AND (product_name ILIKE $${idx} OR generic_name ILIKE $${idx}
                          OR product_code ILIKE $${idx} OR barcode ILIKE $${idx})`;
    params.push(`%${filter.search}%`);
    idx++;
  }

  if (filter.category) {
    whereClause += ` AND category = $${idx}`;
    params.push(filter.category);
    idx++;
  }

  if (filter.inStock) {
    whereClause += ' AND quantity > 0';
  }

  // Bound last, after every filter has taken its slot. These are the two that
  // were missing.
  params.push(clampTillLimit(filter.limit), clampTillOffset(filter.offset));

  const text = `SELECT ${TILL_PRODUCT_COLUMNS}
         FROM inventory
         ${whereClause}
        ORDER BY
          -- First-Expiry-First-Out: sellable stock first, shortest date on top.
          --
          -- This used to read WHEN expiry_date > CURRENT_DATE THEN 0 ELSE 1,
          -- which put a batch dated TODAY in the same group as one that expired
          -- last year and pushed it below next month's stock. Today's date is
          -- the last day the medicine is guaranteed, so it is the most urgent
          -- thing on the shelf, not the least. Undated rows get their own group
          -- between the two: they are sellable, but a batch nobody has dated
          -- should not be dispensed ahead of one that is about to expire.
          --
          -- compareTillOrder in the offline catalogue reproduces this exactly,
          -- and the two have to agree or the grid a cashier rotates the shelf
          -- by changes when the connection drops.
          CASE WHEN expiry_date IS NULL THEN 1
               WHEN expiry_date < CURRENT_DATE THEN 2
               ELSE 0 END,
          -- NULLS LAST is the Postgres default for ASC, so undated rows stay
          -- where the group above put them.
          expiry_date ASC,
          product_name ASC,
          -- Tiebreaker. Two batches of the same product can share an expiry
          -- date and a name, and without a total order a paged fetch skips or
          -- repeats rows, which for the offline cache means stock that cannot
          -- be sold during an outage.
          id ASC
        LIMIT $${idx} OFFSET $${idx + 1}`;

  return { text, params };
}
