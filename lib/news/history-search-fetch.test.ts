// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import { ACCELERATOR_USER_AGENT } from "../ingest/accelerator-fetch";
import { createThrottle } from "../ingest/throttle";
import { createHistorySearchClient } from "./history-search-fetch";

const SEARCH = "https://hn.algolia.com/api/v1/search?query=%22Blacksmith%22";

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

function fakeFetch(body = '{"hits":[]}', status = 200) {
  const calls: { url: string; headers: Record<string, string> }[] = [];

  const fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
    calls.push({
      url: url.toString(),
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
    });
    return new Response(body, { status });
  });

  return { fetch: fetch as unknown as typeof globalThis.fetch, calls };
}

describe("the News history search client", () => {
  it("carries the same honest User-Agent as the feeds and the other Sources", async () => {
    const { fetch, calls } = fakeFetch();
    const client = createHistorySearchClient({ fetch });

    await client.search(SEARCH);

    expect(calls[0]?.headers["user-agent"]).toBe(ACCELERATOR_USER_AGENT);
    expect(ACCELERATOR_USER_AGENT).not.toMatch(/Mozilla|Chrome|Safari/);
  });

  it("returns the body read as JSON, unvalidated", async () => {
    const { fetch } = fakeFetch('{"hits":[{"objectID":"1"}]}');
    const client = createHistorySearchClient({ fetch });

    await expect(client.search(SEARCH)).resolves.toEqual({
      hits: [{ objectID: "1" }],
    });
  });

  it("throws, naming the URL, on a non-2xx response", async () => {
    const { fetch } = fakeFetch("nope", 429);
    const client = createHistorySearchClient({ fetch });

    await expect(client.search(SEARCH)).rejects.toThrow(
      `${SEARCH} answered 429`,
    );
  });

  it("throws, naming the URL, on a body that is not JSON", async () => {
    const { fetch } = fakeFetch("<html>Moved</html>");
    const client = createHistorySearchClient({ fetch });

    await expect(client.search(SEARCH)).rejects.toThrow(
      `${SEARCH} answered with a body that is not JSON`,
    );
  });

  it("rate-limits requests to one a second per host", async () => {
    const clock = fakeClock();
    const { fetch } = fakeFetch();
    const client = createHistorySearchClient({
      fetch,
      createThrottleFor: () =>
        createThrottle({ limit: 1, windowMs: 1_000, ...clock }),
    });

    // A run's queries all go to one host, so each waits out the one before it.
    await client.search(SEARCH);
    await client.search(`${SEARCH}&page=1`);
    await client.search(`${SEARCH}&page=2`);

    expect(clock.now()).toBe(2_000);
  });
});
