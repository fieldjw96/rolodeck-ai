import { z } from "zod";

import type { IngestRejection } from "../../db/profile-input";
import { decodeEntities } from "../ingest/entities";
import { issueField } from "../zod/issues";
import type { NewsArticle } from "./feeds";

/**
 * News's second path: a search over a year of Hacker News, run once per Kept Company Profile,
 * beside the feeds `feeds.ts` reads. A feed carries what published today; this is what lets News
 * answer "what has been said about this company" rather than only "was it in today's headlines".
 * See docs/adr/0018, which amends docs/adr/0015 on exactly this point.
 *
 * Parsing only, like `feeds.ts`: this builds the query urls and validates what comes back, and
 * nothing here fetches. Fetching is `history-search-fetch.ts`; scoring and storing is `run.ts`,
 * with `scoreNewsMatch` unchanged.
 *
 * ## The host
 *
 * `hn.algolia.com/api/v1/search`: keyless, documented, and the relevance-ranked sibling of the
 * `search_by_date` endpoint the Show HN Source already reads (`scripts/fetch-show-hn.ts`). This
 * host's terms were cleared when that Source was built; this adds a second endpoint on the same
 * API, not a new host.
 *
 * ## Why the query is constrained, and how
 *
 * Company names are terrible search keys, which docs/adr/0010 said first. Measured against this
 * API on 2026-09-20, stories only:
 *
 * - `Versive`, a bare query: 28,950 hits all time, and 1,208 to 3,592 in the last twelve months
 *   (Algolia's counts are not exhaustive and moved between two runs of the same query). The top
 *   result is an article about Pokémon, because typo tolerance reads "Versive" as "version" and
 *   "aversive".
 * - `Versive` restricted to the title alone: still 847 in twelve months, all of them typos.
 * - `Versive` restricted to the title, typo tolerance off: **0**. The same as an exact phrase over
 *   every attribute, and the same all time. Nothing on Hacker News is titled with it.
 * - `Sierra AI`, bare: 15 in twelve months, the top three about the company. As an exact phrase
 *   in the title: 0, because Hacker News titles it "Sierra". Its own domain, `sierra.ai`, in the
 *   story's url: 11, every one of them Sierra's own writing.
 * - `Mulligan insurance`: 0 every way it was asked.
 *
 * So each company gets two queries, both stories only, both the last `HISTORY_WINDOW_DAYS`, both
 * with typo tolerance off, both capped at `HITS_PER_QUERY` by relevance:
 *
 * 1. **Its own site.** The domain of the Profile's `website`, searched in the story's `url` only,
 *    and then kept only when the hit's host *is* that domain or a subdomain of it. Algolia
 *    matches `routine.co` inside `open-routines.com`, so the host check is ours and not the
 *    API's. This is the precise half: a story linking to a company's own site is about the
 *    company. Skipped when the Profile has no website, or when its website is a page on a host
 *    it does not own (`github.com/acme`), where the domain would be everybody's.
 * 2. **Its name, as an exact phrase, in the title.** The half that finds other people writing
 *    about the company: Tailscale's post about Blacksmith is found this way and not the first.
 *    Useless for a name that is also a word, and worse than useless, because the matcher cannot
 *    tell a namesake from the company by a headline alone. Measured on 2026-09-20 against the
 *    Kept companies: "Blacksmith" is in 5 titles in a year, 3 of them about the company; "Juno"
 *    in 13, "Darwin" in 42, "Routine" in 44 and "Journey" in about 300, and not one of those
 *    is. Worse, "AI Darwin Awards" and "My Morning Routine as an AI Automation Agency Owner"
 *    score 0.6 against Kept AI companies and would be shown. So a title query answering with
 *    more than `MAX_TITLE_HITS` is read as a name too common to search by, and none of its
 *    results are kept: a pre-seed company is not in a dozen headlines a year, and the one that
 *    is will have its own site linked, which the first query finds.
 *
 * Every result that survives is still scored by `scoreNewsMatch` rather than trusted, against
 * the Company Profile it was searched for and only that one. A targeted result is about the
 * company it was searched for or it is about nothing.
 *
 * Per CLAUDE.md, the response is hostile. It crosses a Zod schema, so a changed shape is a
 * rejection naming the field and costs that one company; one bad hit costs that hit.
 */

export const HN_SEARCH_ENDPOINT = "https://hn.algolia.com/api/v1/search";

/** The window searched: the last twelve months. */
export const HISTORY_WINDOW_DAYS = 365;

/**
 * The most relevant hits one query stores. Relevance-ranked, so the cap keeps the best of a
 * common name's noise rather than a random slice of it; no company measured has more than 11
 * hits on its own site in a year.
 */
export const HITS_PER_QUERY = 50;

/**
 * More titles than this in a year carrying the name is a name too common to search by. Twice the
 * most any Kept company measured had (Blacksmith, 5), and under the fewest any common-word name
 * had (Juno, 13). See the header.
 */
export const MAX_TITLE_HITS = 10;

const DAY_MS = 24 * 60 * 60 * 1_000;

/** `news_items.source_name` for a text post, which has no link of its own. */
const HACKER_NEWS = "Hacker News";

/** A Kept Company Profile, as much of it as the search needs. */
export type SearchSubject = {
  readonly name: string;
  readonly website: string | null;
};

export type HistoryQuery =
  | { readonly kind: "site"; readonly url: string; readonly domain: string }
  | { readonly kind: "title"; readonly url: string };

/**
 * The domain a Profile's website names, without a leading `www.`, or null when there is not one
 * worth searching: no website, one that does not parse, or one with a path, which is a page on
 * somebody else's host rather than a site the company owns.
 */
export function companyDomain(website: string | null): string | null {
  if (website === null) {
    return null;
  }

  let url: URL;

  try {
    url = new URL(website);
  } catch {
    return null;
  }

  if (
    !/^https?:$/.test(url.protocol) ||
    url.pathname.replace(/\/+$/, "") !== ""
  ) {
    return null;
  }

  const host = url.hostname.toLowerCase().replace(/^www\./, "");

  return host.includes(".") ? host : null;
}

/** Whether `url`'s host is `domain` or a subdomain of it. */
function isOnDomain(url: string, domain: string): boolean {
  const host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  return host === domain || host.endsWith(`.${domain}`);
}

function searchUrl(
  params: Readonly<Record<string, string>>,
  now: Date,
): string {
  const since = Math.floor(
    (now.getTime() - HISTORY_WINDOW_DAYS * DAY_MS) / 1_000,
  );
  const url = new URL(HN_SEARCH_ENDPOINT);

  for (const [name, value] of Object.entries({
    ...params,
    tags: "story",
    typoTolerance: "false",
    numericFilters: `created_at_i>=${since}`,
    hitsPerPage: String(HITS_PER_QUERY),
    attributesToRetrieve: "title,url,created_at_i,story_text",
  })) {
    url.searchParams.set(name, value);
  }

  return url.toString();
}

/** The queries one Company Profile is searched with, as of `now`. See the header for why. */
export function historyQueries(
  subject: SearchSubject,
  now: Date,
): HistoryQuery[] {
  const queries: HistoryQuery[] = [];
  const domain = companyDomain(subject.website);

  if (domain !== null) {
    queries.push({
      kind: "site",
      domain,
      url: searchUrl(
        { query: domain, restrictSearchableAttributes: "url" },
        now,
      ),
    });
  }

  // A double quote inside the name would end the phrase early; nothing else in a name is syntax.
  const name = subject.name.replace(/"/g, " ").replace(/\s+/g, " ").trim();

  if (name !== "") {
    queries.push({
      kind: "title",
      url: searchUrl(
        {
          query: `"${name}"`,
          restrictSearchableAttributes: "title",
          advancedSyntax: "true",
        },
        now,
      ),
    });
  }

  return queries;
}

const nonBlank = z
  .string()
  .refine((value) => value.trim().length > 0, { message: "must not be blank" });

/**
 * One hit, loose about everything News does not read and strict about what it stores. A text
 * post has no `url`; Algolia has served that both as `null` and as a missing key, and an empty
 * string is read the same way rather than as a malformed link.
 */
const hitSchema = z.looseObject({
  objectID: nonBlank,
  title: nonBlank,
  url: z.preprocess(
    (value) => (value === "" ? null : value),
    z.url({ protocol: /^https?$/ }).nullish(),
  ),
  created_at_i: z.int().nonnegative(),
  story_text: z.string().nullish(),
});

/** The envelope, checked apart from its hits for the reason `feeds.ts` gives for its channel. */
const responseSchema = z.looseObject({
  hits: z.array(z.unknown()),
});

export type HistorySearchParse =
  | {
      readonly success: true;
      /** Every hit the response carried, including the ones rejected or dropped. */
      readonly hits: number;
      /**
       * A title query that answered with more than `MAX_TITLE_HITS`: the name is too common to
       * search by, and `articles` is empty however many of them validated.
       */
      readonly tooCommon: boolean;
      readonly articles: readonly NewsArticle[];
      /** Hits skipped for a field that did not validate, each naming it. */
      readonly rejections: readonly IngestRejection[];
    }
  | { readonly success: false; readonly rejection: IngestRejection };

/** A text post's body as the standfirst the matcher reads, as `feeds.ts` reads a description. */
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
 * Validates one query's response, as of `now`. Never throws.
 *
 * A response that is not an object with a `hits` array is a rejection naming the field. A hit
 * that does not validate is a rejection naming `hits.<index>.<field>`, and every other hit
 * survives. No hits at all is a quiet company, not a changed shape.
 *
 * Two kinds of valid hit are dropped without a rejection, because neither is the response's
 * fault: one from a `site` query whose host is not the company's, and one older than the window,
 * which the query already excludes and this does not take on trust. And every hit of a title
 * query answering with more than `MAX_TITLE_HITS` is dropped, which `tooCommon` reports.
 *
 * A link post is stored as its link, with the linked site's host as `source_name`, since that is
 * who published it. A text post is stored as its Hacker News item, from "Hacker News".
 */
export function parseHistorySearch(
  query: HistoryQuery,
  body: unknown,
  now: Date,
): HistorySearchParse {
  const envelope = responseSchema.safeParse(body);

  if (!envelope.success) {
    // A failed safeParse always carries at least one issue.
    const issue = envelope.error.issues[0]!;

    return {
      success: false,
      rejection: {
        field: issueField(issue),
        reason: issue.message,
        raw: body,
      },
    };
  }

  const windowStart = now.getTime() - HISTORY_WINDOW_DAYS * DAY_MS;
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

    const { objectID, title, url, created_at_i, story_text } = hit.data;
    const publishedAt = new Date(created_at_i * 1_000);

    if (publishedAt.getTime() < windowStart) {
      return;
    }

    if (
      query.kind === "site" &&
      (url == null || !isOnDomain(url, query.domain))
    ) {
      return;
    }

    articles.push({
      title: title.replace(/\s+/g, " ").trim(),
      description: storyText(story_text),
      url: url ?? `https://news.ycombinator.com/item?id=${objectID}`,
      publishedAt,
      sourceName:
        url == null
          ? HACKER_NEWS
          : new URL(url).hostname.toLowerCase().replace(/^www\./, ""),
    });
  });

  const hits = envelope.data.hits.length;
  const tooCommon = query.kind === "title" && hits > MAX_TITLE_HITS;

  return {
    success: true,
    hits,
    tooCommon,
    articles: tooCommon ? [] : articles,
    rejections,
  };
}
