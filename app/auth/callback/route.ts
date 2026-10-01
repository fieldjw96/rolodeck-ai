import { NextResponse, type NextRequest } from "next/server";

import { HOME_PATH, LOGIN_PATH } from "../../../lib/auth/paths";
import { requestOrigin } from "../../../lib/http/request-origin";
import { supabaseForRouteHandler } from "../../../lib/supabase/route-handler";
import type { OAuthError } from "../../login/errors";

/**
 * Where the Google round trip lands. Google returns to Supabase, Supabase returns here with an
 * authorization code, and this handler trades it for a session using the PKCE verifier
 * `app/login/google/route.ts` put in a cookie on the way out.
 *
 * Every way this can fail ends on `/login?error=…` with a message somebody can act on. That is
 * the point of it being a handler and not a page: a page that threw would answer a cancelled
 * consent screen with a 500 and an opaque Next error digest, which tells a beta user nothing.
 *
 * A brand new Google identity needs nothing else to happen here. Supabase Auth creates the user
 * on the first exchange, and because Google asserts a verified email it is confirmed in the
 * database directly, with no mail sent — which is what lets sign-up be open with no SMTP
 * provider at all (docs/adr/0021). The same identity signing in again resolves to the same
 * user, because Supabase keys it on the provider and the provider's subject id.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const parameters = request.nextUrl.searchParams;

  // Google's own refusals and cancellations arrive as `error`/`error_description`, not as an
  // exception. `access_denied` is the Cancel button.
  if (parameters.has("error") || parameters.has("error_description")) {
    return backToLogin(request, "declined");
  }

  const code = parameters.get("code");

  if (code === null || code.length === 0) {
    return backToLogin(request, "no-code");
  }

  const { supabase, carryCookies } = supabaseForRouteHandler(request);
  const { error } = await supabase.auth.exchangeCodeForSession(code);

  if (error !== null) {
    // An expired code, a replayed one, or a request arriving without the verifier cookie that
    // was minted with it — a link somebody forwarded, most likely.
    return carryCookies(backToLogin(request, "exchange"));
  }

  // The session cookies go out on this redirect; the gate takes it from here.
  return carryCookies(
    NextResponse.redirect(new URL(HOME_PATH, requestOrigin(request)), 303),
  );
}

function backToLogin(request: NextRequest, error: OAuthError): NextResponse {
  return NextResponse.redirect(
    new URL(`${LOGIN_PATH}?error=${error}`, requestOrigin(request)),
    303,
  );
}
