import { closeIngestDb, getIngestDb } from "../db/connection";
import { createGNewsClient, readGNewsApiKey } from "../lib/news/gnews";
import {
  fetchNewsForKeptProfiles,
  newsRunFailed,
  summariseNewsRun,
} from "../lib/news/run";
import { readOwnerId } from "../lib/supabase/env";

/**
 * The operator entry point for News. Everything worth testing lives in `lib/news/`; this file
 * is environment in, stdout out, and an exit code.
 *
 * On demand only, like every Source's script: it makes real requests to GNews, spends real
 * quota, and writes real rows through the RLS-bypassing connection, none of which belongs in
 * `npm test` or CI.
 *
 *     GNEWS_API_KEY=... SUPABASE_DB_URL=... ROLODECK_OWNER_ID=... npm run ingest:news
 *
 * Exits non-zero when any company could not be searched for. See `newsRunFailed`.
 */
async function main(): Promise<void> {
  // Both read before anything is fetched, so a missing key or owner fails on the first line.
  const client = createGNewsClient({ apiKey: readGNewsApiKey() });
  const ownerId = readOwnerId();

  const report = await fetchNewsForKeptProfiles(getIngestDb(), {
    ownerId,
    client,
  });

  console.log(summariseNewsRun(report));

  if (newsRunFailed(report)) {
    throw new Error(
      `News could not be fetched for ${report.failures.length} of ${report.companies} companies. ` +
        "See the failures above.",
    );
  }
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(closeIngestDb);
