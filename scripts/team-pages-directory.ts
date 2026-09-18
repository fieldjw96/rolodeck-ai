import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Where the team-page enrichment's three steps hand work to one another. The workflow sets
 * `TEAM_PAGES_DIR` so the model step can be told the same path; a local run defaults to the
 * system's temporary directory.
 */
export function teamPagesDirectory(): string {
  return (
    process.env.TEAM_PAGES_DIR ?? path.join(tmpdir(), "rolodeck-team-pages")
  );
}
