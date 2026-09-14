import { eq, sql } from "drizzle-orm";

import { SEED_CANDIDATES, SEED_SOURCE } from "../lib/ingest/seed-profiles";
import { readOwnerId } from "../lib/ingest/env";
import type { Database } from "./connection";
import { persistProfiles, type IngestReport } from "./ingest";
import { profiles } from "./schema";

/**
 * Guarantees `profiles` holds at least this many rows, regardless of how well the live
 * scrapers did on their own. See docs/adr/0002: this is the fallback that ADR describes
 * rather than a substitute for real scraping.
 */
export const MINIMUM_PROFILE_COUNT = 30;

const NOTHING_TO_ADD: IngestReport = {
  inserted: 0,
  updated: 0,
  rejected: 0,
  rejections: [],
};

export type SeedBackfillResult = {
  /** How many Profiles the owner held before this ran. */
  readonly before: number;
  /** How many of `SEED_CANDIDATES` this run attempted to add, in list order. Zero is a pass. */
  readonly needed: number;
  readonly report: IngestReport;
};

/**
 * Tops `profiles` up to `MINIMUM_PROFILE_COUNT`, adding only as many hand-written seed
 * Profiles as are needed to reach it and none once the floor is already met — a table the
 * scrapers already filled past the minimum is left exactly as they wrote it. That is a pass,
 * not a no-op failure: see this repo's Ticket #7.
 *
 * Idempotent by construction: a second call finds `before` already at or above the minimum
 * and writes nothing, and even a call that lands mid-way is safe, since `persistProfiles`
 * itself is idempotent on `(owner_id, source, name_key)` — docs/adr/0008.
 */
export async function backfillSeedProfiles(
  db: Database,
): Promise<SeedBackfillResult> {
  const ownerId = readOwnerId();

  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(profiles)
    .where(eq(profiles.ownerId, ownerId));

  const before = row?.count ?? 0;
  const needed = Math.max(0, MINIMUM_PROFILE_COUNT - before);

  if (needed === 0) {
    return { before, needed, report: NOTHING_TO_ADD };
  }

  const report = await persistProfiles(db, {
    source: SEED_SOURCE,
    // Never exceeds SEED_CANDIDATES.length: `needed` is at most MINIMUM_PROFILE_COUNT, and
    // the seed list is kept a few entries deep past that floor.
    candidates: SEED_CANDIDATES.slice(0, needed),
  });

  return { before, needed, report };
}
