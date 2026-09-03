import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

import { NOT_SIGNED_IN } from "../api/responses";
import {
  createNonce,
  CSP_HEADER,
  NONCE_HEADER,
  contentSecurityPolicy,
  withSecurityHeaders,
} from "../http/security-headers";
import { readBrowserSafeEnv } from "../supabase/env";
import { HOME_PATH, isApiPath, isPublicPath, LOGIN_PATH } from "./paths";

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
 * Moves any cookies the session refresh just wrote onto the response being sent instead.
 * Dropping them would log the user out on the very request that renewed their tokens.
 */
function carryingCookies(
  response: NextResponse,
  refreshed: NextResponse,
): NextResponse {
  for (const cookie of refreshed.cookies.getAll()) {
    response.cookies.set(cookie);
  }
  for (const [name, value] of Object.entries(NO_STORE)) {
    response.headers.set(name, value);
  }

  return response;
}

/** Sends the browser somewhere else, keeping the refreshed cookies. */
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
  return carryingCookies(
    NextResponse.redirect(
      url,
      request.method === "GET" || request.method === "HEAD" ? 307 : 303,
    ),
    refreshed,
  );
}

/**
 * Passes the request through, carrying the nonce this response's Content-Security-Policy is
 * written against. Next looks for the CSP header on the *request* and stamps the nonce onto the
 * scripts it emits, which is the only way an inline-script-free policy and Next's own inline
 * scripts can both be true. The headers are rebuilt from `request.headers` on each call rather
 * than captured once: `request.cookies.set()` writes through to them, and a stale copy would
 * hand the render downstream the spent tokens.
 */
function passThrough(request: NextRequest, nonce: string): NextResponse {
  const headers = new Headers(request.headers);
  headers.set(NONCE_HEADER, nonce);
  headers.set(CSP_HEADER, contentSecurityPolicy(nonce));

  return NextResponse.next({ request: { headers } });
}

/**
 * The single-account gate. Every request Next routes through the Proxy either carries a valid
 * Supabase session or is turned away — sent to `/login`, or answered 401 if it was a request
 * to a route handler — so the app is never publicly readable even though V1 has exactly one
 * account.
 *
 * This is the optimistic half of the check that Next's authentication guide describes: it
 * centralises the refusal and, just as importantly, is the only place that can write refreshed
 * auth cookies back to the response. The authoritative check is `requireUser()` in
 * `lib/auth/session.ts`, which every gated segment calls for itself, and `authenticated()` in
 * `lib/api/authenticated.ts` for the route handlers, which no layout sits above.
 *
 * It is also where the security headers go on, for the same reason: whichever way this function
 * answers — pass through, redirect or 401 — the answer leaves from here. See docs/adr/0006.
 */
export async function applyAuthGate(
  request: NextRequest,
): Promise<NextResponse> {
  const nonce = createNonce();

  return withSecurityHeaders(await decide(request, nonce), nonce);
}

/** The gate's actual decision: through, to `/login`, or 401. The headers go on afterwards. */
async function decide(
  request: NextRequest,
  nonce: string,
): Promise<NextResponse> {
  const env = readBrowserSafeEnv();

  let response = passThrough(request, nonce);

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

          response = passThrough(request, nonce);

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
    // The route handlers under `/api` answer 401 for themselves as well — see
    // `lib/api/authenticated.ts` — but a request stopped here never reaches them, and a
    // caller that asked for JSON should not be handed the login page with a 200.
    return isApiPath(request.nextUrl.pathname)
      ? carryingCookies(
          NextResponse.json(NOT_SIGNED_IN, { status: 401 }),
          response,
        )
      : redirectCarryingCookies(request, LOGIN_PATH, response);
  }

  if (user !== null && publicRoute) {
    return redirectCarryingCookies(request, HOME_PATH, response);
  }

  return response;
}
