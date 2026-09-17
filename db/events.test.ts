// @vitest-environment node
import { count, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { citiesInArea, eventCityOf } from "../lib/location/bay-area";
import type { EventInput } from "./event-input";
import {
  diaryQuerySchema,
  diaryToday,
  persistEvents,
  readDiary,
} from "./events";
import { recordSwipe } from "./deck";
import { asUser } from "./rls";
import {
  eventAttendances,
  events,
  profiles,
  swipes,
  userProfiles,
} from "./schema";
import { createScratchDb, type ScratchDb } from "./testing/scratch-db";
import { SEEDED_PROVENANCE } from "./testing/seed-profiles";
import { writeUserProfile } from "./user-profile";

const JACK = "11111111-1111-1111-1111-111111111111";
const SOMEONE_ELSE = "22222222-2222-2222-2222-222222222222";

const TODAY = "2026-09-13";

const SUMMIT: EventInput = {
  externalId: "summit@example.com",
  name: "Sprocket Summit",
  startDate: "2026-10-01",
  endDate: "2026-10-02",
  location: "San Francisco",
  url: "https://example.com/summit",
  attendees: ["Sprocket", "Quiet Co"],
};

const MEETUP: EventInput = {
  externalId: "meetup@example.com",
  name: "Robotics Meetup",
  startDate: "2026-09-20",
  url: "https://example.com/meetup",
  // Spelled the way no Company Profile is: `name_key` is what makes it Sprocket anyway.
  attendees: ["  SPROCKET "],
};

/** Nobody is known to attend this one. */
const DEMO_DAY: EventInput = {
  externalId: "demo-day@example.com",
  name: "Demo Day",
  startDate: "2026-11-01",
  url: "https://example.com/demo-day",
  attendees: [],
};

/** A "City, ST" Bay Area location, the other shape Techmeme states. */
const SANTA_CLARA_EXPO: EventInput = {
  externalId: "santa-clara-expo@example.com",
  name: "Santa Clara Robotics Expo",
  startDate: "2026-09-28",
  location: "Santa Clara, CA",
  url: "https://example.com/santa-clara-expo",
  attendees: [],
};

/** A bare, out-of-area city — the shape Techmeme states for `London` itself. */
const LONDON_TALK: EventInput = {
  externalId: "london-talk@example.com",
  name: "London Fintech Talk",
  startDate: "2026-09-25",
  location: "London",
  url: "https://example.com/london-talk",
  attendees: [],
};

/** A "City, ST" out-of-area location. */
const AUSTIN_MIXER: EventInput = {
  externalId: "austin-mixer@example.com",
  name: "Austin Founders Mixer",
  startDate: "2026-09-22",
  location: "Austin, TX",
  url: "https://example.com/austin-mixer",
  attendees: [],
};

let scratch: ScratchDb;
const ownerIdBefore = process.env.ROLODECK_OWNER_ID;

/** A Company Profile, written as the superuser: arranging fixtures is not what is under test. */
async function company(
  name: string,
  {
    ownerId = JACK,
    source = "seed",
  }: { ownerId?: string; source?: string } = {},
): Promise<string> {
  const [row] = await scratch.db
    .insert(profiles)
    .values({
      ownerId,
      source,
      name,
      description: "A company.",
      sector: "other",
      stage: "seed",
      website: null,
      provenance: SEEDED_PROVENANCE,
    })
    .returning({ id: profiles.id });

  return row!.id;
}

async function eventId(externalId: string): Promise<string> {
  const [row] = await scratch.db
    .select({ id: events.id })
    .from(events)
    .where(eq(events.externalId, externalId));

  return row!.id;
}

const eventRowCount = async () => {
  const [row] = await scratch.db.select({ total: count() }).from(events);
  return row!.total;
};

const diary = (options: { includePast?: boolean; today?: string } = {}) =>
  asUser(scratch.db, JACK, (tx) =>
    readDiary(tx, {
      userId: JACK,
      today: options.today ?? TODAY,
      includePast: options.includePast,
    }),
  );

const keep = (profileId: string, userId = JACK) =>
  scratch.db.insert(swipes).values({ userId, profileId, decision: "keep" });

beforeAll(async () => {
  scratch = await createScratchDb();
  await scratch.createUser(JACK);
  await scratch.createUser(SOMEONE_ELSE);
}, 60_000);

afterAll(async () => {
  await scratch?.close();
  process.env.ROLODECK_OWNER_ID = ownerIdBefore;
});

beforeEach(async () => {
  process.env.ROLODECK_OWNER_ID = JACK;
  await scratch.reset();
  await scratch.db.delete(events);
  await scratch.db.delete(swipes);
  await scratch.db.delete(profiles);
  await scratch.db.delete(userProfiles);
});

describe("persistEvents", () => {
  it("stores every field, owned by the account named in the environment", async () => {
    const report = await persistEvents(scratch.db, {
      source: "techmeme-events",
      events: [SUMMIT],
    });

    expect(report).toEqual({
      inserted: 1,
      updated: 0,
      rejected: 0,
      rejections: [],
      attendances: 0,
    });

    const [row] = await scratch.db.select().from(events);

    expect(row).toMatchObject({
      ownerId: JACK,
      source: "techmeme-events",
      externalId: "summit@example.com",
      name: "Sprocket Summit",
      startDate: "2026-10-01",
      endDate: "2026-10-02",
      location: "San Francisco",
      url: "https://example.com/summit",
    });
  });

  it("stores null for an end date and location the Source does not state", async () => {
    await persistEvents(scratch.db, { source: "luma", events: [DEMO_DAY] });

    const [row] = await scratch.db.select().from(events);

    expect(row?.endDate).toBeNull();
    expect(row?.location).toBeNull();
  });

  it("rejects a malformed Event naming the field, and still writes the rest", async () => {
    const report = await persistEvents(scratch.db, {
      source: "luma",
      events: [
        { ...SUMMIT, url: "javascript:alert(1)" },
        { ...MEETUP, startDate: "Sept 20" },
        { ...DEMO_DAY, endDate: "2026-10-31" },
        { ...DEMO_DAY, externalId: "fine@example.com" },
      ],
    });

    expect(report.inserted).toBe(1);
    expect(report.rejections.map((rejection) => rejection.field)).toEqual([
      "url",
      "startDate",
      "endDate",
    ]);
    expect(await eventRowCount()).toBe(1);
  });

  it("throws on a Source name that is not a slug, before writing anything", async () => {
    await expect(
      persistEvents(scratch.db, { source: "Techmeme", events: [SUMMIT] }),
    ).rejects.toThrow();

    expect(await eventRowCount()).toBe(0);
  });

  it("throws rather than writing invisible rows when the owner id is absent", async () => {
    delete process.env.ROLODECK_OWNER_ID;

    await expect(
      persistEvents(scratch.db, { source: "luma", events: [SUMMIT] }),
    ).rejects.toThrow(/ROLODECK_OWNER_ID/);
  });
});

describe("persistEvents idempotency", () => {
  it("leaves the row count unchanged when the same Source runs twice", async () => {
    await company("Sprocket");

    const first = await persistEvents(scratch.db, {
      source: "techmeme-events",
      events: [SUMMIT, MEETUP, DEMO_DAY],
    });
    const rowsAfterFirst = await eventRowCount();

    const second = await persistEvents(scratch.db, {
      source: "techmeme-events",
      events: [SUMMIT, MEETUP, DEMO_DAY],
    });

    expect(first).toMatchObject({ inserted: 3, updated: 0 });
    expect(second).toMatchObject({ inserted: 0, updated: 3 });
    expect(rowsAfterFirst).toBe(3);
    expect(await eventRowCount()).toBe(3);
    await expect(
      scratch.db.select().from(eventAttendances),
    ).resolves.toHaveLength(2);
  });

  it("updates an Event in place, keeping its id, when the Source corrects it", async () => {
    await persistEvents(scratch.db, { source: "luma", events: [SUMMIT] });
    const before = await eventId(SUMMIT.externalId);

    await persistEvents(scratch.db, {
      source: "luma",
      events: [
        { ...SUMMIT, name: "Sprocket Summit 2026", startDate: "2026-10-02" },
      ],
    });

    const rows = await scratch.db.select().from(events);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: before,
      name: "Sprocket Summit 2026",
      startDate: "2026-10-02",
    });
  });

  it("keeps the same id from two Sources as two Events", async () => {
    await persistEvents(scratch.db, { source: "luma", events: [SUMMIT] });
    await persistEvents(scratch.db, {
      source: "techmeme-events",
      events: [SUMMIT],
    });

    expect(await eventRowCount()).toBe(2);
  });
});

describe("attendance", () => {
  it("links one Event to many companies, and one company to many Events", async () => {
    const sprocket = await company("Sprocket");
    const quietCo = await company("Quiet Co");

    const report = await persistEvents(scratch.db, {
      source: "luma",
      events: [SUMMIT, MEETUP],
    });

    expect(report.attendances).toBe(3);

    const summit = await eventId(SUMMIT.externalId);
    const meetup = await eventId(MEETUP.externalId);

    const companiesAtSummit = await scratch.db
      .select({ profileId: eventAttendances.profileId })
      .from(eventAttendances)
      .where(eq(eventAttendances.eventId, summit));

    expect(companiesAtSummit.map((row) => row.profileId).sort()).toEqual(
      [sprocket, quietCo].sort(),
    );

    const eventsForSprocket = await scratch.db
      .select({ eventId: eventAttendances.eventId })
      .from(eventAttendances)
      .where(eq(eventAttendances.profileId, sprocket));

    expect(eventsForSprocket.map((row) => row.eventId).sort()).toEqual(
      [summit, meetup].sort(),
    );
  });

  it("stores the Event and links nothing when no attendee is a Company Profile", async () => {
    const report = await persistEvents(scratch.db, {
      source: "luma",
      events: [{ ...SUMMIT, attendees: ["Nobody Incorporated"] }],
    });

    expect(report).toMatchObject({ inserted: 1, attendances: 0 });
    await expect(scratch.db.select().from(eventAttendances)).resolves.toEqual(
      [],
    );
  });

  it("rebuilds an Event's attendance from what the Source states now", async () => {
    await company("Sprocket");
    const quietCo = await company("Quiet Co");

    await persistEvents(scratch.db, { source: "luma", events: [SUMMIT] });
    await persistEvents(scratch.db, {
      source: "luma",
      events: [{ ...SUMMIT, attendees: ["Quiet Co"] }],
    });

    const rows = await scratch.db.select().from(eventAttendances);

    expect(rows.map((row) => row.profileId)).toEqual([quietCo]);
  });

  it("never links a company belonging to another account", async () => {
    await company("Sprocket", { ownerId: SOMEONE_ELSE });

    const report = await persistEvents(scratch.db, {
      source: "luma",
      events: [SUMMIT],
    });

    expect(report.attendances).toBe(0);
  });

  it("links every Company Profile a name matches, whichever Source found it", async () => {
    await company("Sprocket", { source: "show-hn" });
    await company("Sprocket", { source: "sec-form-d" });

    const report = await persistEvents(scratch.db, {
      source: "luma",
      events: [MEETUP],
    });

    expect(report.attendances).toBe(2);
  });
});

describe("reading the Diary", () => {
  it("shows an Event with no known attendees", async () => {
    await persistEvents(scratch.db, { source: "luma", events: [DEMO_DAY] });

    const read = await diary();

    expect(read).toEqual([
      {
        id: expect.any(String),
        name: "Demo Day",
        startDate: "2026-11-01",
        endDate: null,
        location: null,
        url: "https://example.com/demo-day",
        important: false,
        keptCompanies: [],
      },
    ]);
  });

  it("lists Events by date, soonest first", async () => {
    await persistEvents(scratch.db, {
      source: "luma",
      events: [DEMO_DAY, SUMMIT, MEETUP],
    });

    const read = await diary();

    expect(read.map((event) => event.name)).toEqual([
      "Robotics Meetup",
      "Sprocket Summit",
      "Demo Day",
    ]);
  });

  it("leaves past Events out by default, keeps one still running, and shows all on request", async () => {
    await persistEvents(scratch.db, {
      source: "luma",
      events: [
        { ...MEETUP, startDate: "2026-09-01" },
        // Started yesterday, ends tomorrow: not past yet.
        { ...SUMMIT, startDate: "2026-09-12", endDate: "2026-09-14" },
        // Today counts as upcoming, all day.
        { ...DEMO_DAY, startDate: TODAY },
      ],
    });

    await expect(
      diary().then((read) => read.map((e) => e.name)),
    ).resolves.toEqual(["Sprocket Summit", "Demo Day"]);
    await expect(
      diary({ includePast: true }).then((read) => read.map((e) => e.name)),
    ).resolves.toEqual(["Robotics Meetup", "Sprocket Summit", "Demo Day"]);
  });

  it("marks an Event important once a company attending it is Kept, and not before", async () => {
    const sprocket = await company("Sprocket");
    await company("Quiet Co");
    await persistEvents(scratch.db, {
      source: "luma",
      events: [SUMMIT, DEMO_DAY],
    });

    const before = await diary();

    expect(before.map((event) => [event.name, event.important])).toEqual([
      ["Sprocket Summit", false],
      ["Demo Day", false],
    ]);

    await asUser(scratch.db, JACK, (tx) =>
      recordSwipe(tx, { userId: JACK, profileId: sprocket, decision: "keep" }),
    );

    const after = await diary();

    expect(after.map((event) => [event.name, event.important])).toEqual([
      ["Sprocket Summit", true],
      ["Demo Day", false],
    ]);
    expect(after[0]?.keptCompanies).toEqual(["Sprocket"]);
  });

  it("unmarks it again when the Keep is corrected to a Pass", async () => {
    const sprocket = await company("Sprocket");
    await persistEvents(scratch.db, { source: "luma", events: [MEETUP] });
    await keep(sprocket);

    await asUser(scratch.db, JACK, (tx) =>
      recordSwipe(tx, { userId: JACK, profileId: sprocket, decision: "pass" }),
    );

    const [meetup] = await diary();

    expect(meetup?.important).toBe(false);
    expect(meetup?.keptCompanies).toEqual([]);
  });

  it("names a Kept company once, even when two of its Company Profiles attend", async () => {
    const first = await company("Sprocket", { source: "show-hn" });
    const second = await company("Sprocket", { source: "sec-form-d" });
    const quietCo = await company("Quiet Co");
    await persistEvents(scratch.db, { source: "luma", events: [SUMMIT] });
    await keep(first);
    await keep(second);
    await keep(quietCo);

    const [summit] = await diary();

    expect(summit?.keptCompanies).toEqual(["Quiet Co", "Sprocket"]);
  });

  it("is not marked by somebody else's Keep", async () => {
    const sprocket = await company("Sprocket");
    await persistEvents(scratch.db, { source: "luma", events: [MEETUP] });
    await keep(sprocket, SOMEONE_ELSE);

    const [meetup] = await diary();

    expect(meetup?.important).toBe(false);
  });

  it("shows nobody else's Events", async () => {
    process.env.ROLODECK_OWNER_ID = SOMEONE_ELSE;
    await persistEvents(scratch.db, { source: "luma", events: [SUMMIT] });

    await expect(diary()).resolves.toEqual([]);
  });
});

describe("filtering the Diary by area", () => {
  const names = (read: Awaited<ReturnType<typeof diary>>) =>
    read.map((event) => event.name).sort();

  it("keeps a bare Bay Area city and a 'City, ST' one, by default", async () => {
    // Nothing saved to `user_profiles`: the never-saved default is "Bay Area" itself.
    await persistEvents(scratch.db, {
      source: "techmeme-events",
      events: [SUMMIT, SANTA_CLARA_EXPO],
    });

    expect(names(await diary())).toEqual(
      ["Santa Clara Robotics Expo", "Sprocket Summit"].sort(),
    );
  });

  it("hides a bare out-of-area city and a 'City, ST' one, by default", async () => {
    await persistEvents(scratch.db, {
      source: "techmeme-events",
      events: [SUMMIT, LONDON_TALK, AUSTIN_MIXER],
    });

    expect(names(await diary())).toEqual(["Sprocket Summit"]);
  });

  it("keeps an Event with no stated location, regardless of area", async () => {
    await persistEvents(scratch.db, {
      source: "luma",
      events: [DEMO_DAY, LONDON_TALK],
    });

    expect(names(await diary())).toEqual(["Demo Day"]);
  });

  it("filters nothing for an owner whose area is unrecognised", async () => {
    await writeUserProfile(scratch.db, JACK, {
      sectors: [],
      stages: [],
      area: "New York",
      excluded_sectors: [],
    });
    await persistEvents(scratch.db, {
      source: "luma",
      events: [SUMMIT, LONDON_TALK],
    });

    expect(names(await diary())).toEqual(
      ["London Fintech Talk", "Sprocket Summit"].sort(),
    );
  });

  it("filters nothing for an owner whose area is empty", async () => {
    // Not a shape `writeUserProfile`'s own boundary allows in; written directly, as the
    // superuser, the way `citiesInArea`'s own contract for free text has to hold regardless.
    await scratch.db.insert(userProfiles).values({
      userId: JACK,
      sectors: [],
      stages: [],
      area: "",
      excludedSectors: [],
    });
    await persistEvents(scratch.db, {
      source: "luma",
      events: [SUMMIT, LONDON_TALK],
    });

    expect(names(await diary())).toEqual(
      ["London Fintech Talk", "Sprocket Summit"].sort(),
    );
  });
});

describe("matching an Event's location to the area in Postgres", () => {
  const LOCATIONS: (string | undefined)[] = [
    "San Francisco",
    "  Palo Alto , CA",
    "SAN JOSE, CA",
    "St. Helena, CA",
    "Oakland, California, USA",
    "Los Angeles, CA",
    "London",
    "New York, NY",
    "CA",
    undefined,
  ];

  it("agrees with eventCityOf and citiesInArea on every location", async () => {
    await persistEvents(scratch.db, {
      source: "techmeme-events",
      events: LOCATIONS.map((location, index) => ({
        externalId: `located-${index}@example.com`,
        name: `Located ${index}`,
        startDate: "2026-10-01",
        location,
        url: "https://example.com/located",
        attendees: [],
      })),
    });

    const bayAreaCities = citiesInArea("Bay Area");
    const expected = LOCATIONS.map((location, index) => ({
      inArea:
        location === undefined || bayAreaCities.includes(eventCityOf(location)),
      name: `Located ${index}`,
    }))
      .filter((row) => row.inArea)
      .map((row) => row.name)
      .sort();

    // Nothing saved to `user_profiles`: the never-saved default is "Bay Area" itself.
    const read = await diary();

    expect(read.map((event) => event.name).sort()).toEqual(expected);
  });
});

describe("the Diary's today", () => {
  it("turns over at midnight in the Bay Area, not at midnight UTC", () => {
    // September is daylight time: the Bay Area is seven hours behind UTC.
    expect(diaryToday(new Date("2026-09-14T06:59:00Z"))).toBe("2026-09-13");
    expect(diaryToday(new Date("2026-09-14T07:00:00Z"))).toBe("2026-09-14");
  });
});

describe("the Diary's query", () => {
  it("accepts nothing, or include=past, and names anything else", () => {
    expect(diaryQuerySchema.safeParse({}).success).toBe(true);
    expect(diaryQuerySchema.safeParse({ include: "past" }).success).toBe(true);

    const refused = diaryQuerySchema.safeParse({ include: "everything" });

    expect(refused.success).toBe(false);
    expect(refused.error?.issues[0]?.path).toEqual(["include"]);
  });
});

describe("row level security under the Diary", () => {
  beforeEach(async () => {
    await company("Sprocket");
    await persistEvents(scratch.db, { source: "luma", events: [MEETUP] });
  });

  it("lets the owner read their Events and attendances", async () => {
    await scratch.as("authenticated", JACK);

    await expect(scratch.db.select().from(events)).resolves.toHaveLength(1);
    await expect(
      scratch.db.select().from(eventAttendances),
    ).resolves.toHaveLength(1);
  });

  it("shows the anonymous role no Events and no attendances", async () => {
    await scratch.as("anon");

    await expect(scratch.db.select().from(events)).resolves.toEqual([]);
    await expect(scratch.db.select().from(eventAttendances)).resolves.toEqual(
      [],
    );
  });

  it("shows another signed-in account none of them", async () => {
    await scratch.as("authenticated", SOMEONE_ELSE);

    await expect(scratch.db.select().from(events)).resolves.toEqual([]);
    await expect(scratch.db.select().from(eventAttendances)).resolves.toEqual(
      [],
    );
  });

  it("refuses the write to the app's own role, so ingest stays the only writer", async () => {
    await scratch.as("authenticated", JACK);

    await expect(
      persistEvents(scratch.db, { source: "luma", events: [DEMO_DAY] }),
    ).rejects.toThrow();

    await scratch.reset();
    expect(await eventRowCount()).toBe(1);
  });
});
