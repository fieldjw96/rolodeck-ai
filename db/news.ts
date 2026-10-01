import { and, asc, desc, eq, gte, sql } from "drizzle-orm";
import { z } from "zod";

import { NEWS_DISPLAY_THRESHOLD } from "../lib/news/match";
import { issueField } from "../lib/zod/issues";
import type { Database } from "./connection";
import type { IngestRejection } from "./profile-input";
import { newsItems, profiles, swipes } from "./schema";

/**
 * The one write path into `news_items` and the one read path out of it.
 *
 * Nothing here fetches or matches. It takes articles that already carry a `confidence`, stores
 * every one of them, and on the way out shows only those at or above `NEWS_DISPLAY_THRESHOLD`.
 * That split — store everything, filter on read — is the decision docs/adr/0010 records.
 */

/** A Kept Company Profile, as much of it as News needs to search for it and score the results. */
export type KeptCompany = {
  readonly id: string;
  readonly name: string;
  readonly sector: string;
  /** Searched as the company's own domain, per `lib/news/history-search.ts`. */
  readonly website: string | null;
};

/**
 * The Company Profiles `keepsUserId` has Kept, which are the ones a News run searches for, read
 * the way the ingest role can.
 *
 * One User's Keeps and not every User's, deliberately: docs/adr/0019 keeps gathering narrow
 * while the Catalogue it writes into is shared. `lib/news/env.ts` is where that User is named
 * and why.
 *
 * `readKeptProfiles` in `db/deck.ts` answers the same question for the Watchlist by joining
 * `swipes`, which the ingest role holds no grant on. This asks `ingest.kept_profile_ids` — a
 * function migration `0008_ingest_role` defines and lets that role alone call — for the ids
 * instead, so ingest learns which companies are Kept without being able to read or write
 * anything else about a swipe. That function still takes the User to answer for, and so still
 * carries ADR 0013's second deferred risk: it is unchanged by docs/adr/0019.
 *
 * Ordered by name, not by when each was Kept: the function hands out ids and nothing more, and
 * the order a run searches in only decides which company a spent quota lands on.
 */
export async function readKeptCompaniesForNews(
  db: Database,
  keepsUserId: string,
): Promise<KeptCompany[]> {
  const keeper = z.guid().parse(keepsUserId);

  return db
    .select({
      id: profiles.id,
      name: profiles.name,
      sector: profiles.sector,
      website: profiles.website,
    })
    .from(profiles)
    .where(
      sql`${profiles.id} in (select ingest.kept_profile_ids(${keeper}::uuid))`,
    )
    .orderBy(asc(profiles.name), asc(profiles.id));
}

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

/**
 * Stores a batch of candidates idempotently on `(profile_id, url)`. Nobody owns them: an
 * article is Catalogue, read by every User whatever Keep caused it to be fetched. See
 * docs/adr/0019.
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
): Promise<NewsIngestReport> {
  const accepted: z.infer<typeof candidateSchema>[] = [];
  const rejections: IngestRejection[] = [];

  for (const candidate of candidates) {
    const parsed = candidateSchema.safeParse(candidate);

    if (parsed.success) {
      accepted.push(parsed.data);
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

  return { inserted, updated, rejected: rejections.length, rejections };
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
 * matching `readKeptProfiles`. A User who has Kept a company Jack never did sees no News for
 * it, because nothing gathered any: docs/adr/0019 accepts that consequence by name.
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
