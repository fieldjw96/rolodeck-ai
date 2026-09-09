import "server-only";

import type { User } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { logLine } from "../observability/log";
import { getSessionUser } from "../auth/session";
import { apiRateLimiter } from "./rate-limit";
import { tooManyRequests, unauthorized } from "./responses";

export type AuthenticatedHandler<Context> = (
  request: NextRequest,
  user: User,
  context: Context,
) => Promise<Response>;

/** One structured line for whatever this request answered — 401, 429, or the handler's own
 * response — so every path through `authenticated()` leaves the same trail. */
function logRequest(
  request: NextRequest,
  response: Response,
  startedAt: number,
  userId: string | undefined,
): void {
  logLine({
    level: "info",
    method: request.method,
    path: request.nextUrl.pathname,
    status: response.status,
    duration_ms: Math.round(performance.now() - startedAt),
    ...(userId === undefined ? {} : { user_id: userId }),
  });
}

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
 *
 * Ticket #14: this is also the one place every route handler passes through both before and
 * after it runs, which is what makes it the shared error boundary as well as the gate. A
 * throw the handler never catches is caught here, logged with its stack trace and a request id
 * nothing else in the response carries, and turned into a 500 that names only that id — never
 * the message or the stack — so a production incident is diagnosable from the log rather than
 * from what a caller was handed.
 */
export function authenticated<Context>(
  handler: AuthenticatedHandler<Context>,
): (request: NextRequest, context: Context) => Promise<Response> {
  return async (request, context) => {
    const startedAt = performance.now();
    let userId: string | undefined;

    try {
      const user = await getSessionUser();

      if (user === null) {
        const response = unauthorized();
        logRequest(request, response, startedAt, userId);
        return response;
      }

      userId = user.id;

      // After the session check, so an unauthenticated caller cannot spend a real account's
      // budget, and so the limit is keyed on an identity Supabase Auth has just confirmed.
      const budget = apiRateLimiter.check(user.id);

      if (!budget.allowed) {
        const response = tooManyRequests(budget.retryAfterSeconds);
        logRequest(request, response, startedAt, userId);
        return response;
      }

      const response = await handler(request, user, context);
      logRequest(request, response, startedAt, userId);
      return response;
    } catch (error) {
      const requestId = randomUUID();

      logLine({
        level: "error",
        method: request.method,
        path: request.nextUrl.pathname,
        status: 500,
        duration_ms: Math.round(performance.now() - startedAt),
        ...(userId === undefined ? {} : { user_id: userId }),
        request_id: requestId,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });

      return Response.json({ request_id: requestId }, { status: 500 });
    }
  };
}
