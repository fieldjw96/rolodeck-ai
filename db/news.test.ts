// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { NEWS_DISPLAY_THRESHOLD } from "../lib/news/match";
import { persistNewsItems, readNews, type NewsCandidate } from "./news";
import { asUser } from "./rls";
import { newsItems, profiles, swipes, type SwipeDecision } from "./schema";
import { createScratchDb, type ScratchDb } from "./testing/scratch-db";
import { seedProfiles } from "./testing/seed-profiles";

const JACK = "11111111-1111-1111-1111-111111111111";
const SOMEONE_ELSE = "22222222-2222-2222-2222-222222222222";

const FIRST_PUBLISHED = Date.UTC(2026, 8, 1, 12, 0, 0);
const A_DAY = 86_400_000;

let scratch: ScratchDb;

/** The `day`-th article, published that many days after the first, confidently matched unless
 * a test says otherwise. */
function candidate(
  profileId: string,
  day: number,
  overrides: Partial<NewsCandidate> = {},
): NewsCandidate {
  return {
    profileId,
    title: `Headline ${day}`,
    description: "A standfirst.",
    url: `https://news.example/articles/${day}`,
    publishedAt: new Date(FIRST_PUBLISHED + day * A_DAY),
    sourceName: "The Example Times",
    confidence: 0.9,
    ...overrides,
  };
}

const swipe = (
  profileId: string,
  decision: SwipeDecision = "keep",
  userId = JACK,
) => scratch.db.insert(swipes).values({ userId, profileId, decision });

const storedRows = () => scratch.db.select().from(newsItems);

const titles = (groups: Awaited<ReturnType<typeof readNews>>) =>
  groups.map((group) => ({
    company: group.profile.name,
    titles: group.items.map((item) => item.title),
  }));

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
  await scratch.db.delete(newsItems);
  await scratch.db.delete(swipes);
  await scratch.db.delete(profiles);
});

describe("persistNewsItems", () => {
  it("stores every candidate however low its confidence, owned by the account it is given", async () => {
    const [id] = await seedProfiles(scratch.db, { count: 1, ownerId: JACK });

    const report = await persistNewsItems(scratch.db, {
      ownerId: JACK,
      candidates: [
        candidate(id!, 1, { confidence: 0.9 }),
        candidate(id!, 2, { confidence: 0.1 }),
        candidate(id!, 3, { confidence: 0 }),
      ],
    });

    expect(report).toEqual({
      inserted: 3,
      updated: 0,
      rejected: 0,
      rejections: [],
    });

    const rows = await storedRows();
    expect(rows.map((row) => row.confidence).sort()).toEqual([0, 0.1, 0.9]);
    expect(new Set(rows.map((row) => row.ownerId))).toEqual(new Set([JACK]));
  });

  it("is idempotent on the article url per Company Profile: a second run leaves the row count unchanged", async () => {
    const [id] = await seedProfiles(scratch.db, { count: 1, ownerId: JACK });
    const batch = [candidate(id!, 1), candidate(id!, 2, { confidence: 0.2 })];

    await persistNewsItems(scratch.db, { ownerId: JACK, candidates: batch });
    const countAfterFirst = (await storedRows()).length;

    const second = await persistNewsItems(scratch.db, {
      ownerId: JACK,
      candidates: batch,
    });

    expect(countAfterFirst).toBe(2);
    expect((await storedRows()).length).toBe(countAfterFirst);
    expect(second).toMatchObject({ inserted: 0, updated: 2 });
  });

  it("updates a stored article's fields and score on a later run, but not when it was first fetched", async () => {
    const [id] = await seedProfiles(scratch.db, { count: 1, ownerId: JACK });

    await persistNewsItems(scratch.db, {
      ownerId: JACK,
      candidates: [candidate(id!, 1, { confidence: 0.3 })],
    });
    const [before] = await storedRows();

    await persistNewsItems(scratch.db, {
      ownerId: JACK,
      candidates: [
        candidate(id!, 1, { title: "A corrected headline", confidence: 0.8 }),
      ],
    });
    const rows = await storedRows();

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      title: "A corrected headline",
      confidence: 0.8,
      fetchedAt: before!.fetchedAt,
    });
  });

  it("treats a url repeated within one batch as one article", async () => {
    const [id] = await seedProfiles(scratch.db, { count: 1, ownerId: JACK });

    const report = await persistNewsItems(scratch.db, {
      ownerId: JACK,
      candidates: [candidate(id!, 1), candidate(id!, 1)],
    });

    expect(report).toMatchObject({ inserted: 1, updated: 1 });
    expect(await storedRows()).toHaveLength(1);
  });

  it("stores the same article once for each Company Profile it is attributed to", async () => {
    const [first, second] = await seedProfiles(scratch.db, {
      count: 2,
      ownerId: JACK,
    });

    await persistNewsItems(scratch.db, {
      ownerId: JACK,
      candidates: [candidate(first!, 1), candidate(second!, 1)],
    });

    expect(await storedRows()).toHaveLength(2);
  });

  it("rejects a candidate by field name and writes the rest of the batch", async () => {
    const [id] = await seedProfiles(scratch.db, { count: 1, ownerId: JACK });

    const report = await persistNewsItems(scratch.db, {
      ownerId: JACK,
      candidates: [
        candidate(id!, 1, { confidence: 1.5 }),
        candidate(id!, 2, { url: "javascript:alert(1)" }),
        candidate(id!, 3, { sourceName: " " }),
        candidate(id!, 4),
      ],
    });

    expect(report.rejections.map((rejection) => rejection.field)).toEqual([
      "confidence",
      "url",
      "sourceName",
    ]);
    expect(report).toMatchObject({ inserted: 1, rejected: 3 });
  });

  it("is refused underneath by Postgres for a score outside 0 to 1, whatever wrote it", async () => {
    const [id] = await seedProfiles(scratch.db, { count: 1, ownerId: JACK });

    await expect(
      scratch.db
        .insert(newsItems)
        .values({ ...candidate(id!, 1), ownerId: JACK, confidence: 2 }),
    ).rejects.toThrow();
  });
});

describe("readNews", () => {
  it("does not return a below-threshold item, although it is persisted", async () => {
    const [id] = await seedProfiles(scratch.db, { count: 1, ownerId: JACK });
    await swipe(id!);

    await persistNewsItems(scratch.db, {
      ownerId: JACK,
      candidates: [
        candidate(id!, 1, {
          title: "At the threshold",
          confidence: NEWS_DISPLAY_THRESHOLD,
        }),
        candidate(id!, 2, {
          title: "Just below it",
          confidence: NEWS_DISPLAY_THRESHOLD - 0.01,
        }),
      ],
    });

    const stored = await storedRows();
    expect(stored.map((row) => row.title).sort()).toEqual([
      "At the threshold",
      "Just below it",
    ]);

    expect(titles(await readNews(scratch.db, JACK))).toEqual([
      { company: "Startup 0", titles: ["At the threshold"] },
    ]);
  });

  it("groups by company with each company's newest article first, and the freshest company first", async () => {
    const [older, newer] = await seedProfiles(scratch.db, {
      count: 2,
      ownerId: JACK,
    });
    await swipe(older!);
    await swipe(newer!);

    await persistNewsItems(scratch.db, {
      ownerId: JACK,
      candidates: [
        candidate(older!, 1),
        candidate(older!, 5),
        candidate(newer!, 3),
        candidate(newer!, 7),
      ],
    });

    expect(titles(await readNews(scratch.db, JACK))).toEqual([
      { company: "Startup 1", titles: ["Headline 7", "Headline 3"] },
      { company: "Startup 0", titles: ["Headline 5", "Headline 1"] },
    ]);
  });

  it("returns nothing for a Company Profile that is not currently Kept, even with News stored for it", async () => {
    const [passed, unswiped, keptThenPassed] = await seedProfiles(scratch.db, {
      count: 3,
      ownerId: JACK,
    });
    await swipe(passed!, "pass");
    await swipe(keptThenPassed!, "keep");

    await persistNewsItems(scratch.db, {
      ownerId: JACK,
      candidates: [
        candidate(passed!, 1),
        candidate(unswiped!, 2),
        candidate(keptThenPassed!, 3),
      ],
    });

    await scratch.db.delete(swipes);
    await swipe(passed!, "pass");
    await swipe(keptThenPassed!, "pass");

    expect(await readNews(scratch.db, JACK)).toEqual([]);
  });

  it("returns nobody else's News", async () => {
    const [theirs] = await seedProfiles(scratch.db, {
      count: 1,
      ownerId: SOMEONE_ELSE,
    });
    await swipe(theirs!, "keep", SOMEONE_ELSE);
    await persistNewsItems(scratch.db, {
      ownerId: SOMEONE_ELSE,
      candidates: [candidate(theirs!, 1)],
    });

    expect(await readNews(scratch.db, JACK)).toEqual([]);
  });

  it("reads through RLS as the signed-in owner, and the policy alone hides the rows from anyone else", async () => {
    const [id] = await seedProfiles(scratch.db, { count: 1, ownerId: JACK });
    await swipe(id!);
    await persistNewsItems(scratch.db, {
      ownerId: JACK,
      candidates: [candidate(id!, 1)],
    });

    const asJack = await asUser(scratch.db, JACK, (tx) => readNews(tx, JACK));
    expect(titles(asJack)).toEqual([
      { company: "Startup 0", titles: ["Headline 1"] },
    ]);

    // No `where` clause here: what comes back is the policy's answer and nothing else's.
    await scratch.as("authenticated", SOMEONE_ELSE);
    expect(await storedRows()).toEqual([]);

    await scratch.as("anon");
    expect(await storedRows()).toEqual([]);

    await scratch.reset();
  });
});
