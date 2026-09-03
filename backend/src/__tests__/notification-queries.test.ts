import {
  FEED_DEFAULT_LIMIT,
  FEED_MAX_LIMIT,
  buildMarkReadQuery,
  buildNotificationCountQuery,
  buildNotificationFeedQuery,
  clampFeedLimit,
  stockAlertKinds,
  toCounts,
  type BuiltQuery,
} from '../utils/notification-queries';
import { STOCK_ALERT_KINDS } from '../utils/stock-alerts';
import { renderStockAlertVerifySql } from '../utils/stock-alert-verify-sql';

/**
 * The reader's half of the notifications contract.
 *
 * database/tests/005_stock_alerts_verify.sql runs these three queries against a
 * real Postgres, over rows the writer has just written, and proves what comes
 * back. This suite proves the query that gets there is the one the route sends,
 * and pins the parts a database cannot object to: placeholder numbering, tenant
 * scoping, and which parameter each filter reads.
 *
 * The division matters because of how these fail. A filter pointed at the wrong
 * parameter is not an error — `= ANY()` over an array of the wrong type simply
 * matches nothing, and an empty bell is indistinguishable from a pharmacy with
 * nothing wrong. The harness would catch that too, but only once; these run on
 * every build and name the parameter that moved.
 */

const PHARMACY = '00000000-0000-4000-8000-000000000001';
const SISTER = '00000000-0000-4000-8000-000000000002';
const ALERT_ID = '11111111-1111-4111-8111-111111111111';
const KINDS = [...STOCK_ALERT_KINDS];

function placeholders(text: string): number[] {
  return [...text.matchAll(/\$(\d+)/g)].map((match) => Number(match[1]));
}

/** The placeholders used must be exactly $1..$n for n parameters. */
function expectBound(query: BuiltQuery): void {
  const used = placeholders(query.text);
  expect(used.length).toBeGreaterThan(0);
  // A gap means a parameter was pushed that the SQL never reads. A number beyond
  // the length means the SQL asks for one that was never pushed — against a bell
  // that is not an error, it is a filter that silently stopped filtering.
  expect([...new Set(used)].sort((a, b) => a - b)).toEqual(
    query.params.map((_, index) => index + 1)
  );
}

/** How many times one placeholder appears, without `$2` matching `$20`. */
function countPlaceholder(text: string, n: number): number {
  return (text.match(new RegExp(`\\$${n}(?!\\d)`, 'g')) ?? []).length;
}

/**
 * Asserts the kind filter reads the parameter that actually holds the kinds.
 *
 * This is the test the whole module is arranged around. The filter is one shared
 * fragment used by three queries whose parameters are not in the same order —
 * the mark-read binds kinds to $2 and ids to $3 — so a fragment that hardcoded a
 * placeholder would be right in two of them and wrong in the third. Pointing it
 * at the ids array does not raise anything: a text comparison against uuids
 * matches no rows, "mark all read" reports zero, and the badge stays full.
 */
function expectKindFilterOnKinds(query: BuiltQuery, kinds: string[]): void {
  const match = query.text.match(/split_part\(dedupe_key, ':', 1\) = ANY\(\$(\d+)::text\[\]\)/);
  expect(match).not.toBeNull();

  const index = Number(match![1]);
  expect(query.params[index - 1]).toEqual(kinds);
  // Twice, and only twice: once deciding whether there is any narrowing at all
  // and once doing it. Read from two different parameters, those two decisions
  // could disagree — "no filter" from an empty array and a narrowing from
  // somebody else's.
  expect(query.text).toContain(`cardinality($${index}::text[]) = 0`);
  expect(countPlaceholder(query.text, index)).toBe(2);
}

describe('clampFeedLimit', () => {
  it.each([undefined, null, '', 'abc', NaN])('defaults when the caller asked for %p', (value) => {
    expect(clampFeedLimit(value)).toBe(FEED_DEFAULT_LIMIT);
  });

  it.each([0, -1, -50])('defaults on %p rather than limiting the bell to nothing', (value) => {
    // A LIMIT 0 is the quietest failure available here: a valid query, a 200, an
    // empty list, and a badge that reads zero. It looks exactly like a pharmacy
    // with no problems.
    expect(clampFeedLimit(value)).toBe(FEED_DEFAULT_LIMIT);
  });

  it('defaults on a fraction below one, which would otherwise truncate to zero', () => {
    expect(clampFeedLimit(0.5)).toBe(FEED_DEFAULT_LIMIT);
  });

  it.each([1, 20, FEED_MAX_LIMIT])('passes %p through', (value) => {
    expect(clampFeedLimit(value)).toBe(value);
  });

  it.each([FEED_MAX_LIMIT + 1, 5000])('caps %p at the maximum', (value) => {
    expect(clampFeedLimit(value)).toBe(FEED_MAX_LIMIT);
  });

  it('truncates a fraction rather than rounding it up', () => {
    expect(clampFeedLimit(20.9)).toBe(20);
  });

  it('reads the numeric string a query parameter arrives as', () => {
    // express hands over `?limit=30` as text, and `Number('30abc')` is NaN, so
    // neither case can reach the SQL as something Postgres has to reject.
    expect(clampFeedLimit('30')).toBe(30);
    expect(clampFeedLimit('30abc')).toBe(FEED_DEFAULT_LIMIT);
  });
});

describe('stockAlertKinds', () => {
  it('is the writer\'s list, so the reader cannot ask for a kind nobody writes', () => {
    expect(stockAlertKinds()).toEqual(KINDS);
  });

  it('hands out a copy, so a caller sorting it cannot reorder the writer\'s', () => {
    const kinds = stockAlertKinds();
    kinds.reverse();
    kinds.push('claim_rejected');
    expect(STOCK_ALERT_KINDS).toEqual(KINDS);
  });

  it('spells every kind with underscores, which is what the dedupe key holds', () => {
    // The bell's own components use hyphens internally ('low-stock'). A hyphen
    // reaching the query would match no rows and answer with an empty list on a
    // 200, so the spelling is pinned at the end nearest the SQL as well as at the
    // route, which rejects a kind it does not recognise.
    for (const kind of stockAlertKinds()) {
      expect(kind).toMatch(/^[a-z][a-z_]*$/);
      expect(kind).not.toContain('-');
    }
  });
});

describe('buildNotificationFeedQuery', () => {
  it('binds exactly the four parameters it declares', () => {
    expectBound(buildNotificationFeedQuery(PHARMACY, { kinds: KINDS, unread: true, limit: 5 }));
  });

  it('reads one pharmacy, so a branch cannot see another branch\'s alerts', () => {
    const query = buildNotificationFeedQuery(PHARMACY);
    expect(query.text).toContain('pharmacy_id = $1');
    expect(query.params[0]).toBe(PHARMACY);
    expect(buildNotificationFeedQuery(SISTER).params[0]).toBe(SISTER);
  });

  it('excludes superseded rows, which are the record of a shortage that ended', () => {
    expect(buildNotificationFeedQuery(PHARMACY).text).toContain('superseded_at IS NULL');
  });

  it('reads everything live when no filter is given', () => {
    const query = buildNotificationFeedQuery(PHARMACY);
    expect(query.params).toEqual([PHARMACY, [], false, FEED_DEFAULT_LIMIT]);
  });

  it('narrows on unread without inverting the test', () => {
    const query = buildNotificationFeedQuery(PHARMACY, { unread: true });
    // `NOT true OR read_at IS NULL` keeps only the unopened ones; `NOT false OR …`
    // is always true and keeps everything. Written as an AND, or with the boolean
    // the other way round, the bell shows only alerts somebody has already read.
    expect(query.text).toContain('(NOT $3::boolean OR read_at IS NULL)');
    expect(query.params[2]).toBe(true);
    expect(buildNotificationFeedQuery(PHARMACY).params[2]).toBe(false);
  });

  it('orders newest first with a tiebreak, so one refresh does not reshuffle the bell', () => {
    // A refresh writes every alert it raises in a single INSERT and NOW() is
    // fixed for the transaction, so they all share a created_at. Without the
    // second key the order of those is arbitrary and the list reorders itself
    // each time it is opened.
    expect(buildNotificationFeedQuery(PHARMACY).text).toContain('ORDER BY created_at DESC, id DESC');
  });

  it('limits the list, and the limit is a parameter rather than a literal', () => {
    const query = buildNotificationFeedQuery(PHARMACY, { limit: 7 });
    expect(query.text).toContain('LIMIT $4');
    expect(query.params[3]).toBe(7);
  });

  it('derives the kind in SQL, so the writer\'s key and the reader\'s label cannot disagree', () => {
    expect(buildNotificationFeedQuery(PHARMACY).text).toContain(
      "split_part(dedupe_key, ':', 1) AS dedupe_kind"
    );
  });

  it('points the kind filter at the kinds it was given', () => {
    expectKindFilterOnKinds(buildNotificationFeedQuery(PHARMACY, { kinds: ['low_stock'] }), [
      'low_stock',
    ]);
  });

  it('and at an empty array when it was given none, which means no narrowing', () => {
    expectKindFilterOnKinds(buildNotificationFeedQuery(PHARMACY), []);
  });
});

describe('buildNotificationCountQuery', () => {
  it('binds exactly the two parameters it declares', () => {
    expectBound(buildNotificationCountQuery(PHARMACY, KINDS));
  });

  it('answers the badge and the unread number in one round trip', () => {
    const text = buildNotificationCountQuery(PHARMACY).text;
    expect(text).toContain('COUNT(*)::int AS live');
    expect(text).toContain('COUNT(*) FILTER (WHERE read_at IS NULL)::int AS unread');
  });

  it('has no limit, because the badge says sixty while the list shows twenty', () => {
    expect(buildNotificationCountQuery(PHARMACY).text).not.toMatch(/\bLIMIT\b/i);
  });

  it('reads the same live rows the feed reads', () => {
    const text = buildNotificationCountQuery(PHARMACY).text;
    expect(text).toContain('pharmacy_id = $1');
    expect(text).toContain('superseded_at IS NULL');
  });

  it('points the kind filter at the kinds it was given', () => {
    expectKindFilterOnKinds(buildNotificationCountQuery(PHARMACY, ['expiring']), ['expiring']);
    expectKindFilterOnKinds(buildNotificationCountQuery(PHARMACY), []);
  });
});

describe('toCounts', () => {
  it('reads the numbers the cast returns', () => {
    expect(toCounts({ live: 8, unread: 5 })).toEqual({ live: 8, unread: 5 });
  });

  it('reads the strings an uncast COUNT comes back as', () => {
    expect(toCounts({ live: '8', unread: '5' })).toEqual({ live: 8, unread: 5 });
  });

  it('answers zero for a row that has neither, so an empty result is a zero badge and not NaN', () => {
    // NaN in a badge renders as nothing at all, which reads as "the bell is
    // broken" rather than "there is nothing to see".
    expect(toCounts({})).toEqual({ live: 0, unread: 0 });
  });

  it('keeps a real zero a zero', () => {
    expect(toCounts({ live: 0, unread: 0 })).toEqual({ live: 0, unread: 0 });
  });

  it('does not pass a value it cannot read through to the response', () => {
    expect(toCounts({ live: undefined, unread: 'not a number' })).toEqual({ live: 0, unread: 0 });
  });
});

describe('buildMarkReadQuery', () => {
  it('binds exactly the three parameters it declares', () => {
    expectBound(buildMarkReadQuery(PHARMACY, { ids: [ALERT_ID], kinds: KINDS }));
  });

  it('binds them in the order the SQL reads them', () => {
    // Kinds and ids are both string[], so swapping them compiles. Swapped, the
    // uuid array is compared as text against the dedupe key's first segment and
    // matches nothing: the update reports zero rows and the badge stays full.
    const query = buildMarkReadQuery(PHARMACY, { ids: [ALERT_ID], kinds: ['low_stock'] });
    expect(query.params).toEqual([PHARMACY, ['low_stock'], [ALERT_ID]]);
  });

  it('stamps read_at rather than removing the row', () => {
    const text = buildMarkReadQuery(PHARMACY).text;
    expect(text).toContain('UPDATE notifications');
    expect(text).toContain('SET read_at = NOW()');
    expect(text).not.toMatch(/\bDELETE\b/i);
    // An alert stays live until the stock arrives. Clearing it is the pharmacist
    // saying they have seen it, not a claim that the shortage ended — and the
    // superseded_at column is the only thing that says that.
    expect(text).toContain('superseded_at IS NULL');
  });

  it('only stamps rows nobody has opened, so read_at stays the moment it was first seen', () => {
    expect(buildMarkReadQuery(PHARMACY).text).toContain('read_at IS NULL');
  });

  it('is scoped to the pharmacy in the WHERE clause, not checked afterwards', () => {
    // An id from another branch matches no rows and answers "not found", which is
    // the same answer as an id that does not exist and leaks nothing about which.
    const query = buildMarkReadQuery(PHARMACY, { ids: [ALERT_ID] });
    expect(query.text).toContain('pharmacy_id = $1');
    expect(query.params[0]).toBe(PHARMACY);
  });

  it('treats no ids as every live alert the kinds allow, which is what "mark all read" asks for', () => {
    const query = buildMarkReadQuery(PHARMACY);
    expect(query.text).toContain('(cardinality($3::uuid[]) = 0 OR id = ANY($3::uuid[]))');
    expect(query.params[2]).toEqual([]);
  });

  it('narrows to the ids it was given', () => {
    const query = buildMarkReadQuery(PHARMACY, { ids: [ALERT_ID] });
    expect(query.params[2]).toEqual([ALERT_ID]);
  });

  it('points the kind filter at the kinds and not at the ids beside them', () => {
    expectKindFilterOnKinds(buildMarkReadQuery(PHARMACY, { ids: [ALERT_ID], kinds: ['expiring'] }), [
      'expiring',
    ]);
  });
});

describe('the three queries agree about what is live', () => {
  const queries: Array<[string, BuiltQuery]> = [
    ['the feed', buildNotificationFeedQuery(PHARMACY, { kinds: KINDS })],
    ['the counts', buildNotificationCountQuery(PHARMACY, KINDS)],
    ['mark read', buildMarkReadQuery(PHARMACY, { kinds: KINDS })],
  ];

  for (const [label, query] of queries) {
    it(`${label} scopes to one pharmacy and skips superseded rows`, () => {
      // If mark-read covered rows the feed does not show, the badge would fall
      // while the list stayed the same length — and the pharmacist would have no
      // way to tell which of the two was wrong.
      expect(query.text).toContain('pharmacy_id = $1');
      expect(query.params[0]).toBe(PHARMACY);
      expect(query.text).toContain('superseded_at IS NULL');
    });

    it(`${label} reads the kind from the dedupe key, not from notification_type`, () => {
      // notification_type is a channel enum ('sms', 'email', 'in_app', …). It says
      // how a notification was sent, not what it is about, so filtering the bell on
      // it would group every stock alert with every other in-app message.
      expect(query.text).toContain("split_part(dedupe_key, ':', 1)");
    });
  }
});

describe('the generated harness proves the reader against a real database', () => {
  it('renders a view for the bell\'s list and one for the badge', () => {
    const rendered = renderStockAlertVerifySql();
    expect(rendered).toContain('CREATE TEMP VIEW feed_stock AS');
    expect(rendered).toContain('CREATE TEMP VIEW feed_unread_low AS');
    expect(rendered).toContain('CREATE TEMP VIEW counts_all AS');
  });

  it('renders the limit as a literal, so the harness proves it applies', () => {
    // A LIMIT that did not bind is only a slow dropdown, which nothing in a unit
    // test can see; PASS 34 in the harness counts the rows that come back.
    const rendered = renderStockAlertVerifySql();
    expect(rendered).toContain('LIMIT 3;');
    expect(rendered).toContain('LIMIT 20;');
  });

  it('renders the mark-read statement, both by kind and by id', () => {
    expect(renderStockAlertVerifySql()).toContain('SET read_at = NOW()');
  });

  it('asks for a kind this module does not write, so the reader is not hardcoded to four', () => {
    // The claim feature writes into the same table. A reader that only ever
    // filtered on STOCK_ALERT_KINDS would return nothing for it and the next
    // feature would duplicate the query rather than reuse it.
    expect(renderStockAlertVerifySql()).toContain('CREATE TEMP VIEW feed_claim AS');
  });
});
