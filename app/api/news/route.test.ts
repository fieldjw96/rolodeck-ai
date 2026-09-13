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

import { persistNewsItems, type NewsCandidate } from "../../../db/news";
import { swipes } from "../../../db/schema";
import {
  startRouteHarness,
  type RouteHarness,
} from "../../../lib/api/testing/route-harness";
import { NEWS_DISPLAY_THRESHOLD } from "../../../lib/news/match";
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

const read = () => GET(new NextRequest("http://localhost/api/news"), undefined);

function candidate(
  profileId: string,
  overrides: Partial<NewsCandidate> = {},
): NewsCandidate {
  return {
    profileId,
    title: "Startup 0 raises a seed round",
    description: null,
    url: "https://news.example/startup-0",
    publishedAt: new Date("2026-09-01T12:00:00.000Z"),
    sourceName: "TechCrunch",
    confidence: 0.85,
    ...overrides,
  };
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
  // Deleting the Profiles cascades to their News.
  await harness.clear();
  await harness.signIn();
});

describe("GET /api/news without a session", () => {
  it("answers 401 rather than redirecting to /login", async () => {
    harness.signOut();

    const response = await read();

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "not signed in" });
  });
});

describe("GET /api/news", () => {
  it("answers with no companies when nothing is Kept", async () => {
    const response = await read();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ companies: [] });
  });

  it("lists Kept companies' News at or above the threshold, grouped, with each item's confidence", async () => {
    const [id] = await harness.seed(1);
    await harness.scratch.db
      .insert(swipes)
      .values({ userId: harness.user.id, profileId: id!, decision: "keep" });

    await persistNewsItems(harness.scratch.db, {
      ownerId: harness.user.id,
      candidates: [
        candidate(id!),
        candidate(id!, {
          url: "https://news.example/namesake",
          confidence: NEWS_DISPLAY_THRESHOLD - 0.2,
        }),
      ],
    });

    const response = await read();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      companies: [
        {
          profile: { id, name: "Startup 0", sector: "hardware-robotics" },
          items: [
            {
              id: expect.any(String),
              title: "Startup 0 raises a seed round",
              url: "https://news.example/startup-0",
              published_at: "2026-09-01T12:00:00.000Z",
              source_name: "TechCrunch",
              confidence: 0.85,
            },
          ],
        },
      ],
    });
  });

  it("lists nobody else's News", async () => {
    const [theirs] = await harness.seed(1, harness.strangerId);
    await harness.scratch.db.insert(swipes).values({
      userId: harness.strangerId,
      profileId: theirs!,
      decision: "keep",
    });
    await persistNewsItems(harness.scratch.db, {
      ownerId: harness.strangerId,
      candidates: [candidate(theirs!)],
    });

    await expect((await read()).json()).resolves.toEqual({ companies: [] });
  });
});
