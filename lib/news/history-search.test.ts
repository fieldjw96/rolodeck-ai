// @vitest-environment node
import { describe, expect, it } from "vitest";

import { readNewsSearchFixture } from "../testing/fixtures";
import {
  HISTORY_WINDOW_DAYS,
  HITS_PER_QUERY,
  MAX_TITLE_HITS,
  companyDomain,
  historyQueries,
  parseHistorySearch,
  type HistoryQuery,
} from "./history-search";

/**
 * `db/fixtures/news-search-blacksmith-{site,title}.json` are real responses, taken with `curl`
 * on 2026-09-20 from exactly the urls `historyQueries` builds for Blacksmith as of that day,
 * which each `.meta.json` records. Blacksmith is a Kept company with a site of its own and a name
 * that is also a word, so its two captures carry both what the queries are for and the noise
 * they have to live with.
 */

const CAPTURED = new Date("2026-09-20T00:00:00Z");
const BLACKSMITH = { name: "Blacksmith", website: "https://blacksmith.sh/" };

const queryOf = (kind: HistoryQuery["kind"]): HistoryQuery =>
  historyQueries(BLACKSMITH, CAPTURED).find((query) => query.kind === kind)!;

const A_MONTH_AGO = Math.floor(CAPTURED.getTime() / 1_000) - 30 * 86_400;

const hit = (overrides: Record<string, unknown> = {}) => ({
  objectID: "1",
  title: "Blacksmith raises a seed round",
  url: "https://www.blacksmith.sh/blog/seed",
  created_at_i: A_MONTH_AGO,
  ...overrides,
});

describe("companyDomain", () => {
  it.each([
    ["https://blacksmith.sh/", "blacksmith.sh"],
    ["https://www.kaso.ai", "kaso.ai"],
    ["http://Journey.IO", "journey.io"],
    ["https://inflection-space.com/", "inflection-space.com"],
  ])("reads %s as %s", (website, domain) => {
    expect(companyDomain(website)).toBe(domain);
  });

  it.each([
    // A page on a host the company does not own: the domain would be everybody's.
    ["https://github.com/acme/acme"],
    ["https://www.ycombinator.com/companies/acme"],
    ["not a url"],
    ["ftp://acme.com"],
    ["http://localhost"],
  ])("finds no domain worth searching in %s", (website) => {
    expect(companyDomain(website)).toBeNull();
  });

  it("finds none without a website", () => {
    expect(companyDomain(null)).toBeNull();
  });
});

describe("historyQueries", () => {
  it("searches the company's own domain in the url and its name as an exact title phrase", () => {
    const [site, title] = historyQueries(BLACKSMITH, CAPTURED);

    expect(site).toMatchObject({ kind: "site", domain: "blacksmith.sh" });
    expect(Object.fromEntries(new URL(site!.url).searchParams)).toMatchObject({
      query: "blacksmith.sh",
      restrictSearchableAttributes: "url",
    });

    expect(title).toMatchObject({ kind: "title" });
    expect(Object.fromEntries(new URL(title!.url).searchParams)).toMatchObject({
      query: '"Blacksmith"',
      restrictSearchableAttributes: "title",
      advancedSyntax: "true",
    });
  });

  it("constrains every query to stories, no typos, the last twelve months and a capped page", () => {
    const since = CAPTURED.getTime() / 1_000 - HISTORY_WINDOW_DAYS * 86_400;

    for (const query of historyQueries(BLACKSMITH, CAPTURED)) {
      const url = new URL(query.url);

      expect(url.origin + url.pathname).toBe(
        "https://hn.algolia.com/api/v1/search",
      );
      expect(Object.fromEntries(url.searchParams)).toMatchObject({
        tags: "story",
        typoTolerance: "false",
        numericFilters: `created_at_i>=${since}`,
        hitsPerPage: String(HITS_PER_QUERY),
      });
    }
    expect(HISTORY_WINDOW_DAYS).toBe(365);
  });

  it("searches by name alone when there is no site of the company's own", () => {
    expect(
      historyQueries(
        { name: "Acme", website: "https://github.com/acme" },
        CAPTURED,
      ).map((query) => query.kind),
    ).toEqual(["title"]);
  });

  it("keeps a quote in a name from ending the phrase early", () => {
    const [title] = historyQueries(
      { name: 'The "Best" Co', website: null },
      CAPTURED,
    );

    expect(new URL(title!.url).searchParams.get("query")).toBe('"The Best Co"');
  });
});

describe("parseHistorySearch, against the real captures", () => {
  it("records the url each capture was taken from, which is the url the query builds", async () => {
    for (const kind of ["site", "title"] as const) {
      const fixture = await readNewsSearchFixture(`blacksmith-${kind}`);
      expect(fixture.capture).toEqual({
        sourceUrl: queryOf(kind).url,
        capturedAt: "2026-09-20",
      });
    }
  });

  it("reads every hit on the company's own site as an article from that site", async () => {
    const { body } = await readNewsSearchFixture("blacksmith-site");
    const parsed = parseHistorySearch(queryOf("site"), body, CAPTURED);

    expect(parsed).toMatchObject({
      success: true,
      hits: 8,
      tooCommon: false,
      rejections: [],
    });
    if (!parsed.success) return;

    expect(parsed.articles).toHaveLength(8);
    expect(
      parsed.articles.every(
        (article) =>
          article.url.startsWith("https://www.blacksmith.sh/") &&
          article.sourceName === "blacksmith.sh",
      ),
    ).toBe(true);
    expect(parsed.articles[0]).toEqual({
      title: "The GitHub Actions control plane is no longer free",
      description: null,
      url: "https://www.blacksmith.sh/blog/actions-pricing",
      publishedAt: new Date(1_765_906_654 * 1_000),
      sourceName: "blacksmith.sh",
    });
  });

  it("reads the title search's namesakes as articles too, for the matcher to score", async () => {
    const { body } = await readNewsSearchFixture("blacksmith-title");
    const parsed = parseHistorySearch(queryOf("title"), body, CAPTURED);

    expect(parsed).toMatchObject({ success: true, hits: 5, tooCommon: false });
    if (!parsed.success) return;

    expect(parsed.articles.map((article) => article.sourceName)).toEqual([
      "blacksmith.sh",
      "github.com",
      "theconversation.com",
      "blacksmith.sh",
      "tailscale.com",
    ]);
  });
});

describe("parseHistorySearch", () => {
  it("keeps a site query's hits only when they are on the company's domain or a subdomain of it", () => {
    const parsed = parseHistorySearch(
      queryOf("site"),
      {
        hits: [
          hit({ objectID: "1", url: "https://blacksmith.sh/a" }),
          hit({ objectID: "2", url: "https://docs.blacksmith.sh/b" }),
          hit({ objectID: "3", url: "https://open-blacksmith.sh.example/c" }),
          hit({ objectID: "4", url: "https://notblacksmith.sh/d" }),
          hit({ objectID: "5", url: null }),
        ],
      },
      CAPTURED,
    );

    expect(
      parsed.success && parsed.articles.map((article) => article.url),
    ).toEqual(["https://blacksmith.sh/a", "https://docs.blacksmith.sh/b"]);
  });

  it("stores a text post as its Hacker News item, its body as the standfirst", () => {
    const parsed = parseHistorySearch(
      queryOf("title"),
      {
        hits: [
          hit({
            objectID: "42",
            url: null,
            story_text: "<p>We use Blacksmith for CI &amp; love it.</p>",
          }),
        ],
      },
      CAPTURED,
    );

    expect(parsed.success && parsed.articles).toEqual([
      {
        title: "Blacksmith raises a seed round",
        description: "We use Blacksmith for CI & love it.",
        url: "https://news.ycombinator.com/item?id=42",
        publishedAt: new Date(A_MONTH_AGO * 1_000),
        sourceName: "Hacker News",
      },
    ]);
  });

  it("drops a hit from before the window rather than taking the query's filter on trust", () => {
    const tooOld =
      Math.floor(CAPTURED.getTime() / 1_000) -
      (HISTORY_WINDOW_DAYS + 1) * 86_400;
    const parsed = parseHistorySearch(
      queryOf("title"),
      { hits: [hit({ created_at_i: tooOld }), hit({ objectID: "2" })] },
      CAPTURED,
    );

    expect(parsed).toMatchObject({ success: true, hits: 2, rejections: [] });
    expect(parsed.success && parsed.articles).toHaveLength(1);
  });

  it(`reads more than ${MAX_TITLE_HITS} title hits as a name too common to search by, and keeps none`, () => {
    const hits = (count: number) =>
      Array.from({ length: count }, (_, index) =>
        hit({ objectID: String(index), url: `https://x.example/${index}` }),
      );

    expect(
      parseHistorySearch(
        queryOf("title"),
        { hits: hits(MAX_TITLE_HITS) },
        CAPTURED,
      ),
    ).toMatchObject({ tooCommon: false, articles: { length: MAX_TITLE_HITS } });
    expect(
      parseHistorySearch(
        queryOf("title"),
        { hits: hits(MAX_TITLE_HITS + 1) },
        CAPTURED,
      ),
    ).toMatchObject({
      tooCommon: true,
      hits: MAX_TITLE_HITS + 1,
      articles: [],
    });
  });

  it("rejects a response that has changed shape, naming the field", () => {
    expect(
      parseHistorySearch(queryOf("site"), { results: [] }, CAPTURED),
    ).toMatchObject({ success: false, rejection: { field: "hits" } });
    expect(parseHistorySearch(queryOf("site"), null, CAPTURED)).toMatchObject({
      success: false,
      rejection: { field: "(root)" },
    });
  });

  it("rejects a bad hit by field and keeps the rest", () => {
    const parsed = parseHistorySearch(
      queryOf("title"),
      {
        hits: [
          hit({ objectID: "1", url: "javascript:alert(1)" }),
          hit({ objectID: "2", title: "  " }),
          hit({ objectID: "3", created_at_i: "yesterday" }),
          hit({ objectID: "../../evil", url: null }),
          hit({ objectID: "4" }),
        ],
      },
      CAPTURED,
    );

    expect(parsed).toMatchObject({
      success: true,
      hits: 5,
      rejections: [
        { field: "hits.0.url" },
        { field: "hits.1.title" },
        { field: "hits.2.created_at_i" },
        { field: "hits.3.objectID" },
      ],
    });
    expect(parsed.success && parsed.articles).toHaveLength(1);
  });

  it("reads no hits as a quiet company, not a changed shape", () => {
    expect(
      parseHistorySearch(queryOf("title"), { hits: [] }, CAPTURED),
    ).toEqual({
      success: true,
      hits: 0,
      tooCommon: false,
      articles: [],
      rejections: [],
    });
  });
});
