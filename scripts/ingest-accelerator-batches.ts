import { persistProfiles, type IngestReport } from "../db/ingest";
import { closeIngestDb, getIngestDb } from "../db/ingest-connection";
import type { IngestRejection, ProfileInput } from "../db/profile-input";
import { createAcceleratorClient } from "../lib/ingest/accelerator-fetch";
import {
  ANGELPAD_SOURCE,
  parseAngelPadPortfolio,
} from "../lib/ingest/angelpad";
import {
  toProfileProvenance,
  type ProfileAttribution,
} from "../lib/ingest/scraped-profile";
import {
  parseSouthParkCommonsCompanies,
  SOUTH_PARK_COMMONS_SOURCE,
} from "../lib/ingest/south-park-commons";

/**
 * The operator entry point for the two accelerator batch pages Ticket #50 kept. Everything
 * worth testing lives in `lib/ingest/`; this file is argv in, stdout out, and an exit code —
 * the same split `scripts/ingest-sec-form-d.ts` makes.
 *
 * On demand only. It is not in `npm test` and not in CI: it makes real requests to two live
 * sites and writes real rows as the ingest role.
 *
 *     ROLODECK_INGEST_DATABASE_URL=... ROLODECK_OWNER_ID=... npm run ingest:accelerators
 *
 * `robots.txt`, checked before any fixture was captured:
 *
 * - South Park Commons: `Allow: /`, and `/companies/` is not one of the paths it disallows
 *   (`/investor-newsletter/`, `/members`, `/summer-26-demo-faire`, `/s26-demo-faire`,
 *   `/shareyourstory`, `/new-york`, `/san-francisco`). Note `/s26-demo-faire` is disallowed —
 *   South Park Commons does run a page that lists one batch by name, and this Source
 *   deliberately does not fetch it.
 * - AngelPad: `Disallow:` (empty) for every client but `AhrefsBot`, which is refused
 *   entirely. `/portfolio/` is unrestricted.
 * - HF0 and Alchemist: see below — both were dropped before their `robots.txt` mattered.
 *
 * HF0 and Alchemist are not here. HF0 publishes no company roster anywhere on its site — its
 * only pages are `/`, `/facts`, `/team`, `/thesis` and `/apply`, and `/facts` states aggregate
 * metrics per batch and never a company's name. Alchemist's portfolio page ships its grid
 * empty, with an HTML comment on the container reading "Items will be populated via
 * JavaScript" — client-rendered, exactly the Ticket's `ycombinator.com/companies` case, and its
 * only other pages (the flagship program page, the home page) are marketing copy and FAQs with
 * no company list at all. Both are dropped and named here rather than shipping a parser that
 * returns nothing and reports fine.
 *
 * Known limitation: a company already present under `sec-form-d` or `show-hn` is not matched
 * here. `persistProfiles`'s natural key is `(owner_id, source, name_key)` — `source` is part
 * of the key by design (docs/adr/0008), specifically so two Sources describing the same
 * company do not collide and silently overwrite each other's `sector`, `stage` and
 * provenance. That ADR names the resulting cost directly: "a company found by two Sources is
 * two cards in the Deck until some later Ticket takes that on." Reconciling two Sources'
 * accounts of one company is entity resolution — it needs a rule for which field wins — and
 * ADR 0008 is explicit that this is not a thing to decide inside a single source's write path.
 * This Source is exactly the overlap case: South Park Commons and AngelPad both pick from
 * companies that may already have a `sec-form-d` or `show-hn` Profile, and running this script
 * deals the Deck a second card for those. Left for the later Ticket ADR 0008 already points to,
 * not solved here.
 *
 * Exits non-zero when the run wrote nothing at all, across both sources. A scraper whose
 * selectors have gone stale returns zero rows and reports success, and that silence is the
 * failure this project keeps meeting.
 */

type Batch = {
  readonly source: string;
  readonly url: string;
  readonly parse: (
    html: string,
    capture: { sourceUrl: string; capturedAt: string },
  ) => {
    readonly profiles: readonly {
      readonly input: ProfileInput;
      readonly attribution: ProfileAttribution;
    }[];
    readonly rejections: readonly IngestRejection[];
  };
};

const BATCHES: readonly Batch[] = [
  {
    source: SOUTH_PARK_COMMONS_SOURCE,
    url: "https://www.southparkcommons.com/companies/",
    parse: parseSouthParkCommonsCompanies,
  },
  {
    source: ANGELPAD_SOURCE,
    url: "https://angelpad.com/portfolio/",
    parse: parseAngelPadPortfolio,
  },
];

function summarise(
  source: string,
  parsedRejections: readonly IngestRejection[],
  report: IngestReport,
): string {
  const lines = [
    `${source}: wrote ${report.inserted} new Profiles and updated ${report.updated}.`,
  ];

  for (const rejection of [...parsedRejections, ...report.rejections]) {
    lines.push(`  rejected on ${rejection.field}: ${rejection.reason}`);
  }

  return lines.join("\n");
}

async function main(): Promise<void> {
  const client = createAcceleratorClient();
  const db = await getIngestDb();
  const capturedAt = new Date().toISOString().slice(0, 10);

  let totalWritten = 0;

  for (const batch of BATCHES) {
    const page = await client.get(batch.url);
    const parsed = batch.parse(page.html, {
      sourceUrl: page.sourceUrl,
      capturedAt,
    });

    const report = await persistProfiles(db, {
      source: batch.source,
      candidates: parsed.profiles.map((profile) => ({
        input: profile.input,
        provenance: toProfileProvenance(profile.attribution),
      })),
    });

    console.log(summarise(batch.source, parsed.rejections, report));
    totalWritten += report.inserted + report.updated;
  }

  if (totalWritten === 0) {
    throw new Error(
      "This run wrote no Profiles at all, across every accelerator batch page. Either " +
        "both pages changed shape, or something upstream is down — check the rejections " +
        "above before believing either page is simply empty.",
    );
  }
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(closeIngestDb);
