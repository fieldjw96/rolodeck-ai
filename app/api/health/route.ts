import { sql } from "drizzle-orm";

import { getDb } from "../../../db/connection";
import { authenticated } from "../../../lib/api/authenticated";

/**
 * Confirms Postgres is actually reachable, not just that the process answering is up: `select
 * 1` runs against the same connection the rest of the app queries through, so a pooler outage
 * or a stale connection string shows up here exactly as it would on any other request. Behind
 * `authenticated()` like every other route handler under `/api` — see
 * `app/api/rate-limit.test.ts`, which asserts that of every route it finds.
 */
export const GET = authenticated(async () => {
  try {
    await getDb().execute(sql`select 1`);
  } catch {
    return Response.json({ status: "error" }, { status: 503 });
  }

  return Response.json({ status: "ok" });
});
