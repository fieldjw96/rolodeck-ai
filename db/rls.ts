import { sql } from "drizzle-orm";

import type { Database } from "./connection";

/**
 * Runs `query` as the signed-in user rather than as the connection's own role: `authenticated`,
 * with `request.jwt.claims` carrying their id, which is exactly what `auth.uid()` reads and
 * therefore what every RLS policy in `db/schema.ts` matches on.
 *
 * Both settings are transaction-local, so they are gone the moment the transaction ends and
 * cannot leak onto the next request that borrows the same pooled connection. The claims are
 * set before the role switch because `authenticated` may not have the privilege to set them.
 *
 * `userId` must come from `getSessionUser()`, which revalidates the token against Supabase
 * Auth. Anything else here would be asking Postgres to trust a string the browser chose.
 */
export async function asUser<T>(
  db: Database,
  userId: string,
  query: (tx: Database) => Promise<T>,
): Promise<T> {
  const claims = JSON.stringify({ sub: userId });

  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select set_config('request.jwt.claims', ${claims}, true)`,
    );
    // A literal, never interpolated: a role name cannot be a bind parameter, so the only
    // safe way to write this is for the name to be fixed here in the source.
    await tx.execute(sql`set local role authenticated`);

    return query(tx);
  });
}
