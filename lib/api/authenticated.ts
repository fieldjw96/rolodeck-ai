import "server-only";

import type { User } from "@supabase/supabase-js";
import type { NextRequest } from "next/server";

import { getSessionUser } from "../auth/session";
import { apiRateLimiter } from "./rate-limit";
import { tooManyRequests, unauthorized } from "./responses";

export type AuthenticatedHandler<Context> = (
  request: NextRequest,
  user: User,
  context: Context,
) => Promise<Response>;

/**
 * Wraps a route handler so it only ever runs with a signed-in user, and hands it that user
 * rather than making it ask again.
 *
 * This is ADR 0004's second check, in the one place that check cannot be a layout: route
 * handlers sit outside the `(app)` segment, so nothing above them calls `requireUser()`. The
 * Proxy already turns an unauthenticated request away, but Next documents the Proxy as an
 * optimistic filter — a matcher change would silently uncover every endpoint under `/api`,
 * and this is what makes that a non-event.
 *
 * The user comes from `getSessionUser()`, which revalidates the token against Supabase Auth,
 * and is what the query then presents to Postgres as `auth.uid()`. See `db/rls.ts`.
 *
 * It is also where the rate limit is spent, which is why the limit is per authenticated user
 * and not per IP: this is the one place every endpoint under `/api` passes through, and by the
 * time it runs there is a user to key on. Wrapping here rather than in the Proxy is the same
 * argument ADR 0004 makes — a matcher is a regex somebody can change, and the wrapper is the
 * code being protected. See docs/adr/0006.
 */
export function authenticated<Context>(
  handler: AuthenticatedHandler<Context>,
): (request: NextRequest, context: Context) => Promise<Response> {
  return async (request, context) => {
    const user = await getSessionUser();

    if (user === null) {
      return unauthorized();
    }

    // After the session check, so an unauthenticated caller cannot spend a real account's
    // budget, and so the limit is keyed on an identity Supabase Auth has just confirmed.
    const budget = apiRateLimiter.check(user.id);

    if (!budget.allowed) {
      return tooManyRequests(budget.retryAfterSeconds);
    }

    return handler(request, user, context);
  };
}
