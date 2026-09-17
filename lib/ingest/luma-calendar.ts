import { z } from "zod";

import { parseEventInput, type EventInput } from "../../db/event-input";
import type { IngestRejection } from "../../db/profile-input";
import { issueField } from "../zod/issues";

/**
 * Parses a named Luma calendar page into validated Events.
 *
 * Parsing only: nothing here fetches, and nothing here writes, which is what lets this be
 * tested offline against the captures in `db/fixtures/`. Fetching is `scripts/ingest-events.ts`.
 *
 * Every Luma calendar publishes its upcoming Events the same way — as schema.org JSON-LD: an
 * `ItemList` of `Event`s, each with a name, an ISO start and end, a `Place`, and its
 * `organizer`s. That structured copy is what this reads, rather than the rendered markup,
 * because it is the one Luma publishes for machines to read and so the one least likely to
 * change shape for a redesign. One parser therefore serves every calendar in `LUMA_CALENDARS`;
 * nothing below is specific to any of them.
 *
 * Per CLAUDE.md, scraped data is hostile: the payload crosses a Zod schema on the way in, and
 * one that has changed shape is rejected naming the field.
 */

/**
 * One named Luma calendar: its own Source slug, the page it is read from, and the community
 * whose calendar it is.
 *
 * Each calendar is a Source in its own right rather than a page folded into a shared one, so
 * ADR 0008's identity rules hold per calendar and one going stale cannot be hidden by another
 * succeeding — the same reasoning `lib/ingest/multi-source-run.ts` records for the accelerator
 * batches. `source` doubles as the fixture slug: `db/fixtures/<source>.html` is the committed
 * capture this calendar's parse is tested against.
 */
export type LumaCalendar = {
  readonly source: string;
  readonly url: string;
  /** The community, in its own words on the page. Used in what a run prints. */
  readonly community: string;
};

/**
 * The calendars read, each a real Bay Area community whose Events are hosted by companies, and
 * deliberately not Luma's city discovery pages, search, or anything else that enumerates
 * calendars — those are a general crawl by another name and were rejected on that ground when
 * this Source was one calendar.
 *
 * **The rule for adding a fifth**: a *named* Bay Area calendar whose Events state an `organizer`
 * that is a company. All three clauses do work. Named, because a discovery page is a crawl.
 * Bay Area, because the Deck is Bay Area startups and a calendar of Nairobi meetups states
 * attendance for companies nobody here has Kept. And a company organizer, because Attendance is
 * a Source's own statement (CONTEXT.md), so a calendar whose Events state only people, or only
 * a community that is not a company, states no attendance however many Events it lists.
 *
 * A note on yield, which the rule deliberately does not make a condition: a calendar that
 * curates other people's Events names a different company each time, and one run by a single
 * venue or community names itself over and over. Both are honest statements and both belong
 * here; the first is simply where the attendance comes from.
 *
 * `robots.txt` (`luma.com/robots.txt`), checked with `curl` on 2026-09-17 before any of the
 * captures below: the only group is `User-agent: Googlebot`, disallowing `/social-share`,
 * `/in/`, `/company/` and `/session-*`. There is no `User-agent: *` group, so nothing is
 * disallowed to this project's client, and every path below would be allowed even under
 * Googlebot's rules. Unchanged from the position `scripts/ingest-events.ts` recorded on
 * 2026-09-13.
 *
 * Considered and rejected on the rule above: `luma.com/genai-collective`, The AI Collective, and
 * `luma.com/aihouse`, AI House — both large and both company-hosted, but neither is Bay Area:
 * the first lists Manassas, Nairobi, Harare and Kuala Lumpur, the second is Seattle's Pier 70.
 * `luma.com/agihouse`, `luma.com/aitinkerers`, `luma.com/latentspace` and `luma.com/foundersinc`
 * publish no `ItemList` at all. `luma.com/ycombinator`, `/spc`, `/speedrun`, `/pear`,
 * `/heavybit` and `/devtools` are single Events squatting those slugs rather than calendars.
 */
export const LUMA_CALENDARS: readonly LumaCalendar[] = [
  {
    // The Bay Area chapter of a large in-person AI community, and the calendar this Source
    // started as. The slug is unchanged because rows already carry it.
    source: "luma-bond-ai-sf",
    url: "https://luma.com/genai-sf",
    community: "Bond AI, San Francisco and the Bay Area",
  },
  {
    // "SF Bay Area AI & other startup events worth your attendance", a curated calendar run by
    // Superscout. It lists other people's Events, so its organizers are the companies putting
    // them on — Antler, Conviva, Heavybit, Flower Labs — rather than the curator, which makes
    // it the densest statement of company attendance of the four.
    source: "luma-ai-events-sf",
    url: "https://luma.com/ai-sf",
    community: "AI Events - San Francisco",
  },
  {
    // A community space in Menlo Park that hosts other organisations' Events at 135
    // Constitution Drive. Most Events state the hosting group rather than the venue —
    // Scalekit, the Bay Area Snowflake User Group, TechEquity Ai — which is a company saying
    // it is in a room on a date.
    source: "luma-silicon-valley-ai-hub",
    url: "https://luma.com/svaihub",
    community: "Silicon Valley AI Hub, Menlo Park",
  },
  {
    // "A 16-floor nexus for frontier tech in SF" at 995 Market Street. A company running a
    // building, and the Events it lists are the ones it puts on in that building — hackathons,
    // showcases, open houses — so most state the tower itself and a few state the company that
    // took a floor for the evening. The narrowest of the four by the yield note above, and kept
    // because "Frontier Tower SF hosts this on Saturday" is a statement it made, not one
    // inferred from it.
    source: "luma-frontier-tower-sf",
    url: "https://luma.com/frontiertower",
    community: "Frontier Tower, San Francisco",
  },
];

const LD_JSON_PATTERN =
  /<script\b[^>]*\btype="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g;

/**
 * Loose about everything this parser does not read — geo, images, offers, attendance mode.
 *
 * `address` is either a `PostalAddress` or, as schema.org also allows and Luma also sends, the
 * whole address as one string. A string carries no locality to read, and rejecting an Event over
 * it would lose a real Event for a field this only ever appends to a venue name.
 */
const placeSchema = z.looseObject({
  "@type": z.string(),
  name: z.string().nullish(),
  address: z
    .union([z.string(), z.looseObject({ addressLocality: z.string().nullish() })])
    .nullish(),
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
  const locality =
    typeof place.address === "string"
      ? undefined
      : trimmed(place.address?.addressLocality);

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
 * Parses a whole calendar page: finds the JSON-LD `ItemList`, and turns every listed Event into
 * a validated `EventInput` or a rejection naming its field. The same function for every calendar
 * in `LUMA_CALENDARS`, because Luma publishes them all in one shape.
 *
 * Never throws: a page with no list at all, or with JSON-LD that stopped being JSON, is one
 * rejection rather than an error that aborts the run before it can say why.
 */
export function parseLumaCalendar(html: string): EventBatch {
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
