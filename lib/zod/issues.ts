import type { z } from "zod";

/**
 * Names the field an issue belongs to. Most issues carry a path, but a `strictObject` reports
 * an extra key or a non-object payload at the root (`path: []`), where `path.join` would
 * silently produce an empty string and defeat the rule this exists to serve: a boundary
 * rejects input by naming the offending field, never with a bare "invalid".
 *
 * Shared by both boundaries that do so — the ingest schema in `db/profile-input.ts` and the
 * route handlers' 422 in `lib/api/responses.ts` — so the two cannot drift apart.
 */
export function issueField(issue: z.core.$ZodIssue): string {
  if (issue.path.length > 0) {
    return issue.path.join(".");
  }
  if (issue.code === "unrecognized_keys") {
    return issue.keys.join(", ");
  }
  return "(root)";
}
