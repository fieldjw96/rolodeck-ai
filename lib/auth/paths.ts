/**
 * The one route that is reachable without a session. V1 is single-player and there is no
 * sign-up — the account is provisioned by `scripts/provision-account.ts` — so `/login` is
 * the whole of the unauthenticated surface.
 */
export const LOGIN_PATH = "/login";

/** Where the gate sends a signed-in user who lands on `/login`. */
export const HOME_PATH = "/";

/** True for the routes the gate lets through without a session. */
export function isPublicPath(pathname: string): boolean {
  return pathname === LOGIN_PATH || pathname.startsWith(`${LOGIN_PATH}/`);
}
