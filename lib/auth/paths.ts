/**
 * The front door. Google SSO is the only advertised way in (docs/adr/0021), so this page
 * carries the Google button and nothing else.
 */
export const LOGIN_PATH = "/login";

/**
 * Where the OAuth round trip comes back to, carrying the authorization code. Public because it
 * is reached *before* a session exists — which is exactly the kind of exception that makes a
 * hardcoded list better than a pattern. See docs/adr/0021.
 */
export const AUTH_CALLBACK_PATH = "/auth/callback";

/**
 * Where the Google button leads. Under `/login`, so it needs no entry of its own below.
 */
export const GOOGLE_SIGN_IN_PATH = "/login/google";

/**
 * The email-and-password form, which survives for the deploy smoke test and for nothing else.
 * Nothing links here: ADR 0013 forbids `SUPABASE_SECRET_KEY` in GitHub Actions, so the smoke
 * test cannot generate a sign-in link and has to type a password, and ADR 0021 keeps that one
 * credential unlisted rather than widening ADR 0013. Under `/login`, so it too needs no entry.
 */
export const PASSWORD_SIGN_IN_PATH = "/login/password";

/**
 * Every route the gate lets through without a session, and the whole of the unauthenticated
 * surface. Two entries, each covering its own subtree: `/login` and the pages and handlers
 * beneath it, and the OAuth callback. Adding a third is a decision, not a detail — see
 * `paths.test.ts`, which asserts this list by value.
 */
export const PUBLIC_PATHS = [LOGIN_PATH, AUTH_CALLBACK_PATH] as const;

/** Where the gate sends a signed-in user who lands on `/login`. */
export const HOME_PATH = "/deck";

/** Everything under here is a route handler, and answers in JSON. */
export const API_PREFIX = "/api";

/** True for the routes the gate lets through without a session. */
export function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.some(
    (path) => pathname === path || pathname.startsWith(`${path}/`),
  );
}

/**
 * True for the routes where turning a request away means 401 rather than a redirect: a fetch
 * follows a redirect, so a gated endpoint that redirected would answer a caller expecting
 * JSON with the HTML of the login page, and a 200.
 */
export function isApiPath(pathname: string): boolean {
  return pathname === API_PREFIX || pathname.startsWith(`${API_PREFIX}/`);
}
