import { closeIngestDb, getIngestDb } from "../db/ingest-connection";
import { readOwnerId } from "../lib/ingest/env";
import { createNewsFeedClient } from "../lib/news/feed-fetch";
import { NEWS_FEEDS } from "../lib/news/feeds";
import { createHistorySearchClient } from "../lib/news/history-search-fetch";
import {
  fetchNewsForKeptProfiles,
  newsRunFailures,
  summariseNewsRun,
} from "../lib/news/run";

/**
 * The operator entry point for News. Everything worth testing lives in `lib/news/`; this file
 * is environment in, stdout out, and an exit code.
 *
 * On demand only, like every Source's script: it makes real requests to the feeds in
 * `NEWS_FEEDS` and to Hacker News's search, and writes real rows as the ingest role, none of
 * which belongs in `npm test` or CI. The feeds, and each one's `robots.txt` position, are in
 * `lib/news/feeds.ts`; the search, and why its queries are what they are, is
 * `lib/news/history-search.ts`.
 *
 *     ROLODECK_INGEST_DATABASE_URL=... ROLODECK_OWNER_ID=... npm run ingest:news
 *
 * Exits non-zero when not one feed could be read, or when there was a company to search for and
 * not one search succeeded, saying which. A feed or a search that failed beside one that did not
 * is named in the output, and a run that matched nothing is not a failure. See
 * `newsRunFailures`.
 */
async function main(): Promise<void> {
  // Read before anything is fetched, so a missing owner fails on the first line.
  const ownerId = readOwnerId();

  const report = await fetchNewsForKeptProfiles(await getIngestDb(), {
    ownerId,
    feeds: NEWS_FEEDS,
    client: createNewsFeedClient(),
    search: createHistorySearchClient(),
  });

  console.log(summariseNewsRun(report));

  const failures = newsRunFailures(report);

  if (failures.length > 0) {
    throw new Error(`${failures.join(" ")} See the failures above.`);
  }
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(closeIngestDb);
