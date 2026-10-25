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
 * Empty since Ticket #220, which removed Techmeme: on 2026-10-24 none of its 15 articles
 * matched any of 8 Kept Company Profiles, because it carries about fifteen stories a day about
 * the largest companies in technology, and a pre-seed Bay Area startup is never in it. Worse
 * than merely useless — every one of those articles was still a chance to misattribute a large
 * company's news to a small one with a similar name, once News started scoring every article
 * against the whole Catalogue (docs/adr/0022). Techmeme's own iCalendar feed,
 * `lib/ingest/techmeme-events.ts`, is a different Source entirely and was not touched. In its
 * place, Ticket #220 added Launch HN, read in `lib/news/launch-hn.ts` and not here: it is read
 * through a Hacker News search, not a publisher's RSS, and docs/adr/0023 says why that is not a
 * difference worth papering over to keep this array non-empty.
 *
 * An empty array is not a failure on its own; see `newsRunFailures` in `run.ts`. A run still
 * reads every entry here, even zero of them, so a feed added back inherits a run that already
 * proves it reads what is here rather than assuming an empty list is fine by never exercising
 * the read path.
 *
 * TechCrunch's RSS terms (https://techcrunch.com/rss-terms-of-use/) say: "If you choose to
 * use a TechCrunch RSS feed, you are only permitted to display the content that is provided
 * in the feed, with attribution to TechCrunch, and you must link to the full article on
 * TechCrunch." News shows a headline, names the publication and links out, which is that.
 *
 * Both feeds' `robots.txt` was checked with `curl` from a normal machine on 2026-10-24:
 * `/feed/` gives `User-agent: *` disallows only `/wp-admin/`, `/wp-json/`, `/search/`, `/?s=`
 * and customizer previews, so both feeds are open to the default `User-Agent`. The same file
 * gives `anthropic-ai`, `ClaudeBot` and `Claude-Web` `Disallow: /`, so captures are taken by
 * hand rather than by a Claude Run. Feeds are committed as `news-feed-techcrunch.xml` and
 * `news-feed-techcrunch-y-combinator.xml`, fetched with `curl` and unedited.
 */
export const NEWS_FEEDS: readonly NewsFeed[] = [
  {
    name: "techcrunch",
    publication: "TechCrunch",
    url: "https://techcrunch.com/feed/",
  },
  {
    name: "techcrunch-y-combinator",
    publication: "TechCrunch",
    url: "https://techcrunch.com/tag/y-combinator/feed/",
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
