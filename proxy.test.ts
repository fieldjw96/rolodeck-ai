// @vitest-environment node
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { stubBackend, type AuthBackend } from "./lib/auth/testing/auth-backend";
import { config, proxy } from "./proxy";

/**
 * Next compiles each matcher entry as a regular expression anchored at both ends. Reproducing
 * that here is the only way to answer "does the gate actually run on this path?" — a gate that
 * redirects correctly but never runs on `/` would pass every other test in this repo.
 */
function isMatched(pathname: string): boolean {
  return config.matcher.some((pattern) =>
    new RegExp(`^${pattern}$`).test(pathname),
  );
}

describe("the paths the gate runs on", () => {
  it.each(["/", "/deck", "/deck/sprocket", "/login", "/api/anything"])(
    "covers %s",
    (pathname) => {
      expect(isMatched(pathname)).toBe(true);
    },
  );

  it.each([
    "/_next/static/chunks/main.js",
    "/_next/image",
    "/favicon.ico",
    "/logo.svg",
    "/robots.txt",
  ])("skips %s, which carries no session", (pathname) => {
    expect(isMatched(pathname)).toBe(false);
  });
});

describe("the Proxy entry point", () => {
  let backend: AuthBackend;

  beforeAll(async () => {
    backend = await stubBackend();
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", backend.url);
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", backend.publishableKey);
  }, 30_000);

  afterAll(async () => {
    await backend.close();
    vi.unstubAllEnvs();
  });

  it("hands the request to the gate", async () => {
    const response = await proxy(
      new NextRequest(new URL("https://rolodeck.example/")),
    );

    expect(response.headers.get("location")).toBe(
      "https://rolodeck.example/login",
    );
  });
});
