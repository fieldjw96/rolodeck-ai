import { z } from "zod";

/**
 * The fixed set of funding stages a Profile can be in. Named and closed rather than a free
 * string, so a source's own spelling ("Series A", "series_a") cannot fragment the Deck's
 * notion of stage.
 */
export const STAGE_VALUES = [
  "pre-seed",
  "seed",
  "series-a",
  "series-b-plus",
  "growth",
] as const;

export const stageSchema = z.enum(STAGE_VALUES);

export type Stage = z.infer<typeof stageSchema>;

/**
 * The one shared boundary schema for anything that produces a Profile: scraper, seed loader,
 * and future enrichment all validate against this before a value reaches Postgres. Per
 * CLAUDE.md, scraped data is hostile, so a source that changes shape must fail loudly here,
 * naming the field, rather than let an `undefined` propagate into a Profile.
 */
const nonBlankString = z
  .string()
  .min(1)
  .refine((value) => value.trim().length > 0, {
    message: "must not be blank",
  });

export const profileInputSchema = z.strictObject({
  name: nonBlankString,
  description: nonBlankString,
  sector: nonBlankString,
  stage: stageSchema,
  // Restricted to http(s) rather than any URL scheme z.url() would otherwise accept, so a
  // scraped `javascript:` or `data:` value is rejected here instead of surviving as a
  // Profile's website.
  website: z.url({ protocol: /^https?$/ }).optional(),
});

export type ProfileInput = z.infer<typeof profileInputSchema>;

/**
 * What crosses the boundary instead of a bare ZodError: which field was wrong, why, and the
 * raw input that failed, so a caller can log or quarantine a rejected source record without
 * depending on Zod's own error shape.
 */
export type IngestRejection = {
  readonly field: string;
  readonly reason: string;
  readonly raw: unknown;
};

export type ProfileInputResult =
  | { readonly success: true; readonly data: ProfileInput }
  | { readonly success: false; readonly rejection: IngestRejection };

/**
 * Names the field an issue belongs to. Most issues carry a path, but a `strictObject`
 * reports an extra key or a non-object payload at the root (`path: []`), where `path.join`
 * would silently produce an empty string and defeat the "name the offending field" rule
 * this schema exists to enforce.
 */
function issueField(issue: z.core.$ZodIssue): string {
  if (issue.path.length > 0) {
    return issue.path.join(".");
  }
  if (issue.code === "unrecognized_keys") {
    return issue.keys.join(", ");
  }
  return "(root)";
}

/**
 * Parses a raw, untrusted record against `profileInputSchema`, reporting the first offending
 * field rather than the full ZodError so every ingest path handles one small, typed shape.
 */
export function parseProfileInput(raw: unknown): ProfileInputResult {
  const result = profileInputSchema.safeParse(raw);

  if (result.success) {
    return { success: true, data: result.data };
  }

  // A failed safeParse always carries at least one issue.
  const issue = result.error.issues[0]!;
  return {
    success: false,
    rejection: {
      field: issueField(issue),
      reason: issue.message,
      raw,
    },
  };
}
