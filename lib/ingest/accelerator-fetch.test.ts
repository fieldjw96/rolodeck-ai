// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import {
  ACCELERATOR_USER_AGENT,
  createAcceleratorClient,
} from "./accelerator-fetch";
import { createThrottle } from "./throttle";

/** A clock the test holds, so a rate limit is asserted by moving it rather than waiting. */
function fakeClock(start = 0) {
  let time = start;
  return {
    now: () => time,
    sleep: async (ms: number) => {
      time += ms;
      await Promise.resolve();
    },
  };
}

function fakeFetch(html = "<html></html>") {
  const calls: { url: string; headers: Record<string, string> }[] = [];

  const fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
    calls.push({
      url: url.toString(),
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
    });
    return new Response(html, { status: 200 });
  });

  return { fetch: fetch as unknown as typeof globalThis.fetch, calls };
}

describe("the accelerator fetch client", () => {
  it("sends an honest User-Agent that names the project, not a browser", () => {
    expect(ACCELERATOR_USER_AGENT).toContain("rolodeck-ai");
    expect(ACCELERATOR_USER_AGENT).not.toMatch(/Mozilla|Chrome|Safari/);
  });

  it("carries that User-Agent on every request", async () => {
    const { fetch, calls } = fakeFetch();
    const client = createAcceleratorClient({ fetch });

    await client.get("https://example.com/companies");

    expect(calls[0]?.headers["user-agent"]).toBe(ACCELERATOR_USER_AGENT);
  });

  it("returns the URL fetched alongside the page's text", async () => {
    const { fetch } = fakeFetch("<p>hello</p>");
    const client = createAcceleratorClient({ fetch });

    const page = await client.get("https://example.com/companies");

    expect(page).toEqual({
      sourceUrl: "https://example.com/companies",
      html: "<p>hello</p>",
    });
  });

  it("throws, naming the URL, on a non-2xx response", async () => {
    const fetch = vi.fn(
      async () => new Response("nope", { status: 503 }),
    ) as unknown as typeof globalThis.fetch;
    const client = createAcceleratorClient({ fetch });

    await expect(client.get("https://example.com/companies")).rejects.toThrow(
      "https://example.com/companies answered 503",
    );
  });

  it("rate-limits requests to the same host, and lets a different host through unaffected", async () => {
    const clock = fakeClock();
    const { fetch } = fakeFetch();
    const client = createAcceleratorClient({
      fetch,
      createThrottleFor: () =>
        createThrottle({ limit: 1, windowMs: 1_000, ...clock }),
    });

    await client.get("https://one.example.com/a");
    await client.get("https://two.example.com/a");
    // The second request to the same host waits out the window; a different host does not
    // share its budget.
    await client.get("https://one.example.com/b");

    expect(clock.now()).toBe(1_000);
  });
});
