import { and, asc, eq, isNotNull, isNull, lt, or, sql } from "drizzle-orm";

import type { Database } from "./connection";
import type { Founder } from "./profile-input";
import { profiles } from "./schema";

/**
 * The database half of the team-page enrichment: which Company Profiles it reads a site for,
 * and what it writes back. See docs/adr/0016.
 *
 * It only ever updates rows that exist, and never inserts one. This is not a Source: ADR 0008
 * makes `source` part of a Company Profile's identity, so writing what a company's own site
 * says as a Source would deal the Deck a second card for a company it already has.
 */

export type TeamPageCandidate = {
  readonly profileId: string;
  readonly name: string;
  readonly website: string;
};

/**
 * How long a site that has been read stays out of the queue. Long enough that a run does not
 * spend its quota re-reading pages it read last week, and short enough that a company which
 * publishes a team page after launch is found within a month or so.
 */
export const TEAM_PAGE_RETRY_AFTER_DAYS = 30;

/**
 * Company Profiles that state no founders and do have a website, never-read first and then
 * oldest attempt first, at most `limit`. A Profile read within `TEAM_PAGE_RETRY_AFTER_DAYS`
 * is not taken at all.
 */
export async function selectTeamPageCandidates(
  db: Database,
  {
    ownerId,
    limit,
    now = new Date(),
  }: { ownerId: string; limit: number; now?: Date },
): Promise<TeamPageCandidate[]> {
  const retryBefore = new Date(
    now.getTime() - TEAM_PAGE_RETRY_AFTER_DAYS * 24 * 60 * 60 * 1000,
  );

  const rows = await db
    .select({
      profileId: profiles.id,
      name: profiles.name,
      website: profiles.website,
    })
    .from(profiles)
    .where(
      and(
        eq(profiles.ownerId, ownerId),
        isNull(profiles.founders),
        isNotNull(profiles.website),
        or(
          isNull(profiles.foundersSoughtAt),
          lt(profiles.foundersSoughtAt, retryBefore),
        ),
      ),
    )
    .orderBy(
      sql`${profiles.foundersSoughtAt} asc nulls first`,
      asc(profiles.createdAt),
      asc(profiles.id),
    )
    .limit(limit);

  return rows.flatMap((row) =>
    row.website === null ? [] : [{ ...row, website: row.website }],
  );
}

export type TeamPageResult = {
  readonly profileId: string;
  /** What the page stated, or null when it was read, or refused, and named nobody. */
  readonly founders: readonly Founder[] | null;
};

/**
 * Records one run's attempts: every Profile in `results` is marked as read at `at`, and those
 * with founders get them, attributed `enriched`. Returns how many Profiles gained founders.
 *
 * Every write is conditional on `founders` still being null, in the statement itself, so a
 * Profile a Source stated a team for between the read and this write is never touched,
 * whatever the page said: this fills gaps and never corrects a Source. One transaction, so the
 * count describes the table as it now is.
 */
export async function recordTeamPageResults(
  db: Database,
  {
    ownerId,
    results,
    at,
  }: { ownerId: string; results: readonly TeamPageResult[]; at: Date },
): Promise<{ updated: number }> {
  return db.transaction(async (tx) => {
    let updated = 0;

    for (const result of results) {
      const stillAGap = and(
        eq(profiles.id, result.profileId),
        eq(profiles.ownerId, ownerId),
        isNull(profiles.founders),
      );

      if (result.founders === null || result.founders.length === 0) {
        await tx
          .update(profiles)
          .set({ foundersSoughtAt: at })
          .where(stillAGap);
        continue;
      }

      const written = await tx
        .update(profiles)
        .set({
          founders: [...result.founders],
          provenance: sql`jsonb_set(${profiles.provenance}, '{founders}', '"enriched"')`,
          foundersSoughtAt: at,
        })
        .where(stillAGap)
        .returning({ id: profiles.id });

      updated += written.length;
    }

    return { updated };
  });
}
