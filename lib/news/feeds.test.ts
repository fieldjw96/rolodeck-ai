// @vitest-environment node
import { describe, expect, it } from "vitest";

import { readNewsFeedFixture } from "../testing/fixtures";
import { NEWS_FEEDS, parseNewsFeed, type NewsFeed } from "./feeds";

/**
 * Every feed in `NEWS_FEEDS` has a capture under `db/fixtures/news-feed-<name>.xml`, taken with
 * `curl` from the URL its `.meta.json` records and committed byte-for-byte. See `feeds.ts` for
 * each feed's `robots.txt` position.
 */

const TECHMEME = NEWS_FEEDS.find((feed) => feed.name === "techmeme")!;

const FEED: NewsFeed = {
  name: "example",
  publication: "Example Daily",
  url: "https://news.example/feed.xml",
};

type Item = Partial<
  Record<"title" | "link" | "description" | "pubDate", string>
>;

/** An RSS 2.0 item, every element present unless overridden; `undefined` drops one. */
function item(overrides: Item = {}): string {
  const elements: Item = {
    title: "Ramp raises $150 million",
    link: "https://news.example/ramp-raises",
    description: "<p>The fintech startup&apos;s valuation climbs.</p>",
    pubDate: "Tue, 01 Sep 2026 12:30:00 GMT",
    ...overrides,
  };

  return `<item>${Object.entries(elements)
    .filter(([, value]) => value !== undefined)
    .map(([name, value]) =>
      name === "description"
        ? `<description><![CDATA[${value}]]></description>`
        : `<${name}>${value}</${name}>`,
    )
    .join("")}<guid>${elements.link ?? "none"}</guid></item>`;
}

const rss = (...items: string[]) =>
  `<?xml version="1.0"?><rss version="2.0"><channel><title>Example</title>${items.join("")}</channel></rss>`;

describe("NEWS_FEEDS", () => {
  it.each(NEWS_FEEDS.map((feed) => [feed.name, feed] as const))(
    "has a committed capture of %s, taken from the url it reads",
    async (name, feed) => {
      const fixture = await readNewsFeedFixture(name);

      expect(fixture.capture.sourceUrl).toBe(feed.url);
    },
  );

  it("names each feed once", () => {
    expect(new Set(NEWS_FEEDS.map((feed) => feed.name)).size).toBe(
      NEWS_FEEDS.length,
    );
    expect(new Set(NEWS_FEEDS.map((feed) => feed.url)).size).toBe(
      NEWS_FEEDS.length,
    );
  });
});

describe("parseNewsFeed, against the captured Techmeme feed", () => {
  it("reads every item into an article, rejecting none", async () => {
    const { xml } = await readNewsFeedFixture("techmeme");
    const result = parseNewsFeed(TECHMEME, xml);

    expect(result.success).toBe(true);

    if (result.success) {
      expect(result.rejections).toEqual([]);
      expect(result.articles).toHaveLength(15);
      expect(
        result.articles.every((article) => article.sourceName === "Techmeme"),
      ).toBe(true);
    }
  });

  it("reads a headline and a standfirst the matcher can use, with the markup gone", async () => {
    const { xml } = await readNewsFeedFixture("techmeme");
    const result = parseNewsFeed(TECHMEME, xml);

    expect(result.success && result.articles[0]).toEqual({
      title:
        "Noetive, which is developing an industrial AI model for businesses in physical industries, emerges from stealth with a $41M seed led by Eclipse (Sarah Klearman/Wall Street Journal)",
      description: expect.stringContaining(
        "The AI lab is developing a model that would work alongside businesses in construction, logistics and manufacturing",
      ) as string,
      url: "https://www.techmeme.com/260916/p34#a260916p34",
      publishedAt: new Date("2026-09-16T15:40:01Z"),
      sourceName: "Techmeme",
    });

    for (const article of result.success ? result.articles : []) {
      expect(article.description).not.toMatch(/<|HREF|SRC=/i);
      expect(article.title).not.toContain("&apos;");
    }
  });
});

describe("parseNewsFeed", () => {
  it("reads a feed with a single item, which XML gives as one element rather than a list", () => {
    const result = parseNewsFeed(FEED, rss(item()));

    expect(result).toEqual({
      success: true,
      rejections: [],
      articles: [
        {
          title: "Ramp raises $150 million",
          description: "The fintech startup's valuation climbs.",
          url: "https://news.example/ramp-raises",
          publishedAt: new Date("2026-09-01T12:30:00Z"),
          sourceName: "Example Daily",
        },
      ],
    });
  });

  it("reads a missing or empty description as none", () => {
    const result = parseNewsFeed(
      FEED,
      rss(
        item({ description: undefined }),
        item({ description: " <br/> ", link: "https://news.example/b" }),
      ),
    );

    expect(
      result.success && result.articles.map((article) => article.description),
    ).toEqual([null, null]);
  });

  it.each([
    [
      "a body that is not well-formed",
      "<rss><channel><item></channel></rss>",
      "(document)",
      "example is not well-formed XML",
    ],
    [
      "an HTML error page",
      "<html><body>Bad gateway</body></html>",
      "rss",
      "example is not an RSS 2.0 feed: its root element is <html>",
    ],
    [
      "a feed with no items",
      rss(),
      "rss.channel.item",
      "example: must have at least one item",
    ],
    [
      "a feed with no channel",
      '<rss version="2.0"><title>Example</title></rss>',
      "rss.channel",
      "example:",
    ],
    ["an empty body", "", "(document)", "example is not well-formed XML"],
  ])(
    "rejects %s as the whole feed, naming the feed and the element, without throwing",
    (_description, body, field, reason) => {
      const result = parseNewsFeed(FEED, body);

      expect(result.success).toBe(false);

      if (!result.success) {
        expect(result.rejection.field).toBe(field);
        expect(result.rejection.reason).toContain(reason);
      }
    },
  );

  it.each([
    [
      "a javascript: link",
      { link: "javascript:alert(1)" },
      "rss.channel.item.0.link",
    ],
    ["no title", { title: undefined }, "rss.channel.item.0.title"],
    ["a blank title", { title: "  " }, "rss.channel.item.0.title"],
    ["no pubDate", { pubDate: undefined }, "rss.channel.item.0.pubDate"],
    [
      "a pubDate that only Date would call a date",
      { pubDate: "2026" },
      "rss.channel.item.0.pubDate",
    ],
    [
      "a pubDate that is shaped right and is not a date",
      { pubDate: "Tue, 45 Foo 2026 12:30:00 GMT" },
      "rss.channel.item.0.pubDate",
    ],
  ])(
    "rejects an item with %s by element, and keeps the others",
    (_description, overrides, field) => {
      const result = parseNewsFeed(
        FEED,
        rss(item(overrides), item({ link: "https://news.example/ok" })),
      );

      expect(result.success).toBe(true);

      if (result.success) {
        expect(result.rejections.map((rejection) => rejection.field)).toEqual([
          field,
        ]);
        expect(result.articles.map((article) => article.url)).toEqual([
          "https://news.example/ok",
        ]);
      }
    },
  );

  it("rejects an item whose description arrives as elements rather than text", () => {
    const result = parseNewsFeed(
      FEED,
      rss(
        "<item><title>Ramp</title><link>https://news.example/a</link><description><p>unescaped</p></description><pubDate>Tue, 01 Sep 2026 12:30:00 GMT</pubDate></item>",
        item(),
      ),
    );

    expect(
      result.success && result.rejections.map((rejection) => rejection.field),
    ).toEqual(["rss.channel.item.0.description"]);
  });

  it("rejects an empty item as the item, not the feed", () => {
    const result = parseNewsFeed(FEED, rss("<item/>", item()));

    expect(
      result.success && result.rejections.map((rejection) => rejection.field),
    ).toEqual(["rss.channel.item.0"]);
  });
});
