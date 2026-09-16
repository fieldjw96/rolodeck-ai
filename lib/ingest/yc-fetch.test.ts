// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import { ACCELERATOR_USER_AGENT } from "./accelerator-fetch";
import { createThrottle } from "./throttle";
import { createYcClient, YC_SITEMAP_URL } from "./yc-fetch";

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

function fakeFetch(body = "<html></html>") {
  const calls: { url: string; headers: Record<string, string> }[] = [];

  const fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
    calls.push({
      url: url.toString(),
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
    });
    return new Response(body, { status: 200 });
  });

  return { fetch: fetch as unknown as typeof globalThis.fetch, calls };
}

describe("the Y Combinator fetch client", () => {
  it("reads the company sitemap that answers, not the one sitemap.xml names", () => {
    // https://www.ycombinator.com/sitemap.xml lists /companies/sitemap, which 404s.
    expect(YC_SITEMAP_URL).toBe(
      "https://www.ycombinator.com/companies/sitemap.xml",
    );
  });

  it("carries the same honest User-Agent as the accelerator batch pages on every request", async () => {
    const { fetch, calls } = fakeFetch();
    const client = createYcClient({ fetch });

    await client.get("https://www.ycombinator.com/companies/stripe");

    expect(calls[0]?.headers["user-agent"]).toBe(ACCELERATOR_USER_AGENT);
    expect(ACCELERATOR_USER_AGENT).not.toMatch(/Mozilla|Chrome|Safari/);
  });

  it("returns the response body", async () => {
    const { fetch } = fakeFetch("<urlset></urlset>");
    const client = createYcClient({ fetch });

    await expect(client.get(YC_SITEMAP_URL)).resolves.toBe("<urlset></urlset>");
  });

  it("throws, naming the URL, on a non-2xx response", async () => {
    const fetch = vi.fn(
      async () => new Response("nope", { status: 404 }),
    ) as unknown as typeof globalThis.fetch;
    const client = createYcClient({ fetch });

    await expect(
      client.get("https://www.ycombinator.com/companies/gone"),
    ).rejects.toThrow(
      "https://www.ycombinator.com/companies/gone answered 404",
    );
  });

  it("refuses a URL with a query string without sending it, since robots.txt disallows /companies?*", async () => {
    const { fetch, calls } = fakeFetch();
    const client = createYcClient({ fetch });

    await expect(
      client.get("https://www.ycombinator.com/companies?batch=W26"),
    ).rejects.toThrow("robots.txt disallows /companies?*");
    expect(calls).toEqual([]);
  });

  it("rate-limits requests to one a second per host, and lets a different host through unaffected", async () => {
    const clock = fakeClock();
    const { fetch } = fakeFetch();
    const client = createYcClient({
      fetch,
      createThrottleFor: () =>
        createThrottle({ limit: 1, windowMs: 1_000, ...clock }),
    });

    await client.get("https://www.ycombinator.com/companies/sitemap.xml");
    await client.get("https://example.com/a");
    // Each further request to the same host waits out another window; a different host does
    // not share its budget.
    await client.get("https://www.ycombinator.com/companies/stripe");
    await client.get("https://www.ycombinator.com/companies/dropbox");

    expect(clock.now()).toBe(2_000);
  });
});
