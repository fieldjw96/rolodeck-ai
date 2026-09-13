// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

import { createGNewsThrottle } from "../ingest/throttle";
import {
  createGNewsClient,
  newsSearchUrl,
  parseGNewsResponse,
  readGNewsApiKey,
} from "./gnews";

/**
 * GNews's documented article shape, every field present, so a test that breaks one field is
 * breaking exactly that field. No capture of a live response is committed: there is no GNews
 * key in the environment a Run gets, and this repo does not hand-write fixtures and call them
 * captures. See docs/adr/0010.
 */
function article(overrides: Record<string, unknown> = {}) {
  return {
    id: "a1b2c3",
    title: "Ramp raises $150 million",
    description: "The fintech startup's valuation climbs.",
    content: "Ramp, the corporate card company... [1234 chars]",
    url: "https://techcrunch.example/2026/09/01/ramp-raises",
    image: "https://techcrunch.example/ramp.jpg",
    publishedAt: "2026-09-01T12:30:00Z",
    lang: "en",
    source: {
      id: "s1",
      name: "TechCrunch",
      url: "https://techcrunch.example",
      country: "us",
    },
    ...overrides,
  };
}

const API_KEY = "gnews-test-key-0123456789abcdef";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("parseGNewsResponse", () => {
  it("reads every valid article into what News stores", () => {
    const result = parseGNewsResponse({
      totalArticles: 2,
      articles: [
        article(),
        article({
          url: "https://another.example/story",
          description: "   ",
          publishedAt: "2026-09-02T08:00:00+02:00",
        }),
      ],
    });

    expect(result).toEqual({
      success: true,
      rejections: [],
      articles: [
        {
          title: "Ramp raises $150 million",
          description: "The fintech startup's valuation climbs.",
          url: "https://techcrunch.example/2026/09/01/ramp-raises",
          publishedAt: new Date("2026-09-01T12:30:00Z"),
          sourceName: "TechCrunch",
        },
        {
          title: "Ramp raises $150 million",
          description: null,
          url: "https://another.example/story",
          publishedAt: new Date("2026-09-02T06:00:00Z"),
          sourceName: "TechCrunch",
        },
      ],
    });
  });

  it("reads a response with no articles as no articles, not a failure", () => {
    expect(parseGNewsResponse({ totalArticles: 0, articles: [] })).toEqual({
      success: true,
      articles: [],
      rejections: [],
    });
  });

  it.each([
    [
      "an error body where results were expected",
      { errors: ["You have reached your request limit for today"] },
      "totalArticles",
    ],
    [
      "articles that are not a list",
      { totalArticles: 1, articles: "none" },
      "articles",
    ],
    ["no body at all", null, "(root)"],
    ["a string", "<html>Bad gateway</html>", "(root)"],
  ])(
    "rejects %s naming the field, without throwing",
    (_description, raw, field) => {
      const result = parseGNewsResponse(raw);

      expect(result.success).toBe(false);
      expect(result.success ? null : result.rejection.field).toBe(field);
    },
  );

  it.each([
    ["a javascript: url", { url: "javascript:alert(1)" }, "articles.0.url"],
    ["no title", { title: undefined }, "articles.0.title"],
    ["a blank title", { title: "  " }, "articles.0.title"],
    [
      "a published date that is not a date",
      { publishedAt: "yesterday" },
      "articles.0.publishedAt",
    ],
    [
      "a source with no name",
      { source: { id: "s1" } },
      "articles.0.source.name",
    ],
  ])(
    "rejects an article with %s by field, and keeps the others",
    (_description, overrides, field) => {
      const result = parseGNewsResponse({
        totalArticles: 2,
        articles: [article(overrides), article({ url: "https://ok.example/" })],
      });

      expect(result.success).toBe(true);

      if (result.success) {
        expect(result.rejections.map((rejection) => rejection.field)).toEqual([
          field,
        ]);
        expect(result.articles.map((kept) => kept.url)).toEqual([
          "https://ok.example/",
        ]);
      }
    },
  );
});

describe("newsSearchUrl", () => {
  it("searches for the name as an exact phrase, in titles and descriptions, newest first", () => {
    const url = new URL(newsSearchUrl('Acme "The Rocket" Co'));

    expect(`${url.origin}${url.pathname}`).toBe(
      "https://gnews.io/api/v4/search",
    );
    expect(url.searchParams.get("q")).toBe('"Acme The Rocket Co"');
    expect(url.searchParams.get("in")).toBe("title,description");
    expect(url.searchParams.get("sortby")).toBe("publishedAt");
    expect(url.searchParams.get("max")).toBe("10");
  });

  it("stays inside GNews's 200-character limit on q", () => {
    const q = new URL(newsSearchUrl("x".repeat(500))).searchParams.get("q");

    expect(q?.length).toBeLessThanOrEqual(200);
  });
});

describe("the GNews client", () => {
  const ok = (body: unknown) =>
    new Response(JSON.stringify(body), { status: 200 });

  it("waits for the throttle before every request", async () => {
    const events: string[] = [];
    const client = createGNewsClient({
      apiKey: API_KEY,
      throttle: {
        acquire: async () => {
          events.push("acquire");
        },
      },
      fetch: async () => {
        events.push("fetch");
        return ok({ totalArticles: 0, articles: [] });
      },
    });

    await client.search("Ramp");
    await client.search("Mercury");

    expect(events).toEqual(["acquire", "fetch", "acquire", "fetch"]);
  });

  it("spaces requests a second apart through the shared throttle", async () => {
    let time = 0;
    const sentAt: number[] = [];
    const client = createGNewsClient({
      apiKey: API_KEY,
      throttle: createGNewsThrottle({
        now: () => time,
        sleep: async (ms) => {
          time += ms;
        },
      }),
      fetch: async () => {
        sentAt.push(time);
        return ok({ totalArticles: 0, articles: [] });
      },
    });

    await Promise.all([
      client.search("Ramp"),
      client.search("Mercury"),
      client.search("Acme"),
    ]);

    expect(sentAt).toEqual([0, 1_000, 2_000]);
  });

  it("sends the key in a header, never in the URL", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      ok({ totalArticles: 0, articles: [] }),
    );
    const client = createGNewsClient({
      apiKey: API_KEY,
      throttle: { acquire: async () => {} },
      fetch,
    });

    await client.search("Ramp");

    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).not.toContain(API_KEY);
    expect(new Headers(init?.headers).get("X-Api-Key")).toBe(API_KEY);
  });

  it("returns the parsed body, unvalidated, for the parser to judge", async () => {
    const client = createGNewsClient({
      apiKey: API_KEY,
      throttle: { acquire: async () => {} },
      fetch: async () => ok({ anything: true }),
    });

    await expect(client.search("Ramp")).resolves.toEqual({ anything: true });
  });

  it.each([
    [401, "the API key is missing or invalid"],
    [403, "the daily quota is spent"],
    [429, "too many requests"],
    [418, "418"],
  ])(
    "throws on a %i saying what it means, and never with the key in the message",
    async (status, meaning) => {
      const client = createGNewsClient({
        apiKey: API_KEY,
        throttle: { acquire: async () => {} },
        fetch: async () =>
          new Response(JSON.stringify({ errors: ["nope"] }), { status }),
      });

      const error = await client
        .search("Ramp")
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(meaning);
      expect((error as Error).message).not.toContain(API_KEY);
    },
  );

  it("throws a readable error for a body that is not JSON", async () => {
    const client = createGNewsClient({
      apiKey: API_KEY,
      throttle: { acquire: async () => {} },
      fetch: async () => new Response("<html>", { status: 200 }),
    });

    await expect(client.search("Ramp")).rejects.toThrow("not JSON");
  });
});

describe("readGNewsApiKey", () => {
  it("reads the key from the environment", () => {
    vi.stubEnv("GNEWS_API_KEY", ` ${API_KEY} `);

    expect(readGNewsApiKey()).toBe(API_KEY);
  });

  it.each([
    ["unset", undefined],
    ["blank", "   "],
  ])("fails naming the variable when it is %s", (_description, value) => {
    vi.stubEnv("GNEWS_API_KEY", value);

    expect(() => readGNewsApiKey()).toThrow(/^GNEWS_API_KEY /);
  });
});
