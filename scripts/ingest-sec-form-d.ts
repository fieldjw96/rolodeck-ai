import { getDb } from "../db/connection";
import { persistProfiles } from "../db/ingest";
import {
  createEdgarClient,
  fetchCaliforniaFormDProfiles,
} from "../lib/ingest/edgar";
import {
  parseFormDArgs,
  readEdgarContact,
  summariseRun,
  wroteNothing,
} from "../lib/ingest/form-d-run";
import { toProfileProvenance } from "../lib/ingest/scraped-profile";
import { SEC_FORM_D_SOURCE } from "../lib/ingest/sec-form-d";

/**
 * The operator entry point for the SEC Form D Source. Everything worth testing lives in
 * `lib/ingest/`; this file is argv in, stdout out, and an exit code.
 *
 * On demand only. It is not in `npm test` and not in CI: it makes real requests to the SEC,
 * writes real rows under the secret key, and neither belongs in a suite that has to be able to
 * run a hundred times a day.
 *
 *     SEC_EDGAR_CONTACT=you@example.com npm run ingest:sec-form-d
 *     SEC_EDGAR_CONTACT=you@example.com npm run ingest:sec-form-d -- --since 2026-09-01 --limit 50
 *
 * Exits non-zero when the run wrote nothing. A scraper whose selectors have gone stale returns
 * zero rows and reports success, and that silence is the failure this project keeps meeting.
 */
async function main(): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  const options = parseFormDArgs(process.argv.slice(2), today);

  console.log(
    `Fetching Californian Form D filings from ${options.since} to ${options.until}.`,
  );

  const batch = await fetchCaliforniaFormDProfiles(
    createEdgarClient({ contact: readEdgarContact() }),
    options,
  );

  const report = await persistProfiles(getDb(), {
    source: SEC_FORM_D_SOURCE,
    candidates: batch.profiles.map((profile) => ({
      input: profile.input,
      provenance: toProfileProvenance(profile.attribution),
    })),
  });

  console.log(summariseRun(batch, report));

  if (wroteNothing(report)) {
    throw new Error(
      "This run wrote no Profiles at all. Either nothing was filed in the window, or " +
        "the parser has gone stale against a filing that changed shape — check the " +
        "rejections above before believing the first.",
    );
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
