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

import type { Database } from "../../../db/connection";
import {
  startRouteHarness,
  type RouteHarness,
} from "../../../lib/api/testing/route-harness";
import { GET } from "./route";

let harness: RouteHarness;

/** Set by a test that wants Postgres to look unreachable; the real scratch database otherwise. */
let brokenDb: Pick<Database, "execute"> | null = null;

vi.mock("next/headers", () => ({
  cookies: async () => ({
    getAll: () => harness.cookies,
    set: () => {},
  }),
}));

vi.mock("../../../db/connection", () => ({
  getDb: () => brokenDb ?? harness.scratch.db,
}));

const check = () =>
  GET(new NextRequest("http://localhost/api/health"), undefined);

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
  brokenDb = null;
  await harness.clear();
  await harness.signIn();
});

describe("GET /api/health", () => {
  it("answers 401 rather than redirecting when there is no session", async () => {
    harness.signOut();

    const response = await check();

    expect(response.status).toBe(401);
  });

  it("answers 200 confirming Postgres is reachable", async () => {
    const response = await check();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "ok" });
  });

  it("answers 503 when Postgres is unreachable", async () => {
    brokenDb = {
      execute: () => Promise.reject(new Error("connection refused")),
    } as unknown as Pick<Database, "execute">;

    const response = await check();

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ status: "error" });
  });
});
