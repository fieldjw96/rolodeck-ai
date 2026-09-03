import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

import { readBrowserSafeEnv } from "../supabase/env";
import { HOME_PATH, isPublicPath, LOGIN_PATH } from "./paths";

/**
 * A response that sets auth cookies must never be cached by a CDN or a reverse proxy, or one
 * visitor's session token gets served to the next. `@supabase/ssr` hands these headers to
 * `setAll`; a redirect carrying refreshed cookies needs them just as much.
 */
const NO_STORE: Record<string, string> = {
  "Cache-Control": "private, no-cache, no-store, must-revalidate, max-age=0",
  Expires: "0",
  Pragma: "no-cache",
};

/**
 * Sends the browser somewhere else while keeping any cookies the session refresh just wrote.
 * Dropping them would log the user out on the very request that renewed their tokens.
 */
function redirectCarryingCookies(
  request: NextRequest,
  pathname: string,
  refreshed: NextResponse,
): NextResponse {
  const url = request.nextUrl.clone();
  url.pathname = pathname;
  // The query goes too: it belongs to the route being left, and reflecting whatever was in it
  // onto `/login` is how a redirect turns into somebody else's payload.
  url.search = "";

  // 307 preserves the method, which is right for a navigation and wrong for a form submitted
  // after a session quietly expired — that would re-POST the body at `/login`. 303 turns those
  // into the GET the browser actually wants.
  const response = NextResponse.redirect(
    url,
    request.method === "GET" || request.method === "HEAD" ? 307 : 303,
  );

  for (const cookie of refreshed.cookies.getAll()) {
    response.cookies.set(cookie);
  }
  for (const [name, value] of Object.entries(NO_STORE)) {
    response.headers.set(name, value);
  }

  return response;
}

/**
 * The single-account gate. Every request Next routes through the Proxy either carries a valid
 * Supabase session or is sent to `/login`, so the app is never publicly readable even though
 * V1 has exactly one account.
 *
 * This is the optimistic half of the check that Next's authentication guide describes: it
 * centralises the redirect and, just as importantly, is the only place that can write
 * refreshed auth cookies back to the response. The authoritative check is `requireUser()` in
 * `lib/auth/session.ts`, which every gated segment calls for itself.
 */
export async function applyAuthGate(
  request: NextRequest,
): Promise<NextResponse> {
  const env = readBrowserSafeEnv();

  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (cookiesToSet, headers) => {
          // The refreshed cookies go onto the request as well as the response, so that the
          // render downstream of the Proxy reads the new tokens rather than the spent ones.
          for (const { name, value } of cookiesToSet) {
            request.cookies.set(name, value);
          }

          response = NextResponse.next({ request });

          for (const { name, value, options } of cookiesToSet) {
            response.cookies.set(name, value, options);
          }
          for (const [name, value] of Object.entries(headers)) {
            response.headers.set(name, value);
          }
        },
      },
    },
  );

  // `getUser()`, not `getSession()`: it revalidates the token against Supabase Auth instead
  // of trusting a cookie the browser handed us, which is the whole point of a gate.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const publicRoute = isPublicPath(request.nextUrl.pathname);

  if (user === null && !publicRoute) {
    return redirectCarryingCookies(request, LOGIN_PATH, response);
  }

  if (user !== null && publicRoute) {
    return redirectCarryingCookies(request, HOME_PATH, response);
  }

  return response;
}
