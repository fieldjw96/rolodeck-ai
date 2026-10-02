import { test as base } from "@playwright/test";
import { drizzle } from "drizzle-orm/postgres-js";
import { type Sql } from "postgres";

import * as schema from "../../db/schema";
import { seededName, seedProfiles } from "../../db/testing/seed-profiles";
import {
  stubBackend,
  type AuthBackend,
} from "../../lib/auth/testing/auth-backend";
import { appDatabaseUrl, standUpDatabase } from "./scratch-database";
import { buildApp, getFreePort, startApp, stopApp } from "./server";

/** How many Profiles `seededUser` seeds. Ticket #13’s second AC asks for exactly this many,
 * so both specs in this file share one count rather than each hard-coding it. */
export const SEEDED_PROFILE_COUNT = 2;

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
      const client = await standUpDatabase();

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
