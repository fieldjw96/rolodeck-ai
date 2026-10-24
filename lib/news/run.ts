import type { Database } from "../../db/connection";
import {
  persistNewsArticles,
  persistNewsItems,
  readCatalogueCompaniesForNews,
  readNewsCoveredProfileIds,
  readStoredNewsArticles,
  recordNewsCoverage,
  type NewsArticleInput,
  type NewsCandidate,
  type NewsCompany,
} from "../../db/news";
import type { IngestRejection } from "../../db/profile-input";
import type { NewsFeedClient } from "./feed-fetch";
import { parseNewsFeed, type NewsArticle, type NewsFeed } from "./feeds";
import {
  historyQueries,
  HISTORY_SEARCHES_PER_RUN,
  HISTORY_WINDOW_DAYS,
  parseHistorySearch,
  type HistoryQuery,
} from "./history-search";
import type { HistorySearchClient } from "./history-search-fetch";
import { NEWS_DISPLAY_THRESHOLD, scoreNewsMatch } from "./match";

/**
 * One News run, down three paths, for the whole Catalogue. The feeds: read every feed, store each
 * article once, and score the ones this run had never read against every Company Profile. The
 * first runs: for each Company Profile News has not seen before, score it against every article
 * already stored, and search two years of Hacker News for it. Then store all of it.
 *
 * Nobody's Keeps are consulted. Who reads what is decided by `readNews` on the way out; what is
 * gathered is decided by what ingest has put in the Catalogue. See docs/adr/0022.
 *
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

/** What became of one Company Profile's history search: what it found, or why nothing. */
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

/** How many pairs scored each confidence, highest first: every score, not only a count. */
export type ConfidenceDistribution = readonly {
  readonly confidence: number;
  readonly count: number;
}[];

/** One path's pairs, as scored. */
export type NewsPathScores = {
  /** Each article-and-Profile pair is one scored candidate. */
  readonly candidates: number;
  /** How many of those scored at or above `NEWS_DISPLAY_THRESHOLD`. */
  readonly shown: number;
  readonly distribution: ConfidenceDistribution;
};

export type NewsRunReport = {
  /** How many Company Profiles are in the Catalogue, which is what this run scored against. */
  readonly companies: number;
  /** One per feed, in the order they were read. */
  readonly feeds: readonly NewsFeedOutcome[];
  /** The feed articles this run stored, and how many of them it had never read before. */
  readonly articles: {
    readonly stored: number;
    readonly fresh: number;
    /** Articles skipped on the way into `news_articles` for a field that did not validate. */
    readonly rejections: readonly IngestRejection[];
  };
  /** One per Company Profile searched for this run, in the order they were searched. */
  readonly searches: readonly NewsSearchOutcome[];
  /** Company Profiles still waiting for a first search, past this run's cap. */
  readonly waiting: number;
  /** How many Company Profiles this run recorded as covered. */
  readonly covered: number;
  /** This run's new feed articles against every Company Profile in the Catalogue. */
  readonly fromFeeds: NewsPathScores;
  /** Articles read on earlier runs, against each Company Profile News had not seen before. */
  readonly fromStored: NewsPathScores;
  /** Each search's articles against the Company Profile it searched for. */
  readonly fromSearches: NewsPathScores;
  /**
   * Feed articles that cleared `NEWS_DISPLAY_THRESHOLD` against more than one Company Profile.
   * A matcher misfiring at Catalogue scale shows up here rather than only on somebody's page.
   */
  readonly onSeveralCompanies: number;
  readonly inserted: number;
  readonly updated: number;
  /** Pairs that scored zero, so were counted and not stored. See docs/adr/0022. */
  readonly unattributed: number;
  /** Candidates skipped on the way into `news_items` for a field that did not validate. */
  readonly rejections: readonly IngestRejection[];
};

const failed = <Outcome extends object>(
  outcome: Outcome,
): outcome is Extract<Outcome, { failure: string }> => "failure" in outcome;

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Every score given, with how many pairs carry it, highest first. */
export function confidenceDistribution(
  scores: Iterable<number>,
): ConfidenceDistribution {
  const counts = new Map<number, number>();

  for (const confidence of scores) {
    counts.set(confidence, (counts.get(confidence) ?? 0) + 1);
  }

  return [...counts]
    .map(([confidence, count]) => ({ confidence, count }))
    .sort((a, b) => b.confidence - a.confidence);
}

function pathScores(scores: readonly number[]): NewsPathScores {
  return {
    candidates: scores.length,
    shown: scores.filter((score) => score >= NEWS_DISPLAY_THRESHOLD).length,
    distribution: confidenceDistribution(scores),
  };
}

/**
 * How many of a path's pairs the matcher scored zero, and so were counted and not stored. Read
 * off the distribution rather than counted again: the scoring already knows, and the pairs
 * themselves are let go as they are scored, so nothing downstream could count them.
 */
const unattributedIn = (scores: NewsPathScores): number =>
  scores.distribution.find(({ confidence }) => confidence === 0)?.count ?? 0;

function candidate(
  profile: NewsCompany,
  article: NewsArticleInput,
): NewsCandidate {
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

/**
 * Scores every article against every company, keeping the pairs worth storing and the scores of
 * all of them.
 *
 * The scores rather than the pairs, because at Catalogue scale this is the one place in the run
 * whose size is the product of two growing numbers: a thousand Company Profiles against a year of
 * articles is a million pairs, and nearly every one of them is a zero nothing will store. A
 * number costs eight bytes; a candidate object costs a hundred.
 *
 * `shownByUrl` counts, per article, how many companies it cleared the display threshold against,
 * which is what the run summary reports as an article on several companies.
 */
function scoreEvery(
  companies: readonly NewsCompany[],
  articles: readonly NewsArticleInput[],
  into: {
    readonly attributed: NewsCandidate[];
    readonly shownByUrl?: Map<string, number>;
  },
): NewsPathScores {
  const scores: number[] = [];

  for (const article of articles) {
    for (const company of companies) {
      const scored = candidate(company, article);
      scores.push(scored.confidence);

      if (scored.confidence >= NEWS_DISPLAY_THRESHOLD && into.shownByUrl) {
        into.shownByUrl.set(
          article.url,
          (into.shownByUrl.get(article.url) ?? 0) + 1,
        );
      }

      // Zero is counted above and dropped here, so a million-pair run is a handful of rows.
      // `persistNewsItems` refuses a zero as well; this is what keeps it from reaching it.
      if (scored.confidence > 0) {
        into.attributed.push(scored);
      }
    }
  }

  return pathScores(scores);
}

/** Reads every feed, in order. Never throws for a feed problem; see `fetchNewsForTheCatalogue`. */
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
 * a company with less news than it has, and would then be recorded as searched.
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
 * Reads every feed and gathers News for the whole Catalogue, then scores and stores what it
 * carries. What it stores is Catalogue: every User reads it, and nobody's swipes decided any of
 * it was gathered. See docs/adr/0022, which amends docs/adr/0019 on who gathering is for and
 * docs/adr/0010 on which pairs are stored.
 *
 * Three paths, in order:
 *
 * 1. **The feeds.** Every feed is read and every article stored once in `news_articles`, matched
 *    or not, per docs/adr/0022. The articles this run had never read are scored against every
 *    Company Profile in the Catalogue.
 * 2. **The Company Profiles News has not seen.** Each is scored against the articles read on
 *    earlier runs — today's are left out, because the path above has already scored them against
 *    the whole Catalogue, and a pair scored twice is only a pair counted twice — so a company
 *    that entered the Catalogue after an article was published still gets it.
 * 3. **The history search.** Two years of Hacker News for each of those same Profiles, capped at
 *    `HISTORY_SEARCHES_PER_RUN` a run, oldest-created first. Every result is scored against the
 *    Company Profile it was searched for and no other, per docs/adr/0018.
 *
 * A Profile is recorded in `news_profile_coverage` only when its search succeeded and the write
 * that followed did too, so a failed search or a spent cap means it is tried again next run.
 *
 * Only a pair scoring above zero becomes a `news_items` row, and re-running stores nothing twice:
 * that table's unique index on `(profile_id, url)` is the key, as `news_articles`' on `url` is.
 *
 * Every feed is read even when the Catalogue is empty, so a run proves its feeds still parse on
 * a day it has nothing to match them against.
 *
 * Never throws for a feed or a search problem. A feed that cannot be fetched, no longer parses,
 * or has every one of its items rejected is a failure naming the feed; a search that cannot be
 * fetched, no longer parses, or has every one of its hits rejected is a failure naming the
 * company. Either way the next one is still tried. A database error does throw, since nothing
 * after it could be written either.
 */
export async function fetchNewsForTheCatalogue(
  db: Database,
  {
    feeds,
    client,
    search,
    now = new Date(),
  }: {
    feeds: readonly NewsFeed[];
    client: NewsFeedClient;
    search: HistorySearchClient;
    /** The end of the search window; injectable so a test holds it still. */
    now?: Date;
  },
): Promise<NewsRunReport> {
  const catalogue = await readCatalogueCompaniesForNews(db);

  const read = await readFeeds(feeds, client);
  const articles = await persistNewsArticles(db, { articles: read.articles });

  // Oldest-created first, the order `readCatalogueCompaniesForNews` answers in, so the Company
  // Profile that has waited longest for its first search is the one a spent cap does not strand.
  const covered = await readNewsCoveredProfileIds(db);
  const unseen = catalogue.filter((company) => !covered.has(company.id));
  const firstRuns = unseen.slice(0, HISTORY_SEARCHES_PER_RUN);

  /** The stored articles this run did not read itself, or nothing when nobody needs them. */
  const articlesReadBefore = async (): Promise<NewsArticleInput[]> => {
    if (firstRuns.length === 0) {
      return [];
    }

    const fresh = new Set(articles.fresh.map((article) => article.url));

    return (await readStoredNewsArticles(db)).filter(
      (article) => !fresh.has(article.url),
    );
  };

  const attributed: NewsCandidate[] = [];
  const shownByUrl = new Map<string, number>();

  const fromFeeds = scoreEvery(catalogue, articles.fresh, {
    attributed,
    shownByUrl,
  });
  // Everything read before today, since the path above has already scored today's against the
  // whole Catalogue. Scoring a pair twice would double it in the counts and tell nobody anything.
  const fromStored = scoreEvery(firstRuns, await articlesReadBefore(), {
    attributed,
    shownByUrl,
  });

  const searches: NewsSearchOutcome[] = [];
  const searchScores: number[] = [];
  const searched: string[] = [];

  for (const profile of firstRuns) {
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
    searched.push(profile.id);

    // Against this Company Profile alone, so not through `scoreEvery`'s cross product.
    for (const article of found.articles) {
      const scored = candidate(profile, article);
      searchScores.push(scored.confidence);

      if (scored.confidence > 0) {
        attributed.push(scored);
      }
    }
  }

  const fromSearches = pathScores(searchScores);
  const stored = await persistNewsItems(db, { candidates: attributed });

  // Last, and only for the Profiles whose search succeeded: a row here says both halves of a
  // first run happened and were written. A throw above leaves every Profile uncovered.
  const covering = await recordNewsCoverage(db, searched);

  return {
    companies: catalogue.length,
    feeds: read.outcomes,
    articles: {
      stored: articles.inserted + articles.updated,
      fresh: articles.inserted,
      rejections: articles.rejections,
    },
    searches,
    waiting: unseen.length - firstRuns.length,
    covered: covering,
    fromFeeds,
    fromStored,
    fromSearches,
    onSeveralCompanies: [...shownByUrl.values()].filter(
      (companies) => companies > 1,
    ).length,
    inserted: stored.inserted,
    updated: stored.updated,
    // `stored.unattributed` is a backstop and must be zero: a zero never reaches the write,
    // because keeping a million of them in memory to drop them there is what the paths above
    // avoid. It is added rather than ignored so a zero that did reach it is still counted.
    unattributed:
      unattributedIn(fromFeeds) +
      unattributedIn(fromStored) +
      unattributedIn(fromSearches) +
      stored.unattributed,
    rejections: stored.rejections,
  };
}

/**
 * Why the run should exit non-zero, one line per path that failed, or nothing when it should
 * not. The two paths are judged apart so a run says which half failed.
 *
 * The feeds fail when not one feed was read. A run that read its feeds and matched nothing is not
 * a failure — a two-person startup can go a month unreported — but a run that read no feed at all
 * has checked nothing.
 *
 * The searches fail when there was at least one to run and every one failed, even though the
 * feeds were read: the feeds succeeding says nothing about whether the history was searched. A
 * search that found nothing is a quiet company, not a failure. A feed or a search that failed
 * beside one that did not is named in the summary rather than failing the run.
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
      `News could not search for any of the ${report.searches.length} Company ${report.searches.length === 1 ? "Profile" : "Profiles"} it tried.`,
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

const plural = (count: number, one: string, many: string) =>
  count === 1 ? one : many;

/**
 * What the run did, feed by feed, company by company, and then each path's scores, in the form
 * every ingest script prints. Every score is listed with its count, so "nothing cleared the
 * threshold" can be told apart from "there was nothing to clear it" — which matters more now
 * that a score of zero is no longer a row to go and look at.
 */
export function summariseNewsRun(report: NewsRunReport): string {
  const lines: string[] = ["Feeds:"];

  for (const outcome of report.feeds) {
    if (failed(outcome)) {
      lines.push(`  ${outcome.feed}: failed, ${outcome.failure}`);
      continue;
    }

    lines.push(
      `  ${outcome.feed}: read ${outcome.articles} ${plural(outcome.articles, "article", "articles")}.`,
    );

    // Named, not counted, for the reason `summariseRun` gives in `lib/ingest/form-d-run.ts`.
    for (const rejection of outcome.rejections) {
      lines.push(`    rejected on ${rejection.field}: ${rejection.reason}`);
    }
  }

  lines.push(
    `Stored ${report.articles.stored} feed ${plural(report.articles.stored, "article", "articles")}, ` +
      `${report.articles.fresh} new to the Catalogue.`,
  );

  for (const rejection of report.articles.rejections) {
    lines.push(`  rejected on ${rejection.field}: ${rejection.reason}`);
  }

  lines.push(
    `Searches, ${HISTORY_WINDOW_DAYS} days of Hacker News for each of ${report.searches.length} Company ` +
      `${plural(report.searches.length, "Profile", "Profiles")} new to News, with ${report.waiting} still waiting:`,
  );

  for (const outcome of report.searches) {
    if (failed(outcome)) {
      lines.push(`  ${outcome.company}: failed, ${outcome.failure}`);
      continue;
    }

    lines.push(
      `  ${outcome.company}: found ${outcome.articles} ${plural(outcome.articles, "article", "articles")}` +
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
    describePath("From stored articles", report.fromStored),
    describePath("From searches", report.fromSearches),
    `${report.onSeveralCompanies} feed ${plural(report.onSeveralCompanies, "article", "articles")} ` +
      `cleared the threshold against more than one Company Profile.`,
    `Stored ${report.inserted} new and updated ${report.updated}; ` +
      `${report.unattributed} ${plural(report.unattributed, "pair", "pairs")} scored zero and were not stored.`,
    `Covered ${report.covered} Company ${plural(report.covered, "Profile", "Profiles")} of ${report.companies} in the Catalogue.`,
  );

  for (const rejection of report.rejections) {
    lines.push(`  rejected on ${rejection.field}: ${rejection.reason}`);
  }

  return lines.join("\n");
}
