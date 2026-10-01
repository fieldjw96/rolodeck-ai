import { sql } from "drizzle-orm";

import { getDb } from "../../../db/connection";
import { authenticated } from "../../../lib/api/authenticated";

/**
 * Confirms Postgres is actually reachable, not just that the process answering is up: `select
 * 1` runs against the same connection the rest of the app queries through, so a pooler outage
 * or a stale connection string shows up here exactly as it would on any other request. Behind
 * `authenticated()` like every other route handler under `/api` — see
 * `app/api/rate-limit.test.ts`, which asserts that of every route it finds.
 *
 * The one query in the app outside `asUser()`, deliberately and for one reason: it reads no
 * row, from no table, so there is no row an RLS policy could be the backstop for. A session is
 * what tells Postgres whose rows to return, and this asks for nobody's. Wrapping it would make
 * it test `set local role authenticated` instead of the thing it is here to test — whether the
 * socket and the pooler are up — and would answer 503 for a connection that is perfectly fine.
 *
 * Until Ticket #188 that exemption was a claim nobody could check, and `select 1` was the
 * precedent an unwrapped query against a real table could hide behind: the connection was
 * Supabase's `postgres` role, which bypasses RLS. It is now `rolodeck_app`, which holds no
 * privilege on any table until `asUser()` drops to `authenticated`, so an unwrapped query here
 * that ever grew a `from` clause would be refused by Postgres — see `db/app-role.test.ts`.
 */
export const GET = authenticated(async () => {
  try {
    await getDb().execute(sql`select 1`);
  } catch {
    return Response.json({ status: "error" }, { status: 503 });
  }

  return Response.json({ status: "ok" });
});
