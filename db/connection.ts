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
 * The app's connection to Postgres, made once per server process, as the `rolodeck_app` role.
 *
 * This is not an RLS bypass, and since Ticket #188 that is a property of the credential rather
 * than of every call site remembering. The role is NOBYPASSRLS and NOINHERIT, a member of
 * `authenticated` and nothing else, so it holds no privilege on any table while it is itself:
 * a query made outside `asUser()` in `db/rls.ts` — which spends that membership for the length
 * of one transaction — is refused by Postgres rather than quietly answered with the owner's
 * own rows. `readDatabaseUrl()` refuses a connection string that logs in as anything else,
 * because the whole guarantee is in which role the string names.
 *
 * Ingest never uses it: it has its own connection, as its own narrower role, in
 * `db/ingest-connection.ts` — see docs/adr/0013. Migrations do not use it either: applying DDL
 * needs rights this role deliberately lacks, and `MIGRATION_DATABASE_URL` carries them — see
 * docs/adr/0014.
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
