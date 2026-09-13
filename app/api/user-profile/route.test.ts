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

import { userProfiles } from "../../../db/schema";
import {
  startRouteHarness,
  type RouteHarness,
} from "../../../lib/api/testing/route-harness";
import { GET, PUT } from "./route";

let harness: RouteHarness;

// The cookies a browser would send. `next/headers` is the only way a route handler can read
// them, so this is where a test says "signed in" or "signed out".
vi.mock("next/headers", () => ({
  cookies: async () => ({
    getAll: () => harness.cookies,
    set: () => {},
  }),
}));

// The in-process Postgres stands in for Supabase's. Everything above it — the query, the
// transaction that drops to the `authenticated` role, the policies — is the real thing.
vi.mock("../../../db/connection", () => ({
  getDb: () => harness.scratch.db,
}));

type UserProfileBody = {
  sectors: string[];
  stages: string[];
  area: string;
  excluded_sectors: string[];
};

const EMPTY_BODY: UserProfileBody = {
  sectors: [],
  stages: [],
  area: "Bay Area",
  excluded_sectors: [],
};

const get = () =>
  GET(new NextRequest("http://localhost/api/user-profile"), undefined);

const put = (body: unknown) =>
  PUT(
    new NextRequest("http://localhost/api/user-profile", {
      method: "PUT",
      body: typeof body === "string" ? body : JSON.stringify(body),
      headers: { "content-type": "application/json" },
    }),
    undefined,
  );

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
  await harness.scratch.db.delete(userProfiles);
  await harness.signIn();
});

describe("GET /api/user-profile without a session", () => {
  it("answers 401 rather than redirecting to /login", async () => {
    harness.signOut();

    const response = await get();

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "not signed in" });
  });
});

describe("GET /api/user-profile", () => {
  it("returns a well-defined empty User Profile when the owner has never saved one", async () => {
    const response = await get();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(EMPTY_BODY);
  });

  it("deals nobody else's User Profile", async () => {
    await harness.scratch.db.insert(userProfiles).values({
      userId: harness.strangerId,
      sectors: ["fintech"],
      stages: ["growth"],
      area: "Bay Area",
      excludedSectors: [],
    });

    const response = await get();

    await expect(response.json()).resolves.toEqual(EMPTY_BODY);
  });
});

describe("PUT /api/user-profile", () => {
  it("saves the owner's stated preferences and echoes them back", async () => {
    const response = await put({
      sectors: ["ai-ml", "fintech"],
      stages: ["seed", "series-a"],
      area: "Bay Area",
      excluded_sectors: ["security"],
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      sectors: ["ai-ml", "fintech"],
      stages: ["seed", "series-a"],
      area: "Bay Area",
      excluded_sectors: ["security"],
    });

    await expect((await get()).json()).resolves.toEqual({
      sectors: ["ai-ml", "fintech"],
      stages: ["seed", "series-a"],
      area: "Bay Area",
      excluded_sectors: ["security"],
    });
  });

  it("corrects the one row rather than adding a second on a second PUT", async () => {
    await put(EMPTY_BODY);
    await put({
      sectors: ["health-bio"],
      stages: [],
      area: "Bay Area",
      excluded_sectors: [],
    });

    const rows = await harness.scratch.db.select().from(userProfiles);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.sectors).toEqual(["health-bio"]);
  });

  it("answers 401 rather than redirecting to /login", async () => {
    harness.signOut();

    const response = await put(EMPTY_BODY);

    expect(response.status).toBe(401);
  });
});

describe("PUT /api/user-profile with input it will not accept", () => {
  it("answers 422 naming sectors for a value off the controlled Sector list", async () => {
    const response = await put({ ...EMPTY_BODY, sectors: ["not-a-sector"] });

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      error: "invalid request",
      field: "sectors.0",
    });
  });

  it("answers 422 naming excluded_sectors for a value off the controlled Sector list", async () => {
    const response = await put({
      ...EMPTY_BODY,
      excluded_sectors: ["not-a-sector"],
    });

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      error: "invalid request",
      field: "excluded_sectors.0",
    });
  });

  it("answers 422 naming stages for a value off the controlled Stage list", async () => {
    const response = await put({ ...EMPTY_BODY, stages: ["not-a-stage"] });

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      error: "invalid request",
      field: "stages.0",
    });
  });

  it("answers 422 naming excluded_sectors for a Sector listed as both stated and excluded", async () => {
    const response = await put({
      ...EMPTY_BODY,
      sectors: ["fintech"],
      excluded_sectors: ["fintech"],
    });

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      error: "invalid request",
      field: "excluded_sectors",
    });
  });

  it("answers 422 naming area for a blank area", async () => {
    const response = await put({ ...EMPTY_BODY, area: "" });

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      error: "invalid request",
      field: "area",
    });
  });

  it("answers 422 rather than 500 for a body that is not JSON at all", async () => {
    const response = await put("not json");

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      error: "invalid request",
    });
  });
});
