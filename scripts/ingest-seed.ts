import { getDb } from "../db/connection";
import { backfillSeedProfiles } from "../db/seed-fallback";

/**
 * The operator entry point for `db/seed-fallback.ts`. Everything worth testing lives there;
 * this file is a database connection in, a log line out. Safe to run more than once — see
 * `backfillSeedProfiles`'s own idempotency guarantee.
 *
 *     DATABASE_URL=... ROLODECK_OWNER_ID=... npm run ingest:seed
 */
async function main(): Promise<void> {
  const report = await backfillSeedProfiles(getDb());

  if (report.added === 0) {
    console.log(
      `profiles already holds ${report.before} row(s); nothing to add.`,
    );
  } else {
    console.log(
      `profiles held ${report.before} row(s); added ${report.added} hand-written Profile(s) to reach ${report.after}.`,
    );
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
