import { persistEvents } from "../db/events";
import { closeIngestDb, getIngestDb } from "../db/ingest-connection";
import type { IngestRejection } from "../db/profile-input";
import { createAcceleratorClient } from "../lib/ingest/accelerator-fetch";
import {
  failedSourceRejection,
  noEventsRejection,
  summariseEventSource,
} from "../lib/ingest/events-run";
import {
  LUMA_CALENDARS,
  parseLumaCalendar,
  type EventBatch,
} from "../lib/ingest/luma-calendar";
import {
  describeEmptySources,
  emptySources,
  type SourceRun,
} from "../lib/ingest/multi-source-run";
import {
  parseTechmemeEvents,
  TECHMEME_EVENTS_SOURCE,
} from "../lib/ingest/techmeme-events";

/**
 * The operator entry point for the Diary's events Sources: Techmeme's conference feed and the
 * named Luma calendars in `LUMA_CALENDARS`. Everything worth testing lives in `lib/ingest/` and
 * `db/events.ts`; this file is fetch, parse, persist, and an exit code — the same split
 * `scripts/ingest-accelerator-batches.ts` makes.
 *
 * On demand only. It is not in `npm test` and not in CI: it makes real requests to live sites
 * and writes real rows as the ingest role.
 *
 *     ROLODECK_INGEST_DATABASE_URL=... ROLODECK_OWNER_ID=... npm run ingest:events
 *
 * Requests go through `createAcceleratorClient`, which is this repo's one polite outbound
 * client rather than anything accelerator-specific: every request waits on
 * `lib/ingest/throttle.ts` at one a second per host, and carries the `User-Agent` naming this
 * project that the accelerator Sources send. Every Luma calendar is the same host, so reading
 * four of them is four requests a second apart rather than four at once. No site below requires
 * a `User-Agent`.
 *
 * `robots.txt`, checked with `curl` on 2026-09-13 before either original fixture was captured:
 *
 * - Techmeme (`www.techmeme.com/robots.txt`): `User-agent: *` disallows `/r2/`, `/r/`,
 *   `/goto/`, `/gotos/`, `/igoto/`, `/igotos/`, `/do/`, `/search/`, `/timeline/`, `/track/` and
 *   `/*.jpg`. `/events.ics` is none of them. Each Event's `URL` is a `/r2/` redirect, which this
 *   script never requests: it is stored as the link a person follows from the Diary.
 * - Luma (`luma.com/robots.txt`): the only group is `User-agent: Googlebot`, disallowing
 *   `/social-share`, `/in/`, `/company/` and `/session-*`. There is no `User-agent: *` group,
 *   so nothing is disallowed to this client, and `/genai-sf` would be allowed even under
 *   Googlebot's rules. Re-checked unchanged on 2026-09-17 for the three calendars added then;
 *   `lib/ingest/luma-calendar.ts` records that check beside the calendars it covers.
 *
 * Considered and dropped: Berkeley SkyDeck's Demo Day pages, which state exactly which
 * companies present — real attendance — but never state the date of the Demo Day itself, so
 * there is no `start_date` to give an Event. Which Luma calendars are read, why each one, and
 * the rule for adding another are in `lib/ingest/luma-calendar.ts` rather than here.
 *
 * Attendance only links to Company Profiles already in the Deck, so run the Profile Sources
 * first. An Event whose hosts match nothing is still written; its attendances fill in the next
 * time this runs after those companies arrive.
 *
 * One Source failing does not stop the others: a calendar that cannot be fetched, or whose
 * JSON-LD has changed shape, is a rejection naming it and the loop carries on. Exits non-zero
 * when any Source wrote no Events, even if the others wrote rows: a feed whose shape has drifted
 * returns nothing and reports success, and summing every Source's counts before checking would
 * let a healthy Techmeme hide four dead calendars. See `lib/ingest/multi-source-run.ts`.
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
  ...LUMA_CALENDARS.map(({ source, url }) => ({
    source,
    url,
    parse: parseLumaCalendar,
  })),
];

async function main(): Promise<void> {
  const client = createAcceleratorClient();
  const db = await getIngestDb();

  const runs: SourceRun[] = [];
  const failures: IngestRejection[] = [];

  for (const { source, url, parse } of SOURCES) {
    try {
      const page = await client.get(url);
      const parsed = parse(page.html);

      const rejections =
        parsed.events.length === 0
          ? [...parsed.rejections, noEventsRejection(source, url)]
          : parsed.rejections;

      const report = await persistEvents(db, { source, events: parsed.events });

      console.log(
        summariseEventSource({
          source,
          events: parsed.events,
          rejections,
          report,
        }),
      );
      runs.push({ source, report });
    } catch (error: unknown) {
      const rejection = failedSourceRejection(source, error);
      console.error(`  rejected on ${rejection.field}: ${rejection.reason}`);
      failures.push(rejection);
    }
  }

  const empty = [
    ...emptySources(runs),
    ...failures.map((rejection) => rejection.field),
  ];

  if (empty.length > 0) {
    throw new Error(describeEmptySources(empty, "Events"));
  }
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(closeIngestDb);
