// @vitest-environment node
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_PAGE_SIZE,
  decodeCursor,
  encodeCursor,
  readDeckPage,
  readKeptProfiles,
  recordSwipe,
  undoSwipe,
  type DeckCursor,
  type DeckPage,
  type DeckProfile,
} from "./deck";
import { asUser } from "./rls";
import { profiles, swipes } from "./schema";
import { createScratchDb, type ScratchDb } from "./testing/scratch-db";
import {
  FIRST_CREATED_AT,
  seedProfiles,
  seedSiblings,
} from "./testing/seed-profiles";

const JACK = "11111111-1111-1111-1111-111111111111";
const SOMEONE_ELSE = "22222222-2222-2222-2222-222222222222";
const NO_SUCH_PROFILE = "33333333-3333-3333-3333-333333333333";

let scratch: ScratchDb;

/** `count` Company Profiles in the Catalogue, oldest first. Nobody owns them. */
const seed = (count: number) => seedProfiles(scratch.db, { count });

const names = (page: { profiles: DeckProfile[] }) =>
  page.profiles.map((profile) => profile.name);

/**
 * What Postgres said about a write it refused. Drizzle wraps driver errors, so the message
 * that names row level security is on the cause rather than on the error itself.
 */
async function refusalFrom(write: Promise<unknown>): Promise<string> {
  try {
    await write;
    return "the write was accepted";
  } catch (error) {
    return (error as { cause?: { message?: string } }).cause?.message ?? "";
  }
}

beforeAll(async () => {
  scratch = await createScratchDb();
  await scratch.createUser(JACK);
  await scratch.createUser(SOMEONE_ELSE);
}, 60_000);

afterAll(async () => {
  await scratch?.close();
});

beforeEach(async () => {
  await scratch.reset();
  await scratch.db.delete(swipes);
  await scratch.db.delete(profiles);
});

describe("the Deck cursor", () => {
  it("round-trips the sort key it was built from", () => {
    const cursor = {
      score: 6,
      createdAt: new Date(FIRST_CREATED_AT),
      id: NO_SUCH_PROFILE,
    };

    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
  });

  it.each([
    ["not base64 at all", "!!!!"],
    [
      "base64 of something else entirely",
      Buffer.from("hello").toString("base64url"),
    ],
    [
      "a timestamp with no id",
      Buffer.from("0 2026-01-01T09:00:00.000Z").toString("base64url"),
    ],
    [
      "an id that is not a uuid",
      Buffer.from("0 2026-01-01T09:00:00.000Z nope").toString("base64url"),
    ],
    [
      "a timestamp that is not a date",
      Buffer.from(`0 yesterday ${NO_SUCH_PROFILE}`).toString("base64url"),
    ],
    [
      "a cursor from before the Deck was ranked, with no score",
      Buffer.from(`2026-01-01T09:00:00.000Z ${NO_SUCH_PROFILE}`).toString(
        "base64url",
      ),
    ],
    [
      "a score that is not a whole number",
      Buffer.from(`1.5 2026-01-01T09:00:00.000Z ${NO_SUCH_PROFILE}`).toString(
        "base64url",
      ),
    ],
    [
      "a score higher than any Profile can earn",
      Buffer.from(`99 2026-01-01T09:00:00.000Z ${NO_SUCH_PROFILE}`).toString(
        "base64url",
      ),
    ],
  ])("rejects %s", (_description, raw) => {
    expect(decodeCursor(raw)).toBeNull();
  });
});

describe("reading a page of the Deck", () => {
  it("returns an empty page and no cursor when the Deck is empty", async () => {
    const page = await asUser(scratch.db, JACK, (tx) =>
      readDeckPage(tx, { userId: JACK, limit: DEFAULT_PAGE_SIZE }),
    );

    expect(page).toEqual({ profiles: [], nextCursor: null });
  });

  it("returns a partial page with no cursor when everything fits", async () => {
    await seed(3);

    const page = await asUser(scratch.db, JACK, (tx) =>
      readDeckPage(tx, { userId: JACK, limit: DEFAULT_PAGE_SIZE }),
    );

    // Newest first: the last Profile seeded is the first one dealt.
    expect(names(page)).toEqual(["Startup 2", "Startup 1", "Startup 0"]);
    expect(page.nextCursor).toBeNull();
  });

  it("walks the whole Deck in pages, without repeating or skipping a Profile", async () => {
    await seed(5);

    const dealt: string[] = [];
    let cursor: string | null = null;
    let pages = 0;

    do {
      // Decoding the cursor the last page issued is also the assertion that it is one the
      // endpoint would accept back.
      const decoded: DeckCursor | null | undefined =
        cursor === null ? undefined : decodeCursor(cursor);
      expect(cursor === null || decoded !== null).toBe(true);

      const page: DeckPage = await asUser(scratch.db, JACK, (tx) =>
        readDeckPage(tx, {
          userId: JACK,
          limit: 2,
          cursor: decoded ?? undefined,
        }),
      );

      dealt.push(...names(page));
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor !== null && pages < 10);

    expect(pages).toBe(3);
    expect(dealt).toEqual([
      "Startup 4",
      "Startup 3",
      "Startup 2",
      "Startup 1",
      "Startup 0",
    ]);
  });

  it("hands back at most the requested number of Profiles", async () => {
    await seed(5);

    const page = await asUser(scratch.db, JACK, (tx) =>
      readDeckPage(tx, { userId: JACK, limit: 2 }),
    );

    expect(page.profiles).toHaveLength(2);
    expect(page.nextCursor).not.toBeNull();
  });

  it("deals the same Catalogue to a second User", async () => {
    await seed(2);

    const jacks = await asUser(scratch.db, JACK, (tx) =>
      readDeckPage(tx, { userId: JACK, limit: DEFAULT_PAGE_SIZE }),
    );
    const theirs = await asUser(scratch.db, SOMEONE_ELSE, (tx) =>
      readDeckPage(tx, { userId: SOMEONE_ELSE, limit: DEFAULT_PAGE_SIZE }),
    );

    expect(names(jacks)).toEqual(["Startup 1", "Startup 0"]);
    expect(names(theirs)).toEqual(names(jacks));
  });
});

describe("recording a swipe", () => {
  it("excludes a Kept Profile from every later page", async () => {
    const [oldest] = await seed(2);

    const recorded = await asUser(scratch.db, JACK, (tx) =>
      recordSwipe(tx, {
        userId: JACK,
        profileId: oldest!,
        decision: "keep",
      }),
    );

    expect(recorded).toMatchObject({ profileId: oldest, decision: "keep" });

    const page = await asUser(scratch.db, JACK, (tx) =>
      readDeckPage(tx, { userId: JACK, limit: DEFAULT_PAGE_SIZE }),
    );

    expect(names(page)).toEqual(["Startup 1"]);
  });

  it("excludes a Passed Profile without deleting it", async () => {
    const [only] = await seed(1);

    await asUser(scratch.db, JACK, (tx) =>
      recordSwipe(tx, { userId: JACK, profileId: only!, decision: "pass" }),
    );

    const page = await asUser(scratch.db, JACK, (tx) =>
      readDeckPage(tx, { userId: JACK, limit: DEFAULT_PAGE_SIZE }),
    );

    expect(page.profiles).toEqual([]);
    await scratch.reset();
    await expect(
      scratch.db.select().from(profiles).where(eq(profiles.id, only!)),
    ).resolves.toHaveLength(1);
  });

  it("corrects an earlier decision rather than recording a second one", async () => {
    const [only] = await seed(1);

    await asUser(scratch.db, JACK, (tx) =>
      recordSwipe(tx, { userId: JACK, profileId: only!, decision: "keep" }),
    );
    await asUser(scratch.db, JACK, (tx) =>
      recordSwipe(tx, { userId: JACK, profileId: only!, decision: "pass" }),
    );

    await scratch.reset();
    const rows = await scratch.db.select().from(swipes);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.decision).toBe("pass");
  });

  it("refuses a Profile that does not exist", async () => {
    await expect(
      asUser(scratch.db, JACK, (tx) =>
        recordSwipe(tx, {
          userId: JACK,
          profileId: NO_SUCH_PROFILE,
          decision: "keep",
        }),
      ),
    ).resolves.toBeNull();
  });

  it("records a swipe by a second User against the same Company Profile", async () => {
    const [shared] = await seed(1);

    await expect(
      asUser(scratch.db, SOMEONE_ELSE, (tx) =>
        recordSwipe(tx, {
          userId: SOMEONE_ELSE,
          profileId: shared!,
          decision: "keep",
        }),
      ),
    ).resolves.toMatchObject({ profileId: shared, decision: "keep" });
  });

  it("keeps one user's decisions out of another's Deck", async () => {
    const [shared] = await seed(1);
    await scratch.db
      .insert(swipes)
      .values({ userId: SOMEONE_ELSE, profileId: shared!, decision: "pass" });

    const page = await asUser(scratch.db, JACK, (tx) =>
      readDeckPage(tx, { userId: JACK, limit: DEFAULT_PAGE_SIZE }),
    );

    expect(names(page)).toEqual(["Startup 0"]);
  });
});

describe("undoing a swipe", () => {
  it("deletes the decision and deals the Company Profile again", async () => {
    const [only] = await seed(1);

    await asUser(scratch.db, JACK, (tx) =>
      recordSwipe(tx, { userId: JACK, profileId: only!, decision: "pass" }),
    );

    await expect(
      asUser(scratch.db, JACK, (tx) =>
        undoSwipe(tx, { userId: JACK, profileId: only! }),
      ),
    ).resolves.toBe(true);

    const page = await asUser(scratch.db, JACK, (tx) =>
      readDeckPage(tx, { userId: JACK, limit: DEFAULT_PAGE_SIZE }),
    );

    expect(names(page)).toEqual(["Startup 0"]);

    // No decision at all, rather than a third kind of decision.
    await scratch.reset();
    await expect(scratch.db.select().from(swipes)).resolves.toEqual([]);
  });

  it("takes an undone Keep out of the Watchlist", async () => {
    const [only] = await seed(1);

    await asUser(scratch.db, JACK, (tx) =>
      recordSwipe(tx, { userId: JACK, profileId: only!, decision: "keep" }),
    );
    await asUser(scratch.db, JACK, (tx) =>
      undoSwipe(tx, { userId: JACK, profileId: only! }),
    );

    await expect(
      asUser(scratch.db, JACK, (tx) => readKeptProfiles(tx, JACK)),
    ).resolves.toEqual([]);
  });

  it("says there was nothing to undo when the reader never swiped it", async () => {
    const [only] = await seed(1);

    await expect(
      asUser(scratch.db, JACK, (tx) =>
        undoSwipe(tx, { userId: JACK, profileId: only! }),
      ),
    ).resolves.toBe(false);
  });

  it("says there was nothing to undo for a Company Profile that does not exist", async () => {
    await expect(
      asUser(scratch.db, JACK, (tx) =>
        undoSwipe(tx, { userId: JACK, profileId: NO_SUCH_PROFILE }),
      ),
    ).resolves.toBe(false);
  });

  it("leaves another User's decision about the same Company Profile alone", async () => {
    const [shared] = await seed(1);
    await scratch.db
      .insert(swipes)
      .values({ userId: SOMEONE_ELSE, profileId: shared!, decision: "keep" });

    await expect(
      asUser(scratch.db, JACK, (tx) =>
        undoSwipe(tx, { userId: JACK, profileId: shared! }),
      ),
    ).resolves.toBe(false);

    await scratch.reset();
    await expect(
      scratch.db.select().from(swipes).where(eq(swipes.userId, SOMEONE_ELSE)),
    ).resolves.toHaveLength(1);
  });
});

describe("reading the Watchlist", () => {
  it("returns nothing when nothing has been Kept", async () => {
    await seed(2);

    const kept = await asUser(scratch.db, JACK, (tx) =>
      readKeptProfiles(tx, JACK),
    );

    expect(kept).toEqual([]);
  });

  it("returns every Kept Profile, newest decision first", async () => {
    const [decidedFirst, decidedSecond] = await seed(2);

    // Inserted directly with explicit, well-separated timestamps rather than through
    // `recordSwipe`, so the order asserted below is a fact about `decidedAt` and not a race
    // against the wall clock.
    await scratch.db.insert(swipes).values([
      {
        userId: JACK,
        profileId: decidedFirst!,
        decision: "keep",
        decidedAt: new Date(FIRST_CREATED_AT),
      },
      {
        userId: JACK,
        profileId: decidedSecond!,
        decision: "keep",
        decidedAt: new Date(FIRST_CREATED_AT + 60_000),
      },
    ]);

    const kept = await asUser(scratch.db, JACK, (tx) =>
      readKeptProfiles(tx, JACK),
    );

    expect(kept.map((profile) => profile.name)).toEqual([
      "Startup 1",
      "Startup 0",
    ]);
  });

  it("excludes a Passed Profile", async () => {
    const [only] = await seed(1);

    await asUser(scratch.db, JACK, (tx) =>
      recordSwipe(tx, { userId: JACK, profileId: only!, decision: "pass" }),
    );

    const kept = await asUser(scratch.db, JACK, (tx) =>
      readKeptProfiles(tx, JACK),
    );

    expect(kept).toEqual([]);
  });

  it("shows nobody else's Kept Profiles, though the company itself is shared", async () => {
    const [shared] = await seed(1);
    await scratch.db
      .insert(swipes)
      .values({ userId: SOMEONE_ELSE, profileId: shared!, decision: "keep" });

    const kept = await asUser(scratch.db, JACK, (tx) =>
      readKeptProfiles(tx, JACK),
    );

    expect(kept).toEqual([]);
  });
});

/**
 * A company two Sources both found is two Company Profiles sharing a `name_key`, per
 * docs/adr/0008, and one company to a reader. Nothing below merges the rows: what it asserts is
 * that the Deck deals the company once, that a decision about it covers both rows, and that
 * the Watchlist names it once — including for the pair of Keeps a reader could record before
 * any of this existed. See docs/adr/0024.
 */
describe("a company two Sources found", () => {
  /** Both rows for one company, newest Source last. Dealt and Kept by id, since they share a
   * name and a test asserting on names could not tell which it had. */
  const seedBoth = () =>
    seedSiblings(scratch.db, { name: "Sprocket", sources: ["yc", "show-hn"] });

  const dealtIds = async () => {
    const page = await asUser(scratch.db, JACK, (tx) =>
      readDeckPage(tx, { userId: JACK, limit: DEFAULT_PAGE_SIZE }),
    );

    return page.profiles.map((profile) => profile.id);
  };

  it("deals one card, and it is the first of the siblings by the Deck's own order", async () => {
    const [older, newer] = await seedBoth();

    // Nothing separates them on score, so the newer row wins on `created_at`.
    expect(await dealtIds()).toEqual([newer]);
    expect(older).not.toEqual(newer);
  });

  it("deals neither sibling once one of them is Passed", async () => {
    const [, dealt] = await seedBoth();

    await asUser(scratch.db, JACK, (tx) =>
      recordSwipe(tx, { userId: JACK, profileId: dealt!, decision: "pass" }),
    );

    expect(await dealtIds()).toEqual([]);
  });

  it("deals neither sibling once one of them is Kept", async () => {
    const [, dealt] = await seedBoth();

    await asUser(scratch.db, JACK, (tx) =>
      recordSwipe(tx, { userId: JACK, profileId: dealt!, decision: "keep" }),
    );

    expect(await dealtIds()).toEqual([]);
  });

  // Undo deletes the swipe on the sibling that was dealt, and nothing about the other one.
  // That is all it has to do: the company was dealable only because neither sibling had a
  // decision, so the decision just taken back was its only one.
  it("deals the company again once the decision on the dealt sibling is undone", async () => {
    const [, dealt] = await seedBoth();

    await asUser(scratch.db, JACK, (tx) =>
      recordSwipe(tx, { userId: JACK, profileId: dealt!, decision: "pass" }),
    );
    expect(await dealtIds()).toEqual([]);

    await asUser(scratch.db, JACK, (tx) =>
      undoSwipe(tx, { userId: JACK, profileId: dealt! }),
    );

    expect(await dealtIds()).toEqual([dealt]);
  });

  it("gives one Watchlist entry for a company Kept twice, the one Kept most recently", async () => {
    const [keptFirst, keptSecond] = await seedBoth();

    // The pair of Keeps a reader could record while the Deck still dealt both rows. Written
    // with explicit timestamps, so which is the most recent is a fact about `decidedAt`.
    await scratch.db.insert(swipes).values([
      {
        userId: JACK,
        profileId: keptSecond!,
        decision: "keep",
        decidedAt: new Date(FIRST_CREATED_AT),
      },
      {
        userId: JACK,
        profileId: keptFirst!,
        decision: "keep",
        decidedAt: new Date(FIRST_CREATED_AT + 60_000),
      },
    ]);

    const kept = await asUser(scratch.db, JACK, (tx) =>
      readKeptProfiles(tx, JACK),
    );

    expect(kept.map((profile) => profile.id)).toEqual([keptFirst]);
  });
});

/**
 * The fill rule from Ticket #271: a blank `website`, `location`, `founders` or `links` is
 * dealt from a Sibling that states it, a row's own non-null value is never replaced, and
 * `provenance` is dealt to match. See `db/deck.ts`'s `deckColumns`.
 */
describe("filling a dealt card's blanks from its Siblings", () => {
  const WEBSITE = "https://sprocket.example.com";
  const LOCATION = "Palo Alto, CA";
  const FOUNDERS = [{ name: "Ada Lovelace" }];
  const LINKS = { twitter: "https://twitter.com/sprocket" };

  /**
   * `sec-form-d` states only a location; `ycombinator` states a website, founders and links
   * and no location. Between them every one of the four fillable fields has exactly one
   * Sibling stating it. `ycombinator`, given last, is the newer and so the one the Deck deals.
   */
  const seedComplementary = () =>
    seedSiblings(scratch.db, {
      name: "Sprocket",
      sources: [
        { source: "sec-form-d", location: LOCATION },
        {
          source: "ycombinator",
          website: WEBSITE,
          founders: FOUNDERS,
          links: LINKS,
        },
      ],
    });

  const dealtCard = async () => {
    const page = await asUser(scratch.db, JACK, (tx) =>
      readDeckPage(tx, { userId: JACK, limit: DEFAULT_PAGE_SIZE }),
    );
    const [card] = page.profiles;
    return card!;
  };

  it("deals all four fields on the dealt card, from whichever Sibling states each", async () => {
    await seedComplementary();

    const card = await dealtCard();

    expect(card).toMatchObject({
      website: WEBSITE,
      location: LOCATION,
      founders: FOUNDERS,
      links: LINKS,
    });
  });

  it("deals all four fields whichever Sibling wins sibling_rank", async () => {
    // `ycombinator` given first is now the older Sibling, so `sec-form-d` is the one dealt —
    // the opposite winner from the test above, with the same complementary fields.
    await seedSiblings(scratch.db, {
      name: "Sprocket",
      sources: [
        {
          source: "ycombinator",
          website: WEBSITE,
          founders: FOUNDERS,
          links: LINKS,
        },
        { source: "sec-form-d", location: LOCATION },
      ],
    });

    const card = await dealtCard();

    expect(card).toMatchObject({
      website: WEBSITE,
      location: LOCATION,
      founders: FOUNDERS,
      links: LINKS,
    });
  });

  it("deals the filled website's provenance as the Sibling that states it records", async () => {
    await seedComplementary();

    const card = await dealtCard();

    expect(card.provenance.website).toBe("scraped");
    expect(card.provenance.location).toBe("scraped");
  });

  it("shows the Watchlist the same four fields after a Keep on either Sibling", async () => {
    for (const pick of [0, 1] as const) {
      const [secFormD, ycombinator] = await seedSiblings(scratch.db, {
        name: `Sprocket ${pick}`,
        sources: [
          { source: "sec-form-d", location: LOCATION },
          {
            source: "ycombinator",
            website: WEBSITE,
            founders: FOUNDERS,
            links: LINKS,
          },
        ],
      });
      const keptId = pick === 0 ? secFormD : ycombinator;

      await asUser(scratch.db, JACK, (tx) =>
        recordSwipe(tx, { userId: JACK, profileId: keptId!, decision: "keep" }),
      );

      const kept = await asUser(scratch.db, JACK, (tx) =>
        readKeptProfiles(tx, JACK),
      );
      const entry = kept.find((profile) => profile.id === keptId);

      expect(entry).toMatchObject({
        website: WEBSITE,
        location: LOCATION,
        founders: FOUNDERS,
        links: LINKS,
      });
    }
  });

  it("keeps a dealt row's own location when a Sibling states a different one", async () => {
    const [, newer] = await seedSiblings(scratch.db, {
      name: "Sprocket",
      sources: [
        { source: "sec-form-d", location: "Oakland, CA" },
        { source: "ycombinator", location: LOCATION },
      ],
    });

    const card = await dealtCard();

    expect(card.id).toBe(newer);
    expect(card.location).toBe(LOCATION);
  });

  it("deals the newer Sibling's website when the dealt row states none and two others disagree", async () => {
    const OLDER_WEBSITE = "https://older.example.com";
    const NEWER_WEBSITE = "https://newer.example.com";

    // Given oldest to newest: the last, stating no website, is the newest and so the one
    // dealt; between the other two, the one given second is the newer.
    const [, , dealt] = await seedSiblings(scratch.db, {
      name: "Sprocket",
      sources: [
        { source: "sec-form-d", website: OLDER_WEBSITE },
        { source: "ycombinator", website: NEWER_WEBSITE },
        { source: "angelpad" },
      ],
    });

    const card = await dealtCard();

    expect(card.id).toBe(dealt);
    expect(card.website).toBe(NEWER_WEBSITE);
  });
});

/**
 * The policies from Ticket #2 are the backstop underneath the queries above, so these tests
 * go around `readDeckPage` entirely and ask Postgres directly, as the roles PostgREST and the
 * app itself connect as.
 */
describe("row level security under the Deck", () => {
  /** The one Company Profile in the Catalogue here, which Jack has Kept. Named so a test can
   * point at it without seeding a second, which is now a duplicate rather than a fixture:
   * `seedProfiles` writes the same names under the same source, and that is exactly the
   * natural key of docs/adr/0008. */
  let theOnlyProfile: string;

  beforeEach(async () => {
    const [only] = await seed(1);
    theOnlyProfile = only!;
    await scratch.db
      .insert(swipes)
      .values({ userId: JACK, profileId: theOnlyProfile, decision: "keep" });
  });

  it("shows the anonymous role no Profiles and no swipes", async () => {
    await scratch.as("anon");

    await expect(scratch.db.select().from(profiles)).resolves.toEqual([]);
    await expect(scratch.db.select().from(swipes)).resolves.toEqual([]);
  });

  // The two halves of docs/adr/0019, as two assertions.
  it("shows a second signed-in User the same Company Profile", async () => {
    await scratch.as("authenticated", SOMEONE_ELSE);

    const rows = await scratch.db.select().from(profiles);

    expect(rows.map((row) => row.id)).toEqual([theOnlyProfile]);
  });

  it("shows an authenticated user none of another account's swipes", async () => {
    await scratch.as("authenticated", SOMEONE_ELSE);

    await expect(scratch.db.select().from(swipes)).resolves.toEqual([]);
  });

  it("refuses a swipe recorded against somebody else", async () => {
    await scratch.as("authenticated", SOMEONE_ELSE);

    await expect(
      refusalFrom(
        scratch.db.insert(swipes).values({
          userId: JACK,
          profileId: theOnlyProfile,
          decision: "keep",
        }),
      ),
    ).resolves.toMatch(/row-level security/i);
  });

  /**
   * `swipes_delete_own` from this Ticket, read through `asUser()` rather than `scratch.as()`
   * because that is the path the Deck's Undo takes, and asked with a `where` that names no
   * User: what is under test is the policy on its own, not the clause `undoSwipe` writes over
   * the top of it.
   */
  it("lets a User delete their own swipe", async () => {
    await expect(
      asUser(scratch.db, JACK, (tx) =>
        tx
          .delete(swipes)
          .where(eq(swipes.profileId, theOnlyProfile))
          .returning({ profileId: swipes.profileId }),
      ),
    ).resolves.toHaveLength(1);
  });

  it("deletes none of another User's swipes", async () => {
    await expect(
      asUser(scratch.db, SOMEONE_ELSE, (tx) =>
        tx
          .delete(swipes)
          .where(eq(swipes.profileId, theOnlyProfile))
          .returning({ profileId: swipes.profileId }),
      ),
    ).resolves.toEqual([]);

    // Invisible to them rather than refused, so Jack's decision is still there.
    await scratch.reset();
    await expect(scratch.db.select().from(swipes)).resolves.toHaveLength(1);
  });

  it("refuses a swipe about a Company Profile that does not exist", async () => {
    await scratch.as("authenticated", SOMEONE_ELSE);

    await expect(
      refusalFrom(
        scratch.db.insert(swipes).values({
          userId: SOMEONE_ELSE,
          profileId: NO_SUCH_PROFILE,
          decision: "keep",
        }),
      ),
    ).resolves.toMatch(/row-level security|foreign key/i);
  });
});
