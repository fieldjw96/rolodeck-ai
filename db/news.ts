import { and, asc, desc, eq, gte, like, sql } from "drizzle-orm";
import { z } from "zod";

import { NEWS_DISPLAY_THRESHOLD } from "../lib/news/match";
import { issueField } from "../lib/zod/issues";
import type { Database } from "./connection";
import type { IngestRejection } from "./profile-input";
import {
  newsArticles,
  newsItems,
  newsProfileCoverage,
  newsProfileSiteRecovery,
  profiles,
  swipes,
} from "./schema";

/**
 * The write paths News ingest uses and the one read path the page uses.
 *
 * Nothing here fetches or matches. It takes feed articles and stores each once; it takes pairs
 * that already carry a `confidence` and stores the ones above zero; and on the way out it shows
 * only those at or above `NEWS_DISPLAY_THRESHOLD`. Filtering on read rather than at fetch time
 * is docs/adr/0010; the split between the article and the attribution, and gathering for the
 * whole Catalogue rather than one account's Keeps, is docs/adr/0022.
 */

/** A Company Profile, as much of it as News needs to search for it and score the results. */
export type NewsCompany = {
  readonly id: string;
  readonly name: string;
  readonly sector: string;
  /** Searched as the company's own domain, per `lib/news/history-search.ts`. */
  readonly website: string | null;
};

/**
 * Every Company Profile in the Catalogue, which is what a News run scores against and searches
 * for. Not anybody's Keeps: docs/adr/0022 removed the gathering User, so there is no swipe in
 * this query and nothing for the ingest role to be told about one.
 *
 * Oldest first, because that is the order the history search's per-run cap works through: a
 * Company Profile that has waited longest for its first search is searched for first.
 */
export async function readCatalogueCompaniesForNews(
  db: Database,
): Promise<NewsCompany[]> {
  return db
    .select({
      id: profiles.id,
      name: profiles.name,
      sector: profiles.sector,
      website: profiles.website,
    })
    .from(profiles)
    .orderBy(asc(profiles.createdAt), asc(profiles.id));
}

/**
 * The newest Launch HN post already stored, or null when there is none. Read rather than kept
 * as its own state: every Launch HN post is stored with a title beginning `Launch HN:` by
 * construction (`lib/news/launch-hn.ts`), and `news_articles` is already unique on `url`, so
 * this is the fact a new table would otherwise exist to repeat. See docs/adr/0023.
 */
export async function readLatestLaunchHnPublishedAt(
  db: Database,
): Promise<Date | null> {
  const [row] = await db
    .select({ publishedAt: newsArticles.publishedAt })
    .from(newsArticles)
    .where(like(newsArticles.title, "Launch HN:%"))
    .orderBy(desc(newsArticles.publishedAt))
    .limit(1);

  return row?.publishedAt ?? null;
}

/** One article as it is stored, before anything has been attributed to a company. */
export type NewsArticleInput = {
  readonly title: string;
  readonly description: string | null;
  readonly url: string;
  readonly publishedAt: Date;
  readonly sourceName: string;
  /**
   * The Company Profile a history search found this article for, or null when a feed or Launch HN
   * read it. An article with one is scored against that Profile and no other, which is how
   * docs/adr/0018's rule survives being stored here at all. See docs/adr/0024.
   */
  readonly searchedForProfileId?: string | null;
};

/** One article on its way in, attributed to one Company Profile with a score for how sure. */
export type NewsCandidate = {
  readonly profileId: string;
  readonly title: string;
  readonly description: string | null;
  readonly url: string;
  readonly publishedAt: Date;
  readonly sourceName: string;
  readonly confidence: number;
};

const nonBlank = z
  .string()
  .refine((value) => value.trim().length > 0, { message: "must not be blank" });

/**
 * The same shape again, in Zod, for the reason `persistProfiles` gives: this is the last
 * boundary before Postgres, the write runs as the RLS-bypassing ingest role, and a candidate
 * that went wrong between the parser and here is rejected by field name rather than aborting
 * the batch on a check constraint.
 */
const candidateSchema = z.strictObject({
  profileId: z.guid(),
  title: nonBlank,
  description: z.string().nullable(),
  url: z.url({ protocol: /^https?$/ }),
  publishedAt: z.date(),
  sourceName: nonBlank,
  confidence: z
    .number()
    .min(0, "must be between 0 and 1")
    .max(1, "must be between 0 and 1"),
});

export type NewsIngestReport = {
  readonly inserted: number;
  readonly updated: number;
  readonly rejected: number;
  readonly rejections: readonly IngestRejection[];
};

/** The same shape in Zod, for the reason `candidateSchema` gives, without the score. */
const articleSchema = z.strictObject({
  title: nonBlank,
  description: z.string().nullable(),
  url: z.url({ protocol: /^https?$/ }),
  publishedAt: z.date(),
  sourceName: nonBlank,
  /** Defaulted rather than optional, so one shape reaches the insert whoever built it. */
  searchedForProfileId: z.guid().nullish().default(null),
});

export type NewsArticleIngestReport = NewsIngestReport & {
  /**
   * The articles this run had never read before, which are the ones worth scoring against the
   * whole Catalogue. An article already stored has already been scored against every Company
   * Profile that existed then, and against each newer one on the run that first saw it.
   */
  readonly fresh: readonly NewsArticleInput[];
};

/**
 * Stores feed articles idempotently on `url`, one row each whoever they turn out to be about.
 * See docs/adr/0022.
 *
 * Follows `persistNewsItems` below point for point — Postgres's unique index as the key, one
 * statement per article since a batch can carry the same url twice, inserted and updated counted
 * apart with `xmax = 0`, one transaction, `fetched_at` left alone on update — and adds `fresh`,
 * the articles that were new to this database. An update re-writes the fields a publisher may
 * have corrected.
 */
export async function persistNewsArticles(
  db: Database,
  { articles }: { articles: Iterable<NewsArticleInput> },
): Promise<NewsArticleIngestReport> {
  const accepted: z.infer<typeof articleSchema>[] = [];
  const rejections: IngestRejection[] = [];

  for (const article of articles) {
    const parsed = articleSchema.safeParse(article);

    if (parsed.success) {
      accepted.push(parsed.data);
    } else {
      // A failed safeParse always carries at least one issue.
      const issue = parsed.error.issues[0]!;
      rejections.push({
        field: issueField(issue),
        reason: issue.message,
        raw: article,
      });
    }
  }

  const { inserted, updated, fresh } = await db.transaction(async (tx) => {
    let inserted = 0;
    let updated = 0;
    const fresh: NewsArticleInput[] = [];

    for (const article of accepted) {
      const [written] = await tx
        .insert(newsArticles)
        .values(article)
        .onConflictDoUpdate({
          target: newsArticles.url,
          set: {
            title: sql`excluded.title`,
            description: sql`excluded.description`,
            publishedAt: sql`excluded.published_at`,
            sourceName: sql`excluded.source_name`,
            // `searched_for_profile_id` is deliberately not here, and ingest holds no UPDATE
            // grant on it either: it says which Company Profile's search first stored this
            // article, so an article a feed carried first stays Catalogue when a search finds
            // the same url later. See docs/adr/0024.
          },
        })
        .returning({ inserted: sql<boolean>`(xmax = 0)` });

      if (written?.inserted === true) {
        inserted += 1;
        fresh.push(article);
      } else {
        updated += 1;
      }
    }

    return { inserted, updated, fresh };
  });

  return { inserted, updated, fresh, rejected: rejections.length, rejections };
}

/**
 * Every article stored, newest first. What a Company Profile new to News is scored against on
 * its first run, so it arrives with its News rather than waiting for the next thing published
 * about it. See docs/adr/0022.
 *
 * `searchedForProfileId` comes back with each row because the caller must honour it: an article
 * a search found is scored against that one Company Profile and no other, however many runs
 * later it is read. See docs/adr/0024 and docs/adr/0018.
 */
export async function readStoredNewsArticles(
  db: Database,
): Promise<NewsArticleInput[]> {
  return db
    .select({
      title: newsArticles.title,
      description: newsArticles.description,
      url: newsArticles.url,
      publishedAt: newsArticles.publishedAt,
      sourceName: newsArticles.sourceName,
      searchedForProfileId: newsArticles.searchedForProfileId,
    })
    .from(newsArticles)
    .orderBy(desc(newsArticles.publishedAt), desc(newsArticles.url));
}

/**
 * The ids of the Company Profiles a News run has already scored against the stored articles and
 * searched Hacker News for. Read rather than inferred from `news_items`, because a company
 * nobody has written about is a company with no attributions and nothing left to do.
 */
export async function readNewsCoveredProfileIds(
  db: Database,
): Promise<Set<string>> {
  const rows = await db
    .select({ profileId: newsProfileCoverage.profileId })
    .from(newsProfileCoverage);

  return new Set(rows.map((row) => row.profileId));
}

/**
 * Records that these Company Profiles have had both halves of their first run: scored against
 * every stored article, and searched for over Hacker News. Called after the attributions are
 * written, so a failed write leaves the Profile uncovered and it is tried again.
 *
 * `onConflictDoNothing` because the row says a thing happened once, and a concurrent run that
 * got there first has not made that less true. Returns how many rows it added.
 */
export async function recordNewsCoverage(
  db: Database,
  profileIds: readonly string[],
): Promise<number> {
  if (profileIds.length === 0) {
    return 0;
  }

  const written = await db
    .insert(newsProfileCoverage)
    .values(profileIds.map((profileId) => ({ profileId })))
    .onConflictDoNothing()
    .returning({ profileId: newsProfileCoverage.profileId });

  return written.length;
}

/**
 * The ids of the Company Profiles whose own-site search has already been run again under the
 * news-only rule, so it is never run again. Read, not inferred, for the reason
 * `readNewsCoveredProfileIds` gives: a company whose site query finds nothing is the ordinary
 * case. See docs/adr/0024.
 */
export async function readNewsSiteRecoveredProfileIds(
  db: Database,
): Promise<Set<string>> {
  const rows = await db
    .select({ profileId: newsProfileSiteRecovery.profileId })
    .from(newsProfileSiteRecovery);

  return new Set(rows.map((row) => row.profileId));
}

/**
 * Records that these Company Profiles have had their own-site search run again, and its results
 * kept. Insert-only and idempotent, exactly as `recordNewsCoverage` is and for the same reason:
 * the row says a thing happened once. Returns how many rows it added.
 */
export async function recordNewsSiteRecovery(
  db: Database,
  profileIds: readonly string[],
): Promise<number> {
  if (profileIds.length === 0) {
    return 0;
  }

  const written = await db
    .insert(newsProfileSiteRecovery)
    .values(profileIds.map((profileId) => ({ profileId })))
    .onConflictDoNothing()
    .returning({ profileId: newsProfileSiteRecovery.profileId });

  return written.length;
}

export type NewsItemIngestReport = NewsIngestReport & {
  /**
   * Scored pairs that were not stored because the matcher placed them at zero. Counted rather
   * than written, per docs/adr/0022: at Catalogue scale nearly every pair is one of these, and
   * the run log's confidence distribution is what they were for.
   */
  readonly unattributed: number;
};

/**
 * Stores a batch of candidates idempotently on `(profile_id, url)`. Nobody owns them: an
 * attribution is Catalogue, read by every User whatever gathered it. See docs/adr/0019.
 *
 * Only the pairs the matcher scored above zero become rows — docs/adr/0022, amending
 * docs/adr/0010. The rest are counted as `unattributed` and dropped here rather than filtered by
 * the caller, so there is one rule about what is in this table and it lives next to the table.
 * Nothing is lost by it: the article itself is in `news_articles` whoever it was about.
 *
 * Follows `persistProfiles` (docs/adr/0008) point for point: Postgres's unique index is the key
 * rather than a read-then-insert; one statement per candidate, since a batch can carry the same
 * url twice; inserted and updated counted apart with `xmax = 0`; one transaction per batch; and
 * `fetched_at` left alone on update.
 *
 * An update re-writes the score. A later run scoring the same article under a retuned rule
 * should replace the old number, not sit beside it.
 */
export async function persistNewsItems(
  db: Database,
  { candidates }: { candidates: Iterable<NewsCandidate> },
): Promise<NewsItemIngestReport> {
  const accepted: z.infer<typeof candidateSchema>[] = [];
  const rejections: IngestRejection[] = [];
  let unattributed = 0;

  for (const candidate of candidates) {
    const parsed = candidateSchema.safeParse(candidate);

    if (parsed.success) {
      if (parsed.data.confidence > 0) {
        accepted.push(parsed.data);
      } else {
        unattributed += 1;
      }
    } else {
      // A failed safeParse always carries at least one issue.
      const issue = parsed.error.issues[0]!;
      rejections.push({
        field: issueField(issue),
        reason: issue.message,
        raw: candidate,
      });
    }
  }

  const { inserted, updated } = await db.transaction(async (tx) => {
    let inserted = 0;
    let updated = 0;

    for (const candidate of accepted) {
      const [written] = await tx
        .insert(newsItems)
        .values(candidate)
        .onConflictDoUpdate({
          target: [newsItems.profileId, newsItems.url],
          set: {
            title: sql`excluded.title`,
            description: sql`excluded.description`,
            publishedAt: sql`excluded.published_at`,
            sourceName: sql`excluded.source_name`,
            confidence: sql`excluded.confidence`,
          },
        })
        .returning({ inserted: sql<boolean>`(xmax = 0)` });

      if (written?.inserted === true) {
        inserted += 1;
      } else {
        updated += 1;
      }
    }

    return { inserted, updated };
  });

  return {
    inserted,
    updated,
    unattributed,
    rejected: rejections.length,
    rejections,
  };
}

/** One article as the News page shows it. */
export type NewsEntry = {
  readonly id: string;
  readonly title: string;
  readonly url: string;
  readonly publishedAt: Date;
  readonly sourceName: string;
  readonly confidence: number;
};

/** A Kept Company Profile and its News, newest article first. */
export type NewsGroup = {
  readonly profile: {
    readonly id: string;
    readonly name: string;
    readonly sector: string;
  };
  readonly items: readonly NewsEntry[];
};

type NewsRow = NewsEntry & {
  readonly profileId: string;
  readonly profileName: string;
  readonly profileSector: string;
};

/**
 * Groups rows that are already newest first. Each company's items stay newest first, and the
 * companies come out in order of their newest article, so the company with the freshest news
 * is at the top of the page.
 */
export function groupNewsByCompany(rows: readonly NewsRow[]): NewsGroup[] {
  const groups = new Map<
    string,
    { profile: NewsGroup["profile"]; items: NewsEntry[] }
  >();

  for (const row of rows) {
    const group = groups.get(row.profileId) ?? {
      profile: {
        id: row.profileId,
        name: row.profileName,
        sector: row.profileSector,
      },
      items: [],
    };

    group.items.push({
      id: row.id,
      title: row.title,
      url: row.url,
      publishedAt: row.publishedAt,
      sourceName: row.sourceName,
      confidence: row.confidence,
    });
    groups.set(row.profileId, group);
  }

  return [...groups.values()];
}

/**
 * The reader's News: articles about Company Profiles they currently Keep, at or above
 * `NEWS_DISPLAY_THRESHOLD`, grouped by company, newest first.
 *
 * Kept is checked here, on read, as well as by the ingest run on write. A Company Profile Kept
 * last week and Passed today has News already stored, and News for companies that are not Kept
 * is out of scope — so it disappears from the page rather than lingering until a cleanup.
 *
 * The articles are Catalogue and shared; the Keeps that decide which of them this reader sees
 * are not. So the reader is written into the join on `swipes.user_id` and nowhere else,
 * matching `readKeptProfiles`.
 *
 * Unchanged by docs/adr/0022, which is the point of it: gathering for the whole Catalogue means
 * a User who Keeps a company nobody else has Kept now finds News for it here, and this query is
 * the same query it always was.
 */
export async function readNews(
  db: Database,
  userId: string,
): Promise<NewsGroup[]> {
  const rows = await db
    .select({
      id: newsItems.id,
      title: newsItems.title,
      url: newsItems.url,
      publishedAt: newsItems.publishedAt,
      sourceName: newsItems.sourceName,
      confidence: newsItems.confidence,
      profileId: profiles.id,
      profileName: profiles.name,
      profileSector: profiles.sector,
    })
    .from(newsItems)
    .innerJoin(profiles, eq(profiles.id, newsItems.profileId))
    .innerJoin(
      swipes,
      and(
        eq(swipes.profileId, profiles.id),
        eq(swipes.userId, userId),
        eq(swipes.decision, "keep"),
      ),
    )
    .where(gte(newsItems.confidence, NEWS_DISPLAY_THRESHOLD))
    .orderBy(desc(newsItems.publishedAt), desc(newsItems.id));

  return groupNewsByCompany(rows);
}
