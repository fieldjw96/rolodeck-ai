import { z } from "zod";

import type { IngestRejection } from "../../db/profile-input";
import { createGNewsThrottle, type Throttle } from "../ingest/throttle";
import { issueField } from "../zod/issues";

/**
 * GNews, the provider News reads articles from, and the boundary its responses cross.
 *
 * Everything that knows GNews's shape lives here: the request, the credential, the response
 * schema. Matching an article to a company is `match.ts`; deciding which companies to ask about
 * and writing what comes back is `run.ts` and `db/news.ts`. See docs/adr/0010 for why GNews.
 *
 * Per CLAUDE.md, what comes back is hostile. `parseGNewsResponse` validates it with Zod and
 * never throws: a response that has changed shape is a rejection naming the field, and one bad
 * article in ten costs that article, not the other nine.
 */

export const GNEWS_SEARCH_URL = "https://gnews.io/api/v4/search";

/** The most articles the free plan returns per request; asking for more is not an error, it is
 * silently capped, so the request asks for exactly this. */
export const GNEWS_ARTICLES_PER_REQUEST = 10;

/** GNews rejects a `q` longer than this. */
const MAX_QUERY_LENGTH = 200;

/**
 * The key is read from the environment and nowhere else, parsed rather than trusted, and the
 * error for a missing one names the variable — never a value, since a malformed key is still
 * most of a real one.
 */
const apiKeySchema = z.object({
  GNEWS_API_KEY: z.string({ error: "is not set" }).trim().min(1, "is empty"),
});

export function readGNewsApiKey(): string {
  const parsed = apiKeySchema.safeParse({
    GNEWS_API_KEY: process.env.GNEWS_API_KEY,
  });

  if (!parsed.success) {
    throw new Error(
      `GNEWS_API_KEY ${parsed.error.issues[0]!.message}. News needs a GNews API key from ` +
        "https://gnews.io — see .env.example.",
    );
  }

  return parsed.data.GNEWS_API_KEY;
}

/**
 * The search for one company. The name is quoted, which GNews reads as an exact phrase:
 * unquoted, "Sierra Space" also returns every article that says "sierra" and "space" apart.
 * Searched in the title and description only, which is also all the matcher reads.
 *
 * The key is deliberately not a parameter here. It travels in a header, so this URL is safe
 * to put in an error message or a log line, and nothing that prints it can print the key.
 */
export function newsSearchUrl(companyName: string): string {
  const phrase = companyName.replace(/"/g, "").trim();
  const query = new URLSearchParams({
    q: `"${phrase.slice(0, MAX_QUERY_LENGTH - 2)}"`,
    lang: "en",
    in: "title,description",
    sortby: "publishedAt",
    max: String(GNEWS_ARTICLES_PER_REQUEST),
  });

  return `${GNEWS_SEARCH_URL}?${query.toString()}`;
}

/** What GNews's documented status codes mean, so a failed run says which problem it hit. */
const STATUS_MEANINGS: Readonly<Record<number, string>> = {
  400: "the request was malformed",
  401: "the API key is missing or invalid",
  403: "the daily quota is spent; it resets at 00:00 UTC",
  429: "too many requests in a short time",
  500: "GNews had an internal error",
  503: "GNews is down for maintenance",
};

export type GNewsClient = {
  /** The parsed JSON body of one search, unvalidated. Throttled. Throws on any non-2xx. */
  readonly search: (companyName: string) => Promise<unknown>;
};

export type GNewsClientOptions = {
  readonly apiKey: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly throttle?: Throttle;
};

export function createGNewsClient({
  apiKey,
  fetch = globalThis.fetch,
  throttle = createGNewsThrottle(),
}: GNewsClientOptions): GNewsClient {
  return {
    search: async (companyName) => {
      await throttle.acquire();

      const url = newsSearchUrl(companyName);
      // A header rather than GNews's `apikey` query parameter, which it also accepts: a URL is
      // the thing most likely to be logged, by us or by anything between us and GNews.
      const response = await fetch(url, { headers: { "X-Api-Key": apiKey } });

      if (!response.ok) {
        const meaning = STATUS_MEANINGS[response.status];
        throw new Error(
          `GNews answered ${response.status}${meaning === undefined ? "" : ` (${meaning})`} for ${url}`,
        );
      }

      try {
        return (await response.json()) as unknown;
      } catch {
        throw new Error(
          `GNews answered with a body that is not JSON for ${url}`,
        );
      }
    },
  };
}

const nonBlank = z
  .string()
  .refine((value) => value.trim().length > 0, { message: "must not be blank" });

/**
 * One article, loose about the fields News does not use — `content`, `image`, `lang`, the
 * source's own `url` and `country` — and strict about the ones it stores. `url` is restricted
 * to http(s), because the News page renders it as a link.
 */
const gnewsArticleSchema = z.looseObject({
  title: nonBlank,
  description: z.string().nullish(),
  url: z.url({ protocol: /^https?$/ }),
  publishedAt: z.iso.datetime({ offset: true }),
  source: z.looseObject({ name: nonBlank }),
});

/**
 * The envelope, checked on its own so that "GNews changed shape" and "one article is bad" are
 * two different answers. `articles` is read as unknowns here and validated one by one below.
 */
const gnewsSearchResponseSchema = z.looseObject({
  totalArticles: z.number().int().nonnegative(),
  articles: z.array(z.unknown()),
});

/** An article as News stores it, whatever provider it came from. */
export type NewsArticle = {
  readonly title: string;
  readonly description: string | null;
  readonly url: string;
  readonly publishedAt: Date;
  readonly sourceName: string;
};

export type GNewsParse =
  | {
      readonly success: true;
      readonly articles: readonly NewsArticle[];
      /** Articles skipped for a field that did not validate, each naming it. */
      readonly rejections: readonly IngestRejection[];
    }
  | { readonly success: false; readonly rejection: IngestRejection };

/**
 * Validates one search response. Never throws.
 *
 * An envelope that does not validate — no `articles`, or an error body where a result was
 * expected — is a rejection of the whole response naming the field. An article that does not
 * validate is a rejection naming `articles.<index>.<field>`, and every other article survives.
 */
export function parseGNewsResponse(raw: unknown): GNewsParse {
  const envelope = gnewsSearchResponseSchema.safeParse(raw);

  if (!envelope.success) {
    // A failed safeParse always carries at least one issue.
    const issue = envelope.error.issues[0]!;
    return {
      success: false,
      rejection: { field: issueField(issue), reason: issue.message, raw },
    };
  }

  const articles: NewsArticle[] = [];
  const rejections: IngestRejection[] = [];

  envelope.data.articles.forEach((rawArticle, index) => {
    const article = gnewsArticleSchema.safeParse(rawArticle);

    if (!article.success) {
      const issue = article.error.issues[0]!;
      rejections.push({
        field: `articles.${index}.${issueField(issue)}`,
        reason: issue.message,
        raw: rawArticle,
      });
      return;
    }

    const description = article.data.description?.trim();

    articles.push({
      title: article.data.title.trim(),
      description:
        description === undefined || description === "" ? null : description,
      url: article.data.url,
      publishedAt: new Date(article.data.publishedAt),
      sourceName: article.data.source.name.trim(),
    });
  });

  return { success: true, articles, rejections };
}
