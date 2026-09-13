// @vitest-environment node
import { beforeAll, describe, expect, it } from "vitest";

import { eventInputSchema } from "../../db/event-input";
import {
  readEventSourceFixture,
  type EventSourceFixture,
} from "../testing/fixtures";
import { LUMA_BOND_AI_SF_SOURCE, parseLumaBondAiSf } from "./luma-bond-ai-sf";

/**
 * `db/fixtures/luma-bond-ai-sf.html` was captured with `curl` from the URL its `.meta.json`
 * sibling records, and is committed byte-for-byte. Luma's `robots.txt` does not disallow it —
 * see `scripts/ingest-events.ts`.
 */
let fixture: EventSourceFixture;

beforeAll(async () => {
  fixture = await readEventSourceFixture("luma-bond-ai-sf", "html");
});

describe("parseLumaBondAiSf, against the captured page", () => {
  it("turns the JSON-LD ItemList into validated Events", () => {
    const batch = parseLumaBondAiSf(fixture.text);

    expect(batch.rejections).toEqual([]);
    expect(batch.events).toHaveLength(20);

    for (const event of batch.events) {
      expect(eventInputSchema.safeParse(event).success).toBe(true);
    }
  });

  it("reads an Event's name, dates, venue, link and hosting company", () => {
    const { events } = parseLumaBondAiSf(fixture.text);

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
    const { events } = parseLumaBondAiSf(fixture.text);

    // 17:00 at -07:00 is midnight UTC on the 16th.
    const tasting = events.find((event) =>
      event.name.startsWith("The Tasting Menu"),
    );

    expect(tasting?.startDate).toBe("2026-09-15");
  });

  it("names a hosting Organization as attending, and never a hosting Person", () => {
    const { events } = parseLumaBondAiSf(fixture.text);

    // Hosted by The Multimodal Society and by two people, who are not companies.
    const filmmaking = events.find(
      (event) => event.name === "AI Filmmaking Masterclass + Hackathon",
    );

    expect(filmmaking?.attendees).toEqual(["The Multimodal Society"]);
    expect(filmmaking?.location).toBe("San Francisco, CA");
  });

  it("states no attendees for an Event no organisation hosts", () => {
    const { events } = parseLumaBondAiSf(fixture.text);

    const mapbox = events.find((event) =>
      event.name.startsWith("Mapbox Happy Hour"),
    );

    expect(mapbox).toBeDefined();
    expect(mapbox?.attendees).toEqual([]);
  });
});

describe("the Source slug", () => {
  it("is a lowercase slug persistEvents will accept", () => {
    expect(LUMA_BOND_AI_SF_SOURCE).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
  });
});

describe("parseLumaBondAiSf, against a page that has changed shape", () => {
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
    expect(parseLumaBondAiSf(page([EVENT]))).toEqual({
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
    const batch = parseLumaBondAiSf("<html><body>Not found</body></html>");

    expect(batch.events).toEqual([]);
    expect(batch.rejections.map((rejection) => rejection.field)).toEqual([
      "ItemList",
    ]);
  });

  it("rejects JSON-LD that is no longer JSON", () => {
    const batch = parseLumaBondAiSf(
      `<script type="application/ld+json">{not json</script>`,
    );

    expect(batch.rejections.map((rejection) => rejection.field)).toEqual([
      "ld+json",
    ]);
  });

  it("rejects an ItemList whose elements are no longer a list", () => {
    const batch = parseLumaBondAiSf(
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
  ])("names the field on %s", (_description, item, field) => {
    const batch = parseLumaBondAiSf(page([item]));

    expect(batch.events).toEqual([]);
    expect(batch.rejections).toHaveLength(1);
    expect(batch.rejections[0]?.field).toBe(field);
  });

  it("keeps the rest of the list when one Event is bad", () => {
    const batch = parseLumaBondAiSf(
      page([{ ...EVENT, startDate: undefined }, EVENT]),
    );

    expect(batch.events).toHaveLength(1);
    expect(batch.rejections[0]?.field).toBe("itemListElement.0.item.startDate");
  });

  it("reads a single organizer given as an object rather than a list", () => {
    const [event] = parseLumaBondAiSf(
      page([
        { ...EVENT, organizer: { "@type": "Organization", name: "Solo" } },
      ]),
    ).events;

    expect(event?.attendees).toEqual(["Solo"]);
  });

  it("says Online for a virtual Event, and stores no location where none is given", () => {
    const { events } = parseLumaBondAiSf(
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
    const batch = parseLumaBondAiSf(
      page([{ ...EVENT, someNewField: { a: 1 } }]),
    );

    expect(batch.rejections).toEqual([]);
    expect(batch.events).toHaveLength(1);
  });
});
