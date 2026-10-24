import { closeIngestDb, getIngestDb } from "../db/ingest-connection";
import { describeFailure } from "../lib/ingest/driver-error";
import { createNewsFeedClient } from "../lib/news/feed-fetch";
import { NEWS_FEEDS } from "../lib/news/feeds";
import { createHistorySearchClient } from "../lib/news/history-search-fetch";
import {
  fetchNewsForTheCatalogue,
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
 *     ROLODECK_INGEST_DATABASE_URL=... npm run ingest:news
 *
 * One credential and no other environment: News gathers for the whole Catalogue, so there is no
 * User for it to be told about. The variable that named one is gone — see docs/adr/0022.
 *
 * Exits non-zero when not one feed could be read, or when there was a Company Profile to search
 * for and not one search succeeded, saying which. A feed or a search that failed beside one that
 * did not is named in the output, and a run that matched nothing is not a failure. See
 * `newsRunFailures`.
 */
async function main(): Promise<void> {
  const report = await fetchNewsForTheCatalogue(await getIngestDb(), {
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
    console.error(describeFailure(error));
    process.exitCode = 1;
  })
  .finally(closeIngestDb);
