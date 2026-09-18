import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { closeIngestDb, getIngestDb } from "../db/ingest-connection";
import { selectTeamPageCandidates } from "../db/team-pages";
import { readOwnerId } from "../lib/ingest/env";
import { createTeamSiteClient } from "../lib/ingest/team-page-fetch";
import {
  gatherTeamPages,
  TEAM_PAGE_CANDIDATES_PER_RUN,
  teamPagePrompt,
} from "../lib/ingest/team-pages-run";
import { teamPagesDirectory } from "./team-pages-directory";

/**
 * Step one of the team-page enrichment: choose the candidates and read their sites. See
 * docs/adr/0016 and `lib/ingest/team-pages-run.ts`.
 *
 * Writes nothing to the database. It leaves, under `TEAM_PAGES_DIR`:
 *
 * - `work.json`, what was read for every candidate, which `ingest-team-pages-apply.ts` reads;
 * - `pages/<profile id>.txt`, one per company whose site could be read, for the model;
 * - an empty `answers/`, where the model writes `<profile id>.json`.
 *
 *     ROLODECK_INGEST_DATABASE_URL=... ROLODECK_OWNER_ID=... npm run ingest:team-pages:gather
 */
async function main(): Promise<void> {
  const ownerId = readOwnerId();
  const directory = teamPagesDirectory();

  const candidates = await selectTeamPageCandidates(await getIngestDb(), {
    ownerId,
    limit: TEAM_PAGE_CANDIDATES_PER_RUN,
  });
  // Nothing more to ask the database, and reading sites takes minutes.
  await closeIngestDb();

  const work = await gatherTeamPages(candidates, createTeamSiteClient());

  await rm(directory, { recursive: true, force: true });
  await mkdir(path.join(directory, "pages"), { recursive: true });
  await mkdir(path.join(directory, "answers"), { recursive: true });

  await writeFile(
    path.join(directory, "work.json"),
    JSON.stringify({ candidates: work }),
  );

  const read = work.filter((item) => item.outcome === "read");
  for (const item of read) {
    await writeFile(
      path.join(directory, "pages", `${item.profileId}.txt`),
      teamPagePrompt(item),
    );
  }

  console.log(
    `Team pages: ${candidates.length} candidates taken; ${read.length} sites read and written for the model.`,
  );
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(closeIngestDb);
