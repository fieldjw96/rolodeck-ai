import type { Database } from "../../db/connection";
import {
  persistNewsArticles,
  persistNewsItems,
  readCatalogueCompaniesForNews,
  readLatestLaunchHnPublishedAt,
  readNewsCoveredProfileIds,
  readNewsSiteRecoveredProfileIds,
  readStoredNewsArticles,
  recordNewsCoverage,
  recordNewsSiteRecovery,
  type NewsArticleInput,
  type NewsCandidate,
  type NewsCompany,
} from "../../db/news";
import type { IngestRejection } from "../../db/profile-input";
import { ownSiteConfidence } from "./company-news";
import type { NewsFeedClient } from "./feed-fetch";
import { parseNewsFeed, type NewsArticle, type NewsFeed } from "./feeds";
import {
  companyDomain,
  historyQueries,
  HISTORY_SEARCHES_PER_RUN,
  HISTORY_WINDOW_DAYS,
  parseHistorySearch,
  type HistoryQuery,
} from "./history-search";
import type { HistorySearchClient } from "./history-search-fetch";
import {
  launchHnSearchUrl,
  launchHnSince,
  parseLaunchHnSearch,
} from "./launch-hn";
import { NEWS_DISPLAY_THRESHOLD, scoreNewsMatch } from "./match";

/**
 * One News run, down four paths, for the whole Catalogue. The feeds: read every feed, store each
 * article once, and score the ones this run had never read against every Company Profile.
 * Launch HN: a widening Hacker News search read and scored the same way as the feeds, for the
 * reason docs/adr/0023 gives. The first runs: for each Company Profile News has not seen before,
 * score it against every article already stored, and search two years of Hacker News for it.
 * Then store all of it.
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

/** What became of this run's Launch HN search: how many posts it gave, or why it gave none. */
export type NewsLaunchHnOutcome =
  | {
      readonly articles: number;
      /** Hits skipped for a field that did not validate. */
      readonly rejections: readonly IngestRejection[];
    }
  | { readonly failure: string };

/** What this run's own-site re-searches did, per docs/adr/0024. */
export type NewsReSearchCounts = {
  /** Re-searched and recorded, so never re-searched again. */
  readonly done: number;
  /** Re-searched and failed, so recorded as nothing and retried on a later run. */
  readonly failed: number;
  /** Covered Company Profiles with a searchable website still waiting for theirs. */
  readonly waiting: number;
};

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
  /** This run's Launch HN search. See docs/adr/0023. */
  readonly launchHn: NewsLaunchHnOutcome;
  /** The feed articles this run stored, and how many of them it had never read before. */
  readonly articles: {
    readonly stored: number;
    readonly fresh: number;
    /** Articles skipped on the way into `news_articles` for a field that did not validate. */
    readonly rejections: readonly IngestRejection[];
  };
  /** One per Company Profile searched for the first time this run, in the order searched. */
  readonly searches: readonly NewsSearchOutcome[];
  /** Company Profiles still waiting for a first search, past this run's cap. */
  readonly waiting: number;
  /**
   * The own-site searches re-run for Company Profiles already covered, on whatever was left of
   * this run's cap after the first searches. See docs/adr/0024.
   */
  readonly reSearches: NewsReSearchCounts;
  /** How many Company Profiles this run recorded as covered. */
  readonly covered: number;
  /** The articles the searches stored, kept whatever they scored. See docs/adr/0024. */
  readonly searchArticles: {
    readonly stored: number;
    readonly fresh: number;
    /** Articles skipped on the way into `news_articles` for a field that did not validate. */
    readonly rejections: readonly IngestRejection[];
  };
  /** This run's new feed articles against every Company Profile in the Catalogue. */
  readonly fromFeeds: NewsPathScores;
  /** Articles read on earlier runs, against each Company Profile News had not seen before. */
  readonly fromStored: NewsPathScores;
  /**
   * Each search's articles against the Company Profile it searched for, first searches and
   * own-site re-searches together: both are a search scored against its one subject, and
   * splitting them would make two half-distributions of what is one rule's output.
   */
  readonly fromSearches: NewsPathScores;
  /**
   * Feed articles that cleared `NEWS_DISPLAY_THRESHOLD` against more than one Company Profile in
   * this run's scoring. A matcher misfiring at Catalogue scale shows up here rather than only on
   * somebody's page. Per run, not per article's lifetime: an article scored against one company
   * today and another next month is one each time, which is what makes a run's own log readable.
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
  confidence = scoreNewsMatch(profile, article),
): NewsCandidate {
  return {
    profileId: profile.id,
    title: article.title,
    description: article.description,
    url: article.url,
    publishedAt: article.publishedAt,
    sourceName: article.sourceName,
    confidence,
  };
}

/**
 * One hit, and which of a company's two queries found it. A hit both queries returned is a
 * `site` hit, because `historyQueries` puts the site query first: the host having been checked
 * to be the company's own is the stronger fact of the two, and the one the confidence below
 * turns on.
 */
type SearchHit = {
  readonly article: NewsArticle;
  readonly kind: HistoryQuery["kind"];
};

/**
 * What one search hit is worth against the Company Profile it was searched for. A `title` hit is
 * scored exactly as a feed article is, by `scoreNewsMatch` and nothing else. A `site` hit is
 * judged by the news-only rule in `company-news.ts`, which is the whole of docs/adr/0024's
 * change to scoring.
 */
function searchCandidate(profile: NewsCompany, hit: SearchHit): NewsCandidate {
  return candidate(
    profile,
    hit.article,
    hit.kind === "site"
      ? ownSiteConfidence(profile, hit.article)
      : scoreNewsMatch(profile, hit.article),
  );
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
 *
 * An article a history search found is scored against the one Company Profile it was searched
 * for and skipped for every other, however many runs later this reads it back out of
 * `news_articles`. That is docs/adr/0018's rule, and keeping it is the condition on which
 * docs/adr/0024 stores search results here at all. A skipped pair is not scored, so it is not in
 * the distribution either: there is no number to report for a pair the rule never formed.
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
      const searchedFor = article.searchedForProfileId;

      if (searchedFor != null && searchedFor !== company.id) {
        continue;
      }

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
 * Reads this run's Launch HN search: the stories created since `since`, titled a Launch HN
 * post. Never throws; a request that cannot be fetched or that changes shape is a failure
 * naming why, and costs this run's Launch HN articles and nothing else. See docs/adr/0023 for
 * why a Launch HN failure, alone, never fails the run.
 */
async function readLaunchHn(
  client: HistorySearchClient,
  since: Date,
): Promise<{
  outcome: NewsLaunchHnOutcome;
  articles: readonly NewsArticle[];
}> {
  let body: unknown;

  try {
    body = await client.search(launchHnSearchUrl(since));
  } catch (error) {
    return { outcome: { failure: messageOf(error) }, articles: [] };
  }

  const parsed = parseLaunchHnSearch(body, { since });

  if (!parsed.success) {
    return {
      outcome: {
        failure: `rejected on ${parsed.rejection.field}: ${parsed.rejection.reason}`,
      },
      articles: [],
    };
  }

  // Hits to read and not one that validated is a changed shape, not a quiet week: a quiet week
  // is zero hits, or hits none titled a Launch HN post, neither of which rejects anything.
  const firstRejection = parsed.rejections[0];

  if (parsed.articles.length === 0 && firstRejection !== undefined) {
    return {
      outcome: {
        failure:
          `rejected all ${parsed.rejections.length} of its hits, the first on ` +
          `${firstRejection.field}: ${firstRejection.reason}`,
      },
      articles: [],
    };
  }

  return {
    outcome: {
      articles: parsed.articles.length,
      rejections: parsed.rejections,
    },
    articles: parsed.articles,
  };
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
      hits: SearchHit[];
      rejections: IngestRejection[];
      tooCommonTitles: number | null;
    }
  | { failure: string }
> {
  const byUrl = new Map<string, SearchHit>();
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

    // The two queries overlap whenever a company's own post has its name in the title. The site
    // query runs first, so such a hit is kept as a site hit; see `SearchHit`.
    for (const article of parsed.articles) {
      if (!byUrl.has(article.url)) {
        byUrl.set(article.url, { article, kind: query.kind });
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

  return { hits: [...byUrl.values()], rejections, tooCommonTitles };
}

/**
 * Reads every feed and gathers News for the whole Catalogue, then scores and stores what it
 * carries. What it stores is Catalogue: every User reads it, and nobody's swipes decided any of
 * it was gathered. See docs/adr/0022, which amends docs/adr/0019 on who gathering is for and
 * docs/adr/0010 on which pairs are stored.
 *
 * Four paths, in order:
 *
 * 1. **The feeds.** Every feed is read and every article stored once in `news_articles`, matched
 *    or not, per docs/adr/0022, with no Profile against its name: a feed article is Catalogue.
 *    The articles this run had never read are scored against every Company Profile in it.
 * 2. **Launch HN.** A widening Hacker News search (docs/adr/0023), read and stored and scored
 *    exactly as the feeds are, since it answers who Launch HN posts about no better than a feed
 *    does: `since` is the later of the newest Launch HN post already stored and
 *    `LAUNCH_HN_MIN_WINDOW_DAYS` ago.
 * 3. **The Company Profiles News has not seen.** Each is scored against the articles read on
 *    earlier runs — today's are left out, because the paths above have already scored them
 *    against the whole Catalogue, and a pair scored twice is only a pair counted twice — so a
 *    company that entered the Catalogue after an article was published still gets it.
 * 4. **The history search.** Two years of Hacker News for each of those same Profiles, capped at
 *    `HISTORY_SEARCHES_PER_RUN` a run, oldest-created first. Every result is stored in
 *    `news_articles` carrying the Profile it was searched for, and scored against that Profile
 *    and no other, per docs/adr/0018 and docs/adr/0024. A hit from the `site` query — whose host
 *    is the company's own — is judged by the news-only rule in `company-news.ts` rather than by
 *    the matcher alone.
 * 5. **The recovery pass.** For a Company Profile already covered whose `site` query ran under
 *    the old rule, that one query again, on whatever the first searches left of the cap, once
 *    ever, recorded in `news_profile_site_recovery`. See docs/adr/0024.
 *
 * A Profile is recorded in `news_profile_coverage` only when its search succeeded and the write
 * that followed did too, so a failed search or a spent cap means it is tried again next run. A
 * re-search is recorded in `news_profile_site_recovery` on the same terms.
 *
 * Only a pair scoring above zero becomes a `news_items` row, and re-running stores nothing twice:
 * that table's unique index on `(profile_id, url)` is the key, as `news_articles`' on `url` is.
 *
 * Every feed is read even when the Catalogue is empty, so a run proves its feeds still parse on
 * a day it has nothing to match them against. Launch HN is read the same way, feeds or none.
 *
 * Never throws for a feed, Launch HN, or a search problem. A feed that cannot be fetched, no
 * longer parses, or has every one of its items rejected is a failure naming the feed; Launch HN
 * failing the same way is named in the report and never fails the run on its own, per
 * docs/adr/0023; a search that cannot be fetched, no longer parses, or has every one of its hits
 * rejected is a failure naming the company. Either way the next one is still tried. A database
 * error does throw, since nothing after it could be written either.
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
  const launchHnSinceDate = launchHnSince(
    await readLatestLaunchHnPublishedAt(db),
    now,
  );
  const { outcome: launchHn, articles: launchHnArticles } = await readLaunchHn(
    search,
    launchHnSinceDate,
  );
  const articles = await persistNewsArticles(db, {
    articles: [...read.articles, ...launchHnArticles],
  });

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
  /** Every hit every search found, to be stored whatever it scored. See docs/adr/0024. */
  const searchArticleInputs: NewsArticleInput[] = [];

  /**
   * Scores one search's hits against the Company Profile it was searched for, and keeps the
   * articles themselves. Against this Profile alone, so not through `scoreEvery`'s cross
   * product.
   */
  const takeSearchHits = (
    profile: NewsCompany,
    hits: readonly SearchHit[],
  ): void => {
    for (const hit of hits) {
      const scored = searchCandidate(profile, hit);
      searchScores.push(scored.confidence);
      searchArticleInputs.push({
        ...hit.article,
        searchedForProfileId: profile.id,
      });

      if (scored.confidence > 0) {
        attributed.push(scored);
      }
    }
  };

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
      articles: found.hits.length,
      tooCommonTitles: found.tooCommonTitles,
      rejections: found.rejections,
    });
    searched.push(profile.id);
    takeSearchHits(profile, found.hits);
  }

  // The recovery pass: a Company Profile already covered, whose site query ran under the old
  // rule and whose results were thrown away, gets that one query run again. Only on what the
  // first searches left of this run's cap, so a Catalogue with new Profiles in it never spends
  // its searches on old ones — docs/adr/0024.
  const recovered = await readNewsSiteRecoveredProfileIds(db);
  const awaitingReSearch = catalogue.filter(
    (company) =>
      covered.has(company.id) &&
      !recovered.has(company.id) &&
      companyDomain(company.website) !== null,
  );
  const reSearching = awaitingReSearch.slice(
    0,
    HISTORY_SEARCHES_PER_RUN - firstRuns.length,
  );
  const reSearched: string[] = [];
  let reSearchesFailed = 0;

  for (const profile of reSearching) {
    // The site query alone: the title query's results were kept all along, and re-running it
    // would be a second search for nothing. `awaitingReSearch` is filtered on `companyDomain`,
    // so there is always one query here.
    const found = await searchCompany(
      historyQueries(profile, now).filter((query) => query.kind === "site"),
      search,
      now,
    );

    if ("failure" in found) {
      reSearchesFailed += 1;
      continue;
    }

    reSearched.push(profile.id);
    takeSearchHits(profile, found.hits);
  }

  const fromSearches = pathScores(searchScores);
  // Before the attributions and the records below, so a failed write leaves the Profile
  // uncovered and un-recovered, and both are tried again rather than lost.
  const searchArticles = await persistNewsArticles(db, {
    articles: searchArticleInputs,
  });
  const stored = await persistNewsItems(db, { candidates: attributed });

  // Last, and only for the Profiles whose search succeeded: a row here says both halves of a
  // first run happened and were written. A throw above leaves every Profile uncovered.
  const covering = await recordNewsCoverage(db, searched);
  const recovering = await recordNewsSiteRecovery(db, reSearched);

  return {
    companies: catalogue.length,
    feeds: read.outcomes,
    launchHn,
    articles: {
      stored: articles.inserted + articles.updated,
      fresh: articles.inserted,
      rejections: articles.rejections,
    },
    searches,
    waiting: unseen.length - firstRuns.length,
    reSearches: {
      done: recovering,
      failed: reSearchesFailed,
      waiting: awaitingReSearch.length - reSearching.length,
    },
    covered: covering,
    searchArticles: {
      stored: searchArticles.inserted + searchArticles.updated,
      fresh: searchArticles.inserted,
      rejections: searchArticles.rejections,
    },
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
 * not. The feeds and the searches are judged apart so a run says which half failed; Launch HN
 * is judged by neither rule, for the reason given below.
 *
 * The feeds fail when there was at least one to read and not one of them was. `NEWS_FEEDS` is
 * empty since Ticket #220 (docs/adr/0023), so a run with none configured has nothing to have
 * failed at reading — the same reasoning the searches already had for a Catalogue with nothing
 * new to search for. A run that read its feeds and matched nothing is not a failure either — a
 * two-person startup can go a month unreported.
 *
 * The searches fail when there was at least one to run and every one failed, even though the
 * feeds were read: the feeds succeeding says nothing about whether the history was searched. A
 * search that found nothing is a quiet company, not a failure. A feed or a search that failed
 * beside one that did not is named in the summary rather than failing the run.
 *
 * Launch HN has no rule of its own, by design: see docs/adr/0023. A failed Launch HN search is
 * always named in the summary, and never on its own reason enough to fail the run.
 */
export function newsRunFailures(report: NewsRunReport): string[] {
  const failures: string[] = [];

  if (report.feeds.length > 0 && report.feeds.every(failed)) {
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

  if (failed(report.launchHn)) {
    lines.push(`Launch HN: failed, ${report.launchHn.failure}`);
  } else {
    lines.push(
      `Launch HN: read ${report.launchHn.articles} ${plural(report.launchHn.articles, "post", "posts")}.`,
    );

    for (const rejection of report.launchHn.rejections) {
      lines.push(`  rejected on ${rejection.field}: ${rejection.reason}`);
    }
  }

  lines.push(
    `Stored ${report.articles.stored} ${plural(report.articles.stored, "article", "articles")} from feeds and Launch HN, ` +
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
    `Re-searched the site query for ${report.reSearches.done} Company ` +
      `${plural(report.reSearches.done, "Profile", "Profiles")} already covered, ` +
      `${report.reSearches.failed} failed, with ${report.reSearches.waiting} still waiting.`,
    `Stored ${report.searchArticles.stored} ${plural(report.searchArticles.stored, "article", "articles")} from searches, ` +
      `${report.searchArticles.fresh} new to the Catalogue.`,
  );

  for (const rejection of report.searchArticles.rejections) {
    lines.push(`  rejected on ${rejection.field}: ${rejection.reason}`);
  }

  lines.push(
    describePath("From feeds and Launch HN", report.fromFeeds),
    describePath("From stored articles", report.fromStored),
    describePath("From searches and re-searches", report.fromSearches),
    `${report.onSeveralCompanies} ${plural(report.onSeveralCompanies, "article", "articles")} from feeds or Launch HN ` +
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
