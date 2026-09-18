import { z } from "zod";

import type { IngestRejection, ProfileInput } from "../../db/profile-input";
import type {
  NullableField,
  ProfileProvenance,
  Provenance,
  ProvenancedField,
} from "../../db/provenance";

/**
 * What every Source produces, and how it says where each field came from.
 *
 * Source-independent on purpose: a YC company page and an SEC Form D have nothing in common
 * about how they are fetched or parsed, but they agree completely about what comes out the
 * other end, and about the fact that provenance is carried per field rather than per Profile.
 * Keeping that agreement in one module is what lets `db/ingest.ts` take one shape from all of
 * them — see docs/adr/0003 and docs/adr/0008.
 */

/**
 * Where a fixture, or a live fetch, came from. The captured document itself carries no record
 * of when it was retrieved, so provenance only survives if the caller supplies it alongside —
 * which is what the `.meta.json` sibling of each fixture is for.
 */
export const captureSchema = z.strictObject({
  sourceUrl: z.url({ protocol: /^https?$/ }),
  capturedAt: z.iso.date(),
});

export type Capture = z.infer<typeof captureSchema>;

/**
 * Provenance for one Profile field, per CONTEXT.md: carried per field rather than per Profile,
 * and recording not just *what kind* of value it is but the document and the day it came from,
 * so a Profile stays auditable long after the source has moved on.
 */
export type FieldProvenance = Capture & {
  readonly provenance: Provenance;
};

/**
 * A field with no value has no provenance: the optional Profile fields, `NULLABLE_FIELDS` in
 * `db/provenance.ts`, are the entries that can be null here. This mirrors the shape the
 * `profiles` check constraint enforces — see docs/adr/0003.
 */
export type ProfileAttribution = Readonly<
  Record<Exclude<ProvenancedField, NullableField>, FieldProvenance>
> & {
  readonly [Field in NullableField]: FieldProvenance | null;
};

export type ScrapedProfile = {
  readonly input: ProfileInput;
  readonly attribution: ProfileAttribution;
};

/**
 * One parsed document: the validated record, or the single field that stopped it. Every Source
 * parser returns this, so "a bad record is counted with its field named, never half-written"
 * is one shape rather than one per Source.
 */
export type ScrapedProfileResult =
  | { readonly success: true; readonly profile: ScrapedProfile }
  | { readonly success: false; readonly rejection: IngestRejection };

export function attribute(
  capture: Capture,
  provenance: Provenance,
): FieldProvenance {
  return { ...capture, provenance };
}

/**
 * Narrows per-field attribution to the shape the `profiles.provenance` jsonb column takes,
 * dropping the source URL and capture date the column has no room for. The bridge lives here
 * so that the richer record is what ingest works with and the column stays exactly as
 * docs/adr/0003 defines it.
 */
export function toProfileProvenance(
  attribution: ProfileAttribution,
): ProfileProvenance {
  return {
    name: attribution.name.provenance,
    description: attribution.description.provenance,
    sector: attribution.sector.provenance,
    stage: attribution.stage.provenance,
    website: attribution.website?.provenance ?? null,
    location: attribution.location?.provenance ?? null,
    founders: attribution.founders?.provenance ?? null,
    links: attribution.links?.provenance ?? null,
  };
}
