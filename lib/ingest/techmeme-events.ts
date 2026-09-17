import { z } from "zod";

import { parseEventInput, type EventInput } from "../../db/event-input";
import type { IngestRejection } from "../../db/profile-input";
import { issueField } from "../zod/issues";
import type { EventBatch } from "./luma-calendar";

/**
 * Parses Techmeme's event calendar, as the iCalendar feed it publishes, into validated Events.
 *
 * Parsing only: nothing here fetches, and nothing here writes, which is what lets this be
 * tested offline against the capture in `db/fixtures/`. Fetching is `scripts/ingest-events.ts`.
 *
 * Narrow and trustworthy on purpose: Techmeme's list is hand-maintained by an editorial staff,
 * and the feed is the one Techmeme itself offers for calendar apps — "Add to your calendar" on
 * `techmeme.com/events` — so it is a document meant to be read by software, with a stable
 * `UID` per Event and every date stated in full, where the HTML page drops the year.
 *
 * It states nothing about attendance: every Event from this Source arrives with no attendees,
 * and is still an Event in the Diary.
 *
 * Per CLAUDE.md, scraped data is hostile: each `VEVENT` crosses a Zod schema keyed by its
 * iCalendar property names, so a rejection names the property that stopped it.
 */

export const TECHMEME_EVENTS_SOURCE = "techmeme-events";

/** `YYYYMMDD`, as an iCalendar `DATE` value, to the `YYYY-MM-DD` the rest of the Diary uses. */
const icsDateSchema = z
  .string()
  .regex(/^\d{8}$/, "must be an all-day DATE value, YYYYMMDD")
  .transform(
    (value) => `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6)}`,
  )
  .pipe(z.iso.date());

/**
 * One `VEVENT`'s properties, by name, with their parameters stripped. Loose about everything
 * this parser does not read — `DESCRIPTION`, `X-ALT-DESC`, `SEQUENCE` and the rest.
 *
 * `DTSTART` must be a `DATE`, not a `DATE-TIME`: Techmeme's Events are all-day, and a feed that
 * started sending instants would need a timezone decision this parser should not quietly make.
 */
const veventSchema = z.looseObject({
  UID: z.string(),
  SUMMARY: z.string(),
  DTSTART: icsDateSchema,
  DTEND: icsDateSchema.optional(),
  URL: z.string(),
  LOCATION: z.string().optional(),
  STATUS: z.string().optional(),
});

type Properties = Record<string, string>;

/**
 * RFC 5545 folds a long content line by breaking it with a newline followed by one space or
 * tab. Unfolding is removing exactly that pair, and it has to happen before anything is split
 * into lines — Techmeme folds its URLs mid-word.
 */
const unfold = (ics: string): string[] =>
  ics.replace(/\r?\n[ \t]/g, "").split(/\r?\n/);

/** Undoes the TEXT escaping RFC 5545 applies to commas, semicolons, backslashes and newlines. */
const unescapeText = (value: string): string =>
  value.replace(/\\([\\;,nN])/g, (_match, character: string) =>
    character === "n" || character === "N" ? "\n" : character,
  );

/**
 * The `VEVENT`s in a calendar, as property maps. Nesting is tracked so a `VALARM` inside an
 * event cannot overwrite that event's `DESCRIPTION` or add a `TRIGGER` to it. Where a property
 * repeats, the first one stands.
 */
function veventsOf(lines: readonly string[]): Properties[] {
  const found: Properties[] = [];
  const stack: string[] = [];
  let current: Properties | undefined;

  for (const line of lines) {
    const colon = line.indexOf(":");

    if (colon < 0) {
      continue;
    }

    const name = line.slice(0, colon).split(";")[0]!.toUpperCase();
    const value = line.slice(colon + 1);

    if (name === "BEGIN") {
      stack.push(value.toUpperCase());
      if (value.toUpperCase() === "VEVENT") {
        current = {};
      }
    } else if (name === "END") {
      if (stack.pop() === "VEVENT" && current !== undefined) {
        found.push(current);
        current = undefined;
      }
    } else if (
      current !== undefined &&
      stack.at(-1) === "VEVENT" &&
      !(name in current)
    ) {
      current[name] = value;
    }
  }

  return found;
}

/** A trimmed value, or undefined when the feed held nothing worth carrying. */
function trimmed(value: string | undefined): string | undefined {
  const text = value === undefined ? undefined : unescapeText(value).trim();
  return text === undefined || text.length === 0 ? undefined : text;
}

/**
 * iCalendar's `DTEND` is exclusive: an Event on the 12th and 13th ends on the 14th. The Diary
 * stores the last day an Event actually runs, so one day comes off. Done in UTC, where there is
 * no daylight saving to make a day 23 hours long.
 */
function inclusiveEnd(exclusiveEnd: string): string {
  const [year, month, day] = exclusiveEnd.split("-").map(Number);
  return new Date(Date.UTC(year!, month! - 1, day! - 1))
    .toISOString()
    .slice(0, 10);
}

/**
 * Parses the whole feed into validated Events, and every `VEVENT` it cannot read into a
 * rejection naming the property.
 *
 * Never throws: a response that is not a calendar at all is one rejection naming `VCALENDAR`,
 * rather than an error that aborts the run before it can say why. A `CANCELLED` Event is left
 * out rather than rejected — it is the feed working, not the feed changing shape.
 */
export function parseTechmemeEvents(ics: string): EventBatch {
  const lines = unfold(ics);

  if (!lines.some((line) => line.trim().toUpperCase() === "BEGIN:VCALENDAR")) {
    return {
      events: [],
      rejections: [
        {
          field: "VCALENDAR",
          reason: "the response is not an iCalendar document",
          raw: ics,
        },
      ],
    };
  }

  const events: EventInput[] = [];
  const rejections: IngestRejection[] = [];

  for (const properties of veventsOf(lines)) {
    const parsed = veventSchema.safeParse(properties);

    if (!parsed.success) {
      // A failed safeParse always carries at least one issue.
      const issue = parsed.error.issues[0]!;
      rejections.push({
        field: issueField(issue),
        reason: issue.message,
        raw: properties,
      });
      continue;
    }

    const vevent = parsed.data;

    if (vevent.STATUS?.trim().toUpperCase() === "CANCELLED") {
      continue;
    }

    const input = parseEventInput({
      externalId: trimmed(vevent.UID),
      name: trimmed(vevent.SUMMARY),
      startDate: vevent.DTSTART,
      endDate:
        vevent.DTEND === undefined ? undefined : inclusiveEnd(vevent.DTEND),
      location: trimmed(vevent.LOCATION),
      url: trimmed(vevent.URL),
      attendees: [],
    });

    if (input.success) {
      events.push(input.data);
    } else {
      rejections.push(input.rejection);
    }
  }

  return { events, rejections };
}
