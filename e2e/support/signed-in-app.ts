import { test as base } from "@playwright/test";
import { type Sql } from "postgres";

import {
  signInForCookies,
  stubBackend,
  type CookiePair,
} from "../../lib/auth/testing/auth-backend";
import { appDatabaseUrl, standUpDatabase } from "./scratch-database";
import { buildApp, getFreePort, startApp, stopApp } from "./server";

/** A built, running app with a session for a throwaway user already in hand. */
export type SignedInApp = {
  baseURL: string;
  cookies: CookiePair[];
};

/**
 * `/deck` sits behind Supabase Auth (docs/adr/0004), and CI has no Supabase project to sign
 * in against — the same problem the integration tests solve with the in-process GoTrue stub in
 * `lib/auth/testing`. A browser test needs more than that stub alone: `NEXT_PUBLIC_SUPABASE_URL`
 * is inlined into the build by Next at compile time (see `lib/supabase/env.ts`), so pointing a
 * *running* app at the stub means building against it, which means this suite builds and
 * starts its own server rather than reusing whatever `npm run build` already produced.
 *
 * It also needs a real Postgres now, which it did not until Ticket #191. The specs that use this
 * fixture intercept `/api/*` in the browser and never cared what the server could reach, because
 * every page under `(app)` fetched its own data over HTTP. Then the first-run check went on the
 * `(app)` layout, which reads the User Profile *on the server* to decide whether this User has
 * been asked for preferences — and no `page.route` can answer a query that never leaves the
 * server. Without a database every one of those pages redirected to `/onboarding`, so the
 * accessibility, layout and performance specs all stopped finding anything they looked for.
 *
 * Giving the suite the database production has was the honest answer. The alternative was to
 * move the check somewhere it would be optimistic — which docs/adr/0004 argues against for the
 * session check, for the same reason — or to leave the suite mocking HTTP while the server it
 * had built rendered against nothing, which was always a half-truth and would have broken again
 * the next time anything server-rendered needed data.
 *
 * Worker-scoped, so the specs in this directory share one build, one server and one migration
 * rather than each paying for a `next build` of its own. Every step of the teardown is nested
 * inside the step it undoes, so a setup that failed part-way still stops whatever it did manage
 * to start.
 */
export const test = base.extend<object, { sql: Sql; app: SignedInApp }>({
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
    // dependencies before the fixture itself, so the migration always finishes before
    // `next start` can serve a request against the schema it applies.
    async ({ sql }, provide) => {
      const backend = await stubBackend();

      try {
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
          const user = await backend.createUser();

          try {
            // The stub's users live in the stub, so Postgres has to be told this one exists
            // before anything can reference it — `user_profiles.user_id` is a foreign key onto
            // `auth.users`, which `db/testing/supabase-shim.sql` stands in for here.
            await sql`insert into auth.users (id) values (${user.id})`;

            // And this User has been asked for preferences and stated none, which is what
            // every spec using this fixture means by "a signed-in User": they are testing the
            // Deck, the Diary, the Watchlist and the layout, not the first-run screen. A row
            // with everything empty is exactly what clicking Skip writes, and per
            // docs/adr/0011 it ranks the Deck the same as having no row — the difference is
            // only that this User has been asked. `onboarding.spec.ts` covers the other side,
            // under the config that has no fixture writing this row.
            await sql`insert into user_profiles (user_id) values (${user.id})`;

            await provide({
              baseURL,
              cookies: await signInForCookies(backend, user),
            });
          } finally {
            await backend.deleteUser(user.id);
            await sql`delete from auth.users where id = ${user.id}`;
          }
        } finally {
          await stopApp(server);
        }
      } finally {
        await backend.close();
      }
    },
    {
      scope: "worker",
      // Headroom over `buildApp`'s own 8-minute limit, so a slow cold build fails as "next
      // build did not finish", quoting the build, rather than as a bare fixture timeout that
      // names nothing.
      timeout: 12 * 60 * 1000,
    },
  ],
});

export { expect } from "@playwright/test";
