import { z } from "zod";

import { issueField } from "../lib/zod/issues";

/**
 * The funding stages a Source can state or a pipeline can derive, and so the ones an owner can
 * state a preference for. Named and closed rather than a free string, so a source's own
 * spelling ("Series A", "series_a") cannot fragment the Deck's notion of stage.
 */
export const STATED_STAGE_VALUES = [
  "pre-seed",
  "seed",
  "series-a",
  "series-b-plus",
  "growth",
] as const;

/** The stage of a Company Profile whose Source neither stated one nor gave us one to derive. */
export const NOT_STATED_STAGE = "not-stated";

/**
 * The fixed set of values a Company Profile's `stage` can hold. `not-stated` is deliberate, for
 * the reason `SECTOR_VALUES` carries `other`: ingest must be able to place every row, and a
 * visible `not-stated` is honest where a silent guess is not — or where throwing away a company
 * that is provably raising, for want of one derived field, is no answer at all. See
 * docs/adr/0015.
 *
 * Position in this array carries no meaning. `db/deck.ts` ranks a stage with `inArray`, a set
 * membership test, and never compares two stages as more or less advanced; the one place that
 * does, `lib/ingest/stage.ts`, keeps its own ladder.
 */
export const STAGE_VALUES = [...STATED_STAGE_VALUES, NOT_STATED_STAGE] as const;

export const stageSchema = z.enum(STAGE_VALUES);

export type Stage = z.infer<typeof stageSchema>;

/**
 * A stage an owner can prefer. `not-stated` is not one: it says a Source was silent, not what
 * a company is, so a User Profile preferring it would rank companies by what we failed to learn.
 */
export const statedStageSchema = z.enum(STATED_STAGE_VALUES, {
  error: (issue) =>
    `must be one of the stated Stage values, not ${JSON.stringify(issue.input)}`,
});

export type StatedStage = z.infer<typeof statedStageSchema>;

/**
 * The controlled vocabulary a Company Profile's `sector` is ranked against. Closed for the
 * same reason `Stage` is: a source's own spelling — "Artificial Intelligence" next to "Machine
 * Learning", "SaaS" next to "Enterprise Software" — cannot be allowed to fragment what ranking
 * against a stated preference means. `other` is deliberate: ingest must be able to place every
 * row, and a visible `other` is honest where a silent mis-map is not. See CONTEXT.md.
 */
export const SECTOR_VALUES = [
  "ai-ml",
  "developer-tools",
  "data-infrastructure",
  "saas-enterprise",
  "fintech",
  "health-bio",
  "security",
  "hardware-robotics",
  "climate-energy",
  "consumer-marketplace",
  "vertical-saas",
  "other",
] as const;

export const sectorSchema = z.enum(SECTOR_VALUES, {
  // The default enum message lists the valid options but not what was actually sent; naming
  // the offending value here is what lets a rejection be diagnosed from the log line alone.
  error: (issue) =>
    `must be one of the controlled Sector values, not ${JSON.stringify(issue.input)}`,
});

export type Sector = z.infer<typeof sectorSchema>;

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
  sector: sectorSchema,
  stage: stageSchema,
  // Restricted to http(s) rather than any URL scheme z.url() would otherwise accept, so a
  // scraped `javascript:` or `data:` value is rejected here instead of surviving as a
  // Profile's website.
  website: z.url({ protocol: /^https?$/ }).optional(),
  // A human-readable place — "San Francisco, CA" — not a query result to geocode. Optional
  // because not every Source states one; see docs/adr/0002 on not inventing what a Source
  // never said.
  location: nonBlankString.optional(),
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
      field: issueField(issue),
      reason: issue.message,
      raw,
    },
  };
}
