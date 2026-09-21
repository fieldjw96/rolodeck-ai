import type { Database } from "../../db/connection";
import {
  persistNewsItems,
  readKeptCompaniesForNews,
  type KeptCompany,
  type NewsCandidate,
} from "../../db/news";
import type { IngestRejection } from "../../db/profile-input";
import type { NewsFeedClient } from "./feed-fetch";
import { parseNewsFeed, type NewsArticle, type NewsFeed } from "./feeds";
import {
  historyQueries,
  parseHistorySearch,
  type HistoryQuery,
} from "./history-search";
import type { HistorySearchClient } from "./history-search-fetch";
import { NEWS_DISPLAY_THRESHOLD, scoreNewsMatch } from "./match";

/**
 * One News run, down two paths. The feeds: read every feed, score every article in them against
 * every Kept Company Profile. The searches: search a year of Hacker News for each Kept Company
 * Profile, and score what comes back against that Profile alone. Then store all of it.
 * Everything `scripts/ingest-news.ts` does that is worth testing, with the database, the feeds
 * and the clients that fetch them all passed in.
 */

/** What became of one feed this run: how many articles it gave, or why it gave none. */
export type NewsFeedOutcome =
  | {
      readonly feed: string;
      readonly articles: number;
      /** Items skipped for an element that did not validate. */
      readonly rejections: readonly IngestRejection[];
    }
  | { readonly feed: string; readonly failure: string };

/** What became of one Kept Company Profile's search: how many articles it found, or why none. */
export type NewsSearchOutcome =
  | {
      readonly company: string;
      /** Distinct articles, after the two queries' overlap is removed. */
      readonly articles: number;
      /**
       * How many titles the name was in, when that was too many to search by and the title
       * query's results were dropped; null when they were kept. See `MAX_TITLE_HITS`.
       */
      readonly tooCommonTitles: number | null;
      /** Hits skipped for a field that did not validate. */
      readonly rejections: readonly IngestRejection[];
    }
  | { readonly company: string; readonly failure: string };

/** How many candidates scored each confidence, highest first: every score, not only a count. */
export type ConfidenceDistribution = readonly {
  readonly confidence: number;
  readonly count: number;
}[];

/** One path's candidates, as scored. */
export type NewsPathScores = {
  /** Each article-and-Profile pair is one scored candidate. */
  readonly candidates: number;
  /** How many of those scored at or above `NEWS_DISPLAY_THRESHOLD`. */
  readonly shown: number;
  readonly distribution: ConfidenceDistribution;
};

export type NewsRunReport = {
  /** How many Kept Company Profiles this run scored against. */
  readonly companies: number;
  /** One per feed, in the order they were read. */
  readonly feeds: readonly NewsFeedOutcome[];
  /** One per Kept Company Profile, in the order they were searched. */
  readonly searches: readonly NewsSearchOutcome[];
  /** Every feed article against every Kept Company Profile. */
  readonly fromFeeds: NewsPathScores;
  /** Each search's articles against the Company Profile it searched for. */
  readonly fromSearches: NewsPathScores;
  readonly inserted: number;
  readonly updated: number;
  /** Candidates skipped on the way into `news_items` for a field that did not validate. */
  readonly rejections: readonly IngestRejection[];
};

const failed = <Outcome extends object>(
  outcome: Outcome,
): outcome is Extract<Outcome, { failure: string }> => "failure" in outcome;

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Every score the candidates carry, with how many carry it, highest first. */
export function confidenceDistribution(
  candidates: readonly Pick<NewsCandidate, "confidence">[],
): ConfidenceDistribution {
  const counts = new Map<number, number>();

  for (const { confidence } of candidates) {
    counts.set(confidence, (counts.get(confidence) ?? 0) + 1);
  }

  return [...counts]
    .map(([confidence, count]) => ({ confidence, count }))
    .sort((a, b) => b.confidence - a.confidence);
}

function pathScores(candidates: readonly NewsCandidate[]): NewsPathScores {
  return {
    candidates: candidates.length,
    shown: candidates.filter(
      (candidate) => candidate.confidence >= NEWS_DISPLAY_THRESHOLD,
    ).length,
    distribution: confidenceDistribution(candidates),
  };
}

function candidate(profile: KeptCompany, article: NewsArticle): NewsCandidate {
  return {
    profileId: profile.id,
    title: article.title,
    description: article.description,
    url: article.url,
    publishedAt: article.publishedAt,
    sourceName: article.sourceName,
    confidence: scoreNewsMatch(profile, article),
  };
}

/** Reads every feed, in order. Never throws for a feed problem; see `fetchNewsForKeptProfiles`. */
async function readFeeds(
  feeds: readonly NewsFeed[],
  client: NewsFeedClient,
): Promise<{ outcomes: NewsFeedOutcome[]; articles: NewsArticle[] }> {
  const outcomes: NewsFeedOutcome[] = [];
  const articles: NewsArticle[] = [];

  for (const feed of feeds) {
    let body: string;

    try {
      body = await client.get(feed.url);
    } catch (error) {
      outcomes.push({ feed: feed.name, failure: messageOf(error) });
      continue;
    }

    const parsed = parseNewsFeed(feed, body);

    if (!parsed.success) {
      outcomes.push({
        feed: feed.name,
        failure: `rejected on ${parsed.rejection.field}: ${parsed.rejection.reason}`,
      });
      continue;
    }

    // Items to read and not one that validated is a feed that changed shape, not a quiet day.
    const firstRejection = parsed.rejections[0];

    if (parsed.articles.length === 0 && firstRejection !== undefined) {
      outcomes.push({
        feed: feed.name,
        failure:
          `rejected all ${parsed.rejections.length} of its items, the first on ` +
          `${firstRejection.field}: ${firstRejection.reason}`,
      });
      continue;
    }

    outcomes.push({
      feed: feed.name,
      articles: parsed.articles.length,
      rejections: parsed.rejections,
    });
    articles.push(...parsed.articles);
  }

  return { outcomes, articles };
}

/**
 * Runs one company's queries and returns the distinct articles they found, or why they found
 * none. Any query failing fails the company: half a search reported as a whole one would read as
 * a company with less news than it has.
 */
async function searchCompany(
  queries: readonly HistoryQuery[],
  client: HistorySearchClient,
  now: Date,
): Promise<
  | {
      articles: NewsArticle[];
      rejections: IngestRejection[];
      tooCommonTitles: number | null;
    }
  | { failure: string }
> {
  const byUrl = new Map<string, NewsArticle>();
  const rejections: IngestRejection[] = [];
  let hits = 0;
  let tooCommonTitles: number | null = null;

  for (const query of queries) {
    let body: unknown;

    try {
      body = await client.search(query.url);
    } catch (error) {
      return { failure: `the ${query.kind} query: ${messageOf(error)}` };
    }

    const parsed = parseHistorySearch(query, body, now);

    if (!parsed.success) {
      return {
        failure: `the ${query.kind} query was rejected on ${parsed.rejection.field}: ${parsed.rejection.reason}`,
      };
    }

    hits += parsed.hits;
    rejections.push(...parsed.rejections);

    if (parsed.tooCommon) {
      tooCommonTitles = parsed.hits;
    }

    // The two queries overlap whenever a company's own post has its name in the title.
    for (const article of parsed.articles) {
      if (!byUrl.has(article.url)) {
        byUrl.set(article.url, article);
      }
    }
  }

  // Hits to read and not one that validated is a response that changed shape, not a quiet company.
  const firstRejection = rejections[0];

  if (firstRejection !== undefined && rejections.length === hits) {
    return {
      failure:
        `rejected all ${rejections.length} of its hits, the first on ` +
        `${firstRejection.field}: ${firstRejection.reason}`,
    };
  }

  return { articles: [...byUrl.values()], rejections, tooCommonTitles };
}

/**
 * Fetches every feed and searches for every Kept Company Profile, and scores and stores what
 * they carry for `ownerId`.
 *
 * Kept comes from `readKeptCompaniesForNews`, which asks the one function the ingest role may
 * call about `swipes` rather than reading the table, since this runs as that role — see
 * docs/adr/0013. A Company Profile that is unswiped or Passed is never scored against or searched
 * for.
 *
 * Every feed article is scored against every Kept Company Profile, per docs/adr/0015. Every
 * search result is scored against the Company Profile it was searched for and no other, per
 * docs/adr/0018. Every pair is stored, including the ones scoring zero, per docs/adr/0010, and
 * re-running stores nothing twice: `news_items`' unique index on `(profile_id, url)` is the key.
 *
 * Every feed is read even when nothing is Kept, so a run proves its feeds still parse on the days
 * it has nobody to match them against. With nothing Kept there is nothing to search for.
 *
 * Never throws for a feed or a search problem. A feed that cannot be fetched, no longer parses,
 * or has every one of its items rejected is a failure naming the feed; a search that cannot be
 * fetched, no longer parses, or has every one of its hits rejected is a failure naming the
 * company. Either way the next one is still tried. A database error does throw, since nothing
 * after it could be written either.
 */
export async function fetchNewsForKeptProfiles(
  db: Database,
  {
    ownerId,
    feeds,
    client,
    search,
    now = new Date(),
  }: {
    ownerId: string;
    feeds: readonly NewsFeed[];
    client: NewsFeedClient;
    search: HistorySearchClient;
    /** The end of the search window; injectable so a test holds it still. */
    now?: Date;
  },
): Promise<NewsRunReport> {
  const kept = await readKeptCompaniesForNews(db, ownerId);

  const read = await readFeeds(feeds, client);
  const feedCandidates = kept.flatMap((profile) =>
    read.articles.map((article) => candidate(profile, article)),
  );

  const searches: NewsSearchOutcome[] = [];
  const searchCandidates: NewsCandidate[] = [];

  for (const profile of kept) {
    const found = await searchCompany(
      historyQueries(profile, now),
      search,
      now,
    );

    if ("failure" in found) {
      searches.push({ company: profile.name, failure: found.failure });
      continue;
    }

    searches.push({
      company: profile.name,
      articles: found.articles.length,
      tooCommonTitles: found.tooCommonTitles,
      rejections: found.rejections,
    });
    searchCandidates.push(
      ...found.articles.map((article) => candidate(profile, article)),
    );
  }

  const stored = await persistNewsItems(db, {
    ownerId,
    candidates: [...feedCandidates, ...searchCandidates],
  });

  return {
    companies: kept.length,
    feeds: read.outcomes,
    searches,
    fromFeeds: pathScores(feedCandidates),
    fromSearches: pathScores(searchCandidates),
    inserted: stored.inserted,
    updated: stored.updated,
    rejections: stored.rejections,
  };
}

/**
 * Why the run should exit non-zero, one line per path that failed, or nothing when it should
 * not. The two paths are judged apart so a run says which half failed.
 *
 * The feeds fail when not one feed was read. A run that read its feeds and matched nothing is not
 * a failure — until Jack Keeps a Company Profile there is nothing to match against, and a
 * two-person startup can go a month unreported after that — but a run that read no feed at all
 * has checked nothing.
 *
 * The searches fail when there was at least one to run and every one failed, even though the
 * feeds were read: the feeds succeeding says nothing about whether a year of history was
 * searched. A search that found nothing is a quiet company, not a failure. A feed or a search
 * that failed beside one that did not is named in the summary rather than failing the run.
 */
export function newsRunFailures(report: NewsRunReport): string[] {
  const failures: string[] = [];

  if (report.feeds.every(failed)) {
    failures.push(
      `News could not read any of its ${report.feeds.length} ${report.feeds.length === 1 ? "feed" : "feeds"}.`,
    );
  }

  if (report.searches.length > 0 && report.searches.every(failed)) {
    failures.push(
      `News could not search for any of its ${report.searches.length} Kept ${report.searches.length === 1 ? "company" : "companies"}.`,
    );
  }

  return failures;
}

/** `0.6 ×1, 0.4 ×12, 0 ×200`, or `none` for a path with no candidates. */
function describeDistribution(distribution: ConfidenceDistribution): string {
  return distribution.length === 0
    ? "none"
    : distribution
        .map(({ confidence, count }) => `${confidence} ×${count}`)
        .join(", ");
}

function describePath(label: string, scores: NewsPathScores): string {
  return (
    `${label}: ${scores.candidates} ${scores.candidates === 1 ? "candidate" : "candidates"}, ` +
    `${scores.shown} at or above the display threshold of ${NEWS_DISPLAY_THRESHOLD}. ` +
    `Confidence: ${describeDistribution(scores.distribution)}.`
  );
}

/**
 * What the run did, feed by feed, company by company, and then each path's scores, in the form
 * every ingest script prints. Every score is listed with its count, so "nothing cleared the
 * threshold" can be told apart from "there was nothing to clear it".
 */
export function summariseNewsRun(report: NewsRunReport): string {
  const lines: string[] = ["Feeds:"];

  for (const outcome of report.feeds) {
    if (failed(outcome)) {
      lines.push(`  ${outcome.feed}: failed, ${outcome.failure}`);
      continue;
    }

    lines.push(
      `  ${outcome.feed}: read ${outcome.articles} ${outcome.articles === 1 ? "article" : "articles"}.`,
    );

    // Named, not counted, for the reason `summariseRun` gives in `lib/ingest/form-d-run.ts`.
    for (const rejection of outcome.rejections) {
      lines.push(`    rejected on ${rejection.field}: ${rejection.reason}`);
    }
  }

  lines.push(
    `Searches, a year of Hacker News for each of ${report.companies} Kept Company ${report.companies === 1 ? "Profile" : "Profiles"}:`,
  );

  for (const outcome of report.searches) {
    if (failed(outcome)) {
      lines.push(`  ${outcome.company}: failed, ${outcome.failure}`);
      continue;
    }

    lines.push(
      `  ${outcome.company}: found ${outcome.articles} ${outcome.articles === 1 ? "article" : "articles"}` +
        (outcome.tooCommonTitles === null
          ? "."
          : `, by its site alone: its name is in ${outcome.tooCommonTitles} titles, too common to search by.`),
    );

    for (const rejection of outcome.rejections) {
      lines.push(`    rejected on ${rejection.field}: ${rejection.reason}`);
    }
  }

  lines.push(
    describePath("From feeds", report.fromFeeds),
    describePath("From searches", report.fromSearches),
    `Stored ${report.inserted} new and updated ${report.updated}.`,
  );

  for (const rejection of report.rejections) {
    lines.push(`  rejected on ${rejection.field}: ${rejection.reason}`);
  }

  return lines.join("\n");
}
