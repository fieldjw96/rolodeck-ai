import type { ExtractTablesWithRelations } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { readDatabaseUrl } from "../lib/supabase/env";
import * as schema from "./schema";

/**
 * Any Drizzle handle over this schema, however it is connected. Written in terms of the base
 * class rather than `PostgresJsDatabase` so a query written against it also runs against the
 * in-process Postgres the tests use, which is what keeps "does RLS actually deny this?" a
 * question TypeScript can answer. A transaction is one of these too.
 */
export type Database = PgDatabase<
  PgQueryResultHKT,
  typeof schema,
  ExtractTablesWithRelations<typeof schema>
>;

let connection: Database | null = null;

/**
 * The app's connection to Postgres, made once per server process.
 *
 * This is not an RLS bypass: the connection role is a member of `authenticated`, and every
 * query the app makes goes through `asUser()` in `db/rls.ts`, which drops to that role for
 * the length of a transaction. The RLS-bypassing path is the secret key in
 * `lib/supabase/admin.ts`, which per CLAUDE.md belongs to ingest alone.
 */
export function getDb(): Database {
  if (connection === null) {
    // `prepare: false` because Supabase's transaction pooler hands a connection to a
    // different client between statements, so a prepared statement named on one is not
    // there for the next.
    connection = drizzle(postgres(readDatabaseUrl(), { prepare: false }), {
      schema,
    });
  }

  return connection;
}
