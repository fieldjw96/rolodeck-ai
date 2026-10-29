// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { readNews } from "../../db/news";
import type { Sector } from "../../db/profile-input";
import {
  newsArticles,
  newsItems,
  newsProfileCoverage,
  newsProfileSiteRecovery,
  profiles,
  swipes,
  type SwipeDecision,
} from "../../db/schema";
import { createScratchDb, type ScratchDb } from "../../db/testing/scratch-db";
import { SEEDED_PROVENANCE } from "../../db/testing/seed-profiles";
import type { NewsFeedClient } from "./feed-fetch";
import type { NewsFeed } from "./feeds";
import { HISTORY_SEARCHES_PER_RUN } from "./history-search";
import type { HistorySearchClient } from "./history-search-fetch";
import { LAUNCH_HN_MIN_WINDOW_DAYS } from "./launch-hn";
import {
  confidenceDistribution,
  fetchNewsForTheCatalogue,
  newsRunFailures,
  summariseNewsRun,
  type NewsRunReport,
} from "./run";

const JACK = "11111111-1111-1111-1111-111111111111";
const SOMEONE_ELSE = "22222222-2222-2222-2222-222222222222";

const FIRST_CREATED_AT = Date.UTC(2026, 0, 1, 9, 0, 0);
const A_MINUTE = 60_000;

let scratch: ScratchDb;
/** Company Profiles are created a minute apart, so "oldest first" is a fact about the data. */
let created = 0;

async function companyProfile(
  name: string,
  sector: Sector,
  website: string | null = null,
): Promise<string> {
  const [row] = await scratch.db
    .insert(profiles)
    .values({
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
      createdAt: new Date(FIRST_CREATED_AT + created++ * A_MINUTE),
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
 * company's own site — and recording every per-company history-search query it was sent, as
 * `query` and restriction. Launch HN's own request, to a different endpoint
 * (`search_by_date`, not `search`), is answered the same way but left out of `requested`: these
 * tests are about the history search, and Launch HN gets its own.
 */
function fakeSearch(answer: (query: string, restriction: string) => unknown) {
  const requested: string[] = [];

  const search: HistorySearchClient = {
    search: async (url) => {
      const parsed = new URL(url);
      const query = parsed.searchParams.get("query") ?? "";
      const restriction =
        parsed.searchParams.get("restrictSearchableAttributes") ?? "";

      if (parsed.pathname === "/api/v1/search") {
        requested.push(`${restriction}:${query}`);
      }

      const answered = answer(query, restriction);

      if (answered instanceof Error) {
        throw answered;
      }

      return answered ?? { hits: [] };
    },
  };

  return { search, requested };
}

/**
 * A search client that answers Launch HN's `search_by_date` request and nothing else — every
 * per-company `search` request gets `{ hits: [] }`, which is what these tests about Launch HN
 * alone want from the history search.
 */
function fakeLaunchHn(answer: () => unknown): HistorySearchClient {
  return {
    search: async (url) => {
      if (new URL(url).pathname !== "/api/v1/search_by_date") {
        return { hits: [] };
      }

      const answered = answer();

      if (answered instanceof Error) {
        throw answered;
      }

      return answered ?? { hits: [] };
    },
  };
}

/** One Launch HN hit, titled as the real ones are, a day old unless overridden. */
const launchHnHit = (
  objectID: string,
  title: string,
  createdAtI = Math.floor(NOW.getTime() / 1_000) - 24 * 60 * 60,
) => ({ objectID, title: `Launch HN: ${title}`, created_at_i: createdAtI });

const WIRE_FEED = rss(
  item(
    "Ramp raises $150 million to expand its corporate card and expense platform",
    "https://wire.example/ramp-raises",
    "<p>The fintech startup's valuation climbs.</p>",
  ),
  // A namesake: scored, counted, and attributed to nobody.
  item(
    "Highway ramp closures planned for the weekend",
    "https://wire.example/ramp-closures",
  ),
);

/** One run, with whatever the test wants to vary. */
const run = (
  options: {
    feeds?: readonly NewsFeed[];
    client?: NewsFeedClient;
    search?: HistorySearchClient;
    now?: Date;
  } = {},
) =>
  fetchNewsForTheCatalogue(scratch.db, {
    feeds: options.feeds ?? [WIRE],
    client: options.client ?? fakeClient({ [WIRE.url]: WIRE_FEED }).client,
    search: options.search ?? NO_HISTORY,
    now: options.now ?? NOW,
  });

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
  await scratch.db.delete(newsProfileSiteRecovery);
  await scratch.db.delete(swipes);
  await scratch.db.delete(profiles);
  created = 0;
});

describe("fetchNewsForTheCatalogue", () => {
  it("scores every new feed article against every Company Profile in the Catalogue, whoever swiped what", async () => {
    const ramp = await companyProfile("Ramp", "fintech");
    await companyProfile("Mercury", "fintech");
    await companyProfile("Quiet Co", "other");
    // Passed, unswiped, and Kept by the other User: gathering does not read a swipe at all.
    await swipe(ramp, "pass");

    const report = await run();

    // Two articles against three Company Profiles.
    expect(report).toMatchObject({
      companies: 3,
      fromFeeds: { candidates: 6 },
      fromStored: { candidates: 0 },
    });

    // Only the pairs the matcher placed at all became rows, and both are about Ramp: the one
    // that clears the threshold and the namesake that is stored and hidden.
    const stored = await scratch.db.select().from(newsItems);
    expect(stored.map((row) => row.profileId)).toEqual([ramp, ramp]);
    expect(report).toMatchObject({
      inserted: 2,
      unattributed: 4,
      fromFeeds: { shown: 1 },
    });
  });

  it("attributes one article to the one Company Profile of three that it is about", async () => {
    const ramp = await companyProfile("Ramp", "fintech");
    await companyProfile("Mercury", "fintech");
    await companyProfile("Quiet Co", "other");

    const { client } = fakeClient({
      [WIRE.url]: rss(
        item(
          "Ramp raises $150 million to expand its corporate card and expense platform",
          "https://wire.example/ramp-raises",
        ),
      ),
    });

    const report = await run({ client });

    // Three pairs scored, one stored: the two the matcher placed at zero are counted and
    // dropped, per docs/adr/0022, and the article itself is kept whoever it was about.
    expect(report).toMatchObject({
      fromFeeds: { candidates: 3, shown: 1 },
      inserted: 1,
      unattributed: 2,
      articles: { stored: 1, fresh: 1 },
    });

    const stored = await scratch.db.select().from(newsItems);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.profileId).toBe(ramp);
    expect(await scratch.db.select().from(newsArticles)).toHaveLength(1);
  });

  it("proves the Ticket's outcome: a User Keeps a company nobody else has, and finds its News", async () => {
    const ramp = await companyProfile("Ramp", "fintech");
    // Kept by the second User and by nobody else. Under docs/adr/0019 this gathered nothing.
    await swipe(ramp, "keep", SOMEONE_ELSE);

    await run();

    const news = await readNews(scratch.db, SOMEONE_ELSE);
    expect(
      news.map((group) => [
        group.profile.name,
        group.items.map((entry) => entry.url),
      ]),
    ).toEqual([["Ramp", ["https://wire.example/ramp-raises"]]]);
    // And still nothing for the User who Kept nothing.
    expect(await readNews(scratch.db, JACK)).toEqual([]);
  });

  it("stores each feed article once, however many times the feed is read", async () => {
    await companyProfile("Ramp", "fintech");

    const first = await run();
    const second = await run();

    expect(first.articles).toMatchObject({ stored: 2, fresh: 2 });
    expect(second.articles).toMatchObject({ stored: 2, fresh: 0 });
    expect(
      (await scratch.db.select().from(newsArticles)).map((row) => row.url),
    ).toEqual([
      "https://wire.example/ramp-raises",
      "https://wire.example/ramp-closures",
    ]);
  });

  it("stores an article the whole Catalogue scored zero against, so a later company can be scored against it", async () => {
    await companyProfile("Quiet Co", "other");

    const report = await run();

    expect(report).toMatchObject({
      fromFeeds: { candidates: 2, shown: 0 },
      inserted: 0,
      unattributed: 2,
    });
    expect(await scratch.db.select().from(newsItems)).toEqual([]);
    expect(await scratch.db.select().from(newsArticles)).toHaveLength(2);
    expect(newsRunFailures(report)).toEqual([]);
  });

  it("scores a Company Profile new to News against the articles earlier runs read", async () => {
    await companyProfile("Quiet Co", "other");
    await run();

    // Ramp arrives the day after the article about it was read.
    const ramp = await companyProfile("Ramp", "fintech");
    const second = await run();

    expect(second).toMatchObject({
      companies: 2,
      fromFeeds: { candidates: 0 },
      fromStored: { candidates: 2, shown: 1 },
    });

    const stored = await scratch.db.select().from(newsItems);
    expect(stored.map((row) => [row.profileId, row.url])).toEqual([
      [ramp, "https://wire.example/ramp-raises"],
      [ramp, "https://wire.example/ramp-closures"],
    ]);
  });

  it("scores no pair twice: an article read today is not also scored as a stored one", async () => {
    const ramp = await companyProfile("Ramp", "fintech");

    const report = await run();

    expect(report).toMatchObject({
      fromFeeds: { candidates: 2 },
      fromStored: { candidates: 0 },
    });
    expect(report.inserted).toBe(2);
    expect(await scratch.db.select().from(newsItems)).toHaveLength(2);
    expect(
      (await scratch.db.select().from(newsProfileCoverage)).map(
        (row) => row.profileId,
      ),
    ).toEqual([ramp]);
  });

  it("adds no rows when run a second time over unchanged feeds", async () => {
    await companyProfile("Ramp", "fintech");

    const first = await run();
    const second = await run();

    expect(first).toMatchObject({ inserted: 2, updated: 0 });
    expect(second).toMatchObject({ inserted: 0, updated: 0 });
    expect(await scratch.db.select().from(newsItems)).toHaveLength(2);
  });

  it("reads every feed once, even when the Catalogue is empty, and does not call matching nothing a failure", async () => {
    const { client, requested } = fakeClient({ [WIRE.url]: WIRE_FEED });
    const report = await run({ feeds: [WIRE, DAILY], client });

    expect(requested).toEqual([WIRE.url, DAILY.url]);
    expect(report).toMatchObject({
      companies: 0,
      searches: [],
      waiting: 0,
      fromFeeds: { candidates: 0 },
      inserted: 0,
      articles: { stored: 2, fresh: 2 },
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

  it("stores an attribution every signed-in User can read, whoever is watching the company", async () => {
    await companyProfile("Ramp", "fintech");
    await run();

    await scratch.as("authenticated", SOMEONE_ELSE);
    const items = await scratch.db.select().from(newsItems);
    const articles = await scratch.db.select().from(newsArticles);
    const seenSwipes = await scratch.db.select().from(swipes);
    await scratch.reset();

    expect(items).toHaveLength(2);
    expect(articles).toHaveLength(2);
    expect(seenSwipes).toEqual([]);
  });

  it("scores every article from every feed against every company, and stores each pair once", async () => {
    const ramp = await companyProfile("Ramp", "fintech");
    const mercury = await companyProfile("Mercury", "fintech");

    const { client } = fakeClient({
      [WIRE.url]: WIRE_FEED,
      [DAILY.url]: rss(
        item(
          "Mercury and Ramp both launch business credit cards for startups",
          "https://daily.example/cards",
        ),
      ),
    });

    const report = await run({ feeds: [WIRE, DAILY], client });

    // Three articles, two companies.
    expect(report).toMatchObject({
      fromFeeds: { candidates: 6 },
      onSeveralCompanies: 1,
    });

    const cards = (await scratch.db.select().from(newsItems)).filter(
      (row) => row.url === "https://daily.example/cards",
    );
    expect(new Set(cards.map((row) => row.profileId))).toEqual(
      new Set([ramp, mercury]),
    );
    expect(cards.every((row) => row.confidence >= 0.6)).toBe(true);
    expect(summariseNewsRun(report)).toContain(
      "1 article from feeds or Launch HN cleared the threshold against more than one Company Profile.",
    );
  });

  it("carries on past a feed that cannot be fetched and one that no longer parses, naming each, and still stores the rest", async () => {
    await companyProfile("Ramp", "fintech");

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

    const report = await run({ feeds: [DAILY, broken, WIRE], client });

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
    expect(report.articles).toMatchObject({ stored: 2, fresh: 2 });
    expect(report.inserted).toBe(2);
    expect(newsRunFailures(report)).toEqual([]);
  });

  it("fails when every feed failed", async () => {
    const { client } = fakeClient({
      [WIRE.url]: new Error("https://wire.example/feed.xml answered 500"),
      [DAILY.url]: "not xml at all <",
    });

    const report = await run({ feeds: [WIRE, DAILY], client });

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

    const report = await run({ client });

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
    await companyProfile("Ramp", "fintech");

    const { client } = fakeClient({
      [WIRE.url]: rss(
        item("Ramp launches cards", "javascript:alert(1)"),
        item("Ramp launches cards", "https://wire.example/ok"),
      ),
    });

    const report = await run({ client });

    expect(report.feeds).toMatchObject([
      {
        feed: "wire",
        articles: 1,
        rejections: [{ field: "rss.channel.item.0.link" }],
      },
    ]);
    expect(report.articles).toMatchObject({ stored: 1, fresh: 1 });
    expect(report.inserted).toBe(1);
  });

  it("searches each Company Profile new to News by its own site and its name, over two years", async () => {
    await companyProfile(
      "Blacksmith",
      "developer-tools",
      "https://blacksmith.sh/",
    );
    await companyProfile("Quiet Co", "other");

    const { search, requested } = fakeSearch(() => undefined);
    // The per-company history search alone: Launch HN reads a different endpoint and is not
    // what this test is about.
    const urls: string[] = [];

    await run({
      search: {
        search: (url) => {
          if (new URL(url).pathname === "/api/v1/search") {
            urls.push(url);
          }
          return search.search(url);
        },
      },
    });

    // Oldest Company Profile first. Quiet Co has no website, so it has no site query.
    expect(requested).toEqual([
      "url:blacksmith.sh",
      'title:"Blacksmith"',
      'title:"Quiet Co"',
    ]);

    const since = new Date("2024-09-20T00:00:00Z").getTime() / 1_000;
    expect(
      urls.map((url) => new URL(url).searchParams.get("numericFilters")),
    ).toEqual(Array(3).fill(`created_at_i>=${since}`));
  });

  it("scores each search result against the company it was searched for and no other", async () => {
    const blacksmith = await companyProfile(
      "Blacksmith",
      "developer-tools",
      "https://blacksmith.sh/",
    );
    await companyProfile("Ramp", "fintech");

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

    const report = await run({ client, search });

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

    // Searched for Blacksmith, so never attributed to Ramp.
    const stored = await scratch.db.select().from(newsItems);
    expect(new Set(stored.map((row) => row.profileId))).toEqual(
      new Set([blacksmith]),
    );
    expect(stored.map((row) => [row.url, row.sourceName]).sort()).toEqual([
      ["https://news.ycombinator.com/item?id=3", "Hacker News"],
      ["https://www.blacksmith.sh/blog/seed", "blacksmith.sh"],
    ]);
    // Both articles are kept, each carrying the one Company Profile it was searched for, so
    // nothing else is ever scored against them. See docs/adr/0024.
    expect(report.searchArticles).toMatchObject({ stored: 2, fresh: 2 });
    expect(
      (await scratch.db.select().from(newsArticles))
        .map((row) => [row.url, row.searchedForProfileId])
        .sort(),
    ).toEqual([
      ["https://news.ycombinator.com/item?id=3", blacksmith],
      ["https://www.blacksmith.sh/blog/seed", blacksmith],
    ]);
  });

  it("keeps an article a search found even when it scored zero, so a retune can still reach it", async () => {
    const quiet = await companyProfile("Quiet Co", "other");

    const { client } = fakeClient({ [WIRE.url]: rss() });
    const { search } = fakeSearch(() => ({
      hits: [hit("1", "A quiet week in AI", "https://blog.example/quiet-week")],
    }));

    const report = await run({ client, search });

    // The matcher placed it at zero, so it is no pair and no `news_items` row.
    expect(report.fromSearches).toMatchObject({
      candidates: 1,
      shown: 0,
      distribution: [{ confidence: 0, count: 1 }],
    });
    expect(await scratch.db.select().from(newsItems)).toEqual([]);
    // The article itself is stored all the same, which is what docs/adr/0024 changed.
    expect(report.searchArticles).toMatchObject({ stored: 1, fresh: 1 });
    expect(
      (await scratch.db.select().from(newsArticles)).map((row) => [
        row.url,
        row.searchedForProfileId,
      ]),
    ).toEqual([["https://blog.example/quiet-week", quiet]]);
  });

  it("never scores an article a search found against another Company Profile, on a later run", async () => {
    const blacksmith = await companyProfile(
      "Blacksmith",
      "developer-tools",
      "https://blacksmith.sh/",
    );

    const { client } = fakeClient({ [WIRE.url]: rss() });
    const { search } = fakeSearch((_query, restriction) =>
      restriction === "url"
        ? {
            hits: [
              hit(
                "1",
                "Ramp now runs its CI on Blacksmith",
                "https://blacksmith.sh/blog/ramp",
              ),
            ],
          }
        : { hits: [] },
    );

    await run({ client, search });

    // Ramp arrives the next day, and the article stored for Blacksmith names it in its title.
    const ramp = await companyProfile("Ramp", "fintech");
    const second = await run({ client, search });

    // Not one pair formed: the article belongs to Blacksmith's search. See docs/adr/0018.
    expect(second.fromStored).toMatchObject({ candidates: 0 });

    const stored = await scratch.db.select().from(newsItems);
    expect(stored.filter((row) => row.profileId === ramp)).toEqual([]);
    expect(new Set(stored.map((row) => row.profileId))).toEqual(
      new Set([blacksmith]),
    );
  });

  it("leaves an article a feed carried first as Catalogue when a search finds the same url", async () => {
    await companyProfile(
      "Blacksmith",
      "developer-tools",
      "https://blacksmith.sh/",
    );
    const url = "https://blacksmith.sh/blog/seed";

    const { client } = fakeClient({
      [WIRE.url]: rss(item("Blacksmith raises a seed round", url)),
    });
    const { search } = fakeSearch((_query, restriction) =>
      restriction === "url"
        ? { hits: [hit("1", "Blacksmith raises a seed round", url)] }
        : { hits: [] },
    );

    await run({ client, search });

    const articles = await scratch.db.select().from(newsArticles);
    expect(articles.map((row) => [row.url, row.searchedForProfileId])).toEqual([
      [url, null],
    ]);
  });

  it("shows a company's own announcement to a User who Keeps it, and never its essay", async () => {
    const acme = await companyProfile("Acme", "ai-ml", "https://acme.com/");
    await swipe(acme, "keep");

    const { client } = fakeClient({ [WIRE.url]: rss() });
    const { search } = fakeSearch((_query, restriction) =>
      restriction === "url"
        ? {
            hits: [
              hit(
                "1",
                "Introducing Agent OS",
                "https://acme.com/blog/agent-os",
              ),
              hit(
                "2",
                "Why agents need guardrails",
                "https://acme.com/blog/guardrails",
              ),
            ],
          }
        : { hits: [] },
    );

    const report = await run({ client, search });

    // Both kept, neither naming Acme, so the matcher scored both zero and the news-only rule
    // decided between them. See docs/adr/0024.
    expect(report.searchArticles).toMatchObject({ stored: 2, fresh: 2 });
    expect(report.fromSearches).toMatchObject({
      candidates: 2,
      shown: 1,
      distribution: [
        { confidence: 0.6, count: 1 },
        { confidence: 0, count: 1 },
      ],
    });

    const news = await readNews(scratch.db, JACK);
    expect(
      news.map((group) => [
        group.profile.name,
        group.items.map((entry) => entry.url),
      ]),
    ).toEqual([["Acme", ["https://acme.com/blog/agent-os"]]]);
  });

  it("caps an own-site essay the matcher placed below the display threshold, so it is stored and not shown", async () => {
    const acme = await companyProfile("Acme", "ai-ml", "https://acme.com/");
    await swipe(acme, "keep");

    const { client } = fakeClient({ [WIRE.url]: rss() });
    const { search } = fakeSearch((_query, restriction) =>
      restriction === "url"
        ? {
            hits: [
              hit(
                "1",
                "Why Acme thinks AI agents need guardrails",
                "https://acme.com/blog/guardrails",
              ),
            ],
          }
        : { hits: [] },
    );

    const report = await run({ client, search });

    // 0.7 from the matcher — the name in the headline and two Sector terms — capped at 0.59.
    expect(report.fromSearches.distribution).toEqual([
      { confidence: 0.59, count: 1 },
    ]);
    expect(
      (await scratch.db.select().from(newsItems)).map((row) => row.confidence),
    ).toEqual([0.59]);
    expect(await readNews(scratch.db, JACK)).toEqual([]);
  });

  it("does not search a Company Profile again once it has been searched, even one nothing was found for", async () => {
    await companyProfile("Quiet Co", "other");

    const { search, requested } = fakeSearch(() => ({ hits: [] }));
    const first = await run({ search });
    const second = await run({ search });

    expect(requested).toEqual(['title:"Quiet Co"']);
    expect(first).toMatchObject({ covered: 1, waiting: 0 });
    expect(first.searches).toEqual([
      {
        company: "Quiet Co",
        articles: 0,
        tooCommonTitles: null,
        rejections: [],
      },
    ]);
    // Nothing found is a quiet company, recorded all the same: docs/adr/0022.
    expect(await scratch.db.select().from(newsItems)).toEqual([]);
    expect(second.searches).toEqual([]);
    expect(second).toMatchObject({ covered: 0, fromStored: { candidates: 0 } });
  });

  it("does not record a Company Profile whose search failed, and searches it again next run", async () => {
    await companyProfile("Blacksmith", "developer-tools");

    const outage = "https://hn.algolia.com/api/v1/search answered 503";
    let failing = true;
    const { search, requested } = fakeSearch(() =>
      failing ? new Error(outage) : { hits: [] },
    );

    const first = await run({ search });

    expect(first.searches).toEqual([
      { company: "Blacksmith", failure: `the title query: ${outage}` },
    ]);
    expect(first.covered).toBe(0);
    expect(await scratch.db.select().from(newsProfileCoverage)).toEqual([]);

    failing = false;
    const second = await run({ search });

    expect(requested).toEqual(['title:"Blacksmith"', 'title:"Blacksmith"']);
    expect(second).toMatchObject({ covered: 1 });
    expect(second.searches).toMatchObject([{ company: "Blacksmith" }]);
  });

  it("caps the searches per run, taking the oldest Company Profiles first and saying how many wait", async () => {
    // One more than the cap would be hundreds of Profiles; the cap is asserted against itself.
    const names = Array.from(
      { length: HISTORY_SEARCHES_PER_RUN + 2 },
      (_unused, index) => `Company ${String(index).padStart(4, "0")}`,
    );
    for (const name of names) {
      await companyProfile(name, "other");
    }

    const { search } = fakeSearch(() => ({ hits: [] }));
    const first = await run({ search });

    expect(first.searches).toHaveLength(HISTORY_SEARCHES_PER_RUN);
    expect(first.searches.map((outcome) => outcome.company)).toEqual(
      names.slice(0, HISTORY_SEARCHES_PER_RUN),
    );
    expect(first).toMatchObject({
      waiting: 2,
      covered: HISTORY_SEARCHES_PER_RUN,
    });
    expect(summariseNewsRun(first)).toContain("with 2 still waiting:");

    const second = await run({ search });

    expect(second.searches.map((outcome) => outcome.company)).toEqual(
      names.slice(HISTORY_SEARCHES_PER_RUN),
    );
    expect(second).toMatchObject({ waiting: 0 });
  }, 60_000);

  it("drops a name's title results when it is in too many titles to search by, and says so", async () => {
    await companyProfile("Journey", "saas-enterprise");

    const { search } = fakeSearch(() => ({
      hits: Array.from({ length: 11 }, (_unused, index) =>
        hit(
          String(index),
          `My AI adoption Journey, part ${index}`,
          `https://blog.example/${index}`,
        ),
      ),
    }));

    const report = await run({ search });

    expect(report.searches).toEqual([
      { company: "Journey", articles: 0, tooCommonTitles: 11, rejections: [] },
    ]);
    expect(report.fromSearches.candidates).toBe(0);
    expect(summariseNewsRun(report)).toContain(
      "Journey: found 0 articles, by its site alone: its name is in 11 titles, too common to search by.",
    );
  });

  it("costs one company, naming the field, when its response has changed shape, and carries on", async () => {
    await companyProfile("Blacksmith", "developer-tools");
    await companyProfile("Ramp", "fintech");

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

    const report = await run({ search });

    expect(report.searches).toEqual([
      {
        company: "Blacksmith",
        failure: expect.stringMatching(
          /^the title query was rejected on hits: /,
        ) as string,
      },
      { company: "Ramp", articles: 1, tooCommonTitles: null, rejections: [] },
    ]);
    expect(report.covered).toBe(1);
    expect(newsRunFailures(report)).toEqual([]);
  });

  it("fails, naming the searches, when the feeds were read and every search failed", async () => {
    await companyProfile("Blacksmith", "developer-tools");
    await companyProfile("Ramp", "fintech");

    const outage = "https://hn.algolia.com/api/v1/search answered 503";
    const { search } = fakeSearch(() => new Error(outage));

    const report = await run({ search });

    expect(report.feeds).toEqual([
      { feed: "wire", articles: 2, rejections: [] },
    ]);
    expect(report.searches).toEqual([
      { company: "Blacksmith", failure: `the title query: ${outage}` },
      { company: "Ramp", failure: `the title query: ${outage}` },
    ]);
    expect(newsRunFailures(report)).toEqual([
      "News could not search for any of the 2 Company Profiles it tried.",
    ]);
    // The feeds' half still stored what it found.
    expect(report.articles).toMatchObject({ stored: 2, fresh: 2 });
    expect(report.inserted).toBe(2);
  });

  it("fails a search whose every hit is rejected, since that is a changed shape and not a quiet company", async () => {
    await companyProfile("Blacksmith", "developer-tools");

    const { search } = fakeSearch(() => ({
      hits: [
        { objectID: "1", title: "Blacksmith", url: "https://blacksmith.sh" },
      ],
    }));

    const report = await run({ search });

    expect(report.searches).toEqual([
      {
        company: "Blacksmith",
        failure: expect.stringMatching(
          /^rejected all 1 of its hits, the first on hits\.0\.created_at_i: /,
        ) as string,
      },
    ]);
    expect(report.covered).toBe(0);
  });

  it("reads Launch HN and scores its posts against every Company Profile, like a feed article", async () => {
    const alter = await companyProfile("Alter", "security");
    await companyProfile("Quiet Co", "other");

    const { client } = fakeClient({ [WIRE.url]: rss() });
    const search = fakeLaunchHn(() => ({
      hits: [
        launchHnHit(
          "1",
          "Alter (YC S25) – Access control for multi-user agents",
        ),
      ],
    }));

    const report = await run({ client, search });

    expect(report.launchHn).toEqual({ articles: 1, rejections: [] });
    // One Launch HN post against two Company Profiles.
    expect(report.fromFeeds).toMatchObject({ candidates: 2 });
    expect(report.articles).toMatchObject({ stored: 1, fresh: 1 });

    const stored = await scratch.db.select().from(newsItems);
    expect(stored.map((row) => row.profileId)).toEqual([alter]);
    expect(
      (await scratch.db.select().from(newsArticles)).map((row) => [
        row.url,
        row.sourceName,
      ]),
    ).toEqual([["https://news.ycombinator.com/item?id=1", "Hacker News"]]);
  });

  it("names a Launch HN failure in the report without failing the run beside a feed that succeeded", async () => {
    await companyProfile("Ramp", "fintech");

    const outage = "https://hn.algolia.com/api/v1/search_by_date answered 503";
    const search = fakeLaunchHn(() => new Error(outage));

    const report = await run({ search });

    expect(report.launchHn).toEqual({ failure: outage });
    expect(report.feeds).toMatchObject([{ feed: "wire" }]);
    expect(newsRunFailures(report)).toEqual([]);
  });

  it("is not a failure for NEWS_FEEDS to be empty when Launch HN was read", async () => {
    const search = fakeLaunchHn(() => ({ hits: [] }));

    const report = await run({ feeds: [], search });

    expect(report.feeds).toEqual([]);
    expect(report.launchHn).toEqual({ articles: 0, rejections: [] });
    expect(newsRunFailures(report)).toEqual([]);
  });

  it("widens its window to the newest Launch HN post already stored, past the minimum", async () => {
    const old = new Date(
      NOW.getTime() - (LAUNCH_HN_MIN_WINDOW_DAYS + 20) * 24 * 60 * 60 * 1_000,
    );

    await scratch.db.insert(newsArticles).values({
      title: "Launch HN: Previously (YC S24) – An earlier post",
      description: null,
      url: "https://news.ycombinator.com/item?id=0",
      publishedAt: old,
      sourceName: "Hacker News",
    });

    const sinceSeen: string[] = [];
    const search: HistorySearchClient = {
      search: async (url) => {
        const parsed = new URL(url);
        if (parsed.pathname === "/api/v1/search_by_date") {
          sinceSeen.push(parsed.searchParams.get("numericFilters") ?? "");
        }
        return { hits: [] };
      },
    };

    await run({ search });

    expect(sinceSeen).toEqual([
      `created_at_i>=${Math.floor(old.getTime() / 1_000)}`,
    ]);
  });

  it("re-searches an already-covered company's own site once, and then never again", async () => {
    await companyProfile("Acme", "ai-ml", "https://acme.com/");

    const { client } = fakeClient({ [WIRE.url]: rss() });
    const { search, requested } = fakeSearch((_query, restriction) =>
      restriction === "url"
        ? {
            hits: [
              hit(
                "1",
                "Announcing our seed round",
                "https://acme.com/blog/seed",
              ),
            ],
          }
        : { hits: [] },
    );

    // Nothing to recover on the run that covers it: `covered` is read before the searches.
    const first = await run({ client, search });
    expect(first.reSearches).toEqual({ done: 0, failed: 0, waiting: 0 });

    const second = await run({ client, search });

    expect(second).toMatchObject({
      searches: [],
      reSearches: { done: 1, failed: 0, waiting: 0 },
    });
    // The site query again, and not the title query, which never lost anything.
    expect(requested).toEqual(["url:acme.com", 'title:"Acme"', "url:acme.com"]);
    expect(
      (await scratch.db.select().from(newsProfileSiteRecovery)).map(
        (row) => row.profileId,
      ),
    ).toHaveLength(1);
    expect(summariseNewsRun(second)).toContain(
      "Re-searched the site query for 1 Company Profile already covered, 0 failed, with 0 still waiting.",
    );

    // Recorded, so the third run spends nothing on it.
    const third = await run({ client, search });
    expect(third.reSearches).toEqual({ done: 0, failed: 0, waiting: 0 });
    expect(requested).toHaveLength(3);
  });

  it("records nothing for a re-search that failed, and runs it again next run", async () => {
    await companyProfile("Acme", "ai-ml", "https://acme.com/");

    const outage = "https://hn.algolia.com/api/v1/search answered 503";
    let failing = false;
    const { client } = fakeClient({ [WIRE.url]: rss() });
    const { search } = fakeSearch((_query, restriction) =>
      restriction === "url" && failing ? new Error(outage) : { hits: [] },
    );

    await run({ client, search });

    failing = true;
    const second = await run({ client, search });

    expect(second.reSearches).toEqual({ done: 0, failed: 1, waiting: 0 });
    expect(await scratch.db.select().from(newsProfileSiteRecovery)).toEqual([]);

    failing = false;
    const third = await run({ client, search });

    expect(third.reSearches).toEqual({ done: 1, failed: 0, waiting: 0 });
  });

  it("never re-searches a company with no searchable website, since it has no site query to re-run", async () => {
    await companyProfile("Quiet Co", "other");
    // A website that is a page on somebody else's host is not a domain to search by.
    await companyProfile("Hosted Co", "other", "https://github.com/hosted");

    const { client } = fakeClient({ [WIRE.url]: rss() });
    const { search, requested } = fakeSearch(() => ({ hits: [] }));

    await run({ client, search });
    const second = await run({ client, search });

    expect(second.reSearches).toEqual({ done: 0, failed: 0, waiting: 0 });
    expect(requested).toEqual(['title:"Quiet Co"', 'title:"Hosted Co"']);
  });

  it("spends nothing on a re-search when the first searches used the whole cap, and picks it up next run", async () => {
    await companyProfile("Acme", "ai-ml", "https://acme.com/");

    const { client } = fakeClient({ [WIRE.url]: rss() });
    const { search, requested } = fakeSearch(() => ({ hits: [] }));

    // Acme is covered, and waiting for its own-site re-search.
    await run({ client, search });
    expect(requested).toEqual(["url:acme.com", 'title:"Acme"']);

    for (let index = 0; index < HISTORY_SEARCHES_PER_RUN; index += 1) {
      await companyProfile(
        `Company ${String(index).padStart(4, "0")}`,
        "other",
      );
    }

    const second = await run({ client, search });

    // Every search this run went to a Company Profile that had never had one. First searches
    // come first, and the re-search waits. See docs/adr/0024.
    expect(second.searches).toHaveLength(HISTORY_SEARCHES_PER_RUN);
    expect(second.reSearches).toEqual({ done: 0, failed: 0, waiting: 1 });
    expect(requested).toHaveLength(2 + HISTORY_SEARCHES_PER_RUN);

    const third = await run({ client, search });

    expect(third).toMatchObject({
      searches: [],
      reSearches: { done: 1, failed: 0, waiting: 0 },
    });
    expect(requested.at(-1)).toBe("url:acme.com");
  }, 120_000);
});

describe("confidenceDistribution", () => {
  it("counts every score, highest first", () => {
    expect(confidenceDistribution([0, 0.4, 0, 0.65])).toEqual([
      { confidence: 0.65, count: 1 },
      { confidence: 0.4, count: 1 },
      { confidence: 0, count: 2 },
    ]);
    expect(confidenceDistribution([])).toEqual([]);
  });
});

describe("summariseNewsRun", () => {
  const report: NewsRunReport = {
    companies: 400,
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
    launchHn: { articles: 3, rejections: [] },
    articles: { stored: 15, fresh: 4, rejections: [] },
    searches: [
      {
        company: "Blacksmith",
        articles: 10,
        tooCommonTitles: null,
        rejections: [{ field: "hits.4.url", reason: "Invalid URL", raw: {} }],
      },
      { company: "Ramp", failure: "the site query: answered 503" },
    ],
    waiting: 198,
    reSearches: { done: 2, failed: 1, waiting: 7 },
    covered: 1,
    searchArticles: { stored: 10, fresh: 8, rejections: [] },
    fromFeeds: {
      candidates: 1_600,
      shown: 2,
      distribution: [
        { confidence: 0.6, count: 2 },
        { confidence: 0.4, count: 2 },
        { confidence: 0, count: 1_596 },
      ],
    },
    fromStored: {
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
    onSeveralCompanies: 1,
    inserted: 9,
    updated: 2,
    unattributed: 1_629,
    rejections: [{ field: "url", reason: "Invalid URL", raw: {} }],
  };

  it("names every feed's and every search's outcome, then each path's scores in full", () => {
    expect(summariseNewsRun(report).split("\n")).toEqual([
      "Feeds:",
      "  techmeme: read 15 articles.",
      "    rejected on rss.channel.item.3.link: Invalid URL",
      "  daily: failed, https://daily.example/rss answered 503",
      "Launch HN: read 3 posts.",
      "Stored 15 articles from feeds and Launch HN, 4 new to the Catalogue.",
      "Searches, 730 days of Hacker News for each of 2 Company Profiles new to News, with 198 still waiting:",
      "  Blacksmith: found 10 articles.",
      "    rejected on hits.4.url: Invalid URL",
      "  Ramp: failed, the site query: answered 503",
      "Re-searched the site query for 2 Company Profiles already covered, 1 failed, with 7 still waiting.",
      "Stored 10 articles from searches, 8 new to the Catalogue.",
      "From feeds and Launch HN: 1600 candidates, 2 at or above the display threshold of 0.6. Confidence: 0.6 ×2, 0.4 ×2, 0 ×1596.",
      "From stored articles: 30 candidates, 0 at or above the display threshold of 0.6. Confidence: 0.4 ×2, 0 ×28.",
      "From searches and re-searches: 10 candidates, 1 at or above the display threshold of 0.6. Confidence: 0.6 ×1, 0.4 ×4, 0 ×5.",
      "1 article from feeds or Launch HN cleared the threshold against more than one Company Profile.",
      "Stored 9 new and updated 2; 1629 pairs scored zero and were not stored.",
      "Covered 1 Company Profile of 400 in the Catalogue.",
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
    // Nothing new to News is nothing to search for, not a failed search.
    expect(newsRunFailures({ ...report, searches: [] })).toEqual([]);
    expect(newsRunFailures({ ...report, feeds: allFeedsFailed })).toEqual([
      "News could not read any of its 2 feeds.",
    ]);
    // Empty since Ticket #220 removed Techmeme (docs/adr/0023): nothing configured to read is
    // nothing to have failed at reading, not a failure on its own.
    expect(newsRunFailures({ ...report, feeds: [] })).toEqual([]);
    // Launch HN has no rule of its own: failing it, alone, never fails the run. See docs/adr/0023.
    expect(
      newsRunFailures({
        ...report,
        feeds: [],
        launchHn: { failure: "answered 503" },
      }),
    ).toEqual([]);
    expect(newsRunFailures({ ...report, searches: allSearchesFailed })).toEqual(
      ["News could not search for any of the 2 Company Profiles it tried."],
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
