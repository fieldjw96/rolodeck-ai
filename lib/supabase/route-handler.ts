import "server-only";

import { createServerClient, type CookieOptions } from "@supabase/ssr";
import type { NextRequest, NextResponse } from "next/server";

import { withNoStore } from "../http/no-store";
import { readBrowserSafeEnv } from "./env";

/** A cookie `@supabase/ssr` asked us to write, in the shape its `setAll` hands them over. */
type CookieToSet = { name: string; value: string; options: CookieOptions };

export type RouteHandlerSupabase = {
  supabase: ReturnType<typeof createServerClient>;
  /**
   * Moves the cookies the client wrote onto the response being sent, and marks it uncacheable.
   * A sign-in that dropped them would establish a session nowhere.
   */
  carryCookies: (response: NextResponse) => NextResponse;
};

/**
 * A Supabase client for a Route Handler that *writes* a session: the two halves of the OAuth
 * round trip, which mint a PKCE verifier on the way out and the session itself on the way back.
 *
 * Unlike `createSupabaseServerClient()` this reads the request's cookies off the `NextRequest`
 * and hands the ones it writes back to the caller, instead of going through `cookies()` from
 * `next/headers` and trusting Next to merge those writes into a `NextResponse.redirect` the
 * handler returns. The gate in `lib/auth/gate.ts` already does it this way for the same reason:
 * when the whole value of a response is the `Set-Cookie` on it, it should be put there by code
 * that can be read, and by a test that can see it.
 */
export function supabaseForRouteHandler(
  request: NextRequest,
): RouteHandlerSupabase {
  const env = readBrowserSafeEnv();
  const written: CookieToSet[] = [];

  const supabase = createServerClient(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (cookiesToSet) => {
          written.push(...cookiesToSet);
        },
      },
    },
  );

  return {
    supabase,
    carryCookies: (response) => {
      for (const { name, value, options } of written) {
        response.cookies.set(name, value, options);
      }

      return withNoStore(response);
    },
  };
}
