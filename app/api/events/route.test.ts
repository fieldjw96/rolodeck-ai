// @vitest-environment node
import { NextRequest } from "next/server";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { eventAttendances, events, swipes } from "../../../db/schema";
import {
  startRouteHarness,
  type RouteHarness,
} from "../../../lib/api/testing/route-harness";
import { GET } from "./route";

let harness: RouteHarness;

vi.mock("next/headers", () => ({
  cookies: async () => ({
    getAll: () => harness.cookies,
    set: () => {},
  }),
}));

vi.mock("../../../db/connection", () => ({
  getDb: () => harness.scratch.db,
}));

type DiaryBody = { events: Record<string, unknown>[] };

const read = (query = "") =>
  GET(new NextRequest(`http://localhost/api/events${query}`), undefined);

const readOk = async (query = "") => {
  const response = await read(query);

  expect(response.status).toBe(200);

  return (await response.json()) as DiaryBody;
};

/** Far enough either side of the real today that the test does not depend on when it runs. */
const PAST = "2000-01-01";
const FUTURE = "2999-01-01";

async function addEvent(name: string, startDate: string): Promise<string> {
  const [row] = await harness.scratch.db
    .insert(events)
    .values({
      ownerId: harness.user.id,
      source: "luma",
      externalId: name,
      name,
      startDate,
      url: `https://example.com/${encodeURIComponent(name)}`,
    })
    .returning({ id: events.id });

  return row!.id;
}

beforeAll(async () => {
  harness = await startRouteHarness();

  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", harness.backend.url);
  vi.stubEnv(
    "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
    harness.backend.publishableKey,
  );
}, 60_000);

afterAll(async () => {
  await harness?.close();
  vi.unstubAllEnvs();
});

beforeEach(async () => {
  await harness.clear();
  await harness.signIn();
});

describe("GET /api/events without a session", () => {
  it("answers 401 rather than redirecting to /login", async () => {
    harness.signOut();

    const response = await read();

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "not signed in" });
  });
});

describe("GET /api/events", () => {
  it("answers an empty Diary with no Events", async () => {
    await expect(readOk()).resolves.toEqual({ events: [] });
  });

  it("sends upcoming Events, each with the marking the query computed", async () => {
    const [profileId] = await harness.seed(1);
    const eventId = await addEvent("Sprocket Summit", FUTURE);
    await addEvent("Old Meetup", PAST);
    await harness.scratch.db
      .insert(eventAttendances)
      .values({ eventId, profileId: profileId! });
    await harness.scratch.db.insert(swipes).values({
      userId: harness.user.id,
      profileId: profileId!,
      decision: "keep",
    });

    await expect(readOk()).resolves.toEqual({
      events: [
        {
          id: eventId,
          name: "Sprocket Summit",
          start_date: FUTURE,
          end_date: null,
          location: null,
          url: "https://example.com/Sprocket%20Summit",
          important: true,
          kept_companies: ["Startup 0"],
        },
      ],
    });
  });

  it("includes past Events when asked", async () => {
    await addEvent("Sprocket Summit", FUTURE);
    await addEvent("Old Meetup", PAST);

    const body = await readOk("?include=past");

    expect(body.events.map((event) => event.name)).toEqual([
      "Old Meetup",
      "Sprocket Summit",
    ]);
  });

  it("sends nobody else's Events", async () => {
    await harness.scratch.db.insert(events).values({
      ownerId: harness.strangerId,
      source: "luma",
      externalId: "theirs",
      name: "Their Event",
      startDate: FUTURE,
      url: "https://example.com/theirs",
    });

    await expect(readOk()).resolves.toEqual({ events: [] });
  });

  it("answers 422 naming the field for an include it does not know", async () => {
    const response = await read("?include=everything");

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      error: "invalid request",
      field: "include",
    });
  });
});
