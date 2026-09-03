import type { z } from "zod";

import { issueField } from "../zod/issues";

/**
 * The one shape every failure from a route handler takes: a stable `error` code a caller can
 * branch on, plus whatever detail is useful to a human reading the response.
 */
export type ApiError = {
  error: string;
  field?: string;
  reason?: string;
};

/**
 * The body of every 401 the app sends, from the route handlers and from the Proxy's gate
 * alike, so a caller sees one answer to "no session" wherever the request was stopped.
 */
export const NOT_SIGNED_IN = { error: "not signed in" } satisfies ApiError;

/**
 * No session, so no answer. A route handler returns this rather than calling `requireUser()`:
 * a redirect to `/login` is the right reply to a browser navigating, and the wrong one to a
 * fetch, which would follow it and get HTML where it asked for JSON.
 */
export function unauthorized(): Response {
  return Response.json(NOT_SIGNED_IN, { status: 401 });
}

/** No such Profile, or none this user can see — deliberately the same answer for both. */
export function notFound(): Response {
  return Response.json({ error: "not found" } satisfies ApiError, {
    status: 404,
  });
}

/**
 * Input that arrived intact but did not survive its Zod schema. 422 rather than 400: the
 * request parsed, it just asked for something the endpoint will not do. Only the first issue
 * is reported, and it names its field, so a caller is told what to fix rather than handed
 * Zod's own error shape.
 */
export function unprocessable(error: z.ZodError): Response {
  // A failed safeParse always carries at least one issue.
  const issue = error.issues[0]!;

  return Response.json(
    {
      error: "invalid request",
      field: issueField(issue),
      reason: issue.message,
    } satisfies ApiError,
    { status: 422 },
  );
}
