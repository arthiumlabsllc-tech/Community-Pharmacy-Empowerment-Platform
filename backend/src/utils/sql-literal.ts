/**
 * Inlining a parameterised query as literal SQL.
 *
 * The verification harnesses under database/tests run the SQL the API actually
 * sends, rendered from the same builders, so a change to a query changes the
 * harness. psql has no driver to bind parameters with, so the placeholders are
 * replaced by literals here.
 *
 * Every literal is typed. A bare `'77777777-…'` arrives as text, and text does
 * not compare against uuid — the same distinction that makes `EXECUTE … USING`
 * behave differently from a bound parameter, and one that costs an hour the
 * first time it shows up as `operator does not exist: uuid = text`.
 */

/** The same {text, params} shape pos-queries.ts and recall-queries.ts use. */
export interface BuiltQuery {
  text: string;
  params: unknown[];
}

export function toLiteral(value: unknown, type: string | undefined): string {
  if (value === null || value === undefined) {
    // Untyped, because every nullable placeholder in these queries already
    // carries its own cast: `NULL::text IS NULL` is the test that switches an
    // arm off, and casting it twice would only obscure that.
    return 'NULL';
  }

  if (Array.isArray(value)) {
    const arrayType = type ?? 'text[]';
    const elementType = arrayType.endsWith('[]') ? arrayType.slice(0, -2) : 'text';
    const items = value.map((item) => toLiteral(item, elementType));
    // ARRAY[…] rather than the '{…}' brace form: that one has its own quoting
    // rules for commas, double quotes and backslashes, and getting them wrong
    // silently truncates an element instead of raising.
    return `ARRAY[${items.join(', ')}]::${arrayType}`;
  }

  if (type === 'integer') return String(Math.trunc(Number(value)));

  const escaped = String(value).replace(/'/g, "''");
  return `'${escaped}'::${type ?? 'text'}`;
}

/**
 * Replaces $n with a typed literal.
 *
 * One pass over the placeholders rather than a replacement per index. Doing it
 * index by index puts finished literals into the text before the remaining
 * placeholders are resolved, so a message containing "$1" — entirely possible in
 * prose about a price — would be rewritten by a later pass. A single pass can
 * only ever match the original query text.
 */
export function inlineParams(query: BuiltQuery, types: string[]): string {
  if (query.params.length > types.length) {
    throw new Error(
      `the query binds ${query.params.length} parameters but only ${types.length} types are declared`
    );
  }

  return query.text.replace(/\$(\d+)/g, (placeholder, digits: string) => {
    const index = Number(digits);
    if (index < 1 || index > query.params.length) {
      throw new Error(
        `${placeholder} is not bound — the query supplies ${query.params.length} parameter(s)`
      );
    }
    return toLiteral(query.params[index - 1], types[index - 1]);
  });
}
