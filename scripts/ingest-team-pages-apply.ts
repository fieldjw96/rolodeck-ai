import { readFile } from "node:fs/promises";
import path from "node:path";

import { closeIngestDb, getIngestDb } from "../db/ingest-connection";
import { recordTeamPageResults } from "../db/team-pages";
import { readOwnerId } from "../lib/ingest/env";
import {
  applyTeamAnswers,
  summariseTeamPagesRun,
  teamPagesRunFailed,
  teamPagesWorkSchema,
} from "../lib/ingest/team-pages-run";
import { teamPagesDirectory } from "./team-pages-directory";

/**
 * Step three of the team-page enrichment: check the model's answers against the pages it was
 * given, and record the run. See docs/adr/0016 and `lib/ingest/team-pages-run.ts`.
 *
 *     ROLODECK_INGEST_DATABASE_URL=... ROLODECK_OWNER_ID=... npm run ingest:team-pages:apply
 *
 * Exits non-zero when every candidate taken failed to fetch. A run that read its whole quota
 * and updated nothing is not a failure: most early companies have no team page.
 */
async function main(): Promise<void> {
  const ownerId = readOwnerId();
  const directory = teamPagesDirectory();

  const { candidates: work } = teamPagesWorkSchema.parse(
    JSON.parse(await readFile(path.join(directory, "work.json"), "utf8")),
  );

  const answers = new Map<string, string>();
  for (const item of work) {
    if (item.outcome !== "read") {
      continue;
    }
    try {
      answers.set(
        item.profileId,
        await readFile(
          path.join(directory, "answers", `${item.profileId}.json`),
          "utf8",
        ),
      );
    } catch {
      // No answer is counted, as `unanswered`, by applyTeamAnswers.
    }
  }

  const { results, report } = applyTeamAnswers(work, answers);
  const { updated } = await recordTeamPageResults(await getIngestDb(), {
    ownerId,
    results,
    at: new Date(),
  });

  console.log(summariseTeamPagesRun(report, updated));

  if (teamPagesRunFailed(report)) {
    throw new Error(
      `Every one of the ${report.taken} candidates failed to fetch. See the reasons above.`,
    );
  }
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(closeIngestDb);
