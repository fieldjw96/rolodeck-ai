import type { Database } from "../connection";
import type { ProfileProvenance } from "../provenance";
import { profiles } from "../schema";

/** Valid provenance for every field of a seeded Profile, which has no website to attribute. */
export const SEEDED_PROVENANCE: ProfileProvenance = {
  name: "scraped",
  description: "scraped",
  sector: "enriched",
  stage: "jack",
  website: null,
};

/** Far enough apart that "newest first" is a fact about the data, not about insert order. */
export const FIRST_CREATED_AT = Date.UTC(2026, 0, 1, 9, 0, 0);
const A_MINUTE = 60_000;

/** The name the `index`-th seeded Profile carries, so a test can assert on order by name. */
export const seededName = (index: number) => `Startup ${index}`;

/**
 * `count` Profiles, oldest first: `seedProfiles(3)` returns the ids of Startup 0, 1 and 2, and
 * the Deck deals them back in the opposite order. Written as the superuser, which bypasses
 * RLS — a test arranging its fixtures is not the thing under test.
 *
 * Once per owner: the names repeat, and `(owner_id, source, name_key)` is unique per
 * docs/adr/0008, so a second call for the same owner is a duplicate and Postgres says so.
 */
export async function seedProfiles(
  db: Database,
  { count, ownerId }: { count: number; ownerId: string },
): Promise<string[]> {
  const written = await db
    .insert(profiles)
    .values(
      Array.from({ length: count }, (_unused, index) => ({
        ownerId,
        source: "seed",
        name: seededName(index),
        description: "Seeded for the Deck.",
        sector: "hardware-robotics",
        stage: "seed",
        website: null,
        provenance: SEEDED_PROVENANCE,
        createdAt: new Date(FIRST_CREATED_AT + index * A_MINUTE),
      })),
    )
    .returning({ id: profiles.id });

  return written.map((row) => row.id);
}
