import { drizzle } from "drizzle-orm/postgres-js";
import postgres, { type Sql } from "postgres";

import { readIngestDatabaseUrl } from "../lib/ingest/env";
import type { Database } from "./connection";
import * as schema from "./schema";

let ingestClient: Sql | null = null;
let ingestConnection: Database | null = null;

/**
 * Ingest's own connection to Postgres, as the `rolodeck_ingest` role: the one every Source's
 * fetch script writes through. See docs/adr/0013.
 *
 * That role bypasses RLS on `profiles`, `news_items`, `events` and `event_attendances`, because
 * it writes rows owned by the account rather than by itself, and it can do nothing else at all.
 * Kept in its own module, apart from the app's `getDb()` in `db/connection.ts`, so an ingest
 * entry point never loads the app's connection or its environment: that connection's role is a
 * member of `authenticated`, and a script reaching for it would either fail RLS or quietly hold
 * a credential that can read every swipe.
 */
export function getIngestDb(): Database {
  if (ingestConnection === null) {
    // `prepare: false` for the reason `getDb()` gives: through Supabase's transaction pooler a
    // prepared statement named on one connection is not there on the next.
    ingestClient = postgres(readIngestDatabaseUrl(), { prepare: false });
    ingestConnection = drizzle(ingestClient, { schema });
  }

  return ingestConnection;
}

/**
 * Closes ingest's connection, so a one-shot fetch script's process can exit instead of
 * waiting on a socket it has no more use for. `getDb()` has no equivalent: it backs a server
 * process that never wants its connection to end on purpose.
 */
export async function closeIngestDb(): Promise<void> {
  await ingestClient?.end();
  ingestClient = null;
  ingestConnection = null;
}
