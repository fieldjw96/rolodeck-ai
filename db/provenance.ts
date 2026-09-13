import { z } from "zod";

/**
 * Where a Profile field's value came from. See CONTEXT.md: Provenance is carried per field,
 * not per Profile, so a hand-corrected `name` can sit next to a `sector` that is still
 * whatever the scraper found.
 */
export const PROVENANCE_VALUES = ["scraped", "enriched", "jack"] as const;

export const provenanceSchema = z.enum(PROVENANCE_VALUES);

export type Provenance = z.infer<typeof provenanceSchema>;

/**
 * The Profile fields that carry provenance: every column sourced from the outside world.
 * `id` is a key and `created_at` is assigned by Postgres, so neither came from anywhere a
 * provenance value could describe.
 */
export const PROVENANCED_FIELDS = [
  "name",
  "description",
  "sector",
  "stage",
  "website",
  "location",
] as const;

export type ProvenancedField = (typeof PROVENANCED_FIELDS)[number];

/**
 * `website` and `location` are the two nullable Profile fields, so they are the two fields
 * whose provenance can be null: a Profile with no website, or no stated place, has no source
 * to record for it.
 */
export const profileProvenanceSchema = z.strictObject({
  name: provenanceSchema,
  description: provenanceSchema,
  sector: provenanceSchema,
  stage: provenanceSchema,
  website: provenanceSchema.nullable(),
  location: provenanceSchema.nullable(),
});

export type ProfileProvenance = z.infer<typeof profileProvenanceSchema>;
