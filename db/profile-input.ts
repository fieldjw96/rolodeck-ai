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
export const profileInputSchema = z.strictObject({
  name: z.string().min(1),
  description: z.string().min(1),
  sector: z.string().min(1),
  stage: stageSchema,
  website: z.url().optional(),
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
      field: issue.path.join("."),
      reason: issue.message,
      raw,
    },
  };
}
