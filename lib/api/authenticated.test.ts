// @vitest-environment node
import { NextRequest } from "next/server";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { startRouteHarness, type RouteHarness } from "./testing/route-harness";
import { authenticated } from "./authenticated";

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

const okHandler = authenticated(async () => Response.json({ ok: true }));
const throwingHandler = authenticated(async () => {
  throw new Error("boom");
});

const call = (
  handler: typeof okHandler,
  path = "http://localhost/api/whatever",
) => handler(new NextRequest(path), undefined);

function loggedLine(logSpy: ReturnType<typeof vi.spyOn>, at = 0): LogLine {
  return JSON.parse(logSpy.mock.calls[at]![0] as string) as LogLine;
}

type LogLine = {
  level: string;
  method: string;
  path: string;
  status: number;
  duration_ms: number;
  user_id?: string;
  request_id?: string;
  error?: string;
  stack?: string;
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

afterEach(() => {
  vi.restoreAllMocks();
});

describe("authenticated()'s request log", () => {
  it("logs one structured JSON line naming the method, path, status, duration and user", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const response = await call(okHandler);

    expect(response.status).toBe(200);
    expect(logSpy).toHaveBeenCalledTimes(1);

    const line = loggedLine(logSpy);

    expect(line).toMatchObject({
      method: "GET",
      path: "/api/whatever",
      status: 200,
      user_id: harness.user.id,
    });
    expect(typeof line.duration_ms).toBe("number");
  });

  it("logs a 401 with no user id when there is no session", async () => {
    harness.signOut();

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const response = await call(okHandler);

    expect(response.status).toBe(401);

    const line = loggedLine(logSpy);

    expect(line).toMatchObject({ status: 401 });
    expect(line.user_id).toBeUndefined();
  });
});

describe("authenticated()'s shared error boundary", () => {
  it("catches an unhandled throw, answers 500 with only a request id, and logs the rest", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const response = await call(throwingHandler);

    expect(response.status).toBe(500);

    const body = (await response.json()) as Record<string, unknown>;

    expect(Object.keys(body)).toEqual(["request_id"]);
    expect(body.request_id).toEqual(expect.any(String));

    // Neither the message nor the stack ever reaches the client.
    expect(JSON.stringify(body)).not.toContain("boom");

    const line = loggedLine(logSpy);

    expect(line.status).toBe(500);
    expect(line.request_id).toBe(body.request_id);
    expect(line.user_id).toBe(harness.user.id);
    expect(line.error).toBe("boom");
    expect(line.stack).toEqual(expect.stringContaining("Error: boom"));
  });
});
