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
import type { GNewsClient } from "./gnews";
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

/** GNews's documented article shape. See `gnews.test.ts` on why nothing here is a capture. */
function article(
  title: string,
  url: string,
  description: string | null = null,
) {
  return {
    id: url,
    title,
    description,
    content: "",
    url,
    image: null,
    publishedAt: "2026-09-01T12:00:00Z",
    lang: "en",
    source: { id: "s1", name: "TechCrunch", url: "https://techcrunch.example" },
  };
}

const results = (...articles: unknown[]) => ({
  totalArticles: articles.length,
  articles,
});

/** A provider that answers from a table and records every company it was asked about. */
function fakeProvider(answers: Readonly<Record<string, unknown>>) {
  const searched: string[] = [];

  const client: GNewsClient = {
    search: async (companyName) => {
      searched.push(companyName);
      const answer = answers[companyName];

      if (answer instanceof Error) {
        throw answer;
      }

      return answer ?? results();
    },
  };

  return { client, searched };
}

const RAMP_NEWS = results(
  article(
    "Ramp raises $150 million to expand its corporate card and expense platform",
    "https://techcrunch.example/ramp-raises",
    "The fintech startup's valuation climbs.",
  ),
  // A namesake: stored, scored low, never shown.
  article(
    "Highway ramp closures planned for the weekend",
    "https://local.example/ramp-closures",
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
  it("searches for Kept Company Profiles only — never an unswiped one, a Passed one, or another account's", async () => {
    const ramp = await companyProfile("Ramp", "fintech");
    const mercury = await companyProfile("Mercury", "fintech");
    await companyProfile("Quiet Co", "other");
    const theirs = await companyProfile("Theirs Inc", "security", SOMEONE_ELSE);

    await swipe(ramp, "keep");
    await swipe(mercury, "pass");
    await swipe(theirs, "keep", SOMEONE_ELSE);

    const { client, searched } = fakeProvider({});
    const report = await fetchNewsForKeptProfiles(scratch.db, {
      ownerId: JACK,
      client,
    });

    expect(searched).toEqual(["Ramp"]);
    expect(report.companies).toBe(1);
  });

  it("searches for nothing at all when nothing is Kept", async () => {
    await companyProfile("Ramp", "fintech");

    const { client, searched } = fakeProvider({});
    const report = await fetchNewsForKeptProfiles(scratch.db, {
      ownerId: JACK,
      client,
    });

    expect(searched).toEqual([]);
    expect(newsRunFailed(report)).toBe(false);
  });

  it("stores every article with its score, including the namesake below the threshold, and shows only the match", async () => {
    const ramp = await companyProfile("Ramp", "fintech");
    await swipe(ramp, "keep");

    const { client } = fakeProvider({ Ramp: RAMP_NEWS });
    const report = await fetchNewsForKeptProfiles(scratch.db, {
      ownerId: JACK,
      client,
    });

    expect(report).toMatchObject({ articles: 2, shown: 1, inserted: 2 });

    const stored = await scratch.db.select().from(newsItems);
    expect(stored).toHaveLength(2);
    expect(
      stored.find((row) => row.url === "https://local.example/ramp-closures")
        ?.confidence,
    ).toBeLessThan(0.6);

    const news = await readNews(scratch.db, JACK);
    expect(
      news.flatMap((group) => group.items.map((item) => item.url)),
    ).toEqual(["https://techcrunch.example/ramp-raises"]);
  });

  it("adds no rows when run a second time over the same articles", async () => {
    const ramp = await companyProfile("Ramp", "fintech");
    await swipe(ramp, "keep");
    const { client } = fakeProvider({ Ramp: RAMP_NEWS });

    await fetchNewsForKeptProfiles(scratch.db, { ownerId: JACK, client });
    const afterFirst = (await scratch.db.select().from(newsItems)).length;

    const second = await fetchNewsForKeptProfiles(scratch.db, {
      ownerId: JACK,
      client,
    });

    expect((await scratch.db.select().from(newsItems)).length).toBe(afterFirst);
    expect(second).toMatchObject({ inserted: 0, updated: afterFirst });
  });

  it("carries on past a company the provider fails for, and names it", async () => {
    const ramp = await companyProfile("Ramp", "fintech");
    const mercury = await companyProfile("Mercury", "fintech");
    await swipe(ramp, "keep");
    await swipe(mercury, "keep");

    const { client, searched } = fakeProvider({
      Ramp: new Error("GNews answered 429 (too many requests in a short time)"),
      Mercury: results(
        article(
          "Mercury, the startup bank, launches business credit cards",
          "https://techcrunch.example/mercury-cards",
        ),
      ),
    });

    const report = await fetchNewsForKeptProfiles(scratch.db, {
      ownerId: JACK,
      client,
    });

    expect([...searched].sort()).toEqual(["Mercury", "Ramp"]);
    expect(report.failures).toEqual([
      {
        company: "Ramp",
        reason: "GNews answered 429 (too many requests in a short time)",
      },
    ]);
    expect(report.inserted).toBe(1);
    expect(newsRunFailed(report)).toBe(true);
  });

  it("does not throw on a malformed payload: the company fails naming the field, and a bad article is rejected by field", async () => {
    const ramp = await companyProfile("Ramp", "fintech");
    const mercury = await companyProfile("Mercury", "fintech");
    await swipe(ramp, "keep");
    await swipe(mercury, "keep");

    const { client } = fakeProvider({
      Ramp: { errors: ["You have reached your request limit for today"] },
      Mercury: results(
        article("Mercury launches cards", "javascript:alert(1)"),
        article("Mercury launches cards", "https://ok.example/mercury"),
      ),
    });

    const report = await fetchNewsForKeptProfiles(scratch.db, {
      ownerId: JACK,
      client,
    });

    expect(report.failures).toHaveLength(1);
    expect(report.failures[0]!.company).toBe("Ramp");
    expect(report.failures[0]!.reason).toContain("totalArticles");
    expect(report.rejections.map((rejection) => rejection.field)).toEqual([
      "articles.0.url",
    ]);
    expect(report.inserted).toBe(1);
  });
});

describe("summariseNewsRun", () => {
  const report: NewsRunReport = {
    companies: 2,
    articles: 7,
    shown: 3,
    inserted: 5,
    updated: 2,
    failures: [{ company: "Ramp", reason: "GNews answered 403" }],
    rejections: [{ field: "articles.0.url", reason: "Invalid URL", raw: {} }],
  };

  it("says what was searched, stored and shown, and names every failure and rejection", () => {
    const summary = summariseNewsRun(report);

    expect(summary).toContain("2 Kept Company Profiles");
    expect(summary).toContain(
      "7 articles, 3 at or above the display threshold of 0.6",
    );
    expect(summary).toContain("Stored 5 new and updated 2");
    expect(summary).toContain("failed for Ramp: GNews answered 403");
    expect(summary).toContain("rejected on articles.0.url: Invalid URL");
  });

  it("fails the run only when a company could not be searched for", () => {
    expect(newsRunFailed(report)).toBe(true);
    expect(newsRunFailed({ ...report, failures: [], articles: 0 })).toBe(false);
  });
});
