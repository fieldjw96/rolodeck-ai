import { readFile } from "node:fs/promises";
import path from "node:path";

import { test as base } from "@playwright/test";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres, { type Sql } from "postgres";

import * as schema from "../../db/schema";
import { seededName, seedProfiles } from "../../db/testing/seed-profiles";
import {
  stubBackend,
  type AuthBackend,
} from "../../lib/auth/testing/auth-backend";
import { buildApp, getFreePort, startApp, stopApp } from "./server";

// `process.cwd()`-relative, matching `./server.ts`: Playwright transpiles this file to
// CommonJS, where `import.meta.url` — what `db/testing/scratch-db.ts` uses under Vitest's
// native ESM — is a syntax error.
const SHIM_PATH = path.join(process.cwd(), "db/testing/supabase-shim.sql");
const MIGRATIONS_FOLDER = path.join(process.cwd(), "db/migrations");

/** How many Profiles `seededUser` seeds. Ticket #13's second AC asks for exactly this many,
 * so both specs in this file share one count rather than each hard-coding it. */
export const SEEDED_PROFILE_COUNT = 2;

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;

  if (url === undefined || url.length === 0) {
    throw new Error(
      "DATABASE_URL is not set. This suite asserts the swipe flow against a real Postgres " +
        "instance (Ticket #13), not the GoTrue-stub-only server `e2e/support/server.ts` " +
        "otherwise builds. Point it at a scratch Postgres — the `e2e-db` CI job provisions " +
        "one the same way the `migrate` job does — before running `npm run test:e2e:db`.",
    );
  }

  return url;
}

export type RealDbApp = { baseURL: string };

/** A throwaway user with `SEEDED_PROFILE_COUNT` Profiles of their own, oldest first — the
 * same order `seedProfiles` returns ids in, and the reverse of the order the Deck deals them. */
export type SeededUser = {
  email: string;
  password: string;
  profileNames: string[];
};

/**
 * Everything the two specs in `swipe-flow.spec.ts` need against a real Postgres: a migrated
 * scratch database, a running app pointed at it, and — per test — a fresh signed-up user with
 * Profiles of their own so neither spec depends on what the other left behind.
 *
 * Worker-scoped except `seededUser`: the migration and the built server are expensive enough
 * to share across the file's specs, but the data underneath each test is not, per the Ticket's
 * "reset between tests so they don't depend on run order".
 */
export const test = base.extend<
  { seededUser: SeededUser },
  { backend: AuthBackend; sql: Sql; app: RealDbApp }
>({
  backend: [
    async ({}, provide) => {
      const backend = await stubBackend();
      try {
        await provide(backend);
      } finally {
        await backend.close();
      }
    },
    { scope: "worker" },
  ],

  sql: [
    async ({}, provide) => {
      const client = postgres(databaseUrl(), { prepare: false, max: 5 });

      // Idempotent: both statements are guarded, so a Postgres that already carries the shim
      // — a developer re-running this locally against the same scratch instance — is fine too.
      await client.unsafe(await readFile(SHIM_PATH, "utf8"));
      await migrate(drizzle(client, { schema }), {
        migrationsFolder: MIGRATIONS_FOLDER,
      });

      try {
        await provide(client);
      } finally {
        await client.end();
      }
    },
    { scope: "worker", timeout: 60_000 },
  ],

  app: [
    // `sql` runs first only because it is destructured: Playwright resolves a fixture's
    // dependencies before the fixture itself, so the migration above always finishes before
    // `next start` can serve a request against the schema it applies.
    async ({ backend, sql }, provide) => {
      void sql;

      const env: NodeJS.ProcessEnv = {
        ...process.env,
        NEXT_PUBLIC_SUPABASE_URL: backend.url,
        NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: backend.publishableKey,
        DATABASE_URL: databaseUrl(),
      };

      await buildApp(env);

      const port = await getFreePort();
      const baseURL = `http://127.0.0.1:${String(port)}`;
      const server = await startApp(env, port);

      try {
        await provide({ baseURL });
      } finally {
        await stopApp(server);
      }
    },
    { scope: "worker", timeout: 12 * 60 * 1000 },
  ],

  seededUser: async ({ backend, sql }, provide) => {
    // `auth.users` cascades into `profiles` and `swipes` (`db/schema.ts`'s `onDelete:
    // "cascade"` on both), so truncating it alone clears every table a previous test in this
    // worker could have written to before this one seeds its own, unrelated owner.
    await sql`truncate table auth.users cascade`;

    const user = await backend.createUser();
    await sql`insert into auth.users (id) values (${user.id})`;

    const db = drizzle(sql, { schema });
    await seedProfiles(db, { count: SEEDED_PROFILE_COUNT, ownerId: user.id });

    try {
      await provide({
        email: user.email,
        password: user.password,
        profileNames: Array.from({ length: SEEDED_PROFILE_COUNT }, (_, i) =>
          seededName(i),
        ),
      });
    } finally {
      await backend.deleteUser(user.id);
    }
  },
});

export { expect } from "@playwright/test";
