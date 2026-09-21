import { ACCELERATOR_USER_AGENT } from "../ingest/accelerator-fetch";
import { createThrottle, type Throttle } from "../ingest/throttle";

/**
 * The module under `lib/news` that fetches News's history searches: the urls `historyQueries` in
 * `history-search.ts` builds, all on `hn.algolia.com`. Building those urls and validating what
 * comes back is `history-search.ts` and is offline, the split `feed-fetch.ts` makes for feeds.
 *
 * The same honest `User-Agent` as the feeds, the accelerator batch pages and Y Combinator, and
 * the same limit of one request a second per host. A run makes up to two requests per Kept
 * Company Profile, all to one host, so this is the limit that actually paces a run: sixteen Kept
 * companies is about half a minute. Algolia publishes a far higher ceiling for this API; this
 * stays well under it rather than near it.
 *
 * This host is already fetched by the Show HN Source (`scripts/fetch-show-hn.ts`), so its terms
 * were cleared when that Source was built.
 */

const REQUESTS_PER_HOST_PER_SECOND = 1;
const RATE_WINDOW_MS = 1_000;

/** As `feed-fetch.ts`: a hung request should cost one company, not hold the run open. */
const REQUEST_TIMEOUT_MS = 30_000;

export type HistorySearchClient = {
  /**
   * The response body read as JSON, throttled and identified, and not yet validated: that is
   * `parseHistorySearch`. Throws on any non-2xx, or a body that is not JSON.
   */
  readonly search: (url: string) => Promise<unknown>;
};

export type HistorySearchClientOptions = {
  readonly fetch?: typeof globalThis.fetch;
  /** Injectable so a test can build a throttle against a clock it holds. */
  readonly createThrottleFor?: (host: string) => Throttle;
};

export function createHistorySearchClient({
  fetch = globalThis.fetch,
  createThrottleFor = () =>
    createThrottle({
      limit: REQUESTS_PER_HOST_PER_SECOND,
      windowMs: RATE_WINDOW_MS,
    }),
}: HistorySearchClientOptions = {}): HistorySearchClient {
  const throttles = new Map<string, Throttle>();

  const throttleFor = (host: string): Throttle => {
    const existing = throttles.get(host);
    if (existing !== undefined) {
      return existing;
    }

    const throttle = createThrottleFor(host);
    throttles.set(host, throttle);
    return throttle;
  };

  return {
    search: async (url) => {
      await throttleFor(new URL(url).host).acquire();

      const response = await fetch(url, {
        headers: {
          "User-Agent": ACCELERATOR_USER_AGENT,
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      if (!response.ok) {
        throw new Error(`${url} answered ${response.status}`);
      }

      const text = await response.text();

      try {
        return JSON.parse(text) as unknown;
      } catch {
        throw new Error(`${url} answered with a body that is not JSON`);
      }
    },
  };
}
