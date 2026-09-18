import type { EventInput } from "../../db/event-input";
import type { EventIngestReport } from "../../db/events";
import type { IngestRejection } from "../../db/profile-input";

/**
 * Everything `scripts/ingest-events.ts` does that is worth testing, the way `form-d-run.ts` and
 * `yc-run.ts` hold the testable half of their own scripts. The script itself is fetch, persist,
 * print, and an exit code.
 *
 * What a run has to be able to say, per Source rather than in total: whether a Source stated any
 * company as hosting at all, and whether the names it stated matched anything in the Deck. Those
 * are different failures with the same total. A Source stating no hosts has drifted or lists
 * conferences rather than company events; a Source stating plenty and linking none is working
 * exactly as intended and simply ahead of the Deck, and its attendances fill in the next run
 * after those companies arrive.
 */

/** What one events Source did in a run: what it stated, and what that wrote. */
export type EventSourceResult = {
  readonly source: string;
  /** The Events that parsed. */
  readonly events: readonly EventInput[];
  /** Rejections from parsing, before `persistEvents` adds its own. */
  readonly rejections: readonly IngestRejection[];
  readonly report: EventIngestReport;
};

/** How many of a Source's Events name at least one hosting company. */
export function eventsStatingAHost(events: readonly EventInput[]): number {
  return events.filter((event) => event.attendees.length > 0).length;
}

/**
 * How many distinct companies a Source named as hosting across the whole run. Distinct, because
 * this is the question the Ticket's measurement asks — how much a calendar has to say about
 * attendance — and a venue's calendar naming itself over thirty Events has said one thing once.
 */
export function companiesStated(events: readonly EventInput[]): number {
  return new Set(events.flatMap((event) => event.attendees)).size;
}

/**
 * A Source that returned nothing, as a rejection naming it. A calendar whose JSON-LD changed
 * shape already rejects naming its field; this covers the other way a Source goes quiet, where
 * the page parses cleanly and simply lists no Events.
 */
export function noEventsRejection(
  source: string,
  url: string,
): IngestRejection {
  return {
    field: source,
    reason: `${source} parsed cleanly but listed no Events at all`,
    raw: url,
  };
}

/**
 * A Source whose fetch, parse or write threw, as a rejection naming it. One Source being down
 * is not a reason to skip the rest of the run, so the loop records this and carries on; the
 * exit code is settled at the end.
 *
 * "Failed" rather than "could not be fetched" because this covers the write too: a Source whose
 * page arrived and whose rows would not go in has still not ingested anything this run.
 */
export function failedSourceRejection(
  source: string,
  error: unknown,
): IngestRejection {
  return {
    field: source,
    reason: `${source} failed this run: ${
      error instanceof Error ? error.message : String(error)
    }`,
    raw: error,
  };
}

/**
 * The error message for a run where at least one Source threw, kept apart from
 * `describeEmptySources` because "wrote no Events" and "threw" are different things and a run
 * that hit both should say both.
 */
export function describeFailedSources(
  failures: readonly IngestRejection[],
): string {
  return (
    `${failures.map((failure) => failure.field).join(", ")} failed this run. ` +
    "The other Sources ran; see the reasons above."
  );
}

/**
 * What one Source did, in lines a person reading the run's output can act on. Attendance is
 * reported per Source, never only as a run total, so the two ways of linking nothing stay
 * distinguishable.
 */
export function summariseEventSource({
  source,
  events,
  rejections,
  report,
}: EventSourceResult): string {
  const stated = companiesStated(events);

  const lines = [
    `${source}: wrote ${report.inserted} new Events and updated ${report.updated}, ` +
      `linking ${report.attendances} attendances.`,
    `  ${eventsStatingAHost(events)} of ${events.length} Events state a hosting ` +
      `company, naming ${stated} distinct companies between them.`,
  ];

  if (stated === 0) {
    lines.push(
      "  states no hosting company at all, so it can link no attendance: either its " +
        "organizers stopped being read, or it lists events no company hosts.",
    );
  } else if (report.attendances === 0) {
    lines.push(
      "  states hosting companies, but none of them is a Company Profile in the Deck yet.",
    );
  }

  for (const rejection of [...rejections, ...report.rejections]) {
    lines.push(`  rejected on ${rejection.field}: ${rejection.reason}`);
  }

  return lines.join("\n");
}
