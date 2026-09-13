import { describe, it, expect } from "vitest";

import {
  parseSmokeOptions,
  summarise,
  redact,
  DEFAULT_BASE_URL,
  type CheckResult,
} from "./options";

const env = (
  over: Record<string, string> = {},
): Record<string, string | undefined> => ({
  ROLODECK_SMOKE_EMAIL: "jack@example.com",
  ROLODECK_SMOKE_PASSWORD: "hunter2",
  ...over,
});

describe("parseSmokeOptions", () => {
  it("defaults to the production deployment", () => {
    expect(parseSmokeOptions([], env()).baseUrl).toBe(DEFAULT_BASE_URL);
  });

  it("takes a base URL from argv, ahead of the environment", () => {
    const options = parseSmokeOptions(
      ["http://localhost:3000"],
      env({ ROLODECK_SMOKE_URL: "https://elsewhere.example" }),
    );
    expect(options.baseUrl).toBe("http://localhost:3000");
  });

  it("takes a base URL from the environment when argv has none", () => {
    expect(
      parseSmokeOptions([], env({ ROLODECK_SMOKE_URL: "https://a.example" }))
        .baseUrl,
    ).toBe("https://a.example");
  });

  it("trims trailing slashes so paths are not doubled", () => {
    expect(parseSmokeOptions(["https://a.example///"], env()).baseUrl).toBe(
      "https://a.example",
    );
  });

  it("rejects a base URL with no scheme", () => {
    expect(() => parseSmokeOptions(["rolodeck-ai.vercel.app"], env())).toThrow(
      /http/,
    );
  });

  /**
   * Next refuses to serve its own dev chunks over 127.0.0.1, so the page renders with no
   * interactivity and every check fails in a way indistinguishable from a broken deployment.
   * It cost an hour once already.
   */
  it("rejects 127.0.0.1 with the reason", () => {
    expect(() => parseSmokeOptions(["http://127.0.0.1:3000"], env())).toThrow(
      /localhost/,
    );
  });

  // A smoke test that falls back to a built-in credential is a credential in the repository,
  // and this one signs in to production.
  it("requires a password rather than defaulting one", () => {
    expect(() =>
      parseSmokeOptions([], env({ ROLODECK_SMOKE_PASSWORD: "" })),
    ).toThrow(/ROLODECK_SMOKE_PASSWORD/);
  });

  it("requires an email", () => {
    expect(() =>
      parseSmokeOptions([], env({ ROLODECK_SMOKE_EMAIL: "" })),
    ).toThrow(/ROLODECK_SMOKE_EMAIL/);
  });
});

describe("summarise", () => {
  const ok = (name: string): CheckResult => ({
    name,
    ok: true,
    detail: "fine",
  });
  const bad = (name: string): CheckResult => ({
    name,
    ok: false,
    detail: "broken",
  });

  it("exits 0 when everything passed", () => {
    expect(summarise([ok("a"), ok("b")]).exitCode).toBe(0);
  });

  it("exits 1 and names what failed", () => {
    const { text, exitCode } = summarise([ok("a"), bad("deck")]);
    expect(exitCode).toBe(1);
    expect(text).toContain("deck");
  });

  /**
   * No results is a failure, not a pass. A smoke test that checked nothing and reported
   * cheerfully reads exactly like a healthy deployment, which is the worst way to be wrong.
   */
  it("exits 1 when nothing was checked at all", () => {
    expect(summarise([]).exitCode).toBe(1);
  });
});

describe("redact", () => {
  it("removes the password from output", () => {
    expect(redact("signed in with hunter2 ok", "hunter2")).toBe(
      "signed in with [redacted] ok",
    );
  });

  it("removes every occurrence", () => {
    expect(redact("a hunter2 b hunter2", "hunter2")).toBe(
      "a [redacted] b [redacted]",
    );
  });

  it("leaves text alone when the secret is empty", () => {
    expect(redact("nothing to do", "")).toBe("nothing to do");
  });
});
