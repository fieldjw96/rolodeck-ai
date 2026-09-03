import "server-only";

import type { User } from "@supabase/supabase-js";
import type { NextRequest } from "next/server";

import { getSessionUser } from "../auth/session";
import { unauthorized } from "./responses";

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
 */
export function authenticated<Context>(
  handler: AuthenticatedHandler<Context>,
): (request: NextRequest, context: Context) => Promise<Response> {
  return async (request, context) => {
    const user = await getSessionUser();

    if (user === null) {
      return unauthorized();
    }

    return handler(request, user, context);
  };
}
