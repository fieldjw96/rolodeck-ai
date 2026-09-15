import { drizzle } from "drizzle-orm/postgres-js";
import postgres, { type Sql } from "postgres";

import { INGEST_ROLE, readIngestDatabaseUrl } from "../lib/ingest/env";
import type { Database } from "./connection";
import * as schema from "./schema";

let ingestClient: Sql | null = null;
let ingestConnection: Promise<Database> | null = null;

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
 *
 * Asynchronous because it asks Postgres who it logged in as before handing the connection out.
 * `lib/ingest/env.ts` refuses a connection string that names any other user, but a string can
 * only say who it asks to log in as; `current_user` is who it is. Asked once, not per query: every
 * connection postgres.js opens for this client logs in with the same startup parameters.
 */
export function getIngestDb(): Promise<Database> {
  if (ingestConnection === null) {
    const connecting: Promise<Database> = connectAsIngestRole().catch(
      (error: unknown) => {
        // Not remembered, so the next call asks again rather than replaying this failure.
        if (ingestConnection === connecting) {
          ingestConnection = null;
        }
        throw error;
      },
    );
    ingestConnection = connecting;
  }

  return ingestConnection;
}

async function connectAsIngestRole(): Promise<Database> {
  // `prepare: false` for the reason `getDb()` gives: through Supabase's transaction pooler a
  // prepared statement named on one connection is not there on the next.
  const client = postgres(readIngestDatabaseUrl(), { prepare: false });
  ingestClient = client;

  try {
    const [row] = await client<{ current_user: string }[]>`select current_user`;

    if (row?.current_user !== INGEST_ROLE) {
      throw new Error(
        `ROLODECK_INGEST_DATABASE_URL logged in as ${row?.current_user ?? "no role at all"}, not ${INGEST_ROLE}, so ingest refuses to write through it — see docs/adr/0013`,
      );
    }
  } catch (error) {
    if (ingestClient === client) {
      ingestClient = null;
    }
    await client.end();
    throw error;
  }

  return drizzle(client, { schema });
}

/**
 * Closes ingest's connection, so a one-shot fetch script's process can exit instead of
 * waiting on a socket it has no more use for. `getDb()` has no equivalent: it backs a server
 * process that never wants its connection to end on purpose.
 */
export async function closeIngestDb(): Promise<void> {
  const client = ingestClient;
  ingestClient = null;
  ingestConnection = null;
  await client?.end();
}
