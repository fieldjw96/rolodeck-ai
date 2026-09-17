// @vitest-environment node
import { beforeAll, describe, expect, it } from "vitest";

import { eventInputSchema } from "../../db/event-input";
import { sourceSchema } from "../../db/ingest";
import {
  readEventSourceFixture,
  type EventSourceFixture,
} from "../testing/fixtures";
import { LUMA_CALENDARS, parseLumaCalendar } from "./luma-calendar";

/**
 * Every fixture under `db/fixtures/luma-*.html` was captured with `curl` from the URL its
 * `.meta.json` sibling records, and is committed byte-for-byte. Luma's `robots.txt` does not
 * disallow any of them — see the header of `luma-calendar.ts`.
 *
 * The captures are keyed by Source slug, so the loop below covers a calendar added tomorrow
 * without anyone remembering to add a test for it.
 */
const captures = new Map<string, EventSourceFixture>();

beforeAll(async () => {
  for (const calendar of LUMA_CALENDARS) {
    captures.set(
      calendar.source,
      await readEventSourceFixture(calendar.source, "html"),
    );
  }
});

/** The capture committed for one calendar, read in `beforeAll`. */
const captureOf = (source: string): EventSourceFixture => {
  const capture = captures.get(source);
  if (capture === undefined) {
    throw new Error(`no capture read for ${source}`);
  }
  return capture;
};

const bondAiSf = () => parseLumaCalendar(captureOf("luma-bond-ai-sf").text);

describe("LUMA_CALENDARS", () => {
  it("reads at least the four named calendars this Source is", () => {
    expect(LUMA_CALENDARS.length).toBeGreaterThanOrEqual(4);
  });

  it("gives every calendar a Source slug persistEvents will accept", () => {
    for (const { source } of LUMA_CALENDARS) {
      expect(sourceSchema.safeParse(source).success).toBe(true);
    }
  });

  it("gives every calendar its own slug, so one going stale cannot hide", () => {
    const slugs = LUMA_CALENDARS.map((calendar) => calendar.source);

    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it("keeps the slug rows already carry, pointing at the calendar it was", () => {
    // Per ADR 0008, the slug is part of an Event's identity: changing it would orphan every row
    // this Source has already written rather than update it.
    expect(
      LUMA_CALENDARS.find(
        (calendar) => calendar.source === "luma-bond-ai-sf",
      )?.url,
    ).toBe("https://luma.com/genai-sf");
  });

  it("reads a luma.com path and nothing that enumerates calendars", () => {
    for (const { url } of LUMA_CALENDARS) {
      const { origin, pathname } = new URL(url);

      expect(origin).toBe("https://luma.com");
      // A named calendar is one path segment. Luma's discovery pages live under `/sf`, `/discover`
      // and `/search`, which the header rejects as a general crawl by another name.
      expect(pathname).toMatch(/^\/[A-Za-z0-9][A-Za-z0-9-]*$/);
      expect(pathname).not.toMatch(/^\/(?:discover|search|sf|explore)$/);
    }
  });

  it("records the URL it was captured from against every calendar", () => {
    for (const { source, url } of LUMA_CALENDARS) {
      expect(captureOf(source).capture.sourceUrl).toBe(url);
      expect(captureOf(source).capture.capturedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
});

describe("parseLumaCalendar, against every committed capture", () => {
  it.each(LUMA_CALENDARS.map((calendar) => calendar.source))(
    "reads %s without rejecting anything",
    (source) => {
      const batch = parseLumaCalendar(captureOf(source).text);

      expect(batch.rejections).toEqual([]);
      expect(batch.events.length).toBeGreaterThan(0);

      for (const event of batch.events) {
        expect(eventInputSchema.safeParse(event).success).toBe(true);
      }
    },
  );

  it.each(LUMA_CALENDARS.map((calendar) => calendar.source))(
    "finds at least one Event on %s stating a company as hosting",
    (source) => {
      const { events } = parseLumaCalendar(captureOf(source).text);

      expect(
        events.filter((event) => event.attendees.length > 0).length,
      ).toBeGreaterThan(0);
    },
  );
});

describe("parseLumaCalendar, against the Bond AI capture", () => {
  it("turns the JSON-LD ItemList into validated Events", () => {
    const batch = bondAiSf();

    expect(batch.rejections).toEqual([]);
    expect(batch.events).toHaveLength(20);

    for (const event of batch.events) {
      expect(eventInputSchema.safeParse(event).success).toBe(true);
    }
  });

  it("reads an Event's name, dates, venue, link and hosting company", () => {
    const { events } = bondAiSf();

    expect(
      events.find((event) => event.url === "https://luma.com/7a4iutvp"),
    ).toEqual({
      externalId: "https://luma.com/7a4iutvp",
      name: "AI Security Hackathon - By Hackathons.team",
      startDate: "2026-09-13",
      endDate: "2026-09-13",
      location: "501 Folsom St, San Francisco",
      url: "https://luma.com/7a4iutvp",
      attendees: ["Wasmer"],
    });
  });

  it("keeps an evening Event on the day it happens locally, not the day it is in UTC", () => {
    const { events } = bondAiSf();

    // 17:00 at -07:00 is midnight UTC on the 16th.
    const tasting = events.find((event) =>
      event.name.startsWith("The Tasting Menu"),
    );

    expect(tasting?.startDate).toBe("2026-09-15");
  });

  it("names a hosting Organization as attending, and never a hosting Person", () => {
    const { events } = bondAiSf();

    // Hosted by The Multimodal Society and by two people, who are not companies.
    const filmmaking = events.find(
      (event) => event.name === "AI Filmmaking Masterclass + Hackathon",
    );

    expect(filmmaking?.attendees).toEqual(["The Multimodal Society"]);
    expect(filmmaking?.location).toBe("San Francisco, CA");
  });

  it("states no attendees for an Event no organisation hosts", () => {
    const { events } = bondAiSf();

    const mapbox = events.find((event) =>
      event.name.startsWith("Mapbox Happy Hour"),
    );

    expect(mapbox).toBeDefined();
    expect(mapbox?.attendees).toEqual([]);
  });
});

describe("parseLumaCalendar, against the calendars added for the Diary", () => {
  it("reads a curated calendar's Event as hosted by the company putting it on", () => {
    const { events } = parseLumaCalendar(captureOf("luma-ai-events-sf").text);

    // The calendar is curated by Superscout and lists other people's Events, so the organizer
    // is the company in the room rather than the curator.
    expect(
      events.find((event) => event.url === "https://luma.com/gtmgg065"),
    ).toEqual({
      externalId: "https://luma.com/gtmgg065",
      name: "How do you know your agent works when it scales beyond 1K sessions?",
      startDate: "2026-09-24",
      endDate: "2026-09-24",
      location: "Foster City, CA",
      url: "https://luma.com/gtmgg065",
      attendees: ["Conviva"],
    });
  });

  it("reads a venue calendar's Event as hosted by the visiting company", () => {
    const { events } = parseLumaCalendar(
      captureOf("luma-silicon-valley-ai-hub").text,
    );

    expect(
      events.find((event) => event.url === "https://luma.com/p7v901j3"),
    ).toEqual({
      externalId: "https://luma.com/p7v901j3",
      name: "Agents in Production: DevTools demo night",
      startDate: "2026-10-21",
      endDate: "2026-10-21",
      location: "Menlo Park, CA",
      url: "https://luma.com/p7v901j3",
      attendees: ["Scalekit"],
    });
  });

  it("keeps an Event whose address Luma states as one string, not a PostalAddress", () => {
    const { events } = parseLumaCalendar(
      captureOf("luma-silicon-valley-ai-hub").text,
    );

    // schema.org allows `address` as text, and Luma sends it that way for an Event whose venue
    // was typed rather than picked. There is no locality to append, so the venue name stands.
    const frenchTech = events.find(
      (event) => event.name === "French Tech SF Fall Kick-Off at Snowflake",
    );

    expect(frenchTech?.location).toBe(
      "Silicon Valley AI Hub, 135 Constitution Drive, Menlo Park, CA 94025",
    );
    expect(frenchTech?.attendees).toEqual(["French Tech SF"]);
  });

  it("keeps an Event linking off Luma, because the Event is still on the calendar", () => {
    const { events } = parseLumaCalendar(
      captureOf("luma-silicon-valley-ai-hub").text,
    );

    const apaba = events.find((event) =>
      event.url.startsWith("https://apabasv.com/"),
    );

    expect(apaba?.attendees).toEqual([
      "APABA Silicon Valley’s Women in Law Committee",
    ]);
  });

  it("reads a building's own calendar as the building hosting", () => {
    const { events } = parseLumaCalendar(
      captureOf("luma-frontier-tower-sf").text,
    );

    expect(
      events.find((event) => event.url === "https://luma.com/frontier-al6k"),
    ).toEqual({
      externalId: "https://luma.com/frontier-al6k",
      name: "Dell x NVIDIA Hackathon",
      startDate: "2026-10-25",
      endDate: "2026-10-25",
      location: "Frontier Tower @ Spaceship 995 Market Street, San Francisco",
      url: "https://luma.com/frontier-al6k",
      attendees: ["Frontier Tower SF"],
    });
  });
});

describe("parseLumaCalendar, against a page that has changed shape", () => {
  const EVENT = {
    "@type": "Event",
    "@id": "https://luma.com/summit",
    url: "https://luma.com/summit",
    name: "Sprocket Summit",
    startDate: "2026-10-01T18:00:00.000-07:00",
    endDate: "2026-10-01T21:00:00.000-07:00",
    location: {
      "@type": "Place",
      name: "Exploratorium",
      address: { addressLocality: "San Francisco" },
    },
    organizer: [
      { "@type": "Organization", name: "Sprocket" },
      { "@type": "Person", name: "Somebody" },
    ],
  };

  /** A page carrying `items` as its JSON-LD ItemList, beside an unrelated JSON-LD block. */
  const page = (items: unknown[]) =>
    [
      `<script type="application/ld+json">${JSON.stringify({ "@type": "Organization", name: "Bond AI" })}</script>`,
      `<script data-cfasync="false" type="application/ld+json">${JSON.stringify(
        {
          "@type": "ItemList",
          itemListElement: items.map((item, index) => ({
            "@type": "ListItem",
            position: index + 1,
            item,
          })),
        },
      )}</script>`,
    ].join("\n");

  it("reads a minimal valid Event", () => {
    expect(parseLumaCalendar(page([EVENT]))).toEqual({
      events: [
        {
          externalId: "https://luma.com/summit",
          name: "Sprocket Summit",
          startDate: "2026-10-01",
          endDate: "2026-10-01",
          location: "Exploratorium, San Francisco",
          url: "https://luma.com/summit",
          attendees: ["Sprocket"],
        },
      ],
      rejections: [],
    });
  });

  it("rejects a page carrying no ItemList at all", () => {
    const batch = parseLumaCalendar("<html><body>Not found</body></html>");

    expect(batch.events).toEqual([]);
    expect(batch.rejections.map((rejection) => rejection.field)).toEqual([
      "ItemList",
    ]);
  });

  it("rejects JSON-LD that is no longer JSON", () => {
    const batch = parseLumaCalendar(
      `<script type="application/ld+json">{not json</script>`,
    );

    expect(batch.rejections.map((rejection) => rejection.field)).toEqual([
      "ld+json",
    ]);
  });

  it("rejects an ItemList whose elements are no longer a list", () => {
    const batch = parseLumaCalendar(
      `<script type="application/ld+json">{"@type":"ItemList","itemListElement":{}}</script>`,
    );

    expect(batch.rejections.map((rejection) => rejection.field)).toEqual([
      "itemListElement",
    ]);
  });

  it.each([
    [
      "a missing start",
      { ...EVENT, startDate: undefined },
      "itemListElement.0.item.startDate",
    ],
    [
      "a start with no offset to say which day it is",
      { ...EVENT, startDate: "2026-10-01T18:00:00" },
      "itemListElement.0.item.startDate",
    ],
    [
      "a missing name",
      { ...EVENT, name: undefined },
      "itemListElement.0.item.name",
    ],
    ["a blank name", { ...EVENT, name: "  " }, "name"],
    [
      "a link that is not http(s)",
      { ...EVENT, url: "javascript:alert(1)" },
      "url",
    ],
    [
      "an end before the start",
      { ...EVENT, endDate: "2026-09-30T18:00:00.000-07:00" },
      "endDate",
    ],
    [
      "a location that is no longer an object",
      { ...EVENT, location: "Somewhere" },
      "itemListElement.0.item.location",
    ],
  ])("names the field on %s", (_description, item, field) => {
    const batch = parseLumaCalendar(page([item]));

    expect(batch.events).toEqual([]);
    expect(batch.rejections).toHaveLength(1);
    expect(batch.rejections[0]?.field).toBe(field);
  });

  it("keeps the rest of the list when one Event is bad", () => {
    const batch = parseLumaCalendar(
      page([{ ...EVENT, startDate: undefined }, EVENT]),
    );

    expect(batch.events).toHaveLength(1);
    expect(batch.rejections[0]?.field).toBe("itemListElement.0.item.startDate");
  });

  it("reads a single organizer given as an object rather than a list", () => {
    const [event] = parseLumaCalendar(
      page([
        { ...EVENT, organizer: { "@type": "Organization", name: "Solo" } },
      ]),
    ).events;

    expect(event?.attendees).toEqual(["Solo"]);
  });

  it("says Online for a virtual Event, and stores no location where none is given", () => {
    const { events } = parseLumaCalendar(
      page([
        { ...EVENT, location: { "@type": "VirtualLocation" } },
        {
          ...EVENT,
          "@id": "https://luma.com/other",
          location: undefined,
          endDate: undefined,
        },
      ]),
    );

    expect(events.map((event) => event.location)).toEqual([
      "Online",
      undefined,
    ]);
    expect(events[1]?.endDate).toBeUndefined();
  });

  it("ignores keys the payload gains, so a new field is not an outage", () => {
    const batch = parseLumaCalendar(
      page([{ ...EVENT, someNewField: { a: 1 } }]),
    );

    expect(batch.rejections).toEqual([]);
    expect(batch.events).toHaveLength(1);
  });
});
