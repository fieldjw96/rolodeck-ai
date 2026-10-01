import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { test as base } from "@playwright/test";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres, { type Sql } from "postgres";

import * as schema from "../../db/schema";
import { seededName, seedProfiles } from "../../db/testing/seed-profiles";
import { APP_ROLE } from "../../lib/supabase/env";
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

/**
 * The privileged connection this suite stands its database up with: the shim, the migrations,
 * and each test's fixtures. The app itself is never given it — see `appDatabaseUrl` — the way
 * production hands DDL to `MIGRATION_DATABASE_URL` and the running app to something narrower.
 */
function databaseUrl(): string {
  const url = process.env.DATABASE_URL;

  if (url === undefined || url.length === 0) {
    throw new Error(
      "DATABASE_URL is not set. This suite asserts the swipe flow against a real Postgres " +
        "instance (Ticket #13), not the GoTrue-stub-only server `e2e/support/server.ts` " +
        "otherwise builds. Point it at a scratch Postgres — the `e2e-db` CI job provisions " +
        "one the same way the `migrate` job does — before running `npm run test:e2e:db`. It " +
        "must be privileged enough to create a role and apply the migrations; the app under " +
        "test is handed a narrower one built from it.",
    );
  }

  return url;
}

/**
 * A password for `rolodeck_app` on this scratch database. Random per run, and never anything a
 * real project uses: migration 0012 deliberately sets no password, because the migration is
 * committed, so whatever stands a database up sets one. Here that is this file.
 *
 * One per worker process, which is safe because `playwright.db.config.ts` runs one worker: a
 * second would set its own password on the same cluster's role and lock the first one out.
 */
const APP_ROLE_PASSWORD = `e2e-${randomUUID()}`;

/**
 * The connection string the app under test reads as `DATABASE_URL`: the privileged one above
 * with `rolodeck_app` in place of its user. That role cannot bypass RLS and holds no table
 * privilege until `asUser()` drops to `authenticated`, so this suite — a real browser, a real
 * sign-in, the real route handlers — is also what proves no request the swipe flow makes has
 * forgotten its session. See docs/adr/0005 and `db/app-role.test.ts`.
 *
 * The project-ref suffix a Supabase pooler user carries is kept, since that is how the pooler
 * is told which project to reach: `postgres.abc` becomes `rolodeck_app.abc`.
 */
function appDatabaseUrl(): string {
  const url = new URL(databaseUrl());
  const projectRef = decodeURIComponent(url.username).split(".").slice(1);

  // The setters percent-encode whatever they are given, so neither is encoded here first.
  url.username = [APP_ROLE, ...projectRef].join(".");
  url.password = APP_ROLE_PASSWORD;

  return url.toString();
}

export type RealDbApp = { baseURL: string };

/** A throwaway user with `SEEDED_PROFILE_COUNT` Profiles of their own, oldest first — the
 * same order `seedProfiles` returns ids in, and the reverse of the order the Deck deals them. */
export type SeededUser = {
  email: string;
  password: string;
  profileNames: string[];
};

/** A throwaway user with no User Profile at all — the one `e2e/onboarding.spec.ts` needs, and
 * the reason it is not `seededUser`: that fixture is already asked, on purpose, so the swipe
 * flow it serves is not tangled up in Ticket #191's own screen. */
export type NewUser = { email: string; password: string };

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
  { seededUser: SeededUser; newUser: NewUser },
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

      // The one thing the migration leaves to whoever stands the database up, because the
      // migration is committed and a password is not. In production Jack does this by hand in
      // the Supabase SQL editor; here it is a password only this run knows. Interpolated
      // rather than bound: `alter role` is a utility statement and takes no parameters. Both
      // halves are this repo's own — a constant and a generated UUID — so there is nothing in
      // either that could end the string literal early.
      await client.unsafe(
        `alter role ${APP_ROLE} with password '${APP_ROLE_PASSWORD}'`,
      );

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
        DATABASE_URL: appDatabaseUrl(),
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
    // `auth.users` cascades into `swipes` and `user_profiles`, the two tables that still carry
    // a User. The Catalogue does not cascade any more — nothing owns it, per docs/adr/0019 —
    // so `profiles` is truncated by name, which takes `news_items` and `event_attendances`
    // with it. Between them that is every table a previous test in this worker could have
    // written to before this one seeds its own.
    await sql`truncate table auth.users, profiles cascade`;

    const user = await backend.createUser();
    await sql`insert into auth.users (id) values (${user.id})`;
    // Already asked, on purpose: this fixture serves the swipe flow, which Ticket #191's
    // onboarding screen is not part of. `newUser`, below, is the one deliberately without this
    // row.
    await sql`insert into user_profiles (user_id) values (${user.id})`;

    const db = drizzle(sql, { schema });
    await seedProfiles(db, { count: SEEDED_PROFILE_COUNT });

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

  newUser: async ({ backend, sql }, provide) => {
    await sql`truncate table auth.users, profiles cascade`;

    const user = await backend.createUser();
    await sql`insert into auth.users (id) values (${user.id})`;

    try {
      await provide({ email: user.email, password: user.password });
    } finally {
      await backend.deleteUser(user.id);
    }
  },
});

export { expect } from "@playwright/test";
