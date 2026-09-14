import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";

import * as schema from "../schema";

const SHIM_PATH = fileURLToPath(
  new URL("./supabase-shim.sql", import.meta.url),
);
const MIGRATIONS_FOLDER = fileURLToPath(
  new URL("../migrations", import.meta.url),
);

export type ScratchRole = "anon" | "authenticated" | "rolodeck_ingest";

export type ScratchDb = {
  db: PgliteDatabase<typeof schema>;
  client: PGlite;
  /**
   * Switches the session to `role`, presenting `userId` as the signed-in user. `rolodeck_ingest`
   * is ingest's own role, from migration `0008_ingest_role`; it has no signed-in user.
   */
  as: (role: ScratchRole, userId?: string) => Promise<void>;
  /** Adds the `auth.users` row that `profiles.owner_id` needs to point at. */
  createUser: (id: string) => Promise<void>;
  /** Returns to the superuser session, which bypasses RLS. */
  reset: () => Promise<void>;
  close: () => Promise<void>;
};

/**
 * A real Postgres, in-process, with the migrations applied on top of the Supabase shim.
 * Integration tests get to exercise the actual generated SQL — check constraints, the
 * foreign key into auth.users, and the RLS policy — with no container to start.
 */
export async function createScratchDb(): Promise<ScratchDb> {
  const client = new PGlite();
  await client.exec(await readFile(SHIM_PATH, "utf8"));

  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });

  const reset = async () => {
    // PGlite connects as a superuser, which bypasses RLS; tests opt in to a role.
    await client.exec(
      "reset role; select set_config('request.jwt.claims', '', false);",
    );
  };

  // `set role` changes the current user, which is what table privileges and RLS are checked
  // against, but not the session user. So a session switched this way still passes any check
  // Postgres makes against the session user — `set role` to some other role, notably. A test of
  // those has to log in for real; see "logged in as the ingest role" in `db/ingest-role.test.ts`.
  const as = async (role: ScratchRole, userId?: string) => {
    await reset();
    const claims = userId === undefined ? "" : JSON.stringify({ sub: userId });
    await client.query("select set_config('request.jwt.claims', $1, false)", [
      claims,
    ]);
    await client.exec(`set role ${role};`);
  };

  // Raw SQL rather than Drizzle's `authUsers`, which models columns the shim deliberately
  // leaves out: auth is a separate Ticket and `owner_id` only ever references the id.
  const createUser = async (id: string) => {
    await client.query("insert into auth.users (id) values ($1)", [id]);
  };

  return {
    db,
    client,
    as,
    createUser,
    reset,
    close: () => client.close(),
  };
}
