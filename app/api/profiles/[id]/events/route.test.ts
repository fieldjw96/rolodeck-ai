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

import { eventAttendances, events, swipes } from "../../../../../db/schema";
import {
  startRouteHarness,
  type RouteHarness,
} from "../../../../../lib/api/testing/route-harness";
import { GET } from "./route";

let harness: RouteHarness;

vi.mock("next/headers", () => ({
  cookies: async () => ({
    getAll: () => harness.cookies,
    set: () => {},
  }),
}));

vi.mock("../../../../../db/connection", () => ({
  getDb: () => harness.scratch.db,
}));

const NO_SUCH_PROFILE = "3f0d2f4e-1f6a-4a5c-9f42-6f1e0c7d2b31";

/** Far enough either side of the real today that the test does not depend on when it runs. */
const PAST = "2000-01-01";
const SOONER = "2999-01-01";
const LATER = "2999-06-01";

const read = (id: string) =>
  GET(new NextRequest(`http://localhost/api/profiles/${id}/events`), {
    params: Promise.resolve({ id }),
  });

type EventsItemsBody = { items: Record<string, unknown>[] };

const readOk = async (id: string): Promise<EventsItemsBody> => {
  const response = await read(id);

  expect(response.status).toBe(200);

  return (await response.json()) as EventsItemsBody;
};

async function addEvent(
  name: string,
  startDate: string,
  overrides: { endDate?: string; location?: string | null } = {},
): Promise<string> {
  const [row] = await harness.scratch.db
    .insert(events)
    .values({
      source: "luma",
      externalId: name,
      name,
      startDate,
      endDate: overrides.endDate ?? null,
      location: overrides.location ?? null,
      url: `https://example.com/${encodeURIComponent(name)}`,
    })
    .returning({ id: events.id });

  return row!.id;
}

const attend = (eventId: string, profileId: string) =>
  harness.scratch.db.insert(eventAttendances).values({ eventId, profileId });

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

describe("GET /api/profiles/:id/events without a session", () => {
  it("answers 401 rather than redirecting to /login", async () => {
    harness.signOut();

    const response = await read(NO_SUCH_PROFILE);

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "not signed in" });
  });
});

describe("GET /api/profiles/:id/events", () => {
  it("answers 422 naming id when the id is not a Profile id", async () => {
    const response = await read("not-a-uuid");

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      error: "invalid request",
      field: "id",
    });
  });

  it("lists this company's upcoming Events, soonest first, leaving past ones out", async () => {
    const [id] = await harness.seed(1);
    const sooner = await addEvent("Robotics Meetup", SOONER, {
      location: "San Francisco",
    });
    const later = await addEvent("Sprocket Summit", LATER);
    const past = await addEvent("Old Meetup", PAST);
    await attend(sooner, id!);
    await attend(later, id!);
    await attend(past, id!);

    const body = await readOk(id!);

    expect(body.items).toEqual([
      {
        id: sooner,
        name: "Robotics Meetup",
        start_date: SOONER,
        end_date: null,
        location: "San Francisco",
        url: "https://example.com/Robotics%20Meetup",
      },
      {
        id: later,
        name: "Sprocket Summit",
        start_date: LATER,
        end_date: null,
        location: null,
        url: "https://example.com/Sprocket%20Summit",
      },
    ]);
  });

  it("answers with no items for a company with no Attendance", async () => {
    const [id] = await harness.seed(1);
    await addEvent("Somebody Else's Summit", SOONER);

    await expect(readOk(id!)).resolves.toEqual({ items: [] });
  });

  it("answers with no items for a Profile that does not exist", async () => {
    await expect(readOk(NO_SUCH_PROFILE)).resolves.toEqual({ items: [] });
  });

  // Events are Catalogue, per docs/adr/0019: unlike News, this answers the same way whether
  // or not the asking reader has Kept the company.
  it("lists an upcoming Event for a company nobody has Kept", async () => {
    const [id] = await harness.seed(1);
    const eventId = await addEvent("Sprocket Summit", SOONER);
    await attend(eventId, id!);
    await harness.scratch.db.insert(swipes).values({
      userId: harness.strangerId,
      profileId: id!,
      decision: "pass",
    });

    const body = await readOk(id!);

    expect(body.items.map((item) => item.name)).toEqual(["Sprocket Summit"]);
  });
});
