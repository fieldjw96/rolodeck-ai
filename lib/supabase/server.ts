import "server-only";

import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

import { readBrowserSafeEnv } from "./env";

/**
 * The request-scoped Supabase client, carrying the signed-in user's session. Everything it
 * reads or writes goes through RLS, which is what CLAUDE.md's "nothing in the browser talks
 * to Postgres directly" rule leaves for the server to do.
 *
 * Build a new one per render or per handler. Hoisting it to module scope would let one
 * request's session serve another's.
 */
export async function createSupabaseServerClient() {
  // Awaited before the environment is read so that a static render bails out on `cookies()`
  // — the signal Next expects — rather than on a missing variable during `next build`.
  const cookieStore = await cookies();
  const env = readBrowserSafeEnv();

  return createServerClient(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    {
      cookies: {
        getAll: () => cookieStore.getAll(),
        setAll: (cookiesToSet) => {
          try {
            for (const { name, value, options } of cookiesToSet) {
              cookieStore.set(name, value, options);
            }
          } catch {
            // Server Components cannot write cookies, and Next throws when they try. The
            // Proxy refreshes the session on every matched request, so a refresh dropped
            // here has already been persisted there.
          }
        },
      },
    },
  );
}
