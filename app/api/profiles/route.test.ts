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

import {
  startRouteHarness,
  type RouteHarness,
} from "../../../lib/api/testing/route-harness";
import { POST as keep } from "./[id]/keep/route";
import { POST as pass } from "./[id]/pass/route";
import { GET } from "./route";

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

type DeckBody = {
  profiles: Record<string, unknown>[];
  next_cursor: string | null;
};

const deal = (query = "") =>
  GET(new NextRequest(`http://localhost/api/profiles${query}`), undefined);

const dealt = async (query = "") => {
  const response = await deal(query);

  expect(response.status).toBe(200);

  return (await response.json()) as DeckBody;
};

const names = (body: DeckBody) => body.profiles.map((profile) => profile.name);

const swipe = (route: typeof keep, id: string): Promise<Response> =>
  route(
    new NextRequest(`http://localhost/api/profiles/${id}/keep`, {
      method: "POST",
    }),
    { params: Promise.resolve({ id }) },
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
  await harness.signIn();
});

describe("GET /api/profiles without a session", () => {
  it("answers 401 rather than redirecting to /login", async () => {
    harness.signOut();

    const response = await deal();

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "not signed in" });
  });
});

describe("GET /api/profiles", () => {
  it("deals an empty page when the Deck is empty", async () => {
    await expect(dealt()).resolves.toEqual({ profiles: [], next_cursor: null });
  });

  it("deals a partial page with no cursor when the whole Deck fits", async () => {
    await harness.seed(3);

    const body = await dealt();

    // Newest Profile first, so the last one seeded is the first one dealt.
    expect(names(body)).toEqual(["Startup 2", "Startup 1", "Startup 0"]);
    expect(body.next_cursor).toBeNull();
  });

  it("deals the Deck a page at a time and ends with a null cursor", async () => {
    await harness.seed(3);

    const first = await dealt("?limit=2");

    expect(names(first)).toEqual(["Startup 2", "Startup 1"]);
    expect(first.next_cursor).toEqual(expect.any(String));

    const last = await dealt(`?limit=2&cursor=${first.next_cursor}`);

    expect(names(last)).toEqual(["Startup 0"]);
    expect(last.next_cursor).toBeNull();
  });

  it("never deals more Profiles than the default page size", async () => {
    await harness.seed(21);

    const body = await dealt();

    expect(body.profiles).toHaveLength(20);
    expect(body.next_cursor).not.toBeNull();
  });

  it("puts the Profile on the wire with its provenance and without its owner", async () => {
    await harness.seed(1);

    const [profile] = (await dealt()).profiles;

    expect(Object.keys(profile ?? {}).sort()).toEqual([
      "created_at",
      "description",
      "id",
      "name",
      "provenance",
      "sector",
      "stage",
      "website",
    ]);
    expect(profile?.provenance).toEqual({
      name: "scraped",
      description: "scraped",
      sector: "enriched",
      stage: "jack",
      website: null,
    });
  });

  it("deals nobody else's Profiles", async () => {
    await harness.seed(2, harness.strangerId);

    await expect(dealt()).resolves.toEqual({ profiles: [], next_cursor: null });
  });
});

describe("GET /api/profiles?filter=kept", () => {
  it("lists an empty Watchlist as an empty page, not an error", async () => {
    await harness.seed(1);

    await expect(dealt("?filter=kept")).resolves.toEqual({
      profiles: [],
      next_cursor: null,
    });
  });

  it("lists every Kept Profile, newest decision first, and never a Passed one", async () => {
    const [older, newer] = await harness.seed(2);

    await swipe(keep, older!);
    await swipe(pass, newer!);
    await swipe(keep, newer!);

    expect(names(await dealt("?filter=kept"))).toEqual([
      "Startup 1",
      "Startup 0",
    ]);
  });

  it("deals nobody else's Kept Profiles", async () => {
    await harness.seed(2, harness.strangerId);

    await expect(dealt("?filter=kept")).resolves.toEqual({
      profiles: [],
      next_cursor: null,
    });
  });
});

describe("GET /api/profiles with input it will not accept", () => {
  it("answers 422 naming filter for a filter this endpoint does not know", async () => {
    const response = await deal("?filter=banana");

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      error: "invalid request",
      field: "filter",
    });
  });

  it.each([
    ["a limit of zero", "?limit=0"],
    ["a limit above the maximum", "?limit=51"],
    ["a limit that is not a number", "?limit=banana"],
    ["a fractional limit", "?limit=1.5"],
    ["a negative limit", "?limit=-1"],
  ])("answers 422 naming limit for %s", async (_description, query) => {
    const response = await deal(query);

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      error: "invalid request",
      field: "limit",
    });
  });

  it.each([
    ["a cursor it never issued", "?cursor=not-a-cursor"],
    ["an empty cursor", "?cursor="],
    [
      "a cursor with the timestamp tampered with",
      `?cursor=${Buffer.from("yesterday 3f0d2f4e-1f6a-4a5c-9f42-6f1e0c7d2b31").toString("base64url")}`,
    ],
  ])("answers 422 naming cursor for %s", async (_description, query) => {
    const response = await deal(query);

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      error: "invalid request",
      field: "cursor",
    });
  });
});
