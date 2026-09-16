// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import { ACCELERATOR_USER_AGENT } from "../ingest/accelerator-fetch";
import { createThrottle } from "../ingest/throttle";
import { createNewsFeedClient } from "./feed-fetch";

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

function fakeFetch(body = "<rss></rss>") {
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

describe("the News feed client", () => {
  it("carries the same honest User-Agent as the other Sources on every request", async () => {
    const { fetch, calls } = fakeFetch();
    const client = createNewsFeedClient({ fetch });

    await client.get("https://www.techmeme.com/feed.xml");

    expect(calls[0]?.headers["user-agent"]).toBe(ACCELERATOR_USER_AGENT);
    expect(ACCELERATOR_USER_AGENT).not.toMatch(/Mozilla|Chrome|Safari/);
  });

  it("returns the response body", async () => {
    const { fetch } = fakeFetch("<rss>feed</rss>");
    const client = createNewsFeedClient({ fetch });

    await expect(client.get("https://www.techmeme.com/feed.xml")).resolves.toBe(
      "<rss>feed</rss>",
    );
  });

  it("throws, naming the URL, on a non-2xx response", async () => {
    const fetch = vi.fn(
      async () => new Response("nope", { status: 503 }),
    ) as unknown as typeof globalThis.fetch;
    const client = createNewsFeedClient({ fetch });

    await expect(
      client.get("https://www.techmeme.com/feed.xml"),
    ).rejects.toThrow("https://www.techmeme.com/feed.xml answered 503");
  });

  it("rate-limits requests to one a second per host, and lets a different host through unaffected", async () => {
    const clock = fakeClock();
    const { fetch } = fakeFetch();
    const client = createNewsFeedClient({
      fetch,
      createThrottleFor: () =>
        createThrottle({ limit: 1, windowMs: 1_000, ...clock }),
    });

    await client.get("https://www.techmeme.com/feed.xml");
    await client.get("https://news.example/feed.xml");
    // Each further request to the same host waits out another window; a different host does
    // not share its budget.
    await client.get("https://www.techmeme.com/river.xml");
    await client.get("https://www.techmeme.com/other.xml");

    expect(clock.now()).toBe(2_000);
  });
});
