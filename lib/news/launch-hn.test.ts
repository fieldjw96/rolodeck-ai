// @vitest-environment node
import { describe, expect, it } from "vitest";

import { readNewsSearchFixture } from "../testing/fixtures";
import { NEWS_DISPLAY_THRESHOLD, scoreNewsMatch } from "./match";
import {
  LAUNCH_HN_HITS_PER_QUERY,
  LAUNCH_HN_MIN_WINDOW_DAYS,
  LAUNCH_HN_SEARCH_ENDPOINT,
  launchHnSearchUrl,
  launchHnSince,
  parseLaunchHnSearch,
} from "./launch-hn";

/**
 * `db/fixtures/news-search-launch-hn.json` is a real response, taken with `curl` on 2026-10-24
 * from the url `launchHnSearchUrl` built for that day with no previous run, which its
 * `.meta.json` records. It carries the three Launch HN posts Hacker News had in the preceding
 * seven days, Alter's among them — the post Ticket #220 quoted as its example.
 */

const CAPTURED = new Date("2026-10-24T00:00:00Z");
const CAPTURED_SINCE = new Date("2026-10-17T00:00:00Z");

const DAY_MS = 24 * 60 * 60 * 1_000;

describe("launchHnSince", () => {
  it(`floors at ${LAUNCH_HN_MIN_WINDOW_DAYS} days ago when there is no previous run`, () => {
    expect(launchHnSince(null, CAPTURED)).toEqual(CAPTURED_SINCE);
  });

  it("floors at the minimum window when the previous run is more recent than it", () => {
    const yesterday = new Date(CAPTURED.getTime() - DAY_MS);
    expect(launchHnSince(yesterday, CAPTURED)).toEqual(CAPTURED_SINCE);
  });

  it("reaches back to the previous run when it is further back than the minimum window", () => {
    const aMonthAgo = new Date(CAPTURED.getTime() - 30 * DAY_MS);
    expect(launchHnSince(aMonthAgo, CAPTURED)).toEqual(aMonthAgo);
  });
});

describe("launchHnSearchUrl", () => {
  it("asks for the Launch HN phrase, in stories, since the given moment", () => {
    const url = new URL(launchHnSearchUrl(CAPTURED_SINCE));

    expect(url.origin + url.pathname).toBe(LAUNCH_HN_SEARCH_ENDPOINT);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      query: '"Launch HN"',
      tags: "story",
      typoTolerance: "false",
      numericFilters: `created_at_i>=${Math.floor(CAPTURED_SINCE.getTime() / 1_000)}`,
      hitsPerPage: String(LAUNCH_HN_HITS_PER_QUERY),
      attributesToRetrieve: "title,created_at_i,story_text",
    });
  });
});

describe("parseLaunchHnSearch, against the real capture", () => {
  it("records the url the capture was taken from, which is the url the code builds", async () => {
    const fixture = await readNewsSearchFixture("launch-hn");
    expect(fixture.capture).toEqual({
      sourceUrl: launchHnSearchUrl(CAPTURED_SINCE),
      capturedAt: "2026-10-24",
    });
  });

  it("reads every hit into a post, since every one of them is titled Launch HN", async () => {
    const { body } = await readNewsSearchFixture("launch-hn");
    const parsed = parseLaunchHnSearch(body, { since: CAPTURED_SINCE });

    expect(parsed).toMatchObject({ success: true, hits: 3, rejections: [] });
    if (!parsed.success) return;

    expect(parsed.articles).toHaveLength(3);
    expect(
      parsed.articles.every(
        (article) =>
          article.title.startsWith("Launch HN:") &&
          article.sourceName === "Hacker News" &&
          article.url.startsWith("https://news.ycombinator.com/item?id="),
      ),
    ).toBe(true);
  });

  it("reads the Alter post as its Hacker News item, whatever it itself links to", async () => {
    const { body } = await readNewsSearchFixture("launch-hn");
    const parsed = parseLaunchHnSearch(body, { since: CAPTURED_SINCE });

    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    const alter = parsed.articles.find((article) =>
      article.title.includes("Alter"),
    );

    expect(alter).toEqual({
      title: "Launch HN: Alter (YC S25) – Access control for multi-user agents",
      description: expect.stringContaining(
        "building access control for agents",
      ) as string,
      url: "https://news.ycombinator.com/item?id=50176908",
      publishedAt: new Date(1_792_564_932 * 1_000),
      sourceName: "Hacker News",
    });
  });

  it("scores the Alter post, against a fixture Profile named Alter, at or above the display threshold", async () => {
    const { body } = await readNewsSearchFixture("launch-hn");
    const parsed = parseLaunchHnSearch(body, { since: CAPTURED_SINCE });

    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    const alter = parsed.articles.find((article) =>
      article.title.includes("Alter"),
    )!;

    expect(
      scoreNewsMatch({ name: "Alter", sector: "security" }, alter),
    ).toBeGreaterThanOrEqual(NEWS_DISPLAY_THRESHOLD);
  });
});

describe("parseLaunchHnSearch", () => {
  const hit = (overrides: Record<string, unknown> = {}) => ({
    objectID: "1",
    title: "Launch HN: Acme (YC S26) – A thing that does a thing",
    created_at_i: Math.floor(CAPTURED.getTime() / 1_000) - 3600,
    story_text: "We built a thing.",
    ...overrides,
  });

  it("drops a hit not titled a Launch HN post, without rejecting it", () => {
    const parsed = parseLaunchHnSearch(
      { hits: [hit({ title: "Ask HN: What was your favourite Launch HN?" })] },
      { since: CAPTURED_SINCE },
    );

    expect(parsed).toMatchObject({ success: true, hits: 1, rejections: [] });
    expect(parsed.success && parsed.articles).toEqual([]);
  });

  it("drops a hit from before the window rather than taking the query's filter on trust", () => {
    const tooOld = Math.floor(CAPTURED_SINCE.getTime() / 1_000) - 3600;
    const parsed = parseLaunchHnSearch(
      { hits: [hit({ created_at_i: tooOld }), hit({ objectID: "2" })] },
      { since: CAPTURED_SINCE },
    );

    expect(parsed).toMatchObject({ success: true, hits: 2, rejections: [] });
    expect(parsed.success && parsed.articles).toHaveLength(1);
  });

  it("reads a text post with no story_text as one with no standfirst", () => {
    const parsed = parseLaunchHnSearch(
      { hits: [hit({ story_text: undefined })] },
      { since: CAPTURED_SINCE },
    );

    expect(parsed.success && parsed.articles[0]?.description).toBeNull();
  });

  it("rejects a response that has changed shape, naming the field", () => {
    expect(
      parseLaunchHnSearch({ results: [] }, { since: CAPTURED_SINCE }),
    ).toMatchObject({ success: false, rejection: { field: "hits" } });
    expect(parseLaunchHnSearch(null, { since: CAPTURED_SINCE })).toMatchObject({
      success: false,
      rejection: { field: "(root)" },
    });
  });

  it("rejects a bad hit by field and keeps the rest", () => {
    const parsed = parseLaunchHnSearch(
      {
        hits: [
          hit({ objectID: "../../evil" }),
          hit({ objectID: "2", title: "  " }),
          hit({ objectID: "3", created_at_i: "yesterday" }),
          hit({ objectID: "4" }),
        ],
      },
      { since: CAPTURED_SINCE },
    );

    expect(parsed).toMatchObject({
      success: true,
      hits: 4,
      rejections: [
        { field: "hits.0.objectID" },
        { field: "hits.1.title" },
        { field: "hits.2.created_at_i" },
      ],
    });
    expect(parsed.success && parsed.articles).toHaveLength(1);
  });

  it("reads no hits as a quiet week, not a changed shape", () => {
    expect(
      parseLaunchHnSearch({ hits: [] }, { since: CAPTURED_SINCE }),
    ).toEqual({ success: true, hits: 0, articles: [], rejections: [] });
  });
});
