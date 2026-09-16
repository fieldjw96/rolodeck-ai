import { closeIngestDb, getIngestDb } from "../db/ingest-connection";
import { readOwnerId } from "../lib/ingest/env";
import { createNewsFeedClient } from "../lib/news/feed-fetch";
import { NEWS_FEEDS } from "../lib/news/feeds";
import {
  fetchNewsForKeptProfiles,
  newsRunFailed,
  summariseNewsRun,
} from "../lib/news/run";

/**
 * The operator entry point for News. Everything worth testing lives in `lib/news/`; this file
 * is environment in, stdout out, and an exit code.
 *
 * On demand only, like every Source's script: it makes real requests to the feeds in
 * `NEWS_FEEDS` and writes real rows as the ingest role, neither of which belongs in `npm test`
 * or CI. The feeds, and each one's `robots.txt` position, are in `lib/news/feeds.ts`.
 *
 *     ROLODECK_INGEST_DATABASE_URL=... ROLODECK_OWNER_ID=... npm run ingest:news
 *
 * Exits non-zero when not one feed could be read. A feed that failed beside one that was read is
 * named in the output, and a run that matched nothing is not a failure. See `newsRunFailed`.
 */
async function main(): Promise<void> {
  // Read before anything is fetched, so a missing owner fails on the first line.
  const ownerId = readOwnerId();

  const report = await fetchNewsForKeptProfiles(await getIngestDb(), {
    ownerId,
    feeds: NEWS_FEEDS,
    client: createNewsFeedClient(),
  });

  console.log(summariseNewsRun(report));

  if (newsRunFailed(report)) {
    throw new Error(
      `News could not read any of its ${report.feeds.length} ${report.feeds.length === 1 ? "feed" : "feeds"}. ` +
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
