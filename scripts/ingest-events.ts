import { persistEvents, type EventIngestReport } from "../db/events";
import { closeIngestDb, getIngestDb } from "../db/ingest-connection";
import type { IngestRejection } from "../db/profile-input";
import { createAcceleratorClient } from "../lib/ingest/accelerator-fetch";
import {
  LUMA_BOND_AI_SF_SOURCE,
  parseLumaBondAiSf,
  type EventBatch,
} from "../lib/ingest/luma-bond-ai-sf";
import {
  parseTechmemeEvents,
  TECHMEME_EVENTS_SOURCE,
} from "../lib/ingest/techmeme-events";

/**
 * The operator entry point for the Diary's two events Sources. Everything worth testing lives
 * in `lib/ingest/` and `db/events.ts`; this file is fetch, parse, persist, and an exit code —
 * the same split `scripts/ingest-accelerator-batches.ts` makes.
 *
 * On demand only. It is not in `npm test` and not in CI: it makes real requests to two live
 * sites and writes real rows as the ingest role.
 *
 *     ROLODECK_INGEST_DATABASE_URL=... ROLODECK_OWNER_ID=... npm run ingest:events
 *
 * Requests go through `createAcceleratorClient`, which is this repo's one polite outbound
 * client rather than anything accelerator-specific: every request waits on
 * `lib/ingest/throttle.ts` at one a second per host, and carries the `User-Agent` naming this
 * project that the accelerator Sources send. Neither site below requires one.
 *
 * `robots.txt`, checked with `curl` on 2026-09-13 before either fixture was captured:
 *
 * - Techmeme (`www.techmeme.com/robots.txt`): `User-agent: *` disallows `/r2/`, `/r/`,
 *   `/goto/`, `/gotos/`, `/igoto/`, `/igotos/`, `/do/`, `/search/`, `/timeline/`, `/track/` and
 *   `/*.jpg`. `/events.ics` is none of them. Each Event's `URL` is a `/r2/` redirect, which this
 *   script never requests: it is stored as the link a person follows from the Diary.
 * - Luma (`luma.com/robots.txt`): the only group is `User-agent: Googlebot`, disallowing
 *   `/social-share`, `/in/`, `/company/` and `/session-*`. There is no `User-agent: *` group,
 *   so nothing is disallowed to this client, and `/genai-sf` would be allowed even under
 *   Googlebot's rules.
 *
 * Considered and dropped: Berkeley SkyDeck's Demo Day pages, which state exactly which
 * companies present — real attendance — but never state the date of the Demo Day itself, so
 * there is no `start_date` to give an Event. Luma's other named calendars (`/ycombinator`,
 * `/spc`, `/speedrun`) turned out to be single unrelated Events squatting those slugs.
 *
 * Attendance only links to Company Profiles already in the Deck, so run the Profile Sources
 * first. An Event whose hosts match nothing is still written; its attendances fill in the next
 * time this runs after those companies arrive.
 *
 * Exits non-zero when the run wrote no Events at all, across both Sources: a feed whose shape
 * has drifted returns nothing and reports success, and that silence is the failure this project
 * keeps meeting.
 */

type Source = {
  readonly source: string;
  readonly url: string;
  readonly parse: (text: string) => EventBatch;
};

const SOURCES: readonly Source[] = [
  {
    source: TECHMEME_EVENTS_SOURCE,
    url: "https://www.techmeme.com/events.ics",
    parse: parseTechmemeEvents,
  },
  {
    source: LUMA_BOND_AI_SF_SOURCE,
    url: "https://luma.com/genai-sf",
    parse: parseLumaBondAiSf,
  },
];

function summarise(
  source: string,
  parsedRejections: readonly IngestRejection[],
  report: EventIngestReport,
): string {
  const lines = [
    `${source}: wrote ${report.inserted} new Events and updated ${report.updated}, ` +
      `linking ${report.attendances} attendances.`,
  ];

  for (const rejection of [...parsedRejections, ...report.rejections]) {
    lines.push(`  rejected on ${rejection.field}: ${rejection.reason}`);
  }

  return lines.join("\n");
}

async function main(): Promise<void> {
  const client = createAcceleratorClient();
  const db = getIngestDb();

  let totalWritten = 0;

  for (const { source, url, parse } of SOURCES) {
    const page = await client.get(url);
    const parsed = parse(page.html);

    const report = await persistEvents(db, { source, events: parsed.events });

    console.log(summarise(source, parsed.rejections, report));
    totalWritten += report.inserted + report.updated;
  }

  if (totalWritten === 0) {
    throw new Error(
      "This run wrote no Events at all, across every events Source. Either both feeds " +
        "changed shape, or something upstream is down — check the rejections above before " +
        "believing either calendar is simply empty.",
    );
  }
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(closeIngestDb);
