import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres, { type Sql } from "postgres";

import * as schema from "../../db/schema";
import { APP_ROLE } from "../../lib/supabase/env";

// `process.cwd()`-relative, matching `./server.ts`: Playwright transpiles these files to
// CommonJS, where `import.meta.url` — what `db/testing/scratch-db.ts` uses under Vitest's
// native ESM — is a syntax error.
const SHIM_PATH = path.join(process.cwd(), "db/testing/supabase-shim.sql");
const MIGRATIONS_FOLDER = path.join(process.cwd(), "db/migrations");

/**
 * Standing a scratch Postgres up for a browser suite, shared by both Playwright configs.
 *
 * Both need the same three things and used to need only one of them. `real-db-app.ts` has done
 * this since Ticket #13. `signed-in-app.ts` needed none of it until Ticket #191 put the
 * first-run check on the `(app)` layout, which gave every page in that group a server-side
 * query — something no `page.route` interception can answer, because it never leaves the
 * server. So that suite stopped being able to render a Deck at all, and the honest fix was to
 * give it the database production has rather than to move the check somewhere it would be
 * optimistic. This module is what stops the second copy of that setup from drifting from the
 * first.
 */

/**
 * The privileged connection a suite stands its database up with: the shim, the migrations, the
 * role's password, and each test's fixtures. The app under test is never handed it — see
 * `appDatabaseUrl` — the way production hands DDL to `MIGRATION_DATABASE_URL` and the running
 * app to something narrower.
 */
export function privilegedDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;

  if (url === undefined || url.length === 0) {
    throw new Error(
      "DATABASE_URL is not set. Both Playwright suites assert against a real Postgres: " +
        "`swipe-flow.spec.ts` and `onboarding.spec.ts` by design (Tickets #13 and #191), and " +
        "the accessibility, layout and performance specs because the `(app)` layout reads the " +
        "User Profile to decide whether a User has been asked for preferences. Point it at a " +
        "scratch Postgres — the `perf` and `e2e-db` CI jobs provision one the same way the " +
        "`migrate` job does. It must be privileged enough to create a role and apply the " +
        "migrations; the app under test is handed a narrower one built from it.",
    );
  }

  return url;
}

/**
 * A password for `rolodeck_app` on this scratch database. Random per process, and never
 * anything a real project uses: migration 0012 deliberately sets none, because the migration is
 * committed, so whatever stands a database up sets one.
 *
 * One per worker process, which is safe because both configs run a single worker. Two workers,
 * or both configs at once against one cluster, would each set their own password on the same
 * role and lock the other out. That was already true before this module and is why the two CI
 * jobs provision a Postgres each.
 */
const APP_ROLE_PASSWORD = `e2e-${randomUUID()}`;

/**
 * The connection string the app under test reads as `DATABASE_URL`: the privileged one with
 * `rolodeck_app` in place of its user. That role cannot bypass RLS and holds no table privilege
 * until `asUser()` drops to `authenticated`, so a browser suite running against it is also what
 * proves no request it makes has forgotten its session. See docs/adr/0005 and
 * `db/app-role.test.ts`.
 *
 * The project-ref suffix a Supabase pooler user carries is kept, since that is how the pooler is
 * told which project to reach: `postgres.abc` becomes `rolodeck_app.abc`.
 */
export function appDatabaseUrl(): string {
  const url = new URL(privilegedDatabaseUrl());
  const projectRef = decodeURIComponent(url.username).split(".").slice(1);

  // The setters percent-encode whatever they are given, so neither is encoded here first.
  url.username = [APP_ROLE, ...projectRef].join(".");
  url.password = APP_ROLE_PASSWORD;

  return url.toString();
}

/**
 * A migrated scratch database with `rolodeck_app` able to log in, and a privileged handle on it.
 * The caller owns closing the handle.
 */
export async function standUpDatabase(): Promise<Sql> {
  const client = postgres(privilegedDatabaseUrl(), { prepare: false, max: 5 });

  // Idempotent: both statements are guarded, so a Postgres that already carries the shim — a
  // developer re-running this locally against the same scratch instance — is fine too.
  await client.unsafe(await readFile(SHIM_PATH, "utf8"));
  await migrate(drizzle(client, { schema }), {
    migrationsFolder: MIGRATIONS_FOLDER,
  });

  // The one thing migration 0012 leaves to whoever stands the database up. In production Jack
  // does this by hand in the Supabase SQL editor; here it is a password only this run knows.
  // Interpolated rather than bound: `alter role` is a utility statement and takes no
  // parameters. Both halves are this repo's own — a constant and a generated UUID — so there is
  // nothing in either that could end the string literal early.
  await client.unsafe(
    `alter role ${APP_ROLE} with password '${APP_ROLE_PASSWORD}'`,
  );

  return client;
}
