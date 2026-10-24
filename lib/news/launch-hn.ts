import { z } from "zod";

import type { IngestRejection } from "../../db/profile-input";
import { decodeEntities } from "../ingest/entities";
import { issueField } from "../zod/issues";
import type { NewsArticle } from "./feeds";

/**
 * News's path for Launch HN, where Y Combinator companies announce themselves on Hacker News.
 * Read through `hn.algolia.com/api/v1/search_by_date`, the same keyless Algolia Hacker
 * News Search API `history-search.ts` and the Show HN Source already depend on — fetching is
 * `history-search-fetch.ts`, unmodified, so this adds no new entry to
 * `lib/ingest/boundaries.test.ts`. See docs/adr/0023 for why this is a search and not a feed,
 * which amends docs/adr/0015 on the point that removed Techmeme from `NEWS_FEEDS` (ADR 0015's
 * own feed, and this is not one).
 *
 * Parsing only, like `feeds.ts` and `history-search.ts`: this builds the query url and
 * validates what comes back, and nothing here fetches. Scoring and storing is `run.ts`, which
 * treats a parsed Launch HN post exactly as it treats a feed article — scored against every
 * Company Profile in the Catalogue, stored in `news_articles` beside them — because the query
 * names no company for a hit to be scored against alone, per docs/adr/0023.
 *
 * Per CLAUDE.md, the response is hostile. It crosses a Zod schema, so a changed shape is a
 * rejection naming the field; one bad hit costs that hit and not the rest.
 */

export const LAUNCH_HN_SEARCH_ENDPOINT =
  "https://hn.algolia.com/api/v1/search_by_date";

/** The query asked, and the only tag: Launch HN posts are always stories, never comments. */
const LAUNCH_HN_QUERY = '"Launch HN"';

/**
 * The floor of the window searched, when there is no previous successful run to measure from,
 * or when there is one further back than this. See docs/adr/0023: the window is the later of
 * "since the previous successful run" and this many days, so a run shortly after the last one
 * asks a short question and a run after an outage still catches everything.
 */
export const LAUNCH_HN_MIN_WINDOW_DAYS = 7;

/**
 * The most hits one query stores. Launch HN runs about 2.5 posts a week, so even a window
 * stretched by a quarter of silent runs stays under this by an order of magnitude; it exists to
 * cap a response that has changed shape from reading as a request for everything Hacker News
 * has ever tagged a story.
 */
export const LAUNCH_HN_HITS_PER_QUERY = 100;

const DAY_MS = 24 * 60 * 60 * 1_000;

/** `news_items.source_name` for every Launch HN post. See docs/adr/0023. */
const HACKER_NEWS = "Hacker News";

/** A title that is a Launch HN post, as Hacker News titles one. */
const LAUNCH_HN_TITLE_PREFIX = "Launch HN:";

/**
 * How far back to search, given when Launch HN was last successfully read (null on a first run,
 * or whenever `readLatestLaunchHnPublishedAt` finds nothing) and the moment the run is asking as
 * of. The earlier of the two floors is the longer window, which is what docs/adr/0023 asks for.
 */
export function launchHnSince(previousRun: Date | null, now: Date): Date {
  const floor = new Date(now.getTime() - LAUNCH_HN_MIN_WINDOW_DAYS * DAY_MS);

  if (previousRun === null || previousRun.getTime() > floor.getTime()) {
    return floor;
  }

  return previousRun;
}

/** The url one run reads, asking for stories created since `since`. */
export function launchHnSearchUrl(since: Date): string {
  const url = new URL(LAUNCH_HN_SEARCH_ENDPOINT);

  for (const [name, value] of Object.entries({
    query: LAUNCH_HN_QUERY,
    tags: "story",
    typoTolerance: "false",
    numericFilters: `created_at_i>=${Math.floor(since.getTime() / 1_000)}`,
    hitsPerPage: String(LAUNCH_HN_HITS_PER_QUERY),
    attributesToRetrieve: "title,created_at_i,story_text",
  })) {
    url.searchParams.set(name, value);
  }

  return url.toString();
}

const nonBlank = z
  .string()
  .refine((value) => value.trim().length > 0, { message: "must not be blank" });

/**
 * One hit, loose about everything this module does not read. Unlike a history search hit
 * (`history-search.ts`), a Launch HN post's own `url` is never read: docs/adr/0023 stores every
 * one of these under its Hacker News item regardless of what it links to.
 */
const hitSchema = z.looseObject({
  // Numeric, as every Hacker News item id is: the item page is built from it.
  objectID: z.string().regex(/^\d+$/, "must be a Hacker News item id"),
  title: nonBlank,
  created_at_i: z.int().nonnegative(),
  story_text: z.string().nullish(),
});

/** The envelope, checked apart from its hits for the reason `feeds.ts` gives for its channel. */
const responseSchema = z.looseObject({
  hits: z.array(z.unknown()),
});

export type LaunchHnSearchParse =
  | {
      readonly success: true;
      /** Every hit the response carried, including ones not titled a Launch HN post. */
      readonly hits: number;
      readonly articles: readonly NewsArticle[];
      /** Hits skipped for a field that did not validate, each naming it. */
      readonly rejections: readonly IngestRejection[];
    }
  | { readonly success: false; readonly rejection: IngestRejection };

/** A post's body as the standfirst the matcher reads, as `history-search.ts` reads one. */
function storyText(html: string | null | undefined): string | null {
  if (html === null || html === undefined) {
    return null;
  }

  const text = decodeEntities(html.replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();

  return text === "" ? null : text;
}

/**
 * Validates one response, as of `since`. Never throws.
 *
 * A response that is not an object with a `hits` array is a rejection naming the field. A hit
 * that does not validate is a rejection naming `hits.<index>.<field>`, and every other hit
 * survives. A valid hit not titled `Launch HN:` is dropped without a rejection — the query asks
 * for the phrase anywhere in the post, not only in the title, so a comment or a self-post
 * discussing a Launch HN thread is an honest answer to the query and not a changed shape. A hit
 * older than `since` is dropped the same way, rather than taking the query's own filter on
 * trust, as `parseHistorySearch` does for its window.
 */
export function parseLaunchHnSearch(
  responseBody: unknown,
  { since }: { since: Date },
): LaunchHnSearchParse {
  const envelope = responseSchema.safeParse(responseBody);

  if (!envelope.success) {
    // A failed safeParse always carries at least one issue.
    const issue = envelope.error.issues[0]!;

    return {
      success: false,
      rejection: {
        field: issueField(issue),
        reason: issue.message,
        raw: responseBody,
      },
    };
  }

  const articles: NewsArticle[] = [];
  const rejections: IngestRejection[] = [];

  envelope.data.hits.forEach((rawHit, index) => {
    const hit = hitSchema.safeParse(rawHit);

    if (!hit.success) {
      const issue = hit.error.issues[0]!;
      const field = issue.path.length > 0 ? `.${issueField(issue)}` : "";

      rejections.push({
        field: `hits.${index}${field}`,
        reason: issue.message,
        raw: rawHit,
      });
      return;
    }

    const { objectID, title, created_at_i, story_text } = hit.data;

    if (!title.startsWith(LAUNCH_HN_TITLE_PREFIX)) {
      return;
    }

    const publishedAt = new Date(created_at_i * 1_000);

    if (publishedAt.getTime() < since.getTime()) {
      return;
    }

    articles.push({
      title: title.replace(/\s+/g, " ").trim(),
      description: storyText(story_text),
      url: `https://news.ycombinator.com/item?id=${objectID}`,
      publishedAt,
      sourceName: HACKER_NEWS,
    });
  });

  return {
    success: true,
    hits: envelope.data.hits.length,
    articles,
    rejections,
  };
}
