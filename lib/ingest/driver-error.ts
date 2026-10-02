/**
 * What a failed Postgres write actually says, once `error.message` has already lied about it.
 *
 * Drizzle wraps a failed query in a `DrizzleQueryError` whose `message` is the query text and
 * its parameters, not the reason it failed — that reason is the driver's own error, hung off
 * `cause`. Code that reports `error.message` after a failed write is therefore reporting the SQL
 * it already knew and discarding the one new fact the failure produced. That is Ticket #204: a
 * `NOT NULL` violation across a deploy cost most of a day because nothing had ever printed what
 * postgres.js had already said about it.
 *
 * postgres.js throws a `PostgresError` once a connection exists, carrying `code` and, where the
 * failure names one, `constraint_name`, `column_name`, `table_name` and `detail` — and a plain
 * `Error` carrying just `code` before one does (a refused connection never reaches a query, so
 * it is never a `PostgresError`). Both are told apart from an ordinary `Error` by the one field
 * they share, `code`, which is what this looks for rather than checking `instanceof` against a
 * driver this module does not import.
 *
 * Never reads `query` or `params`: those are already in `error.message` via `DrizzleQueryError`,
 * and widening what prints on failure — even by an error's own fields — is how a Company Profile
 * or Event row, or eventually a credential, ends up in a public log. `message`, `code`,
 * `constraint_name`, `column_name`, `table_name` and `detail` are the only fields read here.
 */

type DriverError = Error & { readonly code: string } & Partial<
    Record<"constraint_name" | "column_name" | "table_name" | "detail", string>
  >;

function asDriverError(value: unknown): DriverError | undefined {
  if (!(value instanceof Error)) {
    return undefined;
  }

  return typeof (value as { code?: unknown }).code === "string"
    ? (value as DriverError)
    : undefined;
}

/**
 * The driver's own account of a failure, found by walking `cause` from `error` itself — not
 * assumed to be exactly one level down, since a rejection built from a caught error can already
 * sit between the throw and the write that actually failed. `undefined` when nothing in the
 * chain carries a `code`, which is every error that was never the driver's.
 */
export function describeDriverError(error: unknown): string | undefined {
  const seen = new Set<unknown>();
  let current: unknown = error;

  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);

    const driver = asDriverError(current);

    if (driver !== undefined) {
      const fields = [`message: ${driver.message}`, `code: ${driver.code}`];

      if (driver.constraint_name !== undefined) {
        fields.push(`constraint: ${driver.constraint_name}`);
      }
      if (driver.column_name !== undefined) {
        fields.push(`column: ${driver.column_name}`);
      }
      if (driver.table_name !== undefined) {
        fields.push(`table: ${driver.table_name}`);
      }
      if (driver.detail !== undefined) {
        fields.push(`detail: ${driver.detail}`);
      }

      return fields.join(", ");
    }

    current = current.cause;
  }

  return undefined;
}

/**
 * What an ingest entry point should print for a thrown `error`: its own message, plus the
 * driver's reason on its own line when `describeDriverError` found one. Every `main().catch()`
 * under `scripts/` and `failedSourceRejection` in `events-run.ts` call this instead of reading
 * `error.message` alone — the one habit this file exists to break. Prefixed with "postgres
 * error" so the line survives `ingest-run.yml`'s summary step, which selects on words like
 * "error" and "fail" rather than trusting every Source to phrase failure the same way.
 */
export function describeFailure(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }

  const driver = describeDriverError(error);

  return driver === undefined
    ? error.message
    : `${error.message}\npostgres error — ${driver}`;
}
