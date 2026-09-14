import { persistProfiles, type ProfileCandidate } from "../db/ingest";
import { closeIngestDb, getIngestDb } from "../db/ingest-connection";
import {
  parseShowHnPosts,
  showHnSearchResponseSchema,
  toProfileProvenance,
  type Capture,
} from "../lib/ingest/show-hn";

/**
 * Reads today's Show HN posts from Algolia's Hacker News Search API and writes what parses as
 * a company to `profiles`. Live, network-touching, and deliberately not part of `npm test` or
 * CI: `lib/ingest/show-hn.test.ts` covers the parsing offline, against committed fixtures, and
 * this is the one place that actually calls the API and the database.
 *
 *     ROLODECK_INGEST_DATABASE_URL=... ROLODECK_OWNER_ID=... npm run source:show-hn
 *
 * Exits non-zero when nothing new was inserted — a run that finds zero companies HN has not
 * shown this pipeline before is either a quiet day or a source that has changed shape, and
 * either way it should be visible in a Run's own exit code rather than read as a silent no-op.
 */

const ALGOLIA_URL =
  "https://hn.algolia.com/api/v1/search_by_date?tags=show_hn&hitsPerPage=500";

async function fetchShowHnPosts(): Promise<{
  hits: unknown[];
  capture: Capture;
}> {
  const response = await fetch(ALGOLIA_URL);

  if (!response.ok) {
    throw new Error(
      `Algolia returned ${response.status} ${response.statusText}`,
    );
  }

  const body = showHnSearchResponseSchema.parse(await response.json());

  return {
    hits: body.hits,
    capture: {
      query: ALGOLIA_URL,
      // A day, not a timestamp: the same grain the fixtures' `.meta.json` siblings record.
      capturedAt: new Date().toISOString().slice(0, 10),
    },
  };
}

async function main(): Promise<void> {
  const { hits, capture } = await fetchShowHnPosts();
  const batch = parseShowHnPosts(hits, capture);

  const candidates: ProfileCandidate[] = batch.profiles.map((profile) => ({
    input: profile.input,
    provenance: toProfileProvenance(profile.attribution),
  }));

  const report = await persistProfiles(getIngestDb(), {
    source: "show-hn",
    candidates,
  });

  console.log(
    `show-hn: read ${hits.length} post(s), skipped ${batch.rejections.length} not a company or with no confident sector, ` +
      `inserted ${report.inserted}, updated ${report.updated}, rejected ${report.rejected} at the write path.`,
  );

  for (const rejection of batch.rejections) {
    console.log(`  skipped (${rejection.field}): ${rejection.reason}`);
  }

  for (const rejection of report.rejections) {
    console.log(`  rejected (${rejection.field}): ${rejection.reason}`);
  }

  if (report.inserted === 0) {
    throw new Error(
      "Inserted no new Profiles. Either Show HN has nothing new today, or this source has changed shape.",
    );
  }
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(closeIngestDb);
