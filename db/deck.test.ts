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
  type DeckCursor,
  type DeckPage,
  type DeckProfile,
} from "./deck";
import { asUser } from "./rls";
import { profiles, swipes } from "./schema";
import { createScratchDb, type ScratchDb } from "./testing/scratch-db";
import { FIRST_CREATED_AT, seedProfiles } from "./testing/seed-profiles";

const JACK = "11111111-1111-1111-1111-111111111111";
const SOMEONE_ELSE = "22222222-2222-2222-2222-222222222222";
const NO_SUCH_PROFILE = "33333333-3333-3333-3333-333333333333";

let scratch: ScratchDb;

/** `count` Profiles for Jack unless another owner is named, oldest first. */
const seed = (count: number, ownerId = JACK) =>
  seedProfiles(scratch.db, { count, ownerId });

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
      Buffer.from("2026-01-01T09:00:00.000Z").toString("base64url"),
    ],
    [
      "an id that is not a uuid",
      Buffer.from("2026-01-01T09:00:00.000Z nope").toString("base64url"),
    ],
    [
      "a timestamp that is not a date",
      Buffer.from(`the other day ${NO_SUCH_PROFILE}`).toString("base64url"),
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

  it("deals nobody else's Profiles", async () => {
    await seed(2, SOMEONE_ELSE);

    const page = await asUser(scratch.db, JACK, (tx) =>
      readDeckPage(tx, { userId: JACK, limit: DEFAULT_PAGE_SIZE }),
    );

    expect(page.profiles).toEqual([]);
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

  it("refuses a Profile belonging to somebody else", async () => {
    const [theirs] = await seed(1, SOMEONE_ELSE);

    await expect(
      asUser(scratch.db, JACK, (tx) =>
        recordSwipe(tx, {
          userId: JACK,
          profileId: theirs!,
          decision: "keep",
        }),
      ),
    ).resolves.toBeNull();
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

  it("shows nobody else's Kept Profiles", async () => {
    const [theirs] = await seed(1, SOMEONE_ELSE);
    await scratch.db
      .insert(swipes)
      .values({ userId: SOMEONE_ELSE, profileId: theirs!, decision: "keep" });

    const kept = await asUser(scratch.db, JACK, (tx) =>
      readKeptProfiles(tx, JACK),
    );

    expect(kept).toEqual([]);
  });
});

/**
 * The policies from Ticket #2 are the backstop underneath the queries above, so these tests
 * go around `readDeckPage` entirely and ask Postgres directly, as the roles PostgREST and the
 * app itself connect as.
 */
describe("row level security under the Deck", () => {
  /** The one Profile Jack owns here. Named so a test can point at it without seeding a
   * second, which is now a duplicate rather than a fixture: `seedProfiles` writes the same
   * names under the same source, and that is exactly the natural key of docs/adr/0008. */
  let jacksOnlyProfile: string;

  beforeEach(async () => {
    const [only] = await seed(1);
    jacksOnlyProfile = only!;
    await scratch.db
      .insert(swipes)
      .values({ userId: JACK, profileId: jacksOnlyProfile, decision: "keep" });
  });

  it("shows the anonymous role no Profiles and no swipes", async () => {
    await scratch.as("anon");

    await expect(scratch.db.select().from(profiles)).resolves.toEqual([]);
    await expect(scratch.db.select().from(swipes)).resolves.toEqual([]);
  });

  it("shows an authenticated user none of another account's swipes", async () => {
    await scratch.as("authenticated", SOMEONE_ELSE);

    await expect(scratch.db.select().from(swipes)).resolves.toEqual([]);
  });

  it("refuses a swipe recorded against somebody else", async () => {
    const [theirs] = await seed(1, SOMEONE_ELSE);
    await scratch.as("authenticated", SOMEONE_ELSE);

    await expect(
      refusalFrom(
        scratch.db
          .insert(swipes)
          .values({ userId: JACK, profileId: theirs!, decision: "keep" }),
      ),
    ).resolves.toMatch(/row-level security/i);
  });

  it("refuses a swipe about a Profile the user cannot see", async () => {
    await scratch.as("authenticated", SOMEONE_ELSE);

    await expect(
      refusalFrom(
        scratch.db.insert(swipes).values({
          userId: SOMEONE_ELSE,
          profileId: jacksOnlyProfile,
          decision: "keep",
        }),
      ),
    ).resolves.toMatch(/row-level security/i);
  });
});
