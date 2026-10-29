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

import { persistNewsItems, type NewsCandidate } from "../../../../../db/news";
import { swipes } from "../../../../../db/schema";
import {
  startRouteHarness,
  type RouteHarness,
} from "../../../../../lib/api/testing/route-harness";
import { NEWS_DISPLAY_THRESHOLD } from "../../../../../lib/news/match";
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

const read = (id: string) =>
  GET(new NextRequest(`http://localhost/api/profiles/${id}/news`), {
    params: Promise.resolve({ id }),
  });

type NewsItemsBody = { items: Record<string, unknown>[] };

const readOk = async (id: string): Promise<NewsItemsBody> => {
  const response = await read(id);

  expect(response.status).toBe(200);

  return (await response.json()) as NewsItemsBody;
};

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
  await harness.clear();
  await harness.signIn();
});

describe("GET /api/profiles/:id/news without a session", () => {
  it("answers 401 rather than redirecting to /login", async () => {
    harness.signOut();

    const response = await read(NO_SUCH_PROFILE);

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "not signed in" });
  });
});

describe("GET /api/profiles/:id/news", () => {
  it("answers 422 naming id when the id is not a Profile id", async () => {
    const response = await read("not-a-uuid");

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      error: "invalid request",
      field: "id",
    });
  });

  it("lists this company's News at or above the threshold, newest first", async () => {
    const [id] = await harness.seed(1);
    await harness.scratch.db
      .insert(swipes)
      .values({ userId: harness.user.id, profileId: id!, decision: "keep" });

    await persistNewsItems(harness.scratch.db, {
      candidates: [
        candidate(id!, {
          url: "https://news.example/older",
          publishedAt: new Date("2026-08-01T12:00:00.000Z"),
        }),
        candidate(id!, {
          url: "https://news.example/newer",
          publishedAt: new Date("2026-09-15T12:00:00.000Z"),
        }),
        candidate(id!, {
          url: "https://news.example/below-threshold",
          confidence: NEWS_DISPLAY_THRESHOLD - 0.2,
        }),
      ],
    });

    const body = await readOk(id!);

    expect(body.items.map((item) => item.url)).toEqual([
      "https://news.example/newer",
      "https://news.example/older",
    ]);
  });

  it("answers with no items for a Profile the reader has never swiped", async () => {
    const [id] = await harness.seed(1);
    await persistNewsItems(harness.scratch.db, { candidates: [candidate(id!)] });

    await expect(readOk(id!)).resolves.toEqual({ items: [] });
  });

  it("answers with no items for a Profile the reader has Passed", async () => {
    const [id] = await harness.seed(1);
    await harness.scratch.db
      .insert(swipes)
      .values({ userId: harness.user.id, profileId: id!, decision: "pass" });
    await persistNewsItems(harness.scratch.db, { candidates: [candidate(id!)] });

    await expect(readOk(id!)).resolves.toEqual({ items: [] });
  });

  it("answers with no items for a company only somebody else has Kept", async () => {
    const [id] = await harness.seed(1);
    await harness.scratch.db.insert(swipes).values({
      userId: harness.strangerId,
      profileId: id!,
      decision: "keep",
    });
    await persistNewsItems(harness.scratch.db, { candidates: [candidate(id!)] });

    await expect(readOk(id!)).resolves.toEqual({ items: [] });
  });

  it("answers with no items for a Profile that does not exist", async () => {
    await expect(readOk(NO_SUCH_PROFILE)).resolves.toEqual({ items: [] });
  });
});
