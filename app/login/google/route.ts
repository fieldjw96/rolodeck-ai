import { NextResponse, type NextRequest } from "next/server";

import { AUTH_CALLBACK_PATH, LOGIN_PATH } from "../../../lib/auth/paths";
import { requestOrigin } from "../../../lib/http/request-origin";
import { supabaseForRouteHandler } from "../../../lib/supabase/route-handler";
import type { OAuthError } from "../errors";

/**
 * Starts the Google round trip. `signInWithOAuth` makes no network call of its own: it mints a
 * PKCE verifier, stores it in a cookie through `@supabase/ssr`, and hands back the Supabase
 * `/auth/v1/authorize` URL to send the browser to. Both halves matter — the verifier cookie is
 * what `app/auth/callback/route.ts` later spends, so a response that dropped it would send
 * somebody to Google and have nothing to exchange when they came back.
 *
 * A GET handler rather than a Server Action because the login page reaches it with a link: see
 * `app/login/google-sign-in.tsx` on `form-action 'self'`.
 *
 * Nothing here is allowed to throw its way out. A route handler that throws is answered with a
 * 500 and an opaque Next error digest, which is no way to tell somebody that the one button on
 * the page did not work — and the one thing that can throw is reading the environment, which
 * means the whole deployment is misconfigured and the message should say so.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    return await startSignIn(request);
  } catch (error) {
    console.error(error);

    return backToLogin(request, "unavailable");
  }
}

async function startSignIn(request: NextRequest): Promise<NextResponse> {
  const { supabase, carryCookies } = supabaseForRouteHandler(request);

  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: {
      // Supabase's own callback is where Google returns to; this is where Supabase then
      // returns to, and it must be on the project's redirect allow-list.
      redirectTo: `${requestOrigin(request)}${AUTH_CALLBACK_PATH}`,
      // Only what ADR 0021 says the consent screen asks for. Requesting more here than the
      // Google project is configured for is what puts the unverified-app warning in front of
      // a beta user, and `openid email profile` are the non-sensitive three.
      scopes: "openid email profile",
    },
  });

  if (error !== null) {
    return carryCookies(backToLogin(request, "unavailable"));
  }

  return carryCookies(NextResponse.redirect(data.url));
}

function backToLogin(request: NextRequest, error: OAuthError): NextResponse {
  const url = new URL(`${LOGIN_PATH}?error=${error}`, requestOrigin(request));

  // 303, not the default 307: whatever the browser did to get here, what it wants next is a
  // GET of the login page.
  return NextResponse.redirect(url, 303);
}
