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

import { swipes } from "../../../../db/schema";
import {
  startRouteHarness,
  type RouteHarness,
} from "../../../../lib/api/testing/route-harness";
import { GET } from "../route";
import { POST as keep } from "./keep/route";
import { POST as pass } from "./pass/route";

let harness: RouteHarness;

vi.mock("next/headers", () => ({
  cookies: async () => ({
    getAll: () => harness.cookies,
    set: () => {},
  }),
}));

vi.mock("../../../../db/connection", () => ({
  getDb: () => harness.scratch.db,
}));

const NO_SUCH_PROFILE = "3f0d2f4e-1f6a-4a5c-9f42-6f1e0c7d2b31";

const swipe = (route: typeof keep, id: string): Promise<Response> =>
  route(
    new NextRequest(`http://localhost/api/profiles/${id}/keep`, {
      method: "POST",
    }),
    { params: Promise.resolve({ id }) },
  );

const dealtNames = async (): Promise<unknown[]> => {
  const response = await GET(
    new NextRequest("http://localhost/api/profiles"),
    undefined,
  );
  const body = (await response.json()) as { profiles: { name: string }[] };

  return body.profiles.map((profile) => profile.name);
};

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

describe.each([["keep", keep] as const, ["pass", pass] as const])(
  "POST /api/profiles/:id/%s",
  (decision, route) => {
    it("answers 401 rather than redirecting when there is no session", async () => {
      const [only] = await harness.seed(1);
      harness.signOut();

      const response = await swipe(route, only!);

      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toEqual({
        error: "not signed in",
      });
    });

    it("records the decision and drops the Profile from later pages", async () => {
      const [older] = await harness.seed(2);

      const response = await swipe(route, older!);

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        profile_id: older,
        decision,
        decided_at: expect.any(String),
      });

      // The decision is in Postgres, not just in the response.
      await expect(
        harness.scratch.db
          .select({
            profileId: swipes.profileId,
            userId: swipes.userId,
            decision: swipes.decision,
          })
          .from(swipes),
      ).resolves.toEqual([
        { profileId: older, userId: harness.user.id, decision },
      ]);

      await expect(dealtNames()).resolves.toEqual(["Startup 1"]);
    });

    it("answers 422 naming id when the id is not a Profile id", async () => {
      const response = await swipe(route, "not-a-uuid");

      expect(response.status).toBe(422);
      await expect(response.json()).resolves.toMatchObject({
        error: "invalid request",
        field: "id",
      });
    });

    it("answers 404 for a Profile that does not exist", async () => {
      const response = await swipe(route, NO_SUCH_PROFILE);

      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual({ error: "not found" });
    });

    it("answers 404, not 403, for somebody else's Profile", async () => {
      const [theirs] = await harness.seed(1, harness.strangerId);

      const response = await swipe(route, theirs!);

      expect(response.status).toBe(404);
      await expect(harness.scratch.db.select().from(swipes)).resolves.toEqual(
        [],
      );
    });
  },
);

describe("swiping the same Profile twice", () => {
  it("corrects the decision rather than recording a second one", async () => {
    const [only] = await harness.seed(1);

    await swipe(keep, only!);
    await swipe(pass, only!);

    const recorded = await harness.scratch.db.select().from(swipes);

    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.decision).toBe("pass");
    await expect(dealtNames()).resolves.toEqual([]);
  });
});
