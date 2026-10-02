// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { isBayArea } from "../lib/location/bay-area";
import {
  decodeCursor,
  readDeckPage,
  recordSwipe,
  type DeckCursor,
  type DeckPage,
} from "./deck";
import type { Sector, Stage } from "./profile-input";
import { asUser } from "./rls";
import { profiles, swipes, userProfiles } from "./schema";
import { createScratchDb, type ScratchDb } from "./testing/scratch-db";
import { FIRST_CREATED_AT, SEEDED_PROVENANCE } from "./testing/seed-profiles";
import { writeUserProfile } from "./user-profile";
import type { UserProfileInput } from "./user-profile-input";

const JACK = "11111111-1111-1111-1111-111111111111";
const A_MINUTE = 60_000;

let scratch: ScratchDb;

/**
 * One Company Profile to seed. Unstated fields default to values no test's User Profile
 * states, so a row only matches what the test says it matches. `minute` places it in time,
 * so newest-first is a fact the test chose rather than insert order.
 */
type Company = {
  name: string;
  minute: number;
  sector?: Sector;
  stage?: Stage;
  location?: string | null;
  id?: string;
};

/** Seeds `companies` for Jack as the superuser, and returns their ids by name. */
async function seed(companies: Company[]): Promise<Record<string, string>> {
  const written = await scratch.db
    .insert(profiles)
    .values(
      companies.map((company) => ({
        ...(company.id === undefined ? {} : { id: company.id }),
        source: "seed",
        name: company.name,
        description: "Seeded for the ranked Deck.",
        sector: company.sector ?? "other",
        stage: company.stage ?? "pre-seed",
        website: null,
        location: company.location ?? null,
        // `location` carries provenance exactly when it has a value, per the check constraint.
        provenance: {
          ...SEEDED_PROVENANCE,
          location: company.location == null ? null : ("scraped" as const),
        },
        createdAt: new Date(FIRST_CREATED_AT + company.minute * A_MINUTE),
      })),
    )
    .returning({ id: profiles.id, name: profiles.name });

  return Object.fromEntries(written.map((row) => [row.name, row.id]));
}

const statePreferences = (input: Partial<UserProfileInput>) =>
  writeUserProfile(scratch.db, JACK, {
    sectors: [],
    stages: [],
    area: "Bay Area",
    excluded_sectors: [],
    ...input,
  });

/** One page of Jack's Deck, by name. */
async function dealPage(limit = 50): Promise<string[]> {
  const page = await asUser(scratch.db, JACK, (tx) =>
    readDeckPage(tx, { userId: JACK, limit }),
  );

  return page.profiles.map((profile) => profile.name);
}

/** Jack's whole Deck, `limit` at a time, handing each cursor back as a client would. */
async function dealWholeDeck(limit: number): Promise<string[][]> {
  const pages: string[][] = [];
  let cursor: string | null = null;

  do {
    const decoded: DeckCursor | null | undefined =
      cursor === null ? undefined : decodeCursor(cursor);
    expect(decoded).not.toBeNull();

    const page: DeckPage = await asUser(scratch.db, JACK, (tx) =>
      readDeckPage(tx, { userId: JACK, limit, cursor: decoded ?? undefined }),
    );

    pages.push(page.profiles.map((profile) => profile.name));
    cursor = page.nextCursor;
  } while (cursor !== null && pages.length < 50);

  return pages;
}

beforeAll(async () => {
  scratch = await createScratchDb();
  await scratch.createUser(JACK);
}, 60_000);

afterAll(async () => {
  await scratch?.close();
});

beforeEach(async () => {
  await scratch.reset();
  await scratch.db.delete(swipes);
  await scratch.db.delete(profiles);
  await scratch.db.delete(userProfiles);
});

describe("ranking the Deck by the User Profile", () => {
  it("deals a Sector match above a Stage match above an area match above no match", async () => {
    // Created in the opposite order to the ranking, so newest-first would deal it backwards.
    await seed([
      {
        name: "Everything",
        minute: 0,
        sector: "ai-ml",
        stage: "series-a",
        location: "San Francisco, CA",
      },
      { name: "Sector", minute: 1, sector: "ai-ml" },
      {
        name: "Stage and area",
        minute: 2,
        stage: "series-a",
        location: "Oakland, CA",
      },
      { name: "Stage", minute: 3, stage: "series-a" },
      { name: "Area", minute: 4, location: "Palo Alto, CA" },
      { name: "Nothing", minute: 5, location: "Los Angeles, CA" },
    ]);
    await statePreferences({ sectors: ["ai-ml"], stages: ["series-a"] });

    await expect(dealPage()).resolves.toEqual([
      "Everything",
      "Sector",
      "Stage and area",
      "Stage",
      "Area",
      "Nothing",
    ]);
  });

  it("still deals every unswiped Company Profile when the User Profile matches none of them", async () => {
    const ids = await seed([
      { name: "Oldest", minute: 0, location: "Los Angeles, CA" },
      { name: "Middle", minute: 1 },
      { name: "Swiped", minute: 2, location: "New York, NY" },
      { name: "Newest", minute: 3, sector: "security", stage: "seed" },
    ]);
    await statePreferences({
      sectors: ["fintech"],
      stages: ["series-b-plus"],
    });
    await asUser(scratch.db, JACK, (tx) =>
      recordSwipe(tx, {
        userId: JACK,
        profileId: ids.Swiped!,
        decision: "pass",
      }),
    );

    await expect(dealPage()).resolves.toEqual(["Newest", "Middle", "Oldest"]);
  });

  it("deals a `not-stated` stage, scoring nothing for it, below an otherwise identical stated match", async () => {
    // Newer than its twin, so newest-first alone would deal it first. `not-stated` matches no
    // stage preference because it can never be one, and deck.ts has no case for it. See
    // docs/adr/0011 and docs/adr/0015.
    await seed([
      { name: "Stated", minute: 0, sector: "ai-ml", stage: "series-a" },
      { name: "Not stated", minute: 1, sector: "ai-ml", stage: "not-stated" },
    ]);
    await statePreferences({ sectors: ["ai-ml"], stages: ["series-a"] });

    const page = await asUser(scratch.db, JACK, (tx) =>
      readDeckPage(tx, { userId: JACK, limit: 50 }),
    );

    expect(page.profiles.map((profile) => profile.name)).toEqual([
      "Stated",
      "Not stated",
    ]);
    expect(page.profiles[1]?.stage).toBe("not-stated");
    // Dealt on the Sector match alone: the stage component added nothing.
    await expect(dealWholeDeck(1)).resolves.toEqual([
      ["Stated"],
      ["Not stated"],
    ]);
  });

  it("omits a Company Profile in an excluded Sector entirely, however well it otherwise matches", async () => {
    await seed([
      { name: "Unmatched", minute: 0 },
      {
        name: "Excluded",
        minute: 1,
        sector: "consumer-marketplace",
        stage: "series-a",
        location: "San Francisco, CA",
      },
      { name: "Matched", minute: 2, stage: "series-a" },
    ]);
    await statePreferences({
      stages: ["series-a"],
      excluded_sectors: ["consumer-marketplace"],
    });

    // Walked a row at a time to the end, so "absent" means from the whole Deck, not merely
    // from a first page it was ranked off the bottom of.
    const pages = await dealWholeDeck(1);

    expect(pages.flat()).toEqual(["Matched", "Unmatched"]);
  });

  it("keeps an already-swiped Company Profile out, even the best-scoring one", async () => {
    const ids = await seed([
      { name: "Best", minute: 0, sector: "ai-ml" },
      { name: "Rest", minute: 1 },
    ]);
    await statePreferences({ sectors: ["ai-ml"] });
    await asUser(scratch.db, JACK, (tx) =>
      recordSwipe(tx, { userId: JACK, profileId: ids.Best!, decision: "keep" }),
    );

    await expect(dealPage()).resolves.toEqual(["Rest"]);
  });

  it("breaks a tie on created_at, then on id, the same way every time", async () => {
    await seed([
      {
        name: "Lower id",
        minute: 0,
        sector: "ai-ml",
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      },
      {
        name: "Higher id",
        minute: 0,
        sector: "ai-ml",
        id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      },
      { name: "Older, same score", minute: -1, sector: "ai-ml" },
      { name: "Newer, same score", minute: 1, sector: "ai-ml" },
    ]);
    await statePreferences({ sectors: ["ai-ml"] });

    const expected = [
      "Newer, same score",
      "Higher id",
      "Lower id",
      "Older, same score",
    ];

    for (let call = 0; call < 5; call += 1) {
      await expect(dealPage()).resolves.toEqual(expected);
    }

    // The same order has to survive a page boundary between the two identical rows.
    await expect(dealWholeDeck(2)).resolves.toEqual([
      ["Newer, same score", "Higher id"],
      ["Lower id", "Older, same score"],
    ]);
  });

  it("deals exactly today's newest-first Deck for a User Profile that was never saved", async () => {
    // Every row here would be ranked by a User Profile stating anything, including the "Bay
    // Area" a never-saved one reads back as its default area.
    await seed([
      {
        name: "Oldest",
        minute: 0,
        sector: "ai-ml",
        stage: "series-a",
        location: "San Francisco, CA",
      },
      { name: "Middle", minute: 1, location: "Palo Alto, CA" },
      { name: "Newest", minute: 2, location: "Los Angeles, CA" },
    ]);

    // Nothing written to `user_profiles`: the owner has never opened the settings page.
    await expect(scratch.db.select().from(userProfiles)).resolves.toEqual([]);
    await expect(dealPage()).resolves.toEqual(["Newest", "Middle", "Oldest"]);
  });

  it("deals a User who stated preferences the same Deck, reordered, not a shorter one (Ticket #191)", async () => {
    const SOMEONE_ELSE = "22222222-2222-2222-2222-222222222222";
    await scratch.createUser(SOMEONE_ELSE);

    await seed([
      { name: "Ai", minute: 0, sector: "ai-ml", stage: "series-a" },
      { name: "Fintech", minute: 1, sector: "fintech" },
      { name: "Security", minute: 2, sector: "security", stage: "seed" },
      { name: "Climate", minute: 3, sector: "climate-energy" },
      { name: "Other", minute: 4 },
    ]);
    await statePreferences({ sectors: ["ai-ml"], stages: ["series-a"] });

    const stated = await dealPage();
    const none = await asUser(scratch.db, SOMEONE_ELSE, (tx) =>
      readDeckPage(tx, { userId: SOMEONE_ELSE, limit: 50 }),
    ).then((page) => page.profiles.map((profile) => profile.name));

    // The property the screen promises: every Company Profile still appears, in a different
    // order, because stating a preference ranks rather than filters. See docs/adr/0011.
    expect(stated).toHaveLength(none.length);
    expect(stated).not.toEqual(none);
    expect([...stated].sort()).toEqual([...none].sort());
  });

  it("ranks nothing by place for an area it has no cities for, rather than erroring", async () => {
    await seed([
      { name: "In San Francisco", minute: 0, location: "San Francisco, CA" },
      { name: "Nowhere stated", minute: 1 },
    ]);
    await statePreferences({ area: "New York" });

    await expect(dealPage()).resolves.toEqual([
      "Nowhere stated",
      "In San Francisco",
    ]);
  });
});

describe("paging a ranked Deck", () => {
  /** Scores in brackets, under the User Profile below. Oldest first by `minute`. */
  const COMPANIES: Company[] = [
    {
      name: "A [7]",
      minute: 0,
      sector: "ai-ml",
      stage: "series-a",
      location: "San Jose, CA",
    },
    { name: "B [0]", minute: 1 },
    { name: "C [4]", minute: 2, sector: "ai-ml" },
    { name: "D [1]", minute: 3, location: "Berkeley, CA" },
    { name: "E [4]", minute: 4, sector: "ai-ml" },
    { name: "F [0]", minute: 5, location: "Austin, TX" },
    { name: "G [2]", minute: 6, stage: "series-a" },
    { name: "H [4]", minute: 7, sector: "ai-ml" },
    { name: "I [0]", minute: 8 },
  ];

  const RANKED = [
    "A [7]",
    "H [4]",
    "E [4]",
    "C [4]",
    "G [2]",
    "D [1]",
    "I [0]",
    "F [0]",
    "B [0]",
  ];

  beforeEach(async () => {
    await seed(COMPANIES);
    await statePreferences({ sectors: ["ai-ml"], stages: ["series-a"] });
  });

  // Every page size from one row up to the whole Deck, so every boundary — between two
  // scores, and inside a run of equal scores — falls between two pages at least once.
  it.each(Array.from({ length: RANKED.length }, (_unused, index) => index + 1))(
    "deals each Company Profile exactly once, in rank order, %i at a time",
    async (limit) => {
      const pages = await dealWholeDeck(limit);

      expect(pages.flat()).toEqual(RANKED);
      expect(pages).toHaveLength(Math.ceil(RANKED.length / limit));
    },
  );

  it("resumes the second page from inside a run of equal scores", async () => {
    // A page of two ends on "H [4]", with two more rows of score 4 still to deal: the page
    // after it must start from "E [4]", not from the next score down and not from "A [7]".
    await expect(dealWholeDeck(2)).resolves.toEqual([
      ["A [7]", "H [4]"],
      ["E [4]", "C [4]"],
      ["G [2]", "D [1]"],
      ["I [0]", "F [0]"],
      ["B [0]"],
    ]);
  });
});

describe("matching a location to the area in Postgres", () => {
  const LOCATIONS: (string | null)[] = [
    "San Francisco, CA",
    "  Palo Alto , CA",
    "SAN JOSE, CA",
    "St. Helena, CA",
    "Oakland, California, USA",
    "Los Angeles, CA",
    "New York, NY",
    "San Francisco",
    "CA",
    null,
  ];

  it("agrees with isBayArea on every location", async () => {
    await seed(
      LOCATIONS.map((location, index) => ({
        name: `Located ${index}`,
        minute: index,
        location,
      })),
    );
    await statePreferences({ area: "Bay Area" });

    // What the Deck would deal if the SQL read `location` exactly as `isBayArea` does: the Bay
    // Area rows first, each group newest first.
    const expected = LOCATIONS.map((location, index) => ({
      name: `Located ${index}`,
      inArea: isBayArea(location),
      index,
    }))
      .sort((a, b) => Number(b.inArea) - Number(a.inArea) || b.index - a.index)
      .map((row) => row.name);

    await expect(dealPage()).resolves.toEqual(expected);
  });
});

/**
 * The invariant Ticket #191 broke and then fixed, asserted directly so it cannot break again.
 *
 * `user_profiles.area` used to be `NOT NULL DEFAULT 'Bay Area'`, so the moment a User saved any
 * preference at all — including by clicking Skip on the first-run screen — their row claimed an
 * area they had never chosen, area ranking switched on at weight 1, and their Deck came back in
 * a different order from the one an identical User with no row got. See docs/adr/0011, which
 * says the Deck ranks by what a User stated.
 */
describe("a saved User Profile that states nothing", () => {
  const MIXED = [
    { name: "In area", minute: 0, location: "San Francisco, CA" },
    { name: "Out of area", minute: 1, location: "New York, NY" },
    { name: "No location", minute: 2, location: null },
  ];

  it("ranks the Deck exactly as having no User Profile at all does", async () => {
    await seed(MIXED);

    const withNoRow = await dealPage();

    await statePreferences({ area: null });

    await expect(dealPage()).resolves.toEqual(withNoRow);
  });

  it("deals newest first, unreordered by area", async () => {
    await seed(MIXED);
    await statePreferences({ area: null });

    // Seeded a minute apart, so newest first is the reverse of the seed order. An out-of-area
    // company still outranks an older in-area one, because nothing has been stated to rank by.
    await expect(dealPage()).resolves.toEqual([
      "No location",
      "Out of area",
      "In area",
    ]);
  });

  it("still ranks by area once a User actually states one", async () => {
    await seed(MIXED);
    await statePreferences({ area: "Bay Area" });

    await expect(dealPage()).resolves.toEqual([
      "In area",
      "No location",
      "Out of area",
    ]);
  });
});
