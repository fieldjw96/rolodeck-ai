// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { NEWS_DISPLAY_THRESHOLD } from "../lib/news/match";
import {
  persistNewsArticles,
  persistNewsItems,
  readCatalogueCompaniesForNews,
  readLatestLaunchHnPublishedAt,
  readNews,
  readNewsCoveredProfileIds,
  readStoredNewsArticles,
  recordNewsCoverage,
  type NewsArticleInput,
  type NewsCandidate,
} from "./news";
import { asUser } from "./rls";
import {
  newsArticles,
  newsItems,
  newsProfileCoverage,
  profiles,
  swipes,
  type SwipeDecision,
} from "./schema";
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

/** The `day`-th article as `news_articles` stores it: no company and no score. */
function article(
  day: number,
  overrides: Partial<NewsArticleInput> = {},
): NewsArticleInput {
  return {
    title: `Headline ${day}`,
    description: "A standfirst.",
    url: `https://news.example/articles/${day}`,
    publishedAt: new Date(FIRST_PUBLISHED + day * A_DAY),
    sourceName: "The Example Times",
    ...overrides,
  };
}

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
  await scratch.db.delete(newsArticles);
  await scratch.db.delete(newsProfileCoverage);
  await scratch.db.delete(swipes);
  await scratch.db.delete(profiles);
});

describe("persistNewsArticles", () => {
  it("stores an article whether or not it matches anything, and the same feed twice stores each once", async () => {
    const batch = [article(1), article(2)];

    const first = await persistNewsArticles(scratch.db, { articles: batch });
    const second = await persistNewsArticles(scratch.db, { articles: batch });

    expect(first).toMatchObject({ inserted: 2, updated: 0, rejected: 0 });
    expect(first.fresh.map((row) => row.url)).toEqual([
      "https://news.example/articles/1",
      "https://news.example/articles/2",
    ]);
    // Nothing was attributed to any company, and the articles are stored all the same.
    expect(await storedRows()).toEqual([]);
    expect(await scratch.db.select().from(newsArticles)).toHaveLength(2);

    expect(second).toMatchObject({ inserted: 0, updated: 2 });
    expect(second.fresh).toEqual([]);
    expect(await scratch.db.select().from(newsArticles)).toHaveLength(2);
  });

  it("treats a url repeated within one batch as one article, and counts it fresh once", async () => {
    const report = await persistNewsArticles(scratch.db, {
      articles: [article(1), article(1)],
    });

    expect(report).toMatchObject({ inserted: 1, updated: 1 });
    expect(report.fresh).toHaveLength(1);
  });

  it("updates a corrected headline but not when the article was first read", async () => {
    await persistNewsArticles(scratch.db, { articles: [article(1)] });
    const [before] = await scratch.db.select().from(newsArticles);

    await persistNewsArticles(scratch.db, {
      articles: [article(1, { title: "A corrected headline" })],
    });
    const rows = await scratch.db.select().from(newsArticles);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      title: "A corrected headline",
      fetchedAt: before!.fetchedAt,
    });
  });

  it("rejects an article by field name and writes the rest of the batch", async () => {
    const report = await persistNewsArticles(scratch.db, {
      articles: [
        article(1, { url: "javascript:alert(1)" }),
        article(2, { sourceName: " " }),
        article(3),
      ],
    });

    expect(report.rejections.map((rejection) => rejection.field)).toEqual([
      "url",
      "sourceName",
    ]);
    expect(report).toMatchObject({ inserted: 1, rejected: 2 });
  });

  it("reads back every stored article, newest first", async () => {
    await persistNewsArticles(scratch.db, {
      articles: [article(1), article(5), article(3)],
    });

    expect(
      (await readStoredNewsArticles(scratch.db)).map((row) => row.title),
    ).toEqual(["Headline 5", "Headline 3", "Headline 1"]);
  });
});

describe("readLatestLaunchHnPublishedAt", () => {
  it("finds none when nothing is stored", async () => {
    expect(await readLatestLaunchHnPublishedAt(scratch.db)).toBeNull();
  });

  it("reads the newest Launch HN post's date, ignoring an ordinary article beside it", async () => {
    await persistNewsArticles(scratch.db, {
      articles: [
        article(1, { title: "Launch HN: Acme (YC S24) – A thing" }),
        article(5, { title: "Launch HN: Zeta (YC S26) – Another thing" }),
        // Published later than both, but not a Launch HN post.
        article(9, { title: "Zeta raises a seed round" }),
      ],
    });

    expect(await readLatestLaunchHnPublishedAt(scratch.db)).toEqual(
      new Date(FIRST_PUBLISHED + 5 * A_DAY),
    );
  });
});

describe("news coverage", () => {
  it("records a Company Profile once and reads it back", async () => {
    const [first, second] = await seedProfiles(scratch.db, { count: 2 });

    expect(await readNewsCoveredProfileIds(scratch.db)).toEqual(new Set());

    expect(await recordNewsCoverage(scratch.db, [first!, second!])).toBe(2);
    // Already recorded: a second run says the same thing and adds nothing.
    expect(await recordNewsCoverage(scratch.db, [first!])).toBe(0);
    expect(await recordNewsCoverage(scratch.db, [])).toBe(0);

    expect(await readNewsCoveredProfileIds(scratch.db)).toEqual(
      new Set([first, second]),
    );
  });

  it("is not inferred from whether the Profile has any News", async () => {
    const [quiet] = await seedProfiles(scratch.db, { count: 1 });
    await recordNewsCoverage(scratch.db, [quiet!]);

    // Nothing was ever found about it, which is the ordinary outcome and not a reason to
    // search again: docs/adr/0022.
    expect(await storedRows()).toEqual([]);
    expect(await readNewsCoveredProfileIds(scratch.db)).toEqual(
      new Set([quiet]),
    );
  });
});

describe("readCatalogueCompaniesForNews", () => {
  it("answers with every Company Profile, swiped or not, oldest created first", async () => {
    const ids = await seedProfiles(scratch.db, { count: 3 });
    await swipe(ids[1]!, "pass");
    await swipe(ids[2]!, "keep", SOMEONE_ELSE);

    const catalogue = await readCatalogueCompaniesForNews(scratch.db);

    expect(catalogue.map((company) => company.name)).toEqual([
      "Startup 0",
      "Startup 1",
      "Startup 2",
    ]);
    expect(catalogue.map((company) => company.id)).toEqual(ids);
  });
});

describe("persistNewsItems", () => {
  it("stores a candidate the matcher placed at all, and counts the ones it scored zero", async () => {
    const [id] = await seedProfiles(scratch.db, { count: 1 });

    const report = await persistNewsItems(scratch.db, {
      candidates: [
        candidate(id!, 1, { confidence: 0.9 }),
        candidate(id!, 2, { confidence: 0.1 }),
        candidate(id!, 3, { confidence: 0 }),
      ],
    });

    expect(report).toEqual({
      inserted: 2,
      updated: 0,
      unattributed: 1,
      rejected: 0,
      rejections: [],
    });

    const rows = await storedRows();
    expect(rows.map((row) => row.confidence).sort()).toEqual([0.1, 0.9]);
  });

  it("attributes one article to the one Company Profile of three it is about", async () => {
    const [match, other, third] = await seedProfiles(scratch.db, { count: 3 });

    const report = await persistNewsItems(scratch.db, {
      candidates: [
        candidate(match!, 1, { confidence: 0.75 }),
        candidate(other!, 1, { confidence: 0 }),
        candidate(third!, 1, { confidence: 0 }),
      ],
    });

    expect(report).toMatchObject({ inserted: 1, unattributed: 2 });

    const rows = await storedRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.profileId).toBe(match);
  });

  it("is idempotent on the article url per Company Profile: a second run leaves the row count unchanged", async () => {
    const [id] = await seedProfiles(scratch.db, { count: 1 });
    const batch = [candidate(id!, 1), candidate(id!, 2, { confidence: 0.2 })];

    await persistNewsItems(scratch.db, { candidates: batch });
    const countAfterFirst = (await storedRows()).length;

    const second = await persistNewsItems(scratch.db, {
      candidates: batch,
    });

    expect(countAfterFirst).toBe(2);
    expect((await storedRows()).length).toBe(countAfterFirst);
    expect(second).toMatchObject({ inserted: 0, updated: 2 });
  });

  it("updates a stored article's fields and score on a later run, but not when it was first fetched", async () => {
    const [id] = await seedProfiles(scratch.db, { count: 1 });

    await persistNewsItems(scratch.db, {
      candidates: [candidate(id!, 1, { confidence: 0.3 })],
    });
    const [before] = await storedRows();

    await persistNewsItems(scratch.db, {
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
    const [id] = await seedProfiles(scratch.db, { count: 1 });

    const report = await persistNewsItems(scratch.db, {
      candidates: [candidate(id!, 1), candidate(id!, 1)],
    });

    expect(report).toMatchObject({ inserted: 1, updated: 1 });
    expect(await storedRows()).toHaveLength(1);
  });

  it("stores the same article once for each Company Profile it is attributed to", async () => {
    const [first, second] = await seedProfiles(scratch.db, { count: 2 });

    await persistNewsItems(scratch.db, {
      candidates: [candidate(first!, 1), candidate(second!, 1)],
    });

    expect(await storedRows()).toHaveLength(2);
  });

  it("rejects a candidate by field name and writes the rest of the batch", async () => {
    const [id] = await seedProfiles(scratch.db, { count: 1 });

    const report = await persistNewsItems(scratch.db, {
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
    const [id] = await seedProfiles(scratch.db, { count: 1 });

    await expect(
      scratch.db
        .insert(newsItems)
        .values({ ...candidate(id!, 1), confidence: 2 }),
    ).rejects.toThrow();
  });
});

describe("deduplication across multiple feeds", () => {
  it("stores articles once when the same url appears in multiple feeds", async () => {
    const sharedUrl = "https://techcrunch.com/shared-article";
    const mainOnlyUrl = "https://techcrunch.com/main-only";
    const ycOnlyUrl = "https://techcrunch.com/yc-only";

    // Articles from the main TechCrunch feed
    const mainFeedArticles: NewsArticleInput[] = [
      {
        title: "Shared Article",
        description: "This appears in both feeds",
        url: sharedUrl,
        publishedAt: new Date("2026-10-01T12:00:00Z"),
        sourceName: "TechCrunch",
      },
      {
        title: "Main Feed Only",
        description: "Only in the main feed",
        url: mainOnlyUrl,
        publishedAt: new Date("2026-10-02T12:00:00Z"),
        sourceName: "TechCrunch",
      },
    ];

    // Articles from the Y Combinator tag feed
    const ycFeedArticles: NewsArticleInput[] = [
      {
        title: "Shared Article",
        description: "This appears in both feeds",
        url: sharedUrl,
        publishedAt: new Date("2026-10-01T12:00:00Z"),
        sourceName: "TechCrunch",
      },
      {
        title: "YC Feed Only",
        description: "Only in the YC feed",
        url: ycOnlyUrl,
        publishedAt: new Date("2026-10-03T12:00:00Z"),
        sourceName: "TechCrunch",
      },
    ];

    // Store articles from both feeds together
    const report = await persistNewsArticles(scratch.db, {
      articles: [...mainFeedArticles, ...ycFeedArticles],
    });

    // Should have inserted 3 unique articles
    expect(report.inserted).toBe(3);
    expect(report.updated).toBe(0);
    expect(report.fresh).toHaveLength(3);

    // Verify unique URLs are stored
    const stored = await readStoredNewsArticles(scratch.db);
    const urls = stored.map((article) => article.url);
    expect(urls).toEqual([sharedUrl, ycOnlyUrl, mainOnlyUrl]);
    expect(new Set(urls).size).toBe(3); // 3 unique URLs
  });
});

describe("readNews", () => {
  it("does not return a below-threshold item, although it is persisted", async () => {
    const [id] = await seedProfiles(scratch.db, { count: 1 });
    await swipe(id!);

    await persistNewsItems(scratch.db, {
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
    const [older, newer] = await seedProfiles(scratch.db, { count: 2 });
    await swipe(older!);
    await swipe(newer!);

    await persistNewsItems(scratch.db, {
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
    });
    await swipe(passed!, "pass");
    await swipe(keptThenPassed!, "keep");

    await persistNewsItems(scratch.db, {
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

  it("returns an article to a second User who has Kept the same company", async () => {
    const [shared] = await seedProfiles(scratch.db, { count: 1 });
    await swipe(shared!, "keep", SOMEONE_ELSE);
    await persistNewsItems(scratch.db, { candidates: [candidate(shared!, 1)] });

    expect(titles(await readNews(scratch.db, SOMEONE_ELSE))).toEqual([
      { company: "Startup 0", titles: ["Headline 1"] },
    ]);
  });

  it("returns nothing to a User who has not Kept the company the article is about", async () => {
    const [shared] = await seedProfiles(scratch.db, { count: 1 });
    await swipe(shared!, "keep", JACK);
    await persistNewsItems(scratch.db, { candidates: [candidate(shared!, 1)] });

    expect(await readNews(scratch.db, SOMEONE_ELSE)).toEqual([]);
  });

  it("reads through RLS as the signed-in User, and the policy shows the article to both of them", async () => {
    const [id] = await seedProfiles(scratch.db, { count: 1 });
    await swipe(id!);
    await persistNewsItems(scratch.db, {
      candidates: [candidate(id!, 1)],
    });

    const asJack = await asUser(scratch.db, JACK, (tx) => readNews(tx, JACK));
    expect(titles(asJack)).toEqual([
      { company: "Startup 0", titles: ["Headline 1"] },
    ]);

    // No `where` clause here: what comes back is the policy's answer and nothing else's. The
    // article is Catalogue, so the second User sees the row; what they do not see is the Keep
    // that caused it to be gathered, which is why `readNews` still answers them nothing.
    await scratch.as("authenticated", SOMEONE_ELSE);
    expect((await storedRows()).map((row) => row.title)).toEqual([
      "Headline 1",
    ]);
    expect(await scratch.db.select().from(swipes)).toEqual([]);

    await scratch.as("anon");
    expect(await storedRows()).toEqual([]);

    await scratch.reset();
  });
});
