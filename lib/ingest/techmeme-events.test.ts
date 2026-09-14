// @vitest-environment node
import { beforeAll, describe, expect, it } from "vitest";

import { eventInputSchema } from "../../db/event-input";
import {
  readEventSourceFixture,
  type EventSourceFixture,
} from "../testing/fixtures";
import { parseTechmemeEvents, TECHMEME_EVENTS_SOURCE } from "./techmeme-events";

/**
 * `db/fixtures/techmeme-events.ics` was captured with `curl` from the URL its `.meta.json`
 * sibling records, and is committed byte-for-byte, CRLF line endings and folded lines
 * included. Techmeme's `robots.txt` does not disallow it — see `scripts/ingest-events.ts`.
 */
let fixture: EventSourceFixture;

beforeAll(async () => {
  fixture = await readEventSourceFixture("techmeme-events", "ics");
});

describe("parseTechmemeEvents, against the captured feed", () => {
  it("turns every VEVENT into a validated Event", () => {
    const batch = parseTechmemeEvents(fixture.text);

    expect(batch.rejections).toEqual([]);
    expect(batch.events).toHaveLength(148);

    for (const event of batch.events) {
      expect(eventInputSchema.safeParse(event).success).toBe(true);
    }
  });

  it("reads name, dates, location and link, unfolding the URL and making DTEND inclusive", () => {
    const { events } = parseTechmemeEvents(fixture.text);

    // The feed's DTEND for BlizzCon is the 14th: iCalendar's end is exclusive, and the Event
    // runs on the 12th and 13th, as Techmeme's own page says.
    expect(events.find((event) => event.name === "BlizzCon")).toEqual({
      externalId: "RkEzvF9eGYFO0MuaeIxqhQ@techmeme.com",
      name: "BlizzCon",
      startDate: "2026-09-12",
      endDate: "2026-09-13",
      location: "Anaheim, CA",
      url: "https://www.techmeme.com/r2/blizzcon.com_en-us_-reQFn6oL.htm?cal=1",
      attendees: [],
    });
  });

  it("gives every Event its own UID, which is what ingest is idempotent on", () => {
    const { events } = parseTechmemeEvents(fixture.text);

    expect(new Set(events.map((event) => event.externalId)).size).toBe(
      events.length,
    );
  });

  it("carries the year the HTML page leaves out, across the turn of the year", () => {
    const { events } = parseTechmemeEvents(fixture.text);

    expect(events.some((event) => event.startDate.startsWith("2027-"))).toBe(
      true,
    );
  });

  it("leaves location unset where the feed states none, rather than inventing one", () => {
    const { events } = parseTechmemeEvents(fixture.text);

    expect(events.filter((event) => event.location === undefined)).toHaveLength(
      2,
    );
  });

  it("states no attendees: Techmeme lists Events, not who goes", () => {
    const { events } = parseTechmemeEvents(fixture.text);

    for (const event of events) {
      expect(event.attendees).toEqual([]);
    }
  });
});

describe("the Source slug", () => {
  it("is a lowercase slug persistEvents will accept", () => {
    expect(TECHMEME_EVENTS_SOURCE).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
  });
});

describe("parseTechmemeEvents, against a feed that has changed shape", () => {
  const VALID_EVENT = [
    "UID:summit@techmeme.com",
    "DTSTART;VALUE=DATE:20261001",
    "DTEND;VALUE=DATE:20261003",
    "SUMMARY:Sprocket Summit",
    "URL:https://example.com/summit",
    "LOCATION:San Francisco",
  ];

  /** A calendar holding one VEVENT per argument, each given as its content lines. */
  const calendar = (...vevents: string[][]) =>
    [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      ...vevents.flatMap((lines) => ["BEGIN:VEVENT", ...lines, "END:VEVENT"]),
      "END:VCALENDAR",
      "",
    ].join("\r\n");

  const without = (property: string) =>
    VALID_EVENT.filter((line) => !line.startsWith(property));

  const replacing = (property: string, line: string) => [
    ...without(property),
    line,
  ];

  it("reads a minimal valid VEVENT", () => {
    expect(parseTechmemeEvents(calendar(VALID_EVENT))).toEqual({
      events: [
        {
          externalId: "summit@techmeme.com",
          name: "Sprocket Summit",
          startDate: "2026-10-01",
          endDate: "2026-10-02",
          location: "San Francisco",
          url: "https://example.com/summit",
          attendees: [],
        },
      ],
      rejections: [],
    });
  });

  it("rejects a response that is not a calendar at all", () => {
    const batch = parseTechmemeEvents("<html><body>Not found</body></html>");

    expect(batch.events).toEqual([]);
    expect(batch.rejections.map((rejection) => rejection.field)).toEqual([
      "VCALENDAR",
    ]);
  });

  it.each([
    ["a missing DTSTART", without("DTSTART"), "DTSTART"],
    [
      "a DTSTART that is an instant, not a day",
      replacing("DTSTART", "DTSTART:20261001T170000Z"),
      "DTSTART",
    ],
    [
      "a DTSTART that is not a real date",
      replacing("DTSTART", "DTSTART;VALUE=DATE:20261340"),
      "DTSTART",
    ],
    ["a missing UID", without("UID"), "UID"],
    ["a missing SUMMARY", without("SUMMARY"), "SUMMARY"],
    ["a blank SUMMARY", replacing("SUMMARY", "SUMMARY:   "), "name"],
    ["a missing URL", without("URL"), "URL"],
    [
      "a URL that is not http(s)",
      replacing("URL", "URL:javascript:alert(1)"),
      "url",
    ],
    [
      "a DTEND no later than DTSTART",
      replacing("DTEND", "DTEND;VALUE=DATE:20261001"),
      "endDate",
    ],
  ])("names the field on %s", (_description, lines, field) => {
    const batch = parseTechmemeEvents(calendar(lines));

    expect(batch.events).toEqual([]);
    expect(batch.rejections).toHaveLength(1);
    expect(batch.rejections[0]?.field).toBe(field);
  });

  it("keeps the rest of the feed when one VEVENT is bad", () => {
    const batch = parseTechmemeEvents(
      calendar(without("DTSTART"), VALID_EVENT),
    );

    expect(batch.events.map((event) => event.name)).toEqual([
      "Sprocket Summit",
    ]);
    expect(batch.rejections).toHaveLength(1);
  });

  it("leaves out a cancelled Event without counting it as a rejection", () => {
    const batch = parseTechmemeEvents(
      calendar([...VALID_EVENT, "STATUS:CANCELLED"]),
    );

    expect(batch).toEqual({ events: [], rejections: [] });
  });

  it("stores no end date where the feed states none", () => {
    const [event] = parseTechmemeEvents(calendar(without("DTEND"))).events;

    expect(event?.endDate).toBeUndefined();
  });

  it("unescapes iCalendar TEXT", () => {
    const [event] = parseTechmemeEvents(
      calendar(
        replacing("SUMMARY", "SUMMARY:Bits\\, Bytes\\; and \\\\Pretzels"),
      ),
    ).events;

    expect(event?.name).toBe("Bits, Bytes; and \\Pretzels");
  });

  it("unfolds a line folded with a tab, and reads bare LF line endings", () => {
    const [event] = parseTechmemeEvents(
      calendar(
        replacing("URL", "URL:https://example.com/su\r\n\tmmit"),
      ).replaceAll("\r\n", "\n"),
    ).events;

    expect(event?.url).toBe("https://example.com/summit");
  });

  it("does not let a nested VALARM overwrite the Event's own properties", () => {
    const [event] = parseTechmemeEvents(
      calendar([
        "BEGIN:VALARM",
        "SUMMARY:Reminder",
        "END:VALARM",
        ...VALID_EVENT,
      ]),
    ).events;

    expect(event?.name).toBe("Sprocket Summit");
  });
});
