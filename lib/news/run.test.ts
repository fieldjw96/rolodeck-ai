// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { readNews } from "../../db/news";
import type { Sector } from "../../db/profile-input";
import {
  newsItems,
  profiles,
  swipes,
  type SwipeDecision,
} from "../../db/schema";
import { createScratchDb, type ScratchDb } from "../../db/testing/scratch-db";
import { SEEDED_PROVENANCE } from "../../db/testing/seed-profiles";
import type { NewsFeedClient } from "./feed-fetch";
import type { NewsFeed } from "./feeds";
import type { HistorySearchClient } from "./history-search-fetch";
import {
  confidenceDistribution,
  fetchNewsForKeptProfiles,
  newsRunFailures,
  summariseNewsRun,
  type NewsRunReport,
} from "./run";

const JACK = "11111111-1111-1111-1111-111111111111";
const SOMEONE_ELSE = "22222222-2222-2222-2222-222222222222";

let scratch: ScratchDb;

async function companyProfile(
  name: string,
  sector: Sector,
  ownerId = JACK,
  website: string | null = null,
): Promise<string> {
  const [row] = await scratch.db
    .insert(profiles)
    .values({
      ownerId,
      source: "seed",
      name,
      description: `${name}, for the News tests.`,
      sector,
      stage: "seed",
      website,
      provenance: {
        ...SEEDED_PROVENANCE,
        website: website === null ? null : "scraped",
      },
    })
    .returning({ id: profiles.id });

  return row!.id;
}

const swipe = (profileId: string, decision: SwipeDecision, userId = JACK) =>
  scratch.db.insert(swipes).values({ userId, profileId, decision });

const WIRE: NewsFeed = {
  name: "wire",
  publication: "The Wire",
  url: "https://wire.example/feed.xml",
};

const DAILY: NewsFeed = {
  name: "daily",
  publication: "Daily Example",
  url: "https://daily.example/rss",
};

/**
 * One RSS 2.0 item. The parser itself is tested against a real capture in `feeds.test.ts`; these
 * tests are about what a run does with what it parsed, so the feeds are written to order.
 */
function item(title: string, link: string, description = "") {
  return `<item><title>${title}</title><link>${link}</link><description><![CDATA[${description}]]></description><pubDate>Tue, 01 Sep 2026 12:00:00 GMT</pubDate></item>`;
}

const rss = (...items: string[]) =>
  `<?xml version="1.0"?><rss version="2.0"><channel><title>Example</title>${items.join("")}</channel></rss>`;

/** A client that answers from a table of urls and records every url it was asked for. */
function fakeClient(answers: Readonly<Record<string, string | Error>>) {
  const requested: string[] = [];

  const client: NewsFeedClient = {
    get: async (url) => {
      requested.push(url);
      const answer = answers[url];

      if (answer instanceof Error) {
        throw answer;
      }

      return answer ?? rss();
    },
  };

  return { client, requested };
}

/** A search that finds nothing, for the tests about the feeds. */
const NO_HISTORY: HistorySearchClient = { search: async () => ({ hits: [] }) };

const NOW = new Date("2026-09-20T00:00:00Z");
const A_MONTH_AGO = Math.floor(NOW.getTime() / 1_000) - 30 * 24 * 60 * 60;

/** One Hacker News search hit, as `history-search.test.ts` tests the real ones. */
const hit = (objectID: string, title: string, url: string | null) => ({
  objectID,
  title,
  url,
  created_at_i: A_MONTH_AGO,
});

/**
 * A search answering by what each query asks for — the name in the title, or `url` for a
 * company's own site — and recording every query it was sent, as `query` and restriction.
 */
function fakeSearch(answer: (query: string, restriction: string) => unknown) {
  const requested: string[] = [];

  const search: HistorySearchClient = {
    search: async (url) => {
      const params = new URL(url).searchParams;
      const query = params.get("query") ?? "";
      const restriction = params.get("restrictSearchableAttributes") ?? "";
      requested.push(`${restriction}:${query}`);

      const answered = answer(query, restriction);

      if (answered instanceof Error) {
        throw answered;
      }

      return answered ?? { hits: [] };
    },
  };

  return { search, requested };
}

const WIRE_FEED = rss(
  item(
    "Ramp raises $150 million to expand its corporate card and expense platform",
    "https://wire.example/ramp-raises",
    "<p>The fintech startup's valuation climbs.</p>",
  ),
  // A namesake: stored, scored low, never shown.
  item(
    "Highway ramp closures planned for the weekend",
    "https://wire.example/ramp-closures",
  ),
);

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

describe("fetchNewsForKeptProfiles", () => {
  it("scores against Kept Company Profiles only — never an unswiped one, a Passed one, or another account's", async () => {
    const ramp = await companyProfile("Ramp", "fintech");
    const mercury = await companyProfile("Mercury", "fintech");
    await companyProfile("Quiet Co", "other");
    const theirs = await companyProfile("Theirs Inc", "security", SOMEONE_ELSE);

    await swipe(ramp, "keep");
    await swipe(mercury, "pass");
    await swipe(theirs, "keep", SOMEONE_ELSE);

    const { client } = fakeClient({ [WIRE.url]: WIRE_FEED });
    const report = await fetchNewsForKeptProfiles(scratch.db, {
      ownerId: JACK,
      feeds: [WIRE],
      client,
      search: NO_HISTORY,
    });

    expect(report).toMatchObject({
      companies: 1,
      fromFeeds: { candidates: 2 },
    });

    const stored = await scratch.db.select().from(newsItems);
    expect(new Set(stored.map((row) => row.profileId))).toEqual(
      new Set([ramp]),
    );
    expect(stored.every((row) => row.ownerId === JACK)).toBe(true);
  });

  it("reads every feed once, even when nothing is Kept, and does not call matching nothing a failure", async () => {
    await companyProfile("Ramp", "fintech");

    const { client, requested } = fakeClient({ [WIRE.url]: WIRE_FEED });
    const report = await fetchNewsForKeptProfiles(scratch.db, {
      ownerId: JACK,
      feeds: [WIRE, DAILY],
      client,
      search: NO_HISTORY,
    });

    expect(requested).toEqual([WIRE.url, DAILY.url]);
    expect(report).toMatchObject({
      companies: 0,
      searches: [],
      fromFeeds: { candidates: 0 },
      inserted: 0,
      feeds: [
        { feed: "wire", articles: 2, rejections: [] },
        // An empty channel is a rejection of that feed, not zero articles.
        {
          feed: "daily",
          failure: expect.stringContaining("at least one item"),
        },
      ],
    });
    expect(await scratch.db.select().from(newsItems)).toEqual([]);
    expect(newsRunFailures(report)).toEqual([]);
  });

  it("stores every article with its score, including the namesake below the threshold, and shows only the match", async () => {
    const ramp = await companyProfile("Ramp", "fintech");
    await swipe(ramp, "keep");

    const { client } = fakeClient({ [WIRE.url]: WIRE_FEED });
    const report = await fetchNewsForKeptProfiles(scratch.db, {
      ownerId: JACK,
      feeds: [WIRE],
      client,
      search: NO_HISTORY,
    });

    expect(report).toMatchObject({
      fromFeeds: { candidates: 2, shown: 1 },
      inserted: 2,
    });

    const stored = await scratch.db.select().from(newsItems);
    expect(stored).toHaveLength(2);
    expect(
      stored.find((row) => row.url === "https://wire.example/ramp-closures")
        ?.confidence,
    ).toBeLessThan(0.6);
    expect(stored.map((row) => row.sourceName)).toEqual([
      "The Wire",
      "The Wire",
    ]);

    const news = await readNews(scratch.db, JACK);
    expect(
      news.flatMap((group) => group.items.map((item) => item.url)),
    ).toEqual(["https://wire.example/ramp-raises"]);
  });

  it("scores every article from every feed against every Kept Company Profile, and stores each pair once", async () => {
    const ramp = await companyProfile("Ramp", "fintech");
    const mercury = await companyProfile("Mercury", "fintech");
    await swipe(ramp, "keep");
    await swipe(mercury, "keep");

    const { client } = fakeClient({
      [WIRE.url]: WIRE_FEED,
      [DAILY.url]: rss(
        item(
          "Mercury and Ramp both launch business credit cards for startups",
          "https://daily.example/cards",
        ),
      ),
    });

    const report = await fetchNewsForKeptProfiles(scratch.db, {
      ownerId: JACK,
      feeds: [WIRE, DAILY],
      client,
      search: NO_HISTORY,
    });

    // Three articles, two companies.
    expect(report).toMatchObject({ fromFeeds: { candidates: 6 }, inserted: 6 });

    const cards = (await scratch.db.select().from(newsItems)).filter(
      (row) => row.url === "https://daily.example/cards",
    );
    expect(new Set(cards.map((row) => row.profileId))).toEqual(
      new Set([ramp, mercury]),
    );
    expect(cards.every((row) => row.confidence >= 0.6)).toBe(true);
  });

  it("adds no rows when run a second time over unchanged feeds", async () => {
    const ramp = await companyProfile("Ramp", "fintech");
    await swipe(ramp, "keep");
    const { client } = fakeClient({ [WIRE.url]: WIRE_FEED });

    await fetchNewsForKeptProfiles(scratch.db, {
      ownerId: JACK,
      feeds: [WIRE],
      client,
      search: NO_HISTORY,
    });
    const afterFirst = (await scratch.db.select().from(newsItems)).length;

    const second = await fetchNewsForKeptProfiles(scratch.db, {
      ownerId: JACK,
      feeds: [WIRE],
      client,
      search: NO_HISTORY,
    });

    expect(afterFirst).toBe(2);
    expect((await scratch.db.select().from(newsItems)).length).toBe(afterFirst);
    expect(second).toMatchObject({ inserted: 0, updated: afterFirst });
  });

  it("carries on past a feed that cannot be fetched and one that no longer parses, naming each, and still stores the rest", async () => {
    const ramp = await companyProfile("Ramp", "fintech");
    await swipe(ramp, "keep");

    const broken: NewsFeed = {
      name: "broken",
      publication: "Broken",
      url: "https://broken.example/feed",
    };

    const { client, requested } = fakeClient({
      [DAILY.url]: new Error("https://daily.example/rss answered 503"),
      [broken.url]: "<html><body>Moved</body></html>",
      [WIRE.url]: WIRE_FEED,
    });

    const report = await fetchNewsForKeptProfiles(scratch.db, {
      ownerId: JACK,
      feeds: [DAILY, broken, WIRE],
      client,
      search: NO_HISTORY,
    });

    expect(requested).toEqual([DAILY.url, broken.url, WIRE.url]);
    expect(report.feeds).toEqual([
      { feed: "daily", failure: "https://daily.example/rss answered 503" },
      {
        feed: "broken",
        failure:
          "rejected on rss: broken is not an RSS 2.0 feed: its root element is <html>",
      },
      { feed: "wire", articles: 2, rejections: [] },
    ]);
    expect(report.inserted).toBe(2);
    expect(newsRunFailures(report)).toEqual([]);
  });

  it("fails when every feed failed", async () => {
    const { client } = fakeClient({
      [WIRE.url]: new Error("https://wire.example/feed.xml answered 500"),
      [DAILY.url]: "not xml at all <",
    });

    const report = await fetchNewsForKeptProfiles(scratch.db, {
      ownerId: JACK,
      feeds: [WIRE, DAILY],
      client,
      search: NO_HISTORY,
    });

    expect(report.feeds.map((outcome) => "failure" in outcome)).toEqual([
      true,
      true,
    ]);
    expect(newsRunFailures(report)).toEqual([
      expect.stringContaining("could not read any of its"),
    ]);
  });

  it("fails a feed whose every item is rejected, since that is a changed shape and not a quiet day", async () => {
    const { client } = fakeClient({
      [WIRE.url]: rss(
        item("Ramp launches cards", "javascript:alert(1)"),
        item("Mercury launches cards", "ftp://wire.example/mercury"),
      ),
    });

    const report = await fetchNewsForKeptProfiles(scratch.db, {
      ownerId: JACK,
      feeds: [WIRE],
      client,
      search: NO_HISTORY,
    });

    expect(report.feeds).toEqual([
      {
        feed: "wire",
        failure: expect.stringMatching(
          /^rejected all 2 of its items, the first on rss\.channel\.item\.0\.link: /,
        ) as string,
      },
    ]);
    expect(newsRunFailures(report)).toEqual([
      expect.stringContaining("could not read any of its"),
    ]);
  });

  it("rejects a bad item by element and stores the others", async () => {
    const ramp = await companyProfile("Ramp", "fintech");
    await swipe(ramp, "keep");

    const { client } = fakeClient({
      [WIRE.url]: rss(
        item("Ramp launches cards", "javascript:alert(1)"),
        item("Ramp launches cards", "https://wire.example/ok"),
      ),
    });

    const report = await fetchNewsForKeptProfiles(scratch.db, {
      ownerId: JACK,
      feeds: [WIRE],
      client,
      search: NO_HISTORY,
    });

    expect(report.feeds).toMatchObject([
      {
        feed: "wire",
        articles: 1,
        rejections: [{ field: "rss.channel.item.0.link" }],
      },
    ]);
    expect(report.inserted).toBe(1);
  });

  it("searches each Kept Company Profile by its own site and its name, over the last twelve months", async () => {
    await swipe(
      await companyProfile(
        "Blacksmith",
        "developer-tools",
        JACK,
        "https://blacksmith.sh/",
      ),
      "keep",
    );
    await swipe(await companyProfile("Quiet Co", "other"), "keep");
    // Unswiped, so never searched for.
    await companyProfile("Ramp", "fintech", JACK, "https://ramp.com");

    const { client } = fakeClient({ [WIRE.url]: WIRE_FEED });
    const { search, requested } = fakeSearch(() => undefined);
    const urls: string[] = [];

    await fetchNewsForKeptProfiles(scratch.db, {
      ownerId: JACK,
      feeds: [WIRE],
      client,
      search: {
        search: (url) => {
          urls.push(url);
          return search.search(url);
        },
      },
      now: NOW,
    });

    // In name order. Quiet Co has no website, so it has no site query.
    expect(requested).toEqual([
      "url:blacksmith.sh",
      'title:"Blacksmith"',
      'title:"Quiet Co"',
    ]);

    const since = new Date("2025-09-20T00:00:00Z").getTime() / 1_000;
    expect(
      urls.map((url) => new URL(url).searchParams.get("numericFilters")),
    ).toEqual(Array(3).fill(`created_at_i>=${since}`));
  });

  it("scores each search result against the company it was searched for and no other", async () => {
    const blacksmith = await companyProfile(
      "Blacksmith",
      "developer-tools",
      JACK,
      "https://blacksmith.sh/",
    );
    const ramp = await companyProfile("Ramp", "fintech");
    await swipe(blacksmith, "keep");
    await swipe(ramp, "keep");

    const seed = hit(
      "1",
      "Blacksmith raises a seed round for faster CI for developers",
      "https://www.blacksmith.sh/blog/seed",
    );

    const { client } = fakeClient({ [WIRE.url]: rss() });
    const { search } = fakeSearch((query, restriction) => {
      if (restriction === "url") {
        return {
          hits: [
            seed,
            // Algolia's match, not ours: another host whose url carries the domain's words.
            hit(
              "2",
              "Blacksmith sh tricks",
              "https://blacksmith-sh.example/tricks",
            ),
          ],
        };
      }

      // Found by both queries, so stored once.
      return query === '"Blacksmith"'
        ? {
            hits: [seed, hit("3", "Ask HN: Anyone using Blacksmith?", null)],
          }
        : undefined;
    });

    const report = await fetchNewsForKeptProfiles(scratch.db, {
      ownerId: JACK,
      feeds: [WIRE],
      client,
      search,
      now: NOW,
    });

    expect(report.searches).toEqual([
      {
        company: "Blacksmith",
        articles: 2,
        tooCommonTitles: null,
        rejections: [],
      },
      { company: "Ramp", articles: 0, tooCommonTitles: null, rejections: [] },
    ]);
    expect(report.fromSearches).toMatchObject({ candidates: 2, shown: 1 });

    const stored = await scratch.db.select().from(newsItems);
    expect(new Set(stored.map((row) => row.profileId))).toEqual(
      new Set([blacksmith]),
    );
    expect(stored.map((row) => [row.url, row.sourceName]).sort()).toEqual([
      ["https://news.ycombinator.com/item?id=3", "Hacker News"],
      ["https://www.blacksmith.sh/blog/seed", "blacksmith.sh"],
    ]);

    const news = await readNews(scratch.db, JACK);
    expect(
      news.flatMap((group) => group.items.map((item) => item.url)),
    ).toEqual(["https://www.blacksmith.sh/blog/seed"]);
  });

  it("drops a name's title results when it is in too many titles to search by, and says so", async () => {
    await swipe(await companyProfile("Journey", "saas-enterprise"), "keep");

    const { client } = fakeClient({ [WIRE.url]: WIRE_FEED });
    const { search } = fakeSearch(() => ({
      hits: Array.from({ length: 11 }, (_, index) =>
        hit(
          String(index),
          `My AI adoption Journey, part ${index}`,
          `https://blog.example/${index}`,
        ),
      ),
    }));

    const report = await fetchNewsForKeptProfiles(scratch.db, {
      ownerId: JACK,
      feeds: [WIRE],
      client,
      search,
      now: NOW,
    });

    expect(report.searches).toEqual([
      { company: "Journey", articles: 0, tooCommonTitles: 11, rejections: [] },
    ]);
    expect(report.fromSearches.candidates).toBe(0);
    expect(summariseNewsRun(report)).toContain(
      "Journey: found 0 articles, by its site alone: its name is in 11 titles, too common to search by.",
    );
  });

  it("adds no rows when a search is run a second time", async () => {
    await swipe(await companyProfile("Blacksmith", "developer-tools"), "keep");

    const { client } = fakeClient({ [WIRE.url]: rss() });
    const { search } = fakeSearch(() => ({
      hits: [
        hit(
          "1",
          "Blacksmith launches",
          "https://www.blacksmith.sh/blog/launch",
        ),
      ],
    }));
    const run = () =>
      fetchNewsForKeptProfiles(scratch.db, {
        ownerId: JACK,
        feeds: [WIRE],
        client,
        search,
        now: NOW,
      });

    expect(await run()).toMatchObject({ inserted: 1, updated: 0 });
    expect(await run()).toMatchObject({ inserted: 0, updated: 1 });
    expect(await scratch.db.select().from(newsItems)).toHaveLength(1);
  });

  it("costs one company, naming the field, when its response has changed shape, and carries on", async () => {
    await swipe(await companyProfile("Blacksmith", "developer-tools"), "keep");
    await swipe(await companyProfile("Ramp", "fintech"), "keep");

    const { client } = fakeClient({ [WIRE.url]: WIRE_FEED });
    const { search } = fakeSearch((query) =>
      query === '"Blacksmith"'
        ? { results: [] }
        : {
            hits: [
              hit(
                "9",
                "Ramp raises a Series D for its corporate card",
                "https://ramp.com/blog/d",
              ),
            ],
          },
    );

    const report = await fetchNewsForKeptProfiles(scratch.db, {
      ownerId: JACK,
      feeds: [WIRE],
      client,
      search,
      now: NOW,
    });

    expect(report.searches).toEqual([
      {
        company: "Blacksmith",
        failure: expect.stringMatching(
          /^the title query was rejected on hits: /,
        ) as string,
      },
      { company: "Ramp", articles: 1, tooCommonTitles: null, rejections: [] },
    ]);
    expect(newsRunFailures(report)).toEqual([]);
  });

  it("fails, naming the searches, when the feeds were read and every search failed", async () => {
    await swipe(await companyProfile("Blacksmith", "developer-tools"), "keep");
    await swipe(await companyProfile("Ramp", "fintech"), "keep");

    const outage = "https://hn.algolia.com/api/v1/search answered 503";
    const { client } = fakeClient({ [WIRE.url]: WIRE_FEED });
    const { search } = fakeSearch(() => new Error(outage));

    const report = await fetchNewsForKeptProfiles(scratch.db, {
      ownerId: JACK,
      feeds: [WIRE],
      client,
      search,
      now: NOW,
    });

    expect(report.feeds).toEqual([
      { feed: "wire", articles: 2, rejections: [] },
    ]);
    expect(report.searches).toEqual([
      { company: "Blacksmith", failure: `the title query: ${outage}` },
      { company: "Ramp", failure: `the title query: ${outage}` },
    ]);
    expect(newsRunFailures(report)).toEqual([
      "News could not search for any of its 2 Kept companies.",
    ]);
    // The feeds' half still stored what it found.
    expect(report.inserted).toBe(4);
  });

  it("fails a search whose every hit is rejected, since that is a changed shape and not a quiet company", async () => {
    await swipe(await companyProfile("Blacksmith", "developer-tools"), "keep");

    const { client } = fakeClient({ [WIRE.url]: WIRE_FEED });
    const { search } = fakeSearch(() => ({
      hits: [
        { objectID: "1", title: "Blacksmith", url: "https://blacksmith.sh" },
      ],
    }));

    const report = await fetchNewsForKeptProfiles(scratch.db, {
      ownerId: JACK,
      feeds: [WIRE],
      client,
      search,
      now: NOW,
    });

    expect(report.searches).toEqual([
      {
        company: "Blacksmith",
        failure: expect.stringMatching(
          /^rejected all 1 of its hits, the first on hits\.0\.created_at_i: /,
        ) as string,
      },
    ]);
  });
});

describe("confidenceDistribution", () => {
  it("counts every score, highest first", () => {
    expect(
      confidenceDistribution([
        { confidence: 0 },
        { confidence: 0.4 },
        { confidence: 0 },
        { confidence: 0.65 },
      ]),
    ).toEqual([
      { confidence: 0.65, count: 1 },
      { confidence: 0.4, count: 1 },
      { confidence: 0, count: 2 },
    ]);
    expect(confidenceDistribution([])).toEqual([]);
  });
});

describe("summariseNewsRun", () => {
  const report: NewsRunReport = {
    companies: 2,
    feeds: [
      {
        feed: "techmeme",
        articles: 15,
        rejections: [
          { field: "rss.channel.item.3.link", reason: "Invalid URL", raw: {} },
        ],
      },
      { feed: "daily", failure: "https://daily.example/rss answered 503" },
    ],
    searches: [
      {
        company: "Blacksmith",
        articles: 10,
        tooCommonTitles: null,
        rejections: [{ field: "hits.4.url", reason: "Invalid URL", raw: {} }],
      },
      { company: "Ramp", failure: "the site query: answered 503" },
    ],
    fromFeeds: {
      candidates: 30,
      shown: 0,
      distribution: [
        { confidence: 0.4, count: 2 },
        { confidence: 0, count: 28 },
      ],
    },
    fromSearches: {
      candidates: 10,
      shown: 1,
      distribution: [
        { confidence: 0.6, count: 1 },
        { confidence: 0.4, count: 4 },
        { confidence: 0, count: 5 },
      ],
    },
    inserted: 35,
    updated: 5,
    rejections: [{ field: "url", reason: "Invalid URL", raw: {} }],
  };

  it("names every feed's and every search's outcome, then each path's scores in full", () => {
    expect(summariseNewsRun(report).split("\n")).toEqual([
      "Feeds:",
      "  techmeme: read 15 articles.",
      "    rejected on rss.channel.item.3.link: Invalid URL",
      "  daily: failed, https://daily.example/rss answered 503",
      "Searches, a year of Hacker News for each of 2 Kept Company Profiles:",
      "  Blacksmith: found 10 articles.",
      "    rejected on hits.4.url: Invalid URL",
      "  Ramp: failed, the site query: answered 503",
      "From feeds: 30 candidates, 0 at or above the display threshold of 0.6. Confidence: 0.4 ×2, 0 ×28.",
      "From searches: 10 candidates, 1 at or above the display threshold of 0.6. Confidence: 0.6 ×1, 0.4 ×4, 0 ×5.",
      "Stored 35 new and updated 5.",
      "  rejected on url: Invalid URL",
    ]);
  });

  it("fails when every feed failed, or there were none to read, or every search failed, saying which", () => {
    const allFeedsFailed = [
      { feed: "techmeme", failure: "answered 500" },
      { feed: "daily", failure: "answered 503" },
    ];
    const allSearchesFailed = [
      { company: "Blacksmith", failure: "answered 500" },
      { company: "Ramp", failure: "answered 503" },
    ];

    expect(newsRunFailures(report)).toEqual([]);
    // Nothing Kept is nothing to search for, not a failed search.
    expect(newsRunFailures({ ...report, companies: 0, searches: [] })).toEqual(
      [],
    );
    expect(newsRunFailures({ ...report, feeds: allFeedsFailed })).toEqual([
      "News could not read any of its 2 feeds.",
    ]);
    expect(newsRunFailures({ ...report, feeds: [] })).toEqual([
      "News could not read any of its 0 feeds.",
    ]);
    expect(newsRunFailures({ ...report, searches: allSearchesFailed })).toEqual(
      ["News could not search for any of its 2 Kept companies."],
    );
    expect(
      newsRunFailures({
        ...report,
        feeds: allFeedsFailed,
        searches: allSearchesFailed,
      }),
    ).toHaveLength(2);
  });
});
