/**
 * The assertion vocabulary shared by the generated Postgres harnesses.
 *
 * Each harness renders the SQL its builders actually produce, wrapped in
 * plpgsql blocks that raise on a wrong answer. The wrapping is identical every
 * time — a count, a number, a string, a row count from a write — so it lives
 * here rather than being retyped per file, where the copies would drift and a
 * harness would fail in a way that says nothing about the query under test.
 *
 * The counter is per instance rather than module state: two harnesses render in
 * the same jest process, and a shared counter would number one file's PASS lines
 * by where the other one stopped.
 *
 * One hazard worth knowing before naming a column. Every assertion below reads
 * its source from inside a plpgsql block, where the language's own identifiers
 * share a namespace with the query's columns. A column called `found` cannot be
 * aggregated there at all — `FOUND` is a plpgsql status variable, and Postgres
 * answers "column reference is ambiguous" rather than picking one. The API's own
 * path never hits this, because node-postgres runs the same SQL outside plpgsql,
 * so the harness is the only place it can be caught.
 */
export class Harness {
  private pass = 0;

  /** How many assertions have been emitted, for the emit script to report. */
  get assertions(): number {
    return this.pass;
  }

  /**
   * Escapes text that is about to be embedded in a plpgsql string literal.
   *
   * The source and the label both end up inside `RAISE EXCEPTION '…'`. A source
   * that is a subquery rather than a view name carries its own quoted literals,
   * and an unescaped apostrophe in either closes the string early — which
   * reports as a syntax error in the harness rather than a finding about the
   * query, at whatever line the quote happened to land on.
   */
  private say(value: string): string {
    return value.replace(/'/g, "''");
  }

  /** Asserts how many rows a table or view holds. */
  expectRows(source: string, expected: number, label: string): string {
    this.pass += 1;
    const named = this.say(source);
    const said = this.say(label);
    return `
DO $$
DECLARE n INTEGER;
BEGIN
  SELECT COUNT(*)::int INTO n FROM ${source};
  IF n <> ${expected} THEN
    RAISE EXCEPTION '${named}: ${said} — expected ${expected} row(s), got %', n;
  END IF;
  RAISE NOTICE 'PASS ${this.pass}: ${said} (%)', n;
END $$;
`;
  }

  /**
   * Asserts one aggregate over a table or view.
   *
   * The aggregate is written against the source by name rather than arriving as
   * a finished scalar subquery, so a failure can say which source it was on:
   * with a dozen views in one file, "expected 5, got 4" on its own sends you
   * looking in the wrong half of the harness.
   */
  expectNumber(source: string, aggregate: string, expected: number, label: string): string {
    this.pass += 1;
    const named = this.say(source);
    const said = this.say(label);
    return `
DO $$
DECLARE v NUMERIC;
BEGIN
  SELECT (${aggregate})::numeric INTO v FROM ${source};
  IF v IS DISTINCT FROM ${expected} THEN
    RAISE EXCEPTION '${named}: ${said} — expected ${expected}, got %',
      COALESCE(v::text, 'NULL');
  END IF;
  RAISE NOTICE 'PASS ${this.pass}: ${said} (%)', v;
END $$;
`;
  }

  /**
   * The same for a text answer — a receipt number, a supplier, a message.
   *
   * Separate from expectNumber because Postgres will not cast text to numeric.
   * Sharing one method would turn those assertions into an error in the harness
   * rather than a finding about the query.
   */
  expectText(source: string, aggregate: string, expected: string, label: string): string {
    this.pass += 1;
    const named = this.say(source);
    const said = this.say(label);
    const literal = expected.replace(/'/g, "''");
    return `
DO $$
DECLARE v TEXT;
BEGIN
  SELECT (${aggregate})::text INTO v FROM ${source};
  IF v IS DISTINCT FROM '${literal}' THEN
    RAISE EXCEPTION '${named}: ${said} — expected ${literal}, got %',
      COALESCE(v, 'NULL');
  END IF;
  RAISE NOTICE 'PASS ${this.pass}: ${said} (%)', v;
END $$;
`;
  }

  /**
   * Runs statements and asserts how many rows the last one touched.
   *
   * This is the only way to see an `ON CONFLICT DO NOTHING` from SQL: the
   * statement succeeds either way, and the difference between having written a
   * row and having written nothing is the whole point of it.
   */
  expectRowCount(statements: string, expected: number, label: string): string {
    this.pass += 1;
    const said = this.say(label);
    return `
DO $$
DECLARE n INTEGER;
BEGIN
${statements}
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> ${expected} THEN
    RAISE EXCEPTION '${said} — expected ${expected} row(s) affected, got %', n;
  END IF;
  RAISE NOTICE 'PASS ${this.pass}: ${said} (%)', n;
END $$;
`;
  }
}
