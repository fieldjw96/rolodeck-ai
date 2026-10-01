/**
 * What a Postgres connection string has to say about itself before this repo will connect with
 * it. Both of the two it holds — the app's `DATABASE_URL` (docs/adr/0005) and ingest's
 * `ROLODECK_INGEST_DATABASE_URL` (docs/adr/0013) — carry their scoping in the role they log in
 * as, so a string naming the wrong role is the credential that looks scoped and is not.
 *
 * Here rather than in either `env.ts` because both need the same two checks and neither may
 * import the other: `lib/ingest/credential-boundary.test.ts` forbids an ingest entry point from
 * loading `lib/supabase/env`, which knows the secret key's name.
 */

/**
 * Whether `value` logs in as `role`: the plain name on a direct connection, or
 * `<role>.<project-ref>` through Supabase's pooler, which is how the pooler is told which
 * project the role belongs to.
 */
export function connectsAsRole(value: string, role: string): boolean {
  try {
    const user = decodeURIComponent(new URL(value).username);
    return user === role || user.startsWith(`${role}.`);
  } catch {
    // Not a URL at all; the `z.url` check beside this one already says so.
    return false;
  }
}

/**
 * The only query parameter a connection string may carry. postgres.js sends any parameter it
 * does not recognise to the server as a startup parameter, and a startup parameter named `user`
 * replaces the URL's own: `rolodeck_app:…@host/db?user=postgres` logs in as `postgres` while
 * `connectsAsRole` reads `rolodeck_app`. So rather than list the dangerous ones, every
 * parameter but the one a pooler URL needs is refused.
 */
const PERMITTED_QUERY_PARAMETERS: ReadonlySet<string> = new Set(["sslmode"]);

export function carriesOnlyPermittedParameters(value: string): boolean {
  try {
    return [...new URL(value).searchParams.keys()].every((name) =>
      PERMITTED_QUERY_PARAMETERS.has(name),
    );
  } catch {
    return false;
  }
}
