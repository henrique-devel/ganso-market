/**
 * RFC-023 D3. One place that turns an unknown thrown value into the three
 * fields a log line needs to be diagnosable.
 *
 * The reason this module exists: between 2026-09-01 and 2026-09-04 every
 * authenticated call to `GET /polymarket/overview` returned 500, and the log
 * said
 *
 *   {"reason_code":"OVERVIEW_API_FAILED","error_name":"error"}
 *
 * and nothing else. `error.name` for a `pg` driver error is the string
 * "error" — it names no error at all. The one string that identified the cause,
 * `column "occurred_at" does not exist`, existed only inside `error.message`,
 * which was discarded here, and was reachable only by reading the PostgreSQL
 * server log by hand. The defect took about 40 hours to find and about a minute
 * to fix.
 *
 * `pg_code` is the SQLSTATE. It is what separates the three failures that look
 * identical from the outside: `57014` is the statement timeout this RFC's
 * budgets produce on purpose, `42703` is a column that does not exist,
 * `23505` a duplicate key, `25006` a write attempted inside a READ ONLY
 * transaction.
 *
 * Only the error's own `message` is copied. No request payload, no query
 * parameters, no configuration value — a log line is not a place to widen what
 * a leak would expose.
 */
export interface ErrorFields {
  readonly error_name: string;
  readonly error_message: string | null;
  readonly pg_code: string | null;
}

export function errorFields(error: unknown): ErrorFields {
  return {
    error_name: error instanceof Error ? error.name : "UnknownError",
    error_message: error instanceof Error ? error.message : null,
    pg_code: pgCode(error),
  };
}

/**
 * SQLSTATE, when the thrown value carries one as a string.
 *
 * `pg` puts it on `error.code`, but so does Node for its own errors, where it
 * is a name like `ECONNREFUSED` rather than a five-character SQLSTATE. Both are
 * strings and both are worth having in the log, so this does not try to tell
 * them apart — it only refuses the numeric `code` that some libraries use,
 * which would print as a bare integer and read as a SQLSTATE that it is not.
 */
function pgCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null) {
    return null;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && code.length > 0 ? code : null;
}
