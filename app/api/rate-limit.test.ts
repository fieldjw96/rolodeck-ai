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

import { API_RATE_LIMIT } from "../../lib/api/rate-limit";
import {
  startRouteHarness,
  type RouteHarness,
} from "../../lib/api/testing/route-harness";
import { GET } from "./profiles/route";

let harness: RouteHarness;

vi.mock("next/headers", () => ({
  cookies: async () => ({
    getAll: () => harness.cookies,
    set: () => {},
  }),
}));

vi.mock("../../db/connection", () => ({
  getDb: () => harness.scratch.db,
}));

/**
 * Every route file under `/api`, found by walking the tree rather than listed by hand, so an
 * endpoint added next month is covered by the assertion below on the day it lands rather than
 * on the day somebody remembers it. Vite resolves the glob at build time; the modules
 * themselves are loaded lazily, under the mocks above.
 */
const ROUTE_MODULES = import.meta.glob("./**/route.ts") as Record<
  string,
  () => Promise<Record<string, unknown>>
>;

/** The exports Next will call as a handler. Anything else in the module is not a route. */
const HTTP_METHODS = [
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
] as const;

type RouteHandler = (request: NextRequest, context: never) => Promise<Response>;

function handlersIn(module: Record<string, unknown>): [string, RouteHandler][] {
  return HTTP_METHODS.filter(
    (method) => typeof module[method] === "function",
  ).map((method) => [method, module[method] as RouteHandler]);
}

/** Whatever a handler needs alongside the request. The limit is spent before either is read. */
const ANY_REQUEST = () =>
  new NextRequest("http://localhost/api/profiles", { method: "POST" });
const ANY_CONTEXT = {
  params: Promise.resolve({ id: "3f0d2f4e-1f6a-4a5c-9f42-6f1e0c7d2b31" }),
} as never;

const deal = () =>
  GET(new NextRequest("http://localhost/api/profiles"), undefined);

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

describe("the rate limit on /api", () => {
  it("allows the whole budget and refuses the request after it", async () => {
    for (let spent = 0; spent < API_RATE_LIMIT; spent += 1) {
      expect((await deal()).status).toBe(200);
    }

    const refused = await deal();

    expect(refused.status).toBe(429);
    // Whatever is left of the minute the first of those 60 requests started — a real number of
    // whole seconds, not the whole window, because making the requests took time.
    const retryAfter = Number(refused.headers.get("retry-after"));

    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(60);
    await expect(refused.json()).resolves.toEqual({
      error: "too many requests",
    });
  }, 60_000);

  it("spends one budget across the endpoints rather than one each", async () => {
    const { POST: keep } = await import("./profiles/[id]/keep/route");

    for (let spent = 0; spent < API_RATE_LIMIT; spent += 1) {
      expect((await deal()).status).toBe(200);
    }

    // Nothing has been swiped, and this is a Profile id that does not exist: a 404 would be
    // the answer on a budget with anything left in it.
    expect((await keep(ANY_REQUEST(), ANY_CONTEXT)).status).toBe(429);
  }, 60_000);

  it("finds the route files it is about to assert on", () => {
    expect(Object.keys(ROUTE_MODULES)).toEqual(
      expect.arrayContaining([
        "./profiles/route.ts",
        "./profiles/[id]/keep/route.ts",
        "./profiles/[id]/pass/route.ts",
      ]),
    );
  });

  it("covers every route handler under /api, not just the ones named here", async () => {
    for (let spent = 0; spent < API_RATE_LIMIT; spent += 1) {
      expect((await deal()).status).toBe(200);
    }

    for (const [path, load] of Object.entries(ROUTE_MODULES)) {
      const handlers = handlersIn(await load());

      expect(handlers.length, `${path} exports no handler`).toBeGreaterThan(0);

      for (const [method, handler] of handlers) {
        const response = await handler(ANY_REQUEST(), ANY_CONTEXT);

        expect(response.status, `${method} ${path} is not rate-limited`).toBe(
          429,
        );
      }
    }
  }, 60_000);
});
