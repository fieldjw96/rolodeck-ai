import { sql } from "drizzle-orm";

import type { Database } from "./connection";
import { persistProfiles, type ProfileCandidate } from "./ingest";
import type { ProfileInput } from "./profile-input";
import type { ProfileProvenance } from "./provenance";
import { profiles } from "./schema";
import { SEED_PROFILES } from "./seed-data";

/**
 * Guarantees a minimum, useful amount of real Profile data regardless of how well the live
 * scrape in #4 went, so the rest of the product is not blocked on an external site's
 * cooperation. See docs/adr/0002.
 *
 * Nothing here fetches or scrapes: every row it can write is already hand-typed in
 * `db/seed-data.ts`, sourced from public knowledge. This module only decides how many of
 * them, if any, the table still needs.
 */

/** The Source name these rows are written under — see docs/adr/0008 for what a Source is. */
export const SEED_SOURCE = "jack-seed";

/** The floor this Ticket exists to guarantee. */
export const MINIMUM_PROFILE_COUNT = 30;

/**
 * Every field on a hand-curated seed row is Jack's own: he typed it from public knowledge,
 * so none of it is `scraped` or `enriched`. `website` is the one field that can have nothing
 * to attribute, matching the rule `profiles_provenance_covers_every_field` enforces in
 * Postgres — see docs/adr/0003.
 */
function jackProvenance(input: ProfileInput): ProfileProvenance {
  return {
    name: "jack",
    description: "jack",
    sector: "jack",
    stage: "jack",
    website: input.website === undefined ? null : "jack",
  };
}

export type SeedFallbackReport = {
  readonly before: number;
  readonly added: number;
  readonly after: number;
};

/**
 * Tops `profiles` up to `minimum` rows with hand-written Profiles, if it is not there
 * already.
 *
 * Idempotent: a table already at or above `minimum` — because #4 alone reached it, or
 * because a previous run of this backfill did — is left untouched, so running this twice in
 * a row adds rows only the first time. The write itself also goes through `persistProfiles`,
 * which is idempotent on `(owner, source, name)` per docs/adr/0008, so a seed row already
 * present from an earlier run is updated in place rather than duplicated.
 */
export async function backfillSeedProfiles(
  db: Database,
  { minimum = MINIMUM_PROFILE_COUNT }: { minimum?: number } = {},
): Promise<SeedFallbackReport> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(profiles);
  const before = row?.count ?? 0;

  if (before >= minimum) {
    return { before, added: 0, after: before };
  }

  const needed = minimum - before;

  if (needed > SEED_PROFILES.length) {
    throw new Error(
      `Only ${SEED_PROFILES.length} seed Profile(s) are on hand, which is not enough to ` +
        `bring ${before} up to ${minimum}. Add more to db/seed-data.ts.`,
    );
  }

  const candidates: ProfileCandidate[] = SEED_PROFILES.slice(0, needed).map(
    (input) => ({ input, provenance: jackProvenance(input) }),
  );

  const report = await persistProfiles(db, {
    source: SEED_SOURCE,
    candidates,
  });

  return { before, added: report.inserted, after: before + report.inserted };
}
