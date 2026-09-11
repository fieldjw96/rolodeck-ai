import { closeIngestDb, getIngestDb } from "../db/connection";
import { backfillSeedProfiles, MINIMUM_PROFILE_COUNT } from "../db/seed";

/**
 * Guarantees `profiles` holds at least `MINIMUM_PROFILE_COUNT` real rows, regardless of how
 * well the live scrapers did, by hand-adding named Bay Area startups Jack has curated himself
 * — `lib/ingest/seed-profiles.ts`. See docs/adr/0002 for why this fallback exists at all.
 *
 * Idempotent: a table that already holds enough Profiles is left untouched, and running this
 * twice never adds a row twice — see `backfillSeedProfiles` in `db/seed.ts`.
 *
 *     SUPABASE_DB_URL=... ROLODECK_OWNER_ID=... npm run ingest:seed
 */
async function main(): Promise<void> {
  const { before, needed, report } = await backfillSeedProfiles(getIngestDb());

  if (needed === 0) {
    console.log(
      `profiles already holds ${before} row(s), at or above the ${MINIMUM_PROFILE_COUNT} ` +
        "minimum. Nothing to add.",
    );
    return;
  }

  console.log(
    `profiles held ${before} row(s), below the ${MINIMUM_PROFILE_COUNT} minimum. ` +
      `Added ${needed} seed Profile(s): inserted ${report.inserted}, updated ` +
      `${report.updated}, rejected ${report.rejected}.`,
  );

  for (const rejection of report.rejections) {
    console.log(`  rejected (${rejection.field}): ${rejection.reason}`);
  }

  if (report.rejected > 0) {
    // Every entry in SEED_PROFILES is meant to pass profileInputSchema unchanged, so a
    // rejection here means the seed data itself is malformed, not that a source went stale.
    throw new Error(
      `${report.rejected} seed Profile(s) failed validation — the seed data itself is malformed.`,
    );
  }
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(closeIngestDb);
