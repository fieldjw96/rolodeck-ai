import {
  formatDuplicateReport,
  measureProfileDuplicates,
} from "../lib/ingest/measure-profile-duplicates";
import { closeIngestDb, getIngestDb } from "../db/ingest-connection";
import { readOwnerId } from "../lib/ingest/env";

/**
 * The operator entry point for measuring duplicate profiles by name_key. This is a read-only
 * script that analyzes which companies appear under multiple sources.
 *
 * On demand only. It makes no writes and makes no network calls.
 *
 *     ROLODECK_INGEST_DATABASE_URL=... ROLODECK_OWNER_ID=... npm run measure:profile-duplicates
 *
 * Outputs a report showing the count, percentage, and worst offenders.
 */
async function main(): Promise<void> {
  const ownerId = readOwnerId();
  const db = await getIngestDb();

  const stats = await measureProfileDuplicates(db, ownerId);
  console.log(formatDuplicateReport(stats));
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(closeIngestDb);
