import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { readBrowserSafeEnv, readSecretKey } from "./env";

/**
 * The secret-key client. It bypasses RLS entirely, so per CLAUDE.md it belongs to the ingest
 * and account-provisioning paths that run on the server laptop — never to a request handler
 * acting on behalf of a browser, and never to anything that could reach a client bundle.
 *
 * Deliberately not marked `server-only`: `scripts/` runs this under plain Node, outside
 * React's server condition, where that package throws. `lib/supabase/client-boundary.test.ts`
 * is what holds the line instead, by proving nothing under `app/` imports this module.
 */
export function createSupabaseAdminClient(): SupabaseClient {
  const { NEXT_PUBLIC_SUPABASE_URL } = readBrowserSafeEnv();

  return createClient(NEXT_PUBLIC_SUPABASE_URL, readSecretKey(), {
    // No browser here, so there is no session to persist and nothing to refresh in the
    // background: every call authenticates with the secret key itself.
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
