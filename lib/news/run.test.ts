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
import {
  fetchNewsForKeptProfiles,
  newsRunFailed,
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
      website: null,
      provenance: SEEDED_PROVENANCE,
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
    });

    expect(report).toMatchObject({ companies: 1, candidates: 2 });

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
    });

    expect(requested).toEqual([WIRE.url, DAILY.url]);
    expect(report).toMatchObject({
      companies: 0,
      candidates: 0,
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
    expect(newsRunFailed(report)).toBe(false);
  });

  it("stores every article with its score, including the namesake below the threshold, and shows only the match", async () => {
    const ramp = await companyProfile("Ramp", "fintech");
    await swipe(ramp, "keep");

    const { client } = fakeClient({ [WIRE.url]: WIRE_FEED });
    const report = await fetchNewsForKeptProfiles(scratch.db, {
      ownerId: JACK,
      feeds: [WIRE],
      client,
    });

    expect(report).toMatchObject({ candidates: 2, shown: 1, inserted: 2 });

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
    });

    // Three articles, two companies.
    expect(report).toMatchObject({ candidates: 6, inserted: 6 });

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
    });
    const afterFirst = (await scratch.db.select().from(newsItems)).length;

    const second = await fetchNewsForKeptProfiles(scratch.db, {
      ownerId: JACK,
      feeds: [WIRE],
      client,
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
    expect(newsRunFailed(report)).toBe(false);
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
    });

    expect(report.feeds.map((outcome) => "failure" in outcome)).toEqual([
      true,
      true,
    ]);
    expect(newsRunFailed(report)).toBe(true);
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
    });

    expect(report.feeds).toEqual([
      {
        feed: "wire",
        failure: expect.stringMatching(
          /^rejected all 2 of its items, the first on rss\.channel\.item\.0\.link: /,
        ) as string,
      },
    ]);
    expect(newsRunFailed(report)).toBe(true);
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
    candidates: 30,
    shown: 3,
    inserted: 25,
    updated: 5,
    rejections: [{ field: "url", reason: "Invalid URL", raw: {} }],
  };

  it("names every feed's outcome, then says what was scored, stored and shown", () => {
    expect(summariseNewsRun(report).split("\n")).toEqual([
      "techmeme: read 15 articles.",
      "  rejected on rss.channel.item.3.link: Invalid URL",
      "daily: failed, https://daily.example/rss answered 503",
      "Scored against 2 Kept Company Profiles: 30 candidates, 3 at or above the display threshold of 0.6.",
      "Stored 25 new and updated 5.",
      "  rejected on url: Invalid URL",
    ]);
  });

  it("fails only when every feed failed, or there were none to read", () => {
    expect(newsRunFailed(report)).toBe(false);
    expect(
      newsRunFailed({ ...report, companies: 0, candidates: 0, inserted: 0 }),
    ).toBe(false);
    expect(
      newsRunFailed({
        ...report,
        feeds: [
          { feed: "techmeme", failure: "answered 500" },
          { feed: "daily", failure: "answered 503" },
        ],
      }),
    ).toBe(true);
    expect(newsRunFailed({ ...report, feeds: [] })).toBe(true);
  });
});
