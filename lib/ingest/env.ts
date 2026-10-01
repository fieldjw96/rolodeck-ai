import { z } from "zod";

import {
  carriesOnlyPermittedParameters,
  connectsAsRole,
} from "../env/connection-string";
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
    .refine((value) => connectsAsRole(value, INGEST_ROLE), {
      error: `must log in as the ${INGEST_ROLE} role (or ${INGEST_ROLE}.<project-ref> through Supabase's pooler), never as postgres — see docs/adr/0013`,
    })
    .refine(carriesOnlyPermittedParameters, {
      error: `may carry no query parameter but sslmode, because any other is sent to Postgres at login and ?user= replaces the ${INGEST_ROLE} login — see docs/adr/0013`,
    }),
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
