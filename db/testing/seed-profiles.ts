import type { Database } from "../connection";
import type { CompanyLinks, Founder } from "../profile-input";
import type { ProfileProvenance } from "../provenance";
import { profiles } from "../schema";

/** Valid provenance for every field of a seeded Profile, which has no website or location to
 * attribute. */
export const SEEDED_PROVENANCE: ProfileProvenance = {
  name: "scraped",
  description: "scraped",
  sector: "enriched",
  stage: "jack",
  website: null,
  location: null,
  founders: null,
  links: null,
};

/** Far enough apart that "newest first" is a fact about the data, not about insert order. */
export const FIRST_CREATED_AT = Date.UTC(2026, 0, 1, 9, 0, 0);
const A_MINUTE = 60_000;

/** The name the `index`-th seeded Profile carries, so a test can assert on order by name. */
export const seededName = (index: number) => `Startup ${index}`;

/**
 * `count` Company Profiles, oldest first: `seedProfiles(3)` returns the ids of Startup 0, 1 and
 * 2, and the Deck deals them back in the opposite order. Written as the superuser, which
 * bypasses RLS — a test arranging its fixtures is not the thing under test.
 *
 * Once per scratch database, not once per User: the names repeat, `(source, name_key)` is
 * unique per docs/adr/0008, and nothing owns a Company Profile any more (docs/adr/0019), so a
 * second call is a duplicate and Postgres says so.
 */
export async function seedProfiles(
  db: Database,
  { count }: { count: number },
): Promise<string[]> {
  const written = await db
    .insert(profiles)
    .values(
      Array.from({ length: count }, (_unused, index) => ({
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

/**
 * One Sibling to seed: its Source, and the four fields `db/deck.ts`'s fill rule reads —
 * `undefined` where this Sibling states none, exactly as a Source's own record would leave it.
 */
export type SiblingSpec = {
  readonly source: string;
  readonly website?: string | null;
  readonly location?: string | null;
  readonly founders?: Founder[] | null;
  readonly links?: CompanyLinks | null;
};

/**
 * One company that `sources` all found: that many Company Profiles with the one name, and so
 * the one generated `name_key`, which is what makes them siblings. `(source, name_key)` is the
 * Catalogue's key per docs/adr/0008, so this is the shape of the Catalogue today and not a
 * state a test had to force.
 *
 * A bare Source name seeds a Sibling that states none of the four fillable fields, as the
 * sibling tests that only care about the Deck's own ranking do; a `SiblingSpec` states whichever
 * of them this Sibling's Source stated, for the fill-rule tests.
 *
 * Returned in the order the Sources are given, each a minute newer than the last. So the Deck's
 * own order — score, then newest, then id — puts the last Source's row first when nothing else
 * separates them, and a test that wants a particular sibling to win can say which it expects.
 */
export async function seedSiblings(
  db: Database,
  {
    name,
    sources,
    minute = 0,
  }: {
    name: string;
    sources: readonly (string | SiblingSpec)[];
    minute?: number;
  },
): Promise<string[]> {
  const specs = sources.map((source) =>
    typeof source === "string" ? { source } : source,
  );

  const written = await db
    .insert(profiles)
    .values(
      specs.map((spec, index) => ({
        source: spec.source,
        name,
        description: `Found by ${spec.source}.`,
        sector: "hardware-robotics",
        stage: "seed",
        website: spec.website ?? null,
        location: spec.location ?? null,
        founders: spec.founders ?? null,
        links: spec.links ?? null,
        provenance: {
          ...SEEDED_PROVENANCE,
          website: spec.website != null ? ("scraped" as const) : null,
          location: spec.location != null ? ("scraped" as const) : null,
          founders: spec.founders != null ? ("scraped" as const) : null,
          links: spec.links != null ? ("scraped" as const) : null,
        },
        createdAt: new Date(FIRST_CREATED_AT + (minute + index) * A_MINUTE),
      })),
    )
    .returning({ id: profiles.id });

  return written.map((row) => row.id);
}
