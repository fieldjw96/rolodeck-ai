import type { Database } from "../../db/connection";
import {
  persistNewsItems,
  readKeptCompaniesForNews,
  type NewsCandidate,
} from "../../db/news";
import type { IngestRejection } from "../../db/profile-input";
import { parseGNewsResponse, type GNewsClient } from "./gnews";
import { NEWS_DISPLAY_THRESHOLD, scoreNewsMatch } from "./match";

/**
 * One News run: ask the provider about every Kept Company Profile, score what comes back, store
 * all of it. Everything `scripts/ingest-news.ts` does that is worth testing, with the database
 * and the provider both passed in.
 */

/** A company the run could not get News for, and why. The run carries on past it. */
export type NewsRunFailure = {
  readonly company: string;
  readonly reason: string;
};

export type NewsRunReport = {
  /** How many Kept Company Profiles were searched for. */
  readonly companies: number;
  /** How many articles validated, across every company, before storing. */
  readonly articles: number;
  /** How many of those scored at or above `NEWS_DISPLAY_THRESHOLD`. */
  readonly shown: number;
  readonly inserted: number;
  readonly updated: number;
  readonly failures: readonly NewsRunFailure[];
  /** Articles, or stored candidates, that were skipped for a field that did not validate. */
  readonly rejections: readonly IngestRejection[];
};

/**
 * Fetches, scores and stores News for `ownerId`'s Kept Company Profiles.
 *
 * Kept comes from `readKeptCompaniesForNews`, which asks the one function the ingest role may
 * call about `swipes` rather than reading the table, since this runs as that role — see
 * docs/adr/0013. A Company Profile that is unswiped or Passed is never searched for — which also
 * keeps the provider's daily quota spent on companies the owner has said are worth it.
 *
 * Never throws for a provider problem. A search that fails, or a response that has changed
 * shape, is a failure naming the company and the reason, and the next company is still
 * searched: one 429 should cost one company's News, not the run. A database error does throw,
 * since nothing after it could be written either.
 */
export async function fetchNewsForKeptProfiles(
  db: Database,
  { ownerId, client }: { ownerId: string; client: GNewsClient },
): Promise<NewsRunReport> {
  const kept = await readKeptCompaniesForNews(db, ownerId);

  let articles = 0;
  let shown = 0;
  let inserted = 0;
  let updated = 0;
  const failures: NewsRunFailure[] = [];
  const rejections: IngestRejection[] = [];

  for (const profile of kept) {
    let raw: unknown;

    try {
      raw = await client.search(profile.name);
    } catch (error) {
      failures.push({
        company: profile.name,
        reason: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    const parsed = parseGNewsResponse(raw);

    if (!parsed.success) {
      failures.push({
        company: profile.name,
        reason: `the response changed shape at ${parsed.rejection.field}: ${parsed.rejection.reason}`,
      });
      continue;
    }

    rejections.push(...parsed.rejections);

    const candidates: NewsCandidate[] = parsed.articles.map((article) => ({
      profileId: profile.id,
      title: article.title,
      description: article.description,
      url: article.url,
      publishedAt: article.publishedAt,
      sourceName: article.sourceName,
      confidence: scoreNewsMatch(profile, article),
    }));

    articles += candidates.length;
    shown += candidates.filter(
      (candidate) => candidate.confidence >= NEWS_DISPLAY_THRESHOLD,
    ).length;

    const report = await persistNewsItems(db, { ownerId, candidates });

    inserted += report.inserted;
    updated += report.updated;
    rejections.push(...report.rejections);
  }

  return {
    companies: kept.length,
    articles,
    shown,
    inserted,
    updated,
    failures,
    rejections,
  };
}

/**
 * Whether the run should exit non-zero: any company the provider could not answer for, or zero
 * Kept Company Profiles searched at all. A run that asked about companies and found no articles
 * is not a failure — a two-person startup can go a month unreported — but a run that asked about
 * nobody is exactly the silent failure this Ticket's Sources are held to elsewhere: a broken
 * `readKeptCompaniesForNews`, or Jack having Kept nothing, both report success today and
 * shouldn't. A spent quota or a revoked key already fails via `failures`.
 */
export function newsRunFailed(report: NewsRunReport): boolean {
  return report.failures.length > 0 || report.companies === 0;
}

/** What the run did, in the order an operator wants to read it. */
export function summariseNewsRun(report: NewsRunReport): string {
  const lines = [
    `Searched GNews for ${report.companies} Kept Company ${report.companies === 1 ? "Profile" : "Profiles"}.`,
    `  ${report.articles} articles, ${report.shown} at or above the display threshold of ${NEWS_DISPLAY_THRESHOLD}.`,
    `Stored ${report.inserted} new and updated ${report.updated}.`,
  ];

  for (const failure of report.failures) {
    lines.push(`  failed for ${failure.company}: ${failure.reason}`);
  }

  // Named, not counted, for the reason `summariseRun` gives in `lib/ingest/form-d-run.ts`.
  for (const rejection of report.rejections) {
    lines.push(`  rejected on ${rejection.field}: ${rejection.reason}`);
  }

  return lines.join("\n");
}
