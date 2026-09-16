import { z } from "zod";

import type { IngestRejection } from "../../db/profile-input";
import { decodeEntities } from "../ingest/entities";
import { parseXml, type XmlDocument } from "../ingest/xml";
import { issueField } from "../zod/issues";

/**
 * The feeds News reads, and the boundary what they serve crosses.
 *
 * Parsing only: nothing here fetches, which is what lets `parseNewsFeed` be tested offline
 * against the captures in `db/fixtures/`. Fetching is `feed-fetch.ts`; scoring and storing is
 * `run.ts`. See docs/adr/0015 for why News reads feeds rather than searching.
 *
 * Per CLAUDE.md, what a feed serves is hostile. The document crosses a Zod schema keyed by RSS
 * 2.0's own element names, so a rejection names the element that stopped it —
 * `rss.channel.item.3.pubDate` — and `parseNewsFeed` never throws: a feed that is not
 * well-formed, or has no items, is a rejection naming the feed, and one bad item costs that
 * item, not the rest.
 */

export type NewsFeed = {
  /** A lowercase slug, for the run's report and nothing else. */
  readonly name: string;
  /** The publication, as `news_items.source_name` stores it for every item from this feed. */
  readonly publication: string;
  readonly url: string;
};

/**
 * Every feed a News run reads. Adding one is a line here and a capture in `db/fixtures/`, which
 * `feeds.test.ts` checks for every entry.
 *
 * `robots.txt`, checked with `curl` on 2026-09-16 before any capture was taken:
 *
 * - Techmeme (`www.techmeme.com/robots.txt`): `User-agent: *` disallows `/r2/`, `/r/`,
 *   `/goto/`, `/gotos/`, `/igoto/`, `/igotos/`, `/do/`, `/search/`, `/timeline/`, `/track/` and
 *   `/*.jpg`. `/feed.xml` is none of them, and `Claude-User` is separately given `Allow: /`.
 *   It is a document meant for software: an RSS 2.0 channel Techmeme serves as `text/xml`,
 *   the same publisher and the same test as the iCalendar feed `lib/ingest/techmeme-events.ts`
 *   reads. Each item's `link` is a Techmeme permalink, never a `/r2/` redirect, and a run never
 *   requests it either way.
 *
 * Considered and not added: TechCrunch's `/feed/`. `User-agent: *` disallows only `/wp-admin/`,
 * `/wp-json/`, `/search/`, `/?s=` and customizer previews, so `/feed/` is open to the
 * `User-Agent` this project sends. But the same file gives `anthropic-ai`, `ClaudeBot` and
 * `Claude-Web` `Disallow: /`, and every capture in this repo is taken by a Claude Run. A
 * capture TechCrunch has asked Anthropic's agents not to take is not one a Run should take, so
 * it waits for one taken by hand; with that capture committed, adding it is one entry below.
 */
export const NEWS_FEEDS: readonly NewsFeed[] = [
  {
    name: "techmeme",
    publication: "Techmeme",
    url: "https://www.techmeme.com/feed.xml",
  },
];

/** An article as News stores it, whichever feed it came from. */
export type NewsArticle = {
  readonly title: string;
  readonly description: string | null;
  readonly url: string;
  readonly publishedAt: Date;
  readonly sourceName: string;
};

export type NewsFeedParse =
  | {
      readonly success: true;
      readonly articles: readonly NewsArticle[];
      /** Items skipped for an element that did not validate, each naming it. */
      readonly rejections: readonly IngestRejection[];
    }
  | { readonly success: false; readonly rejection: IngestRejection };

const nonBlank = z
  .string()
  .refine((value) => value.trim().length > 0, { message: "must not be blank" });

/**
 * RFC 822, as RSS 2.0 requires of `pubDate`: `Wed, 16 Sep 2026 11:40:01 -0400`. Checked by
 * pattern before `Date` reads it, because `Date` will read almost anything — "2026" included —
 * and a date it guessed at would sort an article into the wrong place on the page.
 */
const RFC_822_DATE =
  /^(?:[A-Za-z]{3},\s*)?\d{1,2}\s+[A-Za-z]{3}\s+(?:\d{4}|\d{2})\s+\d{2}:\d{2}(?::\d{2})?\s+(?:[+-]\d{4}|[A-Za-z]{1,5})$/;

const pubDateSchema = z
  .string()
  .regex(RFC_822_DATE, "must be an RFC 822 date")
  .transform((value) => new Date(value))
  .pipe(z.date({ error: "must be an RFC 822 date" }));

/**
 * One `<item>`, loose about the elements News does not read — `guid`, `category`,
 * `dc:creator`, `content:encoded` and the rest — and strict about the ones it stores. `link` is
 * restricted to http(s), because the News page renders it as a link. `description` is optional,
 * as RSS 2.0 allows, but must be text: a feed that stopped escaping its HTML arrives here as
 * nested elements and fails by name rather than being read as nothing.
 */
const rssItemSchema = z.looseObject({
  title: nonBlank,
  link: z.url({ protocol: /^https?$/ }),
  description: z.string().optional(),
  pubDate: pubDateSchema,
});

/** A lone `<item>` parses as a record, not a list of one; both are a channel's items. */
const asList = (value: unknown): unknown =>
  value === undefined || Array.isArray(value) ? value : [value];

const NO_ITEMS = "must have at least one item";

/**
 * The envelope, checked on its own so that "the feed changed shape" and "one item is bad" are
 * two different answers. Items are read as unknowns here and validated one by one below.
 */
const rssDocumentSchema = z.object({
  rss: z.looseObject({
    channel: z.looseObject({
      item: z.preprocess(
        asList,
        z.array(z.unknown(), { error: NO_ITEMS }).min(1, NO_ITEMS),
      ),
    }),
  }),
});

/**
 * An item's `description` as the standfirst the matcher reads: its markup dropped, its entities
 * decoded, its whitespace collapsed. Feeds put HTML here — Techmeme wraps the headline, the
 * byline and an image in it — and a tag or an attribute is not something an article says.
 */
function descriptionText(html: string | undefined): string | null {
  if (html === undefined) {
    return null;
  }

  const text = decodeEntities(html.replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();

  return text === "" ? null : text;
}

/**
 * Validates one feed's body. Never throws.
 *
 * A body that is not well-formed XML, is not RSS, or has no items is a rejection of the whole
 * feed, naming the feed and the element. An item that does not validate is a rejection naming
 * `rss.channel.item.<index>.<element>`, and every other item survives.
 */
export function parseNewsFeed(feed: NewsFeed, body: string): NewsFeedParse {
  let document: XmlDocument;

  try {
    document = parseXml(body);
  } catch (error) {
    return {
      success: false,
      rejection: {
        field: "(document)",
        reason: `${feed.name} is not well-formed XML: ${error instanceof Error ? error.message : String(error)}`,
        raw: body,
      },
    };
  }

  const envelope = rssDocumentSchema.safeParse({
    [document.root]: document.content,
  });

  if (!envelope.success) {
    // A failed safeParse always carries at least one issue.
    const issue = envelope.error.issues[0]!;
    const notRss = document.root !== "rss";

    return {
      success: false,
      rejection: {
        field: notRss ? "rss" : issueField(issue),
        reason: notRss
          ? `${feed.name} is not an RSS 2.0 feed: its root element is <${document.root}>`
          : `${feed.name}: ${issue.message}`,
        raw: document.content,
      },
    };
  }

  const articles: NewsArticle[] = [];
  const rejections: IngestRejection[] = [];

  envelope.data.rss.channel.item.forEach((rawItem, index) => {
    const item = rssItemSchema.safeParse(rawItem);

    if (!item.success) {
      const issue = item.error.issues[0]!;
      // An `<item>` with no elements at all fails at its own root, which is the item itself.
      const element = issue.path.length > 0 ? `.${issueField(issue)}` : "";

      rejections.push({
        field: `rss.channel.item.${index}${element}`,
        reason: issue.message,
        raw: rawItem,
      });
      return;
    }

    articles.push({
      title: item.data.title.replace(/\s+/g, " ").trim(),
      description: descriptionText(item.data.description),
      url: item.data.link,
      publishedAt: item.data.pubDate,
      sourceName: feed.publication,
    });
  });

  return { success: true, articles, rejections };
}
