import type { Database } from "../../db/connection";
import {
  persistNewsItems,
  readKeptCompaniesForNews,
  type NewsCandidate,
} from "../../db/news";
import type { IngestRejection } from "../../db/profile-input";
import type { NewsFeedClient } from "./feed-fetch";
import { parseNewsFeed, type NewsArticle, type NewsFeed } from "./feeds";
import { NEWS_DISPLAY_THRESHOLD, scoreNewsMatch } from "./match";

/**
 * One News run: read every feed, score every article in them against every Kept Company
 * Profile, store all of it. Everything `scripts/ingest-news.ts` does that is worth testing, with
 * the database, the feeds and the client that fetches them all passed in.
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

export type NewsRunReport = {
  /** How many Kept Company Profiles every article was scored against. */
  readonly companies: number;
  /** One per feed, in the order they were read. */
  readonly feeds: readonly NewsFeedOutcome[];
  /** Articles times Kept Company Profiles: each pair is one scored candidate. */
  readonly candidates: number;
  /** How many of those scored at or above `NEWS_DISPLAY_THRESHOLD`. */
  readonly shown: number;
  readonly inserted: number;
  readonly updated: number;
  /** Candidates skipped on the way into `news_items` for a field that did not validate. */
  readonly rejections: readonly IngestRejection[];
};

const feedFailed = (
  outcome: NewsFeedOutcome,
): outcome is Extract<NewsFeedOutcome, { failure: string }> =>
  "failure" in outcome;

/**
 * Fetches every feed, and scores and stores what they carry for `ownerId`'s Kept Company
 * Profiles.
 *
 * Kept comes from `readKeptCompaniesForNews`, which asks the one function the ingest role may
 * call about `swipes` rather than reading the table, since this runs as that role — see
 * docs/adr/0013. A Company Profile that is unswiped or Passed is never scored against.
 *
 * Every article is scored against every Kept Company Profile with `scoreNewsMatch`, and every
 * pair is stored, including the ones scoring zero, per docs/adr/0010: an article about two Kept
 * companies is stored once for each, which is what `news_items.profile_id` means.
 *
 * Every feed is read even when nothing is Kept, so a run proves its feeds still parse on the days
 * it has nobody to match them against.
 *
 * Never throws for a feed problem. A feed that cannot be fetched, no longer parses, or has every
 * one of its items rejected is a failure naming the feed and the reason, and the next feed is
 * still read. A database error does
 * throw, since nothing after it could be written either.
 */
export async function fetchNewsForKeptProfiles(
  db: Database,
  {
    ownerId,
    feeds,
    client,
  }: {
    ownerId: string;
    feeds: readonly NewsFeed[];
    client: NewsFeedClient;
  },
): Promise<NewsRunReport> {
  const kept = await readKeptCompaniesForNews(db, ownerId);

  const outcomes: NewsFeedOutcome[] = [];
  const articles: NewsArticle[] = [];

  for (const feed of feeds) {
    let body: string;

    try {
      body = await client.get(feed.url);
    } catch (error) {
      outcomes.push({
        feed: feed.name,
        failure: error instanceof Error ? error.message : String(error),
      });
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

  const candidates: NewsCandidate[] = kept.flatMap((profile) =>
    articles.map((article) => ({
      profileId: profile.id,
      title: article.title,
      description: article.description,
      url: article.url,
      publishedAt: article.publishedAt,
      sourceName: article.sourceName,
      confidence: scoreNewsMatch(profile, article),
    })),
  );

  const stored = await persistNewsItems(db, { ownerId, candidates });

  return {
    companies: kept.length,
    feeds: outcomes,
    candidates: candidates.length,
    shown: candidates.filter(
      (candidate) => candidate.confidence >= NEWS_DISPLAY_THRESHOLD,
    ).length,
    inserted: stored.inserted,
    updated: stored.updated,
    rejections: stored.rejections,
  };
}

/**
 * Whether the run should exit non-zero: when not one feed was read. A run that read its feeds and
 * matched nothing is not a failure — until Jack Keeps a Company Profile there is nothing to match
 * against, and a two-person startup can go a month unreported after that — but a run that read no
 * feed at all has checked nothing. A feed that failed beside one that did not is named in the
 * summary rather than failing the run.
 */
export function newsRunFailed(report: NewsRunReport): boolean {
  return report.feeds.every(feedFailed);
}

/** What the run did, feed by feed and then in total, in the form every ingest script prints. */
export function summariseNewsRun(report: NewsRunReport): string {
  const lines: string[] = [];

  for (const outcome of report.feeds) {
    if (feedFailed(outcome)) {
      lines.push(`${outcome.feed}: failed, ${outcome.failure}`);
      continue;
    }

    lines.push(
      `${outcome.feed}: read ${outcome.articles} ${outcome.articles === 1 ? "article" : "articles"}.`,
    );

    // Named, not counted, for the reason `summariseRun` gives in `lib/ingest/form-d-run.ts`.
    for (const rejection of outcome.rejections) {
      lines.push(`  rejected on ${rejection.field}: ${rejection.reason}`);
    }
  }

  lines.push(
    `Scored against ${report.companies} Kept Company ${report.companies === 1 ? "Profile" : "Profiles"}: ` +
      `${report.candidates} candidates, ${report.shown} at or above the display threshold of ${NEWS_DISPLAY_THRESHOLD}.`,
    `Stored ${report.inserted} new and updated ${report.updated}.`,
  );

  for (const rejection of report.rejections) {
    lines.push(`  rejected on ${rejection.field}: ${rejection.reason}`);
  }

  return lines.join("\n");
}
