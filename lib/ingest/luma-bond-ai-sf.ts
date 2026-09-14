import { z } from "zod";

import { parseEventInput, type EventInput } from "../../db/event-input";
import type { IngestRejection } from "../../db/profile-input";
import { issueField } from "../zod/issues";

/**
 * Parses Bond AI's San Francisco and Bay Area calendar on Luma into validated Events.
 *
 * Parsing only: nothing here fetches, and nothing here writes, which is what lets this be
 * tested offline against the capture in `db/fixtures/`. Fetching is `scripts/ingest-events.ts`.
 *
 * Narrow on purpose. This is one named calendar — `luma.com/genai-sf`, the Bay Area chapter
 * of a large in-person AI community — and not Luma's city discovery pages, which are a general
 * crawl by another name. Most of what it lists is hosted by a company, which is what makes it
 * the events Source with something to say about attendance.
 *
 * The page carries its upcoming Events as schema.org JSON-LD: an `ItemList` of `Event`s, each
 * with a name, an ISO start and end, a `Place`, and its `organizer`s. That structured copy is
 * what this reads, rather than the rendered markup, because it is the one Luma publishes for
 * machines to read and so the one least likely to change shape for a redesign.
 *
 * Per CLAUDE.md, scraped data is hostile: the payload crosses a Zod schema on the way in, and
 * one that has changed shape is rejected naming the field.
 */

export const LUMA_BOND_AI_SF_SOURCE = "luma-bond-ai-sf";

const LD_JSON_PATTERN =
  /<script\b[^>]*\btype="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g;

/** Loose about everything this parser does not read — geo, images, offers, attendance mode. */
const placeSchema = z.looseObject({
  "@type": z.string(),
  name: z.string().nullish(),
  address: z.looseObject({ addressLocality: z.string().nullish() }).nullish(),
});

const organizerSchema = z.looseObject({
  "@type": z.string(),
  name: z.string(),
});

const lumaEventSchema = z.looseObject({
  "@type": z.literal("Event"),
  "@id": z.string(),
  url: z.string(),
  name: z.string(),
  startDate: z.iso.datetime({ offset: true }),
  endDate: z.iso.datetime({ offset: true }).nullish(),
  location: placeSchema.nullish(),
  // schema.org allows one organizer or several; Luma sends an array, but a single object is
  // the same statement and not a reason to reject an Event.
  organizer: z.union([organizerSchema, z.array(organizerSchema)]).nullish(),
});

const listItemSchema = z.looseObject({ item: lumaEventSchema });

const itemListSchema = z.looseObject({
  "@type": z.literal("ItemList"),
  itemListElement: z.array(z.unknown()),
});

export type EventBatch = {
  readonly events: readonly EventInput[];
  readonly rejections: readonly IngestRejection[];
};

/** A trimmed value, or undefined when the page held nothing worth carrying. */
function trimmed(value: string | null | undefined): string | undefined {
  const text = value?.trim();
  return text === undefined || text.length === 0 ? undefined : text;
}

/**
 * The calendar date an ISO timestamp names in its own offset. Luma states every time with the
 * Event's local offset (`2026-09-15T17:00:00.000-07:00`), so the first ten characters are the
 * day a person in the room would call it — converting to UTC first would move an evening
 * meetup onto the next day.
 */
const localDate = (timestamp: string): string => timestamp.slice(0, 10);

/**
 * Where, in words. A `Place` names either a venue ("Exploratorium") or an obfuscated area
 * ("San Francisco, CA") — Luma hides the address of an Event until someone registers — and the
 * locality is added only where the name does not already carry it.
 */
function locationOf(
  place: z.infer<typeof placeSchema> | null | undefined,
): string | undefined {
  if (place === null || place === undefined) {
    return undefined;
  }

  if (place["@type"] === "VirtualLocation") {
    return "Online";
  }

  const name = trimmed(place.name);
  const locality = trimmed(place.address?.addressLocality);

  if (name === undefined) {
    return locality;
  }

  return locality === undefined || name.includes(locality)
    ? name
    : `${name}, ${locality}`;
}

/**
 * The companies the page states are hosting. Only `Organization` organizers count: a `Person`
 * hosting is not a company attending, and naming their employer would be exactly the inference
 * the Ticket rules out. A hosting organisation that is not a Company Profile in the Deck —
 * a community, a meetup brand — simply matches nothing at ingest.
 */
function attendeesOf(event: z.infer<typeof lumaEventSchema>): string[] {
  const organizers =
    event.organizer === null || event.organizer === undefined
      ? []
      : [event.organizer].flat();

  const names = organizers
    .filter((organizer) => organizer["@type"] === "Organization")
    .map((organizer) => trimmed(organizer.name))
    .filter((name) => name !== undefined);

  return [...new Set(names)];
}

function rejectedBatch(
  field: string,
  reason: string,
  raw: unknown,
): EventBatch {
  return { events: [], rejections: [{ field, reason, raw }] };
}

/**
 * Parses the whole calendar page: finds the JSON-LD `ItemList`, and turns every listed Event
 * into a validated `EventInput` or a rejection naming its field.
 *
 * Never throws: a page with no list at all, or with JSON-LD that stopped being JSON, is one
 * rejection rather than an error that aborts the run before it can say why.
 */
export function parseLumaBondAiSf(html: string): EventBatch {
  let list: z.infer<typeof itemListSchema> | undefined;

  for (const match of html.matchAll(LD_JSON_PATTERN)) {
    let payload: unknown;
    try {
      payload = JSON.parse(match[1]!);
    } catch {
      return rejectedBatch(
        "ld+json",
        "an embedded JSON-LD block was not valid JSON",
        match[1],
      );
    }

    // The page carries other JSON-LD too — the calendar's own `Organization` — which is not
    // what this reads and not a reason to stop.
    if (
      typeof payload !== "object" ||
      payload === null ||
      (payload as Record<string, unknown>)["@type"] !== "ItemList"
    ) {
      continue;
    }

    const parsed = itemListSchema.safeParse(payload);

    if (!parsed.success) {
      // A failed safeParse always carries at least one issue.
      const issue = parsed.error.issues[0]!;
      return rejectedBatch(issueField(issue), issue.message, payload);
    }

    list = parsed.data;
    break;
  }

  if (list === undefined) {
    return rejectedBatch(
      "ItemList",
      "no JSON-LD ItemList of Events found in the page",
      html,
    );
  }

  const events: EventInput[] = [];
  const rejections: IngestRejection[] = [];

  list.itemListElement.forEach((element, index) => {
    const parsed = listItemSchema.safeParse(element);

    if (!parsed.success) {
      const issue = parsed.error.issues[0]!;
      rejections.push({
        field: `itemListElement.${index}.${issueField(issue)}`,
        reason: issue.message,
        raw: element,
      });
      return;
    }

    const event = parsed.data.item;
    const input = parseEventInput({
      externalId: trimmed(event["@id"]),
      name: trimmed(event.name),
      startDate: localDate(event.startDate),
      endDate:
        event.endDate === null || event.endDate === undefined
          ? undefined
          : localDate(event.endDate),
      location: locationOf(event.location),
      url: trimmed(event.url),
      attendees: attendeesOf(event),
    });

    if (input.success) {
      events.push(input.data);
    } else {
      rejections.push(input.rejection);
    }
  });

  return { events, rejections };
}
