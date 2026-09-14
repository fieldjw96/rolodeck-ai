import { z } from "zod";

import { parseEnv } from "../env/parse-env";

/**
 * Everything an ingest path reads from the environment about where it writes, and nothing the
 * app itself reads. Kept apart from `lib/supabase/env.ts` so that no ingest entry point imports
 * the module that knows the secret key's name, which `lib/ingest/credential-boundary.test.ts`
 * holds it to. See docs/adr/0013.
 */

/**
 * The Postgres role every ingest path connects as: created by migration `0008_ingest_role`, and
 * declared as `ingestRole` in `db/schema.ts`.
 */
export const INGEST_ROLE = "rolodeck_ingest";

/**
 * Whether a connection string logs in as the ingest role: `rolodeck_ingest` on a direct
 * connection, or `rolodeck_ingest.<project-ref>` through Supabase's pooler, which is how the
 * pooler is told which project the role belongs to.
 */
function connectsAsIngestRole(value: string): boolean {
  try {
    const user = decodeURIComponent(new URL(value).username);
    return user === INGEST_ROLE || user.startsWith(`${INGEST_ROLE}.`);
  } catch {
    // Not a URL at all; the `z.url` check beside this one already says so.
    return false;
  }
}

/**
 * The one database credential ingest holds, and the only one permitted in GitHub Actions.
 *
 * Named for what it is rather than for Supabase, and deliberately unlike the app's own
 * `DATABASE_URL`, so the two cannot be pasted into each other's place. The role check is what
 * makes the name mean something: the scoping lives in the role, so a `postgres` connection
 * string under this name would be exactly the credential that looks scoped and is not.
 */
const ingestDatabaseSchema = z.object({
  ROLODECK_INGEST_DATABASE_URL: z
    .url({ protocol: /^postgres(ql)?$/ })
    .refine(connectsAsIngestRole, {
      error: `must log in as the ${INGEST_ROLE} role (or ${INGEST_ROLE}.<project-ref> through Supabase's pooler), never as postgres — see docs/adr/0013`,
    }),
});

/**
 * The one account every Profile belongs to. V1 is single-player per CLAUDE.md, but the id is
 * read from the environment rather than compiled in, because it differs between the real
 * project and any scratch one.
 *
 * Getting this wrong is the quietest failure in the app: a Profile written with an `owner_id`
 * nobody signs in as is not wrong-looking, it is invisible — no RLS policy matches it — and
 * ingest, which bypasses RLS on the tables it writes, would never notice. Hence a parse rather
 * than a read.
 *
 * `z.guid()` rather than `z.uuid()`, matching `db/deck.ts`: Postgres's `uuid` type accepts any
 * 128 bits laid out as hex, and a boundary stricter than the column it guards would reject an
 * id the database is perfectly happy to hold.
 */
const ownerSchema = z.object({
  ROLODECK_OWNER_ID: z.guid(),
});

/** Read on every call, not at module scope, so importing an ingest module needs no environment. */
export function readIngestDatabaseUrl(): string {
  return parseEnv(
    ingestDatabaseSchema,
    {
      ROLODECK_INGEST_DATABASE_URL: process.env.ROLODECK_INGEST_DATABASE_URL,
    },
    "Ingest's database connection",
  ).ROLODECK_INGEST_DATABASE_URL;
}

export function readOwnerId(): string {
  return parseEnv(
    ownerSchema,
    { ROLODECK_OWNER_ID: process.env.ROLODECK_OWNER_ID },
    "The account that owns every Profile",
  ).ROLODECK_OWNER_ID;
}
